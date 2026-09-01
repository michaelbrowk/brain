/**
 * cache_full is a projection of backoff for a full local message cache. It is
 * a persistent local stall, so the UI must not present it as a provider retry.
 */
export type MailSyncStatus =
  | "idle"
  | "syncing"
  | "backoff"
  | "cache_full"
  | "reauth_required";

export interface MailAddress {
  readonly name: string | null;
  readonly address: string;
}

/**
 * Sender category computed at ingest from list headers, Precedence,
 * Auto-Submitted, and the sender local-part. "newsletter" and "notification"
 * are both list mail; "people" is neither.
 */
export type MailThreadCategory = "people" | "notification" | "newsletter";

export interface MailThreadListItem {
  readonly accountId: string;
  readonly threadId: string;
  readonly subject: string | null;
  readonly participants: readonly MailAddress[];
  readonly snippet: string | null;
  readonly lastMessageAt: number | null;
  readonly messageCount: number;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly hasAttachments: boolean;
  /** True when any message carries list or automated-mail headers. */
  readonly listMessage: boolean;
  /** Best-effort sum of provider per-message size estimates, in bytes. */
  readonly sizeBytes: number;
  /**
   * Tier-4 field: absent on the wire below contract tier 4 and decoded as
   * "people". Rolls up per-message categories with newsletter > notification
   * > people; always consistent with listMessage (list mail is exactly the
   * non-"people" categories).
   */
  readonly category: MailThreadCategory;
}

/**
 * Rows cached before the view columns existed keep their defaults until the
 * next provider refresh rewrites them, so "lists" and "people" may misclassify
 * pre-upgrade threads and size-sorted lists place them last.
 */
export type MailThreadView = "unread" | "attachments" | "lists" | "people";

export type MailThreadSort = "date" | "unread" | "sender" | "size";

export interface MailThreadPage {
  readonly apiVersion: 1;
  readonly items: readonly MailThreadListItem[];
  readonly nextCursor: string | null;
  readonly sync: {
    readonly status: MailSyncStatus;
    readonly lastSuccessfulAt: number | null;
  };
}

export type MailSystemMailbox =
  | "inbox"
  | "all"
  | "sent"
  | "starred"
  | "spam"
  | "trash";

export type MailMailboxUnavailableReason =
  | "global_syncing"
  | "mailbox_uninitialized"
  | "mailbox_syncing"
  | "mailbox_backoff"
  | "mailbox_cache_capacity"
  | "mailbox_reauth_required"
  | "history_mismatch";

export type MailMailboxAvailability =
  | {
      readonly status: "available";
      readonly lastSuccessfulAt: number;
      readonly windowTruncated: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: MailMailboxUnavailableReason;
      readonly lastSuccessfulAt: number | null;
      readonly windowTruncated: null;
    };

/**
 * A separate additive contract keeps the existing Inbox endpoint rollback-safe.
 * Internal generation and History cursors never cross the service boundary.
 */
export interface MailMailboxThreadPage {
  readonly apiVersion: 1;
  readonly mailboxId: MailSystemMailbox;
  readonly items: readonly MailThreadListItem[];
  readonly nextCursor: string | null;
  readonly availability: MailMailboxAvailability;
}

export type MailSearchIndexStatus = "building" | "ready";

/**
 * Local search is intentionally limited to cached thread headers and previews.
 * Message bodies stay outside this first slice and are never fetched to answer
 * a search request.
 */
export interface MailSearchThreadPage {
  readonly apiVersion: 1;
  readonly mailboxId: MailSystemMailbox;
  readonly scope: "headers_and_previews";
  readonly items: readonly MailThreadListItem[];
  readonly nextCursor: string | null;
  readonly availability: MailMailboxAvailability;
  readonly indexStatus: MailSearchIndexStatus;
  readonly resultsTruncated: boolean;
}

export interface MailSearchInput {
  readonly accountId: string;
  readonly mailboxId: MailSystemMailbox;
  /** Normalized plain terms. The service compiles these into safe FTS syntax. */
  readonly query: string;
  readonly cursor: string | null;
  readonly limit: number;
}

export interface MailMessageDto {
  readonly accountId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly from: MailAddress | null;
  readonly replyTo: readonly MailAddress[];
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly subject: string | null;
  readonly sentAt: number | null;
  readonly unread: boolean;
  readonly inInbox: boolean;
  readonly snippet: string | null;
  readonly textBody: string | null;
  /** HTML stays inert data. The UI must not render it before sanitization. */
  readonly htmlBody: string | null;
  readonly hasAttachments: boolean;
}

export interface MailThreadDetail {
  readonly apiVersion: 1;
  readonly thread: MailThreadListItem;
  readonly messages: readonly MailMessageDto[];
}

export interface MailSyncResult {
  readonly apiVersion: 1;
  readonly status: MailSyncStatus;
  readonly changedCount: number;
  readonly hasMore: boolean;
}

export interface MailThreadMutationResult {
  readonly apiVersion: 1;
  readonly thread: MailThreadListItem;
}

export type MailThreadMutationInput =
  | { readonly accountId: string; readonly read: boolean }
  | { readonly accountId: string; readonly archive: boolean }
  | { readonly accountId: string; readonly trash: true }
  | { readonly accountId: string; readonly restore: true }
  | { readonly accountId: string; readonly spam: boolean }
  | { readonly accountId: string; readonly starred: boolean };

export type MailSendMode = "compose" | "reply";
export type MailSendStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "delivery_unknown";

export interface MailSendInput {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly mode: MailSendMode;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly replyToMessageId: string | null;
}

export interface MailSendResult {
  readonly apiVersion: 1;
  readonly operationId: string;
  readonly created: boolean;
  readonly status: MailSendStatus;
}

export interface MailSendOperation {
  readonly apiVersion: 1;
  readonly operationId: string;
  readonly status: MailSendStatus;
}
