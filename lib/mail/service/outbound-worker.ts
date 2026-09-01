import type { MailSendOperation } from "../message-types";
import type {
  MailSendQueueStore,
  MailSendRequestContext,
  StoredMailSendSubmission,
} from "./outbound";

const DEFAULT_INITIAL_DELAY_MS = 0;
const DEFAULT_CONTINUATION_DELAY_MS = 250;
const DEFAULT_IDLE_RETRY_MS = 5_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const MAX_DELAY_MS = 24 * 60 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_OPERATION_ID = /^send-[0-9a-f-]{36}$/;

export interface MailOutboundProcessor {
  processOperation(
    operationId: string,
    request: MailSendRequestContext,
  ): Promise<MailSendOperation>;
}

interface ActiveOperation {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

interface PassResult {
  readonly listed: number;
  readonly failures: number;
  readonly skippedInvalidated: number;
}

export type MailOutboundWorkerEvent =
  | Readonly<{
      event: "mail_outbound_worker_failed";
      errorCode: "operation_failed" | "queue_unavailable";
    }>
  | Readonly<{ event: "mail_outbound_worker_recovered" }>;

/**
 * Serialized, durable outbox runner. One bounded pass is allowed at a time;
 * provider failures are isolated to one operation, and all retry timing remains
 * sourced from the durable queue instead of process memory.
 */
export class MailOutboundWorker {
  private readonly store: MailSendQueueStore;
  private readonly processor: MailOutboundProcessor;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly continuationDelayMs: number;
  private readonly idleRetryMs: number;
  private readonly operationTimeoutMs: number;
  private readonly batchSize: number;
  private readonly onEvent: (event: MailOutboundWorkerEvent) => void;
  private readonly invalidatedAccounts = new Set<string>();
  private readonly activeByAccount = new Map<string, Set<ActiveOperation>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inFlight: Promise<void> | null = null;
  private commandTail: Promise<void> = Promise.resolve();
  private accountGuardTail: Promise<void> = Promise.resolve();
  private started = false;
  private unhealthy = false;

  constructor(options: {
    readonly store: MailSendQueueStore;
    readonly processor: MailOutboundProcessor;
    readonly now?: () => number;
    readonly initialDelayMs?: number;
    readonly continuationDelayMs?: number;
    readonly idleRetryMs?: number;
    readonly operationTimeoutMs?: number;
    readonly batchSize?: number;
    readonly onEvent?: (event: MailOutboundWorkerEvent) => void;
  }) {
    this.store = options.store;
    this.processor = options.processor;
    this.now = options.now ?? Date.now;
    this.initialDelayMs = validateInitialDelay(
      options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
    );
    this.continuationDelayMs = validateDelay(
      options.continuationDelayMs ?? DEFAULT_CONTINUATION_DELAY_MS,
    );
    this.idleRetryMs = validateDelay(
      options.idleRetryMs ?? DEFAULT_IDLE_RETRY_MS,
    );
    this.operationTimeoutMs = validateDelay(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
    );
    this.batchSize = validateBatchSize(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /** Starts recovery of durable queued and expired-sending operations. */
  async start(): Promise<void> {
    await this.serialize(() => {
      if (this.started) return;
      this.started = true;
      this.schedule(this.initialDelayMs);
    });
  }

  /** Runs one pass now, joining an already-running pass instead of overlapping. */
  async runNow(): Promise<void> {
    const holder = await this.serialize(() => {
      this.clearTimer();
      return Object.freeze({ pass: this.inFlight ?? this.beginPass() });
    });
    await holder.pass;
  }

  /** Aborts the current provider call and resolves only after it has drained. */
  async stop(): Promise<void> {
    await this.serialize(async () => {
      this.started = false;
      this.clearTimer();
      this.controller?.abort();
      for (const operations of this.activeByAccount.values()) {
        for (const operation of operations) operation.controller.abort();
      }
      await this.inFlight?.catch(() => undefined);
    });
  }

  /** Account-removal barrier: block new work, abort it, then drain it. */
  async invalidateAccount(accountIdInput: string): Promise<void> {
    const accountId = validateAccountId(accountIdInput);
    const holder = await this.serializeAccountGuard(() => {
      this.invalidatedAccounts.add(accountId);
      const active = [...(this.activeByAccount.get(accountId) ?? [])];
      for (const operation of active) operation.controller.abort();
      return Object.freeze({
        drain: Promise.all(active.map((operation) => operation.done)),
      });
    });
    await holder.drain;
  }

  /** Rollback hook when the authoritative account deletion did not commit. */
  async restoreInvalidatedAccount(accountIdInput: string): Promise<void> {
    const accountId = validateAccountId(accountIdInput);
    const holder = await this.serializeAccountGuard(() => {
      const active = [...(this.activeByAccount.get(accountId) ?? [])];
      return Object.freeze({
        drain: Promise.all(active.map((operation) => operation.done)),
      });
    });
    await holder.drain;
    await this.serializeAccountGuard(() => {
      this.invalidatedAccounts.delete(accountId);
    });
    await this.serialize(() => {
      if (this.started) {
        this.clearTimer();
        this.schedule(0);
      }
    });
  }

  private beginPass(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let nextDelayMs: number | null = null;
    const task = (async () => {
      let result: PassResult;
      let failureCode:
        | Extract<
            MailOutboundWorkerEvent,
            { readonly event: "mail_outbound_worker_failed" }
          >["errorCode"]
        | null = null;
      try {
        result = await this.runPass(controller.signal);
      } catch {
        failureCode = "queue_unavailable";
        result = Object.freeze({
          listed: 0,
          failures: 1,
          skippedInvalidated: 0,
        });
      }
      if (result.failures > 0 && failureCode === null) {
        failureCode = "operation_failed";
      }
      if (!controller.signal.aborted && this.started) {
        try {
          nextDelayMs = await this.nextDelay(result, controller.signal);
        } catch {
          failureCode = "queue_unavailable";
          nextDelayMs = this.idleRetryMs;
        }
      }
      if (failureCode === null) {
        this.observeRecovery();
      } else {
        this.observeFailure(failureCode);
      }
    })().finally(() => {
      if (this.controller === controller) this.controller = null;
      if (this.inFlight === task) this.inFlight = null;
      if (
        this.started &&
        !controller.signal.aborted &&
        nextDelayMs !== null
      ) {
        this.schedule(nextDelayMs);
      }
    });
    this.inFlight = task;
    return task;
  }

  private async runPass(signal: AbortSignal): Promise<PassResult> {
    const listed = await this.store.listRunnable(
      this.readNow(),
      this.batchSize,
    );
    if (!Array.isArray(listed) || listed.length > this.batchSize) {
      throw new Error("mail outbound queue result is invalid");
    }

    const seen = new Set<string>();
    let failures = 0;
    let skippedInvalidated = 0;
    for (const submission of listed) {
      if (signal.aborted) break;
      if (!isRunnableIdentity(submission) || seen.has(submission.operationId)) {
        failures += 1;
        continue;
      }
      seen.add(submission.operationId);
      if (this.invalidatedAccounts.has(submission.accountId)) {
        skippedInvalidated += 1;
        continue;
      }
      const outcome = await this.processOne(submission, signal);
      if (outcome === "failed") failures += 1;
      if (outcome === "skipped_invalidated") skippedInvalidated += 1;
    }
    return Object.freeze({
      listed: listed.length,
      failures,
      skippedInvalidated,
    });
  }

  private async processOne(
    submission: StoredMailSendSubmission,
    passSignal: AbortSignal,
  ): Promise<"completed" | "failed" | "skipped_invalidated"> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    passSignal.addEventListener("abort", abort, { once: true });
    if (passSignal.aborted) controller.abort();

    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active = Object.freeze({ controller, done });
    const operations = await this.serializeAccountGuard(() => {
      if (
        passSignal.aborted ||
        this.invalidatedAccounts.has(submission.accountId)
      ) {
        return null;
      }
      const accountOperations =
        this.activeByAccount.get(submission.accountId) ??
        new Set<ActiveOperation>();
      accountOperations.add(active);
      this.activeByAccount.set(submission.accountId, accountOperations);
      return accountOperations;
    });
    if (operations === null) {
      passSignal.removeEventListener("abort", abort);
      finish();
      return "skipped_invalidated";
    }

    try {
      const now = this.readNow();
      await this.processor.processOperation(submission.operationId, {
        deadlineAt: safeDeadline(now, this.operationTimeoutMs),
        signal: controller.signal,
      });
      return "completed";
    } catch {
      return "failed";
    } finally {
      passSignal.removeEventListener("abort", abort);
      operations.delete(active);
      if (operations.size === 0) {
        this.activeByAccount.delete(submission.accountId);
      }
      finish();
    }
  }

  private async nextDelay(
    result: PassResult,
    signal: AbortSignal,
  ): Promise<number | null> {
    const active = await this.store.countActive();
    if (signal.aborted) return null;
    if (!Number.isSafeInteger(active) || active < 0) {
      throw new Error("mail outbound active count is invalid");
    }
    // send() does not have an explicit wake-up hook yet. Keep one slow idle
    // poll alive so durable work added after an empty startup is recovered.
    if (active === 0) return this.idleRetryMs;

    const nextRunnableAt = await this.store.nextRunnableAt();
    if (signal.aborted) return null;
    if (nextRunnableAt === null) return this.idleRetryMs;
    if (!Number.isSafeInteger(nextRunnableAt) || nextRunnableAt < 0) {
      throw new Error("mail outbound retry time is invalid");
    }
    const delay = nextRunnableAt - this.readNow();
    // send() does not notify this worker yet. A newly queued operation can
    // become runnable before the timestamp we just read, so never sleep
    // longer than the idle discovery interval.
    if (delay > 0) {
      return Math.min(delay, this.idleRetryMs, MAX_TIMER_DELAY_MS);
    }
    if (result.failures > 0 || result.skippedInvalidated > 0) {
      return this.idleRetryMs;
    }
    return this.continuationDelayMs;
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.timer !== null) return;
    const timer = setTimeout(() => {
      if (this.timer === timer) this.timer = null;
      void this.runNow().catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    this.timer = timer;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private observeFailure(
    errorCode: Extract<
      MailOutboundWorkerEvent,
      { readonly event: "mail_outbound_worker_failed" }
    >["errorCode"],
  ): void {
    if (this.unhealthy) return;
    this.unhealthy = true;
    this.emit(Object.freeze({ event: "mail_outbound_worker_failed", errorCode }));
  }

  private observeRecovery(): void {
    if (!this.unhealthy) return;
    this.unhealthy = false;
    this.emit(Object.freeze({ event: "mail_outbound_worker_recovered" }));
  }

  private emit(event: MailOutboundWorkerEvent): void {
    try {
      this.onEvent(event);
    } catch {
      // Observability must never change delivery semantics.
    }
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("mail outbound clock is invalid");
    }
    return now;
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const run = this.commandTail.then(operation, operation);
    this.commandTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private serializeAccountGuard<T>(
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const run = this.accountGuardTail.then(operation, operation);
    this.accountGuardTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

function isRunnableIdentity(
  value: StoredMailSendSubmission,
): value is StoredMailSendSubmission {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.operationId === "string" &&
    SAFE_OPERATION_ID.test(value.operationId) &&
    typeof value.accountId === "string" &&
    SAFE_ACCOUNT_ID.test(value.accountId)
  );
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) {
    throw new Error("mail outbound account is invalid");
  }
  return value;
}

function safeDeadline(now: number, timeoutMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + timeoutMs);
}

function validateInitialDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELAY_MS) {
    throw new Error("mail outbound initial delay is invalid");
  }
  return value;
}

function validateDelay(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DELAY_MS) {
    throw new Error("mail outbound delay is invalid");
  }
  return value;
}

function validateBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error("mail outbound batch size is invalid");
  }
  return value;
}
