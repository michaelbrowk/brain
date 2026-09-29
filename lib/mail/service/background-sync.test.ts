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
    // The index keeps the account queued, so the burst runs it three times
    // and then the account rests for an interval like any finished one.
    expect(indexCalls).toBe(3);
    expect(providerCalls).toBe(3);
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
    // runs the account again; that sync fails, and the senders step still
    // runs, told that nothing reached the provider.
    expect(senderSteps).toEqual([
      { accountId: accountA, syncSucceeded: true },
      { accountId: accountA, syncSucceeded: false },
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    // A sync the cache refused for backoff did not reach the provider either.
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

  it("backs a quiet Gmail account off to the fallback after three empty passes and returns on the first change", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA],
        listSyncAccounts: async () => [{ accountId: accountA, providerKind: "gmail" }],
        runBackgroundSyncStep: async () => {
          calls.push(Date.now());
          // The fifth pass brings a letter; every other one finds nothing.
          return calls.length === 5 ? changed() : syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(200_010);
    expect(calls).toEqual([
      10,
      20_010,
      40_010,
      // Three empty passes in a row: the account rests for the fallback.
      100_010,
      160_010,
      // The fifth pass saw a change, so the next one is back on 20 s.
      180_010,
      200_010,
    ]);
    await scheduler.stop();
  });

  it("counts a pass once, however many continuation visits the cache takes", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    let prefetches = 0;
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
        privacyCache: {
          async runBackgroundPrefetchStep() {
            prefetches += 1;
            // Bodies to fetch after a new letter: four more visits.
            return { hasMore: prefetches < 5 };
          },
        },
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([10, 10, 10, 10, 10]);
    // One pass that found nothing, not five: the account stays on 20 s.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls.at(-1)).toBe(20_010);
    await scheduler.stop();
  });

  it("brings a backed-off Gmail account back to its cadence on an on-demand sync", async () => {
    vi.useFakeTimers({ now: 0 });
    const calls: number[] = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [accountA, accountB],
        listSyncAccounts: async () => [
          { accountId: accountA, providerKind: "gmail" },
          { accountId: accountB, providerKind: "gmail" },
        ],
        runBackgroundSyncStep: async (accountId) => {
          if (accountId === accountA) calls.push(Date.now());
          return syncResult(false);
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(calls).toEqual([10, 20_010, 40_010]);
    // The owner asked for this account: the demand resets the backoff, and
    // the next pass is one Gmail interval from now instead of at 100 010.
    scheduler.noteDemand(accountA);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([10, 20_010, 40_010, 70_000]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([10, 20_010, 40_010, 70_000, 90_000]);
    await scheduler.stop();
  });

  it("never exceeds one pass per account per cadence window, however often it is asked", async () => {
    vi.useFakeTimers({ now: 0 });
    const gmail = [accountA, accountB, accountC];
    const imap = "account-a44444444444444444444444444444444";
    const calls: Array<{ accountId: string; at: number }> = [];
    const scheduler = new MailBackgroundSyncScheduler(
      {
        listAccountIds: async () => [...gmail, imap],
        listSyncAccounts: async () => [
          ...gmail.map((accountId) => ({ accountId, providerKind: "gmail" as const })),
          { accountId: imap, providerKind: "imap" as const },
        ],
        runBackgroundSyncStep: async (accountId) => {
          calls.push({ accountId, at: Date.now() });
          return changed();
        },
      },
      { initialDelayMs: 10, intervalMs: 60_000, gmailIntervalMs: 20_000 },
    );

    scheduler.start();
    for (let second = 0; second < 600; second += 1) {
      // An owner hammering the refresh on every account, every second.
      for (const accountId of [...gmail, imap]) scheduler.noteDemand(accountId);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    for (const accountId of gmail) {
      const times = timesOf(calls, accountId);
      expect(times.length).toBeGreaterThanOrEqual(29);
      expect(Math.min(...gaps(times))).toBeGreaterThanOrEqual(20_000);
    }
    const imapTimes = timesOf(calls, imap);
    expect(imapTimes.length).toBeGreaterThanOrEqual(9);
    expect(Math.min(...gaps(imapTimes))).toBeGreaterThanOrEqual(60_000);
    await scheduler.stop();
  });

  it("refuses a Gmail cadence slower than the fallback it backs off to", () => {
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
    await vi.advanceTimersByTimeAsync(24);
    expect(calls).toBe(2);
    // Fifty requests during the pass are one pass after it.
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(3);
    expect(most).toBe(1);
    await scheduler.stop();
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
