import { createHash } from "node:crypto";

import type {
  MailDraftAttachmentDto,
  MailDraftCreateInput,
  MailDraftCreateResponse,
  MailDraftDeleteResponse,
  MailDraftDeleteInput,
  MailDraftDto,
  MailDraftIntent,
  MailDraftListResponse,
  MailDraftMutationInput,
  MailDraftMutationResponse,
  MailDraftPatch,
  MailDraftSendResponse,
  MailDraftSummaryDto,
  MailDraftThreadingContext,
  StoredMailDraft,
  StoredMailDraftAttachment,
} from "./draft-types";
import { MAIL_DRAFT_API_VERSION } from "./draft-types";
import type { MailSendErrorCode } from "./service/outbound";

export const MAIL_DRAFT_LIMITS = Object.freeze({
  maxDraftsPerAccount: 100,
  maxSentTombstonesPerAccount: 100,
  maxBodyBytes: 1024 * 1024,
  maxAccountBytes: 128 * 1024 * 1024,
  maxMutationReceiptsPerAccount: 128,
  maxDeleteReceiptsPerAccount: 128,
  sentTombstoneMs: 24 * 60 * 60 * 1_000,
  deleteReceiptMs: 24 * 60 * 60 * 1_000,
  maxAddressFieldBytes: 64 * 1024,
  maxSubjectBytes: 998,
  maxSourceMessageIdBytes: 512,
  maxFilenameBytes: 1024,
  maxThreadReferences: 50,
  maxThreadReferencesBytes: 32 * 1024,
  maxListResponseBytes: 2 * 1024 * 1024,
});

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_DRAFT_ID =
  /^draft-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_MUTATION_ID =
  /^draft-mutation-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ATTACHMENT_ID =
  /^draft-attachment-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_SEND_OPERATION_ID = /^send-[0-9a-f-]{36}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_BLOB_NAME = /^sha256-[a-f0-9]{64}$/;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const NO_SINGLE_LINE_CONTROLS = /^[^\u0000-\u001f\u007f]*$/u;
const NO_NUL = /^[^\u0000]*$/u;
const NO_PROVIDER_CONTROLS = /^[^\u0000-\u001f\u007f]+$/u;
const RFC_MESSAGE_ID = /^<[^<>\s\u0000-\u001f\u007f]+>$/u;
const SEND_ERROR_CODES = new Set<MailSendErrorCode>([
  "mail_send_request_invalid",
  "mail_send_account_not_found",
  "mail_send_account_reauth_required",
  "mail_send_reply_target_not_found",
  "mail_send_idempotency_conflict",
  "mail_send_operation_not_found",
  "mail_send_rate_limited",
  "mail_send_service_unavailable",
]);

export type MailDraftCodecErrorCode =
  | "mail_draft_request_invalid"
  | "mail_draft_response_invalid";

export class MailDraftCodecError extends Error {
  constructor(readonly code: MailDraftCodecErrorCode) {
    super(code);
    this.name = "MailDraftCodecError";
  }
}

export function validateMailDraftAccountId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ACCOUNT_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailDraftId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_DRAFT_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailDraftMutationId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_MUTATION_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailDraftCreateInput(
  value: unknown,
): MailDraftCreateInput {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "bcc",
      "cc",
      "draftId",
      "intent",
      "subject",
      "text",
      "to",
    ])
  ) {
    throw requestInvalid();
  }
  return Object.freeze({
    draftId: validateMailDraftId(value.draftId),
    accountId: validateMailDraftAccountId(value.accountId),
    intent: validateIntent(value.intent, "request"),
    to: validateSingleLine(value.to, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "request"),
    cc: validateSingleLine(value.cc, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "request"),
    bcc: validateSingleLine(value.bcc, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "request"),
    subject: validateSingleLine(value.subject, MAIL_DRAFT_LIMITS.maxSubjectBytes, "request"),
    text: validateBody(value.text, "request"),
  });
}

export function validateMailDraftMutationInput(
  value: unknown,
): MailDraftMutationInput {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw requestInvalid();
  }
  const base = {
    accountId: validateMailDraftAccountId(value.accountId),
    draftId: validateMailDraftId(value.draftId),
    mutationId: validateMailDraftMutationId(value.mutationId),
    expectedRevision: validateRevision(value.expectedRevision, "request"),
  };
  if (
    value.kind === "patch" &&
    hasExactKeys(value, [
      "accountId",
      "draftId",
      "expectedRevision",
      "kind",
      "mutationId",
      "patch",
    ])
  ) {
    return Object.freeze({
      ...base,
      kind: "patch" as const,
      patch: validatePatch(value.patch),
    });
  }
  if (
    value.kind === "send" &&
    hasExactKeys(value, [
      "accountId",
      "draftId",
      "expectedRevision",
      "kind",
      "mutationId",
      "sendIdempotencyKey",
      "sendOperationId",
    ]) &&
    typeof value.sendIdempotencyKey === "string" &&
    SAFE_IDEMPOTENCY_KEY.test(value.sendIdempotencyKey) &&
    typeof value.sendOperationId === "string" &&
    SAFE_SEND_OPERATION_ID.test(value.sendOperationId)
  ) {
    return Object.freeze({
      ...base,
      kind: "send" as const,
      sendIdempotencyKey: value.sendIdempotencyKey,
      sendOperationId: value.sendOperationId,
    });
  }
  throw requestInvalid();
}

export function validateMailDraftDeleteInput(
  value: unknown,
): MailDraftDeleteInput {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "draftId",
      "expectedRevision",
      "mutationId",
    ])
  ) {
    throw requestInvalid();
  }
  return Object.freeze({
    accountId: validateMailDraftAccountId(value.accountId),
    draftId: validateMailDraftId(value.draftId),
    mutationId: validateMailDraftMutationId(value.mutationId),
    expectedRevision: validateRevision(value.expectedRevision, "request"),
  });
}

export function validateStoredMailDraft(value: unknown): StoredMailDraft {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "apiVersion",
      "attachments",
      "bcc",
      "cc",
      "createdAt",
      "draftId",
      "intent",
      "revision",
      "sendErrorCode",
      "sendIdempotencyKey",
      "sendOperationId",
      "sentAt",
      "state",
      "subject",
      "text",
      "threading",
      "to",
      "updatedAt",
    ]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    !Array.isArray(value.attachments)
  ) {
    throw responseInvalid();
  }
  const accountId = responseField(() => validateMailDraftAccountId(value.accountId));
  const draftId = responseField(() => validateMailDraftId(value.draftId));
  const revision = validateRevision(value.revision, "response");
  const state = validateState(value.state);
  const intent = validateIntent(value.intent, "response");
  const attachments = value.attachments.map((attachment) =>
    validateStoredAttachment(attachment, accountId, draftId),
  );
  if (
    new Set(attachments.map((attachment) => attachment.attachmentId)).size !==
    attachments.length
  ) {
    throw responseInvalid();
  }
  const sendOperationId = optionalPattern(
    value.sendOperationId,
    SAFE_SEND_OPERATION_ID,
    "response",
  );
  const sendIdempotencyKey = optionalPattern(
    value.sendIdempotencyKey,
    SAFE_IDEMPOTENCY_KEY,
    "response",
  );
  const sendErrorCode = validateSendErrorCode(value.sendErrorCode);
  const createdAt = validateTimestamp(value.createdAt, "response");
  const updatedAt = validateTimestamp(value.updatedAt, "response");
  const sentAt = optionalTimestamp(value.sentAt, "response");
  if (updatedAt < createdAt || (sentAt !== null && sentAt < createdAt)) {
    throw responseInvalid();
  }
  assertStateShape({
    state,
    sendOperationId,
    sendIdempotencyKey,
    sendErrorCode,
    sentAt,
    to: value.to,
    cc: value.cc,
    bcc: value.bcc,
    subject: value.subject,
    text: value.text,
    attachments,
  });
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId,
    accountId,
    revision,
    state,
    intent,
    threading: validateThreading(value.threading),
    to: validateSingleLine(value.to, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "response"),
    cc: validateSingleLine(value.cc, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "response"),
    bcc: validateSingleLine(value.bcc, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "response"),
    subject: validateSingleLine(value.subject, MAIL_DRAFT_LIMITS.maxSubjectBytes, "response"),
    text: validateBody(value.text, "response"),
    attachments: Object.freeze(attachments),
    sendIdempotencyKey,
    sendOperationId,
    sendErrorCode,
    createdAt,
    updatedAt,
    sentAt,
  });
}

export function mailDraftToDto(value: StoredMailDraft): MailDraftDto {
  const draft = validateStoredMailDraft(value);
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId: draft.draftId,
    accountId: draft.accountId,
    revision: draft.revision,
    state: draft.state,
    intent: draft.intent,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
    attachments: Object.freeze(
      draft.attachments.map((attachment): MailDraftAttachmentDto =>
        Object.freeze({
          attachmentId: attachment.attachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
        }),
      ),
    ),
    sendOperationId: draft.sendOperationId,
    sendErrorCode: draft.sendErrorCode,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentAt: draft.sentAt,
  });
}

export function mailDraftToSummaryDto(
  value: StoredMailDraft,
): MailDraftSummaryDto {
  const draft = validateStoredMailDraft(value);
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId: draft.draftId,
    accountId: draft.accountId,
    revision: draft.revision,
    state: draft.state,
    intent: draft.intent,
    subject: draft.subject,
    sendOperationId: draft.sendOperationId,
    sendErrorCode: draft.sendErrorCode,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentAt: draft.sentAt,
  });
}

export function validateMailDraftDto(value: unknown): MailDraftDto {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "apiVersion",
      "attachments",
      "bcc",
      "cc",
      "createdAt",
      "draftId",
      "intent",
      "revision",
      "sendErrorCode",
      "sendOperationId",
      "sentAt",
      "state",
      "subject",
      "text",
      "to",
      "updatedAt",
    ]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    !Array.isArray(value.attachments)
  ) {
    throw responseInvalid();
  }
  const accountId = responseField(() => validateMailDraftAccountId(value.accountId));
  const draftId = responseField(() => validateMailDraftId(value.draftId));
  const revision = validateRevision(value.revision, "response");
  const state = validateState(value.state);
  const intent = validateIntent(value.intent, "response");
  const attachments = value.attachments.map(validateAttachmentDto);
  if (
    new Set(attachments.map((attachment) => attachment.attachmentId)).size !==
    attachments.length
  ) {
    throw responseInvalid();
  }
  const sendOperationId = optionalPattern(
    value.sendOperationId,
    SAFE_SEND_OPERATION_ID,
    "response",
  );
  const sendErrorCode = validateSendErrorCode(value.sendErrorCode);
  const createdAt = validateTimestamp(value.createdAt, "response");
  const updatedAt = validateTimestamp(value.updatedAt, "response");
  const sentAt = optionalTimestamp(value.sentAt, "response");
  const to = validateSingleLine(
    value.to,
    MAIL_DRAFT_LIMITS.maxAddressFieldBytes,
    "response",
  );
  const cc = validateSingleLine(
    value.cc,
    MAIL_DRAFT_LIMITS.maxAddressFieldBytes,
    "response",
  );
  const bcc = validateSingleLine(
    value.bcc,
    MAIL_DRAFT_LIMITS.maxAddressFieldBytes,
    "response",
  );
  const subject = validateSingleLine(
    value.subject,
    MAIL_DRAFT_LIMITS.maxSubjectBytes,
    "response",
  );
  const text = validateBody(value.text, "response");
  if (updatedAt < createdAt || (sentAt !== null && sentAt < createdAt)) {
    throw responseInvalid();
  }
  assertPublicStateShape({
    state,
    sendOperationId,
    sendErrorCode,
    sentAt,
    to,
    cc,
    bcc,
    subject,
    text,
    attachments,
  });
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId,
    accountId,
    revision,
    state,
    intent,
    to,
    cc,
    bcc,
    subject,
    text,
    attachments: Object.freeze(attachments),
    sendOperationId,
    sendErrorCode,
    createdAt,
    updatedAt,
    sentAt,
  });
}

export function validateMailDraftSummaryDto(
  value: unknown,
): MailDraftSummaryDto {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "apiVersion",
      "createdAt",
      "draftId",
      "intent",
      "revision",
      "sendErrorCode",
      "sendOperationId",
      "sentAt",
      "state",
      "subject",
      "updatedAt",
    ]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION
  ) {
    throw responseInvalid();
  }
  const summary = Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    draftId: responseField(() => validateMailDraftId(value.draftId)),
    accountId: responseField(() => validateMailDraftAccountId(value.accountId)),
    revision: validateRevision(value.revision, "response"),
    state: validateState(value.state),
    intent: validateIntent(value.intent, "response"),
    subject: validateSingleLine(
      value.subject,
      MAIL_DRAFT_LIMITS.maxSubjectBytes,
      "response",
    ),
    sendOperationId: optionalPattern(
      value.sendOperationId,
      SAFE_SEND_OPERATION_ID,
      "response",
    ),
    sendErrorCode: validateSendErrorCode(value.sendErrorCode),
    createdAt: validateTimestamp(value.createdAt, "response"),
    updatedAt: validateTimestamp(value.updatedAt, "response"),
    sentAt: optionalTimestamp(value.sentAt, "response"),
  });
  if (
    summary.updatedAt < summary.createdAt ||
    (summary.sentAt !== null && summary.sentAt < summary.createdAt)
  ) {
    throw responseInvalid();
  }
  assertSummaryStateShape(summary);
  return summary;
}

export function validateMailDraftCreateResponse(
  value: unknown,
): MailDraftCreateResponse {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "created", "draft"]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    typeof value.created !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    created: value.created,
    draft: validateMailDraftDto(value.draft),
  });
}

export function validateMailDraftListResponse(
  value: unknown,
): MailDraftListResponse {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "drafts"]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    !Array.isArray(value.drafts) ||
    value.drafts.length >
      MAIL_DRAFT_LIMITS.maxDraftsPerAccount +
        MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount
  ) {
    throw responseInvalid();
  }
  const drafts = value.drafts.map(validateMailDraftSummaryDto);
  if (new Set(drafts.map((draft) => draft.draftId)).size !== drafts.length) {
    throw responseInvalid();
  }
  const response = Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    drafts: Object.freeze(drafts),
  });
  if (
    Buffer.byteLength(JSON.stringify(response)) >
    MAIL_DRAFT_LIMITS.maxListResponseBytes
  ) {
    throw responseInvalid();
  }
  return response;
}

export function validateMailDraftMutationResponse(
  value: unknown,
): MailDraftMutationResponse {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "apiVersion",
      "appliedRevision",
      "operationId",
      "replayed",
    ]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    typeof value.replayed !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    replayed: value.replayed,
    appliedRevision: validateRevision(value.appliedRevision, "response"),
    operationId: optionalPattern(
      value.operationId,
      SAFE_SEND_OPERATION_ID,
      "response",
    ),
  });
}

export function validateMailDraftDeleteResponse(
  value: unknown,
): MailDraftDeleteResponse {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["apiVersion", "deleted", "replayed"]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    value.deleted !== true ||
    typeof value.replayed !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    deleted: true,
    replayed: value.replayed,
  });
}

export function validateMailDraftSendResponse(
  value: unknown,
): MailDraftSendResponse {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "apiVersion",
      "appliedRevision",
      "created",
      "operationId",
      "replayed",
      "status",
    ]) ||
    value.apiVersion !== MAIL_DRAFT_API_VERSION ||
    typeof value.created !== "boolean" ||
    typeof value.replayed !== "boolean" ||
    typeof value.operationId !== "string" ||
    !SAFE_SEND_OPERATION_ID.test(value.operationId) ||
    (value.status !== "queued" &&
      value.status !== "sending" &&
      value.status !== "sent" &&
      value.status !== "failed" &&
      value.status !== "delivery_unknown")
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: MAIL_DRAFT_API_VERSION,
    replayed: value.replayed,
    appliedRevision: validateRevision(value.appliedRevision, "response"),
    operationId: value.operationId,
    created: value.created,
    status: value.status,
  });
}

export function fingerprintMailDraftCreate(value: MailDraftCreateInput): string {
  const input = validateMailDraftCreateInput(value);
  return sha256(
    JSON.stringify({
      accountId: input.accountId,
      bcc: input.bcc,
      cc: input.cc,
      draftId: input.draftId,
      intent: input.intent,
      subject: input.subject,
      text: input.text,
      to: input.to,
    }),
  );
}

export function fingerprintMailDraftMutation(
  value: MailDraftMutationInput,
): string {
  const input = validateMailDraftMutationInput(value);
  return sha256(
    JSON.stringify(
      input.kind === "patch"
        ? {
            accountId: input.accountId,
            draftId: input.draftId,
            expectedRevision: input.expectedRevision,
            kind: input.kind,
            mutationId: input.mutationId,
            patch: canonicalPatch(input.patch),
          }
        : {
            accountId: input.accountId,
            draftId: input.draftId,
            expectedRevision: input.expectedRevision,
            kind: input.kind,
            mutationId: input.mutationId,
            sendIdempotencyKey: input.sendIdempotencyKey,
            sendOperationId: input.sendOperationId,
          },
    ),
  );
}

export function fingerprintMailDraftDelete(value: MailDraftDeleteInput): string {
  const input = validateMailDraftDeleteInput(value);
  return sha256(
    JSON.stringify({
      accountId: input.accountId,
      draftId: input.draftId,
      expectedRevision: input.expectedRevision,
      mutationId: input.mutationId,
    }),
  );
}

export function serializeMailDraftThreading(
  value: MailDraftThreadingContext | null,
): string | null {
  const threading = validateThreading(value);
  return threading === null ? null : JSON.stringify(threading);
}

export function parseMailDraftThreading(
  value: unknown,
): MailDraftThreadingContext | null {
  if (value === null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value) > 64 * 1024) {
    throw responseInvalid();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw responseInvalid();
  }
  return validateThreading(parsed);
}

function validatePatch(value: unknown): MailDraftPatch {
  if (!isPlainRecord(value)) throw requestInvalid();
  const keys = Object.keys(value).sort();
  const allowed = ["bcc", "cc", "subject", "text", "to"];
  if (
    keys.length < 1 ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw requestInvalid();
  }
  const patch: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    text?: string;
  } = {};
  if ("to" in value) {
    patch.to = validateSingleLine(value.to, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "request");
  }
  if ("cc" in value) {
    patch.cc = validateSingleLine(value.cc, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "request");
  }
  if ("bcc" in value) {
    patch.bcc = validateSingleLine(value.bcc, MAIL_DRAFT_LIMITS.maxAddressFieldBytes, "request");
  }
  if ("subject" in value) {
    patch.subject = validateSingleLine(value.subject, MAIL_DRAFT_LIMITS.maxSubjectBytes, "request");
  }
  if ("text" in value) patch.text = validateBody(value.text, "request");
  return Object.freeze(patch);
}

function canonicalPatch(value: MailDraftPatch): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["bcc", "cc", "subject", "text", "to"] as const) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  return result;
}

function validateIntent(
  value: unknown,
  mode: "request" | "response",
): MailDraftIntent {
  if (!isPlainRecord(value) || typeof value.kind !== "string") {
    throw mode === "request" ? requestInvalid() : responseInvalid();
  }
  if (value.kind === "compose" && hasExactKeys(value, ["kind"])) {
    return Object.freeze({ kind: "compose" as const });
  }
  if (
    (value.kind === "reply" ||
      value.kind === "reply_all" ||
      value.kind === "forward") &&
    hasExactKeys(value, ["kind", "sourceMessageId"]) &&
    typeof value.sourceMessageId === "string" &&
    !hasUnpairedSurrogate(value.sourceMessageId) &&
    NO_PROVIDER_CONTROLS.test(value.sourceMessageId) &&
    Buffer.byteLength(value.sourceMessageId) <=
      MAIL_DRAFT_LIMITS.maxSourceMessageIdBytes
  ) {
    return Object.freeze({
      kind: value.kind,
      sourceMessageId: value.sourceMessageId,
    });
  }
  throw mode === "request" ? requestInvalid() : responseInvalid();
}

function validateThreading(value: unknown): MailDraftThreadingContext | null {
  if (value === null) return null;
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["providerThreadId", "references", "rfcMessageId"]) ||
    !Array.isArray(value.references) ||
    value.references.length > MAIL_DRAFT_LIMITS.maxThreadReferences
  ) {
    throw responseInvalid();
  }
  const providerThreadId = optionalBoundedProviderValue(value.providerThreadId);
  const rfcMessageId = optionalRfcMessageId(value.rfcMessageId);
  const references = value.references.map((reference) => {
    if (typeof reference !== "string" || !RFC_MESSAGE_ID.test(reference)) {
      throw responseInvalid();
    }
    return reference;
  });
  if (
    Buffer.byteLength(references.join(" ")) >
    MAIL_DRAFT_LIMITS.maxThreadReferencesBytes
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    providerThreadId,
    rfcMessageId,
    references: Object.freeze(references),
  });
}

function validateAttachmentDto(value: unknown): MailDraftAttachmentDto {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["attachmentId", "bytes", "filename", "mimeType"]) ||
    typeof value.attachmentId !== "string" ||
    !SAFE_ATTACHMENT_ID.test(value.attachmentId) ||
    typeof value.filename !== "string" ||
    Buffer.byteLength(value.filename) > MAIL_DRAFT_LIMITS.maxFilenameBytes ||
    !NO_SINGLE_LINE_CONTROLS.test(value.filename) ||
    typeof value.mimeType !== "string" ||
    !MIME_TYPE.test(value.mimeType) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    attachmentId: value.attachmentId,
    filename: value.filename,
    mimeType: value.mimeType,
    bytes: value.bytes as number,
  });
}

function validateStoredAttachment(
  value: unknown,
  accountId: string,
  draftId: string,
): StoredMailDraftAttachment {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, [
      "accountId",
      "attachmentId",
      "blobName",
      "blobSha256",
      "bytes",
      "createdAt",
      "draftId",
      "filename",
      "mimeType",
    ]) ||
    value.accountId !== accountId ||
    value.draftId !== draftId ||
    typeof value.attachmentId !== "string" ||
    !SAFE_ATTACHMENT_ID.test(value.attachmentId) ||
    typeof value.filename !== "string" ||
    !NO_NUL.test(value.filename) ||
    Buffer.byteLength(value.filename) > MAIL_DRAFT_LIMITS.maxFilenameBytes ||
    typeof value.mimeType !== "string" ||
    value.mimeType !== value.mimeType.toLowerCase() ||
    !MIME_TYPE.test(value.mimeType) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0 ||
    (value.bytes as number) > MAIL_DRAFT_LIMITS.maxAccountBytes ||
    typeof value.blobSha256 !== "string" ||
    !SAFE_SHA256.test(value.blobSha256) ||
    typeof value.blobName !== "string" ||
    !SAFE_BLOB_NAME.test(value.blobName) ||
    value.blobName !== `sha256-${value.blobSha256}`
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    accountId,
    draftId,
    attachmentId: value.attachmentId,
    filename: value.filename,
    mimeType: value.mimeType,
    bytes: value.bytes as number,
    blobSha256: value.blobSha256,
    blobName: value.blobName,
    createdAt: validateTimestamp(value.createdAt, "response"),
  });
}

function validateState(value: unknown): StoredMailDraft["state"] {
  if (
    value !== "editing" &&
    value !== "submitting" &&
    value !== "failed" &&
    value !== "delivery_unknown" &&
    value !== "sent"
  ) {
    throw responseInvalid();
  }
  return value;
}

function assertStateShape(value: {
  readonly state: StoredMailDraft["state"];
  readonly sendOperationId: string | null;
  readonly sendIdempotencyKey: string | null;
  readonly sendErrorCode: MailSendErrorCode | null;
  readonly sentAt: number | null;
  readonly to: unknown;
  readonly cc: unknown;
  readonly bcc: unknown;
  readonly subject: unknown;
  readonly text: unknown;
  readonly attachments: readonly StoredMailDraftAttachment[];
}): void {
  const hasSendIdentity =
    value.sendOperationId !== null && value.sendIdempotencyKey !== null;
  const hasNoSendIdentity =
    value.sendOperationId === null && value.sendIdempotencyKey === null;
  if (
    (value.state === "editing" &&
      (!hasNoSendIdentity || value.sendErrorCode !== null || value.sentAt !== null)) ||
    (value.state === "submitting" &&
      (!hasSendIdentity || value.sendErrorCode !== null || value.sentAt !== null)) ||
    ((value.state === "failed" || value.state === "delivery_unknown") &&
      (!hasSendIdentity || value.sendErrorCode === null || value.sentAt !== null)) ||
    (value.state === "sent" &&
      (!hasSendIdentity ||
        value.sendErrorCode !== null ||
        value.sentAt === null ||
        value.to !== "" ||
        value.cc !== "" ||
        value.bcc !== "" ||
        value.subject !== "" ||
        value.text !== "" ||
        value.attachments.length !== 0))
  ) {
    throw responseInvalid();
  }
}

function assertPublicStateShape(value: {
  readonly state: StoredMailDraft["state"];
  readonly sendOperationId: string | null;
  readonly sendErrorCode: MailSendErrorCode | null;
  readonly sentAt: number | null;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly MailDraftAttachmentDto[];
}): void {
  const hasSendIdentity = value.sendOperationId !== null;
  if (
    (value.state === "editing" &&
      (hasSendIdentity || value.sendErrorCode !== null || value.sentAt !== null)) ||
    (value.state === "submitting" &&
      (!hasSendIdentity || value.sendErrorCode !== null || value.sentAt !== null)) ||
    ((value.state === "failed" || value.state === "delivery_unknown") &&
      (!hasSendIdentity || value.sendErrorCode === null || value.sentAt !== null)) ||
    (value.state === "sent" &&
      (!hasSendIdentity ||
        value.sendErrorCode !== null ||
        value.sentAt === null ||
        value.to !== "" ||
        value.cc !== "" ||
        value.bcc !== "" ||
        value.subject !== "" ||
        value.text !== "" ||
        value.attachments.length !== 0))
  ) {
    throw responseInvalid();
  }
}

function assertSummaryStateShape(value: {
  readonly state: StoredMailDraft["state"];
  readonly sendOperationId: string | null;
  readonly sendErrorCode: MailSendErrorCode | null;
  readonly sentAt: number | null;
}): void {
  const hasSendIdentity = value.sendOperationId !== null;
  if (
    (value.state === "editing" &&
      (hasSendIdentity || value.sendErrorCode !== null || value.sentAt !== null)) ||
    (value.state === "submitting" &&
      (!hasSendIdentity || value.sendErrorCode !== null || value.sentAt !== null)) ||
    ((value.state === "failed" || value.state === "delivery_unknown") &&
      (!hasSendIdentity || value.sendErrorCode === null || value.sentAt !== null)) ||
    (value.state === "sent" &&
      (!hasSendIdentity || value.sendErrorCode !== null || value.sentAt === null))
  ) {
    throw responseInvalid();
  }
}

function validateSendErrorCode(value: unknown): MailSendErrorCode | null {
  if (value === null) return null;
  if (typeof value !== "string" || !SEND_ERROR_CODES.has(value as MailSendErrorCode)) {
    throw responseInvalid();
  }
  return value as MailSendErrorCode;
}

function validateSingleLine(
  value: unknown,
  maxBytes: number,
  mode: "request" | "response",
): string {
  if (
    typeof value !== "string" ||
    hasUnpairedSurrogate(value) ||
    !NO_SINGLE_LINE_CONTROLS.test(value) ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw mode === "request" ? requestInvalid() : responseInvalid();
  }
  return value;
}

function validateBody(value: unknown, mode: "request" | "response"): string {
  if (
    typeof value !== "string" ||
    hasUnpairedSurrogate(value) ||
    !NO_NUL.test(value) ||
    Buffer.byteLength(value) > MAIL_DRAFT_LIMITS.maxBodyBytes
  ) {
    throw mode === "request" ? requestInvalid() : responseInvalid();
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validateRevision(
  value: unknown,
  mode: "request" | "response",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw mode === "request" ? requestInvalid() : responseInvalid();
  }
  return value as number;
}

function validateTimestamp(
  value: unknown,
  mode: "request" | "response",
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw mode === "request" ? requestInvalid() : responseInvalid();
  }
  return value as number;
}

function optionalTimestamp(
  value: unknown,
  mode: "request" | "response",
): number | null {
  return value === null ? null : validateTimestamp(value, mode);
}

function optionalPattern(
  value: unknown,
  pattern: RegExp,
  mode: "request" | "response",
): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw mode === "request" ? requestInvalid() : responseInvalid();
  }
  return value;
}

function optionalBoundedProviderValue(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !NO_PROVIDER_CONTROLS.test(value) ||
    Buffer.byteLength(value) > 512
  ) {
    throw responseInvalid();
  }
  return value;
}

function optionalRfcMessageId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !RFC_MESSAGE_ID.test(value)) {
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function requestInvalid(): MailDraftCodecError {
  return new MailDraftCodecError("mail_draft_request_invalid");
}

function responseInvalid(): MailDraftCodecError {
  return new MailDraftCodecError("mail_draft_response_invalid");
}
