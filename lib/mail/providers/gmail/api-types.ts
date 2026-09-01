import type { MailBlobDescriptor } from "../../ports";

const GMAIL_RAW_MESSAGE_BYTES = 40 * 1024 * 1024;
const MAX_GMAIL_RETRY_AFTER_MS = 30 * 60 * 1_000;
const GMAIL_HTTP_DATE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [0-9]{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [0-9]|[0-9]{2}) [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4})$/;
const GMAIL_RAW_BASE64URL_CHARACTERS = Math.ceil(
  GMAIL_RAW_MESSAGE_BYTES / 3,
) * 4;

export const GMAIL_API_LIMITS = Object.freeze({
  pageItems: 50,
  paginationPages: 20,
  paginationItems: 1_000,
  listResponseBytes: 512 * 1024,
  messageResponseBytes: 12 * 1024 * 1024,
  threadResponseBytes: 32 * 1024 * 1024,
  errorResponseBytes: 64 * 1024,
  requestTimeoutMs: 15_000,
  pageTokenBytes: 2 * 1024,
  snippetBytes: 64 * 1024,
  headerBytes: 256 * 1024,
  headerCount: 512,
  mimeParts: 256,
  mimeDepth: 32,
  messagesPerThread: 200,
  labelsPerMessage: 256,
  bodyDataBytes: 12 * 1024 * 1024,
  rawMessageBytes: GMAIL_RAW_MESSAGE_BYTES,
  rawBase64UrlCharacters: GMAIL_RAW_BASE64URL_CHARACTERS,
  rawResponseBytes: GMAIL_RAW_BASE64URL_CHARACTERS + 4 * 1024,
});

export type GmailApiErrorCode =
  | "gmail_request_invalid"
  | "gmail_request_cancelled"
  | "gmail_request_timeout"
  | "gmail_reauth_required"
  | "gmail_permission_denied"
  | "gmail_not_found"
  | "gmail_conflict"
  | "gmail_rate_limited"
  | "gmail_service_unavailable"
  | "gmail_response_invalid";

export class GmailApiError extends Error {
  constructor(
    readonly code: GmailApiErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "GmailApiError";
  }
}

export type GmailAccessTokenErrorCode =
  | "invalid_grant"
  | "refresh_timeout"
  | "refresh_unavailable";

export class GmailAccessTokenError extends Error {
  constructor(
    readonly code: GmailAccessTokenErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "GmailAccessTokenError";
  }
}

export function parseGmailRetryAfterMs(
  value: string | null,
  now: number,
): number | null {
  if (!Number.isSafeInteger(now) || now < 0 || value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (/^[0-9]+$/.test(normalized)) {
    if (normalized.length > 10) return MAX_GMAIL_RETRY_AFTER_MS;
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds)) return MAX_GMAIL_RETRY_AFTER_MS;
    return Math.min(seconds * 1_000, MAX_GMAIL_RETRY_AFTER_MS);
  }
  if (!GMAIL_HTTP_DATE.test(normalized)) return null;
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt) || retryAt <= now) return null;
  return Math.min(retryAt - now, MAX_GMAIL_RETRY_AFTER_MS);
}

export interface GmailAccessTokenPort {
  /**
   * Returns an owned token buffer. The API client wipes it after each request.
   * forceRefresh is true only after Gmail rejects a cached token with HTTP 401.
   */
  getAccessToken(
    input: { readonly forceRefresh: boolean },
    signal: AbortSignal,
  ): Promise<Buffer>;
}

export interface GmailListOptions {
  readonly pageToken?: string;
  readonly maxPages?: number;
  readonly maxItems?: number;
}

/**
 * Fixed product views backed by Gmail system labels. `all` deliberately means
 * Gmail's regular mailbox listing with Spam and Trash excluded.
 */
export type GmailSystemMailbox =
  | "all"
  | "inbox"
  | "sent"
  | "spam"
  | "starred"
  | "trash";

export interface GmailInboxThreadSummary {
  readonly id: string;
  readonly snippet: string | null;
  readonly historyId: string | null;
}

export interface GmailInboxMessageSummary {
  readonly id: string;
  readonly threadId: string;
}

export interface GmailInboxList<T> {
  readonly items: readonly T[];
  readonly nextPageToken: string | null;
  readonly resultSizeEstimate: number;
}

export interface GmailProfile {
  readonly emailAddress: string;
  readonly messagesTotal: number;
  readonly threadsTotal: number;
  readonly historyId: string;
}

export interface GmailHistoryOptions {
  readonly startHistoryId: string;
  readonly pageToken?: string;
  readonly maxItems?: number;
}

export interface GmailHistoryMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
}

export interface GmailHistoryLabelChange {
  readonly message: GmailHistoryMessage;
  readonly labelIds: readonly string[];
}

export interface GmailHistoryRecord {
  readonly id: string;
  readonly messagesAdded: readonly GmailHistoryMessage[];
  readonly messagesDeleted: readonly GmailHistoryMessage[];
  readonly labelsAdded: readonly GmailHistoryLabelChange[];
  readonly labelsRemoved: readonly GmailHistoryLabelChange[];
}

export interface GmailHistoryPage {
  readonly items: readonly GmailHistoryRecord[];
  readonly nextPageToken: string | null;
  readonly historyId: string;
}

export interface GmailMessageHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailMessagePartBody {
  readonly attachmentId: string | null;
  readonly size: number;
  readonly data: string | null;
}

export interface GmailMessagePart {
  readonly partId: string | null;
  readonly mimeType: string | null;
  readonly filename: string | null;
  readonly headers: readonly GmailMessageHeader[];
  readonly body: GmailMessagePartBody | null;
  readonly parts: readonly GmailMessagePart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly labelIds: readonly string[];
  readonly snippet: string | null;
  readonly historyId: string | null;
  readonly internalDate: string | null;
  readonly payload: GmailMessagePart | null;
  readonly sizeEstimate: number | null;
}

export interface GmailRawMessageFetchResult {
  readonly id: string;
  readonly sizeEstimate: number;
  readonly descriptor: MailBlobDescriptor;
}

export interface GmailThread {
  readonly id: string;
  readonly snippet: string | null;
  readonly historyId: string | null;
  readonly messages: readonly GmailMessage[];
}

export interface GmailMutationResult {
  readonly id: string;
  readonly threadId: string | null;
  readonly labelIds: readonly string[];
}
