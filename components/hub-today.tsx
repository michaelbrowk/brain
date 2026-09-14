"use client";

// TODAY, ON HOME.
//
// Five rows at most, flat and ungrouped, because grouping is the section's
// job and a dashboard that reproduced the column would be the column. What it
// does reproduce exactly is the ROW: `components/tasks-row.tsx`, the same
// control with the same 1.3-second completion, the same swipe and the same
// checkbox. A second row shape for a task would be a second product.
//
// IT RENDERS, IT DOES NOT DERIVE. Which five are today's is `sectionsFor` in
// `components/tasks-lists`, flattened — the derive the column uses, so the two
// cannot disagree about what matters today. The records and the reader's own
// day are `components/tasks-client`, the one fetch the sidebar count reads
// from as well, and the writes are `components/tasks-actions`.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useMemo } from "react";

import { DUR, EASE_OUT, SPRING_PANEL } from "@/lib/motion";
import { useTaskActions } from "./tasks-actions";
import { useTasks } from "./tasks-client";
import { countsFor, headerLabel, sectionsFor, type TaskCounts } from "./tasks-lists";
import { TasksRow } from "./tasks-row";
import { Empty } from "./ui/empty";
import type { ToastOptions } from "./ui/primitives";

/** The one shared element the captured text travels on, from the field at the
 *  head of Home into the first row of this block. */
export const HUB_CAPTURE_FLIGHT_ID = "hub-capture-flight";

/** Five, and the sixth collapses. A dashboard is a report, and a report that
 *  runs past a screen has stopped being one. */
const HOME_ROWS = 5;

/** The row the flight lands in, before the real one takes its place: 36 tall
 *  on the desktop rhythm, the height a task capsule is. */
const FLIGHT_ROW_PX = 36;

const TODAY_VIEW = { kind: "list", list: "today" } as const;

export interface HubTodayProps {
  /** The shell's count of task events this tab did not write. Shared with the
   *  sidebar's count and the Tasks surface, so the three are one request. */
  refreshToken: number;
  onOpenTasks: () => void;
  onToast?: (title: string, options?: ToastOptions) => void;
  /** The text of a capture in flight from the field above. */
  flight?: string | null;
  /** A task this page has just created: it arrives rather than appears. */
  capturedId?: string | null;
}

export function HubToday({
  refreshToken,
  onOpenTasks,
  onToast,
  flight = null,
  capturedId = null,
}: HubTodayProps) {
  const reduce = useReducedMotion() ?? false;
  const state = useTasks(refreshToken);
  const today = state.day?.today ?? "";
  const offsetMinutes = state.day?.offsetMinutes ?? 0;
  const actions = useTaskActions({ today, onToast });
  const { held, inserted } = actions;

  const records = useMemo(
    () => state.tasks.map((task) => held.get(task.id) ?? task),
    [held, state.tasks],
  );
  const drawn = useMemo(
    () =>
      today
        ? sectionsFor(records, TODAY_VIEW, today, offsetMinutes).flatMap(
            (section) => section.rows,
          )
        : [],
    [offsetMinutes, records, today],
  );
  const counts = useMemo(
    () => countsFor(state.tasks, today, offsetMinutes),
    [offsetMinutes, state.tasks, today],
  );

  // What the LIST holds, so a row still folding is already out of it: one
  // decrement at 1300, and the row leaves at 1520.
  const open = drawn.filter((row) => !held.has(row.task.id)).length;
  const visible = drawn.slice(0, HOME_ROWS);

  // The clock is read on mount, so the server's HTML and the first client
  // render both have no day. A block that guessed one would draw an empty
  // state over a list it has not seen.
  if (today === "") return null;

  return (
    <section className="mt-8" data-hub-today>
      <button
        type="button"
        data-hub-today-open
        onClick={onOpenTasks}
        className="text-h3 -mx-2 mb-1.5 rounded-sm px-2 py-0.5 text-left text-ink transition-colors hover:bg-fill-hover"
      >
        Today
        {open > 0 && (
          /* The number crossfades where the sidebar chip and the column's
             group header do, and for the same reason: a completion moves it
             while the reader is watching the row beside it. */
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={open}
              data-hub-count
              className="tabular-nums text-ink-3"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: reduce ? 0 : DUR.fast } }}
              transition={{ duration: reduce ? 0 : DUR.fast }}
            >
              {headerLabel("", open)}
            </motion.span>
          </AnimatePresence>
        )}
      </button>

      <ul className="brain-tasks-rows brain-hub-tasks">
        {flight !== null && (
          /* WHERE THE CAPTURED TEXT LANDS. The capsule opens under it, 0 to
             36, while the words travel here from the field on the shared
             `layoutId`. Both are gone by the time the real row arrives. */
          <motion.li
            aria-hidden
            className="brain-task-row-item"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: FLIGHT_ROW_PX, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: DUR.exit } }}
            transition={reduce ? { duration: 0 } : SPRING_PANEL}
          >
            <span className="brain-hub-flight-slot">
              <motion.span
                layoutId={reduce ? undefined : HUB_CAPTURE_FLIGHT_ID}
                className="brain-hub-flight-text"
                transition={SPRING_PANEL}
              >
                {flight}
              </motion.span>
            </span>
          </motion.li>
        )}
        <AnimatePresence initial={false}>
          {visible.map(({ key, task }) => (
            <TasksRow
              key={key}
              rowKey={key}
              task={task}
              today={today}
              offsetMinutes={offsetMinutes}
              reduce={reduce}
              selected={false}
              expanded={false}
              categories={EMPTY_CATEGORIES}
              entrance={
                inserted.has(task.id) || task.id === capturedId ? "insert" : false
              }
              onSelect={NOOP}
              onSelectNext={NOOP}
              // A press is not an expansion here. The chips edit a record, and
              // editing a record is the section's work: "everything else is in
              // the section" is the rule this block is drawn to, so the press
              // takes the reader there rather than growing Home into a second
              // Tasks column.
              onExpand={onOpenTasks}
              onComplete={actions.completeTask}
              onReopen={(task) => void actions.reopenTask(task)}
              onReschedule={actions.rescheduleTask}
              onPatch={actions.patchField}
              onFoldEnd={actions.releaseFold}
            />
          ))}
        </AnimatePresence>
      </ul>

      {open === 0 && flight === null && (
        <motion.div
          className="px-2 py-5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: reduce ? 0 : DUR.base, ease: EASE_OUT }}
        >
          <Empty {...emptyForHome(counts)} />
        </motion.div>
      )}

      {drawn.length > HOME_ROWS && (
        <button
          type="button"
          data-hub-today-all
          onClick={onOpenTasks}
          className="-mx-2 mt-1 rounded-sm px-2 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2"
        >
          {`All today (${drawn.length})`}
        </button>
      )}
    </section>
  );
}

/** The two Today states, in Home's own words.
 *
 *  `Add one in Tasks` and not the column's `Add one above`: Home has no
 *  capture row for a task under this block, so the column's sentence would
 *  point a reader at a field that is not on the screen. The two hints differ
 *  on purpose, which is why they are written twice rather than shared. */
function emptyForHome(counts: TaskCounts): {
  icon: "checklist-linear";
  title: string;
  hint: string;
} {
  if (counts.doneToday > 0) {
    return {
      icon: "checklist-linear",
      title: "Done for today",
      hint: `${counts.doneToday} completed · Logbook`,
    };
  }
  return {
    icon: "checklist-linear",
    title: "Nothing planned today",
    hint:
      counts.upcomingThisWeek > 0
        ? `Upcoming has ${counts.upcomingThisWeek} this week`
        : "Add one in Tasks",
  };
}

const EMPTY_CATEGORIES: readonly string[] = [];
const NOOP = () => {};
