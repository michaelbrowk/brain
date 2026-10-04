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
    let visits = 0;
    let providerCalls = 0;
    let blockNext = false;
    let release: (() => void) | undefined;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          return syncResult(false);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        continuationDelayMs: 25,
        privacyCache: {
          async runBackgroundPrefetchStep() {
            visits += 1;
            if (blockNext) {
              blockNext = false;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
            return { hasMore: false };
          },
        },
      },
    );

    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(visits).toBe(0);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(visits).toBe(1);

    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(visits).toBe(2);

    blockNext = true;
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(visits).toBe(3);
    scheduler.kick();
    release?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(24);
    expect(visits).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(visits).toBe(4);
    // Four visits for the cache, one call to the provider: kicks never ask it.
    expect(providerCalls).toBe(1);
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
    // Six cache visits in the burst, and the provider only on the first:
    // its sync was due once and said there was nothing more.
    expect(providerCalls).toBe(1);
    expect(privacyCalls).toBe(6);
    await vi.advanceTimersByTimeAsync(24);
    expect(privacyCalls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerCalls).toBe(1);
    expect(privacyCalls).toBe(7);
    // The next provider call is one interval after the last one.
    await vi.advanceTimersByTimeAsync(974);
    expect(providerCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerCalls).toBe(2);
    await scheduler.stop();
  });

  it("builds each account's search index beside its sync, until the index is done", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    let indexCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          return syncResult(false);
        },
      },
      {
        searchIndex: {
          async runBackgroundSearchIndexStep(accountId, signal) {
            expect(accountId).toBe(accountA);
            expect(signal.aborted).toBe(false);
            indexCalls += 1;
            return { hasMore: indexCalls < 3 };
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    // The index keeps the account queued, so the burst visits it three times
    // and then the account rests for an interval like any finished one. The
    // provider is asked on the first visit only.
    expect(indexCalls).toBe(3);
    expect(providerCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(indexCalls).toBe(3);
    await scheduler.stop();
  });

  it("keeps syncing when a search-index step fails", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          return syncResult(false);
        },
      },
      {
        searchIndex: {
          async runBackgroundSearchIndexStep() {
            throw new Error("index unavailable");
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(providerCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(providerCalls).toBe(2);
    await scheduler.stop();
  });

  it("runs the senders step after each sync and says whether the sync reached the provider", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    const senderSteps: Array<{ accountId: string; syncSucceeded: boolean }> = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          if (providerCalls === 2) throw new Error("provider unavailable");
          if (providerCalls === 3) {
            return Object.freeze({
              result: Object.freeze({
                apiVersion: 1 as const,
                status: "backoff" as const,
                changedCount: 0,
                hasMore: false,
              }),
              hasMore: false,
            });
          }
          return syncResult(false);
        },
      },
      {
        senders: {
          async runBackgroundSenderStep(accountId, input, signal) {
            expect(signal.aborted).toBe(false);
            senderSteps.push({ accountId, syncSucceeded: input.syncSucceeded });
            // The backfill keeps the account queued for one more page.
            return { hasMore: senderSteps.length === 1 };
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    // The first sync succeeds and the backfill asks for more, so the burst
    // visits the account again. That visit does not ask the provider, whose
    // sync is not due, and carries the last sync's verdict: healthy.
    expect(senderSteps).toEqual([
      { accountId: accountA, syncSucceeded: true },
      { accountId: accountA, syncSucceeded: true },
    ]);
    expect(providerCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    // A sync that failed did not reach the provider healthy.
    expect(providerCalls).toBe(2);
    expect(senderSteps.at(-1)).toEqual({ accountId: accountA, syncSucceeded: false });
    await vi.advanceTimersByTimeAsync(1_000);
    // Nor did one the cache refused for backoff.
    expect(providerCalls).toBe(3);
    expect(senderSteps.at(-1)).toEqual({ accountId: accountA, syncSucceeded: false });
    // And a visit before the next sync carries that verdict too.
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(providerCalls).toBe(3);
    expect(senderSteps.at(-1)).toEqual({ accountId: accountA, syncSucceeded: false });
    await scheduler.stop();
  });

  it("keeps syncing when a senders step fails", async () => {
    vi.useFakeTimers();
    let providerCalls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          return syncResult(false);
        },
      },
      {
        senders: {
          async runBackgroundSenderStep() {
            throw new Error("senders unavailable");
          },
        },
        initialDelayMs: 10,
        intervalMs: 1_000,
        continuationDelayMs: 25,
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(providerCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(providerCalls).toBe(2);
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

describe("per-provider sync cadence", () => {
  it("runs Gmail accounts on their own cadence and every other account on the fallback", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: Array<{ accountId: string; at: number }> = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "gmail" },
          { accountId: accountB, providerKind: "imap" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          calls.push({ accountId, at: Date.now() });
          return changed();
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(120_010);
    expect(timesOf(calls, accountA)).toEqual([
      10, 20_010, 40_010, 60_010, 80_010, 100_010, 120_010,
    ]);
    expect(timesOf(calls, accountB)).toEqual([10, 60_010, 120_010]);
    await scheduler.stop();
  });

  it("keeps a quiet Gmail account on its cadence, so a letter is found within one interval", async () => {
    vi.useFakeTimers({ now: 0 });
    const letters = [300_000, 720_000, 1_380_000, 1_860_000, 2_820_000, 3_300_000];
    const latencies: number[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "gmail" }],
        runBackgroundSyncStep: async () => {
          const at = letters[0];
          if (at !== undefined && at <= Date.now()) {
            letters.shift();
            latencies.push(Date.now() - at);
            return changed();
          }
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    // An hour of nothing between letters does not slow the account down.
    expect(latencies).toHaveLength(6);
    expect(Math.max(...latencies)).toBeLessThanOrEqual(20_000);
    await scheduler.stop();
  });

  it("never calls the provider for the cache's continuation visits", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    let indexSteps = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "gmail" }],
        runBackgroundSyncStep: async () => {
          calls.push(Date.now());
          return syncResult(false);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        gmailIntervalMs: 20_000,
        continuationDelayMs: 25,
        searchIndex: {
          async runBackgroundSearchIndexStep() {
            indexSteps += 1;
            return { hasMore: indexSteps < 4_000 };
          },
        },
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60_010);
    // The index took thousands of visits; the provider was asked on its
    // cadence and no more.
    expect(indexSteps).toBeGreaterThan(1_000);
    expect(calls).toEqual([10, 20_010, 40_010, 60_010]);
    await scheduler.stop();
  });

  it("fast-forwards a kick through the cache steps without calling the provider", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: string[] = [];
    const prefetches: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "gmail" },
          { accountId: accountB, providerKind: "imap" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return syncResult(false);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        gmailIntervalMs: 20_000,
        privacyCache: {
          async runBackgroundPrefetchStep(accountId) {
            prefetches.push(accountId);
            return { hasMore: false };
          },
        },
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([accountA, accountB]);
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    // Both accounts' cache steps ran at once; neither provider was asked.
    expect(prefetches).toEqual([accountA, accountB, accountA, accountB]);
    expect(calls).toEqual([accountA, accountB]);
    // And the cadence is where it was: Gmail at 20 010, not 5 010 + 20 000.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toEqual([accountA, accountB, accountA]);
    await scheduler.stop();
  });

  it("holds one provider call per account per cadence window through hours of opens and a 200-body drain", async () => {
    vi.useFakeTimers({ now: 0 });
    const gmail = [accountA, accountB, accountC];
    const imap = "account-a44444444444444444444444444444444";
    const calls: Array<{ accountId: string; at: number }> = [];
    const bodies = new Map<string, number>();
    const scheduler: MailBackgroundSyncScheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [...gmail, imap],
        listSyncAccounts: async () => [
          ...gmail.map((accountId) => ({ accountId, providerKind: "gmail" as const })),
          { accountId: imap, providerKind: "imap" as const },
        ],
        runBackgroundSyncStep: async (accountId) => {
          calls.push({ accountId, at: Date.now() });
          await new Promise((resolve) => setTimeout(resolve, 200));
          return changed();
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        gmailIntervalMs: 20_000,
        privacyCache: {
          // From ten minutes in, two accounts each fetch a 200-body cohort,
          // one body a visit, and every committed body kicks the scheduler,
          // as the content coordinator does.
          async runBackgroundPrefetchStep(accountId) {
            if (Date.now() < 600_000 || (accountId !== imap && accountId !== accountA)) {
              return { hasMore: false };
            }
            const done = bodies.get(accountId) ?? 0;
            if (done >= 200) return { hasMore: false };
            await new Promise((resolve) => setTimeout(resolve, 300));
            bodies.set(accountId, done + 1);
            scheduler.kick();
            return { hasMore: true };
          },
        },
      },
    );

    scheduler.start();
    // Two hours of reading: a message opened every 15 s, which kicks once
    // for the demand and once more when its body is committed.
    for (let t = 0; t < 2 * 3_600_000; t += 15_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      scheduler.kick();
      await vi.advanceTimersByTimeAsync(1_500);
      scheduler.kick();
      await vi.advanceTimersByTimeAsync(8_500);
    }
    expect(bodies.get(imap)).toBe(200);
    expect(bodies.get(accountA)).toBe(200);
    for (const accountId of gmail) {
      const times = timesOf(calls, accountId);
      expect(Math.min(...gaps(times))).toBeGreaterThanOrEqual(20_000);
      // 180 an hour is the cadence; the 200 ms a call takes is the slack.
      expect(times.length).toBeLessThanOrEqual(361);
      expect(times.length).toBeGreaterThanOrEqual(340);
    }
    const imapTimes = timesOf(calls, imap);
    expect(Math.min(...gaps(imapTimes))).toBeGreaterThanOrEqual(60_000);
    expect(imapTimes.length).toBeLessThanOrEqual(121);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
  });

  it("refuses a Gmail cadence slower than the fallback", () => {
    expect(
      () =>
        new MailBackgroundSyncScheduler(
          { listAccountIds: async () => [], runBackgroundSyncStep: async () => changed() },
          { intervalMs: 60_000, gmailIntervalMs: 90_000 },
        ),
    ).toThrow();
  });

  it("fails closed on an account list whose providers are unknown or duplicated", async () => {
    const calls: string[] = [];
    for (const accounts of [
      [{ accountId: accountA, providerKind: "pop3" }],
      [
        { accountId: accountA, providerKind: "gmail" },
        { accountId: accountA, providerKind: "imap" },
      ],
    ]) {
      const scheduler = new MailBackgroundSyncScheduler({
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () =>
          accounts as unknown as readonly { accountId: string; providerKind: "gmail" }[],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return changed();
        },
      });
      await scheduler.runNow();
    }
    expect(calls).toEqual([]);
  });
});

describe("IMAP IDLE in the scheduler", () => {
  function idlePort(log: string[] = []) {
    return {
      afterSync: vi.fn((accountId: string) => {
        log.push(`idle ${accountId}`);
      }),
      retain: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
  }

  it("hands an IMAP account to IDLE once its sync has caught up, and never a Gmail one", async () => {
    vi.useFakeTimers({ now: 0 });
    const log: string[] = [];
    const idle = idlePort(log);
    let imapPages = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "gmail" },
          { accountId: accountB, providerKind: "imap" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          if (accountId === accountA) return changed();
          imapPages += 1;
          log.push(`page ${imapPages}`);
          return imapPages === 1 ? syncResult(true) : changed();
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000, idle },
    );

    scheduler.start();
    expect(idle.start).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10);
    // The first page still had more to come; IDLE waits for the second.
    expect(log).toEqual(["page 1", "page 2", `idle ${accountB}`]);
    expect(idle.retain).toHaveBeenLastCalledWith([accountB]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(idle.afterSync.mock.calls.map(([accountId]) => accountId)).toEqual([
      accountB,
      accountB,
    ]);
    await scheduler.stop();
  });

  it("runs the account IDLE asks for at once, without the accounts that are not due", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: Array<{ accountId: string; at: number }> = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "imap" },
          { accountId: accountB, providerKind: "imap" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          calls.push({ accountId, at: Date.now() });
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, idle: idlePort() },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.requestSync(accountB);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([
      { accountId: accountA, at: 10 },
      { accountId: accountB, at: 10 },
      { accountId: accountB, at: 5_000 },
    ]);
    // The poll underneath carries on: B's next pass is a fallback interval
    // after the one IDLE asked for, A's after its own.
    await vi.advanceTimersByTimeAsync(60_010);
    expect(timesOf(calls, accountA)).toEqual([10, 60_010]);
    expect(timesOf(calls, accountB)).toEqual([10, 5_000, 65_000]);
    await scheduler.stop();
  });

  it("keeps one pass per account in flight however often IDLE asks during it", async () => {
    vi.useFakeTimers({ now: 0 });
    let inFlight = 0;
    let most = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "imap" }],
        runBackgroundSyncStep: async () => {
          calls += 1;
          inFlight += 1;
          most = Math.max(most, inFlight);
          if (calls === 2) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          inFlight -= 1;
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, continuationDelayMs: 25, idle: idlePort() },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    scheduler.requestSync(accountA);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    for (let request = 0; request < 50; request += 1) scheduler.requestSync(accountA);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    release?.();
    // Fifty requests during the pass are one pass after it, five seconds
    // after the IDLE pass before it.
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(3);
    expect(most).toBe(1);
    await scheduler.stop();
  });

  it("holds IDLE-requested passes five seconds apart and folds the hints between into one", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    let echo = false;
    const scheduler: MailBackgroundSyncScheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "imap" }],
        runBackgroundSyncStep: async () => {
          calls.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 300));
          // A server that reports an update the moment IDLE starts again.
          if (echo) setTimeout(() => scheduler.requestSync(accountA), 20);
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, idle: idlePort() },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([10]);
    scheduler.requestSync(accountA);
    await vi.advanceTimersByTimeAsync(1_000);
    for (const at of [21_000, 22_000, 24_000]) {
      await vi.advanceTimersByTimeAsync(at - Date.now());
      scheduler.requestSync(accountA);
    }
    await vi.advanceTimersByTimeAsync(31_000 - Date.now());
    scheduler.requestSync(accountA);
    await vi.advanceTimersByTimeAsync(0);
    // One pass for the first hint, one at the end of its window for the
    // three inside it, and the next hint after the window at once.
    expect(calls).toEqual([10, 20_000, 25_000, 31_000]);

    echo = true;
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    // A pass every five seconds at most, however eager the server.
    expect(calls.length - before).toBeGreaterThanOrEqual(11);
    expect(calls.length - before).toBeLessThanOrEqual(13);
    expect(Math.min(...gaps(calls.slice(1)))).toBeGreaterThanOrEqual(5_000);
    // The step in flight waits on a fake timer, so the stop is advanced too.
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
  });

  it("stops IDLE with the scheduler, ignores it while stopped, and starts it again", async () => {
    vi.useFakeTimers({ now: 0 });
    const idle = idlePort();
    let calls = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "imap" }],
        runBackgroundSyncStep: async () => {
          calls += 1;
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, idle },
    );

    scheduler.requestSync(accountA);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(0);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    await scheduler.stop();
    expect(idle.stop).toHaveBeenCalledOnce();
    scheduler.requestSync(accountA);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(1);
    scheduler.start();
    expect(idle.start).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});

describe("the scheduler never stalls", () => {
  const imap = "account-a44444444444444444444444444444444";

  it("keeps its own clock when the wall clock jumps back an hour", async () => {
    vi.useFakeTimers({ now: 10_000_000 });
    const calls: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, imap],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "gmail" },
          { accountId: imap, providerKind: "imap" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.requestSync(imap);
    await vi.advanceTimersByTimeAsync(10_000);
    const before = calls.length;
    // NTP or a VM restore sets the clock back; the mailbox does not wait an
    // hour for it.
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.slice(before).filter((accountId) => accountId === accountA)).toHaveLength(3);
    const count = calls.length;
    scheduler.requestSync(imap);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.slice(count)).toEqual([imap]);
    await scheduler.stop();
  });

  it("runs IDLE's request at once after the wall clock jumps forward", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        listSyncAccounts: async () => [{ accountId: imap, providerKind: "imap" }],
        runBackgroundSyncStep: async (accountId) => {
          calls.push(accountId);
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.setSystemTime(Date.now() + 3_600_000);
    scheduler.requestSync(imap);
    await vi.advanceTimersByTimeAsync(0);
    // Not a minute later, when the poll's timer armed before the jump fires.
    expect(calls).toEqual([imap, imap]);
    await scheduler.stop();
  });

  it("keeps the senders archiver draining between provider calls", async () => {
    vi.useFakeTimers({ now: 0 });
    let providerCalls = 0;
    let fail = false;
    let backlog = 800;
    let drainedAt: number | null = null;
    const told: boolean[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        listSyncAccounts: async () => [{ accountId: imap, providerKind: "imap" }],
        runBackgroundSyncStep: async () => {
          providerCalls += 1;
          if (fail) throw new Error("provider unavailable");
          return syncResult(false);
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        senders: {
          // A blocked sender with 800 threads in the Inbox: the archiver
          // moves 25 a step, and only after a sync that reached the provider.
          async runBackgroundSenderStep(_accountId, input) {
            told.push(input.syncSucceeded);
            if (!input.syncSucceeded) return { hasMore: false };
            backlog = Math.max(0, backlog - 25);
            if (backlog === 0) drainedAt ??= Date.now();
            return { hasMore: backlog > 0 };
          },
        },
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    // Seconds, on the one healthy sync that began it, not a sync a step.
    expect(drainedAt).not.toBeNull();
    expect(drainedAt!).toBeLessThan(15_000);
    expect(providerCalls).toBe(1);

    fail = true;
    await vi.advanceTimersByTimeAsync(30_010);
    expect(providerCalls).toBe(2);
    expect(told.at(-1)).toBe(false);
    // A visit between provider calls carries the last sync's verdict.
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(providerCalls).toBe(2);
    expect(told.at(-1)).toBe(false);
    await scheduler.stop();
  });

  it("does not spin on an account listing that keeps failing", async () => {
    vi.useFakeTimers({ now: 0 });
    let listings = 0;
    let broken = false;
    let pages = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => {
          listings += 1;
          if (broken) throw new Error("store locked");
          return [{ accountId: accountA, providerKind: "gmail" }];
        },
        runBackgroundSyncStep: async () => {
          pages += 1;
          if (pages === 3) broken = true;
          return syncResult(true);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    const before = listings;
    await vi.advanceTimersByTimeAsync(60_000);
    // Once a fallback interval, not four times a second.
    expect(listings - before).toBeLessThanOrEqual(2);
    await scheduler.stop();
  });

  it("rests a failing provider for the fallback interval, then returns to its cadence", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "gmail" }],
        runBackgroundSyncStep: async () => {
          calls.push(Date.now());
          if (calls.length === 2) throw new Error("provider unavailable");
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(100_010);
    expect(calls).toEqual([10, 20_010, 80_010, 100_010]);
    await scheduler.stop();
  });

  it("starts again promptly after a pause, whatever was due before it", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "gmail" }],
        runBackgroundSyncStep: async () => {
          calls.push(Date.now());
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([10, 6_010]);
    await scheduler.stop();
  });

  it("tells the senders step that a sync still paging reached the provider", async () => {
    vi.useFakeTimers({ now: 0 });
    const told: boolean[] = [];
    let pages = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        runBackgroundSyncStep: async () => {
          pages += 1;
          return syncResult(pages < 3);
        },
      },
      {
        initialDelayMs: 10,
        senders: {
          async runBackgroundSenderStep(_accountId, input) {
            told.push(input.syncSucceeded);
            return { hasMore: false };
          },
        },
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(told).toEqual([true, true, true]);
    await scheduler.stop();
  });

  it("starts a removed and re-added account afresh", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: Array<{ accountId: string; at: number }> = [];
    let accounts = [
      { accountId: accountA, providerKind: "gmail" as const },
      { accountId: imap, providerKind: "imap" as const },
    ];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => accounts.map((account) => account.accountId),
        listSyncAccounts: async () => accounts,
        runBackgroundSyncStep: async (accountId) => {
          calls.push({ accountId, at: Date.now() });
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // Parked for reauth: the pass at 20 010 no longer lists it.
    accounts = [accounts[0]!];
    await vi.advanceTimersByTimeAsync(20_000);
    accounts = [
      { accountId: accountA, providerKind: "gmail" },
      { accountId: imap, providerKind: "imap" },
    ];
    await vi.advanceTimersByTimeAsync(20_000);
    // Synced on the first pass after it came back, not at the due time it
    // had before it left.
    expect(timesOf(calls, imap)).toEqual([10, 40_010]);
    await scheduler.stop();
  });
});

/*
  The new-senders screen reads an IMAP account's Sent folder at the provider.
  That is a session on the owner's mail host, so it keeps the fallback cadence
  whatever brings the scheduler round: one a window beside the sync's own.
*/
describe("the Sent-folder scan in the scheduler", () => {
  const imap = "account-a44444444444444444444444444444444";

  function scanPort(scans: Array<{ accountId: string; at: number }>, log: string[] = []) {
    return {
      async runBackgroundSenderStep(accountId: string) {
        log.push(`senders ${accountId}`);
        return { hasMore: false };
      },
      async runBackgroundSentScanStep(accountId: string) {
        scans.push({ accountId, at: Date.now() });
        log.push(`scan ${accountId}`);
      },
    };
  }

  it("scans an IMAP account once per fallback interval, straight after its sync, and never a Gmail account", async () => {
    vi.useFakeTimers({ now: 0 });
    const scans: Array<{ accountId: string; at: number }> = [];
    const log: string[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, imap],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "gmail" },
          { accountId: imap, providerKind: "imap" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          log.push(`sync ${accountId}`);
          return changed();
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        gmailIntervalMs: 20_000,
        privacyCache: {
          async runBackgroundPrefetchStep(accountId) {
            log.push(`prefetch ${accountId}`);
            return { hasMore: false };
          },
        },
        senders: scanPort(scans, log),
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toEqual([
      `sync ${accountA}`,
      `prefetch ${accountA}`,
      `senders ${accountA}`,
      `sync ${imap}`,
      `scan ${imap}`,
      `prefetch ${imap}`,
      `senders ${imap}`,
    ]);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(scans).toEqual([
      { accountId: imap, at: 10 },
      { accountId: imap, at: 60_010 },
      { accountId: imap, at: 120_010 },
      { accountId: imap, at: 180_010 },
    ]);
    await scheduler.stop();
  });

  it("holds one scan per window through kicks, IDLE's passes and the cache's continuation visits", async () => {
    vi.useFakeTimers({ now: 0 });
    const scans: Array<{ accountId: string; at: number }> = [];
    const syncs: number[] = [];
    let indexSteps = 0;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        listSyncAccounts: async () => [{ accountId: imap, providerKind: "imap" }],
        runBackgroundSyncStep: async () => {
          syncs.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 200));
          return changed();
        },
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        continuationDelayMs: 25,
        searchIndex: {
          async runBackgroundSearchIndexStep() {
            indexSteps += 1;
            return { hasMore: indexSteps < 3_000 };
          },
        },
        senders: scanPort(scans),
      },
    );

    scheduler.start();
    // Ten minutes of an owner reading (a kick every few seconds) on a host
    // that reports something on INBOX every seven.
    for (let t = 0; t < 600_000; t += 7_000) {
      await vi.advanceTimersByTimeAsync(3_000);
      scheduler.kick();
      await vi.advanceTimersByTimeAsync(4_000);
      scheduler.requestSync(imap);
    }

    expect(indexSteps).toBeGreaterThan(1_000);
    // IDLE brought the sync round far more often than the fallback...
    expect(syncs.length).toBeGreaterThan(60);
    // ...and the scan kept its own window: never two inside sixty seconds.
    const times = timesOf(scans, imap);
    expect(Math.min(...gaps(times))).toBeGreaterThanOrEqual(60_000);
    expect(times.length).toBeLessThanOrEqual(11);
    expect(times.length).toBeGreaterThanOrEqual(9);
    const stopping = scheduler.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopping;
  });

  it("does not scan while the provider's sync is failing, and scans again once it is healthy", async () => {
    vi.useFakeTimers({ now: 0 });
    const scans: Array<{ accountId: string; at: number }> = [];
    let failing = true;
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        listSyncAccounts: async () => [{ accountId: imap, providerKind: "imap" }],
        runBackgroundSyncStep: async () => {
          if (failing) throw new Error("provider unavailable");
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, senders: scanPort(scans) },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(120_010);
    // A kick runs the cache steps of a resting provider; the scan is not one.
    scheduler.kick();
    await vi.advanceTimersByTimeAsync(0);
    expect(scans).toEqual([]);

    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timesOf(scans, imap)).toEqual([180_010]);
    await scheduler.stop();
  });

  it("stops with the scheduler, aborts a scan in flight, and scans again promptly after a resume", async () => {
    vi.useFakeTimers({ now: 0 });
    const started: number[] = [];
    const aborted: boolean[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        listSyncAccounts: async () => [{ accountId: imap, providerKind: "imap" }],
        runBackgroundSyncStep: async () => syncResult(false),
      },
      {
        initialDelayMs: 10,
        intervalMs: 60_000,
        senders: {
          async runBackgroundSenderStep() {
            return { hasMore: false };
          },
          async runBackgroundSentScanStep(_accountId, signal) {
            started.push(Date.now());
            if (started.length > 1) return;
            // The first scan is still on the wire when Mail is switched off.
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                aborted.push(true);
                reject(new Error("aborted"));
              });
            });
          },
        },
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual([10]);
    await scheduler.stop();
    expect(aborted).toEqual([true]);
    // Paused: an hour passes and nothing is asked.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(started).toEqual([10]);

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(started).toEqual([10, 3_600_020]);
    await scheduler.stop();
  });

  it("keeps the pass going when a scan fails, and leaves accounts of an unnamed provider alone", async () => {
    vi.useFakeTimers({ now: 0 });
    const log: string[] = [];
    const failing = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        listSyncAccounts: async () => [{ accountId: imap, providerKind: "imap" }],
        runBackgroundSyncStep: async () => syncResult(false),
      },
      {
        initialDelayMs: 10,
        senders: {
          async runBackgroundSenderStep(accountId) {
            log.push(`senders ${accountId}`);
            return { hasMore: false };
          },
          async runBackgroundSentScanStep() {
            log.push("scan");
            throw new Error("senders store unavailable");
          },
        },
      },
    );
    failing.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(log).toEqual(["scan", `senders ${imap}`]);
    await failing.stop();

    // A port that does not name its providers runs no scan at all.
    const scans: Array<{ accountId: string; at: number }> = [];
    const unnamed = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [imap],
        runBackgroundSyncStep: async () => syncResult(false),
      },
      { initialDelayMs: 10, senders: scanPort(scans) },
    );
    unnamed.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(scans).toEqual([]);
    await unnamed.stop();
  });
});

function changed(): MailBackgroundSyncStep {
  return syncResult(false, false, 1);
}

function timesOf(
  calls: readonly { readonly accountId: string; readonly at: number }[],
  accountId: string,
): number[] {
  return calls.filter((call) => call.accountId === accountId).map((call) => call.at);
}

function gaps(times: readonly number[]): number[] {
  return times.slice(1).map((time, index) => time - times[index]!);
}

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
