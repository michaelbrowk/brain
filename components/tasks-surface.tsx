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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  EVENING_GROUP_KEY,
  belongs,
  categoriesOf,
  countsFor,
  headerLabel,
  listOf,
  sectionsFor,
  type TaskCounts,
  type TaskSection,
  type TasksView,
} from "./tasks-lists";
import { ROW_KEYS, TasksRow, tomorrowOf, whenValueFor } from "./tasks-row";
import type { WhenValue } from "./tasks-when-picker";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
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
  const actions = useTaskActions({ today, offsetMinutes, onToast });
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
  /** A history row (a repeat's past completion) answers no key, so the
   *  arrows step over it; only rows that can be acted on take the capsule. */
  const order = useMemo(
    () => drawn.filter((row) => row.untickable).map((row) => row.key),
    [drawn],
  );

  /** AN EXPANSION DOES NOT SURVIVE THE COMPLETION IT IS OPEN OVER.
   *
   *  Tick the checkbox of a row whose chips are open and the chips would stay:
   *  the box stops the press from reaching the row, `openRow` refuses an inert
   *  row, and every key on it is dead, so a When menu and a category picker
   *  would sit live over a record the reader has finished with and nothing
   *  short of an arrow key would shut them.
   *
   *  Read off the RECORD and derived during the render, not cleared by the
   *  gesture in an effect: a completion that arrives from another tab closes
   *  it the same way, there is no frame in which the chips are drawn over a
   *  struck title, and `react-hooks/set-state-in-effect` is right that a value
   *  a render can compute is not state to write.
   *
   *  So an Undo puts the chips back where the reader left them, because they
   *  never dismissed them. That is the one consequence of deriving rather than
   *  clearing, and it is the behaviour Undo should have. */
  const expandedKey =
    drawn.find((row) => row.key === expandedId)?.task.done === true
      ? null
      : expandedId;

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
    (title: string, picked: WhenValue) => {
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
      // WHAT THE READER PICKED WINS over the list's own seed, and only what
      // they picked: a line typed into Today with no picking still lands
      // today, because an untouched chip answers `when: null` and overrides
      // nothing. A clock and an evening both need a day, so neither travels
      // without one.
      const chosen =
        picked.when === null
          ? {}
          : {
              when: picked.when,
              ...(picked.time !== null ? { time: picked.time } : {}),
              ...(picked.evening ? { evening: true as const } : {}),
            };
      void createTask({ title, ...seed, ...chosen })
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

  /** WHICH ROW HAS A LAYER OPEN ABOVE IT, if any. A ref and not state: it is
   *  read on a keydown and nothing on screen is drawn from it, so a render per
   *  panel would be a render for nobody. Keyed by row, so the fold of one row
   *  cannot take down the flag another row's panel raised. */
  const layerRow = useRef<string | null>(null);
  const noteLayer = useCallback((key: string, open: boolean) => {
    if (open) layerRow.current = key;
    else if (layerRow.current === key) layerRow.current = null;
  }, []);

  const selectNext = useCallback(
    (afterId: string) => {
      const at = order.indexOf(afterId);
      setSelectedId(order[at + 1] ?? order[at - 1] ?? null);
    },
    [order],
  );

  useArrowKeys({ order, selectedId, setSelectedId });
  useEscapeLayers({ layerRow, setExpandedId });
  useNamedTask({
    tasks: state.tasks,
    loading: state.loading,
    today,
    offsetMinutes,
    view,
    reduce,
    onSelectList,
    setSelectedId,
  });

  // The palette's two rows and the row's two keys are one action each.
  useEffect(() => {
    return onTaskCommand((command) => {
      const row = drawn.find((entry) => entry.key === selectedId);
      // A Logbook row that is history moves nothing, the same answer the bare
      // letters give on the row itself.
      if (!row || !row.untickable) return;
      const move = COMMAND_KEYS[command];
      void actions.rescheduleTask(
        row.task,
        whenValueFor(row.task, move.when(today)),
        move.label,
      );
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
              <TasksGhostRow
                captureRequest={captureRequest}
                today={today}
                onCreate={capture}
              />
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
                expandedId={expandedKey}
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
                onLayer={noteLayer}
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

/** ONE ROW, NAMED IN THE URL: `/tasks?task=<id>`.
 *
 *  Something outside this column points at one task: a notification, a row on
 *  Home, a link in a note. The column has to show it wherever it lives.
 *  The list is switched when the record is not in the open one, the capsule
 *  lands on the row, and the query LEAVES WITH IT: a `?task=` left in the bar
 *  would take the reader back to that row every time they came to Tasks, and
 *  the open list is navigation state the shell already owns.
 *
 *  A missing id selects nothing and says nothing: a link to a task somebody
 *  has since deleted is not an error to report to whoever followed it. The
 *  query still leaves, because that is an answer too, and one left standing is
 *  read again on every refetch. The records have to be in before it can be
 *  told apart from a record that has not loaded yet, which is what `loading`
 *  is read for. */
function useNamedTask({
  tasks,
  loading,
  today,
  offsetMinutes,
  view,
  reduce,
  onSelectList,
  setSelectedId,
}: {
  tasks: readonly TaskView[];
  loading: boolean;
  today: string;
  offsetMinutes: number;
  view: TasksView;
  reduce: boolean;
  onSelectList?: (list: TasksListState | null) => void;
  setSelectedId: (id: string | null) => void;
}) {
  // THE URL IS THE STATE, so there is none of its own here: the query is read
  // on every run and taken off once it has been ANSWERED, which is what stops
  // the next run. `nav` exists only so Back and Forward cause a run at all,
  // and `asked` carries the id across a list switch, because opening a list is
  // a navigation and the query may not survive it.
  const [nav, setNav] = useState(0);
  const asked = useRef<string | null>(null);

  useEffect(() => {
    const bump = () => setNav((count) => count + 1);
    window.addEventListener("popstate", bump);
    return () => window.removeEventListener("popstate", bump);
  }, []);

  useEffect(() => {
    const id = taskParam() ?? asked.current;
    if (id === null || today === "") return;
    const task = tasks.find((entry) => entry.id === id);
    if (task === undefined) {
      // Not loaded yet is not the same answer as not there.
      if (loading) return;
      // NOTHING TO ACT ON, and nothing said: a link to a task somebody has
      // since deleted is not an error to report to whoever followed it. The
      // query comes off all the same, because the surface HAS answered it:
      // there is no such task. A `?task=` left standing is read again on every
      // dependency change, so an id that becomes resolvable later would select
      // that row and scroll the column long after the reader followed the
      // link.
      asked.current = null;
      clearTaskParam();
      return;
    }
    if (!belongs(task, view, today, offsetMinutes)) {
      // The list the record lives in, which the shell opens. This runs again
      // once it has, and the row is drawn by then.
      asked.current = id;
      onSelectList?.(listOf(task, today, offsetMinutes));
      return;
    }
    asked.current = null;
    setSelectedId(id);
    const row = document.querySelector<HTMLElement>(
      `.brain-task-row-item[data-task-id="${CSS.escape(id)}"]`,
    );
    row?.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
    clearTaskParam();
  }, [loading, nav, offsetMinutes, onSelectList, reduce, setSelectedId, tasks, today, view]);
}

function taskParam(): string | null {
  if (typeof window === "undefined") return null;
  const id = new URLSearchParams(window.location.search).get("task");
  return id === null || id === "" ? null : id;
}

/** The rest of the URL and the shell's navigation state both stand: only the
 *  one query this surface answers to comes off. */
function clearTaskParam(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("task")) return;
  url.searchParams.delete("task");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
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
  onLayer,
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
  onComplete: (task: TaskView, refusal?: string) => Promise<void>;
  onReopen: (task: TaskView, refusal?: string) => void;
  onReschedule: (task: TaskView, value: WhenValue, label: string) => Promise<void>;
  onPatch: (task: TaskView, patch: TaskFieldPatch) => void;
  onFoldEnd: (id: string) => void;
  /** Whether one of this group's rows has a layer open above it. */
  onLayer: (rowKey: string, open: boolean) => void;
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
          {/* Spec 2. THE EVENING IS A PART OF THE DAY, not one more category,
              and the moon is what says so: every other header on this surface
              is a word a person typed or a date. It arrives with the label it
              belongs to rather than appearing under it. `lib/tasks/lists.ts`
              says a group carries no glyph and the renderer draws this one. */}
          {section.group.key === EVENING_GROUP_KEY && (
            <motion.span
              aria-hidden
              className="brain-tasks-section-moon"
              initial={entrance ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: DUR.fast, delay: 0 } }}
              transition={{
                duration: DUR.base,
                ease: EASE_OUT,
                delay: reduce ? 0 : groupDelay,
              }}
            >
              <Icon name="moon-linear" size={14} />
            </motion.span>
          )}
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
            onLayer={onLayer}
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
        hint: `${counts.doneToday} completed`,
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
}: {
  order: readonly string[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
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
  }, [order, selectedId, setSelectedId]);
}

/** ESCAPE PEELS ONE LAYER AT A TIME.
 *
 *  One key used to close the calendar AND fold the row under it: the picker
 *  answered on its own element, this listener answered on the window, and a
 *  reader who asked for the panel to go lost the row they were working in. A
 *  press outside has never spent two dismissals at once — the panel takes the
 *  press and the row is the next one — and the key says the same sentence.
 *  Escape #1 closes the layer and leaves the row standing with the focus back
 *  on the control that opened it, Escape #2 folds the row. Things behaves this
 *  way.
 *
 *  THE ROW SAYS WHETHER IT HAS A LAYER, and this asks it rather than looking:
 *  every panel a chip opens is portalled to the end of the document, and the
 *  caret in a title is an `input` with no flag on anything.
 *
 *  AND THE ORDERING IS THE WHOLE OF IT. Radix dismisses its own layers from a
 *  `keydown` listener on the DOCUMENT in the capture phase
 *  (`@radix-ui/react-dismissable-layer`), so any listener further along the
 *  path reads the row's signal with the layer already gone and folds the row
 *  on the key that closed the panel. The window's capture phase is the FIRST
 *  stop a key makes, before the document's, so the answer here is read while
 *  the layer is still standing to be read. */
function useEscapeLayers({
  layerRow,
  setExpandedId,
}: {
  /** The row with a layer open above it, or `null`. */
  layerRow: React.RefObject<string | null>;
  setExpandedId: (id: string | null) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The layer's key, and the layer's own listener is the one that answers
      // it. The row is the next one.
      if (layerRow.current !== null) return;
      setExpandedId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [layerRow, setExpandedId]);
}
