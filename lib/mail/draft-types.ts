import type { MailSendErrorCode } from "./service/outbound";
import type { MailSendStatus } from "./message-types";

export const MAIL_DRAFT_API_VERSION = 1 as const;

export type MailDraftErrorCode =
  | "mail_draft_request_invalid"
  | "mail_draft_account_not_found"
  | "mail_draft_account_reauth_required"
  | "mail_draft_capability_unavailable"
  | "mail_draft_reply_target_not_found"
  | "mail_draft_not_found"
  | "mail_draft_revision_conflict"
  | "mail_draft_idempotency_conflict"
  | "mail_draft_quota_exceeded"
  | "mail_draft_state_invalid"
  | "mail_draft_service_unavailable";

export class MailDraftError extends Error {
  constructor(readonly code: MailDraftErrorCode) {
    super(code);
    this.name = "MailDraftError";
  }
}

export type MailDraftIntent =
  | { readonly kind: "compose" }
  | {
      readonly kind: "reply" | "reply_all" | "forward";
      readonly sourceMessageId: string;
    };

export type MailDraftState =
  | "editing"
  | "submitting"
  | "failed"
  | "delivery_unknown"
  | "sent";

/**
 * A future send handoff can snapshot provider threading data here. The first
 * draft slice deliberately keeps it null and never trusts browser headers.
 */
export interface MailDraftThreadingContext {
  readonly providerThreadId: string | null;
  readonly rfcMessageId: string | null;
  readonly references: readonly string[];
}

export interface MailDraftAttachmentDto {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface StoredMailDraftAttachment extends MailDraftAttachmentDto {
  readonly accountId: string;
  readonly draftId: string;
  readonly blobSha256: string;
  readonly blobName: string;
  readonly createdAt: number;
}

export interface MailDraftDto {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
  readonly draftId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly state: MailDraftState;
  readonly intent: MailDraftIntent;
  /** Raw, possibly incomplete address text. Syntax is checked only at send. */
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
  readonly attachments: readonly MailDraftAttachmentDto[];
  readonly sendOperationId: string | null;
  readonly sendErrorCode: MailSendErrorCode | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sentAt: number | null;
}

/**
 * Bounded list projection. Large recipient fields, body text, and attachment
 * metadata are fetched only through the single-draft endpoint.
 */
export interface MailDraftSummaryDto {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
  readonly draftId: string;
  readonly accountId: string;
  readonly revision: number;
  readonly state: MailDraftState;
  readonly intent: MailDraftIntent;
  readonly subject: string;
  readonly sendOperationId: string | null;
  readonly sendErrorCode: MailSendErrorCode | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly sentAt: number | null;
}

export interface StoredMailDraft extends MailDraftDto {
  readonly threading: MailDraftThreadingContext | null;
  readonly sendIdempotencyKey: string | null;
  readonly attachments: readonly StoredMailDraftAttachment[];
}

export interface MailDraftCreateInput {
  readonly draftId: string;
  readonly accountId: string;
  readonly intent: MailDraftIntent;
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailDraftPatch {
  readonly to?: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly subject?: string;
  readonly text?: string;
}

interface MailDraftMutationBase {
  readonly accountId: string;
  readonly draftId: string;
  readonly mutationId: string;
  readonly expectedRevision: number;
}

export type MailDraftMutationInput =
  | (MailDraftMutationBase & {
      readonly kind: "patch";
      readonly patch: MailDraftPatch;
    })
  | (MailDraftMutationBase & {
      readonly kind: "send";
      readonly sendIdempotencyKey: string;
      readonly sendOperationId: string;
    });

export interface StoredMailDraftMutation {
  readonly accountId: string;
  readonly draftId: string;
  readonly mutationId: string;
  readonly kind: MailDraftMutationInput["kind"];
  readonly fingerprint: string;
  readonly expectedRevision: number;
  readonly appliedRevision: number;
  readonly operationId: string | null;
  readonly createdAt: number;
}

export interface MailDraftMutationResult {
  readonly replayed: boolean;
  readonly appliedRevision: number;
  readonly operationId: string | null;
}

export interface MailDraftCreateResponse {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
  readonly created: boolean;
  readonly draft: MailDraftDto;
}

export interface MailDraftListResponse {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
  readonly drafts: readonly MailDraftSummaryDto[];
}

export interface MailDraftMutationResponse extends MailDraftMutationResult {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
}

export interface MailDraftDeleteResponse {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
  readonly deleted: true;
  readonly replayed: boolean;
}

export interface MailDraftSendResponse {
  readonly apiVersion: typeof MAIL_DRAFT_API_VERSION;
  readonly replayed: boolean;
  readonly appliedRevision: number;
  readonly operationId: string;
  readonly created: boolean;
  readonly status: MailSendStatus;
}

export interface MailDraftDeleteInput {
  readonly accountId: string;
  readonly draftId: string;
  readonly mutationId: string;
  readonly expectedRevision: number;
}
