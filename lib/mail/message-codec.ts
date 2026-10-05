import type {
  MailAddress,
  MailBlockedSenders,
  MailMailboxAvailability,
  MailMailboxThreadPage,
  MailMessageDto,
  MailSendInput,
  MailSendOperation,
  MailSendResult,
  MailSendStatus,
  MailSearchAllInput,
  MailSearchInput,
  MailSearchThreadPage,
  MailSenderDecisionInput,
  MailSenderDecisionResult,
  MailSenderScreenState,
  MailSenderThreadRef,
  MailSenderUndoResult,
  MailSyncResult,
  MailSyncStatus,
  MailSystemMailbox,
  MailThreadCategory,
  MailThreadDetail,
  MailThreadBatchInput,
  MailThreadBatchItem,
  MailThreadBatchResult,
  MailThreadListItem,
  MailThreadMutationInput,
  MailThreadMutationResult,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "./message-types";
import { MAIL_THREAD_BATCH_MAX } from "./message-types";
import { normalizeMailSearchQueryText } from "./search-query";
import { validateMailSendAttachments } from "./send-attachment-codec";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_RECIPIENTS = 100;
const MAX_MESSAGES_PER_THREAD = 200;
const MAX_LIST_ITEMS = 100;
/** The palette shows twenty rows at most, and a merge across every account
 *  asks each for that many, so a wider page would only be thrown away. */
const MAX_SEARCH_ALL_LIMIT = 20;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const SYSTEM_MAILBOXES = new Set<MailSystemMailbox>([
  "inbox",
  "all",
  "sent",
  "starred",
  "spam",
  "trash",
]);
const THREAD_VIEWS = new Set<MailThreadView>([
  "unread",
  "attachments",
  "lists",
  "people",
]);
const THREAD_SORTS = new Set<MailThreadSort>([
  "date",
  "unread",
  "sender",
  "size",
]);

export class MailMessageCodecError extends Error {
  constructor(readonly code: "mail_request_invalid" | "mail_response_invalid") {
    super(code);
    this.name = "MailMessageCodecError";
  }
}

export function validateMailAccountId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ACCOUNT_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailResourceId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_RESOURCE_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailSystemMailbox(value: unknown): MailSystemMailbox {
  if (typeof value !== "string" || !SYSTEM_MAILBOXES.has(value as MailSystemMailbox)) {
    throw requestInvalid();
  }
  return value as MailSystemMailbox;
}

export function validateMailOperationId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_OPERATION_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailListOptions(value: {
  readonly cursor?: unknown;
  readonly limit?: unknown;
}): { readonly cursor: string | null; readonly limit: number } {
  let cursor: string | null = null;
  if (value.cursor !== undefined && value.cursor !== null && value.cursor !== "") {
    if (
      typeof value.cursor !== "string" ||
      !/^[A-Za-z0-9_-]{1,2048}$/.test(value.cursor)
    ) {
      throw requestInvalid();
    }
    cursor = value.cursor;
  }
  const limit = value.limit ?? 50;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) {
    throw requestInvalid();
  }
  return Object.freeze({ cursor, limit: limit as number });
}

/**
 * Deliberately separate from validateMailListOptions, which search shares:
 * search continues to reject view and sort, so its surface fails closed.
 * Absent values fall back to the defaults; anything else must be an exact
 * enum member.
 */
export function validateMailThreadListFilter(value: {
  readonly view?: unknown;
  readonly sort?: unknown;
}): { readonly view: MailThreadView | null; readonly sort: MailThreadSort } {
  let view: MailThreadView | null = null;
  if (value.view !== undefined && value.view !== null) {
    if (
      typeof value.view !== "string" ||
      !THREAD_VIEWS.has(value.view as MailThreadView)
    ) {
      throw requestInvalid();
    }
    view = value.view as MailThreadView;
  }
  let sort: MailThreadSort = "date";
  if (value.sort !== undefined && value.sort !== null) {
    if (
      typeof value.sort !== "string" ||
      !THREAD_SORTS.has(value.sort as MailThreadSort)
    ) {
      throw requestInvalid();
    }
    sort = value.sort as MailThreadSort;
  }
  return Object.freeze({ view, sort });
}

export function validateMailSearchInput(value: unknown): MailSearchInput {
  if (!isPlainRecord(value)) throw requestInvalid();
  const allowed = new Set(["accountId", "cursor", "limit", "mailboxId", "query"]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, "accountId") ||
    !Object.prototype.hasOwnProperty.call(value, "mailboxId") ||
    !Object.prototype.hasOwnProperty.call(value, "query")
  ) {
    throw requestInvalid();
  }
  const options = validateMailListOptions({
    cursor: value.cursor,
    limit: value.limit,
  });
  return Object.freeze({
    accountId: validateMailAccountId(value.accountId),
    mailboxId: validateMailSystemMailbox(value.mailboxId),
    query: normalizeMailSearchQuery(value.query),
    cursor: options.cursor,
    limit: options.limit,
  });
}

/**
 * The every-account search takes two keys and nothing else: no account, no
 * mailbox, no cursor, because the route chooses the mailbox per account and
 * never pages. The query is only checked to be a string here. Its terms are
 * checked by the route with `normalizeMailSearchQueryText`, so an empty or
 * over-long query is refused as `invalid_query`, which a palette can show as
 * "nothing to search for", rather than as the shape refusal a malformed body
 * earns.
 */
export function validateMailSearchAllInput(value: unknown): MailSearchAllInput {
  if (!isPlainRecord(value)) throw requestInvalid();
  const allowed = new Set(["limit", "query"]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, "query") ||
    typeof value.query !== "string"
  ) {
    throw requestInvalid();
  }
  const limit = value.limit ?? MAX_SEARCH_ALL_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > MAX_SEARCH_ALL_LIMIT
  ) {
    throw requestInvalid();
  }
  return Object.freeze({ query: value.query, limit: limit as number });
}

/**
 * Reduce untrusted text to Unicode letter/number terms before FTS compilation.
 * Quoting still happens inside the cache, so this normalizer is not itself a
 * SQL boundary.
 */
export function normalizeMailSearchQuery(value: unknown): string {
  const normalized = normalizeMailSearchQueryText(value);
  if (normalized === null) throw requestInvalid();
  return normalized;
}

export function validateMailSyncInput(value: unknown): {
  readonly accountId: string;
  readonly maxItems: number;
} {
  if (!isRecordWithExactFields(value, ["accountId", "maxItems"])) {
    throw requestInvalid();
  }
  if (
    !Number.isSafeInteger(value.maxItems) ||
    (value.maxItems as number) < 1 ||
    (value.maxItems as number) > 20
  ) {
    throw requestInvalid();
  }
  return Object.freeze({
    accountId: validateMailAccountId(value.accountId),
    maxItems: value.maxItems as number,
  });
}

/** The whole body of `PATCH /v1/sync`: one boolean and nothing beside it.
 *  Brain's module switch is the only caller, and a field it did not mean to
 *  send is a disagreement about the contract rather than a value to ignore. */
export function validateMailSyncEnabledInput(value: unknown): {
  readonly enabled: boolean;
} {
  if (!isRecordWithExactFields(value, ["enabled"])) throw requestInvalid();
  if (typeof value.enabled !== "boolean") throw requestInvalid();
  return Object.freeze({ enabled: value.enabled });
}

export function validateMailThreadMutationInput(
  value: unknown,
): MailThreadMutationInput {
  if (!isPlainRecord(value)) throw requestInvalid();
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "accountId") throw requestInvalid();
  const accountId = validateMailAccountId(value.accountId);
  switch (keys[1]) {
    case "read":
      if (typeof value.read !== "boolean") throw requestInvalid();
      return Object.freeze({ accountId, read: value.read });
    case "archive":
      if (typeof value.archive !== "boolean") throw requestInvalid();
      return Object.freeze({ accountId, archive: value.archive });
    case "trash":
      if (value.trash !== true) throw requestInvalid();
      return Object.freeze({ accountId, trash: true });
    case "restore":
      if (value.restore !== true) throw requestInvalid();
      return Object.freeze({ accountId, restore: true });
    case "spam":
      if (typeof value.spam !== "boolean") throw requestInvalid();
      return Object.freeze({ accountId, spam: value.spam });
    case "starred":
      if (typeof value.starred !== "boolean") throw requestInvalid();
      return Object.freeze({ accountId, starred: value.starred });
    default:
      throw requestInvalid();
  }
}

/**
 * `{ accountId, threadIds, archive: true, read?: true }` and nothing else:
 * one to fifty distinct thread ids, archived, and marked read when `read` is
 * there. Any other mutation, a `read: false`, or an `archive: false` is not a
 * batch this contract has.
 */
export function validateMailThreadBatchInput(value: unknown): MailThreadBatchInput {
  const read = isPlainRecord(value) && Object.hasOwn(value, "read");
  if (
    !isRecordWithExactFields(
      value,
      read ? ["accountId", "archive", "read", "threadIds"] : ["accountId", "archive", "threadIds"],
    ) ||
    value.archive !== true ||
    (read && value.read !== true) ||
    !Array.isArray(value.threadIds) ||
    value.threadIds.length < 1 ||
    value.threadIds.length > MAIL_THREAD_BATCH_MAX
  ) {
    throw requestInvalid();
  }
  const accountId = validateMailAccountId(value.accountId);
  const threadIds = value.threadIds.map(validateMailResourceId);
  if (new Set(threadIds).size !== threadIds.length) throw requestInvalid();
  return Object.freeze({
    accountId,
    threadIds: Object.freeze(threadIds),
    archive: true as const,
    ...(read ? { read: true as const } : {}),
  });
}

/**
 * A batch answer for exactly the threads that were sent, in the order they
 * were sent, each on the account that was named.
 */
export function validateMailThreadBatchResult(
  value: unknown,
  expected: Pick<MailThreadBatchInput, "accountId" | "threadIds">,
): MailThreadBatchResult {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "results"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.results) ||
    value.results.length !== expected.threadIds.length
  ) {
    throw responseInvalid();
  }
  const results = value.results.map((entry, index): MailThreadBatchItem => {
    const threadId = expected.threadIds[index];
    if (!isPlainRecord(entry) || entry.threadId !== threadId || threadId === undefined) {
      throw responseInvalid();
    }
    if (entry.status === "done") {
      if (
        !isRecordWithExactFields(entry, ["markedRead", "status", "thread", "threadId"]) ||
        typeof entry.markedRead !== "boolean"
      ) {
        throw responseInvalid();
      }
      const thread = validateThreadListItem(entry.thread);
      if (thread.accountId !== expected.accountId || thread.threadId !== threadId) {
        throw responseInvalid();
      }
      return Object.freeze({ threadId, status: "done", thread, markedRead: entry.markedRead });
    }
    if (entry.status === "stale" && isRecordWithExactFields(entry, ["status", "threadId"])) {
      return Object.freeze({ threadId, status: "stale" });
    }
    if (
      entry.status === "failed" &&
      isRecordWithExactFields(entry, ["errorCode", "status", "threadId"]) &&
      typeof entry.errorCode === "string" &&
      SAFE_ERROR_CODE.test(entry.errorCode)
    ) {
      return Object.freeze({ threadId, status: "failed", errorCode: entry.errorCode });
    }
    throw responseInvalid();
  });
  return Object.freeze({ apiVersion: 1, results: Object.freeze(results) });
}

export function validateMailSendInput(value: unknown): MailSendInput {
  if (
    !isRecordWithExactFields(value, [
      "accountId",
      "agentLine",
      "attachments",
      "bcc",
      "cc",
      "idempotencyKey",
      "mode",
      "origin",
      "replyToMessageId",
      "subject",
      "text",
      "to",
    ])
  ) {
    throw requestInvalid();
  }
  if (
    typeof value.idempotencyKey !== "string" ||
    !SAFE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    (value.mode !== "compose" && value.mode !== "reply") ||
    (value.origin !== "app" && value.origin !== "mcp") ||
    typeof value.agentLine !== "boolean"
  ) {
    throw requestInvalid();
  }
  let attachments;
  try {
    attachments = validateMailSendAttachments(value.attachments);
  } catch {
    throw requestInvalid();
  }
  const to = validateRecipients(value.to);
  const cc = validateRecipients(value.cc);
  const bcc = validateRecipients(value.bcc);
  if (to.length + cc.length + bcc.length < 1 || to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw requestInvalid();
  }
  const subject = boundedString(value.subject, 998, true, "request");
  const text = boundedString(value.text, MAX_TEXT_BYTES, true, "request");
  const replyToMessageId =
    value.replyToMessageId === null
      ? null
      : validateMailResourceId(value.replyToMessageId);
  if (
    (value.mode === "compose" && replyToMessageId !== null) ||
    (value.mode === "reply" && replyToMessageId === null)
  ) {
    throw requestInvalid();
  }
  return Object.freeze({
    accountId: validateMailAccountId(value.accountId),
    idempotencyKey: value.idempotencyKey,
    mode: value.mode,
    to: Object.freeze(to),
    cc: Object.freeze(cc),
    bcc: Object.freeze(bcc),
    subject,
    text,
    replyToMessageId,
    attachments,
    origin: value.origin,
    agentLine: value.agentLine,
  });
}

export function validateMailThreadPage(value: unknown): MailThreadPage {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "items", "nextCursor", "sync"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_LIST_ITEMS ||
    !isRecordWithExactFields(value.sync, ["lastSuccessfulAt", "status"])
  ) {
    throw responseInvalid();
  }
  const items = value.items.map(validateThreadListItem);
  const identities = new Set(items.map((item) => `${item.accountId}\u0000${item.threadId}`));
  if (identities.size !== items.length) throw responseInvalid();
  const nextCursor = nullableBoundedString(value.nextCursor, 2048, false, "response");
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    items: Object.freeze(items),
    nextCursor,
    sync: Object.freeze({
      status: validateSyncStatus(value.sync.status),
      lastSuccessfulAt: nullableTimestamp(value.sync.lastSuccessfulAt),
    }),
  });
}

export function validateMailMailboxThreadPage(
  value: unknown,
): MailMailboxThreadPage {
  if (
    !isRecordWithExactFields(value, [
      "apiVersion",
      "availability",
      "items",
      "mailboxId",
      "nextCursor",
    ]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_LIST_ITEMS
  ) {
    throw responseInvalid();
  }
  const mailboxId = validateResponseMailbox(value.mailboxId);
  const items = value.items.map(validateThreadListItem);
  const identities = new Set(
    items.map((item) => `${item.accountId}\u0000${item.threadId}`),
  );
  if (identities.size !== items.length) throw responseInvalid();
  const nextCursor = nullableBoundedString(
    value.nextCursor,
    2048,
    false,
    "response",
  );
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
    throw responseInvalid();
  }
  const availability = validateMailboxAvailability(value.availability);
  if (availability.status === "unavailable" && (items.length > 0 || nextCursor !== null)) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    mailboxId,
    items: Object.freeze(items),
    nextCursor,
    availability,
  });
}

export function validateMailSearchThreadPage(
  value: unknown,
): MailSearchThreadPage {
  if (
    !isRecordWithExactFields(value, [
      "apiVersion",
      "availability",
      "indexStatus",
      "items",
      "mailboxId",
      "nextCursor",
      "resultsTruncated",
      "scope",
    ]) ||
    value.apiVersion !== 1 ||
    value.scope !== "headers_and_previews" ||
    (value.indexStatus !== "building" && value.indexStatus !== "ready") ||
    typeof value.resultsTruncated !== "boolean" ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_LIST_ITEMS
  ) {
    throw responseInvalid();
  }
  const mailboxId = validateResponseMailbox(value.mailboxId);
  const items = value.items.map(validateThreadListItem);
  const identities = new Set(
    items.map((item) => `${item.accountId}\u0000${item.threadId}`),
  );
  if (identities.size !== items.length) throw responseInvalid();
  const nextCursor = nullableBoundedString(
    value.nextCursor,
    2048,
    false,
    "response",
  );
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
    throw responseInvalid();
  }
  const availability = validateMailboxAvailability(value.availability);
  if (
    (availability.status === "unavailable" || value.indexStatus === "building") &&
    nextCursor !== null
  ) {
    throw responseInvalid();
  }
  if (
    availability.status === "unavailable" &&
    (items.length > 0 || value.resultsTruncated !== true)
  ) {
    throw responseInvalid();
  }
  if (value.indexStatus === "building" && value.resultsTruncated !== true) {
    throw responseInvalid();
  }
  if (
    availability.status === "available" &&
    availability.windowTruncated &&
    value.resultsTruncated !== true
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    mailboxId,
    scope: "headers_and_previews",
    items: Object.freeze(items),
    nextCursor,
    availability,
    indexStatus: value.indexStatus,
    resultsTruncated: value.resultsTruncated,
  });
}

export function validateMailThreadDetail(value: unknown): MailThreadDetail {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "messages", "thread"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.messages) ||
    value.messages.length > MAX_MESSAGES_PER_THREAD
  ) {
    throw responseInvalid();
  }
  const thread = validateThreadListItem(value.thread);
  const messages = value.messages.map(validateMessage);
  if (
    messages.some(
      (message) =>
        message.accountId !== thread.accountId || message.threadId !== thread.threadId,
    ) ||
    new Set(messages.map((message) => message.messageId)).size !== messages.length
  ) {
    throw responseInvalid();
  }
  return Object.freeze({ apiVersion: 1, thread, messages: Object.freeze(messages) });
}

export function validateMailSyncResult(value: unknown): MailSyncResult {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "changedCount", "hasMore", "status"]) ||
    value.apiVersion !== 1 ||
    !Number.isSafeInteger(value.changedCount) ||
    (value.changedCount as number) < 0 ||
    (value.changedCount as number) > 20 ||
    typeof value.hasMore !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    status: validateSyncStatus(value.status),
    changedCount: value.changedCount as number,
    hasMore: value.hasMore,
  });
}

const SAFE_SENDER_DECISION_ID = /^decision-a[0-9a-f]{32}$/;
const MAX_BLOCKED_SENDERS = 1_000;
const MAX_SENDER_THREAD_REFS = 200;
/** The provider list and the owner's own domains, with room to spare. */
const MAX_REFUSED_SCOPE_DOMAINS = 500;

/** The body of `PUT /v1/senders/state`. */
export function validateMailSenderScreenInput(value: unknown): {
  readonly enabled: boolean;
} {
  if (!isRecordWithExactFields(value, ["enabled"])) throw requestInvalid();
  if (typeof value.enabled !== "boolean") throw requestInvalid();
  return Object.freeze({ enabled: value.enabled });
}

export function validateMailSenderScreenState(value: unknown): MailSenderScreenState {
  if (
    !isRecordWithExactFields(value, [
      "apiVersion",
      "backfillComplete",
      "domainScopeRefused",
      "enabled",
      "enabledAt",
    ]) ||
    value.apiVersion !== 1 ||
    typeof value.enabled !== "boolean" ||
    typeof value.backfillComplete !== "boolean" ||
    (value.enabled !== (value.enabledAt !== null)) ||
    (!value.enabled && value.backfillComplete) ||
    !Array.isArray(value.domainScopeRefused) ||
    value.domainScopeRefused.length > MAX_REFUSED_SCOPE_DOMAINS
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    enabled: value.enabled,
    enabledAt: nullableTimestamp(value.enabledAt),
    backfillComplete: value.backfillComplete,
    domainScopeRefused: Object.freeze(
      value.domainScopeRefused.map((domain: unknown) =>
        boundedString(domain, 253, false, "response"),
      ),
    ),
  });
}

/**
 * The body of `POST /v1/senders/decisions`. The address is checked for shape
 * only; which address it names is the service's to decide, through the one
 * normalizer it keeps.
 */
export function validateMailSenderDecisionInput(value: unknown): MailSenderDecisionInput {
  if (
    !isRecordWithExactFields(value, ["address", "decision", "scope"]) ||
    (value.scope !== "address" && value.scope !== "domain") ||
    (value.decision !== "accept" && value.decision !== "block")
  ) {
    throw requestInvalid();
  }
  return Object.freeze({
    address: boundedString(value.address, 998, false, "request"),
    scope: value.scope,
    decision: value.decision,
  });
}

export function validateMailSenderDecisionId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_SENDER_DECISION_ID.test(value)) {
    throw requestInvalid();
  }
  return value;
}

export function validateMailSenderDecisionResult(
  value: unknown,
): MailSenderDecisionResult {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "archived", "decisionId", "pending"]) ||
    value.apiVersion !== 1 ||
    typeof value.decisionId !== "string" ||
    !SAFE_SENDER_DECISION_ID.test(value.decisionId) ||
    typeof value.pending !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    decisionId: value.decisionId,
    archived: validateSenderThreadRefs(value.archived),
    pending: value.pending,
  });
}

export function validateMailSenderUndoResult(value: unknown): MailSenderUndoResult {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "pending", "restored"]) ||
    value.apiVersion !== 1 ||
    typeof value.pending !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    restored: validateSenderThreadRefs(value.restored),
    pending: value.pending,
  });
}

export function validateMailBlockedSenders(value: unknown): MailBlockedSenders {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "blocked"]) ||
    value.apiVersion !== 1 ||
    !Array.isArray(value.blocked) ||
    value.blocked.length > MAX_BLOCKED_SENDERS
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    blocked: Object.freeze(
      value.blocked.map((entry: unknown) => {
        if (
          !isRecordWithExactFields(entry, [
            "archivedCount",
            "decidedAt",
            "decisionId",
            "key",
            "scope",
          ]) ||
          typeof entry.decisionId !== "string" ||
          !SAFE_SENDER_DECISION_ID.test(entry.decisionId) ||
          (entry.scope !== "address" && entry.scope !== "domain") ||
          !Number.isSafeInteger(entry.archivedCount) ||
          (entry.archivedCount as number) < 0
        ) {
          throw responseInvalid();
        }
        return Object.freeze({
          decisionId: entry.decisionId,
          key: boundedString(entry.key, 254, false, "response"),
          scope: entry.scope,
          decidedAt: requiredTimestamp(entry.decidedAt),
          archivedCount: entry.archivedCount as number,
        });
      }),
    ),
  });
}

function validateSenderThreadRefs(value: unknown): readonly MailSenderThreadRef[] {
  if (!Array.isArray(value) || value.length > MAX_SENDER_THREAD_REFS) {
    throw responseInvalid();
  }
  return Object.freeze(
    value.map((entry: unknown) => {
      if (
        !isRecordWithExactFields(entry, ["accountId", "threadId"]) ||
        typeof entry.accountId !== "string" ||
        !SAFE_ACCOUNT_ID.test(entry.accountId) ||
        typeof entry.threadId !== "string" ||
        !SAFE_RESOURCE_ID.test(entry.threadId)
      ) {
        throw responseInvalid();
      }
      return Object.freeze({ accountId: entry.accountId, threadId: entry.threadId });
    }),
  );
}

/** What `PATCH /v1/sync` answers: the state that stands after the call, so a
 *  caller never has to ask a second time. */
export function validateMailSyncPauseResult(value: unknown): {
  readonly apiVersion: 1;
  readonly paused: boolean;
} {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "paused"]) ||
    value.apiVersion !== 1 ||
    typeof value.paused !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({ apiVersion: 1 as const, paused: value.paused });
}

export function validateMailThreadMutationResult(
  value: unknown,
): MailThreadMutationResult {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "thread"]) ||
    value.apiVersion !== 1
  ) {
    throw responseInvalid();
  }
  return Object.freeze({ apiVersion: 1, thread: validateThreadListItem(value.thread) });
}

export function validateMailSendResult(value: unknown): MailSendResult {
  if (
    !isRecordWithExactFields(value, ["apiVersion", "created", "operationId", "status"]) ||
    value.apiVersion !== 1 ||
    typeof value.created !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    operationId: validateResponseOperationId(value.operationId),
    created: value.created,
    status: validateSendStatus(value.status),
  });
}

export function validateMailSendOperation(value: unknown): MailSendOperation {
  if (
    !isRecordWithExactFields(value, [
      "accountId",
      "apiVersion",
      "operationId",
      "status",
      "threadId",
    ]) ||
    value.apiVersion !== 1 ||
    !SAFE_ACCOUNT_ID.test(typeof value.accountId === "string" ? value.accountId : "") ||
    (value.threadId !== null &&
      (typeof value.threadId !== "string" || !SAFE_RESOURCE_ID.test(value.threadId)))
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    apiVersion: 1,
    operationId: validateResponseOperationId(value.operationId),
    accountId: value.accountId as string,
    status: validateSendStatus(value.status),
    threadId: value.threadId,
  });
}

function validateThreadListItem(value: unknown): MailThreadListItem {
  const baseFields = [
    "accountId",
    "hasAttachments",
    "lastMessageAt",
    "messageCount",
    "participants",
    "snippet",
    "subject",
    "threadId",
    "unread",
  ];
  const hasStarred =
    isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, "starred");
  // The two view fields ship together: a response carrying exactly one of
  // them is malformed, unlike starred's independently optional flag.
  const hasListMessage =
    isPlainRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "listMessage");
  const hasSizeBytes =
    isPlainRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "sizeBytes");
  if (hasListMessage !== hasSizeBytes) throw responseInvalid();
  // category travels alone like starred, unlike the paired view fields.
  const hasCategory =
    isPlainRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "category");
  // newSender is tier 5 and travels alone too. A service older than the
  // screen never sends it, and its threads read as not waiting on anyone.
  const hasNewSender =
    isPlainRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "newSender");
  // The sender a waiting thread names comes only with a thread that waits.
  const hasNewSenderFrom =
    isPlainRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "newSenderFrom");
  // The blocked mark is a mark: present and true, or absent, and never on a
  // thread that waits for a decision about the same sender.
  const hasSenderBlocked =
    isPlainRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "senderBlocked");
  if (
    !isRecordWithExactFields(value, [
      ...baseFields,
      ...(hasStarred ? ["starred"] : []),
      ...(hasListMessage ? ["listMessage", "sizeBytes"] : []),
      ...(hasCategory ? ["category"] : []),
      ...(hasNewSender ? ["newSender"] : []),
      ...(hasNewSenderFrom ? ["newSenderFrom"] : []),
      ...(hasSenderBlocked ? ["senderBlocked"] : []),
    ]) ||
    (hasNewSenderFrom && value.newSender !== true) ||
    (hasSenderBlocked && (value.senderBlocked !== true || value.newSender === true)) ||
    !SAFE_ACCOUNT_ID.test(typeof value.accountId === "string" ? value.accountId : "") ||
    !SAFE_RESOURCE_ID.test(typeof value.threadId === "string" ? value.threadId : "") ||
    !Array.isArray(value.participants) ||
    value.participants.length > MAX_RECIPIENTS ||
    !Number.isSafeInteger(value.messageCount) ||
    (value.messageCount as number) < 1 ||
    (value.messageCount as number) > MAX_MESSAGES_PER_THREAD ||
    typeof value.unread !== "boolean" ||
    (hasStarred && typeof value.starred !== "boolean") ||
    (hasListMessage &&
      (typeof value.listMessage !== "boolean" ||
        !Number.isSafeInteger(value.sizeBytes) ||
        (value.sizeBytes as number) < 0)) ||
    (hasCategory &&
      value.category !== "people" &&
      value.category !== "notification" &&
      value.category !== "newsletter") ||
    (hasNewSender && typeof value.newSender !== "boolean") ||
    typeof value.hasAttachments !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    accountId: value.accountId as string,
    threadId: value.threadId as string,
    subject: nullableBoundedString(value.subject, 998, true, "response"),
    participants: Object.freeze(value.participants.map(validateAddress)),
    snippet: nullableBoundedString(value.snippet, 4 * 1024, true, "response"),
    lastMessageAt: nullableTimestamp(value.lastMessageAt),
    messageCount: value.messageCount as number,
    unread: value.unread,
    starred: hasStarred ? (value.starred as boolean) : false,
    hasAttachments: value.hasAttachments,
    listMessage: hasListMessage ? (value.listMessage as boolean) : false,
    sizeBytes: hasListMessage ? (value.sizeBytes as number) : 0,
    category: hasCategory
      ? (value.category as MailThreadCategory)
      : "people",
    newSender: hasNewSender ? (value.newSender as boolean) : false,
    ...(hasNewSenderFrom ? { newSenderFrom: validateAddress(value.newSenderFrom) } : {}),
    ...(hasSenderBlocked ? { senderBlocked: true as const } : {}),
  });
}

function validateMessage(value: unknown): MailMessageDto {
  const baseFields = [
    "accountId",
    "cc",
    "from",
    "hasAttachments",
    "htmlBody",
    "inInbox",
    "messageId",
    "sentAt",
    "snippet",
    "subject",
    "textBody",
    "threadId",
    "to",
    "unread",
  ];
  const hasReplyTo =
    isPlainRecord(value) && Object.prototype.hasOwnProperty.call(value, "replyTo");
  if (
    !isRecordWithExactFields(
      value,
      hasReplyTo ? [...baseFields, "replyTo"] : baseFields,
    ) ||
    !SAFE_ACCOUNT_ID.test(typeof value.accountId === "string" ? value.accountId : "") ||
    !SAFE_RESOURCE_ID.test(typeof value.messageId === "string" ? value.messageId : "") ||
    !SAFE_RESOURCE_ID.test(typeof value.threadId === "string" ? value.threadId : "") ||
    (hasReplyTo && !Array.isArray(value.replyTo)) ||
    !Array.isArray(value.to) ||
    !Array.isArray(value.cc) ||
    (hasReplyTo && (value.replyTo as unknown[]).length > MAX_RECIPIENTS) ||
    value.to.length + value.cc.length > MAX_RECIPIENTS ||
    typeof value.unread !== "boolean" ||
    typeof value.inInbox !== "boolean" ||
    typeof value.hasAttachments !== "boolean"
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    accountId: value.accountId as string,
    messageId: value.messageId as string,
    threadId: value.threadId as string,
    from: value.from === null ? null : validateAddress(value.from),
    replyTo: Object.freeze(
      hasReplyTo ? (value.replyTo as unknown[]).map(validateAddress) : [],
    ),
    to: Object.freeze(value.to.map(validateAddress)),
    cc: Object.freeze(value.cc.map(validateAddress)),
    subject: nullableBoundedString(value.subject, 998, true, "response"),
    sentAt: nullableTimestamp(value.sentAt),
    unread: value.unread,
    inInbox: value.inInbox,
    snippet: nullableBoundedString(value.snippet, 4 * 1024, true, "response"),
    textBody: nullableBoundedString(value.textBody, MAX_TEXT_BYTES, true, "response"),
    htmlBody: nullableBoundedString(value.htmlBody, MAX_HTML_BYTES, true, "response"),
    hasAttachments: value.hasAttachments,
  });
}

function validateAddress(value: unknown): MailAddress {
  if (!isRecordWithExactFields(value, ["address", "name"])) throw responseInvalid();
  const address = boundedString(value.address, 320, false, "response");
  if (!isEmail(address)) throw responseInvalid();
  return Object.freeze({
    name: nullableBoundedString(value.name, 256, true, "response"),
    address,
  });
}

function validateRecipients(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_RECIPIENTS) throw requestInvalid();
  const recipients = value.map((entry) => {
    const address = boundedString(entry, 320, false, "request").toLowerCase();
    if (!isEmail(address)) throw requestInvalid();
    return address;
  });
  if (new Set(recipients).size !== recipients.length) throw requestInvalid();
  return recipients;
}

function isEmail(value: string): boolean {
  return !/[\u0000-\u0020\u007f]/.test(value) && /^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(value);
}

function validateSyncStatus(value: unknown): MailSyncStatus {
  if (
    value === "idle" ||
    value === "syncing" ||
    value === "backoff" ||
    value === "cache_full" ||
    value === "reauth_required"
  ) {
    return value;
  }
  throw responseInvalid();
}

function validateResponseMailbox(value: unknown): MailSystemMailbox {
  if (typeof value !== "string" || !SYSTEM_MAILBOXES.has(value as MailSystemMailbox)) {
    throw responseInvalid();
  }
  return value as MailSystemMailbox;
}

function validateMailboxAvailability(value: unknown): MailMailboxAvailability {
  if (!isPlainRecord(value) || typeof value.status !== "string") {
    throw responseInvalid();
  }
  if (value.status === "available") {
    if (
      !isRecordWithExactFields(value, [
        "lastSuccessfulAt",
        "status",
        "windowTruncated",
      ]) ||
      typeof value.windowTruncated !== "boolean"
    ) {
      throw responseInvalid();
    }
    return Object.freeze({
      status: "available",
      lastSuccessfulAt: requiredTimestamp(value.lastSuccessfulAt),
      windowTruncated: value.windowTruncated,
    });
  }
  if (
    value.status !== "unavailable" ||
    !isRecordWithExactFields(value, [
      "lastSuccessfulAt",
      "reason",
      "status",
      "windowTruncated",
    ]) ||
    value.windowTruncated !== null ||
    !(
      value.reason === "global_syncing" ||
      value.reason === "mailbox_uninitialized" ||
      value.reason === "mailbox_syncing" ||
      value.reason === "mailbox_backoff" ||
      value.reason === "mailbox_cache_capacity" ||
      value.reason === "mailbox_reauth_required" ||
      value.reason === "history_mismatch"
    )
  ) {
    throw responseInvalid();
  }
  return Object.freeze({
    status: "unavailable",
    reason: value.reason,
    lastSuccessfulAt: nullableTimestamp(value.lastSuccessfulAt),
    windowTruncated: null,
  });
}

function validateSendStatus(value: unknown): MailSendStatus {
  if (
    value === "queued" ||
    value === "sending" ||
    value === "sent" ||
    value === "failed" ||
    value === "delivery_unknown"
  ) {
    return value;
  }
  throw responseInvalid();
}

function validateResponseOperationId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_OPERATION_ID.test(value)) {
    throw responseInvalid();
  }
  return value;
}

function nullableTimestamp(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw responseInvalid();
  return value as number;
}

function requiredTimestamp(value: unknown): number {
  const timestamp = nullableTimestamp(value);
  if (timestamp === null) throw responseInvalid();
  return timestamp;
}

function nullableBoundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
  kind: "request" | "response",
): string | null {
  return value === null ? null : boundedString(value, maxBytes, allowEmpty, kind);
}

function boundedString(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
  kind: "request" | "response",
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\u0000") ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw kind === "request" ? requestInvalid() : responseInvalid();
  }
  return value;
}

function isRecordWithExactFields(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string")) return false;
  const sorted = (keys as string[]).sort();
  const expected = [...fields].sort();
  return sorted.every((key, index) => key === expected[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requestInvalid(): MailMessageCodecError {
  return new MailMessageCodecError("mail_request_invalid");
}

function responseInvalid(): MailMessageCodecError {
  return new MailMessageCodecError("mail_response_invalid");
}
