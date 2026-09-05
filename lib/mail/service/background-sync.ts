import { validateMailSyncResult } from "../message-codec";
import type { MailSyncResult } from "../message-types";
import type { MailBackgroundSyncStep } from "./message-service";

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CONTINUATION_DELAY_MS = 250;
const DEFAULT_MAX_ITEMS = 5;
const MAX_ACCOUNTS = 3;
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
  private readonly accountQueue: string[] = [];
  private readonly nextEligibleAt = new Map<string, number>();
  private readonly syncBackoffUntil = new Map<string, number>();
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
    this.syncBackoffUntil.clear();
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
      for (const accountId of this.syncBackoffUntil.keys()) {
        if (!active.has(accountId)) {
          this.syncBackoffUntil.delete(accountId);
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
      let syncHasMore = false;
      if ((this.syncBackoffUntil.get(accountId) ?? 0) <= Date.now()) {
        try {
          syncHasMore = validateBackgroundSyncStep(
            await this.port.runBackgroundSyncStep(
              accountId,
              { maxItems: this.maxItems },
              signal,
            ),
          ).hasMore;
        } catch {
          if (signal.aborted) return false;
          this.syncBackoffUntil.set(accountId, Date.now() + this.intervalMs);
        }
      }
      if (signal.aborted) return false;
      let privacyHasMore = false;
      if (this.privacyCache !== null) {
        try {
          privacyHasMore = validatePrivacyCacheStep(
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
      if (syncHasMore || privacyHasMore) {
        this.accountQueue.push(accountId);
      } else {
        this.nextEligibleAt.set(accountId, Date.now() + this.intervalMs);
      }
    }
    const hasContinuation = !signal.aborted && this.accountQueue.length > 0;
    return hasContinuation;
  }
}

function validatePrivacyCacheStep(value: {
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
    throw new Error("mail background privacy cache step is invalid");
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
    value.length > MAX_ACCOUNTS ||
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
