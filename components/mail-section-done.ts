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
 * The QUEUE sends what a closed window owes the provider: per thread an
 * archive and then, for an unread one, the read flag, one request at a time
 * across every Done still going out. It takes its transport as one function,
 * so a batch endpoint replaces `DoneSend` and nothing else.
 *
 * The STORE holds both for the page, not for one mount of Mail. A reader who
 * leaves Mail while a Done is still sending and comes back finds the same
 * holds and the same queue: the rows do not show again, and no second queue
 * sends them twice. The page leaving is heard here too, once, whether Mail is
 * on screen or not.
 */

import type { MailThreadListItem } from "@/lib/mail/message-types";
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
 * The two mutations a Done owes one thread, each its own request today, and
 * the two that take them back when the provider's answer shows new mail.
 */
export type DoneMutation =
  | { readonly accountId: string; readonly threadId: string; readonly archive: boolean }
  | { readonly accountId: string; readonly threadId: string; readonly read: boolean };

/**
 * THE TRANSPORT. One mutation, one request, answered with the thread as the
 * provider reads it after applying the mutation. A transport with no answer
 * to give says nothing about the thread, and the queue takes it at its word.
 */
export type DoneSend = (mutation: DoneMutation) => Promise<MailThreadListItem | void>;

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

/** What became of one Done's threads. */
export type DoneOutcome = {
  /** Out of the inbox. */
  readonly moved: readonly MailThreadListItem[];
  /** Still where they were: a failure, or an account closed for the run. */
  readonly stayed: readonly MailThreadListItem[];
  /** No longer what the list said they were, so neither of the above. */
  readonly changed: readonly MailThreadListItem[];
  /** Got new mail between the press and their turn, and so were not sent. */
  readonly renewed: readonly MailThreadListItem[];
  /** Accounts closed for the run, and why. */
  readonly closed: ReadonlyMap<string, DoneClosure>;
};

/** What one Done hands the queue with its threads. */
export type DoneHooks = {
  readonly send: DoneSend;
  /**
   * The copy of a thread the lists hold now, or nothing when no list has
   * one. Asked before each send: a thread whose copy has another message
   * than the press saw is not sent (`renewed`).
   */
  readonly current?: (thread: MailThreadListItem) => MailThreadListItem | undefined;
  /** A thread's archive answered. Called before its read flag is sent. */
  readonly onArchived?: (thread: MailThreadListItem) => void;
  /** A thread got new mail and is not being sent. */
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
 * Whether a thread has mail the press did not see. The count catches a
 * reply, and the date catches a message that took another's place. A read
 * flag or a star set elsewhere since is not new mail.
 */
function gotNewMail(pressed: MailThreadListItem, now: MailThreadListItem): boolean {
  return (
    now.messageCount !== pressed.messageCount || now.lastMessageAt !== pressed.lastMessageAt
  );
}

export function doneQueue(failureOf: (error: unknown) => DoneFailure): DoneQueue {
  const open = new Set<QueuedRun>();
  let tail: Promise<unknown> = Promise.resolve();

  const close = (run: QueuedRun, thread: MailThreadListItem, failure: DoneFailure) => {
    if (CLOSES.has(failure) && !run.closed.has(thread.accountId)) {
      run.closed.set(thread.accountId, failure as DoneClosure);
    }
  };

  /* Archive, then read. That order is the one that fails safely: a failed
     archive leaves the thread exactly where it was, unread and in its
     section, while a read that fails after a successful archive costs
     nothing a reader can see, because the thread is out of the inbox either
     way. The provider's archive drops the INBOX label and touches nothing
     else, which is why the read flag is sent at all.

     The press took a snapshot, and a provider's archive and read flag act on
     every message the thread has when they are called: a reply that arrived
     inside the window would be filed away, read, before anyone saw it. Three
     checks stand in its way. The lists are asked what they hold now, before
     anything is sent; they only know what the change feed has told them, so
     this one saves a request and nothing more. The archive's answer, the
     provider reading the thread after moving it, is compared with the press:
     new mail there and the archive is taken back before any read flag goes.
     The read flag's answer is compared with the archive's: a reply that
     landed between the two was marked read with the rest, so both are taken
     back. A reply after the read flag answered arrives unread, as new mail
     does, and is no longer this run's to see. */
  const sendThread = async (run: QueuedRun, thread: MailThreadListItem): Promise<void> => {
    const now = run.hooks.current?.(thread);
    if (now !== undefined && gotNewMail(thread, now)) {
      run.renewed.push(thread);
      run.hooks.onRenewed?.(thread);
      return;
    }
    const key = { accountId: thread.accountId, threadId: thread.threadId };
    let archived: MailThreadListItem | void;
    try {
      archived = await run.hooks.send({ ...key, archive: true });
    } catch (error) {
      const failure = failureOf(error);
      if (failure === "changed") {
        run.changed.push(thread);
        return;
      }
      close(run, thread, failure);
      run.stayed.push(thread);
      return;
    }
    if (archived && gotNewMail(thread, archived)) {
      await takeBack(run, thread, [{ ...key, archive: false }]);
      return;
    }
    run.hooks.onArchived?.(thread);
    if (!thread.unread) {
      run.moved.push(thread);
      return;
    }
    let read: MailThreadListItem | void;
    try {
      read = await run.hooks.send({ ...key, read: true });
    } catch (error) {
      // A server that went quiet between the two still closes the account.
      close(run, thread, failureOf(error));
      run.moved.push(thread);
      return;
    }
    if (read && gotNewMail(archived || thread, read)) {
      // The reply first: it is the one a reader would miss.
      await takeBack(run, thread, [
        { ...key, read: false },
        { ...key, archive: false },
      ]);
      return;
    }
    run.moved.push(thread);
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
    for (
      let thread = run.rest.shift();
      thread !== undefined;
      thread = run.rest.shift()
    ) {
      // A failing thread does not stop the run, and a closed account does
      // not cost one more attempt per thread for one more refusal each.
      if (run.closed.has(thread.accountId)) {
        run.stayed.push(thread);
        continue;
      }
      await sendThread(run, thread);
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
      for (const run of open) {
        for (const thread of run.rest.splice(0)) {
          run.atOnce.push(sendThread(run, thread));
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
  /** The transport of the surface that pressed Done. */
  readonly send: DoneSend;
  /** Says the press-time sentence again without its Undo. */
  readonly respeak: () => void;
  /** A thread got new mail and came off the run: put its row back. */
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
