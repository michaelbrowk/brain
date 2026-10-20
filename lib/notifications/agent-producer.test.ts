import { describe, expect, it } from "vitest";
import type { McpActivityEntry } from "@/lib/mcp/activity-log";
import { notificationSchema } from "./model";
import { agentActionNotification, mergeAgentDigests, type AgentActivityEntry } from "./agent-producer";

const line = (patch: Partial<AgentActivityEntry> = {}): AgentActivityEntry => ({
  at: "2026-09-14T12:00:00.000Z", client: "ChatGPT", tool: "write_page", page: "notes", outcome: "ok", ...patch,
});
const make = (patch: Partial<AgentActivityEntry> = {}, label = "Meeting notes", zone = "Asia/Dubai") =>
  agentActionNotification(line(patch), label, zone)!;

describe("daily agent digests", () => {
  it("keeps the activity log's structural contract", () => {
    const entry: McpActivityEntry = line();
    const back: AgentActivityEntry = entry;
    expect(back.tool).toBe("write_page");
  });

  it("folds across tools and targets for one agent and local day", () => {
    let row = make();
    row = mergeAgentDigests(row, make({ tool: "create_page", page: "second" }));
    row = mergeAgentDigests(row, make({ tool: "complete_task", task: "t1" }, "Call Alex"));
    row = mergeAgentDigests(row, make({ tool: "update_mail_thread", accountId: "a", threadId: "thread", change: "archive" }, "Project update"));
    expect(row.title).toBe("ChatGPT · 2 pages, 1 task, 1 thread");
    expect(row.digest).toMatchObject({ agent: "ChatGPT", day: "2026-09-14" });
    expect(notificationSchema.safeParse(row).success).toBe(true);
    expect(make({ client: "Claude" }).id).not.toBe(row.id);
  });

  it("counts seven writes and a move of one page as one page", () => {
    let row = make();
    for (let i = 0; i < 7; i++) row = mergeAgentDigests(row, make({ at: `2026-09-14T13:0${i}:00.000Z` }));
    row = mergeAgentDigests(row, make({ tool: "move_page" }));
    expect(row.title).toBe("ChatGPT · 1 page");
    expect(row.digest!.targets).toHaveLength(1);
  });

  it("rolls over at the owner's midnight, including DST, rather than UTC midnight", () => {
    expect(make({ at: "2026-09-14T19:59:59.999Z" }).digest!.day).toBe("2026-09-14");
    expect(make({ at: "2026-09-14T20:00:00.000Z" }).digest!.day).toBe("2026-09-15");
    expect(make({ at: "2026-11-01T03:59:59.999Z" }, "Notes", "America/New_York").digest!.day).toBe("2026-10-31");
    expect(make({ at: "2026-11-01T04:00:00.000Z" }, "Notes", "America/New_York").digest!.day).toBe("2026-11-01");
  });

  it("counts distinct threads per account, and distinct sent messages separately", () => {
    let row = make({ tool: "update_mail_thread", accountId: "a", threadId: "t" });
    row = mergeAgentDigests(row, make({ tool: "update_mail_thread", accountId: "a", threadId: "t", change: "spam" }));
    row = mergeAgentDigests(row, make({ tool: "update_mail_thread", accountId: "b", threadId: "t" }));
    const sent = make({ tool: "reply_mail", accountId: "a", threadId: "t", operationId: "op" });
    row = mergeAgentDigests(row, sent);
    row = mergeAgentDigests(row, sent);
    expect(row.title).toBe("ChatGPT · 2 threads, 1 message sent");
  });

  it("keeps read state while refreshing titles and newest target order", () => {
    const read = { ...make(), readAt: "2026-09-14T12:01:00.000Z" };
    let row = mergeAgentDigests(read, make({ page: "second", at: "2026-09-14T13:00:00.000Z" }, "Second"));
    row = mergeAgentDigests(row, make({ at: "2026-09-14T14:00:00.000Z" }, "Renamed notes"));
    expect(row.readAt).toBe(read.readAt);
    expect(row.digest!.targets.map((t) => t.title)).toEqual(["Renamed notes", "Second"]);
    expect(row.at).toBe("2026-09-14T14:00:00.000Z");
  });

  it("bounds target detail to 50 and distinct sets to 200 per kind without inflating repeats", () => {
    let row = make();
    for (let i = 0; i < 205; i++) row = mergeAgentDigests(row, make({ page: `p${i}` }));
    expect(row.digest!.ids.page).toHaveLength(200);
    expect(row.digest!.targets).toHaveLength(50);
    expect(row.title).toBe("ChatGPT · 200+ pages");
    row = mergeAgentDigests(row, make());
    expect(row.title).toBe("ChatGPT · 200+ pages");
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it.each(["read_page", "get_task", "notion_finalize_page", "connection_check"])("ignores %s", (tool) => {
    expect(agentActionNotification(line({ tool }))).toBeNull();
  });
  it("ignores refusals, read marks and invalid instants", () => {
    expect(agentActionNotification(line({ outcome: "conflict" }))).toBeNull();
    expect(agentActionNotification(line({ tool: "update_mail_thread", change: "read" }))).toBeNull();
    expect(agentActionNotification(line({ at: "2026-02-31T00:00:00.000Z" }))).toBeNull();
  });
  it("bounds names and labels, checks hrefs, and gives unnamed targets usable labels", () => {
    const row = make({ client: " C\nD ", page: "bad#id" }, "x".repeat(500));
    expect(row.digest!.agent).toBe("C D");
    expect(row.digest!.targets[0].title).toHaveLength(200);
    expect(row.digest!.targets[0].href).toBe("/");
    expect(notificationSchema.safeParse(row).success).toBe(true);
    expect(agentActionNotification(line())!.digest!.targets[0].title).toBe("Page");
  });
});
