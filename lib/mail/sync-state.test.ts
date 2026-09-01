import { describe, expect, it } from "vitest";
import {
  advanceMailboxSync,
  beginMailboxSync,
  completeMailboxSync,
  createMailboxSyncState,
  failMailboxSync,
  observeMailboxIdentity,
  recoverExpiredMailboxSync,
  remoteMessageKey,
} from "./sync-state";

const now = Date.parse("2026-07-12T12:00:00.000Z");

function completeInitialSync() {
  let state = createMailboxSyncState();
  state = beginMailboxSync(state, {
    attemptId: "attempt-initial",
    now,
    leaseMs: 60_000,
  });
  state = observeMailboxIdentity(state, {
    attemptId: "attempt-initial",
    now: state.lease!.startedAt + 1,
    uidValidity: "101",
  });
  state = advanceMailboxSync(state, {
    attemptId: "attempt-initial",
    now: state.lease!.startedAt + 2,
    uidValidity: "101",
    highestUid: 25,
    highestModSeq: "300",
  });
  return completeMailboxSync(state, {
    attemptId: "attempt-initial",
    now: now + 1_000,
  });
}

describe("mailbox sync state", () => {
  it("commits an initial generation only after the complete transition", () => {
    let state = createMailboxSyncState();
    state = beginMailboxSync(state, {
      attemptId: "attempt-1",
      now,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "attempt-1",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    state = advanceMailboxSync(state, {
      attemptId: "attempt-1",
      now: state.lease!.startedAt + 2,
      uidValidity: "101",
      highestUid: 25,
      highestModSeq: "300",
    });

    expect(state.active).toBeNull();
    expect(state.resume).toEqual({
      generation: 1,
      uidValidity: "101",
      highestUid: 25,
      highestModSeq: "300",
    });

    state = completeMailboxSync(state, {
      attemptId: "attempt-1",
      now: now + 1_000,
    });

    expect(state.phase).toBe("idle");
    expect(state.active).toEqual({
      generation: 1,
      uidValidity: "101",
      highestUid: 25,
      highestModSeq: "300",
    });
    expect(state.resume).toBeNull();
    expect(state.lease).toBeNull();
  });

  it("keeps a durable resume cursor across a transient failure", () => {
    let state = completeInitialSync();
    state = beginMailboxSync(state, {
      attemptId: "attempt-2",
      now: now + 2_000,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "attempt-2",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    state = advanceMailboxSync(state, {
      attemptId: "attempt-2",
      now: state.lease!.startedAt + 2,
      uidValidity: "101",
      highestUid: 40,
      highestModSeq: "450",
    });
    state = failMailboxSync(state, {
      attemptId: "attempt-2",
      now: now + 3_000,
      errorCode: "imap_connection_lost",
    });

    expect(state.phase).toBe("backoff");
    expect(state.active?.highestUid).toBe(25);
    expect(state.resume?.highestUid).toBe(40);
    expect(() =>
      beginMailboxSync(state, {
        attemptId: "too-early",
        now: state.retryAt! - 1,
        leaseMs: 60_000,
      }),
    ).toThrow(/backoff/i);

    state = beginMailboxSync(state, {
      attemptId: "attempt-3",
      now: state.retryAt!,
      leaseMs: 60_000,
    });
    expect(state.resume?.highestUid).toBe(40);
    state = observeMailboxIdentity(state, {
      attemptId: "attempt-3",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    state = completeMailboxSync(state, {
      attemptId: "attempt-3",
      now: state.retryAt ?? now + 60_000,
    });
    expect(state.active?.highestUid).toBe(40);
  });

  it("stages a new generation when UIDVALIDITY changes", () => {
    let state = completeInitialSync();
    state = beginMailboxSync(state, {
      attemptId: "attempt-rebuild",
      now: now + 2_000,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "attempt-rebuild",
      now: state.lease!.startedAt + 1,
      uidValidity: "202",
    });

    expect(state.phase).toBe("rebuilding");
    expect(state.active).toMatchObject({ generation: 1, uidValidity: "101" });
    expect(state.resume).toEqual({
      generation: 2,
      uidValidity: "202",
      highestUid: 0,
      highestModSeq: null,
    });

    state = advanceMailboxSync(state, {
      attemptId: "attempt-rebuild",
      now: state.lease!.startedAt + 2,
      uidValidity: "202",
      highestUid: 7,
      highestModSeq: "9",
    });
    state = failMailboxSync(state, {
      attemptId: "attempt-rebuild",
      now: now + 3_000,
      errorCode: "imap_disconnect",
    });

    expect(state.active).toMatchObject({ generation: 1, uidValidity: "101" });
    expect(state.resume).toMatchObject({ generation: 2, uidValidity: "202" });

    state = beginMailboxSync(state, {
      attemptId: "attempt-resume-rebuild",
      now: state.retryAt!,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "attempt-resume-rebuild",
      now: state.lease!.startedAt + 1,
      uidValidity: "202",
    });
    expect(state.resume?.generation).toBe(2);
    state = completeMailboxSync(state, {
      attemptId: "attempt-resume-rebuild",
      now: state.retryAt ?? now + 90_000,
    });
    expect(state.active).toMatchObject({
      generation: 2,
      uidValidity: "202",
      highestUid: 7,
    });
  });

  it("rejects stale attempts and non-monotonic cursors", () => {
    let state = completeInitialSync();
    state = beginMailboxSync(state, {
      attemptId: "current-attempt",
      now: now + 2_000,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "current-attempt",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });

    expect(() =>
      advanceMailboxSync(state, {
        attemptId: "stale-attempt",
        now: state.lease!.startedAt + 2,
        uidValidity: "101",
        highestUid: 26,
        highestModSeq: "301",
      }),
    ).toThrow(/attempt/i);
    expect(() =>
      advanceMailboxSync(state, {
        attemptId: "current-attempt",
        now: state.lease!.startedAt + 2,
        uidValidity: "101",
        highestUid: 24,
        highestModSeq: "301",
      }),
    ).toThrow(/highest uid/i);
  });

  it("keys remote messages by UIDVALIDITY as well as UID", () => {
    expect(remoteMessageKey("account", "inbox", "101", 7)).not.toBe(
      remoteMessageKey("account", "inbox", "202", 7),
    );
    expect(remoteMessageKey("account", "inbox", "101", 7)).toBe(
      "account/inbox/101/7",
    );
  });

  it("recovers an expired worker lease without publishing staged data", () => {
    let state = createMailboxSyncState();
    state = beginMailboxSync(state, {
      attemptId: "expired-attempt",
      now,
      leaseMs: 1_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "expired-attempt",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    state = advanceMailboxSync(state, {
      attemptId: "expired-attempt",
      now: state.lease!.startedAt + 2,
      uidValidity: "101",
      highestUid: 10,
      highestModSeq: "20",
    });

    state = recoverExpiredMailboxSync(state, { now: now + 1_000 });

    expect(state.phase).toBe("backoff");
    expect(state.active).toBeNull();
    expect(state.resume).toMatchObject({ highestUid: 10 });
    expect(() =>
      completeMailboxSync(state, {
        attemptId: "expired-attempt",
        now: now + 1_001,
      }),
    ).toThrow(/attempt/i);
  });

  it("rejects every late worker transition outside the sync lease", () => {
    let state = beginMailboxSync(createMailboxSyncState(), {
      attemptId: "late-sync",
      now,
      leaseMs: 1_000,
    });
    expect(() =>
      observeMailboxIdentity(state, {
        attemptId: "late-sync",
        now: now + 1_001,
        uidValidity: "101",
      }),
    ).toThrow(/outside/i);
    state = observeMailboxIdentity(state, {
      attemptId: "late-sync",
      now: now + 500,
      uidValidity: "101",
    });
    expect(() =>
      advanceMailboxSync(state, {
        attemptId: "late-sync",
        now: now + 1_001,
        uidValidity: "101",
        highestUid: 1,
        highestModSeq: "1",
      }),
    ).toThrow(/outside/i);
    expect(() =>
      failMailboxSync(state, {
        attemptId: "late-sync",
        now: now + 1_001,
        errorCode: "imap_timeout",
      }),
    ).toThrow(/outside/i);
  });

  it("rejects a decreasing MODSEQ inside one mailbox generation", () => {
    let state = completeInitialSync();
    state = beginMailboxSync(state, {
      attemptId: "modseq-attempt",
      now: now + 2_000,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "modseq-attempt",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    expect(() =>
      advanceMailboxSync(state, {
        attemptId: "modseq-attempt",
        now: state.lease!.startedAt + 2,
        uidValidity: "101",
        highestUid: 26,
        highestModSeq: "299",
      }),
    ).toThrow(/modseq/i);
  });

  it("requires every resumed worker to observe UIDVALIDITY before advancing or completing", () => {
    let state = completeInitialSync();
    state = beginMailboxSync(state, {
      attemptId: "partial-attempt",
      now: now + 2_000,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "partial-attempt",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    state = advanceMailboxSync(state, {
      attemptId: "partial-attempt",
      now: state.lease!.startedAt + 2,
      uidValidity: "101",
      highestUid: 30,
      highestModSeq: "350",
    });
    state = failMailboxSync(state, {
      attemptId: "partial-attempt",
      now: now + 3_000,
      errorCode: "imap_disconnect",
    });
    state = beginMailboxSync(state, {
      attemptId: "resumed-attempt",
      now: state.retryAt!,
      leaseMs: 60_000,
    });

    expect(() =>
      advanceMailboxSync(state, {
        attemptId: "resumed-attempt",
        now: state.lease!.startedAt + 1,
        uidValidity: "101",
        highestUid: 31,
        highestModSeq: "351",
      }),
    ).toThrow(/observed/i);
    expect(() =>
      completeMailboxSync(state, {
        attemptId: "resumed-attempt",
        now: state.lease!.startedAt + 1,
      }),
    ).toThrow(/observing identity/i);

    state = observeMailboxIdentity(state, {
      attemptId: "resumed-attempt",
      now: state.lease!.startedAt + 1,
      uidValidity: "202",
    });
    expect(state.phase).toBe("rebuilding");
    expect(state.resume).toMatchObject({ uidValidity: "202", highestUid: 0 });
  });

  it("enforces the RFC 7162 unsigned 63-bit MODSEQ range", () => {
    let state = beginMailboxSync(createMailboxSyncState(), {
      attemptId: "modseq-range",
      now,
      leaseMs: 60_000,
    });
    state = observeMailboxIdentity(state, {
      attemptId: "modseq-range",
      now: state.lease!.startedAt + 1,
      uidValidity: "101",
    });
    expect(() =>
      advanceMailboxSync(state, {
        attemptId: "modseq-range",
        now: state.lease!.startedAt + 2,
        uidValidity: "101",
        highestUid: 1,
        highestModSeq: "9223372036854775807",
      }),
    ).not.toThrow();
    for (const highestModSeq of ["0", "9223372036854775808", "9".repeat(10_000)]) {
      expect(() =>
        advanceMailboxSync(state, {
          attemptId: "modseq-range",
          now: state.lease!.startedAt + 2,
          uidValidity: "101",
          highestUid: 1,
          highestModSeq,
        }),
      ).toThrow(/63-bit/i);
    }
  });

  it("fails closed on an inconsistent persisted sync record", () => {
    const invalid = {
      ...createMailboxSyncState(),
      phase: "backoff" as const,
      retryAt: null,
    };
    expect(() =>
      beginMailboxSync(invalid, {
        attemptId: "must-not-run",
        now,
        leaseMs: 60_000,
      }),
    ).toThrow(/retry time/i);
  });
});
