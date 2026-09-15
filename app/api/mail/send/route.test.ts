import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSendInput } from "@/lib/mail/message-types";

/** `origin` is Brain's own record of who wrote a message, and the header a
 *  person filters an agent's mail on. The route used to hand the body
 *  straight to the service, so anything that could reach this same-origin
 *  route, the owner's own browser or a script inside it, could claim to be an
 *  agent. The route stamps its own value now, and these say so. */

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));

// Only the factory is replaced: `runMailApiAction` branches on the real
// `BrainMailClientError`, and a stand-in would turn every service refusal
// into a 503.
vi.mock("@/lib/mail/brain-mail-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/brain-mail-client")>()),
  createBrainMailClient: () => ({ sendMessage }),
}));

const ACCOUNT = "account-a00000000000000000000000000000000";

function composed(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    idempotencyKey: "browser-key-alpha-0001",
    mode: "compose",
    to: ["friend@example.net"],
    cc: [],
    bcc: [],
    subject: "Hello",
    text: "one line",
    replyToMessageId: null,
    attachments: [],
    origin: "app",
    agentLine: false,
    ...overrides,
  };
}

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("https://brain.test/api/mail/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://brain.test",
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({
    apiVersion: 1,
    operationId: "send-alpha",
    created: true,
    status: "queued",
  });
  vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the browser's own send route", () => {
  it("stamps the origin itself and ignores the one the body claims", async () => {
    const response = await post(
      composed({ origin: "mcp", agentLine: true }),
    );

    expect(response.status).toBe(200);
    const sent = sendMessage.mock.calls[0][0] as MailSendInput;
    expect(sent.origin).toBe("app");
    // `agentLine` only does anything on an "mcp" origin, service-side, so an
    // owner's message cannot carry the agent's line either.
    expect(sent.subject).toBe("Hello");
  });

  it("stamps it on a body that names no origin at all", async () => {
    const withoutOrigin: Record<string, unknown> = composed();
    delete withoutOrigin.origin;
    const response = await post(withoutOrigin);

    expect(response.status).toBe(200);
    expect((sendMessage.mock.calls[0][0] as MailSendInput).origin).toBe("app");
  });

  it("hands a body that is not an object to the service unchanged", async () => {
    // The codec is the one place that says what a send request is, and a
    // refusal from it names the request rather than an origin the route
    // invented for it.
    await post("not an object");

    expect(sendMessage.mock.calls[0][0]).toBe("not an object");
  });
});
