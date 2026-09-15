import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as activityLog from "@/lib/mcp/activity-log";
import { appendMcpActivity } from "@/lib/mcp/activity-log";
import { DELETE, GET, SHOWN } from "./route";

const ACCOUNT = "account-a00000000000000000000000000000000";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-activity-route-"));
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function write(index: number): Promise<void> {
  await appendMcpActivity({
    at: new Date(1_757_000_000_000 + index * 1000).toISOString(),
    client: "Claude",
    tool: "update_mail_thread",
    accountId: ACCOUNT,
    threadId: `thread-${index}`,
    change: "archive",
    outcome: "ok",
  });
}

describe("the agent activity route", () => {
  it("answers an empty list before an agent has done anything", async () => {
    const answer = await GET();
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ entries: [] });
  });

  it("answers the newest lines first and never more than the shown count", async () => {
    for (let index = 0; index < SHOWN + 5; index += 1) await write(index);

    const body = (await (await GET()).json()) as {
      entries: Array<{ threadId: string }>;
    };

    expect(body.entries).toHaveLength(SHOWN);
    expect(body.entries[0].threadId).toBe(`thread-${SHOWN + 4}`);
    expect(body.entries[SHOWN - 1].threadId).toBe("thread-5");
  });

  it("empties the log on a clear", async () => {
    await write(0);
    const cleared = await DELETE();
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(await (await GET()).json()).toEqual({ entries: [] });
  });

  it("answers a sentence and a code when the read itself throws", async () => {
    // `readMcpActivity` swallows its own read failures lower down, so nothing
    // in the shipped stack reaches this branch: the stand-in is what proves
    // the rejection becomes an answer rather than an unhandled one.
    const read = vi
      .spyOn(activityLog, "readMcpActivity")
      .mockRejectedValue(new Error("EIO: /srv/brain/state/mcp-activity.jsonl"));
    try {
      const answer = await GET();
      expect(answer.status).toBe(500);
      const body = await answer.json();
      expect(body).toEqual({
        error: "couldn't read the agent activity log",
        reason: "activity_read_failed",
      });
      expect(JSON.stringify(body)).not.toContain("/srv/brain/state");
    } finally {
      read.mockRestore();
    }
  });

  it("answers a sentence and a code when the clear itself throws", async () => {
    const clear = vi
      .spyOn(activityLog, "clearMcpActivity")
      .mockRejectedValue(new Error("EACCES: /srv/brain/state"));
    try {
      const answer = await DELETE();
      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({
        error: "couldn't clear the agent activity log",
        reason: "activity_clear_failed",
      });
    } finally {
      clear.mockRestore();
    }
  });
});
