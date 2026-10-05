// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_DONE,
  beginDoneRead,
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
  type DoneFailure,
  type DoneMutation,
  type DoneOutcome,
  type SectionDoneRun,
} from "./mail-section-done";
import { MailApiError } from "./mail-surface-client";
import type { MailThreadListItem } from "@/lib/mail/message-types";

// A section's Done, deferred. The rows leave the column at the press and
// nothing is sent until the pill's window closes, so three things are pinned
// here with no React in them: the overlay that keeps the rows out of every
// Inbox list while the streams still hold them, the queue that sends the
// mutations afterwards, one at a time, under no lock, and the store that
// keeps both for the page rather than for one mount of Mail.

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

/** A transport that records every mutation. `answer` may throw, wait, or
 *  return the thread as the server would after applying it. */
function recorder(
  answer: (
    mutation: DoneMutation,
  ) => Promise<MailThreadListItem | void> | MailThreadListItem | void = () => {},
) {
  const sent: DoneMutation[] = [];
  const send = vi.fn(async (mutation: DoneMutation) => {
    sent.push(mutation);
    return await answer(mutation);
  });
  return { sent, send };
}

const said = (sent: readonly DoneMutation[]) =>
  sent.map((mutation) => {
    const { accountId: _account, threadId, ...rest } = mutation;
    return `${threadId}:${Object.entries(rest)
      .map(([field, value]) => `${field}=${String(value)}`)
      .join(",")}`;
  });

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
});

describe("the Done queue", () => {
  const failureOf = (error: unknown): DoneFailure =>
    error instanceof Error &&
    ["changed", "refused", "silent", "signed-out", "unreachable"].includes(error.message)
      ? (error.message as DoneFailure)
      : "failed";

  const hooks = (send: ReturnType<typeof recorder>["send"]) => ({ send });

  it("archives each thread and then marks it read, one request at a time, in order", async () => {
    const { sent, send } = recorder();
    const queue = doneQueue(failureOf);
    const threads = [thread("1"), thread("2", { unread: false }), thread("3")];
    const outcome = await queue.commit(threads, hooks(send));

    expect(sent).toEqual([
      { accountId: ACCOUNT_A, threadId: "1", archive: true },
      { accountId: ACCOUNT_A, threadId: "1", read: true },
      // Already read: the archive is the whole of it.
      { accountId: ACCOUNT_A, threadId: "2", archive: true },
      { accountId: ACCOUNT_A, threadId: "3", archive: true },
      { accountId: ACCOUNT_A, threadId: "3", read: true },
    ]);
    expect(ids(outcome.moved)).toEqual(["1", "2", "3"]);
    expect(outcome.stayed).toEqual([]);
    expect(outcome.changed).toEqual([]);
    expect(outcome.renewed).toEqual([]);
    expect(outcome.closed.size).toBe(0);
  });

  it("says a thread is archived when its archive answers, before the read flag goes out", async () => {
    const read = gate();
    const { send } = recorder((mutation) => ("read" in mutation ? read.promise : undefined));
    const queue = doneQueue(failureOf);
    const archived: string[] = [];
    const done = queue.commit([thread("1")], {
      send,
      onArchived: (item) => archived.push(item.threadId),
    });
    await flush();
    expect(archived).toEqual(["1"]);
    read.open();
    await done;
  });

  it("does not send a thread that got new mail since the press, and says which", async () => {
    // The press took a snapshot. A reply that arrived inside the window is on
    // the copy the lists hold now, and archiving the thread would file that
    // reply away, read, before anyone saw it.
    const { sent, send } = recorder();
    const queue = doneQueue(failureOf);
    const threads = [thread("1"), thread("2"), thread("3"), thread("4")];
    const now = new Map<string, MailThreadListItem>([
      // A reply: one more message.
      ["1", { ...threads[0]!, messageCount: 2, lastMessageAt: 9 }],
      // The same letter, read elsewhere since: nothing new in it.
      ["2", { ...threads[1]!, unread: false }],
      // The same count and a later date: a message replaced another.
      ["4", { ...threads[3]!, lastMessageAt: 9 }],
    ]);
    const renewed: string[] = [];
    const outcome = await queue.commit(threads, {
      send,
      // No copy of "3" in any list: nothing says it changed, so it goes.
      current: (item) => now.get(item.threadId),
      onRenewed: (item) => renewed.push(item.threadId),
    });
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["2", "2", "3", "3"]);
    expect(ids(outcome.moved)).toEqual(["2", "3"]);
    expect(ids(outcome.renewed)).toEqual(["1", "4"]);
    expect(renewed).toEqual(["1", "4"]);
    expect(outcome.stayed).toEqual([]);
  });

  it("looks at the lists again before each send, not once for the run", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "1" ? first.promise : undefined,
    );
    const queue = doneQueue(failureOf);
    const threads = [thread("1", { unread: false }), thread("2", { unread: false })];
    let reply = false;
    const done = queue.commit(threads, {
      send,
      current: (item) =>
        reply && item.threadId === "2" ? { ...item, messageCount: 2 } : item,
    });
    await flush();
    // The reply lands while the first archive is still out.
    reply = true;
    first.open();
    const outcome = await done;
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["1"]);
    expect(ids(outcome.renewed)).toEqual(["2"]);
  });

  it("takes an archive back when the server's answer carries mail the press did not see", async () => {
    // No list has heard of the reply: the reader is in another account, out
    // of Mail, or the change feed has not caught up. The archive's own answer
    // is the provider reading the thread after it moved it, and it has the
    // reply in it.
    const threads = [thread("1"), thread("2")];
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "1" && "archive" in mutation && mutation.archive
        ? { ...threads[0]!, messageCount: 2, lastMessageAt: 9 }
        : mutation.threadId === "2"
          ? { ...threads[1]!, unread: "read" in mutation ? false : true }
          : undefined,
    );
    const archived: string[] = [];
    const renewed: string[] = [];
    const outcome = await doneQueue(failureOf).commit(threads, {
      send,
      onArchived: (item) => archived.push(item.threadId),
      onRenewed: (item) => renewed.push(item.threadId),
    });
    expect(said(sent)).toEqual([
      "1:archive=true",
      // Back to the Inbox, and no read flag over the reply.
      "1:archive=false",
      "2:archive=true",
      "2:read=true",
    ]);
    expect(ids(outcome.renewed)).toEqual(["1"]);
    expect(ids(outcome.moved)).toEqual(["2"]);
    expect(renewed).toEqual(["1"]);
    expect(archived).toEqual(["2"]);
    expect(outcome.stayed).toEqual([]);
  });

  it("takes the read flag and the archive back when a reply lands between the two", async () => {
    // The archive's answer is the press's thread. The read flag acts on the
    // whole thread, the reply included, and its answer shows the reply.
    const pressed = thread("1");
    const { sent, send } = recorder((mutation) =>
      "read" in mutation && mutation.read
        ? { ...pressed, unread: false, messageCount: 2, lastMessageAt: 9 }
        : pressed,
    );
    const renewed: string[] = [];
    const outcome = await doneQueue(failureOf).commit([pressed], {
      send,
      onRenewed: (item) => renewed.push(item.threadId),
    });
    expect(said(sent)).toEqual([
      "1:archive=true",
      "1:read=true",
      "1:read=false",
      "1:archive=false",
    ]);
    expect(ids(outcome.renewed)).toEqual(["1"]);
    expect(outcome.moved).toEqual([]);
    expect(renewed).toEqual(["1"]);
  });

  it("counts a thread it could not take back as moved, and closes its account as any failure would", async () => {
    // The archive went and the way back did not: the thread is out of the
    // inbox, which is what `moved` says, and its new mail arrives as new
    // mail does.
    const threads = [thread("1", { unread: false }), thread("2", { unread: false })];
    const { sent, send } = recorder((mutation) => {
      if ("archive" in mutation && !mutation.archive) throw new Error("silent");
      return { ...threads[0]!, messageCount: 2 };
    });
    const renewed: string[] = [];
    const archived: string[] = [];
    const outcome = await doneQueue(failureOf).commit(threads, {
      send,
      onArchived: (item) => archived.push(item.threadId),
      onRenewed: (item) => renewed.push(item.threadId),
    });
    expect(said(sent)).toEqual(["1:archive=true", "1:archive=false"]);
    expect(ids(outcome.moved)).toEqual(["1"]);
    expect(archived).toEqual(["1"]);
    expect(renewed).toEqual([]);
    expect(ids(outcome.stayed)).toEqual(["2"]);
    expect([...outcome.closed]).toEqual([[ACCOUNT_A, "silent"]]);
  });

  it("leaves a failed thread where it was, unread, and keeps going", async () => {
    const { sent, send } = recorder((mutation) => {
      if (mutation.threadId === "2") throw new Error("provider said no");
    });
    const queue = doneQueue(failureOf);
    const outcome = await queue.commit([thread("1"), thread("2"), thread("3")], hooks(send));
    expect(sent.filter((mutation) => mutation.threadId === "2")).toHaveLength(1);
    expect(ids(outcome.moved)).toEqual(["1", "3"]);
    expect(ids(outcome.stayed)).toEqual(["2"]);
    expect(outcome.closed.size).toBe(0);
  });

  // No folder for the action, no answer inside the deadline, a session that
  // is over, a server nothing reached: each is as true of the next thread.
  it.each(["refused", "silent", "signed-out", "unreachable"] as const)(
    "closes an account for the run at its first %s answer, and still sends the other account's",
    async (failure) => {
      const { sent, send } = recorder((mutation) => {
        if (mutation.accountId === ACCOUNT_A) throw new Error(failure);
      });
      const queue = doneQueue(failureOf);
      const outcome = await queue.commit(
        [thread("1"), thread("2", { accountId: ACCOUNT_B }), thread("3")],
        hooks(send),
      );
      // One attempt on A, not one per thread.
      expect(sent.filter((mutation) => mutation.accountId === ACCOUNT_A)).toHaveLength(1);
      expect(ids(outcome.moved)).toEqual(["2"]);
      expect(ids(outcome.stayed)).toEqual(["1", "3"]);
      expect([...outcome.closed]).toEqual([[ACCOUNT_A, failure]]);
    },
  );

  it("closes an account that stopped answering on the read after an archive too", async () => {
    // The archive landed and the read flag went unanswered: the thread is
    // out of the inbox either way, and the account is still closed.
    const { sent, send } = recorder((mutation) => {
      if ("read" in mutation) throw new Error("silent");
    });
    const outcome = await doneQueue(failureOf).commit(
      [thread("1"), thread("2")],
      hooks(send),
    );
    expect(sent).toHaveLength(2);
    expect(ids(outcome.moved)).toEqual(["1"]);
    expect(ids(outcome.stayed)).toEqual(["2"]);
    expect([...outcome.closed]).toEqual([[ACCOUNT_A, "silent"]]);
  });

  it("names a thread the server no longer recognises apart from one that stayed", async () => {
    const { send } = recorder((mutation) => {
      if (mutation.threadId === "2") throw new Error("changed");
    });
    const outcome = await doneQueue(failureOf).commit(
      [thread("1", { unread: false }), thread("2"), thread("3", { unread: false })],
      hooks(send),
    );
    expect(ids(outcome.moved)).toEqual(["1", "3"]);
    expect(ids(outcome.changed)).toEqual(["2"]);
    expect(outcome.stayed).toEqual([]);
  });

  it("sends a second Done's threads only after the first one's", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "a-1" ? first.promise : undefined,
    );
    const queue = doneQueue(failureOf);
    const one = queue.commit([thread("a-1", { unread: false })], hooks(send));
    const two = queue.commit([thread("b-1", { unread: false })], hooks(send));
    await flush();
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["a-1"]);
    first.open();
    await Promise.all([one, two]);
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["a-1", "b-1"]);
  });

  it("takes a thread it has not sent out of the run, and not one it has", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "1" ? first.promise : undefined,
    );
    const queue = doneQueue(failureOf);
    const threads = [1, 2, 3].map((index) => thread(String(index), { unread: false }));
    const done = queue.commit(threads, hooks(send));
    await flush();
    // In flight: its outcome is the server's now.
    expect(queue.withdraw(threads[0]!)).toBe(false);
    expect(queue.withdraw(threads[2]!)).toBe(true);
    expect(queue.withdraw(threads[2]!)).toBe(false);
    first.open();
    const outcome = await done;
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["1", "2"]);
    // Withdrawn is not a failure: it is in none of the run's accounts.
    expect(ids(outcome.moved)).toEqual(["1", "2"]);
    expect(outcome.stayed).toEqual([]);
    expect(outcome.renewed).toEqual([]);
  });

  it("sends everything still waiting at once when the page leaves", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "a-1" && "archive" in mutation ? first.promise : undefined,
    );
    const queue = doneQueue(failureOf);
    const one = queue.commit(
      [thread("a-1", { unread: false }), thread("a-2", { unread: false })],
      hooks(send),
    );
    const two = queue.commit([thread("b-1", { unread: false })], hooks(send));
    await flush();
    expect(sent).toHaveLength(1);

    // The request in flight is already out. What the loop had not reached,
    // in this run and in the one behind it, leaves in the same task.
    queue.unload();
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["a-1", "a-2", "b-1"]);

    // A page that comes back finds every thread accounted for, once.
    first.open();
    const outcomes = await Promise.all([one, two]);
    expect(sent).toHaveLength(3);
    expect(ids(outcomes[0].moved).sort()).toEqual(["a-1", "a-2"]);
    expect(ids(outcomes[1].moved)).toEqual(["b-1"]);
  });
});

describe("the Done store", () => {
  afterEach(() => resetSectionDone());

  function run(
    threads: readonly MailThreadListItem[],
    send: ReturnType<typeof recorder>["send"],
    overrides: Partial<SectionDoneRun> = {},
  ): SectionDoneRun & { readonly outcomes: DoneOutcome[]; readonly respoken: string[] } {
    const outcomes: DoneOutcome[] = [];
    const respoken: string[] = [];
    return {
      label: "Newsletters",
      threads: [...threads],
      blocked: 0,
      send,
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
    const { sent, send } = recorder();
    const items = [thread("1", { unread: false })];
    const undone = parkSectionDone(run(items, send));
    await flush();
    expect(sent).toEqual([]);
    expect(undone.undo()).toEqual(items);
    // Settled: a stale pill, an expiry and a page leaving all find nothing.
    expect(undone.undo()).toBeNull();
    expect(undone.send()).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(sent).toEqual([]);

    const gone = parkSectionDone(run(items, send));
    expect(gone.send()).toBe(true);
    expect(gone.send()).toBe(false);
    expect(gone.undo()).toBeNull();
    await flush();
    expect(sent).toEqual([{ accountId: ACCOUNT_A, threadId: "1", archive: true }]);
  });

  it("marks an archive landed against the reads begun so far, and ends the hold on that account's next read", async () => {
    const { send } = recorder();
    const items = [thread("1", { unread: false })];
    holdSectionDone(items);
    const before = beginDoneRead();
    const ticket = parkSectionDone(run(items, send));
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
    const { sent, send } = recorder();
    const items = [thread("1", { unread: false }), thread("2", { unread: false })];
    const stop = watchDoneLists((item) =>
      item.threadId === "1" ? { ...item, messageCount: 2 } : item,
    );
    // A second watcher that came and went (a development double mount) does
    // not take the first one's place away with it.
    watchDoneLists(() => undefined)();
    const first = run(items, send);
    holdSectionDone(items);
    parkSectionDone(first).send();
    await flush();
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["2"]);
    expect(ids(first.outcomes[0]!.renewed)).toEqual(["1"]);

    // Mail is closed: no list holds a copy, so nothing says a thread changed.
    stop();
    parkSectionDone(run([items[0]!], send)).send();
    await flush();
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["2", "1"]);
  });

  it("takes one letter out of a Done that is waiting, or queued, and lets go of its hold", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "q-1" ? first.promise : undefined,
    );
    const queued = ["q-1", "q-2"].map((id) => thread(id, { unread: false }));
    const waiting = ["w-1", "w-2"].map((id) => thread(id, { unread: false }));
    holdSectionDone([...queued, ...waiting]);
    parkSectionDone(run(queued, send)).send();
    const ticket = parkSectionDone(run(waiting, send));
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
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["q-1", "w-2"]);
  });

  it("lets every waiting Done go when the page leaves, says so once each, and sends the lot at once", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "q-1" ? first.promise : undefined,
    );
    const queued = run(
      ["q-1", "q-2"].map((id) => thread(id, { unread: false })),
      send,
    );
    const waiting = run([thread("w-1", { unread: false })], send);
    parkSectionDone(queued).send();
    const ticket = parkSectionDone(waiting);
    await flush();
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["q-1"]);

    // No Mail surface is asked: the listener is the store's own, so it is
    // there whether Mail is on screen or not, and there is one of it however
    // many times Mail was mounted.
    window.dispatchEvent(new Event("pagehide"));
    expect(sent.map((mutation) => mutation.threadId)).toEqual(["q-1", "q-2", "w-1"]);
    // The pill a restored page shows must not offer an Undo over archives
    // already out. The run that was already sending had no pill left.
    expect(waiting.respoken).toEqual(["respoken"]);
    expect(queued.respoken).toEqual([]);
    expect(ticket.undo()).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(sent).toHaveLength(3);
    expect(waiting.respoken).toEqual(["respoken"]);
    first.open();
    await flush(40);
  });

  it("says a Done let go early again without its Undo, once", () => {
    const { send } = recorder();
    const early = run([thread("1", { unread: false })], send);
    const ticket = parkSectionDone(early);
    sendSectionDoneEarly(ticket);
    sendSectionDoneEarly(ticket);
    expect(early.respoken).toEqual(["respoken"]);
  });

  it("forgets everything on reset, the page listener included", async () => {
    const { sent, send } = recorder();
    parkSectionDone(run([thread("1", { unread: false })], send));
    holdSectionDone([thread("1")]);
    resetSectionDone();
    expect(doneOverlaySnapshot()).toBe(NO_DONE);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(sent).toEqual([]);
  });
});
