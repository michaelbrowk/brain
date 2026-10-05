import type {
  MailMailboxThreadPage,
  MailSearchThreadPage,
  MailSyncResult,
  MailSystemMailbox,
  MailThreadBatchInput,
  MailThreadBatchItem,
  MailThreadBatchPress,
  MailThreadBatchResult,
  MailThreadDetail,
  MailThreadListItem,
  MailThreadMutationInput,
  MailThreadMutationResult,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "../message-types";
import { mailThreadHasNewMail } from "../message-types";
import { validateMailThreadBatchInput } from "../message-codec";
import {
  MAIL_CHANGE_ALL_MAILBOXES,
  type MailServiceChange,
  type MailServiceChangeKind,
} from "./change-feed-ring";
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
  /**
   * `reason` names which of several sites raised one code, as a stable code
   * of its own (`[a-z][a-z0-9_]*`). It exists for the log: the message stays
   * the code, and nothing on the wire carries it.
   */
  constructor(
    readonly code: MailProviderSyncErrorCode,
    readonly retryAfterMs: number | null = null,
    readonly reason: string | null = null,
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
  /**
   * A section's Done in as few round trips as the provider allows: archive
   * every thread, and mark read the ones whose `read` is set and that got no
   * new mail. Optional, and partial by design: a thread absent from the answer
   * is one this call did not touch, and the service takes it through the
   * per-thread path in the same request. A refusal that speaks for the whole
   * account (no folder to archive into) throws before anything moves.
   */
  archiveThreads?(
    input: {
      readonly threads: readonly MailProviderBatchThread[];
      /** The cache's sync cursor: where the provider's change log is read
       *  from to learn what reached these threads since the cache saw them. */
      readonly cursor: string | null;
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, MailProviderBatchOutcome>>;
}

/** A thread a batch names, with every message the cache holds for it, or
 *  null when the cache does not hold it or cannot name every message, and
 *  whether it is to be marked read: only one unread when it was pressed. */
export interface MailProviderBatchThread {
  readonly threadId: string;
  readonly messages:
    | readonly { readonly messageId: string; readonly unread: boolean }[]
    | null;
  readonly read: boolean;
}

/**
 * What a provider's batch did to one thread. `done` carries the thread read
 * back from the provider. `applied` says the provider took exactly these
 * cached messages out of the Inbox (and marked them read with `markedRead`)
 * and nothing else is known to have reached the thread, so the cache applies
 * that itself instead of a read per thread. `markedRead` is whether the read
 * flag went on: never on a thread that got new mail.
 */
export type MailProviderBatchOutcome =
  | {
      readonly status: "done";
      readonly thread: CachedProviderThread;
      readonly markedRead: boolean;
    }
  | {
      readonly status: "applied";
      readonly messageIds: readonly string[];
      readonly markedRead: boolean;
    }
  | { readonly status: "stale" }
  | { readonly status: "failed"; readonly error: unknown };

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
  archiveThreads(
    input: MailThreadBatchInput,
    signal: AbortSignal,
  ): Promise<MailThreadBatchResult>;
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
  private readonly onChange: ((change: MailServiceChange) => void) | null;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly accountId: string;
    readonly cache: SqliteMailMessageCache;
    readonly provider: MailProviderSyncPort;
    readonly reauthErrorCode: MailCacheReauthErrorCode;
    readonly hydrateHiddenMailboxes?: boolean;
    readonly now?: () => number;
    /** Told after the cache commits something a listing shows: a published
     *  generation, an incremental page that changed threads, a published
     *  hidden mailbox, a mutation. The change feed is the one listener. */
    readonly onChange?: (change: MailServiceChange) => void;
  }) {
    this.accountId = validateAccountId(options.accountId);
    this.cache = options.cache;
    this.provider = options.provider;
    this.reauthErrorCode = options.reauthErrorCode;
    this.hydrateHiddenMailboxes = options.hydrateHiddenMailboxes ?? true;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? null;
  }

  /** After the commit, never before it, and never at the commit's expense: a
   *  listener that throws has missed one record, and the sync it watched
   *  still answers as it would have. */
  private recordChange(
    kind: MailServiceChangeKind,
    mailboxIds: readonly MailSystemMailbox[],
  ): void {
    if (this.onChange === null) return;
    try {
      this.onChange({ accountId: this.accountId, mailboxIds, kind });
    } catch {
      // The feed is a hint; the next record or the browser's safety net
      // covers the one lost here.
    }
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

  /** One bounded step of the account's search index build; see the cache. */
  async runBackgroundSearchIndexStep(
    accountId: string,
  ): Promise<{ readonly hasMore: boolean }> {
    this.assertAccount(accountId);
    return this.cache.advanceSearchIndexStep();
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
      // A thread action can move a thread in or out of any listing.
      this.recordChange("mutation", MAIL_CHANGE_ALL_MAILBOXES);
      return Object.freeze({ apiVersion: 1, thread: refreshed.thread });
    });
  }

  /**
   * A section's Done for one account: one pass through the mutation gate,
   * the provider's own batch where it has one, the per-thread path for what
   * that leaves, and one change record at the end.
   *
   * Every thread answers for itself. The deadline aborts `signal`, and a
   * thread the run had not reached by then is `failed`, so a batch that got
   * half way says which half instead of failing whole. Only a refusal that
   * speaks for the account, before anything moved, fails the request.
   */
  async archiveThreads(
    input: MailThreadBatchInput,
    signal: AbortSignal,
  ): Promise<MailThreadBatchResult> {
    let batch: MailThreadBatchInput;
    try {
      batch = validateMailThreadBatchInput(input);
    } catch {
      throw new MailCacheError("mail_cache_invalid");
    }
    this.assertAccount(batch.accountId);
    try {
      return await this.mutate(signal, () =>
        this.archiveThreadsUnlocked(batch.threads, batch.read === true, signal),
      );
    } catch (error) {
      // The gate did not open before the deadline: nothing was reached.
      if (signal.aborted && error === signal.reason) {
        return batchResult(
          batch.threads.map(({ threadId }) => failedItem(threadId, NOT_REACHED)),
        );
      }
      throw error;
    }
  }

  /*
    The press is the measure. A thread whose cached copy already has more
    mail, or newer mail, than the press saw is not sent to the provider at
    all: the provider's batch names the messages the cache holds, and a reply
    the background sync cached after the press would be among them, archived
    and marked read before anyone saw it. Such a thread answers `renewed` with
    the cached copy and nothing is done to it. What the provider reads back
    after its archive is held to the same measure, and a thread that got mail
    in the meantime is put back in the Inbox here, in this request, so the
    guarantee does not rest on a take-back a closing page never sends.
  */
  private async archiveThreadsUnlocked(
    presses: readonly MailThreadBatchPress[],
    read: boolean,
    signal: AbortSignal,
  ): Promise<MailThreadBatchResult> {
    const threadIds = presses.map((press) => press.threadId);
    const pressOf = new Map(presses.map((press) => [press.threadId, press]));
    const flag = (threadId: string) => read && pressOf.get(threadId)!.unread;
    const cached = this.cache.readBatchThreads(threadIds);
    const outcomes = new Map<string, MailProviderBatchOutcome>();
    const renewed = new Map<string, MailThreadListItem>();
    for (const press of presses) {
      const row = cached.get(press.threadId);
      if (row !== undefined && mailThreadHasNewMail(press, row.thread)) {
        renewed.set(press.threadId, row.thread);
      }
    }
    const toSend = threadIds.filter((threadId) => !renewed.has(threadId));
    if (this.provider.archiveThreads !== undefined && toSend.length > 0) {
      let handled: ReadonlyMap<string, MailProviderBatchOutcome>;
      try {
        handled = await this.provider.archiveThreads(
          {
            threads: toSend.map((threadId) =>
              Object.freeze({
                threadId,
                messages: cached.get(threadId)?.messages ?? null,
                read: flag(threadId),
              }),
            ),
            cursor: this.cache.readSyncState().historyId,
          },
          signal,
        );
      } catch (error) {
        if (isAccountRefusal(error)) throw error;
        // The provider's batch never got going: a session that did not open,
        // a deadline already spent. The per-thread path would meet the same.
        handled = new Map(
          toSend.map((threadId) => [threadId, { status: "failed", error }] as const),
        );
      }
      for (const [threadId, outcome] of handled) {
        if (toSend.includes(threadId)) outcomes.set(threadId, outcome);
      }
    }
    for (const threadId of toSend) {
      if (outcomes.has(threadId)) continue;
      if (signal.aborted) {
        outcomes.set(threadId, { status: "failed", error: signal.reason });
        continue;
      }
      try {
        outcomes.set(
          threadId,
          await this.archiveOneUnlocked(threadId, flag(threadId), pressOf.get(threadId)!, signal),
        );
      } catch (error) {
        const reachedAny = [...outcomes.values()].some(
          (outcome) => outcome.status === "done" || outcome.status === "applied",
        );
        if (isAccountRefusal(error) && !reachedAny) throw error;
        outcomes.set(
          threadId,
          error instanceof MailProviderSyncError &&
            error.code === "mail_provider_thread_stale"
            ? { status: "stale" }
            : { status: "failed", error },
        );
      }
    }

    // Mail the press did not see reached a thread while it was archived. A
    // thread still in the Inbox (Gmail left the new message there) is answered
    // as it stands; one the archive took out goes back. If going back fails
    // the archive stands, the answer says so, and Brain's take-back is the
    // last word.
    let touched = false;
    for (const threadId of toSend) {
      const outcome = outcomes.get(threadId);
      if (
        outcome?.status !== "done" ||
        !mailThreadHasNewMail(pressOf.get(threadId)!, outcome.thread.thread)
      ) {
        continue;
      }
      touched = true;
      if (outcome.thread.inInbox) {
        renewed.set(threadId, outcome.thread.thread);
        this.cacheWrite(outcome.thread);
        outcomes.delete(threadId);
        continue;
      }
      if (signal.aborted) continue;
      try {
        // The reply first: it is the one a reader would miss.
        if (outcome.markedRead) await this.provider.setThreadRead(threadId, false, signal);
        await this.provider.unarchiveThread(threadId, signal);
        const back = await this.provider.getThread(threadId, signal);
        if (back === null || back.thread.threadId !== threadId) continue;
        renewed.set(threadId, back.thread);
        this.cacheWrite(back);
        outcomes.delete(threadId);
      } catch {
        // Answered `done` below with the new mail in it.
      }
    }

    const applied = threadIds.flatMap((threadId) => {
      const outcome = outcomes.get(threadId);
      return outcome?.status === "applied"
        ? [{ threadId, messageIds: outcome.messageIds, read: outcome.markedRead }]
        : [];
    });
    let written: ReadonlyMap<string, MailThreadListItem> = new Map();
    try {
      if (applied.length > 0) written = this.cache.applyBatchArchive(applied);
    } catch {
      // The provider has the archive either way. The answer below is worked
      // out from the cached rows, and the next sync pass repairs the cache.
    }
    let changed = touched;
    const results = threadIds.map((threadId): MailThreadBatchItem => {
      const kept = renewed.get(threadId);
      if (kept !== undefined) return Object.freeze({ threadId, status: "renewed", thread: kept });
      const outcome = outcomes.get(threadId)!;
      if (outcome.status === "stale") return Object.freeze({ threadId, status: "stale" });
      if (outcome.status === "failed") return failedItem(threadId, batchErrorCode(outcome.error));
      changed = true;
      if (outcome.status === "done") {
        this.cacheWrite(outcome.thread);
        return Object.freeze({
          threadId,
          status: "done",
          thread: outcome.thread.thread,
          markedRead: outcome.markedRead,
        });
      }
      const before = cached.get(threadId)!.thread;
      return Object.freeze({
        threadId,
        status: "done",
        thread:
          written.get(threadId) ??
          Object.freeze({ ...before, unread: outcome.markedRead ? false : before.unread }),
        markedRead: outcome.markedRead,
      });
    });
    // A thread action can move a thread in or out of any listing.
    if (changed) this.recordChange("mutation", MAIL_CHANGE_ALL_MAILBOXES);
    return batchResult(results);
  }

  /**
   * One thread of a batch the provider's own batch did not take: the archive,
   * a read back, and the read flag only on a thread the read back shows no
   * new mail on, compared with what the cache held at the press. The flag
   * failing does not undo an archive that landed.
   */
  private async archiveOneUnlocked(
    threadId: string,
    read: boolean,
    before: MailThreadBatchPress,
    signal: AbortSignal,
  ): Promise<MailProviderBatchOutcome> {
    const readBack = async (): Promise<CachedProviderThread | null> => {
      const thread = await this.provider.getThread(threadId, signal);
      if (
        thread !== null &&
        (thread.thread.accountId !== this.accountId || thread.thread.threadId !== threadId)
      ) {
        throw new MailProviderSyncError("mail_provider_response_invalid");
      }
      return thread;
    };
    await this.provider.archiveThread(threadId, signal);
    const archived = await readBack();
    if (archived === null) return { status: "stale" };
    if (!read || !archived.thread.unread || mailThreadHasNewMail(before, archived.thread)) {
      return { status: "done", thread: archived, markedRead: false };
    }
    try {
      await this.provider.setThreadRead(threadId, true, signal);
    } catch {
      return { status: "done", thread: archived, markedRead: false };
    }
    let after: CachedProviderThread | null = null;
    try {
      after = await readBack();
    } catch {
      // The flag is on; the thread as the archive left it still answers.
    }
    return { status: "done", thread: after ?? archived, markedRead: true };
  }

  /** The provider has the change either way; a row the cache will not take
   *  now is repaired by the next sync pass. */
  private cacheWrite(thread: CachedProviderThread): void {
    try {
      this.cache.replaceActiveThread(thread);
    } catch {
      // See above.
    }
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
      // Only the completed generation is listed; its staged pages were not.
      this.recordChange("sync", MAIL_CHANGE_ALL_MAILBOXES);
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
    // A changed thread may have moved between any of the listings, so each
    // one is named rather than guessed from the provider's labels.
    if (changes.length > 0) this.recordChange("sync", MAIL_CHANGE_ALL_MAILBOXES);
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
          this.recordChange("sync", [mailboxId]);
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

/** The code a batch thread the deadline left unreached answers with. */
const NOT_REACHED = "request_deadline_exceeded";

/** A refusal that holds for every thread on the account: the server has no
 *  folder for an archive, or will not move mail at all. */
function isAccountRefusal(error: unknown): boolean {
  return (
    error instanceof MailProviderSyncError &&
    error.code === "mail_provider_mutation_unsupported"
  );
}

function failedItem(threadId: string, errorCode: string): MailThreadBatchItem {
  return Object.freeze({ threadId, status: "failed", errorCode });
}

function batchResult(results: readonly MailThreadBatchItem[]): MailThreadBatchResult {
  return Object.freeze({ apiVersion: 1, results: Object.freeze([...results]) });
}

/** The public code of one thread's failure: the codes a single mutation's
 *  error body would carry, so a client reads both the same way. */
function batchErrorCode(error: unknown): string {
  if (error instanceof MailProviderSyncError) {
    switch (error.code) {
      case "mail_provider_reauth_required":
        return "mail_account_reauth_required";
      case "mail_provider_rate_limited":
        return "mail_sync_rate_limited";
      case "mail_provider_mutation_unsupported":
        return "mail_thread_mutation_unsupported";
      default:
        return "mail_sync_unavailable";
    }
  }
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return NOT_REACHED;
  }
  return "mail_sync_unavailable";
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
