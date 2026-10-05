// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DONE_UNLOAD_BUDGET_BYTES,
  NO_DONE,
  beginDoneRead,
  doneBatchFailureOf,
  doneFailureOf,
  doneOverlaySnapshot,
  doneQueue,
  doneReadLanded,
  hideDone,
  holdDone,
  holdSectionDone,
  landDone,
  parkSectionDone,
  releaseDone,
  resetSectionDone,
  sendSectionDoneEarly,
  settleDone,
  subscribeDoneOverlay,
  watchDoneLists,
  withdrawSectionDone,
  type DoneBatch,
  type DoneFailure,
  type DoneMutation,
  type DoneOutcome,
  type SectionDoneRun,
} from "./mail-section-done";
import { MailApiError } from "./mail-surface-client";
import type { MailThreadBatchItem, MailThreadListItem } from "@/lib/mail/message-types";

// A section's Done, deferred. The rows leave the column at the press and
// nothing is sent until the pill's window closes, so three things are pinned
// here with no React in them: the overlay that keeps the rows out of every
// Inbox list while the streams still hold them, the queue that sends the
// batches afterwards, one at a time, under no lock, and the store that keeps
// both for the page rather than for one mount of Mail.

const ACCOUNT_A = "account-a0123456789abcdef0123456789abcdef";
const ACCOUNT_B = "account-b0123456789abcdef0123456789abcdef";

function thread(
  threadId: string,
  overrides: Partial<MailThreadListItem> = {},
): MailThreadListItem {
  return {
    accountId: ACCOUNT_A,
    threadId,
    subject: threadId,
    participants: [{ name: "Sender", address: "sender@example.test" }],
    snippet: null,
    lastMessageAt: 1,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "newsletter",
    newSender: false,
    ...overrides,
  };
}

const ids = (items: readonly MailThreadListItem[]) => items.map((item) => item.threadId);

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function flush(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/**
 * The two transports a Done is given, recording every batch and every single
 * mutation. A batch answers each thread `done` with the thread as pressed,
 * read when the batch asked for it, unless `answer` says otherwise for that
 * thread; `before` may wait or throw for the whole request. A single mutation
 * (a take-back) answers what `single` returns, or throws with it.
 */
function transport(
  pressed: readonly MailThreadListItem[],
  options: {
    readonly answer?: (threadId: string, batch: DoneBatch) => MailThreadBatchItem | undefined;
    readonly before?: (batch: DoneBatch) => Promise<void> | void;
    readonly single?: (mutation: DoneMutation) => Promise<void> | void;
  } = {},
) {
  const batches: DoneBatch[] = [];
  const sent: DoneMutation[] = [];
  const sendBatch = vi.fn(async (batch: DoneBatch): Promise<readonly MailThreadBatchItem[]> => {
    batches.push(batch);
    await options.before?.(batch);
    return batch.threads.map(({ threadId }) => {
      const given = options.answer?.(threadId, batch);
      if (given !== undefined) return given;
      const copy = pressed.find(
        (item) => item.accountId === batch.accountId && item.threadId === threadId,
      )!;
      return {
        threadId,
        status: "done",
        thread: batch.read ? { ...copy, unread: false } : copy,
        markedRead: batch.read && copy.unread,
      };
    });
  });
  const send = vi.fn(async (mutation: DoneMutation) => {
    sent.push(mutation);
    await options.single?.(mutation);
  });
  return { batches, sent, sendBatch, send, hooks: { sendBatch, send } };
}

const said = (sent: readonly DoneMutation[]) =>
  sent.map((mutation) => {
    const { accountId: _account, threadId, ...rest } = mutation;
    return `${threadId}:${Object.entries(rest)
      .map(([field, value]) => `${field}=${String(value)}`)
      .join(",")}`;
  });

const idsOf = (batch: DoneBatch) => batch.threads.map((press) => press.threadId);
const sentIds = (batches: readonly DoneBatch[]) => batches.map(idsOf);
/** What the press of these threads sends: each one as it was pressed. */
const pressesOf = (threads: readonly MailThreadListItem[]) =>
  threads.map(({ threadId, messageCount, lastMessageAt, unread }) => ({
    threadId,
    messageCount,
    lastMessageAt,
    unread,
  }));

describe("the Done overlay", () => {
  it("takes held threads out of an Inbox list and hands the same list back when it holds none", () => {
    const items = [thread("1"), thread("2"), thread("3")];
    const held = holdDone(NO_DONE, [items[1]!]);
    expect(ids(hideDone(items, held))).toEqual(["1", "3"]);
    expect(hideDone(items, NO_DONE)).toBe(items);
    const untouched = [items[0]!, items[2]!];
    expect(hideDone(untouched, held)).toBe(untouched);
  });

  it("is keyed by account and thread, so the same id on another account stays", () => {
    const mine = thread("1");
    const theirs = thread("1", { accountId: ACCOUNT_B });
    const held = holdDone(NO_DONE, [mine]);
    expect(hideDone([mine, theirs], held)).toEqual([theirs]);
  });

  it("hides nothing outside an Inbox: All Mail still lists the letter", () => {
    const items = [thread("1")];
    const held = holdDone(NO_DONE, items);
    expect(hideDone(items, held, { inbox: false })).toBe(items);
  });

  it("lets go of exactly the threads it is asked to, and changes nothing when asked for none it holds", () => {
    const items = [thread("1"), thread("2")];
    const held = holdDone(NO_DONE, items);
    const one = releaseDone(held, [items[0]!]);
    expect(ids(hideDone(items, one))).toEqual(["1"]);
    expect(releaseDone(one, [items[0]!])).toBe(one);
    expect(holdDone(one, [])).toBe(one);
  });

  it("keeps a thread out while nothing has been sent, whatever is read meanwhile", () => {
    const items = [thread("1")];
    const held = holdDone(NO_DONE, items);
    // The window is open or the queue has not reached it: the server still
    // lists the thread, and a read that says so is not news.
    const settled = settleDone(held, { startedAt: 7, accountId: ACCOUNT_A, listed: items });
    expect(settled.overlay).toBe(held);
    expect(settled.gone).toEqual([]);
  });

  it("keeps an archived thread out until a read of its account begun after the archive answered lands", () => {
    const items = [thread("1"), thread("2")];
    const landed = landDone(holdDone(NO_DONE, items), [items[0]!], 4);
    // Read four began before the answer and may still list the thread.
    const stale = settleDone(landed, { startedAt: 4, accountId: ACCOUNT_A, listed: items });
    expect(stale.overlay).toBe(landed);
    expect(stale.gone).toEqual([]);

    // Read five began after it. The thread it does not list is gone from
    // the Inbox, so the hold ends and the lists are swept of it.
    const fresh = settleDone(landed, {
      startedAt: 5,
      accountId: ACCOUNT_A,
      listed: [items[1]!],
    });
    expect(ids(hideDone(items, fresh.overlay))).toEqual(["1"]);
    expect(ids(fresh.gone)).toEqual(["1"]);
  });

  it("is not told anything by another account's read", () => {
    // A refresh of four accounts lands in waves. An account that answers
    // late in it, after the archive did, says nothing about this account's
    // thread: this account's own read left before the archive and may still
    // be on its way with the row in it.
    const items = [thread("1")];
    const landed = landDone(holdDone(NO_DONE, items), items, 4);
    const other = settleDone(landed, { startedAt: 9, accountId: ACCOUNT_B, listed: [] });
    expect(other.overlay).toBe(landed);
    expect(other.gone).toEqual([]);
  });

  it("lets a thread a later read lists back into the column, and sweeps nothing", () => {
    // Listed by a read begun after the archive: someone moved it back, and
    // that read says so better than the overlay does.
    const items = [thread("1")];
    const landed = landDone(holdDone(NO_DONE, items), items, 4);
    const fresh = settleDone(landed, { startedAt: 5, accountId: ACCOUNT_A, listed: items });
    expect(hideDone(items, fresh.overlay)).toBe(items);
    expect(fresh.gone).toEqual([]);
  });

  it("does not mark a thread it no longer holds as archived", () => {
    const items = [thread("1")];
    expect(landDone(NO_DONE, items, 3)).toBe(NO_DONE);
  });
});

describe("what a lost Done mutation says about the rest of its run", () => {
  it("reads the service's codes, the client's clock, a sign-out and a dead connection", () => {
    expect(doneFailureOf(new MailApiError(409, "mail_thread_stale"))).toBe("changed");
    expect(doneFailureOf(new MailApiError(409, "mail_thread_mutation_unsupported"))).toBe(
      "refused",
    );
    expect(
      doneFailureOf(new DOMException("mail mutation unanswered after 15000ms", "TimeoutError")),
    ).toBe("silent");
    // The session ended: the next thread on the account would be answered
    // the same way, and so would the one after it.
    expect(doneFailureOf(new MailApiError(401, null))).toBe("signed-out");
    // `fetch` rejects with a TypeError when nothing answered at all.
    expect(doneFailureOf(new TypeError("Failed to fetch"))).toBe("unreachable");
    // Too many requests is a bad minute for this thread, not for the account.
    expect(doneFailureOf(new MailApiError(429, "mail_rate_limited"))).toBe("failed");
    expect(doneFailureOf(new MailApiError(502, null))).toBe("failed");
    expect(doneFailureOf(new Error("anything else"))).toBe("failed");
  });

  it("reads one thread a batch failed by the code a single request would carry", () => {
    expect(doneBatchFailureOf("mail_thread_mutation_unsupported")).toBe("refused");
    // The service's deadline came before this thread: the account is slow.
    expect(doneBatchFailureOf("request_deadline_exceeded")).toBe("silent");
    expect(doneBatchFailureOf("mail_sync_rate_limited")).toBe("failed");
    expect(doneBatchFailureOf("mail_sync_unavailable")).toBe("failed");
  });
});

describe("the Done queue", () => {
  const failureOf = (error: unknown): DoneFailure =>
    error instanceof Error &&
    ["changed", "refused", "silent", "signed-out", "unreachable"].includes(error.message)
      ? (error.message as DoneFailure)
      : "failed";

  /** Fifty-one threads on one account: two batches, so what the first one
   *  answers can be seen to reach the second. */
  const fiftyOne = () =>
    Array.from({ length: 51 }, (_value, index) => thread(String(index + 1), { unread: false }));

  it("archives an account's threads in one request, and asks for the read flag when any is unread", async () => {
    const threads = [thread("1"), thread("2", { unread: false }), thread("3")];
    const { batches, sent, hooks } = transport(threads);
    const outcome = await doneQueue(failureOf).commit(threads, hooks);

    // Each thread travels with what the press saw of it.
    expect(batches).toEqual([
      { accountId: ACCOUNT_A, threads: pressesOf(threads), read: true },
    ]);
    expect(sent).toEqual([]);
    expect(ids(outcome.moved)).toEqual(["1", "2", "3"]);
    expect(outcome.stayed).toEqual([]);
    expect(outcome.changed).toEqual([]);
    expect(outcome.renewed).toEqual([]);
    expect(outcome.closed.size).toBe(0);

    const read = [thread("4", { unread: false })];
    const second = transport(read);
    await doneQueue(failureOf).commit(read, second.hooks);
    expect(second.batches).toEqual([
      { accountId: ACCOUNT_A, threads: pressesOf(read), read: false },
    ]);
  });

  it("sends fifteen threads over two accounts as two requests, and no batch over fifty", async () => {
    const threads = Array.from({ length: 15 }, (_value, index) =>
      thread(`t${index}`, { accountId: index % 3 === 0 ? ACCOUNT_B : ACCOUNT_A }),
    );
    const { batches, hooks } = transport(threads);
    const outcome = await doneQueue(failureOf).commit(threads, hooks);

    expect(batches.map((batch) => [batch.accountId, batch.threads.length])).toEqual([
      [ACCOUNT_B, 5],
      [ACCOUNT_A, 10],
    ]);
    expect(outcome.moved).toHaveLength(15);

    const many = Array.from({ length: 120 }, (_value, index) => thread(`m${index}`));
    const big = transport(many);
    await doneQueue(failureOf).commit(many, big.hooks);
    expect(big.batches.map((batch) => batch.threads.length)).toEqual([50, 50, 20]);
  });

  it("says a thread is archived when its batch answers", async () => {
    const answer = gate();
    const threads = [thread("1"), thread("2")];
    const { hooks } = transport(threads, { before: () => answer.promise });
    const archived: string[] = [];
    const done = doneQueue(failureOf).commit(threads, {
      ...hooks,
      onArchived: (item) => archived.push(item.threadId),
    });
    await flush();
    expect(archived).toEqual([]);
    answer.open();
    await done;
    expect(archived).toEqual(["1", "2"]);
  });

  it("does not send a thread that got new mail since the press, and says which", async () => {
    // The press took a snapshot. A reply that arrived inside the window is on
    // the copy the lists hold now, and archiving the thread would file that
    // reply away, read, before anyone saw it.
    const threads = [thread("1"), thread("2"), thread("3"), thread("4")];
    const { batches, hooks } = transport(threads);
    const now = new Map<string, MailThreadListItem>([
      // A reply: one more message.
      ["1", { ...threads[0]!, messageCount: 2, lastMessageAt: 9 }],
      // The same letter, read elsewhere since: nothing new in it.
      ["2", { ...threads[1]!, unread: false }],
      // The same count and a later date: a message replaced another.
      ["4", { ...threads[3]!, lastMessageAt: 9 }],
    ]);
    const renewed: string[] = [];
    const outcome = await doneQueue(failureOf).commit(threads, {
      ...hooks,
      // No copy of "3" in any list: nothing says it changed, so it goes.
      current: (item) => now.get(item.threadId),
      onRenewed: (item) => renewed.push(item.threadId),
    });
    expect(sentIds(batches)).toEqual([["2", "3"]]);
    expect(ids(outcome.moved)).toEqual(["2", "3"]);
    expect(ids(outcome.renewed)).toEqual(["1", "4"]);
    expect(renewed).toEqual(["1", "4"]);
    expect(outcome.stayed).toEqual([]);
  });

  it("looks at the lists again for each batch, not once for the run", async () => {
    const first = gate();
    const threads = [thread("1", { unread: false }), thread("2", { accountId: ACCOUNT_B })];
    const { batches, hooks } = transport(threads, {
      before: (batch) => (batch.accountId === ACCOUNT_A ? first.promise : undefined),
    });
    let reply = false;
    const done = doneQueue(failureOf).commit(threads, {
      ...hooks,
      current: (item) => (reply && item.threadId === "2" ? { ...item, messageCount: 2 } : item),
    });
    await flush();
    // The reply lands while the first account's batch is still out.
    reply = true;
    first.open();
    const outcome = await done;
    expect(sentIds(batches)).toEqual([["1"]]);
    expect(ids(outcome.renewed)).toEqual(["2"]);
  });

  it("takes an archive back when the answer carries mail the press did not see", async () => {
    // No list has heard of the reply: the reader is in another account, out
    // of Mail, or the change feed has not caught up. The answer is the
    // provider reading the thread after the batch, and it has the reply.
    const threads = [thread("1"), thread("2")];
    const { sent, hooks } = transport(threads, {
      answer: (threadId) =>
        threadId === "1"
          ? {
              threadId,
              status: "done",
              thread: { ...threads[0]!, messageCount: 2, lastMessageAt: 9 },
              markedRead: false,
            }
          : undefined,
    });
    const archived: string[] = [];
    const renewed: string[] = [];
    const outcome = await doneQueue(failureOf).commit(threads, {
      ...hooks,
      onArchived: (item) => archived.push(item.threadId),
      onRenewed: (item) => renewed.push(item.threadId),
    });
    // Back to the Inbox. The service sent no read flag over the reply, so
    // none is taken back.
    expect(said(sent)).toEqual(["1:archive=false"]);
    expect(ids(outcome.renewed)).toEqual(["1"]);
    expect(ids(outcome.moved)).toEqual(["2"]);
    expect(renewed).toEqual(["1"]);
    expect(archived).toEqual(["2"]);
    expect(outcome.stayed).toEqual([]);
  });

  it("takes the read flag and then the archive back when the flag went on over new mail", async () => {
    // The service compared with its cache, which already held the reply: it
    // flagged the thread. The press did not have the reply.
    const pressed = thread("1");
    const { sent, hooks } = transport([pressed], {
      answer: (threadId) => ({
        threadId,
        status: "done",
        thread: { ...pressed, unread: false, messageCount: 2, lastMessageAt: 9 },
        markedRead: true,
      }),
    });
    const renewed: string[] = [];
    const outcome = await doneQueue(failureOf).commit([pressed], {
      ...hooks,
      onRenewed: (item) => renewed.push(item.threadId),
    });
    // The reply first: it is the one a reader would miss.
    expect(said(sent)).toEqual(["1:read=false", "1:archive=false"]);
    expect(ids(outcome.renewed)).toEqual(["1"]);
    expect(outcome.moved).toEqual([]);
    expect(renewed).toEqual(["1"]);
  });

  it("counts a thread it could not take back as moved, and closes its account as any failure would", async () => {
    // The archive went and the way back did not: the thread is out of the
    // inbox, which is what `moved` says, and its new mail arrives as new
    // mail does. The account's next batch is not sent.
    const threads = fiftyOne();
    const { batches, sent, hooks } = transport(threads, {
      answer: (threadId) =>
        threadId === "1"
          ? {
              threadId,
              status: "done",
              thread: { ...threads[0]!, messageCount: 2 },
              markedRead: false,
            }
          : undefined,
      single: () => {
        throw new Error("silent");
      },
    });
    const renewed: string[] = [];
    const archived: string[] = [];
    const outcome = await doneQueue(failureOf).commit(threads, {
      ...hooks,
      onArchived: (item) => archived.push(item.threadId),
      onRenewed: (item) => renewed.push(item.threadId),
    });
    expect(said(sent)).toEqual(["1:archive=false"]);
    expect(batches).toHaveLength(1);
    expect(outcome.moved).toHaveLength(50);
    expect(archived).toContain("1");
    expect(renewed).toEqual([]);
    expect(ids(outcome.stayed)).toEqual(["51"]);
    expect([...outcome.closed]).toEqual([[ACCOUNT_A, "silent"]]);
  });

  it("leaves a failed thread where it was, unread, and keeps going", async () => {
    const threads = [thread("1"), thread("2"), thread("3")];
    const { hooks } = transport(threads, {
      answer: (threadId) =>
        threadId === "2"
          ? { threadId, status: "failed", errorCode: "mail_sync_unavailable" }
          : undefined,
    });
    const outcome = await doneQueue(failureOf).commit(threads, hooks);
    expect(ids(outcome.moved)).toEqual(["1", "3"]);
    expect(ids(outcome.stayed)).toEqual(["2"]);
    expect(outcome.closed.size).toBe(0);
  });

  // No folder for the action, no answer inside the deadline, a session that
  // is over, a server nothing reached: each is as true of the next thread.
  it.each(["refused", "silent", "signed-out", "unreachable"] as const)(
    "closes an account for the run when its batch is lost to a %s answer, and still sends the other account's",
    async (failure) => {
      const threads = [
        ...fiftyOne(),
        thread("b-1", { accountId: ACCOUNT_B }),
      ];
      const { batches, hooks } = transport(threads, {
        before: (batch) => {
          if (batch.accountId === ACCOUNT_A) throw new Error(failure);
        },
      });
      const outcome = await doneQueue(failureOf).commit(threads, hooks);
      // One request to A, not one per batch.
      expect(batches.filter((batch) => batch.accountId === ACCOUNT_A)).toHaveLength(1);
      expect(ids(outcome.moved)).toEqual(["b-1"]);
      expect(outcome.stayed).toHaveLength(51);
      expect([...outcome.closed]).toEqual([[ACCOUNT_A, failure]]);
    },
  );

  it.each([
    ["mail_thread_mutation_unsupported", "refused"],
    ["request_deadline_exceeded", "silent"],
  ] as const)(
    "closes an account when a thread of its batch fails with %s, and sends it no more batches",
    async (errorCode, closure) => {
      const threads = fiftyOne();
      const { batches, hooks } = transport(threads, {
        answer: (threadId) =>
          Number(threadId) > 40 ? { threadId, status: "failed", errorCode } : undefined,
      });
      const outcome = await doneQueue(failureOf).commit(threads, hooks);
      expect(batches).toHaveLength(1);
      expect(outcome.moved).toHaveLength(40);
      expect(outcome.stayed).toHaveLength(11);
      expect([...outcome.closed]).toEqual([[ACCOUNT_A, closure]]);
    },
  );

  it("names a thread the server no longer recognises apart from one that stayed", async () => {
    const threads = [thread("1", { unread: false }), thread("2"), thread("3", { unread: false })];
    const { hooks } = transport(threads, {
      answer: (threadId) => (threadId === "2" ? { threadId, status: "stale" } : undefined),
    });
    const outcome = await doneQueue(failureOf).commit(threads, hooks);
    expect(ids(outcome.moved)).toEqual(["1", "3"]);
    expect(ids(outcome.changed)).toEqual(["2"]);
    expect(outcome.stayed).toEqual([]);
  });

  it("sends a second Done's batch only after the first one's", async () => {
    const first = gate();
    const threads = [thread("a-1", { unread: false }), thread("b-1", { unread: false })];
    const { batches, hooks } = transport(threads, {
      before: (batch) => (idsOf(batch)[0] === "a-1" ? first.promise : undefined),
    });
    const queue = doneQueue(failureOf);
    const one = queue.commit([threads[0]!], hooks);
    const two = queue.commit([threads[1]!], hooks);
    await flush();
    expect(sentIds(batches)).toEqual([["a-1"]]);
    first.open();
    await Promise.all([one, two]);
    expect(sentIds(batches)).toEqual([["a-1"], ["b-1"]]);
  });

  it("takes a thread it has not sent out of the run, and not one it has", async () => {
    const first = gate();
    const threads = [
      thread("1", { unread: false }),
      thread("2", { unread: false, accountId: ACCOUNT_B }),
      thread("3", { unread: false, accountId: ACCOUNT_B }),
    ];
    const { batches, hooks } = transport(threads, {
      before: (batch) => (batch.accountId === ACCOUNT_A ? first.promise : undefined),
    });
    const queue = doneQueue(failureOf);
    const done = queue.commit(threads, hooks);
    await flush();
    // In flight: its outcome is the server's now.
    expect(queue.withdraw(threads[0]!)).toBe(false);
    expect(queue.withdraw(threads[2]!)).toBe(true);
    expect(queue.withdraw(threads[2]!)).toBe(false);
    first.open();
    const outcome = await done;
    expect(sentIds(batches)).toEqual([["1"], ["2"]]);
    // Withdrawn is not a failure: it is in none of the run's accounts.
    expect(ids(outcome.moved)).toEqual(["1", "2"]);
    expect(outcome.stayed).toEqual([]);
    expect(outcome.renewed).toEqual([]);
  });

  it("sends everything still waiting at once when the page leaves", async () => {
    const first = gate();
    const threads = [
      thread("a-1", { unread: false }),
      thread("a-2", { unread: false, accountId: ACCOUNT_B }),
      thread("b-1", { unread: false }),
    ];
    const { batches, hooks } = transport(threads, {
      before: (batch) => (idsOf(batch)[0] === "a-1" ? first.promise : undefined),
    });
    const queue = doneQueue(failureOf);
    const one = queue.commit([threads[0]!, threads[1]!], hooks);
    const two = queue.commit([threads[2]!], hooks);
    await flush();
    expect(batches).toHaveLength(1);

    // The batch in flight is already out. What the loop had not reached, in
    // this run and in the one behind it, leaves in the same task.
    queue.unload();
    expect(sentIds(batches)).toEqual([["a-1"], ["a-2"], ["b-1"]]);

    // A page that comes back finds every thread accounted for, once.
    first.open();
    const outcomes = await Promise.all([one, two]);
    expect(batches).toHaveLength(3);
    expect(ids(outcomes[0].moved).sort()).toEqual(["a-1", "a-2"]);
    expect(ids(outcomes[1].moved)).toEqual(["b-1"]);
  });

  it("puts a thread the service answers renewed back with no request of its own, the page leaving or not", async () => {
    // The service found a reply its cache held that the press did not see,
    // and left the thread alone. Nothing is left to take back, which matters
    // most when the page is closing and a take-back would never be sent.
    const threads = [thread("1"), thread("2", { accountId: ACCOUNT_B })];
    const first = gate();
    const { sent, hooks } = transport(threads, {
      before: (batch) => (batch.accountId === ACCOUNT_A ? first.promise : undefined),
      answer: (threadId) =>
        threadId === "2"
          ? {
              threadId,
              status: "renewed",
              thread: { ...threads[1]!, messageCount: 2, lastMessageAt: 9 },
            }
          : undefined,
    });
    const renewed: string[] = [];
    const archived: string[] = [];
    const queue = doneQueue(failureOf);
    const done = queue.commit(threads, {
      ...hooks,
      onRenewed: (item) => renewed.push(item.threadId),
      onArchived: (item) => archived.push(item.threadId),
    });
    await flush();
    queue.unload();
    first.open();
    const outcome = await done;
    expect(sent).toEqual([]);
    expect(ids(outcome.renewed)).toEqual(["2"]);
    expect(renewed).toEqual(["2"]);
    expect(archived).toEqual(["1"]);
    expect(ids(outcome.moved)).toEqual(["1"]);
  });

  it("does not take back a thread whose answer has fewer messages than the press: a letter deleted elsewhere", async () => {
    const threads = [thread("1", { messageCount: 2 })];
    const { sent, hooks } = transport(threads, {
      answer: (threadId) => ({
        threadId,
        status: "done",
        thread: { ...threads[0]!, messageCount: 1, unread: false },
        markedRead: true,
      }),
    });
    const outcome = await doneQueue(failureOf).commit(threads, hooks);
    expect(sent).toEqual([]);
    expect(ids(outcome.moved)).toEqual(["1"]);
  });

  it("leaves a thread the answer says nothing about where it was", async () => {
    const threads = [thread("1"), thread("2")];
    const wire = transport(threads);
    const outcome = await doneQueue(failureOf).commit(threads, {
      ...wire.hooks,
      sendBatch: async (batch) => (await wire.sendBatch(batch)).slice(0, 1),
    });
    expect(ids(outcome.moved)).toEqual(["1"]);
    expect(ids(outcome.stayed)).toEqual(["2"]);
  });

  it("sends at pagehide only as many batches as a keepalive body may carry, and the rest later", async () => {
    // Three accounts' batches of fifty of the longest ids: some 17 KiB each,
    // so two fit the page's budget and the third does not go with the page.
    const accounts = ["c", "d", "e"].map((letter) => `account-${letter}${"0".repeat(32)}`);
    const first = gate();
    const held = thread("held", { accountId: ACCOUNT_A });
    const long = accounts.flatMap((accountId) =>
      Array.from({ length: 50 }, (_value, index) =>
        thread(`${accountId.slice(8, 9)}${index}`.padEnd(255, "x"), {
          accountId,
          messageCount: 200,
          lastMessageAt: 1_700_000_000_000,
        }),
      ),
    );
    const { batches, hooks } = transport([held, ...long], {
      before: (batch) => (batch.accountId === ACCOUNT_A ? first.promise : undefined),
    });
    const queue = doneQueue(failureOf);
    const done = queue.commit([held, ...long], hooks);
    await flush();
    expect(batches).toHaveLength(1);

    queue.unload();
    expect(batches.map((batch) => batch.accountId)).toEqual([ACCOUNT_A, accounts[0], accounts[1]]);
    const weight = (batch: DoneBatch) =>
      new TextEncoder().encode(JSON.stringify({ ...batch, archive: true })).length;
    expect(weight(batches[1]!) + weight(batches[2]!)).toBeLessThanOrEqual(
      DONE_UNLOAD_BUDGET_BYTES,
    );

    // The page did not leave after all: the run goes on and sends the third.
    first.open();
    const outcome = await done;
    expect(batches.map((batch) => batch.accountId)).toEqual([ACCOUNT_A, ...accounts]);
    expect(outcome.moved).toHaveLength(151);
  });
});

describe("the Done store", () => {
  afterEach(() => resetSectionDone());

  function run(
    threads: readonly MailThreadListItem[],
    wire: ReturnType<typeof transport>,
    overrides: Partial<SectionDoneRun> = {},
  ): SectionDoneRun & { readonly outcomes: DoneOutcome[]; readonly respoken: string[] } {
    const outcomes: DoneOutcome[] = [];
    const respoken: string[] = [];
    return {
      label: "Newsletters",
      threads: [...threads],
      blocked: 0,
      sendBatch: wire.sendBatch,
      send: wire.send,
      respeak: () => respoken.push("respoken"),
      onSettled: (outcome) => outcomes.push(outcome),
      outcomes,
      respoken,
      ...overrides,
    };
  }

  it("tells whoever is listening when the holds change, and nobody after they stop", () => {
    const heard = vi.fn();
    const stop = subscribeDoneOverlay(heard);
    const items = [thread("1")];
    holdSectionDone(items);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(hideDone(items, doneOverlaySnapshot())).toEqual([]);
    // The same holds again are not a change.
    holdSectionDone([]);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    resetSectionDone();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(doneOverlaySnapshot()).toBe(NO_DONE);
  });

  it("sends nothing for a parked Done until it is let go, and nothing at all once it is undone", async () => {
    const items = [thread("1", { unread: false })];
    const wire = transport(items);
    const undone = parkSectionDone(run(items, wire));
    await flush();
    expect(wire.batches).toEqual([]);
    expect(undone.undo()).toEqual(items);
    // Settled: a stale pill, an expiry and a page leaving all find nothing.
    expect(undone.undo()).toBeNull();
    expect(undone.send()).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(wire.batches).toEqual([]);

    const gone = parkSectionDone(run(items, wire));
    expect(gone.send()).toBe(true);
    expect(gone.send()).toBe(false);
    expect(gone.undo()).toBeNull();
    await flush();
    expect(wire.batches).toEqual([
      { accountId: ACCOUNT_A, threads: pressesOf(items), read: false },
    ]);
  });

  it("marks an archive landed against the reads begun so far, and ends the hold on that account's next read", async () => {
    const items = [thread("1", { unread: false })];
    const wire = transport(items);
    holdSectionDone(items);
    const before = beginDoneRead();
    const ticket = parkSectionDone(run(items, wire));
    ticket.send();
    await flush();
    // The read that left before the archive answered says nothing.
    expect(doneReadLanded({ startedAt: before, accountId: ACCOUNT_A, listed: items })).toEqual(
      [],
    );
    expect(hideDone(items, doneOverlaySnapshot())).toEqual([]);
    const after = beginDoneRead();
    expect(ids(doneReadLanded({ startedAt: after, accountId: ACCOUNT_A, listed: [] }))).toEqual([
      "1",
    ]);
    expect(doneOverlaySnapshot().size).toBe(0);
  });

  it("asks whoever is watching the lists for the copy they hold now, and nobody once they stop", async () => {
    const items = [thread("1", { unread: false }), thread("2", { unread: false })];
    const wire = transport(items);
    const stop = watchDoneLists((item) =>
      item.threadId === "1" ? { ...item, messageCount: 2 } : item,
    );
    // A second watcher that came and went (a development double mount) does
    // not take the first one's place away with it.
    watchDoneLists(() => undefined)();
    const first = run(items, wire);
    holdSectionDone(items);
    parkSectionDone(first).send();
    await flush();
    expect(sentIds(wire.batches)).toEqual([["2"]]);
    expect(ids(first.outcomes[0]!.renewed)).toEqual(["1"]);

    // Mail is closed: no list holds a copy, so nothing says a thread changed.
    stop();
    parkSectionDone(run([items[0]!], wire)).send();
    await flush();
    expect(sentIds(wire.batches)).toEqual([["2"], ["1"]]);
  });

  it("takes one letter out of a Done that is waiting, or queued, and lets go of its hold", async () => {
    const first = gate();
    const queued = [
      thread("q-1", { unread: false }),
      thread("q-2", { unread: false, accountId: ACCOUNT_B }),
    ];
    const waiting = ["w-1", "w-2"].map((id) => thread(id, { unread: false }));
    const wire = transport([...queued, ...waiting], {
      before: (batch) => (idsOf(batch)[0] === "q-1" ? first.promise : undefined),
    });
    holdSectionDone([...queued, ...waiting]);
    parkSectionDone(run(queued, wire)).send();
    const ticket = parkSectionDone(run(waiting, wire));
    await flush();

    // In flight: too late, and its hold stays.
    expect(withdrawSectionDone(queued[0]!)).toBe(false);
    expect(withdrawSectionDone(queued[1]!)).toBe(true);
    expect(withdrawSectionDone(waiting[0]!)).toBe(true);
    // Not held at all.
    expect(withdrawSectionDone(thread("elsewhere"))).toBe(false);
    expect(ids(hideDone([...queued, ...waiting], doneOverlaySnapshot()))).toEqual([
      "q-2",
      "w-1",
    ]);

    // Undo gives back what the run still has, and the window closing sends
    // only that.
    ticket.send();
    first.open();
    await flush(40);
    expect(sentIds(wire.batches)).toEqual([["q-1"], ["w-2"]]);
  });

  it("lets every waiting Done go when the page leaves, says so once each, and sends the lot at once", async () => {
    const first = gate();
    const threads = [
      thread("q-1", { unread: false }),
      thread("q-2", { unread: false, accountId: ACCOUNT_B }),
      thread("w-1", { unread: false }),
    ];
    const wire = transport(threads, {
      before: (batch) => (idsOf(batch)[0] === "q-1" ? first.promise : undefined),
    });
    const queued = run(threads.slice(0, 2), wire);
    const waiting = run([threads[2]!], wire);
    parkSectionDone(queued).send();
    const ticket = parkSectionDone(waiting);
    await flush();
    expect(sentIds(wire.batches)).toEqual([["q-1"]]);

    // No Mail surface is asked: the listener is the store's own, so it is
    // there whether Mail is on screen or not, and there is one of it however
    // many times Mail was mounted.
    window.dispatchEvent(new Event("pagehide"));
    expect(sentIds(wire.batches)).toEqual([["q-1"], ["q-2"], ["w-1"]]);
    // The pill a restored page shows must not offer an Undo over archives
    // already out. The run that was already sending had no pill left.
    expect(waiting.respoken).toEqual(["respoken"]);
    expect(queued.respoken).toEqual([]);
    expect(ticket.undo()).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(wire.batches).toHaveLength(3);
    expect(waiting.respoken).toEqual(["respoken"]);
    first.open();
    await flush(40);
  });

  it("says a Done let go early again without its Undo, once", () => {
    const items = [thread("1", { unread: false })];
    const early = run(items, transport(items));
    const ticket = parkSectionDone(early);
    sendSectionDoneEarly(ticket);
    sendSectionDoneEarly(ticket);
    expect(early.respoken).toEqual(["respoken"]);
  });

  it("forgets everything on reset, the page listener included", async () => {
    const items = [thread("1", { unread: false })];
    const wire = transport(items);
    parkSectionDone(run(items, wire));
    holdSectionDone([thread("1")]);
    resetSectionDone();
    expect(doneOverlaySnapshot()).toBe(NO_DONE);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(wire.batches).toEqual([]);
  });
});
