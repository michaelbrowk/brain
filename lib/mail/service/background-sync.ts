import { validateMailSyncResult } from "../message-codec";
import type { MailSyncResult } from "../message-types";
import { MAX_MAIL_ACCOUNTS } from "./account-types";
import type { MailBackgroundSyncStep } from "./message-service";

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CONTINUATION_DELAY_MS = 250;
const DEFAULT_MAX_ITEMS = 5;
const MAX_PROVIDER_PAGES_PER_BURST = 6;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;

export interface MailBackgroundSyncPort {
  listAccountIds(): Promise<readonly string[]>;
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
 * The new-senders screen's step. `syncSucceeded` says whether the account's
 * latest sync reached the provider and came back healthy, this page's own or,
 * on a page with no sync due, the one before it: the archiver and the
 * restores only touch the provider while that holds.
 */
export interface MailBackgroundSenderPort {
  runBackgroundSenderStep(
    accountId: string,
    input: { readonly syncSucceeded: boolean },
    signal: AbortSignal,
  ): Promise<{ readonly hasMore: boolean }>;
}

/**
 * One serialized poller for the isolated service. A failed account never
 * prevents the remaining accounts from syncing, and a slow pass cannot overlap
 * the next one. Provider-specific backoff stays inside the sync service.
 */
export class MailBackgroundSyncScheduler {
  private readonly port: MailBackgroundSyncPort;
  private readonly initialDelayMs: number;
  private readonly intervalMs: number;
  private readonly continuationDelayMs: number;
  private readonly maxItems: number;
  private readonly privacyCache: MailBackgroundPrivacyCachePort | null;
  private readonly searchIndex: MailBackgroundSearchIndexPort | null;
  private readonly senders: MailBackgroundSenderPort | null;
  private readonly accountQueue: string[] = [];
  private readonly nextEligibleAt = new Map<string, number>();
  /** When each account's provider sync is next due; absent means now. */
  private readonly syncDueAt = new Map<string, number>();
  /** Whether each account's last provider sync came back healthy. */
  private readonly syncHealthy = new Map<string, boolean>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private kickRequested = false;

  constructor(
    port: MailBackgroundSyncPort,
    options: {
      readonly initialDelayMs?: number;
      readonly intervalMs?: number;
      readonly continuationDelayMs?: number;
      readonly maxItems?: number;
      readonly privacyCache?: MailBackgroundPrivacyCachePort;
      readonly searchIndex?: MailBackgroundSearchIndexPort;
      readonly senders?: MailBackgroundSenderPort;
    } = {},
  ) {
    this.port = port;
    this.initialDelayMs = validateDelay(
      options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    );
    this.intervalMs = validateDelay(options.intervalMs ?? DEFAULT_INTERVAL_MS);
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
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(this.initialDelayMs);
  }

  async stop(): Promise<void> {
    this.started = false;
    this.kickRequested = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.inFlight?.catch(() => undefined);
    this.accountQueue.length = 0;
    this.nextEligibleAt.clear();
    this.syncDueAt.clear();
    this.syncHealthy.clear();
  }

  /**
   * Coalesced fast-forward for freshly observed work (an owner content demand
   * or a new ready commit): runs a pass now, or schedules one continuation
   * right after the pass that is already in flight.
   */
  kick(): void {
    if (!this.started) return;
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
    let nextDelayMs = this.intervalMs;
    const task = this.runPass(controller.signal)
      .then((hasContinuation) => {
        if (hasContinuation) nextDelayMs = this.continuationDelayMs;
      })
      .finally(() => {
        if (this.controller === controller) this.controller = null;
        if (this.inFlight === task) this.inFlight = null;
        if (this.kickRequested) {
          this.kickRequested = false;
          nextDelayMs = Math.min(nextDelayMs, this.continuationDelayMs);
        }
        if (this.started) this.schedule(nextDelayMs);
      });
    this.inFlight = task;
    return task;
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runPass(signal: AbortSignal): Promise<boolean> {
    let accountIds: readonly string[];
    try {
      accountIds = validateAccountIds(await this.port.listAccountIds());
    } catch {
      this.accountQueue.length = 0;
      this.nextEligibleAt.clear();
      return false;
    }
    if (signal.aborted) return false;
    if (this.accountQueue.length === 0) {
      this.accountQueue.push(...accountIds);
    } else {
      const active = new Set(accountIds);
      const retained = this.accountQueue.filter((accountId) =>
        active.has(accountId),
      );
      const queued = new Set(retained);
      const now = Date.now();
      for (const accountId of accountIds) {
        if (
          !queued.has(accountId) &&
          (this.nextEligibleAt.get(accountId) ?? 0) <= now
        ) {
          retained.push(accountId);
        }
      }
      this.accountQueue.splice(0, this.accountQueue.length, ...retained);
      for (const accountId of this.nextEligibleAt.keys()) {
        if (!active.has(accountId)) {
          this.nextEligibleAt.delete(accountId);
        }
      }
      for (const accountId of this.syncDueAt.keys()) {
        if (!active.has(accountId)) {
          this.syncDueAt.delete(accountId);
          this.syncHealthy.delete(accountId);
        }
      }
    }

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
      //
      // The provider itself is dialed only when this account's sync is due:
      // an interval after its last sync, or at once while it has pages left.
      // A page that exists for the caches alone, a privacy-cache
      // continuation or a kick after a body landed, runs their steps without
      // it. Otherwise draining two hundred bodies would be two hundred
      // history walks for every account. Such a page tells the senders step
      // how the last sync went.
      let syncHasMore = false;
      let syncSucceeded = this.syncHealthy.get(accountId) ?? false;
      if ((this.syncDueAt.get(accountId) ?? 0) <= Date.now()) {
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
          this.syncDueAt.set(
            accountId,
            syncHasMore ? 0 : Date.now() + this.intervalMs,
          );
        } catch {
          if (signal.aborted) return false;
          syncSucceeded = false;
          this.syncDueAt.set(accountId, Date.now() + this.intervalMs);
        }
        this.syncHealthy.set(accountId, syncSucceeded);
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
      } else {
        this.nextEligibleAt.set(accountId, Date.now() + this.intervalMs);
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
