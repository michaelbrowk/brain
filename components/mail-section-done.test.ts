import { describe, expect, it, vi } from "vitest";
import {
  NO_DONE,
  doneQueue,
  hideDone,
  holdDone,
  landDone,
  releaseDone,
  settleDone,
  type DoneFailure,
  type DoneMutation,
} from "./mail-section-done";
import type { MailThreadListItem } from "@/lib/mail/message-types";

// A section's Done, deferred. The rows leave the column at the press and
// nothing is sent until the pill's window closes, so two things are pinned
// here with no React in them: the overlay that keeps the rows out of every
// Inbox list while the streams still hold them, and the queue that sends the
// mutations afterwards, one at a time, under no lock.

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

describe("the Done overlay", () => {
  it("takes held threads out of an Inbox list and hands the same list back when it holds none", () => {
    const items = [thread("1"), thread("2"), thread("3")];
    const held = holdDone(NO_DONE, [items[1]!]);
    expect(ids(hideDone(items, held))).toEqual(["1", "3"]);
    expect(hideDone(items, NO_DONE)).toBe(items);
    expect(hideDone([items[0]!, items[2]!], held)).toHaveLength(2);
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
    const settled = settleDone(held, 7, items);
    expect(settled.overlay).toBe(held);
    expect(settled.gone).toEqual([]);
  });

  it("keeps an archived thread out until a read begun after the archive answered lands", () => {
    const items = [thread("1"), thread("2")];
    const landed = landDone(holdDone(NO_DONE, items), [items[0]!], 4);
    // Read four began before the answer and may still list the thread.
    const stale = settleDone(landed, 4, items);
    expect(stale.overlay).toBe(landed);
    expect(stale.gone).toEqual([]);

    // Read five began after it. The thread it does not list is gone from
    // the Inbox, so the hold ends and the lists are swept of it.
    const fresh = settleDone(landed, 5, [items[1]!]);
    expect(ids(hideDone(items, fresh.overlay))).toEqual(["1"]);
    expect(ids(fresh.gone)).toEqual(["1"]);
  });

  it("lets a thread a later read lists back into the column, and sweeps nothing", () => {
    // Listed by a read begun after the archive: someone moved it back, and
    // that read says so better than the overlay does.
    const items = [thread("1")];
    const landed = landDone(holdDone(NO_DONE, items), items, 4);
    const fresh = settleDone(landed, 5, items);
    expect(hideDone(items, fresh.overlay)).toBe(items);
    expect(fresh.gone).toEqual([]);
  });

  it("does not mark a thread it no longer holds as archived", () => {
    const items = [thread("1")];
    expect(landDone(NO_DONE, items, 3)).toBe(NO_DONE);
  });
});

describe("the Done queue", () => {
  function recorder(
    answer: (mutation: DoneMutation) => Promise<void> | void = () => {},
  ) {
    const sent: Array<{ mutation: DoneMutation; keepalive: boolean }> = [];
    const send = vi.fn(async (mutation: DoneMutation, options: { keepalive: boolean }) => {
      sent.push({ mutation, keepalive: options.keepalive });
      await answer(mutation);
    });
    return { sent, send };
  }

  const failureOf = (error: unknown): DoneFailure =>
    error instanceof Error &&
    (error.message === "changed" || error.message === "refused" || error.message === "silent")
      ? error.message
      : "failed";

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

  it("archives each thread and then marks it read, one request at a time, in order", async () => {
    const { sent, send } = recorder();
    const queue = doneQueue(send, failureOf);
    const threads = [thread("1"), thread("2", { unread: false }), thread("3")];
    const outcome = await queue.commit(threads, () => {});

    expect(sent.map((entry) => entry.mutation)).toEqual([
      { accountId: ACCOUNT_A, threadId: "1", archive: true },
      { accountId: ACCOUNT_A, threadId: "1", read: true },
      // Already read: the archive is the whole of it.
      { accountId: ACCOUNT_A, threadId: "2", archive: true },
      { accountId: ACCOUNT_A, threadId: "3", archive: true },
      { accountId: ACCOUNT_A, threadId: "3", read: true },
    ]);
    expect(sent.every((entry) => !entry.keepalive)).toBe(true);
    expect(ids(outcome.moved)).toEqual(["1", "2", "3"]);
    expect(outcome.stayed).toEqual([]);
    expect(outcome.changed).toEqual([]);
  });

  it("says a thread is archived when its archive answers, before the read flag goes out", async () => {
    const read = gate();
    const { send } = recorder((mutation) => ("read" in mutation ? read.promise : undefined));
    const queue = doneQueue(send, failureOf);
    const archived: string[] = [];
    const done = queue.commit([thread("1")], (item) => archived.push(item.threadId));
    await flush();
    expect(archived).toEqual(["1"]);
    read.open();
    await done;
  });

  it("leaves a failed thread where it was, unread, and keeps going", async () => {
    const { sent, send } = recorder((mutation) => {
      if (mutation.threadId === "2") throw new Error("provider said no");
    });
    const queue = doneQueue(send, failureOf);
    const outcome = await queue.commit([thread("1"), thread("2"), thread("3")], () => {});
    expect(sent.filter((entry) => entry.mutation.threadId === "2")).toHaveLength(1);
    expect(ids(outcome.moved)).toEqual(["1", "3"]);
    expect(ids(outcome.stayed)).toEqual(["2"]);
    expect(outcome.refused.size).toBe(0);
  });

  it("closes an account for the run at its first refusal, and still sends the other account's", async () => {
    const { sent, send } = recorder((mutation) => {
      if (mutation.accountId === ACCOUNT_A) throw new Error("refused");
    });
    const queue = doneQueue(send, failureOf);
    const outcome = await queue.commit(
      [thread("1"), thread("2", { accountId: ACCOUNT_B }), thread("3")],
      () => {},
    );
    expect(sent.filter((entry) => entry.mutation.accountId === ACCOUNT_A)).toHaveLength(1);
    expect(ids(outcome.moved)).toEqual(["2"]);
    expect(ids(outcome.stayed)).toEqual(["1", "3"]);
    expect([...outcome.refused]).toEqual([ACCOUNT_A]);
  });

  it("closes an account that stopped answering, on the archive or on the read after it", async () => {
    const onArchive = recorder((mutation) => {
      if (mutation.threadId === "1") throw new Error("silent");
    });
    const first = await doneQueue(onArchive.send, failureOf).commit(
      [thread("1"), thread("2")],
      () => {},
    );
    expect(onArchive.sent).toHaveLength(1);
    expect(ids(first.stayed)).toEqual(["1", "2"]);
    expect([...first.silent]).toEqual([ACCOUNT_A]);

    // The archive landed and the read flag went unanswered: the thread is
    // out of the inbox either way, and the account is still closed.
    const onRead = recorder((mutation) => {
      if ("read" in mutation) throw new Error("silent");
    });
    const second = await doneQueue(onRead.send, failureOf).commit(
      [thread("1"), thread("2")],
      () => {},
    );
    expect(onRead.sent).toHaveLength(2);
    expect(ids(second.moved)).toEqual(["1"]);
    expect(ids(second.stayed)).toEqual(["2"]);
    expect([...second.silent]).toEqual([ACCOUNT_A]);
  });

  it("names a thread the server no longer recognises apart from one that stayed", async () => {
    const { send } = recorder((mutation) => {
      if (mutation.threadId === "2") throw new Error("changed");
    });
    const outcome = await doneQueue(send, failureOf).commit(
      [thread("1", { unread: false }), thread("2"), thread("3", { unread: false })],
      () => {},
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
    const queue = doneQueue(send, failureOf);
    const one = queue.commit([thread("a-1", { unread: false })], () => {});
    const two = queue.commit([thread("b-1", { unread: false })], () => {});
    await flush();
    expect(sent.map((entry) => entry.mutation.threadId)).toEqual(["a-1"]);
    first.open();
    await Promise.all([one, two]);
    expect(sent.map((entry) => entry.mutation.threadId)).toEqual(["a-1", "b-1"]);
  });

  it("sends everything still waiting at once, with keepalive, when the page leaves", async () => {
    const first = gate();
    const { sent, send } = recorder((mutation) =>
      mutation.threadId === "a-1" && "archive" in mutation ? first.promise : undefined,
    );
    const queue = doneQueue(send, failureOf);
    const one = queue.commit(
      [thread("a-1", { unread: false }), thread("a-2", { unread: false })],
      () => {},
    );
    const two = queue.commit([thread("b-1", { unread: false })], () => {});
    await flush();
    expect(sent).toHaveLength(1);

    // The request in flight is already out. What the loop had not reached,
    // in this run and in the one behind it, leaves in the same task.
    queue.unload();
    expect(sent.map((entry) => [entry.mutation.threadId, entry.keepalive])).toEqual([
      ["a-1", false],
      ["a-2", true],
      ["b-1", true],
    ]);

    // A page that comes back finds every thread accounted for, once.
    first.open();
    const outcomes = await Promise.all([one, two]);
    expect(sent).toHaveLength(3);
    expect(ids(outcomes[0].moved).sort()).toEqual(["a-1", "a-2"]);
    expect(ids(outcomes[1].moved)).toEqual(["b-1"]);
  });
});
