import { randomInt } from "node:crypto";

import type { MailSystemMailbox } from "../message-types";

/** THE SERVICE'S ONE WAY OF SAYING THAT SOMETHING CHANGED.
 *
 *  The service stays passive: it opens no connection to Brain (section 4 of
 *  the architecture), so Brain asks. `GET /v1/changes` is a long poll on this
 *  ring, and the ring is fed from the three places mail changes: a sync pass
 *  that commits a new generation or changes threads, a mutation that lands
 *  (the owner's, an agent's, or the new-senders screen's), and a message body
 *  that becomes ready. Each record names the account and the mailboxes whose
 *  listings may differ now, and nothing else about the mail.
 *
 *  MEMORY ONLY, BOUNDED, AND HONEST ABOUT WHAT IT LOST. The ring keeps the
 *  last 256 records under a monotonic cursor. A reader whose cursor has left
 *  the ring, or that the ring never issued, is told `reset` rather than handed
 *  the part that is left, because a partial answer reads as the whole story.
 *  The cursor starts at a random point of a 2^48 range, so a cursor Brain kept
 *  across a restart of this process lands outside the new ring and resets
 *  instead of matching a stranger's sequence number.
 *
 *  ONE READER WAITS. Brain runs one loop per process, so a second request that
 *  would wait while another does is a second loop or a stale one, and it is
 *  refused as busy rather than queued. A request that can be answered at once
 *  never waits and is never refused.
 */
export const MAIL_CHANGE_FEED_CAPACITY = 256;
export const MAIL_CHANGE_FEED_MAX_WAIT_MS = 25_000;
const CURSOR_START_RANGE = 2 ** 48;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SYSTEM_MAILBOXES: ReadonlySet<string> = new Set<MailSystemMailbox>([
  "inbox",
  "all",
  "sent",
  "starred",
  "spam",
  "trash",
]);

export type MailServiceChangeKind = "sync" | "content_ready" | "mutation";

export interface MailServiceChange {
  readonly accountId: string;
  /** The listings that may read differently now. Empty for a body that
   *  became ready, which changes no listing. */
  readonly mailboxIds: readonly MailSystemMailbox[];
  readonly kind: MailServiceChangeKind;
  /** Only on `content_ready`: whose body it is, so a reader holding that
   *  message open knows the event is its own. */
  readonly messageId?: string;
}

export interface MailChangeFeedAnswer {
  readonly apiVersion: 1;
  readonly cursor: number;
  readonly changes: readonly MailServiceChange[];
  readonly reset?: true;
}

export class MailChangeFeedBusyError extends Error {
  constructor() {
    super("mail_changes_busy");
    this.name = "MailChangeFeedBusyError";
  }
}

/** Every mailbox a thread can be listed in, for a change that may have moved
 *  a thread between any of them. */
export const MAIL_CHANGE_ALL_MAILBOXES: readonly MailSystemMailbox[] = Object.freeze([
  "inbox",
  "all",
  "sent",
  "starred",
  "spam",
  "trash",
]);

export class MailChangeFeed {
  private readonly capacity: number;
  private sequence: number;
  private readonly entries: { readonly sequence: number; readonly change: MailServiceChange }[] =
    [];
  private waiter: (() => void) | null = null;

  constructor(
    options: { readonly capacity?: number; readonly initialCursor?: number } = {},
  ) {
    this.capacity = options.capacity ?? MAIL_CHANGE_FEED_CAPACITY;
    // randomInt's span has to stay under 2^48, hence the one short.
    this.sequence = options.initialCursor ?? randomInt(0, CURSOR_START_RANGE - 1);
    if (
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 0 ||
      this.sequence >= CURSOR_START_RANGE
    ) {
      throw new Error("mail change feed is invalid");
    }
  }

  latestCursor(): number {
    return this.sequence;
  }

  append(change: MailServiceChange): void {
    const validated = validateMailServiceChange(change);
    this.sequence += 1;
    this.entries.push(Object.freeze({ sequence: this.sequence, change: validated }));
    if (this.entries.length > this.capacity) this.entries.shift();
    this.waiter?.();
  }

  /**
   * The long poll. `null` from the cursor is a first read and is answered at
   * once with where to wait from. A read with nothing new waits up to
   * `waitMs` for the next record and answers empty with its own cursor when
   * none comes. While the service is paused nothing is answered: the reader
   * waits out its time and gets its own cursor back, and whatever the ring
   * holds by the resume is still there for it. Resolves `null` when the
   * reader left before an answer, so the caller writes nothing.
   */
  read(input: {
    readonly cursor: number | null;
    readonly waitMs: number;
    readonly paused: () => boolean;
    readonly signal: AbortSignal;
  }): Promise<MailChangeFeedAnswer | null> {
    const { cursor, waitMs, paused, signal } = input;
    if (cursor === null) return Promise.resolve(this.answer([]));
    const quiet = (): MailChangeFeedAnswer =>
      Object.freeze({ apiVersion: 1, cursor, changes: Object.freeze([]) });
    const now = paused() ? null : this.answerAfter(cursor);
    if (now !== null) return Promise.resolve(now);
    if (waitMs <= 0) return Promise.resolve(quiet());
    if (signal.aborted) return Promise.resolve(null);
    if (this.waiter !== null) return Promise.reject(new MailChangeFeedBusyError());
    return new Promise((resolve) => {
      let settled = false;
      const finish = (answer: MailChangeFeedAnswer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.waiter === wake) this.waiter = null;
        resolve(answer);
      };
      const onAbort = () => finish(null);
      const wake = () => {
        if (paused()) return;
        const answer = this.answerAfter(cursor);
        if (answer !== null) finish(answer);
      };
      const timer = setTimeout(() => finish(quiet()), waitMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiter = wake;
    });
  }

  /** What a caught-up reader is owed now, or `null` when it has to wait. */
  private answerAfter(cursor: number): MailChangeFeedAnswer | null {
    const earliest = this.entries[0]?.sequence ?? this.sequence + 1;
    if (!Number.isSafeInteger(cursor) || cursor > this.sequence || cursor < earliest - 1) {
      return Object.freeze({ ...this.answer([]), reset: true as const });
    }
    if (cursor === this.sequence) return null;
    return this.answer(
      this.entries.filter((entry) => entry.sequence > cursor).map((entry) => entry.change),
    );
  }

  private answer(changes: readonly MailServiceChange[]): MailChangeFeedAnswer {
    return Object.freeze({
      apiVersion: 1,
      cursor: this.sequence,
      changes: Object.freeze([...changes]),
    });
  }
}

function validateMailServiceChange(change: MailServiceChange): MailServiceChange {
  if (
    change === null ||
    typeof change !== "object" ||
    typeof change.accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(change.accountId) ||
    !Array.isArray(change.mailboxIds) ||
    change.mailboxIds.some((mailboxId) => !SYSTEM_MAILBOXES.has(mailboxId)) ||
    new Set(change.mailboxIds).size !== change.mailboxIds.length ||
    (change.kind !== "sync" && change.kind !== "mutation" && change.kind !== "content_ready")
  ) {
    throw new Error("mail change is invalid");
  }
  if (change.kind === "content_ready") {
    if (typeof change.messageId !== "string" || !SAFE_MESSAGE_ID.test(change.messageId)) {
      throw new Error("mail change is invalid");
    }
    return Object.freeze({
      accountId: change.accountId,
      mailboxIds: Object.freeze([...change.mailboxIds]),
      kind: change.kind,
      messageId: change.messageId,
    });
  }
  if (change.messageId !== undefined) throw new Error("mail change is invalid");
  return Object.freeze({
    accountId: change.accountId,
    mailboxIds: Object.freeze([...change.mailboxIds]),
    kind: change.kind,
  });
}
