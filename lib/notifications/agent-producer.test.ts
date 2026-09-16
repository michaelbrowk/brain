import { describe, expect, it } from "vitest";
import type { McpActivityEntry } from "@/lib/mcp/activity-log";
import { agentActionNotification, type AgentActivityEntry } from "./agent-producer";
import { decodeAgentMailHref } from "./ids";
import { notificationSchema } from "./model";

/** The producer reads one log line and nothing else, so its input is a
 *  structural copy of the log's own entry rather than an import that would
 *  make the two modules point at each other. These two assignments are what
 *  hold the copy to the original: a field the log adds and this misses stops
 *  compiling here. */
const _entryIsAnActivityLine: AgentActivityEntry = {} as McpActivityEntry;
const _activityLineIsAnEntry: McpActivityEntry = {} as AgentActivityEntry;
void _entryIsAnActivityLine;
void _activityLineIsAnEntry;

const AT = "2026-09-14T12:00:00.000Z";
const ACCOUNT = "account-adeadbeefdeadbeefdeadbeefdeadbeef";

const line = (patch: Partial<AgentActivityEntry>): AgentActivityEntry => ({
  at: AT,
  client: "Claude",
  tool: "create_task",
  outcome: "ok",
  ...patch,
});

describe("what an agent did, as a row", () => {
  it("names the client and the verb, and nothing the agent wrote", () => {
    const row = agentActionNotification(line({ task: "task-alpha" }), "Water the plants");
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("agent-action");
    expect(row!.title).toBe("Claude created a task");
    expect(row!.body).toBe("Water the plants");
    expect(row!.at).toBe(AT);
    expect(row!.readAt).toBeUndefined();
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("leaves the body out when the call site had no title in hand", () => {
    const row = agentActionNotification(line({ task: "task-alpha" }));
    expect(row!.body).toBeUndefined();
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  /** One row per tool, with the destination beside it. The table is the
   *  contract: a tool added to the log and not to this table writes no row. */
  const verbs: Array<[string, Partial<AgentActivityEntry>, string, string]> = [
    ["send_mail", { tool: "send_mail", accountId: ACCOUNT, operationId: "op-1" }, "Claude sent a message", "/mail"],
    ["save_mail_attachment", { tool: "save_mail_attachment", accountId: ACCOUNT, page: "meeting-notes" }, "Claude saved an attachment", "/p/meeting-notes"],
    ["create_task", { tool: "create_task", task: "task-alpha" }, "Claude created a task", "/tasks?task=task-alpha"],
    ["promote_task_line", { tool: "promote_task_line", task: "task-alpha", page: "notes" }, "Claude made a task from a line", "/tasks?task=task-alpha"],
    ["update_task", { tool: "update_task", task: "task-alpha", change: "title" }, "Claude changed a task", "/tasks?task=task-alpha"],
    ["complete_task", { tool: "complete_task", task: "task-alpha" }, "Claude completed a task", "/tasks?task=task-alpha"],
    ["reopen_task", { tool: "reopen_task", task: "task-alpha" }, "Claude reopened a task", "/tasks?task=task-alpha"],
    // The record is gone, so the column is the whole answer: "?task=" would
    // name a row nothing can select.
    ["delete_task", { tool: "delete_task", task: "task-alpha" }, "Claude deleted a task", "/tasks"],
    ["write_page", { tool: "write_page", page: "notes" }, "Claude wrote a page", "/p/notes"],
    ["append_page", { tool: "append_page", page: "notes" }, "Claude added to a page", "/p/notes"],
    ["create_page", { tool: "create_page", page: "notes" }, "Claude created a page", "/p/notes"],
    ["update_meta", { tool: "update_meta", page: "notes" }, "Claude changed a page", "/p/notes"],
    ["move_page", { tool: "move_page", page: "notes" }, "Claude moved a page", "/p/notes"],
    ["delete_page", { tool: "delete_page", page: "notes" }, "Claude deleted a page", "/"],
  ];

  it.each(verbs)("%s", (_name, patch, title, href) => {
    const row = agentActionNotification(line(patch));
    expect(row).not.toBeNull();
    expect(row!.title).toBe(title);
    expect(row!.href).toBe(href);
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  /** One triage tool, six changes. `read` and `starred` carry no direction in
   *  the log line, and the row says what the line knows rather than guessing
   *  which way it went. */
  const triage: Array<[string, string]> = [
    ["archive", "Claude archived a thread"],
    ["trash", "Claude moved a thread to the trash"],
    ["restore", "Claude took a thread out of the trash"],
    ["spam", "Claude marked a thread as spam"],
    ["starred", "Claude changed a thread's star"],
    ["read", "Claude changed a thread's read mark"],
  ];

  it.each(triage)("update_mail_thread, %s", (change, title) => {
    const row = agentActionNotification(
      line({ tool: "update_mail_thread", accountId: ACCOUNT, threadId: "thread-one", change }),
    );
    expect(row!.title).toBe(title);
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("falls back to one word for a triage line that named no change", () => {
    const row = agentActionNotification(
      line({ tool: "update_mail_thread", accountId: ACCOUNT, threadId: "thread-one" }),
    );
    expect(row!.title).toBe("Claude sorted a thread");
  });

  it("carries the thread in the href a mail row is opened through", () => {
    const row = agentActionNotification(
      line({ tool: "reply_mail", accountId: ACCOUNT, threadId: "thread-one", messageId: "m-1" }),
    );
    expect(row!.title).toBe("Claude replied to a message");
    expect(decodeAgentMailHref(row!.href)).toEqual({
      accountId: ACCOUNT,
      threadId: "thread-one",
    });
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("opens the surface alone when the line names no thread", () => {
    const row = agentActionNotification(line({ tool: "send_mail", accountId: ACCOUNT }));
    expect(row!.href).toBe("/mail");
  });

  it("derives one id from the line, so a replay is one row", () => {
    const entry = line({ task: "task-alpha" });
    const first = agentActionNotification(entry)!.id;
    expect(agentActionNotification(entry)!.id).toBe(first);
    expect(first).toMatch(/^agent:2026-09-14T12:00:00\.000Z:create_task:[0-9a-f]{16}$/);
  });

  it("gives two different lines two ids", () => {
    const alpha = agentActionNotification(line({ task: "task-alpha" }))!.id;
    const beta = agentActionNotification(line({ task: "task-beta" }))!.id;
    expect(alpha).not.toBe(beta);
    // The client's own name is not in the digest, so it is the ids that make
    // a row distinct, the way the id's own shape says.
    const sameIds = agentActionNotification(line({ task: "task-alpha", client: "Other" }))!.id;
    expect(sameIds).toBe(alpha);
  });

  it("says nothing about a call that was refused", () => {
    expect(agentActionNotification(line({ task: "task-alpha", outcome: "not_found" }))).toBeNull();
    expect(agentActionNotification(line({ task: "task-alpha", outcome: "conflict" }))).toBeNull();
  });

  it("says nothing about a read", () => {
    for (const tool of [
      "get_task",
      "list_tasks",
      "read_page",
      "search",
      "list_tree",
      "list_mail_threads",
      "get_mail_thread",
      "read_mail_message",
      "search_mail",
      "list_mail_accounts",
      "get_mail_send_status",
    ]) {
      expect(agentActionNotification(line({ tool }))).toBeNull();
    }
  });

  it("says nothing about the import family or the handshake", () => {
    for (const tool of [
      "notion_reserve_page",
      "notion_upload_attachment",
      "notion_finalize_page",
      "connection_check",
    ]) {
      expect(agentActionNotification(line({ tool, page: "notes" }))).toBeNull();
    }
  });

  it("says nothing about a line whose instant the centre would refuse", () => {
    expect(agentActionNotification(line({ at: "2026-09-14", task: "task-alpha" }))).toBeNull();
    expect(agentActionNotification(line({ at: "not an instant", task: "task-alpha" }))).toBeNull();
  });

  it("keeps a client name the bell can draw, and a row for one it cannot", () => {
    expect(agentActionNotification(line({ client: "  Claude\nDesktop  " }))!.title).toBe(
      "Claude Desktop created a task",
    );
    expect(agentActionNotification(line({ client: "   " }))!.title).toBe("An app created a task");
    expect(agentActionNotification(line({ client: "c".repeat(400) }))!.title.length).toBe(200);
  });

  it("cuts a title from the store to what the centre holds", () => {
    const row = agentActionNotification(line({ task: "task-alpha" }), "t".repeat(500));
    expect(row!.body!.length).toBe(400);
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("opens the surface rather than a path the centre would refuse", () => {
    // A page id the store would never mint. The derived path is checked
    // against the centre's own rule, so a row lands on the surface instead of
    // being written, announced and then refused at the next read.
    const row = agentActionNotification(line({ tool: "write_page", page: "a b#c" }));
    expect(row!.href).toBe("/");
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });
});
