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
/** Empty Gmail passes in a row before the account rests for the fallback. */
const EMPTY_PASSES_BEFORE_BACKOFF = 3;
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
 * Each account keeps its own due time. A Gmail account is due every
 * `gmailIntervalMs`, because `history.list` against a stored history id is one
 * cheap call, and after three empty passes in a row it rests for the fallback
 * interval until a pass brings a change or the owner asks for the account.
 * Every other account is due every `intervalMs`. The scheduler is one loop, so
 * no account ever has two passes in flight, and a timer pass takes only the
 * accounts that are due. An IMAP account holding IDLE keeps that poll as its
 * recovery, and IDLE's requests for a pass go through the same loop.
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
  private readonly nextEligibleAt = new Map<string, number>();
  private readonly syncBackoffUntil = new Map<string, number>();
  private readonly providers = new Map<string, MailBackgroundSyncProvider | null>();
  private readonly emptyPasses = new Map<string, number>();
  /** Accounts IDLE asked for while a pass was in flight. */
  private readonly requested = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
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
    // Gmail backs off to the fallback, so a Gmail cadence slower than the
    // fallback would turn the backoff into a speed-up.
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
    this.nextEligibleAt.clear();
    this.syncBackoffUntil.clear();
    this.providers.clear();
    this.emptyPasses.clear();
    this.requested.clear();
  }

  /**
   * IDLE saw INBOX change (or restarted): one pass of this account now, or
   * right after the pass in flight. Requests during a pass coalesce into that
   * one follow-up, so an update storm is still one pass at a time.
   */
  requestSync(accountId: string): void {
    if (!this.started) return;
    if (this.inFlight !== null) {
      this.requested.add(accountId);
      return;
    }
    this.nextEligibleAt.delete(accountId);
    void this.runNow();
  }

  /**
   * Coalesced fast-forward for freshly observed work (an owner content demand
   * or a new ready commit): runs a pass over every account now, or schedules
   * one continuation right after the pass that is already in flight.
   */
  kick(): void {
    if (!this.started) return;
    if (this.inFlight !== null) {
      this.kickRequested = true;
      return;
    }
    this.nextEligibleAt.clear();
    void this.runNow();
  }

  /**
   * The owner asked for this account (`POST /v1/sync`, which syncs it on its
   * own). That ends a Gmail backoff: the account is due one Gmail interval
   * from now at the latest. It never brings a pass sooner than that, so a
   * refresh held down cannot run an account faster than its cadence.
   */
  noteDemand(accountId: string): void {
    if (!this.started) return;
    this.emptyPasses.delete(accountId);
    const dueAt = Date.now() + this.cadenceOf(accountId);
    const current = this.nextEligibleAt.get(accountId);
    if (current !== undefined && current > dueAt) {
      this.nextEligibleAt.set(accountId, dueAt);
    }
    if (this.inFlight === null) this.schedule(this.delayUntilNextDue());
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
          this.nextEligibleAt.clear();
          hasContinuation = true;
        }
        if (this.requested.size > 0) {
          for (const accountId of this.requested) {
            this.nextEligibleAt.delete(accountId);
          }
          this.requested.clear();
          hasContinuation = true;
        }
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
    if (this.nextEligibleAt.size === 0) return this.intervalMs;
    const earliest = Math.min(...this.nextEligibleAt.values());
    return Math.max(this.continuationDelayMs, earliest - Date.now());
  }

  private cadenceOf(accountId: string): number {
    return this.providers.get(accountId) === "gmail" &&
      (this.emptyPasses.get(accountId) ?? 0) < EMPTY_PASSES_BEFORE_BACKOFF
      ? this.gmailIntervalMs
      : this.intervalMs;
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
    try {
      accounts = await this.listAccounts();
    } catch {
      this.accountQueue.length = 0;
      this.nextEligibleAt.clear();
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
    // Only the accounts that are due: a Gmail account on its 20 s cadence
    // must not drag every other account along with it.
    for (const accountId of accountIds) {
      if (
        !queued.has(accountId) &&
        (this.nextEligibleAt.get(accountId) ?? 0) <= now
      ) {
        retained.push(accountId);
      }
    }
    this.accountQueue.splice(0, this.accountQueue.length, ...retained);
    for (const state of [this.nextEligibleAt, this.syncBackoffUntil, this.emptyPasses]) {
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
      // The privacy cache runs on every page, whatever the provider said.
      // A provider that is failing or has pages to spare must not starve
      // it: a failure rests the provider for one interval while the cache
      // keeps draining, and a busy provider interleaves with it.
      let syncHasMore = false;
      let syncSucceeded = false;
      if ((this.syncBackoffUntil.get(accountId) ?? 0) <= Date.now()) {
        let changed = false;
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
          // A new generation still being written counts as a change even on
          // a page that happened to carry no thread.
          changed =
            step.result.changedCount > 0 || step.result.status === "syncing";
        } catch {
          if (signal.aborted) return false;
          this.syncBackoffUntil.set(accountId, Date.now() + this.intervalMs);
        }
        this.recordSyncOutcome(accountId, changed);
      }
      if (signal.aborted) return false;
      // Straight after the sync rather than after the cache steps below, so
      // IDLE is back on INBOX while the bodies download. An account whose
      // provider is resting still gets here, which keeps IDLE's own backoff
      // moving without a timer of its own.
      if (!syncHasMore && this.providers.get(accountId) === "imap") {
        this.idle?.afterSync(accountId);
      }
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
      } else {
        this.nextEligibleAt.set(accountId, Date.now() + this.cadenceOf(accountId));
      }
    }
    const hasContinuation = !signal.aborted && this.accountQueue.length > 0;
    return hasContinuation;
  }

  /** A failed pass saw no change either, so it counts toward the backoff. */
  private recordSyncOutcome(accountId: string, changed: boolean): void {
    if (changed) {
      this.emptyPasses.delete(accountId);
      return;
    }
    this.emptyPasses.set(
      accountId,
      Math.min(
        EMPTY_PASSES_BEFORE_BACKOFF,
        (this.emptyPasses.get(accountId) ?? 0) + 1,
      ),
    );
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
