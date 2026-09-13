import { resolveAnchor } from "./anchor";
import type { TaskAnchor, TaskRecord } from "./model";
import type { TaskLine } from "./task-lines";

/** What a page's tasks should become, now that the page says what it says.
 *
 *  This is the whole decision and none of the writing. The store's leaf reads
 *  the page, hands the parsed lines and the page's records over, and applies
 *  what comes back inside the `mutate()` it already owns. Keeping the decision
 *  here means the rule that can lose somebody's note edit is testable without
 *  a filesystem, a lock or a clock.
 *
 *  Nothing here touches the clock, the filesystem or a Store, and no argument
 *  is mutated. The one instant a detach needs is `at`, handed in by the caller
 *  that owns the write.
 */

/** A record of this page, with the completion the index currently remembers
 *  for it. A linked task's `done` is not in its file, so it has to travel
 *  beside the record rather than inside it. */
export interface ReconcileTask {
  task: TaskRecord;
  done: boolean;
}

export interface ReconcileInput {
  page: string;
  /** `parseTaskLines(markdown)` of the page as it now stands. */
  lines: TaskLine[];
  /** Every record the index holds for this page, in any order. */
  tasks: ReconcileTask[];
  /** The instant a detach is stamped with, read by the caller from its own
   *  clock. An argument, so this module stays testable and deterministic. */
  at: string;
}

/** A record that still has a line. */
export interface TaskRebind {
  id: string;
  /** Position in `lines`. The markdown line is `anchor.line`, and the two are
   *  different numbers. */
  index: number;
  /** The anchor as it should now be stored. */
  anchor: TaskAnchor;
  /** The title cache, refreshed off the line. */
  title: string;
  /** The completion, read off the line's checkbox. */
  done: boolean;
  anchorChanged: boolean;
  titleChanged: boolean;
  doneChanged: boolean;
  /** Whether a field the FILE holds changed. `done` is deliberately not one
   *  of them: it is not stored for a linked task, so a tick alone must not
   *  rewrite `_tasks/<id>.md` and must not earn a Git commit of its own. */
  recordChanged: boolean;
}

/** A record whose line this page no longer has. It keeps `page` and `anchor`,
 *  so the row can read "line removed from ‹page›" and still say where the
 *  line was, and it takes ownership of `done`. */
export interface TaskDetach {
  id: string;
  detachedAt: string;
  done: boolean;
  /** Set exactly when `done` is true: the instant it was finished, kept if
   *  the record already carried one. The caller clears it otherwise. */
  doneAt?: string;
  reason: DetachReason;
}

/** Why the line could not be followed. Three answers rather than one, because
 *  a support question about a task that left a note is unanswerable when
 *  every detach looks the same. */
export type DetachReason =
  /** Nothing on the page is this task any more (resolver step 4). */
  | "line-gone"
  /** The line this anchor names is on the page, and another record already
   *  took it. */
  | "line-taken"
  /** The record names the page but carries no anchor, so there is nothing to
   *  resolve. A hand-edited file is the ordinary way to reach this. */
  | "no-anchor";

export interface PageReconciliation {
  page: string;
  rebound: TaskRebind[];
  detached: TaskDetach[];
  /** Positions in `lines` that no record took. They are ordinary checkboxes:
   *  a task exists only after the gesture, never because a checkbox was
   *  typed. Reported so the caller can see the page whole. */
  unclaimedLines: number[];
}

export function reconcilePageTasks({
  page,
  lines,
  tasks,
  at,
}: ReconcileInput): PageReconciliation {
  const claimed = new Set<number>();
  const rebound: TaskRebind[] = [];
  const detached: TaskDetach[] = [];

  for (const { task, done } of ordered(tasks, page)) {
    const anchor = task.anchor;
    if (!anchor) {
      detached.push(detachOf(task, done, at, "no-anchor"));
      continue;
    }
    // Review finding 16, decided here. The resolver skips a claimed line and
    // falls through to its similarity step, which would rebind this record to
    // whichever neighbour scores above the threshold and rewrite its text and
    // hash, so a guess is indistinguishable from an identity by the next
    // reconcile. When this page still holds the anchor's text and every copy
    // of it is already spoken for, the honest answer is that this record has
    // no line: at most one record follows a line, and the rest detach.
    if (textIsSpokenFor(anchor, lines, claimed)) {
      detached.push(detachOf(task, done, at, "line-taken"));
      continue;
    }
    const resolved = resolveAnchor(anchor, lines, claimed);
    if (!resolved) {
      detached.push(detachOf(task, done, at, "line-gone"));
      continue;
    }
    claimed.add(resolved.index);
    rebound.push(rebindOf(task, done, resolved.index, resolved.anchor, lines));
  }

  const unclaimedLines = lines
    .map((_, index) => index)
    .filter((index) => !claimed.has(index));
  return { page, rebound, detached, unclaimedLines };
}

/** The order the records are walked in, which decides who keeps a line when
 *  two of them want the same one. Document order first, so the page reads the
 *  way it looks, then the older record, then the id: every key is on the
 *  record itself, so the answer does not depend on the order a directory
 *  happened to be read in.
 *
 *  A record of another page is not this page's to decide about. An already
 *  detached one keeps `page` and `anchor` and so arrives here too, and is
 *  left out: resolving it again would let it claim a line a still-linked
 *  record needs, and flip a `done` it now owns. */
function ordered(tasks: ReconcileTask[], page: string): ReconcileTask[] {
  return tasks
    .filter(
      ({ task }) => task.page === page && task.detachedAt === undefined,
    )
    .sort((a, b) => {
      const byLine = lineKey(a.task) - lineKey(b.task);
      if (byLine !== 0) return byLine;
      const byOrdinal = (a.task.anchor?.ordinal ?? 0) - (b.task.anchor?.ordinal ?? 0);
      if (byOrdinal !== 0) return byOrdinal;
      if (a.task.created !== b.task.created) {
        return a.task.created < b.task.created ? -1 : 1;
      }
      return a.task.id < b.task.id ? -1 : 1;
    });
}

/** A record with no anchor sorts last, so it can never displace one that has
 *  a position to argue from. */
function lineKey(task: TaskRecord): number {
  return task.anchor?.line ?? Number.MAX_SAFE_INTEGER;
}

/** Whether the page still holds this anchor's exact text and every copy of it
 *  is claimed. False when the text is gone, which is the edited line the
 *  resolver's similarity step exists for. */
function textIsSpokenFor(
  anchor: TaskAnchor,
  lines: TaskLine[],
  claimed: ReadonlySet<number>,
): boolean {
  let seen = false;
  for (const [index, line] of lines.entries()) {
    if (line.hash !== anchor.hash) continue;
    if (!claimed.has(index)) return false;
    seen = true;
  }
  return seen;
}

function rebindOf(
  task: TaskRecord,
  done: boolean,
  index: number,
  anchor: TaskAnchor,
  lines: TaskLine[],
): TaskRebind {
  const line = lines[index];
  // The normalized form, not the raw one: it is what the anchor stores and
  // what a one-line list row wants, and a tab inside a raw line is a control
  // character the record schema refuses. An empty line is the one the
  // template writes, and a title has a minimum length, so the cache keeps its
  // last real value rather than becoming a record no schema accepts.
  const title = line.normalized === "" ? task.title : line.normalized;
  const stored = task.anchor;
  const anchorChanged =
    stored === undefined ||
    anchor.text !== stored.text ||
    anchor.hash !== stored.hash ||
    anchor.ordinal !== stored.ordinal ||
    anchor.line !== stored.line;
  const titleChanged = title !== task.title;
  return {
    id: task.id,
    index,
    anchor,
    title,
    done: line.checked,
    anchorChanged,
    titleChanged,
    doneChanged: line.checked !== done,
    recordChanged: anchorChanged || titleChanged,
  };
}

function detachOf(
  task: TaskRecord,
  done: boolean,
  at: string,
  reason: DetachReason,
): TaskDetach {
  const doneAt = done ? (task.doneAt ?? at) : undefined;
  return {
    id: task.id,
    detachedAt: at,
    done,
    ...(doneAt === undefined ? {} : { doneAt }),
    reason,
  };
}
