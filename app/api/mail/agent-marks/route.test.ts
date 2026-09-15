import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSendOperation, MailSendStatus } from "@/lib/mail/message-types";
import {
  MCP_AGENT_SEND_MAX,
  readAgentSends,
  recordAgentSend,
  resolveAgentSendThread,
} from "@/lib/mcp/agent-sends";

const { getSendOperation } = vi.hoisted(() => ({ getSendOperation: vi.fn() }));

vi.mock("@/lib/mail/brain-mail-client", () => ({
  createBrainMailClient: () => ({ getSendOperation }),
}));

const ACCOUNT = "account-a00000000000000000000000000000000";

/** A watcher list an injected resolve announces on, so a test waits for the
 *  step it needs rather than for a timer. Mirrors `lib/push/send.ts`'s own
 *  concurrency test: a `setTimeout(0)` here would race the lanes' own
 *  microtasks and fail intermittently. */
const watchers = new Set<() => void>();
const announce = () => {
  for (const watcher of [...watchers]) watcher();
};
const waitFor = (ready: () => boolean) =>
  new Promise<void>((resolve) => {
    const watcher = () => {
      if (!ready()) return;
      watchers.delete(watcher);
      resolve();
    };
    watchers.add(watcher);
    watcher();
  });

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

  it("stops remembering an id once its mark rotates out of the file", async () => {
    await recordAgentSend({ operationId: "send-old", accountId: ACCOUNT, clientName: "Claude" });
    getSendOperation.mockResolvedValue(operation("send-old", "sent", null));

    expect(await get()).toEqual({ marks: [] });
    expect(getSendOperation).toHaveBeenCalledTimes(1);

    // Crowd send-old's mark out of the 200-entry file with newer, already
    // resolved sends — the same rotation every mark gets. None of these
    // touch getSendOperation: they arrive with a thread already on them.
    for (let index = 0; index < MCP_AGENT_SEND_MAX; index += 1) {
      const operationId = `send-fresh-${index}`;
      await recordAgentSend({ operationId, accountId: ACCOUNT, clientName: "Claude" });
      await resolveAgentSendThread(operationId, `thread-fresh-${index}`);
    }
    expect((await readAgentSends()).some((mark) => mark.operationId === "send-old")).toBe(false);

    // A request today reads the file and intersects `settled` with it, so an
    // id whose mark is gone leaves the memo too.
    await get();

    // send-old rotates back in. If `settled` had kept it forever this would
    // never be asked again; it left with the eviction, so it is eligible
    // once more.
    await recordAgentSend({ operationId: "send-old", accountId: ACCOUNT, clientName: "Claude" });
    getSendOperation.mockClear();
    await get();
    expect(getSendOperation).toHaveBeenCalledWith("send-old", expect.anything());
  });

  it("resolves pending marks with a small concurrency, not one at a time", async () => {
    const { AGENT_MARKS_RESOLVE_CONCURRENCY } = await import("./route");
    const total = 8;
    for (let index = 0; index < total; index += 1) {
      await recordAgentSend({
        operationId: `send-${index}`,
        accountId: ACCOUNT,
        clientName: "Claude",
      });
    }
    const started: string[] = [];
    const gates: Array<() => void> = [];
    getSendOperation.mockImplementation(
      (operationId: string) =>
        new Promise<MailSendOperation>((resolve) => {
          started.push(operationId);
          gates.push(() => resolve(operation(operationId, "sent", `thread-for-${operationId}`)));
          announce();
        }),
    );

    const { GET } = await import("./route");
    const answer = GET(new Request("https://brain.test/api/mail/agent-marks"));

    await waitFor(() => started.length === AGENT_MARKS_RESOLVE_CONCURRENCY);
    expect(started).toEqual(["send-0", "send-1", "send-2", "send-3", "send-4"]);

    // A sixth only starts once a lane frees — the concurrency cap doing its
    // job rather than eight round trips firing at once.
    let released = 0;
    while (released < total) {
      gates[released]!();
      released += 1;
      if (started.length < total) {
        await waitFor(
          () => started.length === Math.min(total, AGENT_MARKS_RESOLVE_CONCURRENCY + released),
        );
      }
    }

    const response = await answer;
    expect(response.status).toBe(200);
    const body = (await response.json()) as { marks: unknown[] };
    expect(body.marks).toHaveLength(total);
  });
});
