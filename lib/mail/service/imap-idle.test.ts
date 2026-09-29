import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";
import { MailAccountError } from "./account-types";
import { type ImapIdleClient, MailImapIdleSupervisor } from "./imap-idle";

const accountA = "account-a11111111111111111111111111111111";
const accountB = "account-a22222222222222222222222222222222";
const BASE_MS = 60_000;
const CAP_MS = 30 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The part of ImapFlow the supervisor drives, with ImapFlow's own semantics:
 * `idle()` stays pending until a command breaks it (DONE is sent ahead of
 * that command), `close()` emits `close`, and updates arrive as events.
 */
class FakeImapFlow extends EventEmitter {
  capabilities = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["IDLE", true],
  ]);
  readonly calls: string[] = [];
  private ending: ((result: boolean) => void) | null = null;

  idle(): Promise<boolean> {
    this.calls.push("idle");
    return new Promise<boolean>((resolve) => {
      this.ending = resolve;
    });
  }

  async noop(): Promise<void> {
    this.calls.push("noop");
    this.endIdle(true);
  }

  close(): void {
    this.calls.push("close");
    this.emit("close");
  }

  /** The IDLE command completing on its own: `false` is ImapFlow's failure. */
  endIdle(result: boolean): void {
    const ending = this.ending;
    this.ending = null;
    ending?.(result);
  }

  get idling(): boolean {
    return this.ending !== null;
  }
}

function harness(options: { readonly clients?: FakeImapFlow[] } = {}) {
  const clients = options.clients ?? [];
  const opened: FakeImapFlow[] = [];
  const signals: AbortSignal[] = [];
  const connector = {
    openIdleSession: vi.fn(async (_accountId: string, signal: AbortSignal) => {
      signals.push(signal);
      const client = clients.shift() ?? new FakeImapFlow();
      opened.push(client);
      return client as unknown as ImapIdleClient;
    }),
  };
  const passes: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const supervisor = new MailImapIdleSupervisor({
    connector,
    onChange: (accountId) => passes.push(accountId),
    onEvent: (record) => events.push({ ...record }),
  });
  supervisor.start();
  return { supervisor, connector, opened, signals, passes, events };
}

/** Lets the connector's promise and the supervisor's reaction settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("IMAP IDLE supervisor", () => {
  it("opens INBOX after a pass, asks for one pass to close the gap, and enters IDLE after it", async () => {
    const { supervisor, connector, opened, passes, events } = harness();

    supervisor.afterSync(accountA);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledOnce();
    expect(connector.openIdleSession.mock.calls[0]?.[0]).toBe(accountA);
    // Mail that landed between the pass and the session's EXAMINE is seen by
    // this one pass; IDLE starts after it like after any other.
    expect(passes).toEqual([accountA]);
    expect(opened[0]?.calls).toEqual([]);
    expect(events).toEqual([{ event: "mail_imap_idle_connected", accountId: accountA }]);

    supervisor.afterSync(accountA);
    expect(opened[0]?.calls).toEqual(["idle"]);
    // Already idling: another pass on the poll changes nothing.
    supervisor.afterSync(accountA);
    expect(opened[0]?.calls).toEqual(["idle"]);
    expect(connector.openIdleSession).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it.each(["exists", "expunge", "flags"])(
    "leaves IDLE on %s and runs the same pass, once",
    async (update) => {
      const { supervisor, opened, passes } = harness();
      supervisor.afterSync(accountA);
      await settle();
      supervisor.afterSync(accountA);
      const client = opened[0]!;

      client.emit(update, { path: "INBOX" });
      await settle();
      expect(client.calls).toEqual(["idle", "noop"]);
      expect(passes).toEqual([accountA, accountA]);

      // A burst of updates while the pass is pending is one more pass after
      // it, not one each.
      client.emit(update, { path: "INBOX" });
      client.emit("exists", { path: "INBOX" });
      await settle();
      expect(passes).toEqual([accountA, accountA]);
      supervisor.afterSync(accountA);
      expect(passes).toEqual([accountA, accountA, accountA]);

      supervisor.afterSync(accountA);
      expect(client.calls).toEqual(["idle", "noop", "idle"]);
      expect(passes).toHaveLength(3);
      await supervisor.stop();
    },
  );

  it("changes nothing for an update about a mailbox the session does not hold", async () => {
    const { supervisor, opened, passes } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    const client = opened[0]!;

    client.emit("exists", { path: "Archive" });
    client.emit("flags", { path: "INBOX.Sent" });
    client.emit("expunge", {});
    await settle();
    expect(client.calls).toEqual(["idle"]);
    expect(passes).toEqual([accountA]);
    // The update for INBOX itself is case-insensitive, as the name is.
    client.emit("exists", { path: "inbox" });
    await settle();
    expect(client.calls).toEqual(["idle", "noop"]);
    await supervisor.stop();
  });

  it("restarts IDLE before the 29-minute mark and runs a pass", async () => {
    vi.useFakeTimers({ now: 0 });
    expect(MAIL_RESOURCE_LIMITS.idleRestartMs).toBeLessThan(29 * 60_000);
    const { supervisor, opened, passes } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    const client = opened[0]!;

    await vi.advanceTimersByTimeAsync(MAIL_RESOURCE_LIMITS.idleRestartMs - 1);
    expect(client.calls).toEqual(["idle"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toEqual(["idle", "noop"]);
    expect(passes).toEqual([accountA, accountA]);
    supervisor.afterSync(accountA);
    expect(client.calls).toEqual(["idle", "noop", "idle"]);
    // The same connection, not a new one: a restart is DONE and IDLE again.
    expect(opened).toHaveLength(1);
    await supervisor.stop();
  });

  it("falls back to the poll when the connection drops, reconnecting on a capped exponential backoff", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, connector, opened, events } = harness();
    const connectAndIdle = async () => {
      supervisor.afterSync(accountA);
      await settle();
      supervisor.afterSync(accountA);
    };
    await connectAndIdle();

    const waits: number[] = [];
    for (let drop = 1; drop <= 7; drop += 1) {
      opened.at(-1)!.close();
      const droppedAt = Date.now();
      // Every pass on the poll asks; none reconnects before the backoff ends.
      let reconnectedAt: number | null = null;
      while (reconnectedAt === null) {
        await vi.advanceTimersByTimeAsync(BASE_MS);
        const before = connector.openIdleSession.mock.calls.length;
        await connectAndIdle();
        if (connector.openIdleSession.mock.calls.length > before) {
          reconnectedAt = Date.now();
        }
      }
      waits.push(reconnectedAt - droppedAt);
    }
    expect(waits).toEqual([
      BASE_MS,
      2 * BASE_MS,
      4 * BASE_MS,
      8 * BASE_MS,
      16 * BASE_MS,
      CAP_MS,
      CAP_MS,
    ]);
    // The counts live in the log lines and nowhere else.
    expect(
      events
        .filter((record) => record.event === "mail_imap_idle_fallback")
        .map((record) => [record.reason, record.failureCount]),
    ).toEqual([
      ["connection_dropped", 1],
      ["connection_dropped", 2],
      ["connection_dropped", 3],
      ["connection_dropped", 4],
      ["connection_dropped", 5],
      ["connection_dropped", 6],
      ["connection_dropped", 7],
    ]);
    await supervisor.stop();
  });

  it("treats an IDLE that ends on its own, or a failed break, as a dropped connection", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, opened, events } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    opened[0]!.endIdle(false);
    await settle();
    expect(opened[0]!.calls).toEqual(["idle", "close"]);

    await vi.advanceTimersByTimeAsync(BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    const second = opened[1]!;
    second.noop = async () => {
      second.calls.push("noop");
      throw new Error("SECRET provider transcript");
    };
    second.emit("exists", { path: "INBOX" });
    await settle();
    expect(second.calls).toEqual(["idle", "noop", "close"]);

    // An IDLE the server ends with OK, when nobody sent DONE, is a session
    // nobody is driving any more, however politely it ended.
    await vi.advanceTimersByTimeAsync(2 * BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    opened[2]!.endIdle(true);
    await settle();
    expect(opened[2]!.calls).toEqual(["idle", "close"]);
    expect(
      events.filter((record) => record.event === "mail_imap_idle_fallback"),
    ).toEqual([
      { event: "mail_imap_idle_fallback", accountId: accountA, reason: "connection_dropped", failureCount: 1 },
      { event: "mail_imap_idle_fallback", accountId: accountA, reason: "connection_dropped", failureCount: 2 },
      { event: "mail_imap_idle_fallback", accountId: accountA, reason: "connection_dropped", failureCount: 3 },
    ]);
    await supervisor.stop();
  });

  it("gives the next IDLE its own 25 minutes after leaving for an update", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, opened } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    const client = opened[0]!;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    client.emit("exists", { path: "INBOX" });
    await settle();
    supervisor.afterSync(accountA);
    expect(client.calls).toEqual(["idle", "noop", "idle"]);
    // The first IDLE's restart would have fired at 25 minutes.
    await vi.advanceTimersByTimeAsync(MAIL_RESOURCE_LIMITS.idleRestartMs - 1);
    expect(client.calls).toEqual(["idle", "noop", "idle"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toEqual(["idle", "noop", "idle", "noop"]);
    await supervisor.stop();
  });

  it("asks for one more pass instead of IDLE when INBOX changed while the pass ran", async () => {
    const { supervisor, opened, passes } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    const client = opened[0]!;
    client.emit("exists", { path: "INBOX" });
    await settle();
    expect(passes).toEqual([accountA, accountA]);

    // Between commands the server reports a letter that landed while the pass
    // was reading INBOX, and it will not report it again once IDLE starts.
    client.emit("exists", { path: "INBOX" });
    client.emit("flags", { path: "INBOX" });
    await settle();
    expect(passes).toEqual([accountA, accountA]);
    supervisor.afterSync(accountA);
    expect(passes).toEqual([accountA, accountA, accountA]);
    expect(client.calls).toEqual(["idle", "noop"]);
    // That pass saw it; IDLE starts after it as usual.
    supervisor.afterSync(accountA);
    expect(client.calls).toEqual(["idle", "noop", "idle"]);
    await supervisor.stop();
  });

  it("drops a session whose server never answers DONE, and still asks for the pass", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, opened, passes, events } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    const client = opened[0]!;
    client.noop = async () => {
      client.calls.push("noop");
      // The server keeps the socket alive and never ends IDLE.
      await new Promise<void>(() => undefined);
    };
    client.emit("exists", { path: "INBOX" });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(client.calls).toEqual(["idle", "noop"]);
    expect(passes).toEqual([accountA]);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.calls).toEqual(["idle", "noop", "close"]);
    expect(passes).toEqual([accountA, accountA]);
    expect(events.at(-1)).toEqual({
      event: "mail_imap_idle_fallback",
      accountId: accountA,
      reason: "done_unanswered",
      failureCount: 1,
    });
    // And a new session after the backoff, not a session stuck forever.
    await vi.advanceTimersByTimeAsync(BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    expect(opened).toHaveLength(2);
    await supervisor.stop();
  });

  it("starts the backoff from the bottom after a session that lived longer than three minutes", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, opened, connector, events } = harness();
    const connectAndIdle = async () => {
      supervisor.afterSync(accountA);
      await settle();
      supervisor.afterSync(accountA);
    };
    await connectAndIdle();
    // Three sessions that die at once: the backoff climbs to four minutes.
    for (const wait of [BASE_MS, 2 * BASE_MS, 4 * BASE_MS]) {
      opened.at(-1)!.close();
      await vi.advanceTimersByTimeAsync(wait);
      await connectAndIdle();
    }
    expect(connector.openIdleSession).toHaveBeenCalledTimes(4);
    // The fourth idles for ten minutes before its server ends IDLE on its own.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    opened.at(-1)!.endIdle(true);
    await settle();
    expect(events.at(-1)).toMatchObject({ reason: "connection_dropped", failureCount: 1 });
    await vi.advanceTimersByTimeAsync(BASE_MS);
    await connectAndIdle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(5);
    await supervisor.stop();
  });

  it("resets the backoff after a session that idled cleanly", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, opened, connector, events } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    opened[0]!.close();
    await vi.advanceTimersByTimeAsync(BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    opened[1]!.emit("exists", { path: "INBOX" });
    await settle();
    supervisor.afterSync(accountA);
    opened[1]!.close();
    // The first failure since a clean cycle waits the base again, not twice it.
    await vi.advanceTimersByTimeAsync(BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(3);
    expect(events.at(-2)).toMatchObject({ reason: "connection_dropped", failureCount: 1 });
    await supervisor.stop();
  });

  it("keeps its backoff on its own clock when the wall clock jumps", async () => {
    vi.useFakeTimers({ now: 10_000_000 });
    const { supervisor, connector, opened, events } = harness();
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    opened[0]!.close();
    // The clock goes back an hour: the one-minute backoff is still a minute.
    vi.setSystemTime(Date.now() - 3_600_000);
    await vi.advanceTimersByTimeAsync(BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(2);

    // And forward an hour: a session that lived seconds did not live an
    // hour, so the backoff keeps climbing.
    supervisor.afterSync(accountA);
    vi.setSystemTime(Date.now() + 3_600_000);
    opened[1]!.close();
    expect(events.at(-1)).toMatchObject({ reason: "connection_dropped", failureCount: 2 });
    await supervisor.stop();
  });

  it("falls back to the poll for a server without IDLE and asks again only after the cap", async () => {
    vi.useFakeTimers({ now: 0 });
    const plain = new FakeImapFlow();
    plain.capabilities.delete("IDLE");
    const { supervisor, connector, passes, events } = harness({ clients: [plain] });

    supervisor.afterSync(accountA);
    await settle();
    expect(plain.calls).toEqual(["close"]);
    expect(passes).toEqual([]);
    expect(events).toEqual([
      {
        event: "mail_imap_idle_fallback",
        accountId: accountA,
        reason: "idle_unsupported",
        failureCount: 1,
      },
    ]);
    await vi.advanceTimersByTimeAsync(CAP_MS - 1);
    supervisor.afterSync(accountA);
    expect(connector.openIdleSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    supervisor.afterSync(accountA);
    expect(connector.openIdleSession).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("backs off after a session that never opened, with the stable code only", async () => {
    vi.useFakeTimers({ now: 0 });
    const { supervisor, connector, events } = harness();
    connector.openIdleSession.mockRejectedValueOnce(
      new MailAccountError("imap_connection_timeout"),
    );
    connector.openIdleSession.mockRejectedValueOnce(
      new Error("SECRET provider transcript"),
    );
    supervisor.afterSync(accountA);
    await settle();
    supervisor.afterSync(accountA);
    expect(connector.openIdleSession).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(BASE_MS);
    supervisor.afterSync(accountA);
    await settle();
    expect(events).toEqual([
      {
        event: "mail_imap_idle_fallback",
        accountId: accountA,
        reason: "connect_failed",
        errorCode: "imap_connection_timeout",
        failureCount: 1,
      },
      {
        event: "mail_imap_idle_fallback",
        accountId: accountA,
        reason: "connect_failed",
        errorCode: "imap_connection_failed",
        failureCount: 2,
      },
    ]);
    await supervisor.stop();
  });

  it("holds one session per account and tears every one down on stop", async () => {
    const { supervisor, connector, opened } = harness();
    supervisor.afterSync(accountA);
    supervisor.afterSync(accountA);
    supervisor.afterSync(accountB);
    await settle();
    supervisor.afterSync(accountA);
    supervisor.afterSync(accountB);
    expect(connector.openIdleSession).toHaveBeenCalledTimes(2);

    await supervisor.stop();
    expect(opened.map((client) => client.calls.at(-1))).toEqual(["close", "close"]);
    // Paused means paused: nothing opens until the scheduler starts again.
    supervisor.afterSync(accountA);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(2);
    supervisor.start();
    supervisor.afterSync(accountA);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(3);
    await supervisor.stop();
  });

  it("aborts a session still opening on stop and closes it when it lands", async () => {
    const late = new FakeImapFlow();
    let land: (() => void) | undefined;
    const { supervisor, connector, signals, passes } = harness();
    connector.openIdleSession.mockImplementationOnce(async (_accountId, signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        land = resolve;
      });
      return late as unknown as ImapIdleClient;
    });
    supervisor.afterSync(accountA);
    await settle();
    const stopped = supervisor.stop();
    expect(signals[0]?.aborted).toBe(true);
    land?.();
    await stopped;
    expect(late.calls).toEqual(["close"]);
    expect(passes).toEqual([]);
  });

  it("tears down an account that no longer syncs, and one being removed until it is restored", async () => {
    const { supervisor, connector, opened } = harness();
    supervisor.afterSync(accountA);
    supervisor.afterSync(accountB);
    await settle();

    supervisor.retain([accountB]);
    expect(opened[0]?.calls).toEqual(["close"]);
    expect(opened[1]?.calls).toEqual([]);

    await supervisor.invalidateAccount(accountB);
    expect(opened[1]?.calls).toEqual(["close"]);
    supervisor.afterSync(accountB);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(2);
    supervisor.restoreInvalidatedAccount(accountB);
    supervisor.afterSync(accountB);
    await settle();
    expect(connector.openIdleSession).toHaveBeenCalledTimes(3);
    await supervisor.stop();
  });
});
