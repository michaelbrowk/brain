import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailSyncResult } from "../message-types";
import { MailBackgroundSyncScheduler } from "./background-sync";
import type { MailBackgroundSyncStep } from "./message-service";

const accountA = "account-a11111111111111111111111111111111";
const accountB = "account-a22222222222222222222222222222222";
const accountC = "account-a33333333333333333333333333333333";

afterEach(() => {
  vi.useRealTimers();
});

describe("Mail background sync scheduler", () => {
  it("serializes accounts and never overlaps slow passes", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          if (accountId === accountA) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 20, maxItems: 20 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([accountA]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([accountA]);
    release?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([accountA, accountB]);
    await scheduler.stop();
  });

  it("fast-forwards a kicked pass and coalesces kicks during a running pass", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let blockNext = false;
    let release: (() => void) | undefined;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          calls += 1;
          if (blockNext) {
            blockNext = false;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, continuationDelayMs: 25 },
    );

    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(0);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);

    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);

    blockNext = true;
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3);
    scheduler.kick();
    release?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(24);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(4);
    await scheduler.stop();
  });

  it("continues after one account fails and aborts a running pass on stop", async () => {
    const calls: string[] = [];
    let observedAbort = false;
    const scheduler = new MailBackgroundSyncScheduler({
      listAccountIds: async () => [accountA, accountB],
      runBackgroundSyncStep: async (accountId, _input, signal) => {
        calls.push(accountId);
        if (accountId === accountA) throw new Error("provider unavailable");
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        return syncResult(false);
      },
    });

    const pass = scheduler.runNow();
    await vi.waitFor(() => expect(calls).toEqual([accountA, accountB]));
    await scheduler.stop();
    await pass;
    expect(observedAbort).toBe(true);
  });

  it("drains provider pages round-robin in bounded six-page bursts", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let listCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => {
          listCalls += 1;
          return [accountA, accountB, accountC];
        },
        runBackgroundSyncStep: async (accountId, input) => {
          calls.push(accountId);
          expect(input).toEqual({ maxItems: 5 });
          return syncResult(true, false);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([
      accountA,
      accountB,
      accountC,
      accountA,
      accountB,
      accountC,
    ]);
    expect(listCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(24);
    expect(calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.slice(6)).toEqual([
      accountA,
      accountB,
      accountC,
      accountA,
      accountB,
      accountC,
    ]);
    expect(listCalls).toBe(2);
    await scheduler.stop();
  });

  it("keeps a busy Gmail history page on the fast continuation queue", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async (_accountId, input) => {
          calls += 1;
          expect(input).toEqual({ maxItems: 5 });
          return syncResult(true, true, 6);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(6);
    await vi.advanceTimersByTimeAsync(24);
    expect(calls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(12);
    await scheduler.stop();
  });

  it("drains privacy-cache items in bounded continuation bursts", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    let privacyCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          return syncResult(false);
        },
      },
      {
        privacyCache: {
          async runBackgroundPrefetchStep(accountId, signal) {
            expect(accountId).toBe(accountA);
            expect(signal.aborted).toBe(false);
            privacyCalls += 1;
            return { hasMore: privacyCalls < 7 };
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(providerCalls).toBe(6);
    expect(privacyCalls).toBe(6);
    await vi.advanceTimersByTimeAsync(24);
    expect(providerCalls).toBe(6);
    expect(privacyCalls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerCalls).toBe(7);
    expect(privacyCalls).toBe(7);
    await vi.advanceTimersByTimeAsync(999);
    expect(providerCalls).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerCalls).toBe(8);
    await scheduler.stop();
  });

  it("runs the privacy-cache step on every page, not only after the last one", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    let privacyCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          return syncResult(true);
        },
      },
      {
        privacyCache: {
          async runBackgroundPrefetchStep() {
            privacyCalls += 1;
            return { hasMore: false };
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(providerCalls).toBe(6);
    expect(privacyCalls).toBe(6);
    await scheduler.stop();
  });

  it("keeps draining the privacy cache while the provider is failing", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    let privacyCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          throw new Error("provider unavailable");
        },
      },
      {
        privacyCache: {
          async runBackgroundPrefetchStep() {
            privacyCalls += 1;
            return { hasMore: privacyCalls % 3 !== 0 };
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    // The failing provider rests for the interval; the cache keeps draining
    // in the same pass without dialing the provider again.
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(providerCalls).toBe(1);
    expect(privacyCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(999);
    expect(providerCalls).toBe(1);
    expect(privacyCalls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerCalls).toBe(2);
    expect(privacyCalls).toBe(6);
    await scheduler.stop();
  });

  it("round-robins privacy-cache work across accounts", async () => {
    vi.useFakeTimers();
    const privacyCalls: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB, accountC],
        runBackgroundSyncStep: async () => syncResult(false),
      },
      {
        privacyCache: {
          async runBackgroundPrefetchStep(accountId) {
            privacyCalls.push(accountId);
            return { hasMore: true };
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(privacyCalls).toEqual([
      accountA,
      accountB,
      accountC,
      accountA,
      accountB,
      accountC,
    ]);
    await scheduler.stop();
  });

  it("reconciles added and removed accounts between continuation bursts", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let accounts: readonly string[] = [accountA];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => accounts,
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return syncResult(accountId !== accountB);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(Array(6).fill(accountA));
    accounts = [accountB];
    await vi.advanceTimersByTimeAsync(25);
    expect(calls.at(-1)).toBe(accountB);
    expect(calls.filter((accountId) => accountId === accountA)).toHaveLength(6);
    await scheduler.stop();
  });

  it("re-polls a completed account while another account has endless pages", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return syncResult(accountId === accountA);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 100,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls.filter((accountId) => accountId === accountB)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls.filter((accountId) => accountId === accountB)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter((accountId) => accountId === accountB)).toHaveLength(2);
    await scheduler.stop();
  });

  it("keeps only unfinished accounts in the continuation queue", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const remaining = new Map([
      [accountA, 7],
      [accountB, 1],
      [accountC, 1],
    ]);
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB, accountC],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          const pages = remaining.get(accountId) ?? 0;
          remaining.set(accountId, Math.max(0, pages - 1));
          return syncResult(pages > 1);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([
      accountA,
      accountB,
      accountC,
      accountA,
      accountA,
      accountA,
    ]);
    await vi.advanceTimersByTimeAsync(25);
    expect(calls.slice(6)).toEqual([accountA, accountA, accountA]);
    await scheduler.stop();
  });

  it("uses the regular interval once every queued account is drained", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return syncResult(false);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 100,
        continuationDelayMs: 5,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([accountA, accountB]);
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([accountA, accountB, accountA, accountB]);
    await scheduler.stop();
  });

  it("fails closed on invalid account lists and invalid sync results", async () => {
    const calls: string[] = [];
    const invalidList = new MailBackgroundSyncScheduler({
      listAccountIds: async () => [accountA, accountB, accountC, accountA],
      runBackgroundSyncStep: async (accountId) => {
        calls.push(accountId);
        return syncResult(false);
      },
    });
    await invalidList.runNow();
    expect(calls).toEqual([]);

    const invalidResult = new MailBackgroundSyncScheduler({
      listAccountIds: async () => [accountA, accountB],
      runBackgroundSyncStep: async (accountId) => {
        calls.push(accountId);
        if (accountId === accountA) {
          return {
            result: {
              apiVersion: 1,
              status: "idle",
              changedCount: 0,
              hasMore: true,
            } as MailSyncResult,
            hasMore: true,
          } as MailBackgroundSyncStep;
        }
        return syncResult(false);
      },
    });
    await invalidResult.runNow();
    expect(calls).toEqual([accountA, accountB]);
  });

  it("does not schedule another burst after stop aborts in-flight work", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let listCalls = 0;
    const started = deferred<void>();
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => {
          listCalls += 1;
          return [accountA];
        },
        runBackgroundSyncStep: async (accountId, _input, signal) => {
          calls.push(accountId);
          started.resolve();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return syncResult(true);
        },
      },
      { initialDelayMs: 10, intervalMs: 20, continuationDelayMs: 5 },
    );

    scheduler.start();
    const running = vi.advanceTimersByTimeAsync(10);
    await started.promise;
    await scheduler.stop();
    await running;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual([accountA]);
    expect(listCalls).toBe(1);
  });
});

function syncResult(
  hasMore: boolean,
  resultHasMore = hasMore,
  changedCount = resultHasMore ? 1 : 0,
): MailBackgroundSyncStep {
  return Object.freeze({
    result: Object.freeze({
      apiVersion: 1,
      status: resultHasMore ? "syncing" : "idle",
      changedCount,
      hasMore: resultHasMore,
    }),
    hasMore,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
