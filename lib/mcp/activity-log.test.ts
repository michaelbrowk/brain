import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_ACTIVITY_FILE,
  MCP_ACTIVITY_MAX_LINES,
  appendMcpActivity,
  clearMcpActivity,
  mcpStateDirectory,
  readMcpActivity,
} from "./activity-log";

const ACCOUNT = "account-a00000000000000000000000000000000";

let root: string;

beforeEach(() => {
  root = path.join(os.tmpdir(), "brain-mcp-activity-test");
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the MCP activity log", () => {
  it("re-exports the state directory so a caller has one import", () => {
    expect(mcpStateDirectory()).toBe(root);
  });

  it("appends one line per call and reads the newest first", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      accountId: ACCOUNT,
      operationId: "send-alpha",
      outcome: "ok",
    });
    await appendMcpActivity({
      at: "2026-09-14T09:00:01.000Z",
      client: "Claude",
      tool: "update_mail_thread",
      accountId: ACCOUNT,
      threadId: "thread-alpha",
      outcome: "ok",
    });
    const entries = await readMcpActivity(50);
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe("update_mail_thread");
    expect(entries[0].threadId).toBe("thread-alpha");
    expect(entries[1].operationId).toBe("send-alpha");
  });

  it("answers nothing before anything has been written", async () => {
    expect(await readMcpActivity(50)).toEqual([]);
  });

  it("drops the oldest line at the cap and never grows past it", async () => {
    for (let i = 0; i < MCP_ACTIVITY_MAX_LINES + 10; i += 1) {
      await appendMcpActivity({
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "get_task",
        task: `task-${i}`,
        outcome: "ok",
      });
    }
    const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
    expect(raw.trimEnd().split("\n")).toHaveLength(MCP_ACTIVITY_MAX_LINES);
    const entries = await readMcpActivity(MCP_ACTIVITY_MAX_LINES);
    expect(entries.at(-1)?.task).toBe("task-10");
  });

  it("reads no more than the limit asked for", async () => {
    for (const task of ["task-alpha", "task-beta", "task-gamma"]) {
      await appendMcpActivity({
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "get_task",
        task,
        outcome: "ok",
      });
    }
    const entries = await readMcpActivity(2);
    expect(entries.map((entry) => entry.task)).toEqual(["task-gamma", "task-beta"]);
  });

  it("strips an address out of a refusal reason", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      accountId: ACCOUNT,
      outcome: "refused mary@example.test is not an address",
    });
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).not.toContain("@");
    expect(entry.outcome).toBe("refused maryexample.test is not an address");
  });

  it("bounds an outcome that carried a whole message into it", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      outcome: "refused ".concat("a".repeat(400)),
    });
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toHaveLength(120);
  });

  it("keeps no field a subject, an address or a title could enter through", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "send_mail",
      accountId: ACCOUNT,
      outcome: "ok",
      // @ts-expect-error the entry shape is the redaction: there is no such field
      subject: "the quarterly numbers",
    });
    const raw = await fs.readFile(path.join(root, MCP_ACTIVITY_FILE), "utf8");
    expect(raw).not.toContain("quarterly");
  });

  it("writes the file under 0600 in a 0700 directory", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, MCP_ACTIVITY_FILE))).mode & 0o777).toBe(0o600);
  });

  it("survives a corrupt line rather than losing the file", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, MCP_ACTIVITY_FILE), "{not json\n", { mode: 0o600 });
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    expect(await readMcpActivity(50)).toHaveLength(1);
  });

  it("clears to nothing and stays readable", async () => {
    await appendMcpActivity({
      at: "2026-09-14T09:00:00.000Z",
      client: "Claude",
      tool: "get_task",
      task: "task-alpha",
      outcome: "ok",
    });
    await clearMcpActivity();
    expect(await readMcpActivity(50)).toEqual([]);
  });

  it("keeps concurrent appends from losing a line", async () => {
    await Promise.all(
      ["task-alpha", "task-beta", "task-gamma", "task-delta"].map((task) =>
        appendMcpActivity({
          at: "2026-09-14T09:00:00.000Z",
          client: "Claude",
          tool: "get_task",
          task,
          outcome: "ok",
        }),
      ),
    );
    expect(await readMcpActivity(50)).toHaveLength(4);
  });
});
