import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAIL_SEND_ATTACHMENT_LIMITS } from "@/lib/mail/send-attachment-codec";
import { MAIL_SERVICE_HTTP_LIMITS } from "@/lib/mail/service/limits";

/** The draft door is how the compose sheet sends, with its files or without
 *  them: the files ride on the send mutation into the message the service
 *  builds from the draft. These pin what the browser's route lets through to
 *  the service and what it answers first. */

const { sendDraft } = vi.hoisted(() => ({ sendDraft: vi.fn() }));

// Only the factory is replaced: `runMailApiAction` branches on the real
// `BrainMailClientError`.
vi.mock("@/lib/mail/brain-mail-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/brain-mail-client")>()),
  createBrainMailClient: () => ({ sendDraft }),
}));

const ACCOUNT = "account-a00000000000000000000000000000000";
const DRAFT = "draft-00000000-0000-4000-8000-000000000001";
const OPERATION = "send-00000000-0000-4000-8000-000000000001";

function mutation(overrides: Record<string, unknown> = {}) {
  return {
    kind: "send",
    accountId: ACCOUNT,
    draftId: DRAFT,
    mutationId: "draft-mutation-00000000-0000-4000-8000-000000000002",
    expectedRevision: 3,
    sendIdempotencyKey: "draft-send-key-0001",
    sendOperationId: OPERATION,
    ...overrides,
  };
}

/** "AQID" decodes to three bytes and carries no padding. */
const file = (override: Record<string, unknown> = {}) => ({
  filename: "invoice.pdf",
  mimeType: "application/pdf",
  dataBase64: "AQID",
  ...override,
});
const payloadOf = (bytes: number) => {
  const groups = Math.ceil(bytes / 3);
  const padding = groups * 3 - bytes;
  return "A".repeat(groups * 4 - padding) + "=".repeat(padding);
};

async function post(body: unknown): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request(`https://brain.test/api/mail/drafts/${DRAFT}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://brain.test" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ draftId: DRAFT }) },
  );
}

const refusal = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

beforeEach(() => {
  sendDraft.mockReset();
  sendDraft.mockResolvedValue({
    apiVersion: 1,
    replayed: false,
    appliedRevision: 4,
    operationId: OPERATION,
    created: true,
    status: "queued",
  });
  vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the draft door's send route", () => {
  it("hands a send without files to the service as it came", async () => {
    const response = await post(mutation());

    expect(response.status).toBe(202);
    expect(sendDraft).toHaveBeenCalledWith(DRAFT, mutation(), expect.any(AbortSignal));
  });

  it("hands the compose sheet's files on with the mutation", async () => {
    const attachments = [file(), file({ filename: "notes.txt", mimeType: "text/plain" })];
    const response = await post(mutation({ attachments }));

    expect(response.status).toBe(202);
    expect(sendDraft.mock.calls[0]?.[1]).toMatchObject({ attachments });
  });

  it("answers a set past the total cap with a 413 before the service is asked", async () => {
    const response = await post(
      mutation({
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
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("answers a set exactly at the cap but refused for something else as the files' own 400", async () => {
    // At the cap is within it: the size is not what is wrong, so the
    // sentence must not say the files are too large.
    const response = await post(
      mutation({
        attachments: [
          file({
            mimeType: "Application/PDF",
            dataBase64: payloadOf(MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes),
          }),
        ],
      }),
    );

    expect(response.status).toBe(400);
    expect(await refusal(response)).toBe("mail_send_attachments_invalid");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it.each([
    ["one file past the count cap", () => Array.from({ length: 11 }, () => file())],
    ["base64 that is not base64", () => [file({ dataBase64: "!!!=" })]],
    ["a filename past the byte cap", () => [file({ filename: "a".repeat(256) })]],
    ["a content type the codec refuses", () => [file({ mimeType: "Application/PDF" })]],
    ["a list that is not a list", () => "invoice.pdf"],
  ])("refuses %s as the files", async (_name, make) => {
    const response = await post(mutation({ attachments: make() }));

    expect(response.status).toBe(400);
    expect(await refusal(response)).toBe("mail_send_attachments_invalid");
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it("bounds the body by its bytes before a character of it is parsed", async () => {
    const response = await post("x".repeat(MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes + 1));

    expect(response.status).toBe(413);
    expect(sendDraft).not.toHaveBeenCalled();
  });

  it.each([
    // Each is a few megabytes of body and hundreds of megabytes parsed.
    ["a million empty files", () => `{"attachments":[${"{},".repeat(1_000_000)}{}]}`],
    ["millions of numbers", () => `[${"1,".repeat(3_000_000)}1]`],
  ])("refuses %s by its structure, before a character of it is parsed", async (_name, make) => {
    const body = make();
    const parse = vi.spyOn(JSON, "parse");
    let response: Response;
    let parsed: number;
    try {
      response = await post(body);
      parsed = parse.mock.calls.length;
    } finally {
      parse.mockRestore();
    }

    expect(parsed).toBe(0);
    expect(response.status).toBe(400);
    expect(await refusal(response)).toBe("mail_draft_request_invalid");
    expect(sendDraft).not.toHaveBeenCalled();
  });
});
