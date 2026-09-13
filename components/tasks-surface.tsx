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
import { listOf } from "@/lib/tasks/lists";
import type { TaskView } from "@/lib/tasks/model";

import { SMART_UNDO_MS, type TasksListState } from "./shell/helpers";
import {
  TaskRequestError,
  createTask,
  mutateTasks,
  patchTask,
  reloadTasks,
  useTasks,
} from "./tasks-client";
import { TasksGhostRow } from "./tasks-ghost-row";
import { TasksListMenu } from "./tasks-list-menu";
import {
  categoriesOf,
  headerLabel,
  sectionsFor,
  type TaskSection,
  type TasksView,
} from "./tasks-lists";
import { TasksRow } from "./tasks-row";
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

  /** Rows the fold is still playing on. They keep their PRE-write record, so
   *  a completed task stays where it was for the 220ms it takes to leave
   *  while the counts beside it have already moved on. That is the spec's one
   *  decrement, at 1300, with the row still on screen until 1520. */
  const [held, setHeld] = useState<ReadonlyMap<string, TaskView>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [inserted, setInserted] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(
    () => state.tasks.map((task) => held.get(task.id) ?? task),
    [held, state.tasks],
  );
  const sections = useMemo(
    () => (today ? sectionsFor(rows, view, today, offsetMinutes) : []),
    [offsetMinutes, rows, today, view],
  );
  const categories = useMemo(() => categoriesOf(state.tasks), [state.tasks]);

  const order = useMemo(
    () => sections.flatMap((section) => section.tasks.map((task) => task.id)),
    [sections],
  );

  const entrance = useEntrance({
    today,
    replay: view.kind === "list" && view.list === "today",
    ready: sections.length > 0,
  });

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

  const refuse = useCallback(
    (error: unknown) => {
      const message =
        error instanceof TaskRequestError && error.message
          ? error.message
          : "That did not save";
      onToast?.(message, { urgent: true });
    },
    [onToast],
  );

  const reopenTask = useCallback(
    async (task: TaskView) => {
      mutateTasks((tasks) =>
        tasks.map((entry) =>
          entry.id === task.id ? { ...task, done: false, doneAt: undefined } : entry,
        ),
      );
      try {
        const saved = await patchTask(task.id, { done: false });
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
      } catch (error) {
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === task.id ? task : entry)),
        );
        refuse(error);
      }
    },
    [refuse],
  );

  /** The write is issued HERE, at 1300, called by the row as its fold starts.
   *  Nothing was sent before this point, so a cancelled completion leaves no
   *  request, no `rev` bump and no commit behind it. */
  const completeTask = useCallback(
    async (task: TaskView) => {
      hold(task);
      mutateTasks((tasks) =>
        tasks.map((entry) =>
          entry.id === task.id
            ? { ...entry, done: true, doneAt: new Date().toISOString() }
            : entry,
        ),
      );
      onToast?.("Completed", {
        actionLabel: "Undo",
        durationMs: SMART_UNDO_MS,
        onAction: () => {
          void reopenTask(task);
        },
      });
      try {
        const saved = await patchTask(
          task.id,
          { done: true },
          task.repeat ? today : undefined,
        );
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
      } catch (error) {
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === task.id ? task : entry)),
        );
        refuse(error);
        throw error;
      }
    },
    [hold, onToast, refuse, reopenTask, today],
  );

  const rescheduleTask = useCallback(
    async (task: TaskView, when: string | "someday" | null, label: string) => {
      hold(task);
      mutateTasks((tasks) =>
        tasks.map((entry) =>
          entry.id === task.id ? { ...entry, when: when ?? undefined } : entry,
        ),
      );
      onToast?.(`Moved to ${label}`, {
        actionLabel: "Undo",
        durationMs: SMART_UNDO_MS,
        onAction: () => {
          mutateTasks((tasks) =>
            tasks.map((entry) => (entry.id === task.id ? task : entry)),
          );
          void patchTask(task.id, { when: task.when ?? null }).catch(refuse);
        },
      });
      try {
        const saved = await patchTask(task.id, { when });
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
        );
      } catch (error) {
        mutateTasks((tasks) =>
          tasks.map((entry) => (entry.id === task.id ? task : entry)),
        );
        refuse(error);
        throw error;
      }
    },
    [hold, onToast, refuse],
  );

  const patchField = useCallback(
    (
      task: TaskView,
      patch: { title?: string; deadline?: string | null; category?: string | null },
    ) => {
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

  /** A task captured in a list lands IN that list, which is the only reading
   *  of the ghost row that does not make the reader file what they just
   *  wrote. Upcoming and the Logbook have no day to give it, so a task
   *  written there lands in the Inbox. */
  const capture = useCallback(
    (title: string) => {
      const seed =
        view.kind === "category"
          ? view.category
            ? { category: view.category }
            : {}
          : view.list === "today"
            ? { when: today }
            : view.list === "someday"
              ? { when: "someday" }
              : {};
      void createTask({ title, ...seed })
        .then((task) => {
          setInserted((current) => new Set(current).add(task.id));
          mutateTasks((tasks) => [task, ...tasks]);
        })
        .catch(refuse);
    },
    [refuse, today, view],
  );

  const selectNext = useCallback(
    (afterId: string) => {
      const at = order.indexOf(afterId);
      setSelectedId(order[at + 1] ?? order[at - 1] ?? null);
    },
    [order],
  );

  useArrowKeys({ order, selectedId, setSelectedId, setExpandedId });

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
          <ul className="brain-tasks-rows" aria-label="New task">
            <TasksGhostRow captureRequest={captureRequest} onCreate={capture} />
          </ul>

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
                onComplete={completeTask}
                onReopen={(task) => void reopenTask(task)}
                onReschedule={rescheduleTask}
                onPatch={patchField}
                onFoldEnd={releaseFold}
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

function normalize(patch: {
  title?: string;
  deadline?: string | null;
  category?: string | null;
}): Partial<TaskView> {
  return {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.deadline !== undefined ? { deadline: patch.deadline ?? undefined } : {}),
    ...(patch.category !== undefined ? { category: patch.category ?? undefined } : {}),
  };
}

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
  onReopen: (task: TaskView) => void;
  onReschedule: (
    task: TaskView,
    when: string | "someday" | null,
    label: string,
  ) => Promise<void>;
  onPatch: (
    task: TaskView,
    patch: { title?: string; deadline?: string | null; category?: string | null },
  ) => void;
  onFoldEnd: (id: string) => void;
}) {
  const groupDelay = Math.min(index * GROUP_STEP, ENTRANCE_CEILING);
  // The count is what the LIST holds, so a row still folding is already out
  // of it: one decrement at 1300, and the row leaves at 1520.
  const count = section.tasks.filter((task) => !held.has(task.id)).length;

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
            exit={{ opacity: 0, transition: { duration: DUR.fast } }}
            transition={{
              duration: DUR.base,
              ease: EASE_OUT,
              delay: reduce ? 0 : groupDelay,
            }}
          >
            {counted ? headerLabel(section.group.label, count) : section.group.label}
          </motion.h2>
          <motion.span
            aria-hidden
            className="brain-tasks-rule"
            initial={entrance && !reduce ? { scaleX: 0 } : false}
            animate={{ scaleX: 1 }}
            exit={reduce ? { opacity: 0 } : { scaleX: 0 }}
            transition={{
              duration: DUR.page,
              ease: EASE_OUT,
              delay: reduce ? 0 : Math.min(groupDelay + RULE_STEP, ENTRANCE_CEILING),
            }}
          />
        </div>
      )}
      <ul className="brain-tasks-rows">
        {section.tasks.map((task, row) => (
          <TasksRow
            key={task.id}
            task={task}
            today={today}
            offsetMinutes={offsetMinutes}
            reduce={reduce}
            selected={task.id === selectedId}
            expanded={task.id === expandedId}
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

export interface TaskCounts {
  doneToday: number;
  upcomingThisWeek: number;
}

function useCounts(
  tasks: readonly TaskView[],
  today: string,
  offsetMinutes: number,
): TaskCounts {
  return useMemo(() => {
    if (!today) return { doneToday: 0, upcomingThisWeek: 0 };
    let doneToday = 0;
    let upcomingThisWeek = 0;
    for (const task of tasks) {
      const list = listOf(task, today);
      if (list === "logbook") {
        if (task.doneAt && doneDay(task.doneAt, offsetMinutes) === today) doneToday += 1;
        continue;
      }
      if (list === "upcoming" && withinWeek(task, today)) upcomingThisWeek += 1;
    }
    return { doneToday, upcomingThisWeek };
  }, [offsetMinutes, tasks, today]);
}

function doneDay(iso: string, offsetMinutes: number): string {
  return new Date(Date.parse(iso) + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function withinWeek(task: TaskView, today: string): boolean {
  const days = [task.when, task.deadline].filter(
    (value): value is string => typeof value === "string" && value > today,
  );
  if (days.length === 0) return false;
  const soonest = days.sort()[0] as string;
  const limit = new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) - 1,
      Number(today.slice(8, 10)) + 7,
    ),
  )
    .toISOString()
    .slice(0, 10);
  return soonest <= limit;
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
