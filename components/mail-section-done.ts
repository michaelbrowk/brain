/**
 * A section's Done, deferred, with no React in it.
 *
 * Pressing Done takes the section out of the column at once and sends
 * nothing: the pill's Undo stands for its window, and only when that window
 * closes do the archives go out, in the background and under no lock. Three
 * things make that work, and all of them live here.
 *
 * The OVERLAY keeps the threads out of every Inbox list while the streams
 * still hold them. Laid over, not written in, for the reason the New senders
 * decisions are (`mail-new-senders.ts`): a list read that left before the
 * press and lands after it would put the rows straight back, and an Undo
 * would have to find and restore every copy it removed. Taking the threads
 * off the overlay is the whole of an Undo, and it cannot fail.
 *
 * The QUEUE sends what a closed window owes the provider: one batch request
 * per account and up to fifty threads, archive and read flag together, one
 * request at a time across every Done still going out. A thread the answer
 * shows got new mail is taken back with requests of its own.
 *
 * The STORE holds both for the page, not for one mount of Mail. A reader who
 * leaves Mail while a Done is still sending and comes back finds the same
 * holds and the same queue: the rows do not show again, and no second queue
 * sends them twice. The page leaving is heard here too, once, whether Mail is
 * on screen or not.
 */

import {
  MAIL_THREAD_BATCH_MAX,
  mailThreadHasNewMail,
  type MailThreadBatchItem,
  type MailThreadBatchPress,
  type MailThreadListItem,
} from "@/lib/mail/message-types";
import { MailApiError, isMailMutationTimeout } from "./mail-surface-client";
import { unifiedThreadKey } from "./mail-unified";

/**
 * One thread a Done holds out of the column. `landedAt` is null until its
 * archive answers, and then the count of Inbox reads begun at that moment:
 * the hold ends on the first read of its account begun after it
 * (`settleDone`).
 */
export type DoneHold = {
  readonly thread: MailThreadListItem;
  readonly landedAt: number | null;
};

/** The threads Done is holding out, keyed by `unifiedThreadKey`. */
export type DoneOverlay = ReadonlyMap<string, DoneHold>;

export const NO_DONE: DoneOverlay = new Map();

/**
 * A list as Done leaves it: the held threads are gone from an Inbox and from
 * the merged Inboxes. All Mail and the other mailboxes still list them. The
 * same array comes back when nothing in it is held, so a render that hid
 * nothing costs nothing downstream.
 */
export function hideDone(
  items: readonly MailThreadListItem[],
  overlay: DoneOverlay,
  options: { readonly inbox: boolean } = { inbox: true },
): readonly MailThreadListItem[] {
  if (!options.inbox || overlay.size === 0) return items;
  const shown = items.filter((item) => !overlay.has(unifiedThreadKey(item)));
  return shown.length === items.length ? items : shown;
}

/** The press: these threads leave the column, and nothing has been sent. */
export function holdDone(
  overlay: DoneOverlay,
  threads: readonly MailThreadListItem[],
): DoneOverlay {
  if (threads.length === 0) return overlay;
  const next = new Map(overlay);
  for (const thread of threads) {
    next.set(unifiedThreadKey(thread), { thread, landedAt: null });
  }
  return next;
}

/** Undo, or an archive that failed: these threads are back in the column. */
export function releaseDone(
  overlay: DoneOverlay,
  threads: readonly MailThreadListItem[],
): DoneOverlay {
  let next: Map<string, DoneHold> | null = null;
  for (const thread of threads) {
    const key = unifiedThreadKey(thread);
    if (!overlay.has(key)) continue;
    next ??= new Map(overlay);
    next.delete(key);
  }
  return next ?? overlay;
}

/**
 * The archive answered for these threads while `readsBegun` Inbox reads had
 * been begun. A thread the overlay no longer holds stays let go.
 */
export function landDone(
  overlay: DoneOverlay,
  threads: readonly MailThreadListItem[],
  readsBegun: number,
): DoneOverlay {
  let next: Map<string, DoneHold> | null = null;
  for (const thread of threads) {
    const key = unifiedThreadKey(thread);
    const held = overlay.get(key);
    if (held === undefined) continue;
    next ??= new Map(overlay);
    next.set(key, { thread: held.thread, landedAt: readsBegun });
  }
  return next ?? overlay;
}

/** One Inbox read as the overlay hears of it: when it began, counted by
 *  `beginDoneRead`, which account it read and what it listed. */
export type DoneRead = {
  readonly startedAt: number;
  readonly accountId: string;
  readonly listed: readonly MailThreadListItem[];
};

/**
 * An Inbox read has landed. A thread of the account it read, whose archive
 * answered before that read began, is the read's to speak for now, the rule
 * the New senders overlay keeps for a block's archive: a key leaves only on a
 * read begun after the answer. A read begun earlier may still list the
 * thread, and the hold is what keeps that row from flashing back.
 *
 * Another account's read says nothing. A refresh of several accounts lands in
 * waves, and one that answered late in it would otherwise end the hold while
 * this account's own read, begun before the archive, was still on its way
 * with the row in it.
 *
 * `gone` is what such a read did not list. Those threads are out of the
 * Inbox, and the caller sweeps them from the lists in the same commit: the
 * lists were never told, and a deep row or one an earlier read put back
 * would show the moment the hold let go. A thread the read does list is in
 * the Inbox again by someone's hand, and it simply shows.
 */
export function settleDone(
  overlay: DoneOverlay,
  read: DoneRead,
): { readonly overlay: DoneOverlay; readonly gone: readonly MailThreadListItem[] } {
  let next: Map<string, DoneHold> | null = null;
  let present: Set<string> | null = null;
  const gone: MailThreadListItem[] = [];
  for (const [key, held] of overlay) {
    if (held.thread.accountId !== read.accountId) continue;
    if (held.landedAt === null || read.startedAt <= held.landedAt) continue;
    present ??= new Set(read.listed.map(unifiedThreadKey));
    next ??= new Map(overlay);
    next.delete(key);
    if (!present.has(key)) gone.push(held.thread);
  }
  return { overlay: next ?? overlay, gone };
}

/**
 * The two mutations that take a thread's Done back when the provider's
 * answer shows new mail, each its own request.
 */
export type DoneMutation =
  | { readonly accountId: string; readonly threadId: string; readonly archive: boolean }
  | { readonly accountId: string; readonly threadId: string; readonly read: boolean };

/** A take-back's transport: one mutation, one request. */
export type DoneSend = (mutation: DoneMutation) => Promise<MailThreadListItem | void>;

/** One account's threads, at most `MAIL_THREAD_BATCH_MAX`, each with what
 *  the press saw of it, to archive, and the ones unread at the press to mark
 *  read with `read`. */
export type DoneBatch = {
  readonly accountId: string;
  readonly threads: readonly MailThreadBatchPress[];
  readonly read: boolean;
};

/**
 * THE TRANSPORT. One batch, one request, answered per thread. The service
 * holds every thread to its press: one with mail the press did not see is
 * left in the Inbox and answers `renewed`, and the read flag goes only on a
 * thread unread at the press. The queue checks every `done` answer against
 * the press all the same.
 */
export type DoneSendBatch = (batch: DoneBatch) => Promise<readonly MailThreadBatchItem[]>;

/**
 * What a failed mutation says about the rest of the run. `changed`: the
 * server no longer recognises the thread. `failed`: this thread only, a bad
 * minute or too many requests. The other four close the account for the run,
 * because its next thread would be answered the same way: `refused`, its
 * server has no folder for the action; `silent`, it did not answer inside
 * the client's deadline; `signed-out`, the session is over; `unreachable`,
 * nothing answered at all.
 */
export type DoneFailure =
  | "changed"
  | "refused"
  | "silent"
  | "signed-out"
  | "unreachable"
  | "failed";

/** Why an account was closed for a run. */
export type DoneClosure = Exclude<DoneFailure, "changed" | "failed">;

const CLOSES: ReadonlySet<DoneFailure> = new Set<DoneFailure>([
  "refused",
  "silent",
  "signed-out",
  "unreachable",
]);

/**
 * Reads a lost mutation. A 409 that names no folder is the account's server
 * answering for every thread on it. A request the client's own clock ended
 * (`MAIL_MUTATION_TIMEOUT_MS`) is an account the next request would sit on
 * just as long. A 401 is the session, and `fetch` rejecting with a TypeError
 * is the network: neither gets better one thread later. Anything else,
 * a 429 included, is that thread's alone.
 */
export function doneFailureOf(error: unknown): DoneFailure {
  if (error instanceof MailApiError) {
    if (error.code === "mail_thread_stale") return "changed";
    if (error.code === "mail_thread_mutation_unsupported") return "refused";
    if (error.status === 401) return "signed-out";
    return "failed";
  }
  if (isMailMutationTimeout(error)) return "silent";
  if (error instanceof TypeError) return "unreachable";
  return "failed";
}

/**
 * Reads one thread a batch answered `failed`, by the code a single request
 * would have carried. A thread the service's deadline left unreached is an
 * account that is slow now, as a request the client's clock ended is.
 */
export function doneBatchFailureOf(errorCode: string): DoneFailure {
  if (errorCode === "mail_thread_mutation_unsupported") return "refused";
  if (errorCode === "request_deadline_exceeded") return "silent";
  return "failed";
}

/** What became of one Done's threads. */
export type DoneOutcome = {
  /** Out of the inbox. */
  readonly moved: readonly MailThreadListItem[];
  /** Still where they were: a failure, or an account closed for the run. */
  readonly stayed: readonly MailThreadListItem[];
  /** No longer what the list said they were, so neither of the above. */
  readonly changed: readonly MailThreadListItem[];
  /** Got new mail after the press: not sent, or sent and taken back. */
  readonly renewed: readonly MailThreadListItem[];
  /** Accounts closed for the run, and why. */
  readonly closed: ReadonlyMap<string, DoneClosure>;
};

/** What one Done hands the queue with its threads. */
export type DoneHooks = {
  readonly sendBatch: DoneSendBatch;
  readonly send: DoneSend;
  /**
   * The copy of a thread the lists hold now, or nothing when no list has
   * one. Asked as each batch is made up: a thread whose copy has another
   * message than the press saw is not sent (`renewed`). A pre-filter that
   * saves a thread; the answers `sendBatch` returns are the check that holds.
   */
  readonly current?: (thread: MailThreadListItem) => MailThreadListItem | undefined;
  /** A thread's archive answered and it stays out of the Inbox. */
  readonly onArchived?: (thread: MailThreadListItem) => void;
  /** A thread got new mail and is back in the Inbox, or never left it. */
  readonly onRenewed?: (thread: MailThreadListItem) => void;
};

export type DoneQueue = {
  /**
   * Sends one Done's threads behind whatever is still going out, and
   * resolves, never rejects, with what became of them.
   */
  commit(threads: readonly MailThreadListItem[], hooks: DoneHooks): Promise<DoneOutcome>;
  /**
   * Takes a thread the queue has not sent yet out of its run, and says
   * whether it did. One already sent, or in flight, is the server's now.
   */
  withdraw(thread: MailThreadListItem): boolean;
  /**
   * The page is leaving. Everything not yet sent, in every Done still
   * waiting, goes at once: a loop that awaits its way through them would be
   * cut at the first request. The account rules do not apply to what leaves
   * this way, since no answer comes back in time to close anything.
   */
  unload(): void;
};

type QueuedRun = {
  readonly rest: MailThreadListItem[];
  readonly atOnce: Promise<void>[];
  readonly hooks: DoneHooks;
  readonly moved: MailThreadListItem[];
  readonly stayed: MailThreadListItem[];
  readonly changed: MailThreadListItem[];
  readonly renewed: MailThreadListItem[];
  readonly closed: Map<string, DoneClosure>;
};

/**
 * Whether a thread has mail the press did not see: more messages, or a newer
 * one. A read flag or a star set elsewhere since is not new mail, and nor is
 * a letter deleted elsewhere.
 */
const gotNewMail = mailThreadHasNewMail;

/** What the press saw of a thread, as the service holds the batch to it. */
function pressOf(thread: MailThreadListItem): MailThreadBatchPress {
  return {
    threadId: thread.threadId,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt,
    unread: thread.unread,
  };
}

/**
 * What the batches a closing page sends may weigh together. A `keepalive`
 * request's body counts against a 64 KiB quota the browser shares with every
 * other such request the page has in flight (a parked draft's, a pending
 * delete's); past it the browser refuses the request outright. Batches past
 * this much stay unsent and their threads stay in the Inbox, the safe way to
 * fall short.
 */
export const DONE_UNLOAD_BUDGET_BYTES = 48 * 1024;

export function doneQueue(failureOf: (error: unknown) => DoneFailure): DoneQueue {
  const open = new Set<QueuedRun>();
  let tail: Promise<unknown> = Promise.resolve();

  const close = (run: QueuedRun, thread: MailThreadListItem, failure: DoneFailure) => {
    if (CLOSES.has(failure) && !run.closed.has(thread.accountId)) {
      run.closed.set(thread.accountId, failure as DoneClosure);
    }
  };

  /* The next batch: the first unsent thread's account, and up to a batch of
     that account's unsent threads, in order. A thread on an account the run
     has closed is not sent, and costs no request for one more refusal. The
     lists are asked what they hold now as each thread is taken; they only
     know what the change feed has told them, so a thread they show with new
     mail is kept back and saves a place in the batch, nothing more. */
  const nextBatch = (run: QueuedRun): MailThreadListItem[] | null => {
    while (run.rest.length > 0) {
      const accountId = run.rest[0]!.accountId;
      const batch: MailThreadListItem[] = [];
      for (let at = 0; at < run.rest.length && batch.length < MAIL_THREAD_BATCH_MAX; ) {
        const thread = run.rest[at]!;
        if (thread.accountId !== accountId) {
          at += 1;
          continue;
        }
        run.rest.splice(at, 1);
        if (run.closed.has(accountId)) {
          run.stayed.push(thread);
          continue;
        }
        const now = run.hooks.current?.(thread);
        if (now !== undefined && gotNewMail(thread, now)) {
          run.renewed.push(thread);
          run.hooks.onRenewed?.(thread);
          continue;
        }
        batch.push(thread);
      }
      if (batch.length > 0) return batch;
    }
    return null;
  };

  const batchOf = (batch: readonly MailThreadListItem[]): DoneBatch => ({
    accountId: batch[0]!.accountId,
    threads: batch.map(pressOf),
    read: batch.some((thread) => thread.unread),
  });

  /* Archive, then read, in one request, and the press travels with it. The
     service holds each thread to what the press saw before it touches the
     provider: a thread whose cached copy already has mail the press did not
     see is left alone, and one that got mail while it was archived is put
     back, in the same request, so a page that closes on the answer loses
     nothing. Such a thread answers `renewed` and its row comes back with no
     request from here. The read flag goes only on a thread unread at the
     press, since a read failure leaves a thread exactly where it was and a
     flag on a reply nobody has seen is the one thing Done must not do.

     A `done` answer is still compared with the press: if the service could
     not put a thread back, the new mail is in that answer, and the thread is
     taken back from here, the read flag first when it went on (the reply is
     the one a reader would miss), then the archive. A reply that lands after
     the answer arrives unread, as new mail does, and is no longer this run's
     to see. */
  const sendBatch = async (run: QueuedRun, batch: readonly MailThreadListItem[]): Promise<void> => {
    const accountId = batch[0]!.accountId;
    let answers: readonly MailThreadBatchItem[];
    try {
      answers = await run.hooks.sendBatch(batchOf(batch));
    } catch (error) {
      const failure = failureOf(error);
      for (const thread of batch) {
        if (failure === "changed") {
          run.changed.push(thread);
          continue;
        }
        close(run, thread, failure);
        run.stayed.push(thread);
      }
      return;
    }
    const byThread = new Map(answers.map((answer) => [answer.threadId, answer]));
    for (const thread of batch) {
      const answer = byThread.get(thread.threadId);
      if (answer === undefined) {
        run.stayed.push(thread);
        continue;
      }
      if (answer.status === "stale") {
        run.changed.push(thread);
        continue;
      }
      if (answer.status === "failed") {
        close(run, thread, doneBatchFailureOf(answer.errorCode));
        run.stayed.push(thread);
        continue;
      }
      if (answer.status === "renewed") {
        run.renewed.push(thread);
        run.hooks.onRenewed?.(thread);
        continue;
      }
      if (gotNewMail(thread, answer.thread)) {
        const key = { accountId, threadId: thread.threadId };
        await takeBack(
          run,
          thread,
          answer.markedRead
            ? [
                { ...key, read: false },
                { ...key, archive: false },
              ]
            : [{ ...key, archive: false }],
        );
        continue;
      }
      run.hooks.onArchived?.(thread);
      run.moved.push(thread);
    }
  };

  /* New mail reached a thread the run already acted on: these mutations
     undo what was sent, and its row comes back. One that fails leaves the
     thread out of the inbox, which is what `moved` says, and its new mail
     arrives the way new mail does. */
  const takeBack = async (
    run: QueuedRun,
    thread: MailThreadListItem,
    undo: readonly DoneMutation[],
  ): Promise<void> => {
    try {
      for (const mutation of undo) await run.hooks.send(mutation);
    } catch (error) {
      close(run, thread, failureOf(error));
      run.moved.push(thread);
      run.hooks.onArchived?.(thread);
      return;
    }
    run.renewed.push(thread);
    run.hooks.onRenewed?.(thread);
  };

  const drain = async (run: QueuedRun): Promise<DoneOutcome> => {
    // A failing thread does not stop the run; a closed account stops its own
    // threads and no other account's.
    for (let batch = nextBatch(run); batch !== null; batch = nextBatch(run)) {
      await sendBatch(run, batch);
    }
    await Promise.all(run.atOnce);
    open.delete(run);
    return run;
  };

  return {
    commit(threads, hooks) {
      const run: QueuedRun = {
        rest: [...threads],
        atOnce: [],
        hooks,
        moved: [],
        stayed: [],
        changed: [],
        renewed: [],
        closed: new Map(),
      };
      open.add(run);
      const done = tail.then(() => drain(run));
      tail = done.catch(() => undefined);
      return done;
    },
    withdraw(thread) {
      const key = unifiedThreadKey(thread);
      for (const run of open) {
        const at = run.rest.findIndex((item) => unifiedThreadKey(item) === key);
        if (at < 0) continue;
        run.rest.splice(at, 1);
        return true;
      }
      return false;
    },
    unload() {
      let budget = DONE_UNLOAD_BUDGET_BYTES;
      for (const run of open) {
        for (let batch = nextBatch(run); batch !== null; batch = nextBatch(run)) {
          const bytes = new TextEncoder().encode(
            JSON.stringify({ ...batchOf(batch), archive: true }),
          ).length;
          if (bytes > budget) {
            // Not sent: these stay in the Inbox, and a page that comes back
            // from the back-forward cache sends them with the rest of its run.
            run.rest.unshift(...batch);
            return;
          }
          budget -= bytes;
          run.atOnce.push(sendBatch(run, batch));
        }
      }
    },
  };
}

/* ── The store ──────────────────────────────────────────────────────────── */

/**
 * One Done, from the press to its report: the section it named, what will be
 * sent for it, how many of its rows sit on an account that cannot move them,
 * and the three things only the surface that pressed it can do.
 *
 * `threads` is the run's own list and is the one thing here that changes: a
 * letter asked for while the run waits is taken out of it
 * (`withdrawSectionDone`).
 */
export type SectionDoneRun = {
  readonly label: string;
  readonly threads: MailThreadListItem[];
  readonly blocked: number;
  /** The transports of the surface that pressed Done: the batch, and the
   *  single mutation a take-back needs. */
  readonly sendBatch: DoneSendBatch;
  readonly send: DoneSend;
  /** Says the press-time sentence again without its Undo. */
  readonly respeak: () => void;
  /** A thread got new mail and is in the Inbox: put its row back. */
  readonly onRenewed?: (thread: MailThreadListItem) => void;
  /** The run has landed. */
  readonly onSettled: (outcome: DoneOutcome) => void;
};

/**
 * A Done waiting behind its pill's Undo. It settles exactly once, one of two
 * ways (the shape `mail-deferred-discard.ts` gives a parked draft delete):
 * `undo` hands back the threads to put back in the column and nothing is
 * ever sent, or `send` gives the run to the queue and Undo has nothing left
 * to hand back. The window running out, a second Done, the surface
 * unmounting, the page leaving and a stale pill can all reach the same
 * ticket, so every call after the first is a no-op.
 */
export type SectionDoneTicket = {
  readonly run: SectionDoneRun;
  /** The threads to release, once; `null` when the Done has already settled. */
  undo(): readonly MailThreadListItem[] | null;
  /** Hands the run to the queue, once. Whether this call was the one. */
  send(): boolean;
};

/** The copy of a thread a surface's lists hold now, if they hold one. */
export type DoneLists = (thread: MailThreadListItem) => MailThreadListItem | undefined;

type Store = {
  overlay: DoneOverlay;
  readonly listeners: Set<() => void>;
  queue: DoneQueue;
  readonly waiting: Set<SectionDoneTicket>;
  readsBegun: number;
  readonly lists: DoneLists[];
  listening: boolean;
};

const store: Store = {
  overlay: NO_DONE,
  listeners: new Set(),
  queue: doneQueue(doneFailureOf),
  waiting: new Set(),
  readsBegun: 0,
  lists: [],
  listening: false,
};

function setOverlay(next: DoneOverlay): void {
  if (next === store.overlay) return;
  store.overlay = next;
  for (const listener of [...store.listeners]) listener();
}

/** The holds as they stand: the snapshot `useSyncExternalStore` reads. */
export function doneOverlaySnapshot(): DoneOverlay {
  return store.overlay;
}

/** No Done can be waiting before the browser has run. */
export function doneOverlayServerSnapshot(): DoneOverlay {
  return NO_DONE;
}

export function subscribeDoneOverlay(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/** The press: these threads leave every Inbox list. */
export function holdSectionDone(threads: readonly MailThreadListItem[]): void {
  setOverlay(holdDone(store.overlay, threads));
}

/** Undo, a failed archive, new mail: these threads are back. */
export function releaseSectionDone(threads: readonly MailThreadListItem[]): void {
  setOverlay(releaseDone(store.overlay, threads));
}

/** These threads are no longer the column's to show, as of now: an archive
 *  answered, or the server no longer recognises them. */
export function landSectionDone(threads: readonly MailThreadListItem[]): void {
  setOverlay(landDone(store.overlay, threads, store.readsBegun));
}

/**
 * An Inbox read is leaving. Counted here and not by the surface that makes
 * it, so a hold landed under one mount of Mail is measured against the reads
 * of the next one on the same clock.
 */
export function beginDoneRead(): number {
  store.readsBegun += 1;
  return store.readsBegun;
}

/** That read landed. Returns the threads to sweep from the lists
 *  (`settleDone`). */
export function doneReadLanded(read: DoneRead): readonly MailThreadListItem[] {
  const settled = settleDone(store.overlay, read);
  setOverlay(settled.overlay);
  return settled.gone;
}

/**
 * The surface that has lists says so, and the queue asks it for the copy
 * they hold before each send. The last to arrive is the one asked, and one
 * that leaves takes only itself away, so a development double mount cannot
 * leave the queue asking nobody, or asking a surface that is gone.
 */
export function watchDoneLists(lookup: DoneLists): () => void {
  store.lists.push(lookup);
  return () => {
    const at = store.lists.lastIndexOf(lookup);
    if (at >= 0) store.lists.splice(at, 1);
  };
}

function commitRun(run: SectionDoneRun): void {
  void store.queue
    .commit(run.threads, {
      sendBatch: run.sendBatch,
      send: run.send,
      current: (thread) => store.lists.at(-1)?.(thread),
      onArchived: (thread) => landSectionDone([thread]),
      onRenewed: run.onRenewed,
    })
    .then(run.onSettled);
}

/* THE PAGE LEAVING, HEARD ONCE. Whatever is still waiting behind an Undo
   goes to the queue and its pill is said again without one (the page may
   come back from the back-forward cache with this very DOM), and then the
   queue sends everything it has not sent, in the same task. The listener is
   the store's own, added the first time a Done needs it: a surface's
   listener goes with the surface, and a reader who pressed Done, left Mail
   and closed the tab would leave the unsent tail behind. */
function onPageHide(): void {
  for (const ticket of [...store.waiting]) sendSectionDoneEarly(ticket);
  store.queue.unload();
}

function listenForPageHide(): void {
  if (store.listening || typeof window === "undefined") return;
  store.listening = true;
  window.addEventListener("pagehide", onPageHide);
}

/** Parks a Done behind its pill. Nothing is sent, and nothing is held: the
 *  surface holds the threads in the same commit that moves the column. */
export function parkSectionDone(run: SectionDoneRun): SectionDoneTicket {
  listenForPageHide();
  let state: "parked" | "undone" | "sent" = "parked";
  const ticket: SectionDoneTicket = {
    run,
    undo() {
      if (state !== "parked") return null;
      state = "undone";
      store.waiting.delete(ticket);
      return [...run.threads];
    },
    send() {
      if (state !== "parked") return false;
      state = "sent";
      store.waiting.delete(ticket);
      commitRun(run);
      return true;
    },
  };
  store.waiting.add(ticket);
  return ticket;
}

/**
 * The way back is gone before its window ran out: a second Done was pressed,
 * the surface is unmounting, or the page is leaving. The run goes to the
 * queue now, and the sentence is said again without an Undo, so no pill is
 * left offering a way back over archives already out.
 */
export function sendSectionDoneEarly(ticket: SectionDoneTicket): void {
  if (ticket.send()) ticket.run.respeak();
}

/**
 * Someone asked for a letter Done is holding: a notification pressed, the
 * palette, a link. If nothing has been sent for it yet it comes out of its
 * run and off the overlay, and says so; the caller opens it. One whose
 * archive is in flight or has answered is the server's now.
 */
export function withdrawSectionDone(thread: MailThreadListItem): boolean {
  const key = unifiedThreadKey(thread);
  const held = store.overlay.get(key);
  if (held === undefined) return false;
  let withdrawn = false;
  for (const ticket of store.waiting) {
    const at = ticket.run.threads.findIndex((item) => unifiedThreadKey(item) === key);
    if (at < 0) continue;
    ticket.run.threads.splice(at, 1);
    withdrawn = true;
    break;
  }
  withdrawn ||= store.queue.withdraw(thread);
  if (withdrawn) releaseSectionDone([held.thread]);
  return withdrawn;
}

/**
 * Forgets every hold, every waiting Done and the page listener. For tests,
 * which share this module the way a session's mounts of Mail do: without it
 * one case's holds would hide another case's rows. A run still out keeps
 * sending on the queue it was given and reports to whoever pressed it.
 */
export function resetSectionDone(): void {
  store.waiting.clear();
  store.queue = doneQueue(doneFailureOf);
  store.readsBegun = 0;
  store.lists.length = 0;
  if (store.listening && typeof window !== "undefined") {
    window.removeEventListener("pagehide", onPageHide);
  }
  store.listening = false;
  setOverlay(NO_DONE);
}
