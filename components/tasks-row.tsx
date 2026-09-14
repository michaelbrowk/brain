"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  type MotionValue,
} from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DUR,
  EASE_OUT,
  HOVER,
  SPRING_MATERIALIZE,
  SPRING_SELECT,
  SPRING_SHEET_GESTURE,
  materializeFade,
} from "@/lib/motion";
import type { TaskRepeat, TaskView } from "@/lib/tasks/model";

import { CategoryPicker } from "./category-picker";
import {
  EASE_OUT_CSS,
  TaskCheckbox,
  setTaskCheckboxChecked,
} from "./tasks-checkbox";
import {
  deadlineCaption,
  dayLabel,
  doneTimeOf,
  overdueWhenCaption,
  repeatNextLabel,
} from "./tasks-lists";
import { TasksRepeatMenu } from "./tasks-repeat-menu";
import { Icon } from "./ui/icon";

/** THE ROW, AND THE TWO DIRECTIONS IT CAN LEAVE IN.
 *
 *  Done folds UP, into the past. Every reschedule folds DOWN, into the
 *  future. The two verbs never overlap and neither scales the text: a row
 *  leaving is a capsule folding into its own edge (`clip-path` plus real
 *  height), so the words are cut off by an edge rather than shrunk.
 *
 *  The completion is a 1200ms hold and the write is issued at its end, not at
 *  the press. A reader who changes their mind inside the window erases the
 *  check and nothing was ever sent: no request, no `rev` bump, no commit.
 *  That is why the draw runs on WAAPI and not on a CSS transition: a cancel
 *  has to interrupt it from wherever it is.
 */

/** The one flowing selection capsule of the column. */
export const TASKS_SELECT_LAYOUT_ID = "tasks-select";

/** The hold: 100ms for the box to settle, then 1200 the row does not move. */
const SETTLE_MS = 100;
const HOLD_MS = 1200;
export const WRITE_AT_MS = SETTLE_MS + HOLD_MS;

const FOLD_MS = DUR.page * 1000;
const FADE_MS = DUR.fast * 1000;
/** The opacity takes the last 120 of the fold's 220. */
const FADE_DELAY_MS = FOLD_MS - FADE_MS;

/* The swipe, in the composer's own numbers. */
const AXIS_HYSTERESIS_PX = 10;
const WORD_AT_PX = 24;
const RUBBER_AT_PX = 160;
const RUBBER_TENSION = 0.55;
const COMMIT_PX = 120;
const COMMIT_VELOCITY = 800;
/** Past the column's own edge; the fold takes the height from there. */
const EXIT_PX = 420;

export type FoldDirection = "up" | "down";

export interface TaskRowHandle {
  readonly finished: Promise<void>;
  cancel(): void;
}

/** `clip-path` plus `height`, on WAAPI. Up cuts the row off at its top edge,
 *  down at its bottom one. Returns a handle because a failed write has to be
 *  able to put the row back mid-flight. */
export function foldRow(
  element: HTMLElement,
  direction: FoldDirection,
  reduce: boolean,
): TaskRowHandle {
  const height = element.offsetHeight;
  if (typeof element.animate !== "function") {
    return { finished: Promise.resolve(), cancel: () => {} };
  }
  const clipTo = direction === "up" ? "inset(0 0 100% 0)" : "inset(100% 0 0 0)";
  // Reduced motion: a 120ms opacity fade and an immediate reflow, the way
  // Mail's `exitFades` leaves a row. Nothing travels and no height animates.
  const animation = reduce
    ? element.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: EASE_OUT_CSS,
        fill: "forwards",
      })
    : element.animate(
        [
          { clipPath: "inset(0 0 0 0)", height: `${height}px`, opacity: 1, offset: 0 },
          { opacity: 1, offset: FADE_DELAY_MS / FOLD_MS },
          { clipPath: clipTo, height: "0px", opacity: 0, offset: 1 },
        ],
        { duration: FOLD_MS, easing: EASE_OUT_CSS, fill: "forwards" },
      );
  return {
    finished: animation.finished.then(
      () => undefined,
      () => undefined,
    ),
    cancel: () => animation.cancel(),
  };
}

export interface TasksRowProps {
  task: TaskView;
  /** What the COLUMN calls this row. The Logbook draws one row per completion,
   *  so a repeating task has several rows carrying one record id, and the
   *  selection has to be able to tell them apart. Defaults to the id. */
  rowKey?: string;
  /** A Logbook row that is history: an older completion of a repeating task.
   *  It has nothing left to undo, so its box does not toggle and the row does
   *  not open. */
  historic?: boolean;
  today: string;
  offsetMinutes: number;
  reduce: boolean;
  selected: boolean;
  expanded: boolean;
  /** Categories already in use, for the picker inside an expanded row. */
  categories: readonly string[];
  /** The title of the note a linked or detached task points at. */
  pageTitle?: string;
  /** Play the arrival: the morning entrance, or a row inserted afterwards. */
  entrance?: { delay: number } | "insert" | false;
  onSelect: (id: string) => void;
  /** ⌘⏎ moves the capsule on at once and the fold plays behind it. */
  onSelectNext: (afterId: string) => void;
  onExpand: (id: string | null) => void;
  /** Resolves when the write landed, rejects when the route refused it. */
  onComplete: (task: TaskView) => Promise<void>;
  onReopen: (task: TaskView) => void;
  onReschedule: (task: TaskView, when: string | "someday" | null, label: string) => Promise<void>;
  onPatch: (
    task: TaskView,
    patch: {
      title?: string;
      deadline?: string | null;
      category?: string | null;
      repeat?: TaskRepeat | null;
    },
  ) => void;
  onFoldEnd: (id: string) => void;
  onOpenPage?: (pageId: string) => void;
}

export function TasksRow({
  task,
  rowKey,
  historic = false,
  today,
  offsetMinutes,
  reduce,
  selected,
  expanded,
  categories,
  pageTitle,
  entrance = false,
  onSelect,
  onSelectNext,
  onExpand,
  onComplete,
  onReopen,
  onReschedule,
  onPatch,
  onFoldEnd,
  onOpenPage,
}: TasksRowProps) {
  const key = rowKey ?? task.id;
  const wrapRef = useRef<HTMLLIElement | null>(null);
  const boxRef = useRef<HTMLButtonElement | null>(null);
  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [swipeSide, setSwipeSide] = useState<"left" | "right" | null>(null);
  const x = useMotionValue(0);

  const linked = task.page !== undefined && task.detachedAt === undefined;
  const detached = task.detachedAt !== undefined;
  const overdueWhen = overdueWhenCaption(task, today);
  const deadline = deadlineCaption(task, today);
  const repeatNext = repeatNextLabel(task, today);

  useEffect(
    () => () => {
      if (holdRef.current) clearTimeout(holdRef.current);
    },
    [],
  );

  const cancelHold = useCallback(() => {
    if (!holdRef.current) return false;
    clearTimeout(holdRef.current);
    holdRef.current = null;
    setHolding(false);
    if (boxRef.current) setTaskCheckboxChecked(boxRef.current, false, reduce);
    return true;
  }, [reduce]);

  /** The fold and the write start on the same beat, 1300ms after the press.
   *  A refusal cancels the fold and puts the box back. */
  const commit = useCallback(async () => {
    const element = wrapRef.current;
    const fold = element ? foldRow(element, "up", reduce) : null;
    let refused = false;
    try {
      await onComplete(task);
    } catch {
      refused = true;
    }
    if (refused) {
      fold?.cancel();
      if (boxRef.current) setTaskCheckboxChecked(boxRef.current, false, reduce);
      // Everything the hold changed goes back, not only the tick. `holding`
      // dims the title and grows the tail that names the next occurrence, so
      // a row left holding after a refusal reads as completed while the toast
      // says it failed.
      setHolding(false);
      onFoldEnd(task.id);
      return;
    }
    await fold?.finished;
    onFoldEnd(task.id);
  }, [onComplete, onFoldEnd, reduce, task]);

  const beginHold = useCallback(() => {
    if (boxRef.current) setTaskCheckboxChecked(boxRef.current, true, reduce);
    setHolding(true);
    holdRef.current = setTimeout(() => {
      holdRef.current = null;
      void commit();
    }, WRITE_AT_MS);
  }, [commit, reduce]);

  const toggle = useCallback(() => {
    // An older completion of a repeating series is history: the untick is
    // offered on the newest one only, so there is nothing here to undo.
    if (historic) return;
    if (task.done) {
      onReopen(task);
      return;
    }
    if (cancelHold()) return;
    beginHold();
  }, [beginHold, cancelHold, historic, onReopen, task]);

  /** ⌘⏎: the SELECTION moves on at once and the fold plays behind it. The
   *  hold is unchanged, because the way back has nothing to do with which hand made
   *  the gesture, and a keyboard completion that wrote immediately would be
   *  the one path with no way back. */
  const completeNow = useCallback(() => {
    onSelectNext(key);
    if (holdRef.current) return;
    beginHold();
  }, [beginHold, key, onSelectNext]);

  const leaveDown = useCallback(
    async (when: string | "someday" | null, label: string) => {
      const element = wrapRef.current;
      const fold = element ? foldRow(element, "down", reduce) : null;
      let refused = false;
      try {
        await onReschedule(task, when, label);
      } catch {
        refused = true;
      }
      if (refused) fold?.cancel();
      else await fold?.finished;
      onFoldEnd(task.id);
    },
    [onFoldEnd, onReschedule, reduce, task],
  );

  useRowShortcuts({
    selected,
    expanded,
    completeNow,
    leaveDown,
    onExpand,
    today,
    rowKey: key,
    historic,
  });

  const swipeHandlers = useSwipe({
    x,
    reduce,
    enabled: !task.done && !historic && !expanded,
    onWord: setSwipeSide,
    onCommit: (side) => {
      setSwipeSide(null);
      void leaveDown(
        side === "right" ? tomorrowOf(today) : "someday",
        side === "right" ? "Tomorrow" : "Someday",
      );
    },
    onRelease: () => setSwipeSide(null),
  });

  const openRow = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-task-control]")) return;
    onSelect(key);
    // A history row opens nothing: its chips would edit the live record from
    // under a completion that is over, and its title is not the record's to
    // change from here either.
    if (historic) return;
    // The title becomes editable on a SECOND tap, not on expansion, so a
    // phone keyboard does not rise from opening a row.
    if (expanded && (event.target as HTMLElement).closest(".brain-task-title")) {
      setDraft(task.title);
      setEditing(true);
      return;
    }
    onExpand(expanded ? null : key);
  };

  const commitTitle = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== task.title) onPatch(task, { title: next });
  };

  const arrival =
    entrance === false
      ? false
      : entrance === "insert"
        ? reduce
          ? { opacity: 0 }
          : { opacity: 0, height: 0 }
        : reduce
          ? { opacity: 0 }
          : { opacity: 0, y: 6 };
  const arrivalDelay = entrance && entrance !== "insert" ? entrance.delay : 0;

  return (
    <motion.li
      ref={wrapRef}
      className="brain-task-row-item"
      data-task-id={task.id}
      data-holding={holding ? "" : undefined}
      initial={arrival}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, height: "auto" }}
      transition={{
        duration: entrance === "insert" ? DUR.page : DUR.base,
        ease: EASE_OUT,
        delay: reduce ? 0 : arrivalDelay,
      }}
    >
      <div className="brain-task-swipe">
        <AnimatePresence>
          {swipeSide && (
            <motion.span
              className="brain-task-word"
              data-side={swipeSide}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: HOVER.in, ease: EASE_OUT }}
            >
              <Icon
                name={swipeSide === "right" ? "calendar-date" : "box-minimalistic"}
                size={16}
              />
              {swipeSide === "right" ? "Tomorrow" : "Someday"}
            </motion.span>
          )}
        </AnimatePresence>
        <motion.div
          className="brain-task-row"
          data-selected={selected ? "" : undefined}
          data-expanded={expanded ? "" : undefined}
          data-done={task.done ? "" : undefined}
          style={{ x }}
          onClick={openRow}
          {...swipeHandlers}
        >
          {selected && (
            <motion.span
              aria-hidden
              className="tree-row-capsule"
              layoutId={reduce ? undefined : TASKS_SELECT_LAYOUT_ID}
              transition={SPRING_SELECT}
            />
          )}
          <TaskCheckbox
            checked={task.done}
            label={task.title}
            reduce={reduce}
            onToggle={toggle}
            onBox={(box) => {
              boxRef.current = box;
            }}
          />
          <span className="brain-task-main">
            <span className="brain-task-line">
              {editing ? (
                <input
                  data-task-control
                  autoFocus
                  aria-label="Task title"
                  className="brain-task-input"
                  dir="auto"
                  value={draft}
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onBlur={commitTitle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitTitle();
                    if (event.key === "Escape") setEditing(false);
                  }}
                />
              ) : (
                <span className="brain-task-title truncate" dir="auto">
                  {task.title}
                </span>
              )}
              <span className="brain-task-tail">
                {linked && <Icon name="document-text" size={14} className="text-ink-3" />}
                {task.repeat && <Icon name="restart" size={14} className="text-ink-3" />}
                {/* Spec 2.1, t=100: a repeat grows `restart` plus the day the
                    next one lands on, so the row says where it went before it
                    goes. `materializeFade` is the spec's own choice here and
                    is a crossfade in both motion settings. */}
                <AnimatePresence>
                  {holding && repeatNext && (
                    <motion.span
                      key={repeatNext}
                      className="brain-task-caption"
                      {...materializeFade}
                    >
                      {repeatNext}
                    </motion.span>
                  )}
                </AnimatePresence>
                {detached ? (
                  <span className="brain-task-caption">
                    line removed from {pageTitle ?? "a note"}
                  </span>
                ) : task.done && task.doneAt ? (
                  <span className="brain-task-caption">
                    {doneTimeOf(task.doneAt, offsetMinutes)}
                  </span>
                ) : deadline ? (
                  <span
                    className="brain-task-caption"
                    data-overdue={deadline.overdue ? "" : undefined}
                  >
                    {deadline.label}
                  </span>
                ) : overdueWhen ? (
                  <span className="brain-task-caption">{overdueWhen}</span>
                ) : null}
              </span>
            </span>
            <AnimatePresence initial={false}>
              {expanded && (
                <motion.span
                  className="brain-task-chips"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: DUR.fast, ease: "easeIn" } }}
                  transition={SPRING_MATERIALIZE}
                >
                  <WhenChip
                    task={task}
                    today={today}
                    onPick={(when, label) => void leaveDown(when, label)}
                  />
                  <CategoryPicker
                    value={task.category}
                    suggestions={[...categories]}
                    onSet={(category) => onPatch(task, { category: category || null })}
                    revealClass=""
                  />
                  {/* A rule can be added to an OPEN task that is not a note
                      line's, and to no other (decision 14): a linked task's
                      completion is the checkbox in somebody's document, and a
                      repeat would have to write `[ ]` back into it every
                      morning. A detached one has no line left and still came
                      from one. And a DONE one has no next occurrence to
                      promise: the rule would describe a series with no open
                      instance, and the record would sit in the Logbook
                      claiming to repeat. The store refuses that shape too. */}
                  {!linked && !detached && !task.done && (
                    <TasksRepeatMenu
                      task={task}
                      today={today}
                      onSet={(repeat) => onPatch(task, { repeat })}
                    />
                  )}
                  {/* A someday task is explicitly undated, and a deadline
                      already past would pull it straight into Today, so the
                      chip is not offered there. */}
                  {task.when !== "someday" && (
                  <label className="chip" data-task-control>
                    <span className="chip-glyph">
                      <Icon name="flag" size={14} />
                    </span>
                    <span className="sr-only">Deadline</span>
                    <input
                      type="date"
                      className="brain-task-date"
                      value={task.deadline ?? ""}
                      onChange={(event) =>
                        onPatch(task, { deadline: event.currentTarget.value || null })
                      }
                    />
                  </label>
                  )}
                  {task.page && pageTitle && (
                    <button
                      type="button"
                      data-task-control
                      className="chip"
                      onClick={() => onOpenPage?.(task.page as string)}
                    >
                      <span className="chip-glyph">
                        <Icon name="document-text" size={14} />
                      </span>
                      {pageTitle}
                    </button>
                  )}
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </motion.div>
      </div>
    </motion.li>
  );
}

export function tomorrowOf(today: string): string {
  const next = new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) - 1,
      Number(today.slice(8, 10)) + 1,
    ),
  );
  return next.toISOString().slice(0, 10);
}

/** The When chip's menu: the two days a task list actually moves things to,
 *  Someday, a date for everything else, and the way back out. */
function WhenChip({
  task,
  today,
  onPick,
}: {
  task: TaskView;
  today: string;
  onPick: (when: string | "someday" | null, label: string) => void;
}) {
  const tomorrow = tomorrowOf(today);
  const label =
    task.when === "someday"
      ? "Someday"
      : task.when === today
        ? "Today"
        : task.when === tomorrow
          ? "Tomorrow"
          : task.when
            ? dayLabel(task.when)
            : "When";
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className="chip" data-task-control aria-label={`When: ${label}`}>
          <span className="chip-glyph">
            <Icon name="calendar" size={14} />
          </span>
          {label}
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[220px]"
        >
          <Dropdown.Item className="brain-menu-item" onSelect={() => onPick(today, "Today")}>
            <Icon name="calendar-date-linear" size={16} className="brain-menu-icon" />
            Today
          </Dropdown.Item>
          <Dropdown.Item className="brain-menu-item" onSelect={() => onPick(tomorrow, "Tomorrow")}>
            <Icon name="calendar-linear" size={16} className="brain-menu-icon" />
            Tomorrow
          </Dropdown.Item>
          <Dropdown.Item className="brain-menu-item" onSelect={() => onPick("someday", "Someday")}>
            <Icon name="box-minimalistic-linear" size={16} className="brain-menu-icon" />
            Someday
          </Dropdown.Item>
          <Dropdown.Separator className="brain-menu-sep" />
          <label className="brain-menu-item" data-task-control>
            <Icon name="calendar-linear" size={16} className="brain-menu-icon" />
            <span className="min-w-0 flex-1">Date</span>
            <input
              type="date"
              className="brain-task-date"
              value={task.when && task.when !== "someday" ? task.when : ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value) onPick(value, dayLabel(value));
              }}
            />
          </label>
          {task.when && (
            <Dropdown.Item className="brain-menu-item" onSelect={() => onPick(null, "Inbox")}>
              <Icon name="close-linear" size={16} className="brain-menu-icon" />
              Clear
            </Dropdown.Item>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** THE ROW'S KEYS ARE UNMODIFIED LETTERS, not browser chords.
 *
 *  ⌘T is New Tab and ⌘N is New Window; `preventDefault` does not reclaim a
 *  chord the browser reserves, and binding one means a reader who reaches for
 *  Today gets a tab. Things puts these on bare letters for the same reason, so
 *  `t` and `s` move the row the capsule is standing on, and the palette
 *  carries the same two for a hand that would rather read them.
 *
 *  Every one of them is off while the caret is in a field. A bare letter is
 *  the one shortcut shape that MUST check: `t` inside the capture row is a
 *  reader typing the word "tomorrow", not asking for Today.
 */
function useRowShortcuts({
  selected,
  expanded,
  completeNow,
  leaveDown,
  onExpand,
  today,
  rowKey,
  historic,
}: {
  selected: boolean;
  expanded: boolean;
  completeNow: () => void;
  leaveDown: (when: string | "someday" | null, label: string) => Promise<void>;
  onExpand: (id: string | null) => void;
  today: string;
  rowKey: string;
  historic: boolean;
}) {
  useEffect(() => {
    // A history row answers no key for the same reason it answers no press:
    // there is nothing on it left to move or to undo.
    if (!selected || historic) return;
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Enter" && meta) {
        event.preventDefault();
        completeNow();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        onExpand(expanded ? null : rowKey);
        return;
      }
      // ⌘] is not a letter and no browser claims it, so Tomorrow keeps the
      // spec's own chord alongside the two letters.
      if (meta && event.key === "]") {
        event.preventDefault();
        void leaveDown(tomorrowOf(today), "Tomorrow");
        return;
      }
      if (meta || event.altKey) return;
      const move = ROW_KEYS[event.key.toLowerCase()];
      if (!move) return;
      event.preventDefault();
      void leaveDown(move.when(today), move.label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [completeNow, expanded, historic, leaveDown, onExpand, rowKey, selected, today]);
}

/** The two the palette carries too, so a key and a palette row never disagree
 *  about where `t` sends a task.
 *
 *  There is no third. Things binds `e` to This evening and Brain has no
 *  evening: the record holds a day or the word `someday`
 *  (`lib/tasks/model.ts`), and the spec names no state between them. A key
 *  that filed for today under an evening's name would be a second answer to
 *  where the task is, and a key that did exactly what `t` does is a dead one. */
export const ROW_KEYS: Record<
  string,
  { when: (today: string) => string | "someday" | null; label: string }
> = {
  t: { when: (today) => today, label: "Today" },
  s: { when: () => "someday", label: "Someday" },
};

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.closest !== "function") return false;
  return Boolean(element.closest("input, textarea, [contenteditable]"));
}

/**
 * THE SWIPE, ON SPRINGS FROM THE CURRENT VALUE.
 *
 * Pointer Events with `setPointerCapture`, ten pixels of hysteresis before
 * the axis is chosen, and never a CSS transition (DESIGN.md ban 8). Right is
 * Tomorrow and left is Someday, onward and away. The capsule tracks the
 * finger 1:1 to 160px and rubber-bands past it; a release under both the
 * travel and the velocity threshold sends nothing.
 *
 * Reduced motion keeps the 1:1 tracking, because that is input and not
 * animation, and drops the spring on the way back.
 */
function useSwipe({
  x,
  reduce,
  enabled,
  onWord,
  onCommit,
  onRelease,
}: {
  x: MotionValue<number>;
  reduce: boolean;
  enabled: boolean;
  onWord: (side: "left" | "right" | null) => void;
  onCommit: (side: "left" | "right") => void;
  onRelease: () => void;
}) {
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    at: number;
    axis: "x" | "y" | null;
    travel: number;
    velocity: number;
  } | null>(null);

  if (!enabled) return {};

  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") return;
      drag.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        at: Date.now(),
        axis: null,
        travel: 0,
        velocity: 0,
      };
      const target = event.currentTarget as HTMLElement & {
        setPointerCapture?: (id: number) => void;
      };
      target.setPointerCapture?.(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const dx = event.clientX - state.x;
      const dy = event.clientY - state.y;
      if (state.axis === null) {
        if (Math.abs(dx) < AXIS_HYSTERESIS_PX && Math.abs(dy) < AXIS_HYSTERESIS_PX) return;
        state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      if (state.axis !== "x") return;
      // The velocity of THIS move, not of the whole drag: `state.at` walks
      // with the pointer. Two events in the same millisecond carry no
      // measurable speed, so the last reading stands rather than dividing by
      // nothing and reading as a flick.
      const now = Date.now();
      const elapsed = now - state.at;
      if (elapsed > 0) {
        state.velocity = (Math.abs(dx - state.travel) / elapsed) * 1000;
        state.at = now;
      }
      state.travel = dx;
      x.set(rubberBand(dx));
      onWord(Math.abs(dx) >= WORD_AT_PX ? (dx > 0 ? "right" : "left") : null);
    },
    onPointerUp: (event: React.PointerEvent) => {
      const state = drag.current;
      drag.current = null;
      if (!state || state.axis !== "x") {
        onRelease();
        return;
      }
      const target = event.currentTarget as HTMLElement & {
        releasePointerCapture?: (id: number) => void;
      };
      target.releasePointerCapture?.(state.id);
      const far = Math.abs(state.travel) >= COMMIT_PX;
      const fast = state.velocity >= COMMIT_VELOCITY;
      if (far || fast) {
        // The capsule leaves past the edge carrying the finger's velocity,
        // and the fold takes over from there.
        const away = (state.travel > 0 ? 1 : -1) * EXIT_PX;
        animate(x, away, reduce ? { duration: DUR.fast } : SPRING_SHEET_GESTURE);
        onCommit(state.travel > 0 ? "right" : "left");
        return;
      }
      // Released early: back to 0 on the gesture spring, which is the one
      // preset with bounce and the only place it is earned.
      animate(x, 0, reduce ? { duration: DUR.fast } : SPRING_SHEET_GESTURE);
      onRelease();
    },
    onPointerCancel: () => {
      drag.current = null;
      onRelease();
    },
  };
}

/** `overshoot · w · .55 / (w + .55 · overshoot)` past 160px of travel. */
function rubberBand(dx: number): number {
  const sign = dx < 0 ? -1 : 1;
  const travel = Math.abs(dx);
  if (travel <= RUBBER_AT_PX) return dx;
  const overshoot = travel - RUBBER_AT_PX;
  const width = RUBBER_AT_PX;
  return (
    sign *
    (RUBBER_AT_PX +
      (overshoot * width * RUBBER_TENSION) / (width + RUBBER_TENSION * overshoot))
  );
}
