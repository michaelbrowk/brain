import type { MailSendAttachment } from "./send-attachment-codec";

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
  /**
   * Tier-5 field: absent on the wire below contract tier 5 and decoded as
   * false. True when the thread waits for the owner's first decision about
   * its sender: the screen is on and its backfill has finished, the thread is
   * "people" mail whose first message arrived after the screen was switched
   * on, and neither the sender's address nor its domain is known or decided.
   * The service computes it at list time from `senders.sqlite3`; the message
   * cache never stores it.
   */
  readonly newSender: boolean;
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

/**
 * The body of `POST /api/mail/search/all`, the palette's door: one query
 * across every connected account, no cursor. `query` is the person's own
 * text, still to be checked by `normalizeMailSearchQueryText`, so the route
 * can refuse an empty or over-long one under its own code rather than the
 * generic shape refusal. `limit` bounds the merged answer and each account's
 * page alike, 1 to 20.
 */
export interface MailSearchAllInput {
  readonly query: string;
  readonly limit: number;
}

/**
 * One account's part in a merged search: the page it answered, with the
 * mailbox it was asked in and the same completeness signals a single-account
 * search carries, or the words for why it did not answer. The address is here
 * so a row's account can be named without a second request.
 */
export type MailSearchAllAccountStatus =
  | {
      readonly accountId: string;
      readonly emailAddress: string;
      readonly mailboxId: MailSystemMailbox;
      readonly availability: MailMailboxAvailability;
      readonly indexStatus: MailSearchIndexStatus;
      readonly resultsTruncated: boolean;
    }
  | {
      readonly accountId: string;
      readonly emailAddress: string;
      readonly error: string;
      readonly reason: string;
    };

/**
 * Every account's search merged newest first and cut to the asked limit.
 * `indexBuilding` and `truncated` fold the per-account signals so a reader
 * that shows one list can say "still indexing" or "more than shown" without
 * walking `accounts`; the per-account entries stay for a reader that wants
 * to name which one.
 */
export interface MailSearchAllResponse {
  readonly apiVersion: 1;
  readonly threads: readonly MailThreadListItem[];
  readonly accounts: readonly MailSearchAllAccountStatus[];
  /** True when any searched account reports its index still building. */
  readonly indexBuilding: boolean;
  /** True when the merge held more rows than `limit`, or any account cut its
   *  own page short. */
  readonly truncated: boolean;
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
export type MailSendOrigin = "app" | "mcp";
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
  /** Files from a page's own attachments. The composer sends none today. */
  readonly attachments: readonly MailSendAttachment[];
  /** Who wrote it. Only "mcp" earns the X-Brain-Agent header. */
  readonly origin: MailSendOrigin;
  /** Adds the recipient-visible line, and only for an agent's message. */
  readonly agentLine: boolean;
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
  /** The account the operation lives in, which is the only account a caller
   *  may write a Sent mark against for it. A caller naming another one is
   *  guessing, and the answer says so rather than letting the guess win. */
  readonly accountId: string;
  readonly status: MailSendStatus;
  /** The Sent copy's thread once a provider has one, so a caller can find it. */
  readonly threadId: string | null;
}

/**
 * The new-senders screen. `enabledAt` is the moment the switch was last
 * turned on, which is also the moment "known" was computed; it is null while
 * the switch is off. `backfillComplete` says whether every connected account
 * has finished teaching the screen who is already known; an account gates
 * nothing until its own backfill has finished, and the others go on gating.
 * `domainScopeRefused` names the domains a decision may not take whole: the
 * big mail providers and the owner's own domains. The UI offers "Everyone at
 * <domain>" for none of them.
 */
export interface MailSenderScreenState {
  readonly apiVersion: 1;
  readonly enabled: boolean;
  readonly enabledAt: number | null;
  readonly backfillComplete: boolean;
  readonly domainScopeRefused: readonly string[];
}

export type MailSenderDecisionScope = "address" | "domain";
export type MailSenderDecisionKind = "accept" | "block";

/** The address may carry a display name; the service normalizes it. */
export interface MailSenderDecisionInput {
  readonly address: string;
  readonly scope: MailSenderDecisionScope;
  readonly decision: MailSenderDecisionKind;
}

export interface MailSenderThreadRef {
  readonly accountId: string;
  readonly threadId: string;
}

/**
 * `archived` names the Inbox threads a block moved to the archive within the
 * request. `pending` is true when more were found than the request could move
 * (more than 200, or the deadline came first); the service's scheduler
 * archives the rest after the next sync.
 */
export interface MailSenderDecisionResult {
  readonly apiVersion: 1;
  readonly decisionId: string;
  readonly archived: readonly MailSenderThreadRef[];
  readonly pending: boolean;
}

/** An undo of a block names the threads it moved back to the Inbox. */
export interface MailSenderUndoResult {
  readonly apiVersion: 1;
  readonly restored: readonly MailSenderThreadRef[];
  readonly pending: boolean;
}

export interface MailBlockedSender {
  readonly decisionId: string;
  /** A normalized address, or a domain when `scope` is "domain". */
  readonly key: string;
  readonly scope: MailSenderDecisionScope;
  readonly decidedAt: number;
  /** Threads the service archived because of this block. */
  readonly archivedCount: number;
}

export interface MailBlockedSenders {
  readonly apiVersion: 1;
  readonly blocked: readonly MailBlockedSender[];
}
