import type {
  MailMailboxThreadPage,
  MailSearchThreadPage,
  MailSyncResult,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadMutationInput,
  MailThreadMutationResult,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "../message-types";
import {
  MAIL_CACHE_HYDRATION_ORDER,
  MailCacheError,
  type CachedProviderThread,
  type MailCacheHydratableMailbox,
  type MailCacheReauthErrorCode,
  type MailboxHydrationState,
  SqliteMailMessageCache,
} from "./message-cache";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_SYNC_ITEMS = 20;
const MAX_CHANGED_THREADS = 100;
const MAX_CHANGED_MESSAGES = 500;
const MAX_SYNC_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_ALL_MAIL_HYDRATION_THREADS = 200;

export type MailProviderSyncErrorCode =
  | "mail_provider_reauth_required"
  | "mail_provider_cursor_invalid"
  | "mail_provider_rate_limited"
  | "mail_provider_unavailable"
  | "mail_provider_response_invalid"
  /**
   * The account cannot perform this mutation and never will, on this server,
   * with this folder layout — an IMAP host that advertises no archive, trash
   * or junk mailbox and offers no well-known name either. It is a refusal, not
   * an outage, so nothing retries it.
   */
  | "mail_provider_mutation_unsupported"
  /**
   * The thread is not where the account last saw it — another client moved
   * or expunged it, or the adapter moved it and a restart took the handle.
   * No retry brings the handle back; the next sync rebuilds the list from
   * the server. A mutation's code only: a listing that loses its place says
   * `mail_provider_cursor_invalid` and is rebuilt on the spot.
   */
  | "mail_provider_thread_stale";

export class MailProviderSyncError extends Error {
  constructor(
    readonly code: MailProviderSyncErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = "MailProviderSyncError";
  }
}

export interface MailProviderInitialPage {
  readonly threads: readonly CachedProviderThread[];
  readonly nextPageToken: string | null;
}

export interface MailProviderIncrementalPage {
  readonly changedThreadIds: readonly string[];
  readonly nextPageToken: string | null;
  readonly resultingHistoryId: string;
}

export interface MailProviderSyncPort {
  getSyncAnchor(signal: AbortSignal): Promise<string>;
  listInitialThreads(
    input: { readonly pageToken: string | null; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailProviderInitialPage>;
  listMailboxThreads(
    input: {
      readonly mailboxId: MailCacheHydratableMailbox;
      readonly pageToken: string | null;
      readonly maxItems: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly threads: readonly CachedProviderThread[];
    readonly nextPageToken: string | null;
    readonly listedCount: number;
  }>;
  listChanges(
    input: {
      readonly startHistoryId: string;
      readonly pageToken: string | null;
      readonly maxItems: number;
    },
    signal: AbortSignal,
  ): Promise<MailProviderIncrementalPage>;
  getThread(
    threadId: string,
    signal: AbortSignal,
  ): Promise<CachedProviderThread | null>;
  setThreadRead(
    threadId: string,
    read: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  archiveThread(threadId: string, signal: AbortSignal): Promise<void>;
  /** The inverse of `archiveThread` — the thread comes back to the inbox. */
  unarchiveThread(threadId: string, signal: AbortSignal): Promise<void>;
  trashThread(threadId: string, signal: AbortSignal): Promise<void>;
  restoreThread(threadId: string, signal: AbortSignal): Promise<void>;
  setThreadSpam(
    threadId: string,
    spam: boolean,
    signal: AbortSignal,
  ): Promise<void>;
  setThreadStarred(
    threadId: string,
    starred: boolean,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface MailBackgroundSyncHealth {
  readonly lastSuccessfulAt: number | null;
  readonly lastErrorCode: string | null;
}

/** Internal scheduler result. The public sync response stays provider-neutral. */
export interface MailBackgroundSyncStep {
  readonly result: MailSyncResult;
  readonly hasMore: boolean;
}

export interface MailMessageService {
  readBackgroundSyncHealth?(): Promise<MailBackgroundSyncHealth>;
  listThreads(input: {
    readonly accountId: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): Promise<MailThreadPage>;
  listMailboxThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): Promise<MailMailboxThreadPage>;
  searchThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly query: string;
    readonly cursor?: string | null;
    readonly limit: number;
  }): Promise<MailSearchThreadPage>;
  getThread(input: {
    readonly accountId: string;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null>;
  getMailboxThread(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null>;
  sync(
    input: { readonly accountId: string; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailSyncResult>;
  syncAccount(
    accountId: string,
    options: { readonly maxItems: number },
    signal?: AbortSignal,
  ): Promise<MailSyncResult>;
  updateThread(
    input: MailThreadMutationInput & { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<MailThreadMutationResult>;
}

/**
 * One account-scoped service instance. The composition root must first verify
 * that accountId is still connected, then create the matching provider port
 * and per-account cache. Account deletion remains local-only and wins by
 * renaming the whole cache directory out of the live namespace.
 */
export class AccountMailMessageService implements MailMessageService {
  private readonly accountId: string;
  private readonly cache: SqliteMailMessageCache;
  private readonly provider: MailProviderSyncPort;
  private readonly reauthErrorCode: MailCacheReauthErrorCode;
  private readonly hydrateHiddenMailboxes: boolean;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly accountId: string;
    readonly cache: SqliteMailMessageCache;
    readonly provider: MailProviderSyncPort;
    readonly reauthErrorCode: MailCacheReauthErrorCode;
    readonly hydrateHiddenMailboxes?: boolean;
    readonly now?: () => number;
  }) {
    this.accountId = validateAccountId(options.accountId);
    this.cache = options.cache;
    this.provider = options.provider;
    this.reauthErrorCode = options.reauthErrorCode;
    this.hydrateHiddenMailboxes = options.hydrateHiddenMailboxes ?? true;
    this.now = options.now ?? Date.now;
  }

  async readBackgroundSyncHealth(): Promise<MailBackgroundSyncHealth> {
    return this.cache.readBackgroundSyncHealth();
  }

  async listThreads(input: {
    readonly accountId: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): Promise<MailThreadPage> {
    this.assertAccount(input.accountId);
    return this.cache.listThreads({
      cursor: input.cursor,
      limit: input.limit,
      view: input.view ?? null,
      sort: input.sort ?? "date",
    });
  }

  async listMailboxThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): Promise<MailMailboxThreadPage> {
    this.assertAccount(input.accountId);
    const page = this.cache.listMailboxThreads({
      mailboxId: input.mailboxId,
      cursor: input.cursor,
      limit: input.limit,
      view: input.view ?? null,
      sort: input.sort ?? "date",
    });
    const availability =
      page.availability.status === "available"
        ? Object.freeze({
            status: "available" as const,
            lastSuccessfulAt: page.availability.lastSuccessfulAt,
            windowTruncated: page.availability.windowTruncated,
          })
        : page.availability;
    return Object.freeze({
      apiVersion: 1,
      mailboxId: page.mailboxId,
      items: page.items,
      nextCursor: page.nextCursor,
      availability,
    });
  }

  async searchThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly query: string;
    readonly cursor?: string | null;
    readonly limit: number;
  }): Promise<MailSearchThreadPage> {
    this.assertAccount(input.accountId);
    return this.cache.searchThreads({
      mailboxId: input.mailboxId,
      query: input.query,
      ...(input.cursor === undefined || input.cursor === null
        ? {}
        : { cursor: input.cursor }),
      limit: input.limit,
    });
  }

  async getThread(input: {
    readonly accountId: string;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null> {
    this.assertAccount(input.accountId);
    return this.cache.getThread(validateProviderId(input.threadId));
  }

  async getMailboxThread(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null> {
    this.assertAccount(input.accountId);
    return this.cache.getMailboxThread({
      mailboxId: input.mailboxId,
      threadId: validateProviderId(input.threadId),
    });
  }

  async sync(
    input: { readonly accountId: string; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailSyncResult> {
    this.assertAccount(input.accountId);
    const maxItems = validateSyncItems(input.maxItems);
    return this.mutate(signal, () => this.syncUnlocked(maxItems, signal));
  }

  async syncAccount(
    accountId: string,
    options: { readonly maxItems: number },
    signal = new AbortController().signal,
  ): Promise<MailSyncResult> {
    this.assertAccount(accountId);
    const maxItems = validateSyncItems(options.maxItems);
    return this.mutate(signal, async () => {
      const inboxResult = await this.syncUnlocked(maxItems, signal);
      if (
        this.hydrateHiddenMailboxes &&
        inboxResult.status === "idle" &&
        !inboxResult.hasMore
      ) {
        await this.hydrateOneHiddenMailbox(signal, MAX_SYNC_ITEMS);
      }
      return inboxResult;
    });
  }

  async runBackgroundSyncStep(
    accountId: string,
    options: { readonly maxItems: number },
    signal = new AbortController().signal,
  ): Promise<MailBackgroundSyncStep> {
    this.assertAccount(accountId);
    const maxItems = validateSyncItems(options.maxItems);
    return this.mutate(signal, async () => {
      const result = await this.syncUnlocked(maxItems, signal);
      const hiddenHasMore =
        this.hydrateHiddenMailboxes &&
        result.status === "idle" &&
        !result.hasMore
          ? await this.hydrateOneHiddenMailbox(signal, maxItems)
          : false;
      return Object.freeze({
        result,
        hasMore: result.hasMore || hiddenHasMore,
      });
    });
  }

  async updateThread(
    input: MailThreadMutationInput & { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<MailThreadMutationResult> {
    const mutation = validateServiceThreadMutation(input);
    this.assertAccount(mutation.accountId);
    const threadId = validateProviderId(mutation.threadId);
    return this.mutate(signal, async () => {
      signal.throwIfAborted();
      await applyThreadMutation(this.provider, threadId, mutation, signal);
      signal.throwIfAborted();
      const refreshed = await this.provider.getThread(threadId, signal);
      if (
        refreshed === null ||
        refreshed.thread.accountId !== mutation.accountId ||
        refreshed.thread.threadId !== threadId
      ) {
        throw new MailProviderSyncError("mail_provider_response_invalid");
      }
      this.cache.replaceActiveThread(refreshed);
      return Object.freeze({ apiVersion: 1, thread: refreshed.thread });
    });
  }

  private async syncUnlocked(
    maxItems: number,
    signal: AbortSignal,
  ): Promise<MailSyncResult> {
    signal.throwIfAborted();
    const attempt = this.cache.beginSyncAttempt(this.now());
    if (!attempt.allowed) {
      return Object.freeze({
        apiVersion: 1,
        status: attempt.status,
        changedCount: 0,
        hasMore: false,
      });
    }
    try {
      const state = this.cache.readSyncState();
      let result: MailSyncResult;
      if (state.activeGeneration === 0 || state.stagedGeneration !== null) {
        result = await this.syncInitial(maxItems, signal);
      } else {
        result = await this.syncIncremental(maxItems, signal, false);
      }
      this.cache.recordSyncSuccess();
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      if (
        error instanceof MailProviderSyncError &&
        error.code === "mail_provider_reauth_required"
      ) {
        this.cache.markReauthRequired(this.reauthErrorCode);
        return Object.freeze({
          apiVersion: 1,
          status: "reauth_required",
          changedCount: 0,
          hasMore: false,
        });
      }
      if (!(error instanceof MailCacheError && error.code === "mail_sync_stale")) {
        this.cache.recordSyncFailure({
          now: this.now(),
          errorCode: stableErrorCode(error),
          retryAfterMs:
            error instanceof MailProviderSyncError ? error.retryAfterMs : null,
        });
      }
      throw error;
    }
  }

  private async syncInitial(
    maxItems: number,
    signal: AbortSignal,
    recoveredCursor = false,
  ): Promise<MailSyncResult> {
    signal.throwIfAborted();
    let state = this.cache.readSyncState();
    let generation = state.stagedGeneration;
    if (generation === null) {
      const anchor = await this.provider.getSyncAnchor(signal);
      signal.throwIfAborted();
      generation = this.cache.beginInitial(anchor);
      state = this.cache.readSyncState();
    } else {
      generation = this.cache.resumeInitial();
      state = this.cache.readSyncState();
    }
    let page: MailProviderInitialPage;
    try {
      page = await this.provider.listInitialThreads(
        { pageToken: state.pageToken, maxItems },
        signal,
      );
    } catch (error) {
      if (
        !recoveredCursor &&
        error instanceof MailProviderSyncError &&
        error.code === "mail_provider_cursor_invalid"
      ) {
        const anchor = await this.provider.getSyncAnchor(signal);
        this.cache.beginInitial(anchor);
        return this.syncInitial(maxItems, signal, true);
      }
      throw error;
    }
    signal.throwIfAborted();
    assertPageBudgets(page.threads);
    this.cache.putInitialPage(
      generation,
      page.threads,
      state.pageToken,
      page.nextPageToken,
    );
    if (page.nextPageToken === null) {
      this.cache.completeInitial(generation, this.now());
    }
    return Object.freeze({
      apiVersion: 1,
      status: page.nextPageToken === null ? "idle" : "syncing",
      changedCount: page.threads.length,
      hasMore: page.nextPageToken !== null,
    });
  }

  private async syncIncremental(
    maxItems: number,
    signal: AbortSignal,
    recoveredCursor: boolean,
  ): Promise<MailSyncResult> {
    const state = this.cache.readSyncState();
    if (state.historyId === null) {
      throw new MailCacheError("mail_cache_invalid");
    }
    let page: MailProviderIncrementalPage;
    try {
      page = await this.provider.listChanges(
        {
          startHistoryId: state.historyId,
          pageToken: state.pageToken,
          maxItems,
        },
        signal,
      );
    } catch (error) {
      if (
        !recoveredCursor &&
        error instanceof MailProviderSyncError &&
        error.code === "mail_provider_cursor_invalid"
      ) {
        const anchor = await this.provider.getSyncAnchor(signal);
        this.cache.beginInitial(anchor);
        return this.syncInitial(maxItems, signal);
      }
      throw error;
    }
    const uniqueThreadIds = [...new Set(page.changedThreadIds.map(validateProviderId))];
    if (uniqueThreadIds.length > MAX_CHANGED_THREADS) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    let fetchedMessages = 0;
    let fetchedTextBytes = 0;
    const changes = await boundedMap(uniqueThreadIds, 2, async (threadId) => {
      signal.throwIfAborted();
      const thread = await this.provider.getThread(threadId, signal);
      if (thread !== null) {
        fetchedMessages += thread.messages.length;
        fetchedTextBytes += cachedThreadTextBytes(thread);
        if (
          fetchedMessages > MAX_CHANGED_MESSAGES ||
          fetchedTextBytes > MAX_SYNC_TEXT_BYTES
        ) {
          throw new MailProviderSyncError("mail_provider_response_invalid");
        }
      }
      return thread === null
        ? Object.freeze({ kind: "delete" as const, threadId })
        : Object.freeze({ kind: "upsert" as const, value: thread });
    });
    assertPageBudgets(
      changes.flatMap((change) => (change.kind === "upsert" ? [change.value] : [])),
    );
    this.cache.applyIncrementalPage({
      expectedHistoryId: state.historyId,
      expectedPageToken: state.pageToken,
      changes,
      nextPageToken: page.nextPageToken,
      resultingHistoryId: page.resultingHistoryId,
      now: this.now(),
    });
    return Object.freeze({
      apiVersion: 1,
      status: page.nextPageToken === null ? "idle" : "syncing",
      changedCount: changes.length,
      hasMore: page.nextPageToken !== null,
    });
  }

  private async hydrateOneHiddenMailbox(
    signal: AbortSignal,
    maxItems: number,
  ): Promise<boolean> {
    let mailboxId: MailCacheHydratableMailbox | null = null;

    try {
      signal.throwIfAborted();
      let states = this.cache.readMailboxHydrationStates();
      const failedProgress = states.find(
        (state) =>
          state.stagedGeneration !== null &&
          (state.status === "backoff" || state.status === "reauth_required"),
      );
      if (failedProgress) {
        this.cache.abandonFailedMailboxHydration(failedProgress.mailboxId);
        states = this.cache.readMailboxHydrationStates();
      }
      const inProgress = states.find((state) => state.stagedGeneration !== null);
      const healthyCandidates = MAIL_CACHE_HYDRATION_ORDER.filter((mailboxId) => {
        const candidate = states.find((state) => state.mailboxId === mailboxId);
        return (
          candidate !== undefined &&
          candidate.status !== "backoff" &&
          candidate.status !== "reauth_required"
        );
      });
      const failedCandidates = MAIL_CACHE_HYDRATION_ORDER.filter(
        (mailboxId) => !healthyCandidates.includes(mailboxId),
      );
      const candidates = inProgress
        ? [inProgress.mailboxId]
        : [...healthyCandidates, ...failedCandidates];
      let state: MailboxHydrationState | null = null;
      for (const candidate of candidates) {
        state = this.cache.beginOrResumeMailboxHydration(candidate);
        if (state !== null) {
          mailboxId = candidate;
          break;
        }
      }
      if (state === null && failedCandidates.length > 0) {
        const retry = this.cache.selectFailedMailboxForRetry(failedCandidates);
        if (retry !== null) {
          this.cache.rearmFailedMailboxHydration(retry);
          state = this.cache.beginOrResumeMailboxHydration(retry);
          if (state !== null) mailboxId = retry;
        }
      }
      if (state === null) return false;
      const generation = state.stagedGeneration;
      if (mailboxId === null || generation === null) {
        throw new MailCacheError("mail_cache_invalid");
      }

      if (state.crawlComplete) {
        if (!this.cache.markPostCrawlHistoryObserved(mailboxId)) {
          this.cache.restartStaleMailboxHydration(mailboxId);
          return true;
        }
        state = this.cache
          .readMailboxHydrationStates()
          .find((candidate) => candidate.mailboxId === mailboxId) ?? null;
        if (
          state === null ||
          state.stagedGeneration !== generation ||
          state.postCrawlHistoryId === null
        ) {
          throw new MailCacheError("mail_sync_stale");
        }
        const pending = this.cache.readPendingThreadRefreshes(maxItems);
        let remaining = pending.length;
        if (pending.length > 0) {
          const changes = await boundedMap(pending, 2, async (refresh) => {
            signal.throwIfAborted();
            const thread = await this.provider.getThread(refresh.threadId, signal);
            return thread === null
              ? Object.freeze({
                  kind: "delete" as const,
                  threadId: refresh.threadId,
                  queuedAt: refresh.queuedAt,
                })
              : Object.freeze({
                  kind: "upsert" as const,
                  value: thread,
                  queuedAt: refresh.queuedAt,
                });
          });
          signal.throwIfAborted();
          assertPageBudgets(
            changes.flatMap((change) =>
              change.kind === "upsert" ? [change.value] : [],
            ),
          );
          remaining = this.cache.applyPendingThreadRefreshes({
            mailboxId,
            generation,
            expectedHistoryId: state.postCrawlHistoryId,
            changes,
          });
        }
        if (remaining === 0) {
          this.cache.completeMailboxHydration({
            mailboxId,
            generation,
            expectedHistoryId: state.postCrawlHistoryId,
            now: this.now(),
          });
          return this.hasPendingHealthyHiddenMailboxWork();
        }
        return true;
      }

      const pageItems =
        mailboxId === "all"
          ? Math.min(
              maxItems,
              MAX_ALL_MAIL_HYDRATION_THREADS - state.listedThreadCount,
            )
          : maxItems;
      if (pageItems < 1) {
        throw new MailCacheError("mail_cache_capacity");
      }
      const page = await this.provider.listMailboxThreads(
        {
          mailboxId,
          pageToken: state.pageToken,
          maxItems: pageItems,
        },
        signal,
      );
      signal.throwIfAborted();
      assertMailboxPage(page, pageItems);
      this.cache.putMailboxHydrationPage({
        mailboxId,
        generation,
        expectedPageToken: state.pageToken,
        threads: page.threads,
        listedCount: page.listedCount,
        nextPageToken: page.nextPageToken,
      });
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      if (mailboxId === null) return false;
      try {
        this.cache.markMailboxHydrationFailure(
          mailboxId,
          stableErrorCode(error),
          error instanceof MailProviderSyncError &&
            error.code === "mail_provider_reauth_required",
        );
        this.cache.abandonFailedMailboxHydration(mailboxId);
      } catch {
        // Hidden hydration is best-effort. Inbox remains the public sync result.
      }
      if (error instanceof MailProviderSyncError) {
        try {
          if (error.code === "mail_provider_reauth_required") {
            this.cache.markReauthRequired(this.reauthErrorCode);
          } else if (
            error.code === "mail_provider_rate_limited" ||
            (error.code === "mail_provider_unavailable" &&
              error.retryAfterMs !== null)
          ) {
            this.cache.recordSyncFailure({
              now: this.now(),
              errorCode: error.code,
              retryAfterMs: error.retryAfterMs,
            });
          }
        } catch {
          // Preserve the already-published Inbox even if health/backoff storage
          // becomes unavailable after the provider failure.
        }
      }
      try {
        return this.hasPendingHealthyHiddenMailboxWork();
      } catch {
        return false;
      }
    }
  }

  private hasPendingHealthyHiddenMailboxWork(): boolean {
    const global = this.cache.readSyncState();
    if (
      global.activeGeneration < 1 ||
      global.stagedGeneration !== null ||
      global.historyId === null ||
      global.status !== "idle"
    ) {
      return false;
    }
    return this.cache.readMailboxHydrationStates().some((state) => {
      if (state.status === "backoff" || state.status === "reauth_required") {
        return false;
      }
      return !(
        state.activeGeneration === global.activeGeneration &&
        state.stagedGeneration === null &&
        state.activeObservedHistoryId === global.historyId &&
        state.status === "idle"
      );
    });
  }

  private assertAccount(value: string): void {
    if (value !== this.accountId) {
      throw new MailCacheError("mail_cache_invalid");
    }
  }

  private async mutate<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    let started = false;
    const execute = async () => {
      started = true;
      signal.throwIfAborted();
      return operation();
    };
    const run = this.mutationTail.then(execute, execute);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        if (!started) finish(() => reject(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  }
}

function assertPageBudgets(threads: readonly CachedProviderThread[]): void {
  if (threads.length > MAX_CHANGED_THREADS) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  const messages = threads.reduce((total, thread) => total + thread.messages.length, 0);
  if (messages > MAX_CHANGED_MESSAGES) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  const textBytes = threads.reduce(
    (total, thread) => total + cachedThreadTextBytes(thread),
    0,
  );
  if (textBytes > MAX_SYNC_TEXT_BYTES) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
}

function assertMailboxPage(
  page: {
    readonly threads: readonly CachedProviderThread[];
    readonly listedCount: number;
  },
  maxItems: number,
): void {
  if (
    !Number.isSafeInteger(page.listedCount) ||
    page.listedCount < 0 ||
    page.listedCount > maxItems ||
    page.threads.length > page.listedCount
  ) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  assertPageBudgets(page.threads);
}

function cachedThreadTextBytes(thread: CachedProviderThread): number {
  return thread.messages.reduce(
    (total, message) =>
      total +
      (message.textBody === null ? 0 : Buffer.byteLength(message.textBody)) +
      (message.htmlBody === null ? 0 : Buffer.byteLength(message.htmlBody)),
    0,
  );
}

function validateServiceThreadMutation(
  value: unknown,
): MailThreadMutationInput & { readonly threadId: string } {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    !keys.includes("accountId") ||
    !keys.includes("threadId")
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  const action = keys.find((key) => key !== "accountId" && key !== "threadId");
  const accountId = record.accountId as string;
  const threadId = record.threadId as string;
  switch (action) {
    case "read":
      if (typeof record.read !== "boolean") break;
      return Object.freeze({ accountId, threadId, read: record.read });
    case "archive":
      if (typeof record.archive !== "boolean") break;
      return Object.freeze({ accountId, threadId, archive: record.archive });
    case "trash":
      if (record.trash !== true) break;
      return Object.freeze({ accountId, threadId, trash: true });
    case "restore":
      if (record.restore !== true) break;
      return Object.freeze({ accountId, threadId, restore: true });
    case "spam":
      if (typeof record.spam !== "boolean") break;
      return Object.freeze({ accountId, threadId, spam: record.spam });
    case "starred":
      if (typeof record.starred !== "boolean") break;
      return Object.freeze({ accountId, threadId, starred: record.starred });
  }
  throw new MailCacheError("mail_cache_invalid");
}

async function applyThreadMutation(
  provider: MailProviderSyncPort,
  threadId: string,
  input: MailThreadMutationInput,
  signal: AbortSignal,
): Promise<void> {
  if ("read" in input) {
    await provider.setThreadRead(threadId, input.read, signal);
    return;
  }
  if ("archive" in input) {
    if (input.archive) await provider.archiveThread(threadId, signal);
    else await provider.unarchiveThread(threadId, signal);
    return;
  }
  if ("trash" in input) {
    await provider.trashThread(threadId, signal);
    return;
  }
  if ("restore" in input) {
    await provider.restoreThread(threadId, signal);
    return;
  }
  if ("spam" in input) {
    await provider.setThreadSpam(threadId, input.spam, signal);
    return;
  }
  await provider.setThreadStarred(threadId, input.starred, signal);
}

function stableErrorCode(error: unknown): string {
  if (error instanceof MailProviderSyncError || error instanceof MailCacheError) {
    return error.code;
  }
  return "mail_provider_unavailable";
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) throw new MailCacheError("mail_cache_invalid");
  return value;
}

function validateProviderId(value: string): string {
  if (!SAFE_PROVIDER_ID.test(value)) throw new MailCacheError("mail_cache_invalid");
  return value;
}

function validateSyncItems(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SYNC_ITEMS) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        result[index] = await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return result;
}
