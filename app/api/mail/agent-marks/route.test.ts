import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSendOperation, MailSendStatus } from "@/lib/mail/message-types";
import { readAgentSends, recordAgentSend } from "@/lib/mcp/agent-sends";

const { getSendOperation } = vi.hoisted(() => ({ getSendOperation: vi.fn() }));

vi.mock("@/lib/mail/brain-mail-client", () => ({
  createBrainMailClient: () => ({ getSendOperation }),
}));

const ACCOUNT = "account-a00000000000000000000000000000000";

let root: string;

function operation(
  operationId: string,
  status: MailSendStatus,
  threadId: string | null,
): MailSendOperation {
  return { apiVersion: 1, operationId, status, threadId };
}

async function get(): Promise<{
  marks: Array<{ accountId: string; threadId: string; clientName: string }>;
}> {
  const { GET } = await import("./route");
  const answer = await GET(new Request("https://brain.test/api/mail/agent-marks"));
  expect(answer.status).toBe(200);
  return (await answer.json()) as {
    marks: Array<{ accountId: string; threadId: string; clientName: string }>;
  };
}

beforeEach(async () => {
  vi.resetModules();
  getSendOperation.mockReset();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-agent-marks-route-"));
  vi.stubEnv("BRAIN_MCP_STATE_DIR", root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the agent send marks route", () => {
  it("answers nothing before an agent has sent", async () => {
    expect(await get()).toEqual({ marks: [] });
    expect(getSendOperation).not.toHaveBeenCalled();
  });

  it("resolves an unresolved mark once and answers from the file after that", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    getSendOperation.mockResolvedValue(operation("send-alpha", "sent", "thread-alpha"));

    expect(await get()).toEqual({
      marks: [{ accountId: ACCOUNT, threadId: "thread-alpha", clientName: "Claude" }],
    });
    expect((await readAgentSends())[0]!.threadId).toBe("thread-alpha");

    expect(await get()).toEqual({
      marks: [{ accountId: ACCOUNT, threadId: "thread-alpha", clientName: "Claude" }],
    });
    expect(getSendOperation).toHaveBeenCalledTimes(1);
  });

  it("asks once and never again for a send whose account keeps no thread", async () => {
    // IMAP has no thread id to give, ever. A caption that is not coming must
    // not cost a round trip on every visit to Sent.
    await recordAgentSend({
      operationId: "send-imap",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    getSendOperation.mockResolvedValue(operation("send-imap", "sent", null));

    expect(await get()).toEqual({ marks: [] });
    expect(await get()).toEqual({ marks: [] });
    expect(getSendOperation).toHaveBeenCalledTimes(1);
  });

  it("asks again while the send is still on its way", async () => {
    await recordAgentSend({
      operationId: "send-slow",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    getSendOperation.mockResolvedValueOnce(operation("send-slow", "queued", null));
    getSendOperation.mockResolvedValueOnce(operation("send-slow", "sent", "thread-slow"));

    expect(await get()).toEqual({ marks: [] });
    expect(await get()).toEqual({
      marks: [{ accountId: ACCOUNT, threadId: "thread-slow", clientName: "Claude" }],
    });
  });

  it("skips a resolve that throws rather than failing the request", async () => {
    await recordAgentSend({
      operationId: "send-broken",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    await recordAgentSend({
      operationId: "send-fine",
      accountId: ACCOUNT,
      clientName: "Claude",
    });
    getSendOperation.mockImplementation(async (operationId: string) => {
      if (operationId === "send-broken") throw new Error("socket gone");
      return operation(operationId, "sent", "thread-fine");
    });

    expect(await get()).toEqual({
      marks: [{ accountId: ACCOUNT, threadId: "thread-fine", clientName: "Claude" }],
    });
  });
});
