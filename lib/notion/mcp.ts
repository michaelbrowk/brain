import {
  AttachmentValidationError,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/store";
import { z } from "zod";
import {
  collectionDefinitionSchema,
  collectionRowSchema,
} from "../collections/model";

const brainPageIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const notionIdSchema = z.string().min(32).max(36);
const sourceHashSchema = z.string().regex(/^[A-Fa-f0-9]{64}$/);
const reservationTokenSchema = z.string().min(16).max(128);

export const notionFindPageInputSchema = z
  .object({
    notionId: notionIdSchema,
    reservationToken: reservationTokenSchema.optional(),
  })
  .strict();

export const notionInspectCandidateInputSchema = z
  .object({ pageId: brainPageIdSchema })
  .strict();

export const notionAdoptPageInputSchema = z
  .object({
    pageId: z.string().min(1),
    notionId: notionIdSchema,
    sourceHash: sourceHashSchema,
    conversionHash: sourceHashSchema,
    expectedRev: z.string().min(1).max(128),
    expectedParentId: z.string().nullable(),
    expectedBeforeId: z.string().nullable(),
  })
  .strict();

export const notionReservePageInputShape = {
  notionId: notionIdSchema,
  sourceHash: sourceHashSchema,
  conversionHash: sourceHashSchema.optional(),
  parentId: brainPageIdSchema.nullable(),
  beforeId: brainPageIdSchema.nullable(),
  title: z.string().min(1).max(500),
  icon: z.string().max(64).optional(),
  cover: z.string().max(2_048).optional(),
  reservationToken: reservationTokenSchema,
  acknowledgedAbort: z
    .object({
      sourceHash: sourceHashSchema,
      reservationToken: reservationTokenSchema,
    })
    .strict()
    .optional(),
} satisfies z.ZodRawShape;

export const notionReservePageInputSchema = z
  .object(notionReservePageInputShape)
  .strict();

export const MAX_NOTION_MCP_ATTACHMENT_BYTES = MAX_ATTACHMENT_BYTES;
export const MAX_NOTION_ATTACHMENT_BASE64_CHARS =
  Math.ceil(MAX_NOTION_MCP_ATTACHMENT_BYTES / 3) * 4;

export const notionUploadAttachmentInputShape = {
  notionId: notionIdSchema,
  sourceHash: sourceHashSchema,
  expectedSha256: sourceHashSchema,
  reservationToken: reservationTokenSchema,
  originalName: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  dataBase64: z.string().max(MAX_NOTION_ATTACHMENT_BASE64_CHARS),
} satisfies z.ZodRawShape;

export const notionUploadAttachmentInputSchema = z.object(
  notionUploadAttachmentInputShape,
).strict();

export const notionVerifyAttachmentInputShape = {
  notionId: notionIdSchema,
  sourceHash: sourceHashSchema,
  reservationToken: reservationTokenSchema,
  url: z
    .string()
    .regex(/^\/_attachments-v2\/[a-f0-9]{64}\.[A-Za-z0-9_-]{1,32}$/),
} satisfies z.ZodRawShape;

export const notionVerifyAttachmentInputSchema = z.object(
  notionVerifyAttachmentInputShape,
).strict();

export const notionVerifyFinalizedAttachmentInputShape = {
  notionId: notionIdSchema,
  sourceHash: sourceHashSchema,
  conversionHash: sourceHashSchema,
  url: z
    .string()
    .regex(/^\/_attachments-v2\/[a-f0-9]{64}\.[A-Za-z0-9_-]{1,32}$/),
} satisfies z.ZodRawShape;

export const notionVerifyFinalizedAttachmentInputSchema = z.object(
  notionVerifyFinalizedAttachmentInputShape,
).strict();

export const notionFinalizePageInputSchema = z
  .object({
    notionId: notionIdSchema,
    sourceHash: sourceHashSchema,
    conversionHash: sourceHashSchema,
    reservationToken: reservationTokenSchema,
    markdown: z.string(),
    title: z.string().min(1).max(500).optional(),
    icon: z.string().max(64).optional(),
    cover: z.string().max(2_048).optional(),
    collection: collectionDefinitionSchema.nullable().optional(),
    collectionRow: collectionRowSchema.nullable().optional(),
  })
  .strict();

export const notionAbortPageInputSchema = z
  .object({
    notionId: notionIdSchema,
    sourceHash: sourceHashSchema,
    reservationToken: reservationTokenSchema,
  })
  .strict();

/** Node's base64 decoder is deliberately forgiving. MCP imports fail closed so
 *  corrupt payloads cannot be acknowledged as successfully saved files. */
export function decodeNotionAttachmentBase64(input: string): Uint8Array {
  if (input.length > MAX_NOTION_ATTACHMENT_BASE64_CHARS) {
    throw new AttachmentValidationError(
      "too_large",
      `encoded attachment exceeds ${MAX_NOTION_MCP_ATTACHMENT_BYTES} bytes`,
    );
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input) || input.length % 4 === 1) {
    throw new AttachmentValidationError(
      "invalid_mime",
      "attachment data is not valid base64",
    );
  }
  const unpadded = input.replace(/=+$/, "");
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  const bytes = Buffer.from(padded, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new AttachmentValidationError(
      "invalid_mime",
      "attachment data is not valid base64",
    );
  }
  if (bytes.byteLength > MAX_NOTION_MCP_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      "too_large",
      `attachment exceeds ${MAX_NOTION_MCP_ATTACHMENT_BYTES} bytes`,
    );
  }
  return new Uint8Array(bytes);
}
