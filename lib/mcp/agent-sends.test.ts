import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCP_AGENT_SENDS_FILE,
  MCP_AGENT_SEND_MAX,
  readAgentSends,
  recordAgentSend,
  resolveAgentSendThread,
} from "./agent-sends";

const ACCOUNT = "account-a00000000000000000000000000000000";

let root: string;

beforeEach(() => {
  root = path.join(os.tmpdir(), "brain-mcp-sends-test");
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the agent send marks", () => {
  it("answers nothing before an agent has sent", async () => {
    expect(await readAgentSends()).toEqual([]);
  });

  it("records a send with no thread yet", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    expect(await readAgentSends()).toEqual([
      { operationId: "send-alpha", accountId: ACCOUNT, clientName: "Claude", threadId: null },
    ]);
  });

  it("resolves one mark's thread and leaves the rest alone", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    await recordAgentSend({
      operationId: "send-beta",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    await resolveAgentSendThread("send-beta", "thread-beta");
    const marks = await readAgentSends();
    expect(marks.find((mark) => mark.operationId === "send-alpha")?.threadId).toBeNull();
    expect(marks.find((mark) => mark.operationId === "send-beta")?.threadId).toBe(
      "thread-beta",
    );
  });

  it("ignores a resolve for an operation it never recorded", async () => {
    await resolveAgentSendThread("send-gamma", "thread-gamma");
    expect(await readAgentSends()).toEqual([]);
  });

  it("records one mark per operation, not one per call", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    expect(await readAgentSends()).toHaveLength(1);
  });

  it("drops the oldest mark at the cap", async () => {
    for (let i = 0; i < MCP_AGENT_SEND_MAX + 5; i += 1) {
      await recordAgentSend({
        operationId: `send-${i}`,
        accountId: ACCOUNT,
        clientName: "Claude",
      });
    }
    const marks = await readAgentSends();
    expect(marks).toHaveLength(MCP_AGENT_SEND_MAX);
    expect(marks[0].operationId).toBe("send-5");
    expect(marks.at(-1)?.operationId).toBe(`send-${MCP_AGENT_SEND_MAX + 4}`);
  });

  it("writes the file under 0600 in a 0700 directory", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(root, MCP_AGENT_SENDS_FILE))).mode & 0o777).toBe(0o600);
  });

  it("holds three ids and an app name, and nothing a message carried", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
      // @ts-expect-error the mark shape is the redaction: there is no such field
      subject: "the quarterly numbers",
    });
    const raw = await fs.readFile(path.join(root, MCP_AGENT_SENDS_FILE), "utf8");
    expect(raw).not.toContain("quarterly");
  });

  it("answers nothing on a file a person edited badly", async () => {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, MCP_AGENT_SENDS_FILE), "{not json", { mode: 0o600 });
    expect(await readAgentSends()).toEqual([]);
  });
});
