import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailSendInput } from "@/lib/mail/message-types";
import { MAIL_SEND_ATTACHMENT_LIMITS } from "@/lib/mail/send-attachment-codec";
import { MAIL_SERVICE_HTTP_LIMITS } from "@/lib/mail/service/limits";

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

  describe("the compose sheet's files", () => {
    /** "AQID" decodes to three bytes and carries no padding. */
    const file = (override: Record<string, unknown> = {}) => ({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      dataBase64: "AQID",
      ...override,
    });
    /** Base64 of exactly `bytes` decoded bytes, one repeated character. */
    const payloadOf = (bytes: number) => {
      const groups = Math.ceil(bytes / 3);
      const padding = groups * 3 - bytes;
      return "A".repeat(groups * 4 - padding) + "=".repeat(padding);
    };
    const refusal = async (response: Response) =>
      ((await response.json()) as { error: { code: string } }).error.code;

    it("hands the files to the service as the codec admits them", async () => {
      const attachments = [
        file(),
        file({ filename: "notes.txt", mimeType: "text/plain", dataBase64: payloadOf(5) }),
      ];
      const response = await post(composed({ attachments }));

      expect(response.status).toBe(200);
      expect((sendMessage.mock.calls[0][0] as MailSendInput).attachments).toEqual(attachments);
    });

    it("takes a set exactly at the total cap", async () => {
      const response = await post(
        composed({
          attachments: [
            file({ dataBase64: payloadOf(3) }),
            file({
              filename: "second.pdf",
              dataBase64: payloadOf(MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes - 3),
            }),
          ],
        }),
      );

      expect(response.status).toBe(200);
    });

    it("answers a set past the total cap with a 413 the sheet words as too large", async () => {
      const response = await post(
        composed({
          attachments: [
            file({ dataBase64: payloadOf(3) }),
            file({
              filename: "second.pdf",
              dataBase64: payloadOf(MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes - 2),
            }),
          ],
        }),
      );

      expect(response.status).toBe(413);
      expect(await refusal(response)).toBe("mail_send_attachments_too_large");
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      [
        "one file past the count cap",
        () => Array.from({ length: MAIL_SEND_ATTACHMENT_LIMITS.maxCount + 1 }, () => file()),
      ],
      ["base64 that is not base64", () => [file({ dataBase64: "!!!=" })]],
      ["base64 with a line break in it", () => [file({ dataBase64: "AQID\nAQID" })]],
      ["base64 that is not a whole number of groups", () => [file({ dataBase64: "AQI" })]],
      [
        "a filename one byte past the cap",
        () => [file({ filename: "a".repeat(MAIL_SEND_ATTACHMENT_LIMITS.maxFilenameBytes + 1) })],
      ],
      ["a header break in the filename", () => [file({ filename: "a\r\nBcc: x@y.z" })]],
      ["an empty filename", () => [file({ filename: "" })]],
      ["a content type that is not a type", () => [file({ mimeType: "not a type" })]],
      ["a content type in capitals", () => [file({ mimeType: "Application/PDF" })]],
      ["a content type with parameters", () => [file({ mimeType: "text/plain; charset=utf-8" })]],
      ["a fourth key on a file", () => [{ ...file(), inline: true }]],
      ["a list that is not a list", () => "invoice.pdf"],
    ])("refuses %s as the files, before the service is asked", async (_name, make) => {
      const response = await post(composed({ attachments: make() }));

      expect(response.status).toBe(400);
      expect(await refusal(response)).toBe("mail_send_attachments_invalid");
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("bounds the body by its bytes before a character of it is parsed", async () => {
      // One byte past the cap, and not JSON at all: a 413 rather than a 400
      // says the body was cut off by its size before anything decoded it.
      const { POST } = await import("./route");
      const response = await POST(
        new Request("https://brain.test/api/mail/send", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://brain.test" },
          body: "x".repeat(MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes + 1),
        }),
      );

      expect(response.status).toBe(413);
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      // Each is a few megabytes of body and hundreds of megabytes parsed.
      ["a million empty files", () => `{"attachments":[${"{},".repeat(1_000_000)}{}]}`],
      ["millions of numbers", () => `[${"1,".repeat(3_000_000)}1]`],
      ["a list nested a hundred thousand deep", () => "[".repeat(100_000)],
    ])("refuses %s by its structure, before a character of it is parsed", async (_name, make) => {
      const { POST } = await import("./route");
      const parse = vi.spyOn(JSON, "parse");
      let response: Response;
      let parsed: number;
      try {
        response = await POST(
          new Request("https://brain.test/api/mail/send", {
            method: "POST",
            headers: { "content-type": "application/json", origin: "https://brain.test" },
            body: make(),
          }),
        );
        parsed = parse.mock.calls.length;
      } finally {
        parse.mockRestore();
      }

      expect(parsed).toBe(0);
      expect(response.status).toBe(400);
      expect(await refusal(response)).toBe("mail_send_request_invalid");
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it("takes a send to a hundred recipients with ten files", async () => {
      const response = await post(
        composed({
          to: Array.from({ length: 100 }, (_, index) => `friend-${index}@example.net`),
          attachments: Array.from(
            { length: MAIL_SEND_ATTACHMENT_LIMITS.maxCount },
            (_, index) => file({ filename: `invoice-${index}.pdf` }),
          ),
        }),
      );

      expect(response.status).toBe(200);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("hands a body that is not an object to the service unchanged", async () => {
    // The codec is the one place that says what a send request is, and a
    // refusal from it names the request rather than an origin the route
    // invented for it.
    await post("not an object");

    expect(sendMessage.mock.calls[0][0]).toBe("not an object");
  });
});
