import { describe, expect, it } from "vitest";
import {
  decodeNotionAttachmentBase64,
  MAX_NOTION_ATTACHMENT_BASE64_CHARS,
  MAX_NOTION_MCP_ATTACHMENT_BYTES,
  notionAbortPageInputSchema,
  notionAdoptPageInputSchema,
  notionFinalizePageInputSchema,
  notionFindPageInputSchema,
  notionReservePageInputSchema,
  notionUploadAttachmentInputSchema,
  notionVerifyAttachmentInputSchema,
  notionVerifyFinalizedAttachmentInputSchema,
} from "./mcp";

describe("Notion MCP strict tool contracts", () => {
  const notionId = "a".repeat(32);
  const sourceHash = "b".repeat(64);
  const conversionHash = "c".repeat(64);
  const reservationToken = "client_journal_token_1234";

  it.each([
    [notionFindPageInputSchema, { notionId }],
    [
      notionAdoptPageInputSchema,
      {
        pageId: "brain-page",
        notionId,
        sourceHash,
        conversionHash,
        expectedRev: "rev-1",
        expectedParentId: null,
        expectedBeforeId: null,
      },
    ],
    [
      notionFinalizePageInputSchema,
      {
        notionId,
        sourceHash,
        conversionHash,
        reservationToken,
        markdown: "body",
      },
    ],
    [
      notionAbortPageInputSchema,
      { notionId, sourceHash, reservationToken },
    ],
  ] as const)("rejects unknown keys before a Notion callback", (schema, valid) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe("Notion MCP attachment decoding", () => {
  it("decodes canonical and unpadded base64", () => {
    expect(new TextDecoder().decode(decodeNotionAttachmentBase64("aGVsbG8="))).toBe(
      "hello",
    );
    expect(new TextDecoder().decode(decodeNotionAttachmentBase64("aGVsbG8"))).toBe(
      "hello",
    );
  });

  it.each(["%%%", "a", "aGVsbG8===", "aG Vs"]) (
    "rejects malformed base64 %s",
    (encoded) => {
      expect(() => decodeNotionAttachmentBase64(encoded)).toThrow();
    },
  );

  it("rejects decoded payloads over the Store limit", () => {
    const encoded = Buffer.alloc(MAX_NOTION_MCP_ATTACHMENT_BYTES + 1).toString(
      "base64",
    );
    expect(() => decodeNotionAttachmentBase64(encoded)).toThrowError(
      expect.objectContaining({ code: "too_large" }),
    );
  });
});

describe("Notion reserve MCP contract", () => {
  const valid = {
    notionId: "a".repeat(32),
    sourceHash: "b".repeat(64),
    parentId: null,
    beforeId: null,
    title: "Page",
    reservationToken: "client_journal_token_1234",
  };

  it.each(["parentId", "beforeId", "reservationToken"] as const)(
    "rejects an omitted %s",
    (field) => {
      const input = { ...valid };
      delete input[field];
      expect(notionReservePageInputSchema.safeParse(input).success).toBe(false);
    },
  );

  it("accepts explicit null hierarchy fields", () => {
    expect(notionReservePageInputSchema.parse(valid)).toMatchObject({
      parentId: null,
      beforeId: null,
    });
  });

  it("rejects unknown reserve fields", () => {
    expect(
      notionReservePageInputSchema.safeParse({ ...valid, extra: true }).success,
    ).toBe(false);
  });
});

describe("Notion upload MCP contract", () => {
  it("accepts unchanged attachments up to the Store byte limit", () => {
    const input = {
      notionId: "a".repeat(32),
      sourceHash: "b".repeat(64),
      expectedSha256: "c".repeat(64),
      reservationToken: "client_journal_token_1234",
      originalName: "large.png",
      mimeType: "image/png",
    };
    const productionRepro = Buffer.alloc(3_379_932).toString("base64");
    const overEncodedLimit = "A".repeat(
      MAX_NOTION_ATTACHMENT_BASE64_CHARS + 1,
    );

    expect(
      notionUploadAttachmentInputSchema.safeParse({
        ...input,
        dataBase64: productionRepro,
      }).success,
    ).toBe(true);
    expect(
      notionUploadAttachmentInputSchema.safeParse({
        ...input,
        dataBase64: overEncodedLimit,
      }).success,
    ).toBe(false);
  });

  it("requires the source descriptor hash", () => {
    const withoutExpectedHash = {
      notionId: "a".repeat(32),
      sourceHash: "b".repeat(64),
      reservationToken: "client_journal_token_1234",
      originalName: "file.txt",
      mimeType: "text/plain",
      dataBase64: "aGVsbG8=",
    };
    expect(
      notionUploadAttachmentInputSchema.safeParse(withoutExpectedHash).success,
    ).toBe(false);
    expect(
      notionUploadAttachmentInputSchema.safeParse({
        ...withoutExpectedHash,
        expectedSha256: "c".repeat(64),
      }).success,
    ).toBe(true);
    expect(
      notionUploadAttachmentInputSchema.safeParse({
        ...withoutExpectedHash,
        expectedSha256: "c".repeat(64),
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("Notion attachment verification MCP contract", () => {
  it("accepts only exact content-addressed v2 URLs", () => {
    const valid = {
      notionId: "a".repeat(32),
      sourceHash: "b".repeat(64),
      reservationToken: "client_journal_token_1234",
      url: "/_attachments-v2/" + "c".repeat(64) + ".png",
    };
    expect(notionVerifyAttachmentInputSchema.safeParse(valid).success).toBe(true);
    expect(
      notionVerifyAttachmentInputSchema.safeParse({ ...valid, extra: true })
        .success,
    ).toBe(false);
    expect(
      notionVerifyAttachmentInputSchema.safeParse({
        ...valid,
        url: valid.url + "?download=1",
      }).success,
    ).toBe(false);
    expect(
      notionVerifyAttachmentInputSchema.safeParse({
        ...valid,
        url: "/api/media/" + "c".repeat(64) + ".png",
      }).success,
    ).toBe(false);
  });

  it("requires the finalized conversion identity", () => {
    const valid = {
      notionId: "a".repeat(32),
      sourceHash: "b".repeat(64),
      conversionHash: "c".repeat(64),
      url: "/_attachments-v2/" + "d".repeat(64) + ".png",
    };
    expect(
      notionVerifyFinalizedAttachmentInputSchema.safeParse(valid).success,
    ).toBe(true);
    expect(
      notionVerifyFinalizedAttachmentInputSchema.safeParse({
        ...valid,
        extra: true,
      }).success,
    ).toBe(false);
    const missingConversion = { ...valid } as Partial<typeof valid>;
    delete missingConversion.conversionHash;
    expect(
      notionVerifyFinalizedAttachmentInputSchema.safeParse(missingConversion)
        .success,
    ).toBe(false);
  });
});
