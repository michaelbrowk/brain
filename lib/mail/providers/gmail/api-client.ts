import type { MailIncomingBlobStorePort } from "../../ports";
import {
  GMAIL_API_LIMITS,
  GmailAccessTokenError,
  GmailApiError,
  parseGmailRetryAfterMs,
  type GmailAccessTokenPort,
  type GmailHistoryLabelChange,
  type GmailHistoryMessage,
  type GmailHistoryOptions,
  type GmailHistoryPage,
  type GmailHistoryRecord,
  type GmailInboxList,
  type GmailInboxMessageSummary,
  type GmailInboxThreadSummary,
  type GmailListOptions,
  type GmailMessage,
  type GmailMessageHeader,
  type GmailMessagePart,
  type GmailMessagePartBody,
  type GmailMutationResult,
  type GmailProfile,
  type GmailRawMessageFetchResult,
  type GmailSystemMailbox,
  type GmailThread,
} from "./api-types";
import { openGmailRawResponse } from "./raw-message-stream";

const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";
const GMAIL_API_ROOT = `${GMAIL_API_ORIGIN}/gmail/v1/users/me`;
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const MAX_MESSAGE_SIZE_ESTIMATE = GMAIL_API_LIMITS.rawMessageBytes;
const SAFE_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_LABEL_ID = /^[A-Za-z0-9_-]{1,255}$/;
const RATE_LIMIT_REASONS = new Set([
  "dailyLimitExceeded",
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

const GMAIL_SYSTEM_MAILBOXES: Readonly<
  Record<
    GmailSystemMailbox,
    { readonly labelId: string | null; readonly includeSpamTrash: boolean }
  >
> = Object.freeze({
  all: Object.freeze({ labelId: null, includeSpamTrash: false }),
  inbox: Object.freeze({ labelId: "INBOX", includeSpamTrash: false }),
  sent: Object.freeze({ labelId: "SENT", includeSpamTrash: false }),
  spam: Object.freeze({ labelId: "SPAM", includeSpamTrash: true }),
  starred: Object.freeze({ labelId: "STARRED", includeSpamTrash: false }),
  trash: Object.freeze({ labelId: "TRASH", includeSpamTrash: true }),
});

interface GmailApiClientOptions {
  readonly tokenPort: GmailAccessTokenPort;
  readonly request?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

interface ListPage<T> {
  readonly items: readonly T[];
  readonly nextPageToken: string | null;
  readonly resultSizeEstimate: number;
}

interface ValidationBudget {
  headerBytes: number;
  headerCount: number;
  mimeParts: number;
  bodyDataBytes: number;
}

interface GmailThreadLabelState {
  readonly id: string;
  readonly messages: readonly {
    readonly id: string;
    readonly labelIds: readonly string[];
  }[];
}

export class GmailApiClient {
  private readonly tokenPort: GmailAccessTokenPort;
  private readonly request: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: GmailApiClientOptions) {
    this.tokenPort = options.tokenPort;
    this.request = options.request ?? fetch;
    this.requestTimeoutMs = validateRequestTimeout(
      options.requestTimeoutMs ?? GMAIL_API_LIMITS.requestTimeoutMs,
    );
  }

  async listInboxThreads(
    options: GmailListOptions = {},
    signal?: AbortSignal,
  ): Promise<GmailInboxList<GmailInboxThreadSummary>> {
    return this.listThreads("inbox", options, signal);
  }

  async listThreads(
    mailbox: GmailSystemMailbox,
    options: GmailListOptions = {},
    signal?: AbortSignal,
  ): Promise<GmailInboxList<GmailInboxThreadSummary>> {
    return this.listMailbox(
      "threads",
      "threads",
      validateThreadListItem,
      mailbox,
      options,
      signal,
    );
  }

  async listInboxMessages(
    options: GmailListOptions = {},
    signal?: AbortSignal,
  ): Promise<GmailInboxList<GmailInboxMessageSummary>> {
    return this.listMessages("inbox", options, signal);
  }

  async listMessages(
    mailbox: GmailSystemMailbox,
    options: GmailListOptions = {},
    signal?: AbortSignal,
  ): Promise<GmailInboxList<GmailInboxMessageSummary>> {
    return this.listMailbox(
      "messages",
      "messages",
      validateMessageListItem,
      mailbox,
      options,
      signal,
    );
  }

  async getThread(id: string, signal?: AbortSignal): Promise<GmailThread> {
    const safeId = validateResourceId(id);
    const url = new URL(`${GMAIL_API_ROOT}/threads/${encodeURIComponent(safeId)}`);
    url.searchParams.set("format", "full");
    url.searchParams.set(
      "fields",
      "id,snippet,historyId,messages(id,threadId,labelIds,snippet,historyId,internalDate,sizeEstimate,payload)",
    );
    return this.requestJson(
      url,
      { method: "GET" },
      GMAIL_API_LIMITS.threadResponseBytes,
      (value) => requireRequestedId(validateThread(value), safeId),
      signal,
    );
  }

  async getProfile(signal?: AbortSignal): Promise<GmailProfile> {
    const url = new URL(`${GMAIL_API_ROOT}/profile`);
    url.searchParams.set(
      "fields",
      "emailAddress,messagesTotal,threadsTotal,historyId",
    );
    return this.requestJson(
      url,
      { method: "GET" },
      GMAIL_API_LIMITS.listResponseBytes,
      validateProfile,
      signal,
    );
  }

  async listHistory(
    options: GmailHistoryOptions,
    signal?: AbortSignal,
  ): Promise<GmailHistoryPage> {
    const normalized = validateHistoryOptions(options);
    const url = new URL(`${GMAIL_API_ROOT}/history`);
    url.searchParams.set("startHistoryId", normalized.startHistoryId);
    url.searchParams.set("maxResults", String(normalized.maxItems));
    url.searchParams.set(
      "fields",
      "history(id,messagesAdded(message(id,threadId,labelIds)),messagesDeleted(message(id,threadId,labelIds)),labelsAdded(message(id,threadId,labelIds),labelIds),labelsRemoved(message(id,threadId,labelIds),labelIds)),nextPageToken,historyId",
    );
    if (normalized.pageToken !== null) {
      url.searchParams.set("pageToken", normalized.pageToken);
    }
    return this.requestJson(
      url,
      { method: "GET" },
      GMAIL_API_LIMITS.listResponseBytes,
      (value) => validateHistoryPage(value, normalized.maxItems),
      signal,
    );
  }

  async getMessage(id: string, signal?: AbortSignal): Promise<GmailMessage> {
    const safeId = validateResourceId(id);
    const url = new URL(`${GMAIL_API_ROOT}/messages/${encodeURIComponent(safeId)}`);
    url.searchParams.set("format", "full");
    url.searchParams.set(
      "fields",
      "id,threadId,labelIds,snippet,historyId,internalDate,sizeEstimate,payload",
    );
    return this.requestJson(
      url,
      { method: "GET" },
      GMAIL_API_LIMITS.messageResponseBytes,
      (value) => requireRequestedId(validateMessage(value), safeId),
      signal,
    );
  }

  async getRawMessage(
    id: string,
    blobStore: MailIncomingBlobStorePort,
    signal?: AbortSignal,
  ): Promise<GmailRawMessageFetchResult> {
    const safeId = validateResourceId(id);
    if (
      blobStore === null ||
      typeof blobStore !== "object" ||
      typeof blobStore.putIncoming !== "function"
    ) {
      throw new GmailApiError("gmail_request_invalid");
    }
    const url = new URL(`${GMAIL_API_ROOT}/messages/${encodeURIComponent(safeId)}`);
    url.searchParams.set("format", "raw");
    url.searchParams.set("fields", "id,sizeEstimate,raw");
    url.searchParams.set("prettyPrint", "false");
    return this.requestRawMessage(url, safeId, blobStore, signal);
  }

  async markThreadRead(
    id: string,
    read: boolean,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    validateReadState(read);
    return this.modify("threads", id, read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], signal);
  }

  async markMessageRead(
    id: string,
    read: boolean,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    validateReadState(read);
    return this.modify("messages", id, read ? [] : ["UNREAD"], read ? ["UNREAD"] : [], signal);
  }

  async archiveThread(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modify("threads", id, [], ["INBOX"], signal);
  }

  /** The inverse of `archiveThread`: INBOX goes back on, nothing else moves. */
  async unarchiveThread(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modify("threads", id, ["INBOX"], [], signal);
  }

  async archiveMessage(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modify("messages", id, [], ["INBOX"], signal);
  }

  async trashThread(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.moveNonDraftThreadMessagesToTrash(id, true, signal);
  }

  async untrashThread(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.moveNonDraftThreadMessagesToTrash(id, false, signal);
  }

  async markThreadSpam(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modifyNonDraftThreadMessages(id, "SPAM", true, signal);
  }

  async markThreadNotSpam(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modifyNonDraftThreadMessages(id, "SPAM", false, signal);
  }

  async starThread(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modifyThreadLabel(id, "STARRED", true, signal);
  }

  async unstarThread(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    return this.modifyThreadLabel(id, "STARRED", false, signal);
  }

  private async listMailbox<T>(
    resource: "threads" | "messages",
    responseField: "threads" | "messages",
    validateItem: (value: unknown) => T,
    mailbox: GmailSystemMailbox,
    options: GmailListOptions,
    signal?: AbortSignal,
  ): Promise<GmailInboxList<T>> {
    const filter = validateSystemMailbox(mailbox);
    const normalized = validateListOptions(options);
    const items: T[] = [];
    const ids = new Set<string>();
    const seenPageTokens = new Set<string>();
    let pageToken = normalized.pageToken;
    let nextPageToken: string | null = null;
    let resultSizeEstimate = 0;

    for (let page = 0; page < normalized.maxPages; page += 1) {
      if (pageToken !== null) {
        if (seenPageTokens.has(pageToken)) {
          throw new GmailApiError("gmail_response_invalid");
        }
        seenPageTokens.add(pageToken);
      }
      const remaining = normalized.maxItems - items.length;
      if (remaining <= 0) break;
      const maxResults = Math.min(GMAIL_API_LIMITS.pageItems, remaining);
      const url = new URL(`${GMAIL_API_ROOT}/${resource}`);
      if (filter.labelId !== null) {
        url.searchParams.append("labelIds", filter.labelId);
      }
      url.searchParams.set(
        "includeSpamTrash",
        String(filter.includeSpamTrash),
      );
      url.searchParams.set("maxResults", String(maxResults));
      url.searchParams.set(
        "fields",
        resource === "threads"
          ? "threads(id,snippet,historyId),nextPageToken,resultSizeEstimate"
          : "messages(id,threadId),nextPageToken,resultSizeEstimate",
      );
      if (pageToken !== null) url.searchParams.set("pageToken", pageToken);
      const pageResult = await this.requestJson(
        url,
        { method: "GET" },
        GMAIL_API_LIMITS.listResponseBytes,
        (value) => validateListPage(value, responseField, validateItem, maxResults),
        signal,
      );
      if (page === 0) resultSizeEstimate = pageResult.resultSizeEstimate;
      for (const item of pageResult.items) {
        const id = (item as { readonly id: string }).id;
        if (ids.has(id)) throw new GmailApiError("gmail_response_invalid");
        ids.add(id);
        items.push(item);
      }
      nextPageToken = pageResult.nextPageToken;
      if (nextPageToken === null) break;
      if (seenPageTokens.has(nextPageToken)) {
        throw new GmailApiError("gmail_response_invalid");
      }
      pageToken = nextPageToken;
    }

    return Object.freeze({
      items: Object.freeze(items),
      nextPageToken,
      resultSizeEstimate,
    });
  }

  private async getThreadLabelState(
    id: string,
    signal?: AbortSignal,
  ): Promise<GmailThreadLabelState> {
    const safeId = validateResourceId(id);
    const url = new URL(
      `${GMAIL_API_ROOT}/threads/${encodeURIComponent(safeId)}`,
    );
    url.searchParams.set("format", "minimal");
    url.searchParams.set("fields", "id,messages(id,labelIds)");
    return this.requestJson(
      url,
      { method: "GET" },
      GMAIL_API_LIMITS.listResponseBytes,
      (value) => requireRequestedId(validateThreadLabelState(value), safeId),
      signal,
    );
  }

  private async moveNonDraftThreadMessagesToTrash(
    id: string,
    trash: boolean,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    const safeId = validateResourceId(id);
    const thread = await this.getThreadLabelState(safeId, signal);
    for (const message of thread.messages) {
      if (message.labelIds.includes("DRAFT")) continue;
      const isTrashed = message.labelIds.includes("TRASH");
      if (isTrashed === trash) continue;
      await this.moveMessageTrash(message.id, trash, signal);
    }
    return threadMutationResult(safeId);
  }

  private async moveMessageTrash(
    id: string,
    trash: boolean,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    const safeId = validateResourceId(id);
    const action = trash ? "trash" : "untrash";
    const url = new URL(
      `${GMAIL_API_ROOT}/messages/${encodeURIComponent(safeId)}/${action}`,
    );
    url.searchParams.set("fields", "id,threadId,labelIds");
    return this.requestJson(
      url,
      { method: "POST" },
      GMAIL_API_LIMITS.listResponseBytes,
      (value) =>
        requireRequestedId(validateMessageMutationResult(value), safeId),
      signal,
    );
  }

  private async modifyThreadLabel(
    id: string,
    labelId: string,
    add: boolean,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    const safeId = validateResourceId(id);
    const thread = await this.getThreadLabelState(safeId, signal);
    const nonDraftMessages = thread.messages.filter(
      (message) => !message.labelIds.includes("DRAFT"),
    );
    const needsChange = nonDraftMessages.filter((message) =>
      add
        ? !message.labelIds.includes(labelId)
        : message.labelIds.includes(labelId),
    );
    if (needsChange.length === 0) return threadMutationResult(safeId);

    if (nonDraftMessages.length === thread.messages.length) {
      return this.modify(
        "threads",
        safeId,
        add ? [labelId] : [],
        add ? [] : [labelId],
        signal,
      );
    }
    for (const message of needsChange) {
      await this.modify(
        "messages",
        message.id,
        add ? [labelId] : [],
        add ? [] : [labelId],
        signal,
      );
    }
    return threadMutationResult(safeId);
  }

  private async modifyNonDraftThreadMessages(
    id: string,
    labelId: string,
    add: boolean,
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    const safeId = validateResourceId(id);
    const thread = await this.getThreadLabelState(safeId, signal);
    for (const message of thread.messages) {
      if (message.labelIds.includes("DRAFT")) continue;
      const hasLabel = message.labelIds.includes(labelId);
      if (hasLabel === add) continue;
      await this.modify(
        "messages",
        message.id,
        add ? [labelId] : [],
        add ? [] : [labelId],
        signal,
      );
    }
    return threadMutationResult(safeId);
  }

  private async modify(
    resource: "threads" | "messages",
    id: string,
    addLabelIds: readonly string[],
    removeLabelIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<GmailMutationResult> {
    const safeId = validateResourceId(id);
    validateMutationLabels(addLabelIds, removeLabelIds);
    const url = new URL(
      `${GMAIL_API_ROOT}/${resource}/${encodeURIComponent(safeId)}/modify`,
    );
    url.searchParams.set(
      "fields",
      resource === "threads" ? "id" : "id,threadId,labelIds",
    );
    const body = JSON.stringify({ addLabelIds, removeLabelIds });
    return this.requestJson(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body,
      },
      GMAIL_API_LIMITS.listResponseBytes,
      (value) =>
        requireRequestedId(
          resource === "threads"
            ? validateThreadMutationResult(value)
            : validateMessageMutationResult(value),
          safeId,
        ),
      signal,
    );
  }

  private async requestJson<T>(
    url: URL,
    init: RequestInit,
    maxResponseBytes: number,
    validate: (value: unknown) => T,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    validateGmailApiUrl(url);
    const signal = callerSignal ?? new AbortController().signal;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const requestSignal = AbortSignal.any([signal, timeoutSignal]);
      let token: Buffer | null = null;
      try {
        token = await this.readAccessToken(attempt === 1, requestSignal);
        const authorization = `Bearer ${token.toString("utf8")}`;
        let response: Response;
        try {
          response = await this.request(url, {
            ...init,
            headers: {
              Accept: "application/json",
              ...Object.fromEntries(new Headers(init.headers)),
              Authorization: authorization,
            },
            cache: "no-store",
            redirect: "error",
            signal: requestSignal,
          });
        } catch (error) {
          throw mapTransportError(error, signal, timeoutSignal);
        }

        if (response.status === 401) {
          await discardResponse(response, GMAIL_API_LIMITS.errorResponseBytes);
          if (attempt === 0) continue;
          throw new GmailApiError("gmail_reauth_required");
        }
        if (response.status !== 200) {
          throw await mapHttpError(response);
        }
        if (!isJsonContentType(response.headers.get("Content-Type"))) {
          await discardResponse(response, maxResponseBytes).catch(() => undefined);
          throw new GmailApiError("gmail_response_invalid");
        }
        const payload = await readBoundedJson(response, maxResponseBytes);
        return validate(payload);
      } catch (error) {
        if (error instanceof GmailApiError) throw error;
        if (error instanceof GmailAccessTokenError) {
          throw mapTokenError(error);
        }
        throw mapTransportError(error, signal, timeoutSignal);
      } finally {
        token?.fill(0);
      }
    }
    throw new GmailApiError("gmail_reauth_required");
  }

  private async requestRawMessage(
    url: URL,
    requestedId: string,
    blobStore: MailIncomingBlobStorePort,
    callerSignal?: AbortSignal,
  ): Promise<GmailRawMessageFetchResult> {
    validateGmailApiUrl(url);
    const signal = callerSignal ?? new AbortController().signal;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
      const requestSignal = AbortSignal.any([signal, timeoutSignal]);
      let token: Buffer | null = null;
      try {
        token = await this.readAccessToken(attempt === 1, requestSignal);
        const authorization = `Bearer ${token.toString("utf8")}`;
        let response: Response;
        try {
          response = await this.request(url, {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: authorization,
            },
            cache: "no-store",
            redirect: "error",
            signal: requestSignal,
          });
        } catch (error) {
          throw mapTransportError(error, signal, timeoutSignal);
        }

        if (response.status === 401) {
          await discardResponse(response, GMAIL_API_LIMITS.errorResponseBytes);
          if (attempt === 0) continue;
          throw new GmailApiError("gmail_reauth_required");
        }
        if (response.status !== 200) {
          throw await mapHttpError(response);
        }
        if (!isJsonContentType(response.headers.get("Content-Type"))) {
          await response.body?.cancel().catch(() => undefined);
          throw new GmailApiError("gmail_response_invalid");
        }

        let decoder;
        try {
          decoder = await openGmailRawResponse(
            response,
            requestedId,
            requestSignal,
          );
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
        const streamFailure: { failed: boolean; error: unknown } = {
          failed: false,
          error: undefined,
        };
        const chunks = captureStreamFailure(decoder.chunks, (error) => {
          streamFailure.failed = true;
          streamFailure.error = error;
        });
        let descriptor;
        try {
          descriptor = await blobStore.putIncoming(
            chunks,
            GMAIL_API_LIMITS.rawMessageBytes,
          );
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          if (streamFailure.failed) {
            const sourceError = streamFailure.error;
            if (sourceError instanceof GmailApiError) throw sourceError;
            throw mapTransportError(sourceError, signal, timeoutSignal);
          }
          throw error;
        }
        const metadata = decoder.finish();
        return Object.freeze({
          id: metadata.id,
          sizeEstimate: metadata.sizeEstimate,
          descriptor,
        });
      } catch (error) {
        if (error instanceof GmailApiError) throw error;
        if (error instanceof GmailAccessTokenError) {
          throw mapTokenError(error);
        }
        throw mapTransportError(error, signal, timeoutSignal);
      } finally {
        token?.fill(0);
      }
    }
    throw new GmailApiError("gmail_reauth_required");
  }

  private async readAccessToken(
    forceRefresh: boolean,
    signal: AbortSignal,
  ): Promise<Buffer> {
    let token: Buffer;
    try {
      token = await this.tokenPort.getAccessToken({ forceRefresh }, signal);
    } catch (error) {
      if (error instanceof GmailAccessTokenError) throw error;
      if (signal.aborted) throw error;
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    if (
      !Buffer.isBuffer(token) ||
      token.length === 0 ||
      token.length > MAX_ACCESS_TOKEN_BYTES ||
      token.includes(0) ||
      token.includes(10) ||
      token.includes(13)
    ) {
      if (Buffer.isBuffer(token)) token.fill(0);
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    return token;
  }
}

async function* captureStreamFailure(
  chunks: AsyncIterable<Uint8Array>,
  onFailure: (error: unknown) => void,
): AsyncIterable<Uint8Array> {
  try {
    yield* chunks;
  } catch (error) {
    onFailure(error);
    throw error;
  }
}

function validateSystemMailbox(
  value: unknown,
): (typeof GMAIL_SYSTEM_MAILBOXES)[GmailSystemMailbox] {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(GMAIL_SYSTEM_MAILBOXES, value)
  ) {
    throw new GmailApiError("gmail_request_invalid");
  }
  return GMAIL_SYSTEM_MAILBOXES[value as GmailSystemMailbox];
}

function validateListOptions(value: GmailListOptions): {
  readonly pageToken: string | null;
  readonly maxPages: number;
  readonly maxItems: number;
} {
  if (!isRecord(value)) throw new GmailApiError("gmail_request_invalid");
  const allowed = new Set(["pageToken", "maxPages", "maxItems"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new GmailApiError("gmail_request_invalid");
  }
  const pageToken =
    value.pageToken === undefined
      ? null
      : validateRequestPageToken(value.pageToken);
  const maxPagesValue = value.maxPages;
  const maxItemsValue = value.maxItems;
  const maxPages =
    maxPagesValue === undefined
      ? GMAIL_API_LIMITS.paginationPages
      : maxPagesValue;
  const maxItems =
    maxItemsValue === undefined
      ? GMAIL_API_LIMITS.paginationItems
      : maxItemsValue;
  if (
    typeof maxPages !== "number" ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > GMAIL_API_LIMITS.paginationPages ||
    typeof maxItems !== "number" ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > GMAIL_API_LIMITS.paginationItems
  ) {
    throw new GmailApiError("gmail_request_invalid");
  }
  return Object.freeze({ pageToken, maxPages, maxItems });
}

function validateHistoryOptions(value: GmailHistoryOptions): {
  readonly startHistoryId: string;
  readonly pageToken: string | null;
  readonly maxItems: number;
} {
  if (!isRecord(value)) throw new GmailApiError("gmail_request_invalid");
  const allowed = new Set(["startHistoryId", "pageToken", "maxItems"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new GmailApiError("gmail_request_invalid");
  }
  const startHistoryId = validateRequestHistoryId(value.startHistoryId);
  const pageToken =
    value.pageToken === undefined
      ? null
      : validateRequestPageToken(value.pageToken);
  const maxItems = value.maxItems ?? GMAIL_API_LIMITS.pageItems;
  if (
    typeof maxItems !== "number" ||
    !Number.isSafeInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > GMAIL_API_LIMITS.pageItems
  ) {
    throw new GmailApiError("gmail_request_invalid");
  }
  return Object.freeze({ startHistoryId, pageToken, maxItems });
}

function validateListPage<T>(
  value: unknown,
  field: "threads" | "messages",
  validateItem: (item: unknown) => T,
  maxResults: number,
): ListPage<T> {
  if (!hasOnlyFields(value, [field, "nextPageToken", "resultSizeEstimate"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const rawItems = value[field];
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const items = (rawItems ?? []).map(validateItem);
  if (items.length > maxResults) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const nextPageToken =
    value.nextPageToken === undefined
      ? null
      : validatePageToken(value.nextPageToken);
  const resultSizeEstimateValue = value.resultSizeEstimate;
  const resultSizeEstimate =
    resultSizeEstimateValue === undefined
      ? items.length
      : resultSizeEstimateValue;
  if (
    typeof resultSizeEstimate !== "number" ||
    !Number.isSafeInteger(resultSizeEstimate) ||
    resultSizeEstimate < 0 ||
    resultSizeEstimate > 0xffff_ffff
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    items: Object.freeze(items),
    nextPageToken,
    resultSizeEstimate,
  });
}

function validateProfile(value: unknown): GmailProfile {
  if (
    !isExactRecord(value, [
      "emailAddress",
      "historyId",
      "messagesTotal",
      "threadsTotal",
    ]) ||
    typeof value.emailAddress !== "string" ||
    value.emailAddress.length === 0 ||
    Buffer.byteLength(value.emailAddress) > 320 ||
    value.emailAddress.includes("\u0000")
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    emailAddress: value.emailAddress,
    messagesTotal: validateUnsignedCount(value.messagesTotal),
    threadsTotal: validateUnsignedCount(value.threadsTotal),
    historyId: validateHistoryIdFromResponse(value.historyId),
  });
}

function validateHistoryPage(value: unknown, maxItems: number): GmailHistoryPage {
  if (!hasOnlyFields(value, ["history", "nextPageToken", "historyId"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const rawHistory = value.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > maxItems) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const items = rawHistory.map(validateHistoryRecord);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new GmailApiError("gmail_response_invalid");
    ids.add(item.id);
  }
  return Object.freeze({
    items: Object.freeze(items),
    nextPageToken:
      value.nextPageToken === undefined
        ? null
        : validatePageToken(value.nextPageToken),
    historyId: validateHistoryIdFromResponse(value.historyId),
  });
}

function validateHistoryRecord(value: unknown): GmailHistoryRecord {
  if (
    !hasOnlyFields(value, [
      "id",
      "messagesAdded",
      "messagesDeleted",
      "labelsAdded",
      "labelsRemoved",
    ])
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateHistoryIdFromResponse(value.id),
    messagesAdded: validateHistoryMessageEntries(value.messagesAdded),
    messagesDeleted: validateHistoryMessageEntries(value.messagesDeleted),
    labelsAdded: validateHistoryLabelEntries(value.labelsAdded),
    labelsRemoved: validateHistoryLabelEntries(value.labelsRemoved),
  });
}

function validateHistoryMessageEntries(value: unknown): readonly GmailHistoryMessage[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > GMAIL_API_LIMITS.pageItems * 4) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze(
    value.map((entry) => {
      if (!isExactRecord(entry, ["message"])) {
        throw new GmailApiError("gmail_response_invalid");
      }
      return validateHistoryMessage(entry.message);
    }),
  );
}

function validateHistoryLabelEntries(value: unknown): readonly GmailHistoryLabelChange[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > GMAIL_API_LIMITS.pageItems * 4) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze(
    value.map((entry) => {
      if (!isExactRecord(entry, ["labelIds", "message"])) {
        throw new GmailApiError("gmail_response_invalid");
      }
      return Object.freeze({
        message: validateHistoryMessage(entry.message),
        labelIds: validateLabelIds(entry.labelIds, false),
      });
    }),
  );
}

function validateHistoryMessage(value: unknown): GmailHistoryMessage {
  if (!hasOnlyFields(value, ["id", "threadId", "labelIds"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    threadId: validateResourceIdFromResponse(value.threadId),
    labelIds: validateLabelIds(value.labelIds, true),
  });
}

function validateThreadListItem(value: unknown): GmailInboxThreadSummary {
  if (!hasOnlyFields(value, ["id", "snippet", "historyId"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    snippet: validateOptionalSnippet(value.snippet),
    historyId: validateOptionalHistoryId(value.historyId),
  });
}

function validateMessageListItem(value: unknown): GmailInboxMessageSummary {
  if (!isExactRecord(value, ["id", "threadId"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    threadId: validateResourceIdFromResponse(value.threadId),
  });
}

function validateThread(value: unknown): GmailThread {
  if (!hasOnlyFields(value, ["id", "snippet", "historyId", "messages"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  if (!Array.isArray(value.messages) || value.messages.length > GMAIL_API_LIMITS.messagesPerThread) {
    throw new GmailApiError("gmail_response_invalid");
  }
  // Gmail threads can contain many individually valid messages. Validation
  // budgets are per message; the bounded HTTP reader is the aggregate thread
  // budget. Sharing one header/MIME budget across the whole conversation made
  // ordinary long threads fail once their combined header count crossed the
  // single-message limit.
  const messages = value.messages.map((message) => validateMessage(message));
  const id = validateResourceIdFromResponse(value.id);
  if (messages.some((message) => message.threadId !== id)) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id,
    snippet: validateOptionalSnippet(value.snippet),
    historyId: validateOptionalHistoryId(value.historyId),
    messages: Object.freeze(messages),
  });
}

function validateMessage(
  value: unknown,
  budget = createValidationBudget(),
): GmailMessage {
  if (
    !hasOnlyFields(value, [
      "id",
      "threadId",
      "labelIds",
      "snippet",
      "historyId",
      "internalDate",
      "payload",
      "sizeEstimate",
    ])
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const labelIds = value.labelIds ?? [];
  if (
    !Array.isArray(labelIds) ||
    labelIds.length > GMAIL_API_LIMITS.labelsPerMessage ||
    labelIds.some((label) => typeof label !== "string" || !SAFE_LABEL_ID.test(label)) ||
    new Set(labelIds).size !== labelIds.length
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const payload =
    value.payload === undefined ? null : validateMessagePart(value.payload, 1, budget);
  const sizeEstimateValue = value.sizeEstimate;
  const sizeEstimate =
    sizeEstimateValue === undefined ? null : sizeEstimateValue;
  if (
    sizeEstimate !== null &&
    (typeof sizeEstimate !== "number" ||
      !Number.isSafeInteger(sizeEstimate) ||
      sizeEstimate < 0 ||
      sizeEstimate > MAX_MESSAGE_SIZE_ESTIMATE)
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const internalDate = value.internalDate ?? null;
  if (
    internalDate !== null &&
    (typeof internalDate !== "string" || !/^\d{1,20}$/.test(internalDate))
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    threadId: validateResourceIdFromResponse(value.threadId),
    labelIds: Object.freeze([...labelIds] as string[]),
    snippet: validateOptionalSnippet(value.snippet),
    historyId: validateOptionalHistoryId(value.historyId),
    internalDate,
    payload,
    sizeEstimate,
  });
}

function validateMessagePart(
  value: unknown,
  depth: number,
  budget: ValidationBudget,
): GmailMessagePart {
  budget.mimeParts += 1;
  if (
    depth > GMAIL_API_LIMITS.mimeDepth ||
    budget.mimeParts > GMAIL_API_LIMITS.mimeParts ||
    !hasOnlyFields(value, [
      "partId",
      "mimeType",
      "filename",
      "headers",
      "body",
      "parts",
    ])
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const headers = value.headers ?? [];
  if (!Array.isArray(headers)) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const parsedHeaders = headers.map((header) => validateHeader(header, budget));
  const parts = value.parts ?? [];
  if (!Array.isArray(parts)) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const parsedParts = parts.map((part) => validateMessagePart(part, depth + 1, budget));
  return Object.freeze({
    partId: validateOptionalText(value.partId, 128, true),
    mimeType: validateOptionalText(value.mimeType, 256, true),
    filename: validateOptionalText(value.filename, 4 * 1024, true),
    headers: Object.freeze(parsedHeaders),
    body: value.body === undefined ? null : validatePartBody(value.body, budget),
    parts: Object.freeze(parsedParts),
  });
}

function validateHeader(
  value: unknown,
  budget: ValidationBudget,
): GmailMessageHeader {
  if (!isExactRecord(value, ["name", "value"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const name = validateText(value.name, 256, false);
  const headerValue = validateText(value.value, 64 * 1024, true);
  budget.headerCount += 1;
  budget.headerBytes += Buffer.byteLength(name) + Buffer.byteLength(headerValue);
  if (
    budget.headerCount > GMAIL_API_LIMITS.headerCount ||
    budget.headerBytes > GMAIL_API_LIMITS.headerBytes
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({ name, value: headerValue });
}

function validatePartBody(
  value: unknown,
  budget: ValidationBudget,
): GmailMessagePartBody {
  if (!hasOnlyFields(value, ["attachmentId", "size", "data"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const size = value.size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_MESSAGE_SIZE_ESTIMATE
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const attachmentId = validateOptionalOpaque(value.attachmentId, 4 * 1024);
  const rawData = value.data;
  if (rawData !== undefined && typeof rawData !== "string") {
    throw new GmailApiError("gmail_response_invalid");
  }
  const rawDataBytes = rawData === undefined ? 0 : Buffer.byteLength(rawData);
  const data = rawData === undefined ? null : normalizeBase64UrlData(rawData);
  if (data !== null) {
    budget.bodyDataBytes += rawDataBytes;
    if (budget.bodyDataBytes > GMAIL_API_LIMITS.bodyDataBytes) {
      throw new GmailApiError("gmail_response_invalid");
    }
  }
  return Object.freeze({ attachmentId, size, data });
}

function normalizeBase64UrlData(value: string): string {
  if (
    Buffer.byteLength(value) > GMAIL_API_LIMITS.bodyDataBytes ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(value)
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const normalized = value.replace(/={1,2}$/, "");
  const paddingLength = value.length - normalized.length;
  if (
    normalized.length % 4 === 1 ||
    (paddingLength > 0 && value.length % 4 !== 0) ||
    (paddingLength === 1 && normalized.length % 4 !== 3) ||
    (paddingLength === 2 && normalized.length % 4 !== 2)
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const bytes = Buffer.from(normalized, "base64url");
  try {
    if (bytes.toString("base64url") !== normalized) {
      throw new GmailApiError("gmail_response_invalid");
    }
    return normalized;
  } finally {
    bytes.fill(0);
  }
}

function validateThreadMutationResult(value: unknown): GmailMutationResult {
  if (!isExactRecord(value, ["id"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    threadId: null,
    labelIds: Object.freeze([]),
  });
}

function validateThreadLabelState(value: unknown): GmailThreadLabelState {
  if (!isExactRecord(value, ["id", "messages"]) || !Array.isArray(value.messages)) {
    throw new GmailApiError("gmail_response_invalid");
  }
  if (
    value.messages.length > GMAIL_API_LIMITS.messagesPerThread ||
    value.messages.length === 0
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const messages = value.messages.map((message) => {
    if (!isExactRecord(message, ["id", "labelIds"]) || !Array.isArray(message.labelIds)) {
      throw new GmailApiError("gmail_response_invalid");
    }
    if (
      message.labelIds.length > GMAIL_API_LIMITS.labelsPerMessage ||
      message.labelIds.some(
        (label) => typeof label !== "string" || !SAFE_LABEL_ID.test(label),
      ) ||
      new Set(message.labelIds).size !== message.labelIds.length
    ) {
      throw new GmailApiError("gmail_response_invalid");
    }
    return Object.freeze({
      id: validateResourceIdFromResponse(message.id),
      labelIds: Object.freeze([...message.labelIds] as string[]),
    });
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    messages: Object.freeze(messages),
  });
}

function threadMutationResult(id: string): GmailMutationResult {
  return Object.freeze({
    id,
    threadId: null,
    labelIds: Object.freeze([]),
  });
}

function validateMessageMutationResult(value: unknown): GmailMutationResult {
  if (!hasOnlyFields(value, ["id", "threadId", "labelIds"])) {
    throw new GmailApiError("gmail_response_invalid");
  }
  const labelIds = value.labelIds ?? [];
  if (
    !Array.isArray(labelIds) ||
    labelIds.length > GMAIL_API_LIMITS.labelsPerMessage ||
    labelIds.some((label) => typeof label !== "string" || !SAFE_LABEL_ID.test(label)) ||
    new Set(labelIds).size !== labelIds.length
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze({
    id: validateResourceIdFromResponse(value.id),
    threadId: validateResourceIdFromResponse(value.threadId),
    labelIds: Object.freeze([...labelIds] as string[]),
  });
}

function requireRequestedId<T extends { readonly id: string }>(
  value: T,
  requestedId: string,
): T {
  if (value.id !== requestedId) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function validateReadState(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new GmailApiError("gmail_request_invalid");
  }
}

function validateMutationLabels(
  addLabelIds: readonly string[],
  removeLabelIds: readonly string[],
): void {
  if (
    addLabelIds.length > 100 ||
    removeLabelIds.length > 100 ||
    addLabelIds.some((label) => !SAFE_LABEL_ID.test(label)) ||
    removeLabelIds.some((label) => !SAFE_LABEL_ID.test(label)) ||
    addLabelIds.some((label) => removeLabelIds.includes(label))
  ) {
    throw new GmailApiError("gmail_request_invalid");
  }
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, maxBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new GmailApiError("gmail_response_invalid");
  } finally {
    bytes.fill(0);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailApiError("gmail_response_invalid");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GmailApiError("gmail_response_invalid");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        next.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new GmailApiError("gmail_response_invalid");
      }
      chunks.push(next.value.slice());
      next.value.fill(0);
    }
    if (declared !== null && total !== Number(declared)) {
      throw new GmailApiError("gmail_response_invalid");
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

async function discardResponse(response: Response, maxBytes: number): Promise<void> {
  try {
    const body = await readBoundedBody(response, maxBytes);
    body.fill(0);
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function mapHttpError(response: Response): Promise<GmailApiError> {
  const status = response.status;
  const retryAfterMs = parseGmailRetryAfterMs(
    response.headers.get("Retry-After"),
    Date.now(),
  );
  const reasons = await readErrorReasons(response);
  if (status === 403 && reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))) {
    return new GmailApiError("gmail_rate_limited", retryAfterMs);
  }
  if (status === 400) return new GmailApiError("gmail_request_invalid");
  if (status === 403) return new GmailApiError("gmail_permission_denied");
  if (status === 404) return new GmailApiError("gmail_not_found");
  if (status === 409) return new GmailApiError("gmail_conflict");
  if (status === 429) {
    return new GmailApiError("gmail_rate_limited", retryAfterMs);
  }
  return new GmailApiError("gmail_service_unavailable", retryAfterMs);
}

async function readErrorReasons(response: Response): Promise<readonly string[]> {
  try {
    if (!isJsonContentType(response.headers.get("Content-Type"))) {
      await discardResponse(response, GMAIL_API_LIMITS.errorResponseBytes);
      return [];
    }
    const value = await readBoundedJson(response, GMAIL_API_LIMITS.errorResponseBytes);
    if (!isRecord(value) || !isRecord(value.error) || !Array.isArray(value.error.errors)) {
      return [];
    }
    return value.error.errors
      .slice(0, 32)
      .map((entry) => (isRecord(entry) ? entry.reason : undefined))
      .filter((reason): reason is string =>
        typeof reason === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(reason),
      );
  } catch {
    return [];
  }
}

function mapTokenError(error: GmailAccessTokenError): GmailApiError {
  if (error.code === "invalid_grant") {
    return new GmailApiError("gmail_reauth_required");
  }
  if (error.code === "refresh_timeout") {
    return new GmailApiError("gmail_request_timeout");
  }
  return new GmailApiError("gmail_service_unavailable", error.retryAfterMs);
}

function mapTransportError(
  _error: unknown,
  callerSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): GmailApiError {
  if (callerSignal.aborted) {
    return new GmailApiError("gmail_request_cancelled");
  }
  if (timeoutSignal.aborted) {
    return new GmailApiError("gmail_request_timeout");
  }
  return new GmailApiError("gmail_service_unavailable");
}

function validateGmailApiUrl(url: URL): void {
  if (
    url.origin !== GMAIL_API_ORIGIN ||
    !url.pathname.startsWith("/gmail/v1/users/me/") ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new GmailApiError("gmail_request_invalid");
  }
}

function validateRequestTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 60_000) {
    throw new GmailApiError("gmail_request_invalid");
  }
  return value;
}

function validateResourceId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_RESOURCE_ID.test(value)) {
    throw new GmailApiError("gmail_request_invalid");
  }
  return value;
}

function validateResourceIdFromResponse(value: unknown): string {
  try {
    return validateResourceId(value);
  } catch {
    throw new GmailApiError("gmail_response_invalid");
  }
}

function validatePageToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > GMAIL_API_LIMITS.pageTokenBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function validateRequestPageToken(value: unknown): string {
  try {
    return validatePageToken(value);
  } catch {
    throw new GmailApiError("gmail_request_invalid");
  }
}

function validateOptionalSnippet(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > GMAIL_API_LIMITS.snippetBytes ||
    value.includes("\u0000")
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function validateOptionalHistoryId(value: unknown): string | null {
  if (value === undefined) return null;
  return validateHistoryIdFromResponse(value);
}

function validateRequestHistoryId(value: unknown): string {
  try {
    return validateHistoryIdFromResponse(value);
  } catch {
    throw new GmailApiError("gmail_request_invalid");
  }
}

function validateHistoryIdFromResponse(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,32}$/.test(value)) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function validateUnsignedCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function validateLabelIds(
  value: unknown,
  optional: boolean,
): readonly string[] {
  if (value === undefined && optional) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > GMAIL_API_LIMITS.labelsPerMessage ||
    value.some(
      (label) => typeof label !== "string" || !SAFE_LABEL_ID.test(label),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return Object.freeze([...value] as string[]);
}

function validateOptionalText(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
): string | null {
  if (value === undefined) return null;
  return validateText(value, maxBytes, allowEmpty);
}

function validateOptionalOpaque(value: unknown, maxBytes: number): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function validateText(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value) > maxBytes ||
    value.includes("\u0000")
  ) {
    throw new GmailApiError("gmail_response_invalid");
  }
  return value;
}

function createValidationBudget(): ValidationBudget {
  return { headerBytes: 0, headerCount: 0, mimeParts: 0, bodyDataBytes: 0 };
}

function isJsonContentType(value: string | null): boolean {
  return value !== null && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyFields(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      allowed.includes(key) &&
      descriptors[key] !== undefined &&
      "value" in descriptors[key],
  );
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    hasOnlyFields(value, fields) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}
