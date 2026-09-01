import type {
  MailContentAttachmentDto,
  MailMessageContent,
} from "./content-types";
import { MAIL_RESOURCE_LIMITS } from "./security";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_ATTACHMENT_ID = /^attachment-a[0-9a-f]{32}$/;
const SAFE_REMOTE_IMAGE_ID = /^remote-image-a[0-9a-f]{32}$/;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const MAX_FILENAME_BYTES = 1024;
const MAX_CONTENT_ID_BYTES = 998;

export class MailContentCodecError extends Error {
  constructor(readonly code: "mail_content_request_invalid" | "mail_content_response_invalid") {
    super(code);
    this.name = "MailContentCodecError";
  }
}

export function validateMailContentAccountId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ACCOUNT_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailContentMessageId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_PROVIDER_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailContentAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ATTACHMENT_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailContentRemoteImageId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REMOTE_IMAGE_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailMessageContent(value: unknown): MailMessageContent {
  if (!isPlainRecord(value)) throw responseInvalid();
  const accountId = responseField(() => validateMailContentAccountId(value.accountId));
  const messageId = responseField(() => validateMailContentMessageId(value.messageId));
  if (value.apiVersion !== 1 || typeof value.state !== "string") {
    throw responseInvalid();
  }
  const base = { apiVersion: 1 as const, accountId, messageId };
  if (
    value.state === "not_requested" ||
    value.state === "fetching" ||
    value.state === "transient" ||
    value.state === "permanent"
  ) {
    if (!hasExactKeys(value, ["accountId", "apiVersion", "messageId", "state"])) {
      throw responseInvalid();
    }
    return Object.freeze({ ...base, state: value.state });
  }
  if (
    value.state !== "ready" ||
    !hasExactKeys(value, [
      "accountId",
      "apiVersion",
      "attachments",
      "htmlBody",
      "messageId",
      "state",
      "textBody",
    ]) ||
    !Array.isArray(value.attachments) ||
    value.attachments.length > MAIL_RESOURCE_LIMITS.mimeParts
  ) {
    throw responseInvalid();
  }
  const textBody = optionalBody(value.textBody, MAIL_RESOURCE_LIMITS.textCharacters);
  const htmlBody = optionalBody(value.htmlBody, MAIL_RESOURCE_LIMITS.htmlCharacters);
  const attachments = value.attachments.map(validateAttachment);
  if (new Set(attachments.map((attachment) => attachment.attachmentId)).size !== attachments.length) {
    throw responseInvalid();
  }
  return Object.freeze({
    ...base,
    state: "ready" as const,
    textBody,
    htmlBody,
    attachments: Object.freeze(attachments),
  });
}

function validateAttachment(value: unknown): MailContentAttachmentDto {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "attachmentId",
      "bytes",
      "contentId",
      "disposition",
      "filename",
      "mimeType",
    ])
  ) {
    throw responseInvalid();
  }
  const attachmentId = responseField(() =>
    validateMailContentAttachmentId(value.attachmentId),
  );
  if (
    typeof value.mimeType !== "string" ||
    !MIME_TYPE.test(value.mimeType) ||
    value.mimeType !== value.mimeType.toLowerCase() ||
    (value.disposition !== "attachment" && value.disposition !== "inline") ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > MAIL_RESOURCE_LIMITS.rawMessageBytes
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    attachmentId,
    filename: optionalBoundedString(value.filename, MAX_FILENAME_BYTES),
    mimeType: value.mimeType,
    disposition: value.disposition,
    contentId: optionalBoundedString(value.contentId, MAX_CONTENT_ID_BYTES),
    bytes: value.bytes as number,
  });
}

function optionalBody(value: unknown, maxCharacters: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxCharacters) {
    throw responseInvalid();
  }
  return value;
}

function optionalBoundedString(value: unknown, maxBytes: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) {
    throw responseInvalid();
  }
  return value;
}

function responseField<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw responseInvalid();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string");
}

function requestInvalid(): MailContentCodecError {
  return new MailContentCodecError("mail_content_request_invalid");
}

function responseInvalid(): MailContentCodecError {
  return new MailContentCodecError("mail_content_response_invalid");
}
