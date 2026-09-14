"use client";

// WHAT A TASK ROW CAN DO, IN ONE PLACE.
//
// The Tasks column and the Today block on Home draw the same row, and a row
// that completes one way in the column and another way on Home is two
// products. So the four writes a row can ask for live here: the completion
// with its 2.1 cycle, the untick, the reschedule and the field patch, each
// with its optimistic step, its revert and the words a refusal is reported
// in. The surfaces own what is on screen; this owns what is written.
//
// ONE FIELD PER REQUEST WHERE THE STORE SAYS SO. `updateTask` refuses a
// schedule, a title, a deadline, a category or a rule in the same call as a
// linked task's `done` or a repeating task's completion, in two separate
// reasons, because a completion already moves `when` and a linked completion
// is a write to somebody's note. Nothing here ever sends both, and
// `tasks-actions.test.ts` holds that shut.
//
// It derives nothing. Which list a record is in is `lib/tasks/lists.ts`, and
// the reader's own day arrives as `today` from `components/tasks-client`,
// which is also where the records are and where the optimistic step lands.

import { useCallback, useState } from "react";

import type { TaskRepeat, TaskView } from "@/lib/tasks/model";

import { SMART_UNDO_MS } from "./shell/helpers";
import {
  TaskRequestError,
  liveTask,
  mutateTasks,
  patchTask,
  reloadTasks,
} from "./tasks-client";
import { movesRow, repeatNextDay } from "./tasks-lists";
import type { ToastOptions } from "./ui/primitives";

/** The fields a chip inside an expanded row can set. `null` clears one, which
 *  is the store's own reading of a patch. */
export interface TaskFieldPatch {
  title?: string;
  deadline?: string | null;
  category?: string | null;
  repeat?: TaskRepeat | null;
}

export interface TaskActions {
  /** Rows a fold is still playing on, which is the RESCHEDULE and nothing
   *  else. They keep their PRE-write record, so a row on its way out of the
   *  list stays where it was for the 220ms it takes to leave while the counts
   *  beside it have already moved on: one decrement at 1300, the row gone at
   *  1520. A completion holds nothing, because it does not leave. */
  readonly held: ReadonlyMap<string, TaskView>;
  /** Rows that arrive rather than appear: a new task, an Undo putting one
   *  back, the next occurrence of a repeat. */
  readonly inserted: ReadonlySet<string>;
  markInserted: (id: string) => void;
  releaseFold: (id: string) => void;
  /** `refusal` is the one sentence this completion is reported in when the
   *  route says no, for the same reason the untick has one: ticking a LINKED
   *  task is a write to somebody's note. Without it the route's own `reason`
   *  stands. */
  completeTask: (task: TaskView, refusal?: string) => Promise<void>;
  /** `refusal` is the one sentence this untick is reported in when the route
   *  says no. Without it the route's own `reason` stands. */
  reopenTask: (task: TaskView, refusal?: string) => Promise<void>;
  rescheduleTask: (
    task: TaskView,
    when: string | "someday" | null,
    label: string,
  ) => Promise<void>;
  patchField: (task: TaskView, patch: TaskFieldPatch) => void;
}

export function useTaskActions({
  today,
  onToast,
}: {
  today: string;
  onToast?: (title: string, options?: ToastOptions) => void;
}): TaskActions {
  const [held, setHeld] = useState<ReadonlyMap<string, TaskView>>(new Map());
  const [inserted, setInserted] = useState<ReadonlySet<string>>(new Set());

  const releaseFold = useCallback((id: string) => {
    setHeld((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  }, []);

  const hold = useCallback((task: TaskView) => {
    setHeld((current) => new Map(current).set(task.id, task));
  }, []);

  /** A row put back by Undo arrives the way a new one does: height 0 to its
   *  own, plus opacity, with an empty box. Without this it would appear in
   *  one frame, which is the one moment the reader is watching that spot. */
  const markInserted = useCallback((id: string) => {
    setInserted((current) => new Set(current).add(id));
  }, []);

  const refuse = useCallback(
    (error: unknown, instead?: string, id?: string) => {
      const reason =
        error instanceof TaskRequestError && error.message
          ? error.message
          : "That did not save";
      // `id` replaces a report this gesture already made rather than queueing
      // behind it: a refusal and the sentence it corrects are one message.
      onToast?.(instead ?? reason, { urgent: true, ...(id ? { id } : {}) });
    },
    [onToast],
  );

  /** THE ROW HANDED IN IS NOT ALWAYS THE RECORD.
   *
   *  A Logbook row of a repeating task is `logbookRows`' projection of ONE of
   *  its completions: `done: true`, `doneAt` the entry's instant, `when` the
   *  day that instance was owed. The record behind it is open and sitting on
   *  its next occurrence. So neither the optimistic step nor the restore may
   *  use it: writing the projection into the store would leave a repeating
   *  record reading as done, which `listOf` files in the Logbook, and the open
   *  instance would be gone from Today and Upcoming until the next reload.
   *
   *  The untick of a repeat therefore changes nothing locally and asks the
   *  server on failure, because a refused write leaves a record this tab never
   *  had a correct copy of.
   *
   *  `refusal` is the row's own sentence for a failure it can name better than
   *  the route can: unticking a LINKED task is a write to somebody's note, and
   *  "Couldn't untick in ‹page›" says which note, which no route reason knows.
   */
  const reopenTask = useCallback(
    async (task: TaskView, refusal?: string) => {
      const projected = task.repeat !== undefined;
      if (!projected) {
        markInserted(task.id);
        mutateTasks((tasks) =>
          tasks.map((entry) =>
            entry.id === task.id ? { ...task, done: false, doneAt: undefined } : entry,
          ),
        );
      }
      // TWO UNTICKS OF ONE INSTANCE. `revert` pops the newest log entry and
      // puts `when` back on the day it was owed, so a double press or a second
      // tab would pop two entries and leave the record two occurrences in the
      // past, with nothing said. The store refuses a stale precondition with
      // the 409 the completion already uses; it has to be the RECORD's `when`,
      // because the row is this completion's projection.
      const live = projected ? liveTask(task.id) : undefined;
      try {
        const saved = await patchTask(task.id, {
          done: false,
          ...(live ? { expectedWhen: live.when ?? null } : {}),
        });
        if (projected) markInserted(saved.id);
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
      } catch (error) {
        // The record, from the server. Never `task`: for a repeat that is the
        // projection and would overwrite the live record with a done one.
        if (projected) reloadTasks();
        else {
          mutateTasks((tasks) =>
            tasks.map((entry) => (entry.id === task.id ? task : entry)),
          );
        }
        refuse(error, refusal);
      }
    },
    [markInserted, refuse],
  );

  /** The write is issued HERE, at 1300, called by the row as its strike
   *  finishes. Nothing was sent before this point, so a cancelled completion
   *  leaves no request, no `rev` bump and no commit behind it.
   *
   *  THE PILL ARRIVES WITH THE WRITE, AND CORRECTS ITSELF. Spec 2.1: the
   *  Snackbar shows on the same beat the row is finished. Waiting for the 2xx
   *  put it 740 ms later, so on a slow write the row was struck through and
   *  the way back had not appeared yet.
   *
   *  It arrives with NO action and no window: "Completed" is a report of what
   *  the reader did a moment ago, which is true the moment they did it, and an Undo
   *  offered before the write landed would send a second PATCH for a
   *  completion that never happened. When the 2xx lands the same sentence is
   *  said again under the same id, now with the way back and its nine
   *  seconds; a refusal replaces it under that id too, in the route's own
   *  words, so a report is never left standing over its own correction.
   */
  const completeTask = useCallback(
    async (task: TaskView, refusal?: string) => {
      // NOTHING IS HELD ANY MORE. `held` existed because a completed row kept
      // its pre-write copy for the 220ms it took to fold away, and there is no
      // fold on this path now: the optimistic `done: true` is what moves the
      // row to the foot of its group, and the layout spring carries it there.
      // `hold` and `releaseFold` stay for the reschedule, which does leave.
      //
      // A REPEATING task is never done. Completing it appends a log entry and
      // moves `when` to the next occurrence, so an optimistic `done: true`
      // would file the series in the Logbook for as long as the write takes
      // and then pull it back out. What moves optimistically is the DAY: the
      // browser knows the rule, so the record leaves this list on the same
      // beat an ordinary completion does and the count beside it decrements
      // once, at 1300. The server's answer replaces it either way.
      const nextDay = repeatNextDay(task, today);
      // One message, said up to twice: the report now, its correction when the
      // answer lands.
      const pill = `task-complete-${task.id}`;
      mutateTasks((tasks) =>
        tasks.map((entry) => {
          if (entry.id !== task.id) return entry;
          if (!task.repeat) {
            return { ...entry, done: true, doneAt: new Date().toISOString() };
          }
          return nextDay === null ? entry : { ...entry, when: nextDay };
        }),
      );
      onToast?.("Completed", { id: pill, durationMs: null });
      try {
        const saved = await patchTask(
          task.id,
          {
            done: true,
            // The instance this tab was looking at. Completing a repeat is
            // not idempotent, so a second tick of the same one from another
            // tab is refused with a 409 rather than silently skipping a
            // period. An ordinary completion needs no such thing.
            ...(task.repeat ? { expectedWhen: task.when ?? null } : {}),
          },
          task.repeat ? today : undefined,
        );
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
        // Spec 2.4, the one case a person watches: the series moved on here
        // and the NEXT occurrence arrives below, in the following day's group,
        // with the insert entrance a new row gets. In Today the next one is
        // tomorrow or later, so nothing appears and the mark is unused.
        if (task.repeat) markInserted(saved.id);
        onToast?.("Completed", {
          id: pill,
          actionLabel: "Undo",
          durationMs: SMART_UNDO_MS,
          onAction: () => {
            void reopenTask(saved);
          },
        });
      } catch (error) {
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === task.id ? task : entry)),
        );
        refuse(error, refusal, pill);
        throw error;
      }
    },
    [markInserted, onToast, refuse, reopenTask, today],
  );

  /** ONE ANSWER, TWO CONSEQUENCES.
   *
   *  Whether this write draws the record somewhere else decides the hold and
   *  the report together. A LEAVING row keeps its pre-write copy while it
   *  folds, which is what `hold` is for, and a row that stays would instead
   *  wear yesterday's day for the length of an animation that is not playing.
   *  And "Moved to Today" over a task that was already in Today is a sentence
   *  about something that did not happen: Today pressed on an overdue task,
   *  or on one a deadline pulled in, is a real write and not a move, so there
   *  is nothing to report and nothing to undo.
   *
   *  The row asks `movesRow` for its fold, so the motion and the words are
   *  the same answer twice rather than two rules. */
  const rescheduleTask = useCallback(
    async (task: TaskView, when: string | "someday" | null, label: string) => {
      const moves = movesRow(task, when, today);
      if (moves) hold(task);
      mutateTasks((tasks) =>
        tasks.map((entry) =>
          entry.id === task.id ? { ...entry, when: when ?? undefined } : entry,
        ),
      );
      try {
        const saved = await patchTask(task.id, { when });
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
        if (!moves) return;
        onToast?.(`Moved to ${label}`, {
          actionLabel: "Undo",
          durationMs: SMART_UNDO_MS,
          onAction: () => {
            markInserted(task.id);
            mutateTasks((tasks) =>
              tasks.map((entry) => (entry.id === task.id ? task : entry)),
            );
            void patchTask(task.id, { when: task.when ?? null }).catch(refuse);
          },
        });
      } catch (error) {
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === task.id ? task : entry)),
        );
        refuse(error);
        throw error;
      }
    },
    [hold, markInserted, onToast, refuse, today],
  );

  const patchField = useCallback(
    (task: TaskView, patch: TaskFieldPatch) => {
      mutateTasks((tasks) =>
        tasks.map((entry) =>
          entry.id === task.id ? { ...entry, ...normalize(patch) } : entry,
        ),
      );
      void patchTask(task.id, patch)
        .then((saved) =>
          mutateTasks((tasks) =>
            tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
          ),
        )
        .catch((error: unknown) => {
          mutateTasks((tasks) =>
            tasks.map((entry) => (entry.id === task.id ? task : entry)),
          );
          refuse(error);
        });
    },
    [refuse],
  );

  return {
    held,
    inserted,
    markInserted,
    releaseFold,
    completeTask,
    reopenTask,
    rescheduleTask,
    patchField,
  };
}

function normalize(patch: TaskFieldPatch): Partial<TaskView> {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.deadline !== undefined ? { deadline: patch.deadline ?? undefined } : {}),
    ...(patch.category !== undefined ? { category: patch.category ?? undefined } : {}),
    // Clearing the rule clears the history with it, the way the record does:
    // `log` beside no `repeat` is a shape nothing reads.
    ...(patch.repeat !== undefined
      ? {
          repeat: patch.repeat ?? undefined,
          ...(patch.repeat === null ? { log: undefined } : {}),
        }
      : {}),
  };
}
