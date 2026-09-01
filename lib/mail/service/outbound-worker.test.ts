import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailSendOperation } from "../message-types";
import type {
  MailSendQueueStore,
  StoredMailSendSubmission,
} from "./outbound";
import {
  MailOutboundWorker,
  type MailOutboundProcessor,
} from "./outbound-worker";

const ACCOUNT_A = "account-a11111111111111111111111111111111";
const ACCOUNT_B = "account-a22222222222222222222222222222222";

afterEach(() => {
  vi.useRealTimers();
});

describe("Mail outbound worker", () => {
  it("recovers durable work on startup and after a clean restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new FakeQueueStore([submission(1, 1_000)]);
    const calls: string[] = [];
    const worker = createWorker(store, async (operationId) => {
      calls.push(operationId);
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([operationId(1)]);
    await worker.stop();

    store.add(submission(2, 1_000));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(1);
    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([operationId(1), operationId(2)]);
    await worker.stop();
  });

  it("joins concurrent runNow calls and never overlaps a pass", async () => {
    const store = new FakeQueueStore([submission(1, 0)]);
    const entered = deferred<void>();
    const release = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const worker = createWorker(store, async (operationId) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      entered.resolve();
      await release.promise;
      active -= 1;
      store.complete(operationId);
      return sent(operationId);
    });

    const first = worker.runNow();
    await entered.promise;
    const second = worker.runNow();
    await Promise.resolve();
    expect(store.listCalls).toBe(1);
    expect(maximumActive).toBe(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(store.listCalls).toBe(1);
    expect(maximumActive).toBe(1);
  });

  it("isolates one operation failure and processes every id once per pass", async () => {
    const duplicate = submission(1, 0);
    const store = new FakeQueueStore([
      duplicate,
      duplicate,
      submission(2, 0, ACCOUNT_B),
    ]);
    const calls: string[] = [];
    const worker = createWorker(store, async (operationId) => {
      calls.push(operationId);
      if (operationId === operationIdFor(duplicate)) {
        throw new Error("provider failed");
      }
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.runNow();
    expect(calls).toEqual([operationId(1), operationId(2)]);
  });

  it("bounds each pass and schedules a continuation without a hot loop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new FakeQueueStore([
      submission(1, 1_000),
      submission(2, 1_000),
      submission(3, 1_000),
    ]);
    const calls: string[] = [];
    const worker = createWorker(
      store,
      async (operationId) => {
        calls.push(operationId);
        store.complete(operationId);
        return sent(operationId);
      },
      { batchSize: 2, continuationDelayMs: 25 },
    );

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([operationId(1), operationId(2)]);
    await vi.advanceTimersByTimeAsync(24);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([
      operationId(1),
      operationId(2),
      operationId(3),
    ]);
    await worker.stop();
  });

  it("sleeps until the durable next-attempt time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new FakeQueueStore([submission(1, 2_000)]);
    const calls: string[] = [];
    const worker = createWorker(store, async (operationId) => {
      calls.push(operationId);
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([operationId(1)]);
    await worker.stop();
  });

  it("discovers newly queued work before an older long retry timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new FakeQueueStore([submission(1, 10_000)]);
    const calls: string[] = [];
    const worker = createWorker(store, async (operationId) => {
      calls.push(operationId);
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);
    store.add(submission(2, 1_000));
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([operationId(2)]);
    await worker.stop();
  });

  it("discovers work added after an empty startup on the idle tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new FakeQueueStore([]);
    const calls: string[] = [];
    const worker = createWorker(store, async (operationId) => {
      calls.push(operationId);
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.listCalls).toBe(1);
    store.add(submission(1, 1_000));
    await vi.advanceTimersByTimeAsync(99);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([operationId(1)]);
    await worker.stop();
  });

  it("aborts and drains an in-flight operation before stop resolves", async () => {
    vi.useFakeTimers();
    const store = new FakeQueueStore([submission(1, 0)]);
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const release = deferred<void>();
    let drained = false;
    const worker = createWorker(store, async (operationId, request) => {
      entered.resolve();
      request.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      await release.promise;
      drained = true;
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.start();
    const timer = vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    const stopping = worker.stop();
    await aborted.promise;
    expect(drained).toBe(false);
    release.resolve();
    await stopping;
    await timer;
    expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.listCalls).toBe(1);
  });

  it("blocks account work until a failed deletion is restored", async () => {
    const store = new FakeQueueStore([
      submission(1, 0, ACCOUNT_A),
      submission(2, 0, ACCOUNT_B),
    ]);
    const calls: string[] = [];
    const worker = createWorker(store, async (operationId) => {
      calls.push(operationId);
      store.complete(operationId);
      return sent(operationId);
    });

    await worker.invalidateAccount(ACCOUNT_A);
    await worker.runNow();
    expect(calls).toEqual([operationId(2)]);
    await worker.restoreInvalidatedAccount(ACCOUNT_A);
    await worker.runNow();
    expect(calls).toEqual([operationId(2), operationId(1)]);
  });

  it("aborts and drains only the account being invalidated", async () => {
    const store = new FakeQueueStore([submission(1, 0, ACCOUNT_A)]);
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const release = deferred<void>();
    let drained = false;
    const worker = createWorker(store, async (operationId, request) => {
      entered.resolve();
      request.signal.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      });
      await release.promise;
      drained = true;
      store.complete(operationId);
      return sent(operationId);
    });

    const pass = worker.runNow();
    await entered.promise;
    const invalidating = worker.invalidateAccount(ACCOUNT_A);
    await aborted.promise;
    expect(drained).toBe(false);
    release.resolve();
    await invalidating;
    await pass;
    expect(drained).toBe(true);
  });

  it("cannot admit account work after invalidation wins the listing race", async () => {
    const listStarted = deferred<void>();
    const listed = deferred<readonly StoredMailSendSubmission[]>();
    const processOperation = vi.fn(async (id: string) => sent(id));
    const store: MailSendQueueStore = {
      listRunnable: async () => {
        listStarted.resolve();
        return listed.promise;
      },
      nextRunnableAt: async () => 0,
      countActive: async () => 1,
    };
    const worker = createWorker(store, processOperation);

    const pass = worker.runNow();
    await listStarted.promise;
    listed.resolve([submission(1, 0, ACCOUNT_A)]);
    const invalidating = worker.invalidateAccount(ACCOUNT_A);
    await invalidating;
    await pass;
    expect(processOperation).not.toHaveBeenCalled();
  });

  it("reports one failure transition and the later recovery", async () => {
    const events: unknown[] = [];
    let fail = true;
    const store: MailSendQueueStore = {
      listRunnable: async () => {
        if (fail) throw new Error("private store detail");
        return [];
      },
      nextRunnableAt: async () => null,
      countActive: async () => 0,
    };
    const worker = new MailOutboundWorker({
      store,
      processor: { processOperation: async (id) => sent(id) },
      onEvent: (event) => events.push(event),
    });

    await worker.runNow();
    await worker.runNow();
    fail = false;
    await worker.runNow();

    expect(events).toEqual([
      {
        event: "mail_outbound_worker_failed",
        errorCode: "queue_unavailable",
      },
      { event: "mail_outbound_worker_recovered" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private store detail");
  });

  it("reports scheduling metadata failures without a premature recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const events: unknown[] = [];
    let metadataFails = true;
    const store: MailSendQueueStore = {
      listRunnable: async () => [],
      nextRunnableAt: async () => null,
      countActive: async () => {
        if (metadataFails) throw new Error("private scheduling detail");
        return 0;
      },
    };
    const worker = new MailOutboundWorker({
      store,
      processor: { processOperation: async (id) => sent(id) },
      initialDelayMs: 0,
      idleRetryMs: 100,
      onEvent: (event) => events.push(event),
    });

    await worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([
      {
        event: "mail_outbound_worker_failed",
        errorCode: "queue_unavailable",
      },
    ]);

    metadataFails = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(events).toEqual([
      {
        event: "mail_outbound_worker_failed",
        errorCode: "queue_unavailable",
      },
      { event: "mail_outbound_worker_recovered" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private scheduling detail");
    await worker.stop();
  });
});

class FakeQueueStore implements MailSendQueueStore {
  private readonly submissions: StoredMailSendSubmission[];
  listCalls = 0;

  constructor(submissions: readonly StoredMailSendSubmission[]) {
    this.submissions = [...submissions];
  }

  add(value: StoredMailSendSubmission): void {
    this.submissions.push(value);
  }

  complete(id: string): void {
    for (let index = this.submissions.length - 1; index >= 0; index -= 1) {
      if (this.submissions[index]?.operationId === id) {
        this.submissions.splice(index, 1);
      }
    }
  }

  async listRunnable(
    now: number,
    limit: number,
  ): Promise<readonly StoredMailSendSubmission[]> {
    this.listCalls += 1;
    return this.submissions
      .filter((value) => value.nextAttemptAt !== null && value.nextAttemptAt <= now)
      .slice(0, limit);
  }

  async nextRunnableAt(): Promise<number | null> {
    const values = this.submissions
      .map((value) => value.nextAttemptAt)
      .filter((value): value is number => value !== null);
    return values.length === 0 ? null : Math.min(...values);
  }

  async countActive(): Promise<number> {
    return this.submissions.length;
  }
}

function createWorker(
  store: MailSendQueueStore,
  processOperation: MailOutboundProcessor["processOperation"],
  options: {
    readonly batchSize?: number;
    readonly continuationDelayMs?: number;
  } = {},
): MailOutboundWorker {
  return new MailOutboundWorker({
    store,
    processor: { processOperation },
    initialDelayMs: 0,
    continuationDelayMs: options.continuationDelayMs ?? 25,
    idleRetryMs: 100,
    operationTimeoutMs: 1_000,
    batchSize: options.batchSize ?? 20,
  });
}

function submission(
  index: number,
  nextAttemptAt: number,
  accountId = ACCOUNT_A,
): StoredMailSendSubmission {
  return Object.freeze({
    version: 0,
    operationId: operationId(index),
    idempotencyKey: `key-${index}`,
    requestFingerprint: "a".repeat(64),
    accountId,
    providerKind: "gmail",
    status: "queued",
    attemptCount: 0,
    lease: null,
    message: Object.freeze({
      messageId: `<message-${index}@brain.local>`,
      envelope: Object.freeze({
        from: "sender@example.com",
        to: Object.freeze(["reader@example.com"]),
        cc: Object.freeze([]),
        bcc: Object.freeze([]),
      }),
      providerThreadId: null,
      rawRfc2822Base64Url: "",
      rawRfc2822Bytes: 0,
      rawRfc2822Sha256: "b".repeat(64),
    }),
    providerMessageId: null,
    providerThreadId: null,
    lastErrorCode: null,
    nextAttemptAt,
    createdAt: nextAttemptAt,
    updatedAt: nextAttemptAt,
  });
}

function sent(id: string): MailSendOperation {
  return Object.freeze({ apiVersion: 1, operationId: id, status: "sent" });
}

function operationId(index: number): string {
  return `send-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function operationIdFor(value: StoredMailSendSubmission): string {
  return value.operationId;
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
