"use client";

// The Tasks canvas: the fourth shell surface, beside notes, mail and
// settings. It owns its own head the way mail does, so the shell draws no
// toolbar over it, and below that head it is five lists and the categories
// that cross them.
//
// IT RENDERS, IT DOES NOT DERIVE. Which list a record is in and which group
// inside it is `lib/tasks/lists.ts`, reached through `components/tasks-lists`;
// the records and the reader's own day are `components/tasks-client`, which
// the sidebar count reads from the same fetch. Nothing here asks a clock
// twice or counts anything the column is not showing.

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DUR, EASE_OUT, SPRING_MATERIALIZE, materializeFade } from "@/lib/motion";
import type { TaskView } from "@/lib/tasks/model";

import { type TasksListState } from "./shell/helpers";
import { useTaskActions, type TaskFieldPatch } from "./tasks-actions";
import {
  TaskRequestError,
  createTask,
  mutateTasks,
  reloadTasks,
  useTasks,
} from "./tasks-client";
import { onTaskCommand, type TaskCommand } from "./tasks-commands";
import { TasksGhostRow } from "./tasks-ghost-row";
import { TasksListMenu } from "./tasks-list-menu";
import {
  categoriesOf,
  countsFor,
  headerLabel,
  sectionsFor,
  type TaskCounts,
  type TaskSection,
  type TasksView,
} from "./tasks-lists";
import { ROW_KEYS, TasksRow, tomorrowOf } from "./tasks-row";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import type { ToastOptions } from "./ui/primitives";
import { ScrollEdge } from "./ui/scroll-edge";

export interface TasksSurfaceProps {
  /** The open list, or a category view. Navigation state, so Back and
   *  Forward move through it and the shell owns it. */
  list?: TasksListState | null;
  onSelectList?: (list: TasksListState | null) => void;
  onToast?: (title: string, options?: ToastOptions) => void;
  /** Bumped by the shell on every store event of type "task" this tab did
   *  not write itself. A task changed somewhere else (another tab, an MCP
   *  call, the repeat rule advancing one). The list refetches on it. */
  refreshToken?: number;
  /** Bumped by "New task" from the palette: the caret goes to the capture
   *  field. */
  captureRequest?: number;
  /** A linked task names its note, and the chip in an expanded row opens it.
   *  The tree lives in the shell, so the two arrive from there. */
  pageTitleOf?: (pageId: string) => string | undefined;
  onOpenPage?: (pageId: string) => void;
}

/** The morning entrance, once per calendar day. */
const ENTRANCE_KEY = "brain.tasks.entrance";
/** Total stagger ceiling. Past it every row arrives with no delay at all. */
const ENTRANCE_CEILING = 0.42;
const GROUP_STEP = 0.05;
const RULE_STEP = 0.06;
const ROW_STEP = 0.03;

export function TasksSurface({
  list = null,
  onSelectList,
  onToast,
  refreshToken = 0,
  captureRequest = 0,
  pageTitleOf,
  onOpenPage,
}: TasksSurfaceProps) {
  const reduce = useReducedMotion() ?? false;
  const state = useTasks(refreshToken);
  const today = state.day?.today ?? "";
  const offsetMinutes = state.day?.offsetMinutes ?? 0;

  const view: TasksView = useMemo(
    () =>
      list === null
        ? { kind: "list", list: "today" }
        : typeof list === "string"
          ? { kind: "list", list }
          : { kind: "category", category: list.category },
    [list],
  );

  /** Every write a row can ask for, and the two sets that say which rows are
   *  arriving and which are still folding. Shared with the Today block on
   *  Home (`components/hub-today.tsx`), so a completion is one cycle and not
   *  two implementations of one. */
  const actions = useTaskActions({ today, onToast });
  const { held, inserted } = actions;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = useMemo(
    () => state.tasks.map((task) => held.get(task.id) ?? task),
    [held, state.tasks],
  );
  const sections = useMemo(
    () => (today ? sectionsFor(rows, view, today, offsetMinutes) : []),
    [offsetMinutes, rows, today, view],
  );
  const categories = useMemo(() => categoriesOf(state.tasks), [state.tasks]);

  /** The column's cursor runs over ROWS and not over records, because the
   *  Logbook draws one row per completion and a daily task has a month of
   *  them under one id. Two rows that answered to one selection would light
   *  together and fight over the capsule's `layoutId`. */
  const drawn = useMemo(
    () => sections.flatMap((section) => section.rows),
    [sections],
  );
  const order = useMemo(() => drawn.map((row) => row.key), [drawn]);

  const entrance = useEntrance({
    today,
    replay: view.kind === "list" && view.list === "today",
    ready: sections.length > 0,
  });

  /** A TASK LANDS IN THE LIST IT WAS TYPED INTO. Anything else files what the
   *  reader has written somewhere they are not looking, with no feedback.
   *
   *  Today takes today, Upcoming takes tomorrow (the first day that list can
   *  hold, since Upcoming is strictly after today), Someday takes the word,
   *  a category view takes the word and no day, and the Inbox takes neither.
   *  The Logbook has no ghost row at all: a task written straight into the
   *  Logbook would have to be born completed, and nobody means that. */
  const capture = useCallback(
    (title: string) => {
      const seed =
        view.kind === "category"
          ? view.category
            ? { category: view.category }
            : {}
          : view.list === "today"
            ? { when: today }
            : view.list === "upcoming"
              ? { when: tomorrowOf(today) }
              : view.list === "someday"
                ? { when: "someday" }
                : {};
      void createTask({ title, ...seed })
        .then((task) => {
          actions.markInserted(task.id);
          mutateTasks((tasks) => [task, ...tasks]);
        })
        .catch((error: unknown) => {
          onToast?.(
            error instanceof TaskRequestError && error.message
              ? error.message
              : "That did not save",
            { urgent: true },
          );
        });
    },
    [actions, onToast, today, view],
  );

  const selectNext = useCallback(
    (afterId: string) => {
      const at = order.indexOf(afterId);
      setSelectedId(order[at + 1] ?? order[at - 1] ?? null);
    },
    [order],
  );

  useArrowKeys({ order, selectedId, setSelectedId, setExpandedId });

  // The palette's two rows and the row's two keys are one action each.
  useEffect(() => {
    return onTaskCommand((command) => {
      const row = drawn.find((entry) => entry.key === selectedId);
      // A Logbook row that is history moves nothing, the same answer the bare
      // letters give on the row itself.
      if (!row || !row.untickable) return;
      const move = COMMAND_KEYS[command];
      void actions.rescheduleTask(row.task, move.when(today), move.label);
    });
  }, [actions, drawn, selectedId, today]);

  // Every list but the Logbook: see `capture`.
  const capturable = !(view.kind === "list" && view.list === "logbook");
  const counts = useCounts(state.tasks, today, offsetMinutes);
  const empty =
    today !== "" && sections.length === 0 && !state.loading && state.error === null;

  return (
    <section aria-label="Tasks" data-testid="tasks-surface" className="brain-tasks">
      <header className="brain-tasks-head">
        <TasksListMenu
          view={view}
          today={today}
          categories={categories}
          onSelect={(next) => onSelectList?.(next)}
        />
      </header>

      <div className="brain-tasks-scroll">
        {/* the head floats over the rows at every width, so the edge is
            unconditional and its height follows --mail-chrome in CSS (§7) */}
        <ScrollEdge variant="blur" steps={1} />
        <div className="brain-tasks-scrollfoot brain-tasks-scrollpad">
          {capturable && (
            <ul className="brain-tasks-rows" aria-label="New task">
              <TasksGhostRow captureRequest={captureRequest} onCreate={capture} />
            </ul>
          )}

          {state.error !== null && (
            <div className="brain-tasks-message">
              <Empty
                icon="checklist-linear"
                title="Tasks could not load"
                hint={state.error}
              />
              <Button variant="quiet" onClick={() => reloadTasks()}>
                Try again
              </Button>
            </div>
          )}

          <AnimatePresence initial={false}>
            {sections.map((section, index) => (
              <TaskGroup
                key={section.group.key}
                section={section}
                index={index}
                counted={view.kind === "list" && view.list === "logbook"}
                reduce={reduce}
                entrance={entrance}
                held={held}
                today={today}
                offsetMinutes={offsetMinutes}
                categories={categories.map((entry) => entry.category)}
                selectedId={selectedId}
                expandedId={expandedId}
                inserted={inserted}
                pageTitleOf={pageTitleOf}
                onOpenPage={onOpenPage}
                onSelect={setSelectedId}
                onSelectNext={selectNext}
                onExpand={setExpandedId}
                onComplete={actions.completeTask}
                onReopen={(task, refusal) =>
                  void actions.reopenTask(task, refusal)
                }
                onReschedule={actions.rescheduleTask}
                onPatch={actions.patchField}
                onFoldEnd={actions.releaseFold}
              />
            ))}
          </AnimatePresence>

          {empty && (
            <motion.div
              className="brain-tasks-empty"
              {...(reduce
                ? materializeFade
                : {
                    initial: { opacity: 0, scale: 0.96 },
                    animate: { opacity: 1, scale: 1 },
                    transition: SPRING_MATERIALIZE,
                  })}
            >
              <Empty {...emptyFor(view, counts)} />
            </motion.div>
          )}
        </div>
        {/* Below md this column runs under the mobile tab bar exactly as the
            mail one does (§7), and two lists in one slot are one design. */}
        <ScrollEdge
          variant="blur"
          position="bottom"
          steps={1}
          size={90}
          className="md:hidden"
        />
      </div>
    </section>
  );
}

/** The palette's rows and the row's keys resolve through one table. */
const COMMAND_KEYS: Record<TaskCommand, (typeof ROW_KEYS)[string]> = {
  "move-today": ROW_KEYS.t as (typeof ROW_KEYS)[string],
  "move-someday": ROW_KEYS.s as (typeof ROW_KEYS)[string],
};

/** The fields a chip inside an expanded row can set. Its one home is
 *  `components/tasks-actions`, beside the write that applies it; re-exported
 *  for the callers that already had the type from here. */
export type { TaskFieldPatch };

function TaskGroup({
  section,
  index,
  counted,
  reduce,
  entrance,
  held,
  today,
  offsetMinutes,
  categories,
  selectedId,
  expandedId,
  inserted,
  pageTitleOf,
  onOpenPage,
  onSelect,
  onSelectNext,
  onExpand,
  onComplete,
  onReopen,
  onReschedule,
  onPatch,
  onFoldEnd,
}: {
  section: TaskSection;
  index: number;
  /** The Logbook is the one list whose headers carry their size. */
  counted: boolean;
  reduce: boolean;
  entrance: boolean;
  held: ReadonlyMap<string, TaskView>;
  today: string;
  offsetMinutes: number;
  categories: string[];
  selectedId: string | null;
  expandedId: string | null;
  inserted: ReadonlySet<string>;
  pageTitleOf?: (pageId: string) => string | undefined;
  onOpenPage?: (pageId: string) => void;
  onSelect: (id: string) => void;
  onSelectNext: (afterId: string) => void;
  onExpand: (id: string | null) => void;
  onComplete: (task: TaskView) => Promise<void>;
  onReopen: (task: TaskView, refusal?: string) => void;
  onReschedule: (
    task: TaskView,
    when: string | "someday" | null,
    label: string,
  ) => Promise<void>;
  onPatch: (task: TaskView, patch: TaskFieldPatch) => void;
  onFoldEnd: (id: string) => void;
}) {
  const groupDelay = Math.min(index * GROUP_STEP, ENTRANCE_CEILING);
  // The count is what the LIST holds, so a row still folding is already out
  // of it: one decrement at 1300, and the row leaves at 1520.
  const count = section.rows.filter((row) => !held.has(row.task.id)).length;

  return (
    <motion.section
      className="brain-tasks-section"
      exit={{
        opacity: 0,
        height: 0,
        transition: {
          opacity: { duration: DUR.fast },
          height: { duration: DUR.page, ease: EASE_OUT },
        },
      }}
    >
      {section.group.label !== null && (
        <div className="brain-tasks-section-head">
          <motion.h2
            className="brain-tasks-section-label text-label"
            initial={entrance ? (reduce ? { opacity: 0 } : { opacity: 0, y: -4 }) : false}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: DUR.fast, delay: 0 } }}
            transition={{
              duration: DUR.base,
              ease: EASE_OUT,
              delay: reduce ? 0 : groupDelay,
            }}
          >
            {section.group.label}
            {counted && (
              /* One decrement, not a race: the number the optimistic write
                 moved at 1300 crossfades while the row below it is still
                 folding. Keyed on the count, so a re-render with the same
                 number does not blink. */
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={count}
                  className="brain-tasks-section-count"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                  transition={{ duration: DUR.fast }}
                >
                  {countSuffix(count)}
                </motion.span>
              </AnimatePresence>
            )}
          </motion.h2>
          <motion.span
            aria-hidden
            className="brain-tasks-rule"
            initial={entrance && !reduce ? { scaleX: 0 } : false}
            animate={{ scaleX: 1 }}
            exit={
              reduce
                ? { opacity: 0, transition: { duration: DUR.fast, delay: 0 } }
                : { scaleX: 0, transition: { duration: DUR.page, ease: EASE_OUT, delay: 0 } }
            }
            transition={{
              duration: DUR.page,
              ease: EASE_OUT,
              delay: reduce ? 0 : Math.min(groupDelay + RULE_STEP, ENTRANCE_CEILING),
            }}
          />
        </div>
      )}
      <ul className="brain-tasks-rows">
        {section.rows.map(({ key, task, untickable }, row) => (
          <TasksRow
            key={key}
            rowKey={key}
            historic={!untickable}
            task={task}
            today={today}
            offsetMinutes={offsetMinutes}
            reduce={reduce}
            selected={key === selectedId}
            expanded={key === expandedId}
            categories={categories}
            pageTitle={task.page ? pageTitleOf?.(task.page) : undefined}
            entrance={
              entrance
                ? {
                    delay: Math.min(groupDelay + row * ROW_STEP, ENTRANCE_CEILING),
                  }
                : inserted.has(task.id)
                  ? "insert"
                  : false
            }
            onSelect={onSelect}
            onSelectNext={onSelectNext}
            onExpand={onExpand}
            onComplete={onComplete}
            onReopen={onReopen}
            onReschedule={onReschedule}
            onPatch={onPatch}
            onFoldEnd={onFoldEnd}
            onOpenPage={onOpenPage}
          />
        ))}
      </ul>
    </motion.section>
  );
}

/** `Today` + ` · 5`. The word and its size are two boxes so the size can
 *  crossfade on its own; the separator keeps its leading space so the two
 *  read as one string, and `headerLabel` stays the one spelling of that
 *  string for anything that needs it in one piece. */
function countSuffix(count: number): string {
  return headerLabel("", count);
}

/** The two numbers the empty states report. Its one home is
 *  `components/tasks-lists`, beside the derive that says which list a record
 *  is in; Home's Today block reads the same one. */
export type { TaskCounts };

function useCounts(
  tasks: readonly TaskView[],
  today: string,
  offsetMinutes: number,
): TaskCounts {
  return useMemo(
    () => countsFor(tasks, today, offsetMinutes),
    [offsetMinutes, tasks, today],
  );
}

/** Seven states, and the two Today hints are alternatives rather than both. */
export function emptyFor(
  view: TasksView,
  counts: TaskCounts,
): { icon: "checklist-linear"; title: string; hint?: string } {
  if (view.kind === "category") {
    return { icon: "checklist-linear", title: "Nothing here" };
  }
  if (view.list === "today") {
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
          : "Add one above",
    };
  }
  if (view.list === "inbox") {
    return {
      icon: "checklist-linear",
      title: "Inbox is clear",
      hint: "Checkboxes in notes and MCP land here",
    };
  }
  if (view.list === "upcoming") {
    return { icon: "checklist-linear", title: "Nothing scheduled" };
  }
  if (view.list === "someday") {
    return { icon: "checklist-linear", title: "Nothing parked" };
  }
  return {
    icon: "checklist-linear",
    title: "Nothing done yet",
    hint: "Completed tasks land here, by day",
  };
}

/** ONCE PER CALENDAR DAY, on the first mount of Today.
 *
 *  The flag flips in a microtask after the first render that has sections,
 *  the `entranceDone` pattern Mail's unified list uses, so rows mounted later
 *  render settled. The day is remembered across mounts, because a reader who
 *  walks to Mail and back has not earned the morning twice; and a date change
 *  in an open tab does not replay it either, since the flag is already down.
 */
function useEntrance({
  today,
  replay,
  ready,
}: {
  today: string;
  replay: boolean;
  ready: boolean;
}): boolean {
  const [done, setDone] = useState(false);
  const play = !done && ready && replay && lastEntranceDay() !== today;

  // The flag goes down in a microtask right after the first render that had
  // rows, never as a synchronous setState inside the effect. Rows that
  // animated their mount ignore a later `initial`, so the flip only reaches
  // the ones mounted after it.
  useEffect(() => {
    if (done || !ready || !today) return;
    queueMicrotask(() => setDone(true));
  });

  useEffect(() => {
    if (play) rememberEntranceDay(today);
  }, [play, today]);

  return play;
}

function lastEntranceDay(): string | null {
  try {
    return window.localStorage.getItem(ENTRANCE_KEY);
  } catch {
    // a browser with storage off gets the entrance once per mount
    return null;
  }
}

function rememberEntranceDay(today: string): void {
  try {
    window.localStorage.setItem(ENTRANCE_KEY, today);
  } catch {
    // same
  }
}

/** The column's own cursor. The capsule flows between rows on `layoutId`, so
 *  what moves here is one string. */
function useArrowKeys({
  order,
  selectedId,
  setSelectedId,
  setExpandedId,
}: {
  order: readonly string[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  setExpandedId: (id: string | null) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpandedId(null);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, [contenteditable]")) return;
      if (order.length === 0) return;
      event.preventDefault();
      const at = selectedId === null ? -1 : order.indexOf(selectedId);
      const next =
        event.key === "ArrowDown"
          ? Math.min(at + 1, order.length - 1)
          : Math.max(at - 1, 0);
      setSelectedId(order[next] ?? null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selectedId, setExpandedId, setSelectedId]);
}
