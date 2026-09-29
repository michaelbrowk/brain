import { describe, expect, it } from "vitest";

import {
  fingerprintMailDraftMutation,
  MAIL_DRAFT_LIMITS,
  MailDraftCodecError,
  mailDraftToDto,
  mailDraftToSummaryDto,
  validateMailDraftCreateInput,
  validateMailDraftListResponse,
  validateMailDraftMutationInput,
  validateStoredMailDraft,
} from "./draft-codec";

const ACCOUNT_ID = `account-a${"1".repeat(32)}`;
const DRAFT_ID = "draft-00000000-0000-4000-8000-000000000001";
const MUTATION_ID =
  "draft-mutation-00000000-0000-4000-8000-000000000001";

describe("mail draft codecs", () => {
  it("keeps incomplete raw address text without pretending it is sendable", () => {
    expect(
      validateMailDraftCreateInput({
        draftId: DRAFT_ID,
        accountId: ACCOUNT_ID,
        intent: { kind: "compose" },
        to: "Misha <misha@",
        cc: "team, another person <",
        bcc: "",
        subject: "Still typing",
        text: "line one\nline two",
      }),
    ).toMatchObject({
      to: "Misha <misha@",
      cc: "team, another person <",
    });
  });

  it("bounds draft content and rejects accessor-backed or extra input", () => {
    const base = {
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      intent: { kind: "compose" },
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      text: "a".repeat(MAIL_DRAFT_LIMITS.maxBodyBytes),
    };
    expect(validateMailDraftCreateInput(base).text).toHaveLength(
      MAIL_DRAFT_LIMITS.maxBodyBytes,
    );
    expect(() =>
      validateMailDraftCreateInput({ ...base, text: `${base.text}a` }),
    ).toThrow(new MailDraftCodecError("mail_draft_request_invalid"));
    expect(() =>
      validateMailDraftCreateInput({ ...base, unknown: true }),
    ).toThrow(new MailDraftCodecError("mail_draft_request_invalid"));
    const accessor = Object.defineProperty({ ...base }, "to", {
      enumerable: true,
      get: () => "secret@example.com",
    });
    expect(() => validateMailDraftCreateInput(accessor)).toThrow(
      new MailDraftCodecError("mail_draft_request_invalid"),
    );
  });

  it("rejects unpaired surrogates without rejecting valid astral Unicode", () => {
    const base = {
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      intent: { kind: "compose" as const },
      to: "😀 <emoji@example.com>",
      cc: "",
      bcc: "",
      subject: "Valid 😀",
      text: "Body 😀",
    };
    expect(validateMailDraftCreateInput(base)).toMatchObject(base);

    for (const malformed of ["\ud800", "\udc00"]) {
      for (const field of ["to", "cc", "bcc", "subject", "text"] as const) {
        expect(() =>
          validateMailDraftCreateInput({ ...base, [field]: malformed }),
        ).toThrow(new MailDraftCodecError("mail_draft_request_invalid"));
      }
      expect(() =>
        validateMailDraftCreateInput({
          ...base,
          intent: { kind: "reply", sourceMessageId: malformed },
        }),
      ).toThrow(new MailDraftCodecError("mail_draft_request_invalid"));
      expect(() =>
        validateMailDraftMutationInput({
          accountId: ACCOUNT_ID,
          draftId: DRAFT_ID,
          mutationId: MUTATION_ID,
          expectedRevision: 0,
          kind: "patch",
          patch: { text: malformed },
        }),
      ).toThrow(new MailDraftCodecError("mail_draft_request_invalid"));
    }
  });

  it("fingerprints canonical patches and rejects changed mutation reuse", () => {
    const first = validateMailDraftMutationInput({
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      mutationId: MUTATION_ID,
      expectedRevision: 2,
      kind: "patch",
      patch: { subject: "Subject", to: "partial@" },
    });
    const reordered = validateMailDraftMutationInput({
      kind: "patch",
      mutationId: MUTATION_ID,
      expectedRevision: 2,
      draftId: DRAFT_ID,
      accountId: ACCOUNT_ID,
      patch: { to: "partial@", subject: "Subject" },
    });
    const changed = validateMailDraftMutationInput({
      ...first,
      patch: { subject: "Changed", to: "partial@" },
    });
    expect(fingerprintMailDraftMutation(first)).toBe(
      fingerprintMailDraftMutation(reordered),
    );
    expect(fingerprintMailDraftMutation(changed)).not.toBe(
      fingerprintMailDraftMutation(first),
    );
  });

  describe("a send that carries the compose sheet's files", () => {
    const SEND = {
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      mutationId: MUTATION_ID,
      expectedRevision: 2,
      kind: "send",
      sendIdempotencyKey: "draft-send-key-0001",
      sendOperationId: "send-00000000-0000-4000-8000-000000000001",
    } as const;
    const file = { filename: "quote.pdf", mimeType: "application/pdf", dataBase64: "AQID" };

    it("takes the files under the codec, and a send without them reads as it always did", () => {
      const bare = validateMailDraftMutationInput(SEND);
      expect(bare).not.toHaveProperty("attachments");
      const withFiles = validateMailDraftMutationInput({ ...SEND, attachments: [file] });
      expect(withFiles).toMatchObject({ kind: "send", attachments: [file] });
      // An empty list is no files: the same mutation, the same fingerprint.
      const empty = validateMailDraftMutationInput({ ...SEND, attachments: [] });
      expect(empty).not.toHaveProperty("attachments");
      expect(fingerprintMailDraftMutation(empty)).toBe(fingerprintMailDraftMutation(bare));
    });

    it("refuses files the codec refuses, and a patch that names files", () => {
      for (const attachments of [
        [{ ...file, dataBase64: "!!!=" }],
        [{ ...file, filename: "a/b.pdf" }],
        [{ ...file, mimeType: "Application/PDF" }],
        Array.from({ length: 11 }, () => file),
        "quote.pdf",
      ]) {
        expect(() => validateMailDraftMutationInput({ ...SEND, attachments })).toThrow(
          MailDraftCodecError,
        );
      }
      expect(() =>
        validateMailDraftMutationInput({
          ...SEND,
          kind: "patch",
          patch: { subject: "x" },
          attachments: [file],
        }),
      ).toThrow(MailDraftCodecError);
    });

    it("fingerprints the files by their digests, so a replay with other files is another mutation", () => {
      const one = validateMailDraftMutationInput({ ...SEND, attachments: [file] });
      const other = validateMailDraftMutationInput({
        ...SEND,
        attachments: [{ ...file, dataBase64: "AQIE" }],
      });
      const renamed = validateMailDraftMutationInput({
        ...SEND,
        attachments: [{ ...file, filename: "quote-2.pdf" }],
      });
      const bare = validateMailDraftMutationInput(SEND);
      const prints = new Set(
        [one, other, renamed, bare].map((mutation) => fingerprintMailDraftMutation(mutation)),
      );
      expect(prints.size).toBe(4);
      expect(fingerprintMailDraftMutation(one)).toBe(
        fingerprintMailDraftMutation(validateMailDraftMutationInput({ ...SEND, attachments: [file] })),
      );
    });
  });

  it("requires sent tombstones to have scrubbed content and attachments", () => {
    const sent = storedDraft({
      revision: 4,
      state: "sent",
      to: "",
      subject: "",
      text: "",
      sendIdempotencyKey: "send-draft-1",
      sendOperationId: "send-00000000-0000-4000-8000-000000000001",
      sentAt: 20,
      updatedAt: 20,
    });
    expect(mailDraftToDto(validateStoredMailDraft(sent))).not.toHaveProperty(
      "sendIdempotencyKey",
    );
    expect(() => validateStoredMailDraft({ ...sent, subject: "still here" })).toThrow(
      new MailDraftCodecError("mail_draft_response_invalid"),
    );
  });

  it("keeps draft lists bounded by projecting large bodies to summaries", () => {
    const stored = validateStoredMailDraft(
      storedDraft({ text: "a".repeat(MAIL_DRAFT_LIMITS.maxBodyBytes) }),
    );
    const summary = mailDraftToSummaryDto(stored);
    expect(summary).toMatchObject({
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      subject: "Subject",
    });
    expect(summary).not.toHaveProperty("text");
    expect(summary).not.toHaveProperty("to");
    expect(summary).not.toHaveProperty("attachments");
    const response = validateMailDraftListResponse({
      apiVersion: 1,
      drafts: [summary],
    });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(
      MAIL_DRAFT_LIMITS.maxListResponseBytes,
    );
  });
});

function storedDraft(
  override: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    apiVersion: 1,
    draftId: DRAFT_ID,
    accountId: ACCOUNT_ID,
    revision: 0,
    state: "editing",
    intent: { kind: "compose" },
    threading: null,
    to: "friend@",
    cc: "",
    bcc: "",
    subject: "Subject",
    text: "Body",
    attachments: [],
    sendIdempotencyKey: null,
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: 10,
    updatedAt: 10,
    sentAt: null,
    ...override,
  };
}
