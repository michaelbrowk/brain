import { validateMailSyncResult } from "../message-codec";
import type { MailSyncResult } from "../message-types";
import { MAX_MAIL_ACCOUNTS } from "./account-types";
import type { MailBackgroundSyncStep } from "./message-service";

const DEFAULT_INITIAL_DELAY_MS = 5_000;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_GMAIL_INTERVAL_MS = 20_000;
const DEFAULT_CONTINUATION_DELAY_MS = 250;
const DEFAULT_MAX_ITEMS = 5;
const MAX_PROVIDER_PAGES_PER_BURST = 6;
/**
 * The least time between two passes IDLE asks for on one account. A server
 * that reports an update every time IDLE starts would otherwise cost a login
 * a second; hints inside the window fold into the one pass at its end.
 */
const IDLE_PASS_FLOOR_MS = 5_000;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;

export type MailBackgroundSyncProvider = "gmail" | "imap";

export interface MailBackgroundSyncAccount {
  readonly accountId: string;
  readonly providerKind: MailBackgroundSyncProvider;
}

export interface MailBackgroundSyncPort {
  listAccountIds(): Promise<readonly string[]>;
  /**
   * The same accounts with their provider. A port without it runs every
   * account on the fallback interval, which is what the scheduler did for
   * every account before Gmail had a cadence of its own.
   */
  listSyncAccounts?(): Promise<readonly MailBackgroundSyncAccount[]>;
  runBackgroundSyncStep(
    accountId: string,
    input: { readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailBackgroundSyncStep>;
}

export interface MailBackgroundPrivacyCachePort {
  runBackgroundPrefetchStep(
    accountId: string,
    signal: AbortSignal,
  ): Promise<{ readonly hasMore: boolean }>;
}

export interface MailBackgroundSearchIndexPort {
  runBackgroundSearchIndexStep(
    accountId: string,
    signal: AbortSignal,
  ): Promise<{ readonly hasMore: boolean }>;
}

/**
 * The new-senders screen's step. `syncSucceeded` says whether this page's
 * sync reached the provider and came back healthy: the archiver and the
 * restores only touch the provider after one that did.
 */
export interface MailBackgroundSenderPort {
  runBackgroundSenderStep(
    accountId: string,
    input: { readonly syncSucceeded: boolean },
    signal: AbortSignal,
  ): Promise<{ readonly hasMore: boolean }>;
}

/**
 * IMAP IDLE as the scheduler drives it (`imap-idle.ts`). IDLE asks for passes
 * through `requestSync`; the scheduler tells it when an IMAP account's sync
 * has caught up, which accounts still sync, and when Mail stops or starts.
 */
export interface MailBackgroundIdlePort {
  afterSync(accountId: string): void;
  retain(accountIds: readonly string[]): void;
  start(): void;
  stop(): Promise<void>;
}

/**
 * One serialized poller for the isolated service. A failed account never
 * prevents the remaining accounts from syncing, and a slow pass cannot overlap
 * the next one. Provider-specific backoff stays inside the sync service.
 *
 * The provider is asked only when an account's sync is due: on its cadence,
 * which is `gmailIntervalMs` for Gmail (one `history.list` against a stored
 * history id) and `intervalMs` for everything else; when IDLE asks, at most
 * once every `IDLE_PASS_FLOOR_MS`; or because the previous page said there is
 * more. Everything else that brings the scheduler round (a kick from the
 * content cache, a continuation for the privacy cache, the search index or
 * the senders screen) runs the cache steps and leaves the provider alone, so
 * an owner reading mail and a cohort of bodies downloading cost the provider
 * nothing beyond the cadence. The scheduler is one loop, so no account ever
 * has two passes in flight.
 */
export class MailBackgroundSyncScheduler {
  private readonly port: MailBackgroundSyncPort;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly gmailIntervalMs: number;
  private readonly continuationDelayMs: number;
  private readonly maxItems: number;
  private readonly privacyCache: MailBackgroundPrivacyCachePort | null;
  private readonly searchIndex: MailBackgroundSearchIndexPort | null;
  private readonly senders: MailBackgroundSenderPort | null;
  private readonly idle: MailBackgroundIdlePort | null;
  private readonly accountQueue: string[] = [];
  /** When each account's provider sync is next due; absent means now. */
  private readonly syncDueAt = new Map<string, number>();
  /** Accounts whose last sync page said there is more to fetch. */
  private readonly syncPending = new Set<string>();
  /** Accounts whose due time IDLE brought forward and that have not synced since. */
  private readonly idleRequested = new Set<string>();
  /** When IDLE last had a pass of each account, for the floor. */
  private readonly lastIdlePassAt = new Map<string, number>();
  private readonly providers = new Map<string, MailBackgroundSyncProvider | null>();
  /** Accounts IDLE asked for while a pass was in flight. */
  private readonly requested = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  /** The next pass visits every account for its cache steps. */
  private visitAll = false;
  private kickRequested = false;

  constructor(
    port: MailBackgroundSyncPort,
    options: {
      readonly initialDelayMs?: number;
      readonly intervalMs?: number;
      readonly gmailIntervalMs?: number;
      readonly continuationDelayMs?: number;
      readonly maxItems?: number;
      readonly privacyCache?: MailBackgroundPrivacyCachePort;
      readonly searchIndex?: MailBackgroundSearchIndexPort;
      readonly senders?: MailBackgroundSenderPort;
      readonly idle?: MailBackgroundIdlePort;
    } = {},
  ) {
    this.port = port;
    this.initialDelayMs = validateDelay(
      options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    );
    this.intervalMs = validateDelay(options.intervalMs ?? DEFAULT_INTERVAL_MS);
    // The fallback is the slowest any account syncs, Gmail included.
    this.gmailIntervalMs = validateDelay(
      options.gmailIntervalMs ??
        Math.min(DEFAULT_GMAIL_INTERVAL_MS, this.intervalMs),
    );
    if (this.gmailIntervalMs > this.intervalMs) {
      throw new Error("mail background interval is invalid");
    }
    this.continuationDelayMs = validateDelay(
      options.continuationDelayMs ?? DEFAULT_CONTINUATION_DELAY_MS,
    );
    this.maxItems = validateMaxItems(options.maxItems ?? DEFAULT_MAX_ITEMS);
    if (
      options.privacyCache !== undefined &&
      typeof options.privacyCache.runBackgroundPrefetchStep !== "function"
    ) {
      throw new Error("mail background privacy cache is invalid");
    }
    this.privacyCache = options.privacyCache ?? null;
    if (
      options.searchIndex !== undefined &&
      typeof options.searchIndex.runBackgroundSearchIndexStep !== "function"
    ) {
      throw new Error("mail background search index is invalid");
    }
    this.searchIndex = options.searchIndex ?? null;
    if (
      options.senders !== undefined &&
      typeof options.senders.runBackgroundSenderStep !== "function"
    ) {
      throw new Error("mail background senders step is invalid");
    }
    this.senders = options.senders ?? null;
    this.idle = options.idle ?? null;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.idle?.start();
    this.schedule(this.initialDelayMs);
  }

  /** Pause and shutdown: the pass in flight drains and IDLE closes. */
  async stop(): Promise<void> {
    this.started = false;
    this.kickRequested = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.inFlight?.catch(() => undefined);
    await this.idle?.stop();
    this.accountQueue.length = 0;
    this.syncDueAt.clear();
    this.syncPending.clear();
    this.idleRequested.clear();
    this.lastIdlePassAt.clear();
    this.providers.clear();
    this.requested.clear();
    this.visitAll = false;
  }

  /**
   * IDLE saw INBOX change (or restarted): the account's sync is due now, or
   * at the end of the floor after IDLE's last pass, whichever is later. A
   * request during a pass is applied when that pass settles, so the pass that
   * was already reading the account cannot swallow it.
   */
  requestSync(accountId: string): void {
    if (!this.started) return;
    if (this.inFlight !== null) {
      this.requested.add(accountId);
      return;
    }
    const dueAt = this.bringSyncForward(accountId);
    this.schedule(Math.max(0, dueAt - Date.now()));
  }

  /**
   * Coalesced fast-forward for freshly observed work (an owner content demand
   * or a new ready commit): the cache steps of every account run now, or right
   * after the pass that is already in flight. No provider is asked on its
   * account: that waits for the account's own due time.
   */
  kick(): void {
    if (!this.started) return;
    this.visitAll = true;
    if (this.inFlight !== null) {
      this.kickRequested = true;
      return;
    }
    void this.runNow();
  }

  runNow(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const controller = new AbortController();
    this.controller = controller;
    let hasContinuation = false;
    const task = this.runPass(controller.signal)
      .then((continuation) => {
        hasContinuation = continuation;
      })
      .finally(() => {
        if (this.controller === controller) this.controller = null;
        if (this.inFlight === task) this.inFlight = null;
        if (this.kickRequested) {
          this.kickRequested = false;
          hasContinuation = true;
        }
        for (const accountId of this.requested) {
          this.bringSyncForward(accountId);
        }
        this.requested.clear();
        if (this.started) {
          this.schedule(
            hasContinuation
              ? this.continuationDelayMs
              : this.delayUntilNextDue(),
          );
        }
      });
    this.inFlight = task;
    return task;
  }

  /** The earliest timer wins: a later request never pushes a pass back. */
  private schedule(delayMs: number): void {
    if (!this.started) return;
    const dueAt = Date.now() + delayMs;
    if (this.timer !== null) {
      if (this.timerDueAt <= dueAt) return;
      clearTimeout(this.timer);
    }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, delayMs);
    this.timer.unref?.();
  }

  private delayUntilNextDue(): number {
    if (this.providers.size === 0) return this.intervalMs;
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const accountId of this.providers.keys()) {
      earliest = Math.min(earliest, this.syncDueAt.get(accountId) ?? now);
    }
    return Math.max(this.continuationDelayMs, earliest - now);
  }

  private cadenceOf(accountId: string): number {
    return this.providers.get(accountId) === "gmail"
      ? this.gmailIntervalMs
      : this.intervalMs;
  }

  private isSyncDue(accountId: string, now: number): boolean {
    return (this.syncDueAt.get(accountId) ?? 0) <= now;
  }

  /** Makes the account's sync due for IDLE; answers when it now is. */
  private bringSyncForward(accountId: string): number {
    const now = Date.now();
    const floorAt =
      (this.lastIdlePassAt.get(accountId) ?? Number.NEGATIVE_INFINITY) +
      IDLE_PASS_FLOOR_MS;
    const dueAt = Math.max(now, floorAt);
    const current = this.syncDueAt.get(accountId) ?? now;
    if (current > dueAt) this.syncDueAt.set(accountId, dueAt);
    this.idleRequested.add(accountId);
    return Math.min(current, dueAt);
  }

  private async listAccounts(): Promise<
    readonly {
      readonly accountId: string;
      readonly providerKind: MailBackgroundSyncProvider | null;
    }[]
  > {
    if (this.port.listSyncAccounts !== undefined) {
      return validateSyncAccounts(await this.port.listSyncAccounts());
    }
    return validateAccountIds(await this.port.listAccountIds()).map(
      (accountId) => Object.freeze({ accountId, providerKind: null }),
    );
  }

  private async runPass(signal: AbortSignal): Promise<boolean> {
    let accounts: Awaited<ReturnType<MailBackgroundSyncScheduler["listAccounts"]>>;
    const visitAll = this.visitAll;
    this.visitAll = false;
    try {
      accounts = await this.listAccounts();
    } catch {
      this.accountQueue.length = 0;
      return false;
    }
    if (signal.aborted) return false;
    const accountIds = accounts.map((account) => account.accountId);
    const active = new Set(accountIds);
    this.providers.clear();
    for (const account of accounts) {
      this.providers.set(account.accountId, account.providerKind);
    }
    const retained = this.accountQueue.filter((accountId) =>
      active.has(accountId),
    );
    const queued = new Set(retained);
    const now = Date.now();
    // The accounts whose sync is due, or every account after a kick: a Gmail
    // account on its 20 s cadence must not drag the others along with it.
    for (const accountId of accountIds) {
      if (!queued.has(accountId) && (visitAll || this.isSyncDue(accountId, now))) {
        retained.push(accountId);
      }
    }
    this.accountQueue.splice(0, this.accountQueue.length, ...retained);
    for (const state of [
      this.syncDueAt,
      this.syncPending,
      this.idleRequested,
      this.lastIdlePassAt,
    ]) {
      for (const accountId of state.keys()) {
        if (!active.has(accountId)) state.delete(accountId);
      }
    }
    // An account removed, disconnected or parked for reauth loses its IDLE.
    this.idle?.retain(
      accounts
        .filter((account) => account.providerKind === "imap")
        .map((account) => account.accountId),
    );

    let pages = 0;
    while (
      !signal.aborted &&
      pages < MAX_PROVIDER_PAGES_PER_BURST &&
      this.accountQueue.length > 0
    ) {
      const accountId = this.accountQueue.shift();
      if (accountId === undefined) return false;
      pages += 1;
      // The cache steps run on every visit, whatever the provider said; the
      // provider only when its sync is due or its last page had more. A
      // failure rests the provider for one fallback interval while the cache
      // keeps draining, and a busy provider interleaves with it.
      let syncHasMore = false;
      let syncSucceeded = false;
      if (this.syncPending.has(accountId) || this.isSyncDue(accountId, Date.now())) {
        if (this.idleRequested.delete(accountId)) {
          this.lastIdlePassAt.set(accountId, Date.now());
        }
        let failed = false;
        try {
          const step = validateBackgroundSyncStep(
            await this.port.runBackgroundSyncStep(
              accountId,
              { maxItems: this.maxItems },
              signal,
            ),
          );
          syncHasMore = step.hasMore;
          syncSucceeded =
            step.result.status === "idle" || step.result.status === "syncing";
        } catch {
          if (signal.aborted) return false;
          failed = true;
        }
        if (syncHasMore) {
          this.syncPending.add(accountId);
        } else {
          this.syncPending.delete(accountId);
          this.syncDueAt.set(
            accountId,
            Date.now() + (failed ? this.intervalMs : this.cadenceOf(accountId)),
          );
        }
        if (signal.aborted) return false;
        // Straight after the sync rather than after the cache steps below, so
        // IDLE is back on INBOX while the bodies download. A failed sync gets
        // here too, which keeps IDLE's own backoff moving on the poll.
        if (!syncHasMore && this.providers.get(accountId) === "imap") {
          this.idle?.afterSync(accountId);
        }
      }
      if (signal.aborted) return false;
      let privacyHasMore = false;
      if (this.privacyCache !== null) {
        try {
          privacyHasMore = validateHasMoreStep(
            await this.privacyCache.runBackgroundPrefetchStep(
              accountId,
              signal,
            ),
          ).hasMore;
        } catch {
          if (signal.aborted) return false;
        }
      }
      if (signal.aborted) return false;
      // The search index builds beside the sync, one bounded batch a page,
      // so a new account is searchable in full within minutes instead of
      // after a dozen searches. A failed step is only a slower build: the
      // next pass asks again, and a search still advances it on its own.
      let indexHasMore = false;
      if (this.searchIndex !== null) {
        try {
          indexHasMore = validateHasMoreStep(
            await this.searchIndex.runBackgroundSearchIndexStep(accountId, signal),
          ).hasMore;
        } catch {
          if (signal.aborted) return false;
        }
      }
      if (signal.aborted) return false;
      // Last, so a blocked sender's new letter is archived by the pass that
      // brought it in. A failed step waits for the next pass like the index.
      let sendersHasMore = false;
      if (this.senders !== null) {
        try {
          sendersHasMore = validateHasMoreStep(
            await this.senders.runBackgroundSenderStep(
              accountId,
              { syncSucceeded },
              signal,
            ),
          ).hasMore;
        } catch {
          if (signal.aborted) return false;
        }
      }
      if (signal.aborted) return false;
      if (syncHasMore || privacyHasMore || indexHasMore || sendersHasMore) {
        this.accountQueue.push(accountId);
      }
    }
    const hasContinuation = !signal.aborted && this.accountQueue.length > 0;
    return hasContinuation;
  }
}

function validateHasMoreStep(value: {
  readonly hasMore: boolean;
}): { readonly hasMore: boolean } {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).join(",") !== "hasMore" ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new Error("mail background step is invalid");
  }
  return Object.freeze({ hasMore: value.hasMore });
}

function validateBackgroundSyncStep(
  value: MailBackgroundSyncStep,
): MailBackgroundSyncStep {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.keys(value).sort().join(",") !== "hasMore,result" ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new Error("mail background sync step is invalid");
  }
  const result = validateSyncResult(value.result);
  if (result.hasMore && !value.hasMore) {
    throw new Error("mail background sync continuation is invalid");
  }
  return Object.freeze({ result, hasMore: value.hasMore });
}

function validateSyncResult(value: MailSyncResult): MailSyncResult {
  const result = validateMailSyncResult(value);
  if (result.hasMore !== (result.status === "syncing")) {
    throw new Error("mail background sync result is invalid");
  }
  return result;
}

function validateAccountIds(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_MAIL_ACCOUNTS ||
    value.some((accountId) => typeof accountId !== "string" || !SAFE_ACCOUNT_ID.test(accountId)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("mail background account list is invalid");
  }
  return Object.freeze([...value]);
}

function validateSyncAccounts(
  value: readonly MailBackgroundSyncAccount[],
): readonly MailBackgroundSyncAccount[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (account) =>
        account === null ||
        typeof account !== "object" ||
        Object.keys(account).sort().join(",") !== "accountId,providerKind" ||
        (account.providerKind !== "gmail" && account.providerKind !== "imap"),
    )
  ) {
    throw new Error("mail background account list is invalid");
  }
  validateAccountIds(value.map((account) => account.accountId));
  return Object.freeze(
    value.map((account) =>
      Object.freeze({
        accountId: account.accountId,
        providerKind: account.providerKind,
      }),
    ),
  );
}

function validateDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new Error("mail background interval is invalid");
  }
  return value;
}

function validateMaxItems(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new Error("mail background sync size is invalid");
  }
  return value;
}
