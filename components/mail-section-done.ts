/**
 * A section's Done, deferred, with no React in it.
 *
 * Pressing Done takes the section out of the column at once and sends
 * nothing: the pill's Undo stands for its window, and only when that window
 * closes do the archives go out, in the background and under no lock. Two
 * things make that work, and both live here.
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
 */

import type { MailThreadListItem } from "@/lib/mail/message-types";
import { unifiedThreadKey } from "./mail-unified";

/**
 * One thread a Done holds out of the column. `landedAt` is null until its
 * archive answers, and then the count of Inbox reads begun at that moment:
 * the hold ends on the first read begun after it (`settleDone`).
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

/**
 * An Inbox read has landed. A thread whose archive answered before that read
 * began is the read's to speak for now, the rule the New senders overlay
 * keeps for a block's archive: a key leaves only on a read begun after the
 * answer. A read begun earlier may still list the thread, and the hold is
 * what keeps that row from flashing back.
 *
 * `gone` is what such a read did not list. Those threads are out of the
 * Inbox, and the caller sweeps them from the lists in the same commit: the
 * lists were never told, and a deep row or one an earlier read put back
 * would show the moment the hold let go. A thread the read does list is in
 * the Inbox again by someone's hand, and it simply shows.
 */
export function settleDone(
  overlay: DoneOverlay,
  startedAt: number,
  listed: readonly MailThreadListItem[],
): { readonly overlay: DoneOverlay; readonly gone: readonly MailThreadListItem[] } {
  let next: Map<string, DoneHold> | null = null;
  let present: Set<string> | null = null;
  const gone: MailThreadListItem[] = [];
  for (const [key, held] of overlay) {
    if (held.landedAt === null || startedAt <= held.landedAt) continue;
    present ??= new Set(listed.map(unifiedThreadKey));
    next ??= new Map(overlay);
    next.delete(key);
    if (!present.has(key)) gone.push(held.thread);
  }
  return { overlay: next ?? overlay, gone };
}

/** The two mutations a Done owes one thread, each its own request today. */
export type DoneMutation =
  | { readonly accountId: string; readonly threadId: string; readonly archive: true }
  | { readonly accountId: string; readonly threadId: string; readonly read: true };

/**
 * THE TRANSPORT. One mutation, one request. `keepalive` is for what leaves
 * while the page unloads, where an ordinary request is cancelled with the
 * document.
 */
export type DoneSend = (
  mutation: DoneMutation,
  options: { readonly keepalive: boolean },
) => Promise<void>;

/**
 * What a failed mutation says about the rest of the run. `changed`: the
 * server no longer recognises the thread. `refused`: the account's server has
 * no folder for the action, which is as true of its next thread. `silent`:
 * the account did not answer inside the client's deadline, and the next
 * request to it would sit just as long. `failed`: this thread only.
 */
export type DoneFailure = "changed" | "refused" | "silent" | "failed";

/** What became of one Done's threads. */
export type DoneOutcome = {
  /** Out of the inbox. */
  readonly moved: readonly MailThreadListItem[];
  /** Still where they were: a failure, or an account closed for the run. */
  readonly stayed: readonly MailThreadListItem[];
  /** No longer what the list said they were, so neither of the above. */
  readonly changed: readonly MailThreadListItem[];
  /** Accounts closed by a refusal. */
  readonly refused: ReadonlySet<string>;
  /** Accounts closed because they stopped answering. */
  readonly silent: ReadonlySet<string>;
};

export type DoneQueue = {
  /**
   * Sends one Done's threads behind whatever is still going out, and
   * resolves, never rejects, with what became of them. `onArchived` is called
   * the moment a thread's archive answers, before its read flag is sent.
   */
  commit(
    threads: readonly MailThreadListItem[],
    onArchived: (thread: MailThreadListItem) => void,
  ): Promise<DoneOutcome>;
  /**
   * The page is leaving. Everything not yet sent, in every Done still
   * waiting, goes at once with `keepalive`: a loop that awaits its way
   * through them would be cut at the first request. The account rules do not
   * apply to what leaves this way, since no answer comes back in time to
   * close anything.
   */
  unload(): void;
};

type DoneRun = {
  readonly rest: MailThreadListItem[];
  readonly atOnce: Promise<void>[];
  readonly onArchived: (thread: MailThreadListItem) => void;
  readonly moved: MailThreadListItem[];
  readonly stayed: MailThreadListItem[];
  readonly changed: MailThreadListItem[];
  readonly refused: Set<string>;
  readonly silent: Set<string>;
};

export function doneQueue(
  send: DoneSend,
  failureOf: (error: unknown) => DoneFailure,
): DoneQueue {
  const open = new Set<DoneRun>();
  let tail: Promise<unknown> = Promise.resolve();

  /* Archive, then read. That order is the one that fails safely: a failed
     archive leaves the thread exactly where it was, unread and in its
     section, while a read that fails after a successful archive costs
     nothing a reader can see, because the thread is out of the inbox either
     way. The provider's archive drops the INBOX label and touches nothing
     else, which is why the read flag is sent at all. */
  const sendThread = async (
    run: DoneRun,
    thread: MailThreadListItem,
    keepalive: boolean,
  ): Promise<void> => {
    const key = { accountId: thread.accountId, threadId: thread.threadId };
    try {
      await send({ ...key, archive: true }, { keepalive });
    } catch (error) {
      const failure = failureOf(error);
      if (failure === "changed") {
        run.changed.push(thread);
        return;
      }
      if (failure === "refused") run.refused.add(thread.accountId);
      if (failure === "silent") run.silent.add(thread.accountId);
      run.stayed.push(thread);
      return;
    }
    run.moved.push(thread);
    run.onArchived(thread);
    if (!thread.unread) return;
    try {
      await send({ ...key, read: true }, { keepalive });
    } catch (error) {
      // A server that went quiet between the two still closes the account.
      if (failureOf(error) === "silent") run.silent.add(thread.accountId);
    }
  };

  const drain = async (run: DoneRun): Promise<DoneOutcome> => {
    for (
      let thread = run.rest.shift();
      thread !== undefined;
      thread = run.rest.shift()
    ) {
      // A failing thread does not stop the run, and a closed account does
      // not cost one more login per thread for one more refusal each.
      if (run.refused.has(thread.accountId) || run.silent.has(thread.accountId)) {
        run.stayed.push(thread);
        continue;
      }
      await sendThread(run, thread, false);
    }
    await Promise.all(run.atOnce);
    open.delete(run);
    return run;
  };

  return {
    commit(threads, onArchived) {
      const run: DoneRun = {
        rest: [...threads],
        atOnce: [],
        onArchived,
        moved: [],
        stayed: [],
        changed: [],
        refused: new Set(),
        silent: new Set(),
      };
      open.add(run);
      const done = tail.then(() => drain(run));
      tail = done.catch(() => undefined);
      return done;
    },
    unload() {
      for (const run of open) {
        for (const thread of run.rest.splice(0)) {
          run.atOnce.push(sendThread(run, thread, true));
        }
      }
    },
  };
}
