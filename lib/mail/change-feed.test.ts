import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shutdown = vi.hoisted(() => ({
  registerActiveSseClose: vi.fn((_close: () => void) => () => {}),
  registerShutdownWorker: vi.fn((_stop: () => void) => () => {}),
}));
vi.mock("@/lib/store/sse-shutdown", () => shutdown);

import {
  MAIL_CHANGE_RETRY_MAX_MS,
  MailChangeFeedLoop,
  startMailChangeFeed,
  type MailChangeFeedLoopPort,
} from "./change-feed";
import type { BrainMailEvent } from "./mail-events";
import type { MailChangeFeedAnswer } from "./service/change-feed-ring";

const ACCOUNT = `account-a${"1".repeat(32)}`;
const OTHER = `account-a${"2".repeat(32)}`;

function answer(
  cursor: number,
  changes: MailChangeFeedAnswer["changes"] = [],
  reset = false,
): MailChangeFeedAnswer {
  return { apiVersion: 1, cursor, changes, ...(reset ? { reset: true as const } : {}) };
}

/** A read the test answers by hand; an unanswered one waits until aborted,
 *  which is what a caught-up long poll does. */
function harness(options: { enabled?: boolean } = {}) {
  const reads: Array<{
    readonly cursor: number | null;
    readonly resolve: (value: MailChangeFeedAnswer) => void;
    readonly reject: (error: unknown) => void;
    readonly signal: AbortSignal;
  }> = [];
  const events: BrainMailEvent[] = [];
  const modulesListeners = new Set<() => void>();
  let enabled = options.enabled ?? true;
  const port: MailChangeFeedLoopPort = {
    readChanges: vi.fn(
      (input: { readonly cursor: number | null }, signal: AbortSignal) =>
        new Promise<MailChangeFeedAnswer>((resolve, reject) => {
          reads.push({ cursor: input.cursor, resolve, reject, signal });
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    ),
    mailEnabled: vi.fn(async () => enabled),
    emit: (event) => events.push(event),
    onModulesChange: (listener) => {
      modulesListeners.add(listener);
      return () => modulesListeners.delete(listener);
    },
  };
  return {
    port,
    reads,
    events,
    setEnabled(value: boolean) {
      enabled = value;
      for (const listener of modulesListeners) listener();
    },
  };
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Brain's mail change-feed loop", () => {
  it("starts from the service's cursor and re-arms from each answer at once", async () => {
    const world = harness();
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await flush();
    world.reads[0]!.resolve(answer(5));
    await flush();
    world.reads[1]!.resolve(
      answer(10, [
        { accountId: ACCOUNT, mailboxIds: ["inbox"], kind: "sync" },
        { accountId: OTHER, mailboxIds: ["inbox", "all"], kind: "mutation" },
        { accountId: ACCOUNT, mailboxIds: ["sent"], kind: "sync" },
        { accountId: ACCOUNT, mailboxIds: [], kind: "content_ready", messageId: "m-1" },
        { accountId: ACCOUNT, mailboxIds: [], kind: "content_ready", messageId: "m-2" },
      ]),
    );
    await flush();

    expect(world.reads.map((read) => read.cursor)).toEqual([null, 5, 10]);
    // One event per account and kind in an answer, never one per record.
    expect(world.events).toEqual([
      { kind: "mail", changeKind: "sync", accountId: ACCOUNT, mailboxIds: ["inbox", "sent"] },
      { kind: "mail", changeKind: "mutation", accountId: OTHER, mailboxIds: ["inbox", "all"] },
      {
        kind: "mail",
        changeKind: "content_ready",
        accountId: ACCOUNT,
        mailboxIds: [],
        messageIds: ["m-1", "m-2"],
      },
    ]);
    loop.stop();
  });

  it("answers a reset with one event that refreshes everything, and goes on from the new cursor", async () => {
    const world = harness();
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await flush();
    world.reads[0]!.resolve(answer(5));
    await flush();
    world.reads[1]!.resolve(answer(90, [], true));
    await flush();

    expect(world.events).toEqual([{ kind: "mail", changeKind: "reset" }]);
    expect(world.reads[2]!.cursor).toBe(90);
    loop.stop();
  });

  it("backs off on errors, doubling to a ceiling, and never spins", async () => {
    const world = harness();
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await flush();
    const failNext = () => world.reads.at(-1)!.reject(new Error("mail_service_unavailable"));

    failNext();
    await vi.advanceTimersByTimeAsync(999);
    expect(world.reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(world.reads).toHaveLength(2);
    failNext();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(world.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(world.reads).toHaveLength(3);

    for (let minute = 0; minute < 10; minute += 1) {
      failNext();
      await vi.advanceTimersByTimeAsync(MAIL_CHANGE_RETRY_MAX_MS);
    }
    const before = world.reads.length;
    failNext();
    await vi.advanceTimersByTimeAsync(MAIL_CHANGE_RETRY_MAX_MS - 1);
    expect(world.reads).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(world.reads).toHaveLength(before + 1);
    loop.stop();
  });

  it("refreshes everything once when it first reaches the service after failing to", async () => {
    const world = harness();
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await flush();
    world.reads[0]!.reject(new Error("mail_service_unavailable"));
    await vi.advanceTimersByTimeAsync(1_000);
    world.reads[1]!.resolve(answer(5));
    await flush();

    expect(world.events).toEqual([{ kind: "mail", changeKind: "reset" }]);
    expect(world.reads[2]!.cursor).toBe(5);
    loop.stop();
  });

  it("treats a quiet answer that came back at once as a fault rather than asking again straight away", async () => {
    const world = harness();
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await flush();
    world.reads[0]!.resolve(answer(5));
    await flush();
    world.reads[1]!.resolve(answer(5));
    await vi.advanceTimersByTimeAsync(999);

    expect(world.reads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(world.reads).toHaveLength(3);
    loop.stop();
  });

  it("asks nothing while Mail is off and starts again the moment it is switched on", async () => {
    const world = harness({ enabled: false });
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(world.reads).toHaveLength(0);

    world.setEnabled(true);
    await flush();
    expect(world.reads).toHaveLength(1);
    loop.stop();
  });

  it("stops the read in flight and asks nothing after a stop", async () => {
    const world = harness();
    const loop = new MailChangeFeedLoop(world.port);
    loop.start();
    await flush();
    world.reads[0]!.resolve(answer(5));
    await flush();

    loop.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(world.reads[1]!.signal.aborted).toBe(true);
    expect(world.reads).toHaveLength(2);
    expect(world.events).toEqual([]);
  });

  it("runs one loop per process, and none under NODE_ENV=test", async () => {
    const world = harness();
    const off = startMailChangeFeed({ env: { NODE_ENV: "test" }, port: world.port });
    await flush();
    expect(world.reads).toHaveLength(0);
    off();

    const stop = startMailChangeFeed({ env: { NODE_ENV: "production" }, port: world.port });
    const again = startMailChangeFeed({ env: { NODE_ENV: "production" }, port: world.port });
    await flush();
    expect(world.reads).toHaveLength(1);
    again();
    stop();
    expect(world.reads[0]!.signal.aborted).toBe(true);
  });

  it("stops at shutdown as a worker, never counted among the event streams", async () => {
    // The shutdown line's stream count is what the standalone smoke waits
    // on before it releases its last request. A loop counted there held the
    // server open past its exit deadline.
    shutdown.registerActiveSseClose.mockClear();
    shutdown.registerShutdownWorker.mockClear();
    const world = harness();
    const stop = startMailChangeFeed({ env: { NODE_ENV: "production" }, port: world.port });
    await flush();

    expect(shutdown.registerActiveSseClose).not.toHaveBeenCalled();
    expect(shutdown.registerShutdownWorker).toHaveBeenCalledTimes(1);
    const shutdownStop = shutdown.registerShutdownWorker.mock.calls[0]![0];
    shutdownStop();
    expect(world.reads[0]!.signal.aborted).toBe(true);
    stop();
  });
});
