import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The four doors in front of the service's new-senders routes. Each one is
 *  held to the same terms as every other mail mutation: same origin, JSON,
 *  a bounded body, and a shape checked before anything reaches the socket. */

const client = vi.hoisted(() => ({
  getSenderScreenState: vi.fn(),
  setSenderScreenEnabled: vi.fn(),
  decideSender: vi.fn(),
  undoSenderDecision: vi.fn(),
  listBlockedSenders: vi.fn(),
}));

// Only the factory is replaced: `runMailApiAction` branches on the real
// `BrainMailClientError`, and a stand-in would turn every refusal into a 503.
vi.mock("@/lib/mail/brain-mail-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/brain-mail-client")>()),
  createBrainMailClient: () => client,
}));

const ORIGIN = "https://brain.test";
const ACCOUNT = "account-a00000000000000000000000000000000";
const DECISION = "decision-a0123456789abcdef0123456789abcdef";
const STATE = {
  apiVersion: 1,
  enabled: true,
  enabledAt: 5,
  backfillComplete: true,
  domainScopeRefused: ["gmail.com"],
};

beforeEach(() => {
  for (const method of Object.values(client)) method.mockReset();
  client.getSenderScreenState.mockResolvedValue(STATE);
  client.setSenderScreenEnabled.mockResolvedValue({
    ...STATE,
    enabled: false,
    enabledAt: null,
    backfillComplete: false,
  });
  client.decideSender.mockResolvedValue({
    apiVersion: 1,
    decisionId: DECISION,
    archived: [{ accountId: ACCOUNT, threadId: "thread-1" }],
    pending: false,
  });
  client.undoSenderDecision.mockResolvedValue({ apiVersion: 1, restored: [], pending: false });
  client.listBlockedSenders.mockResolvedValue({ apiVersion: 1, blocked: [] });
  vi.stubEnv("BRAIN_PUBLIC_ORIGIN", ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function jsonRequest(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body,
  });
}

async function code(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: { code?: unknown } }).error?.code;
}

describe("the new-senders proxies", () => {
  it("reads the screen and the Blocked list", async () => {
    const state = await import("./state/route");
    const blocked = await import("./blocked/route");

    const read = await state.GET(new Request(`${ORIGIN}/api/mail/senders/state`));
    const list = await blocked.GET(new Request(`${ORIGIN}/api/mail/senders/blocked`));

    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(STATE);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ apiVersion: 1, blocked: [] });
  });

  it("switches the screen through the JSON door", async () => {
    const { PUT } = await import("./state/route");

    const switched = await PUT(
      jsonRequest("/api/mail/senders/state", "PUT", JSON.stringify({ enabled: false })),
    );

    expect(switched.status).toBe(200);
    expect(client.setSenderScreenEnabled).toHaveBeenCalledWith(false, expect.any(AbortSignal));
  });

  it("records a decision and relays what it archived", async () => {
    const { POST } = await import("./decisions/route");
    const body = { address: "Growth <news@growth.test>", scope: "domain", decision: "block" };

    const answer = await POST(jsonRequest("/api/mail/senders/decisions", "POST", JSON.stringify(body)));

    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ decisionId: DECISION, pending: false });
    expect(client.decideSender).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it("undoes by default and unblocks with restore=false", async () => {
    const { DELETE } = await import("./decisions/[decisionId]/route");
    const params = { params: Promise.resolve({ decisionId: DECISION }) };

    const undo = await DELETE(
      new Request(`${ORIGIN}/api/mail/senders/decisions/${DECISION}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
      params,
    );
    const unblock = await DELETE(
      new Request(`${ORIGIN}/api/mail/senders/decisions/${DECISION}?restore=false`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
      params,
    );

    expect([undo.status, unblock.status]).toEqual([200, 200]);
    expect(client.undoSenderDecision.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [DECISION, { restore: true }],
      [DECISION, { restore: false }],
    ]);
  });

  it("refuses a request from another origin", async () => {
    const state = await import("./state/route");
    const decisions = await import("./decisions/route");
    const decision = await import("./decisions/[decisionId]/route");

    const answers = [
      await state.PUT(
        jsonRequest("/api/mail/senders/state", "PUT", JSON.stringify({ enabled: true }), {
          origin: "https://elsewhere.test",
        }),
      ),
      await decisions.POST(
        jsonRequest(
          "/api/mail/senders/decisions",
          "POST",
          JSON.stringify({ address: "a@b.test", scope: "address", decision: "accept" }),
          { origin: "https://elsewhere.test" },
        ),
      ),
      await decision.DELETE(
        new Request(`${ORIGIN}/api/mail/senders/decisions/${DECISION}`, { method: "DELETE" }),
        { params: Promise.resolve({ decisionId: DECISION }) },
      ),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(403);
      expect(await code(answer)).toBe("mail_request_invalid");
    }
    expectNothingReachedTheService();
  });

  it("refuses a body that is not JSON by its type", async () => {
    const state = await import("./state/route");
    const decisions = await import("./decisions/route");

    const answers = [
      await state.PUT(
        jsonRequest("/api/mail/senders/state", "PUT", JSON.stringify({ enabled: true }), {
          "content-type": "text/plain",
        }),
      ),
      await decisions.POST(
        jsonRequest(
          "/api/mail/senders/decisions",
          "POST",
          JSON.stringify({ address: "a@b.test", scope: "address", decision: "accept" }),
          { "content-type": "application/x-www-form-urlencoded" },
        ),
      ),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(415);
      expect(await code(answer)).toBe("mail_request_invalid");
    }
    expectNothingReachedTheService();
  });

  it("refuses a malformed body, query or target before the socket", async () => {
    const state = await import("./state/route");
    const decisions = await import("./decisions/route");
    const decision = await import("./decisions/[decisionId]/route");
    const remove = (url: string, decisionId: string, body?: string) =>
      decision.DELETE(
        new Request(`${ORIGIN}${url}`, {
          method: "DELETE",
          headers: { origin: ORIGIN, ...(body ? { "content-type": "application/json" } : {}) },
          ...(body ? { body } : {}),
        }),
        { params: Promise.resolve({ decisionId }) },
      );

    const answers = [
      await state.PUT(jsonRequest("/api/mail/senders/state", "PUT", "{not json")),
      await state.PUT(
        jsonRequest("/api/mail/senders/state", "PUT", JSON.stringify({ enabled: "yes" })),
      ),
      await decisions.POST(
        jsonRequest(
          "/api/mail/senders/decisions",
          "POST",
          JSON.stringify({ address: "a@b.test", scope: "everyone", decision: "block" }),
        ),
      ),
      await decisions.POST(
        jsonRequest(
          "/api/mail/senders/decisions",
          "POST",
          JSON.stringify({ address: "a@b.test", scope: "address", decision: "block", x: 1 }),
        ),
      ),
      await remove(`/api/mail/senders/decisions/${DECISION}?restore=maybe`, DECISION),
      await remove(`/api/mail/senders/decisions/${DECISION}?also=1`, DECISION),
      await remove(`/api/mail/senders/decisions/${DECISION}?restore=false&also=1`, DECISION),
      await remove(`/api/mail/senders/decisions/${DECISION}?restore=true&restore=false`, DECISION),
      await remove("/api/mail/senders/decisions/decision-1", "decision-1"),
      await remove(`/api/mail/senders/decisions/${DECISION}`, DECISION, "{}"),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(await code(answer)).toBe("mail_request_invalid");
    }
    expectNothingReachedTheService();
  });

  it("relays the screen's own refusal unchanged", async () => {
    const { BrainMailClientError } = await import("@/lib/mail/brain-mail-client");
    client.undoSenderDecision.mockRejectedValueOnce(
      new BrainMailClientError(404, "mail_sender_decision_not_found"),
    );
    client.getSenderScreenState.mockRejectedValueOnce(
      new BrainMailClientError(503, "mail_senders_unavailable"),
    );
    const decision = await import("./decisions/[decisionId]/route");
    const state = await import("./state/route");

    const undo = await decision.DELETE(
      new Request(`${ORIGIN}/api/mail/senders/decisions/${DECISION}`, {
        method: "DELETE",
        headers: { origin: ORIGIN },
      }),
      { params: Promise.resolve({ decisionId: DECISION }) },
    );
    const read = await state.GET(new Request(`${ORIGIN}/api/mail/senders/state`));

    expect([undo.status, await code(undo)]).toEqual([404, "mail_sender_decision_not_found"]);
    expect([read.status, await code(read)]).toEqual([503, "mail_senders_unavailable"]);
  });
});

function expectNothingReachedTheService(): void {
  expect(client.setSenderScreenEnabled).not.toHaveBeenCalled();
  expect(client.decideSender).not.toHaveBeenCalled();
  expect(client.undoSenderDecision).not.toHaveBeenCalled();
}
