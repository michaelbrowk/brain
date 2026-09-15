"use client";

import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  type MotionValue,
} from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CHIP_ROW_AIR,
  CHIP_ROW_RING,
  DUR,
  EASE_OUT,
  HOVER,
  SPRING_DEAL,
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
  eveningMoon,
  movedLabel,
  movesRow,
  overdueWhenCaption,
  reminderFired,
  repeatNextLabel,
  timeCaption,
} from "./tasks-lists";
import { TasksRepeatMenu } from "./tasks-repeat-menu";
import { TasksWhenPicker, type WhenValue } from "./tasks-when-picker";
import { Icon } from "./ui/icon";

/** THE ROW, AND THE ONE DIRECTION IT CAN LEAVE IN.
 *
 *  A reschedule folds DOWN, into the future: a capsule folding into its own
 *  bottom edge (`clip-path` plus real height), so the words are cut off by an
 *  edge rather than shrunk.
 *
 *  A COMPLETION IS NOT A LEAVING (D3). The row is struck through, its title
 *  goes quiet, and it sinks to the foot of its group on the layout spring,
 *  where it stays until the day changes. Finishing a task is something the
 *  reader did, and a list that erases it the moment it is done has nothing
 *  left to show for the morning.
 *
 *  The completion is a 1200ms hold and the write is issued at its end, not at
 *  the press. A reader who changes their mind inside the window erases the
 *  check and nothing was ever sent: no request, no `rev` bump, no commit.
 *  That is why the draw runs on WAAPI and not on a CSS transition: a cancel
 *  has to interrupt it from wherever it is.
 */

/** The one flowing selection capsule of the column. */
export const TASKS_SELECT_LAYOUT_ID = "tasks-select";

/** THE CHIP ROW'S BOX, OPEN AND SHUT. The air above and below the chips is
 *  `CHIP_ROW_AIR`, and it is split between the element's padding and its
 *  margin: the padding is inside the box that clips the reveal, so the chips
 *  stand `CHIP_ROW_RING` clear of the clip's edge and a focus ring on one has
 *  room to draw. Both sides travel from 0 with the reveal, so the capsule
 *  grows once instead of stepping open first. */
const CHIP_ROW_OPEN = {
  paddingTop: CHIP_ROW_RING,
  paddingBottom: CHIP_ROW_RING,
  marginTop: CHIP_ROW_AIR - CHIP_ROW_RING,
  marginBottom: CHIP_ROW_AIR - CHIP_ROW_RING,
} as const;
const CHIP_ROW_SHUT = {
  paddingTop: 0,
  paddingBottom: 0,
  marginTop: 0,
  marginBottom: 0,
} as const;

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
  /** Whether the row's own category stands in its tail. Home's Today block
   *  does not group, so the word is the only thing saying which part of a life
   *  a task belongs to; the column groups BY category and would repeat it in
   *  every tail under the header that already says it. */
  showCategory?: boolean;
  /** The title of the note a linked or detached task points at. */
  pageTitle?: string;
  /** Play the arrival: the morning entrance, or a row inserted afterwards. */
  entrance?: { delay: number } | "insert" | false;
  onSelect: (id: string) => void;
  /** ⌘⏎ moves the capsule on at once and the fold plays behind it. */
  onSelectNext: (afterId: string) => void;
  onExpand: (id: string | null) => void;
  /** Resolves when the write landed, rejects when the route refused it.
   *  `refusal` is this row's own sentence for a failure the route cannot
   *  name: completing a LINKED task writes `[x]` into a note, and which note
   *  is a thing only the row knows. */
  onComplete: (task: TaskView, refusal?: string) => Promise<void>;
  /** `refusal` is the sentence a failed untick is reported in. Only the row
   *  knows which note a linked task's box lives in, and that is the whole of
   *  what the reader needs told: the write goes to somebody's document, so a
   *  refusal names it. Everything else keeps the route's own `reason`. */
  onReopen: (task: TaskView, refusal?: string) => void;
  onReschedule: (task: TaskView, value: WhenValue, label: string) => Promise<void>;
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
  showCategory = false,
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
  /** C2. THE ROW IS INVISIBLE FOR THE LENGTH OF ITS OWN REORDER.
   *
   *  Completing a task re-sorts it to the foot of its group, and the row used
   *  to travel there on the layout spring at full opacity: for about 110ms it
   *  was painted exactly over the rows it passed, two titles in one composite,
   *  and an OPEN task wearing the struck row's filled box and its strike. So
   *  it fades out where it stands over `DUR.base`, the reorder happens with
   *  nothing on screen to see it, and it fades in at the foot. Set before the
   *  write leaves, so framer measures the new place with the flag already
   *  true; cleared when the fade is over. Reduced motion never sets it and
   *  gets the instant reorder it already had.
   *
   *  THE FADE IS DRAWN ON THE WRAPPER AND NOT ON THE LIST ITEM. See the
   *  comment on `.brain-task-swipe` below: the item is the node the reorder
   *  moves, and an opacity animation on a node being moved never paints. */
  const [sinking, setSinking] = useState(false);
  const sinkRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const x = useMotionValue(0);

  const linked = task.page !== undefined && task.detachedAt === undefined;
  const detached = task.detachedAt !== undefined;
  /** A completed row in a list answers its checkbox and nothing else. Its
   *  chips would edit a record the reader has finished with, its title is not
   *  worth a keyboard on a phone, and a reschedule key on it would move
   *  something that is already in the past. */
  const inert = historic || task.done;
  const overdueWhen = overdueWhenCaption(task, today);
  const deadline = deadlineCaption(task, today);
  /** The chip's word, and the sentence a screen reader hears in its place:
   *  every chip on this row names its field and its value, so a bare `20 Sep`
   *  beside a When chip would be a date with nothing to attach it to. */
  const deadlineWord = task.deadline ? dayLabel(task.deadline) : "Deadline";
  const deadlineSpoken = task.deadline ? `Deadline: ${deadlineWord}` : "Deadline";
  const repeatNext = repeatNextLabel(task, today);
  const time = timeCaption(task);
  const moon = eveningMoon(task, today);
  const fired = reminderFired(task);

  useEffect(
    () => () => {
      if (holdRef.current) clearTimeout(holdRef.current);
      if (sinkRef.current) clearTimeout(sinkRef.current);
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

  /** THE WRITE STILL LANDS AT 1300, AND THE ROW STAYS.
   *
   *  Completing a task is not the task leaving. The strike is drawn, the title
   *  goes quiet, and the row sinks to the foot of its group on the layout
   *  spring because the derive now sorts it there. A refusal puts the box and
   *  the quiet title back and the row never moved. */
  const commit = useCallback(async () => {
    // Before the write leaves, so the optimistic re-sort and this flag land in
    // one render and framer measures the row's new place with the fade already
    // on. Set after it, the layout spring would have started travelling first.
    if (!reduce) setSinking(true);
    try {
      await onComplete(
        task,
        linked ? `Couldn't tick in ${pageTitle ?? "that note"}` : undefined,
      );
      if (!reduce) {
        sinkRef.current = setTimeout(() => {
          sinkRef.current = null;
          setSinking(false);
        }, DUR.base * 1000);
      }
    } catch {
      if (boxRef.current) setTaskCheckboxChecked(boxRef.current, false, reduce);
      // Everything the hold changed goes back, not only the tick. `holding`
      // strikes the title and grows the tail that names the next occurrence,
      // so a row left holding after a refusal reads as completed while the
      // toast says it failed. The fade goes back with it: the row never moved.
      setHolding(false);
      setSinking(false);
    }
    onFoldEnd(task.id);
  }, [linked, onComplete, onFoldEnd, pageTitle, reduce, task]);

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
      // Unticking a LINKED task writes `[ ]` back into its note, so a failure
      // is a failure in that note and says so. An unlinked one is a record
      // write and has nothing better to say than what the route said.
      onReopen(
        task,
        linked ? `Couldn't untick in ${pageTitle ?? "that note"}` : undefined,
      );
      return;
    }
    if (cancelHold()) return;
    beginHold();
  }, [beginHold, cancelHold, historic, linked, onReopen, pageTitle, task]);

  /** ⌘⏎: the SELECTION moves on at once and the fold plays behind it. The
   *  hold is unchanged, because the way back has nothing to do with which hand made
   *  the gesture, and a keyboard completion that wrote immediately would be
   *  the one path with no way back. */
  const completeNow = useCallback(() => {
    onSelectNext(key);
    if (holdRef.current) return;
    beginHold();
  }, [beginHold, key, onSelectNext]);

  /** A ROW THAT IS NOT LEAVING PLAYS NO LEAVING ANIMATION.
   *
   *  Today pressed on a task that is already in Today writes the day and
   *  moves nothing: the derive draws the record in the same list under the
   *  same header. The fold fills FORWARDS, so one played here would hold a
   *  row that never unmounted at height 0, with the record correct
   *  underneath it, until the next load. `movesRow` is the same answer
   *  `tasks-actions` reports on, so the motion and the words cannot
   *  disagree. */
  const leaveDown = useCallback(
    async (value: WhenValue, label: string) => {
      const element = movesRow(task, value.when, today, offsetMinutes)
        ? wrapRef.current
        : null;
      const fold = element ? foldRow(element, "down", reduce) : null;
      let refused = false;
      try {
        await onReschedule(task, value, label);
      } catch {
        refused = true;
      }
      if (refused) fold?.cancel();
      else await fold?.finished;
      onFoldEnd(task.id);
    },
    [offsetMinutes, onFoldEnd, onReschedule, reduce, task, today],
  );

  useRowShortcuts({
    selected,
    expanded,
    completeNow,
    leaveDown,
    onExpand,
    today,
    rowKey: key,
    inert,
    task,
  });

  const swipeHandlers = useSwipe({
    x,
    reduce,
    enabled: !inert && !expanded,
    onWord: setSwipeSide,
    onCommit: (side) => {
      setSwipeSide(null);
      const when = side === "right" ? tomorrowOf(today) : "someday";
      void leaveDown(whenValueFor(task, when), movedLabel({ when, evening: false }, today));
    },
    onRelease: () => setSwipeSide(null),
  });

  const openRow = (event: React.MouseEvent) => {
    // A PRESS INSIDE A PANEL THIS ROW OPENED IS NOT A PRESS ON THIS ROW.
    //
    // The When picker, the deadline picker, the repeat menu and the category
    // popover are all PORTALLED to the end of the document, and React carries
    // an event from a portal up the tree the portal was DECLARED in. So a day
    // in the calendar arrived here as a second press on the row, this handler
    // folded it, the chips went and the picker went with them, and a teardown
    // that is not a close throws the reader's day away: the panel shut and
    // nothing was saved. The `data-task-control` guard below could not see it,
    // because that guard walks the DOM and the portal has left it.
    //
    // Containment is the question both guards are asking, and it is the one
    // the portal breaks. Asked of the row's own element it answers for every
    // panel a chip opens, the ones here now and the ones added later.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if ((event.target as HTMLElement).closest("[data-task-control]")) return;
    // A history row answers NOTHING, and says so before it is pressed: no
    // hover fill, no pointer cursor, a drawn check instead of a box. Its chips
    // would edit the live record from under a completion that is over, its
    // title is not the record's to change from here, and the untick belongs to
    // the newest entry because there is one rule to put the series back on. A
    // selection capsule on it would be the same refusal one gesture later.
    if (historic) return;
    onSelect(key);
    // A COMPLETED ROW STOPS HERE. The arrows can stand on it, because it is
    // still a row in the list, but its chips would edit a record the reader
    // has finished with and its title is not worth a keyboard on a phone.
    if (inert) return;
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
      // THE SINK. The row travels to its new place in the group rather than
      // cutting there. `layout="position"` and not `layout`: the box's height
      // is the row's own and a size animation would stretch the words inside
      // it. Reduced motion moves it with no spring at all, which is a reflow.
      layout={reduce ? false : "position"}
      initial={arrival}
      // The arrival's opacity and nothing else: the sink's fade is one node in.
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, height: "auto" }}
      transition={{
        duration: entrance === "insert" ? DUR.page : DUR.base,
        ease: EASE_OUT,
        delay: reduce ? 0 : arrivalDelay,
        // The sink has its own curve, and the entrance keeps its stagger: one
        // `transition` for two animations would give the travel the arrival's
        // delay and the arrival the travel's spring.
        //
        // AND A COMPLETION'S REORDER IS NOT A TRAVEL AT ALL. Duration 0, held
        // back by the length of the fade above it, so the row is already gone
        // from the screen when it changes place and back by the time it is
        // drawn again. Every other layout change is still the spring: a
        // neighbour closing the gap is the one thing here that should move.
        layout: sinking ? { duration: 0, delay: DUR.base } : SPRING_DEAL,
      }}
    >
      {/* THE FADE RIDES HERE, ONE NODE IN FROM THE ROW'S OWN ELEMENT. React
          reorders the list by moving the `<li>`, and an opacity animation on
          a node that is being moved never paints: measured on the page, the
          struck row held full ink through the whole sink, and the C2
          composite this was meant to remove was still on screen, a neighbour
          springing across a full-opacity row. This wrapper, which no reorder
          re-parents, keeps the fade through the move. */}
      <motion.div
        className="brain-task-swipe"
        animate={reduce ? { opacity: 1 } : { opacity: sinking ? 0 : 1 }}
        transition={{ duration: DUR.base, ease: EASE_OUT }}
      >
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
          // Every state the row's own rules read sits on the row's own
          // element. The hold used to be flagged one level up, on the list
          // item, so `.brain-task-row[data-holding]` matched nothing and the
          // title never went quiet behind the held tick.
          data-holding={holding ? "" : undefined}
          data-historic={historic ? "" : undefined}
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
            staticCheck={historic}
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
                {/* The clock the record holds, verbatim, then the moon. Both
                    lead the tail: they are where in the DAY this row sits, and
                    the glyphs behind them are what KIND of row it is.

                    ONE CLOCK PER ROW. A finished row reports the time it was
                    finished at, further down this chain, and the hour it was
                    due at is what the strike is drawn over: two clocks side by
                    side made the reader work out which was which. A done row
                    with no instant to report then says nothing, which is
                    right, because there is nothing to report. */}
                {time && !task.done && (
                  <span
                    className="brain-task-caption"
                    data-time
                    data-fired={fired ? "" : undefined}
                  >
                    {time}
                  </span>
                )}
                {/* THE GLYPH SLOT, drawn on every row whether or not this row
                    has a glyph for it. The tail is a flex whose last child is
                    flush, so a row carrying `restart` put its clock 22px left
                    of where a row without one put its own, in the same list,
                    on the axis a reader scans down. */}
                <span className="brain-task-glyphs">
                  {moon && <Icon name="moon-linear" size={14} className="text-ink-3" />}
                  {linked && (
                    <Icon name="document-text" size={14} className="text-ink-3" />
                  )}
                  {task.repeat && (
                    <Icon name="restart" size={14} className="text-ink-3" />
                  )}
                </span>
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
                ) : task.done && task.updatedByName ? (
                  /* Spec row 145. The note owns a linked task's completion,
                     so when a link visitor ticked the box the Logbook says
                     who, in place of the time: the name answers the question
                     the time was standing in for. */
                  <span className="brain-task-caption">
                    done by {task.updatedByName} via link
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
                ) : showCategory && task.category ? (
                  /* Last in the chain, so everything above displaces it: an
                     overdue deadline is red text in this same slot, and a task
                     that is late about a date has nothing to say about which
                     part of a life it belongs to. */
                  <span className="brain-task-caption">{task.category}</span>
                ) : null}
              </span>
            </span>
            <AnimatePresence initial={false}>
              {expanded && (
                /* THE CHIP ROW CARRIES THE CAPSULE'S HEIGHT. It wraps at 390,
                   where four chips do not fit on one line, so the number that
                   used to be in the stylesheet cannot know how tall it is. The
                   row reveals itself from 0 and the capsule, which is
                   `height: auto` now, grows with it: the same 220ms growth,
                   measured off the chips rather than assumed.

                   BOTH SIDES OF THE AIR TRAVEL WITH IT. The 6 below the chips
                   was `padding-bottom` on the capsule, applied in the frame the
                   attribute was, and padding on a box drawn at chip height 0
                   steps the row open 6px before it grows. It is this element's
                   own box now, animated from 0 like the air above it, so the
                   capsule moves once.

                   AND IT IS SPLIT IN TWO, because this box CLIPS. Five of the
                   six are the element's padding and the sixth is its margin,
                   which puts the clip's edge five pixels off the chips rather
                   than flush against them: a chip's focus ring reaches exactly
                   that far, and flush it came back as two slivers on the
                   chip's left and right edges. The reader sees the same 6 they
                   always did, since what the padding takes the margin gives
                   back. `lib/motion.ts` holds both numbers. */
                <motion.span
                  className="brain-task-chips"
                  initial={
                    reduce
                      ? { opacity: 0, ...CHIP_ROW_OPEN }
                      : {
                          opacity: 0,
                          height: 0,
                          ...CHIP_ROW_SHUT,
                          y: -4,
                        }
                  }
                  animate={
                    reduce
                      ? { opacity: 1, ...CHIP_ROW_OPEN }
                      : {
                          opacity: 1,
                          height: "auto",
                          ...CHIP_ROW_OPEN,
                          y: 0,
                        }
                  }
                  exit={
                    reduce
                      ? { opacity: 0, transition: { duration: DUR.fast, ease: "easeIn" } }
                      : {
                          opacity: 0,
                          height: 0,
                          ...CHIP_ROW_SHUT,
                          transition: { duration: DUR.fast, ease: "easeIn" },
                        }
                  }
                  transition={SPRING_MATERIALIZE}
                >
                  <WhenChip
                    task={task}
                    today={today}
                    onPick={(value) => void leaveDown(value, movedLabel(value, today))}
                  />
                  <CategoryPicker
                    chip
                    value={task.category}
                    suggestions={[...categories]}
                    onSet={(category) => onPatch(task, { category: category || null })}
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
                    <TasksWhenPicker
                      mode="deadline"
                      value={{ when: task.deadline ?? null, evening: false, time: null }}
                      today={today}
                      /* `mode="deadline"` draws no Someday row, so the value
                         is a day or nothing and the record takes it whole. */
                      onPick={(value) => onPatch(task, { deadline: value.when })}
                      ariaLabel={deadlineSpoken}
                      trigger={
                        <button
                          type="button"
                          className="chip"
                          data-task-control
                          aria-label={deadlineSpoken}
                        >
                          <span className="chip-glyph">
                            <Icon name="flag" size={14} />
                          </span>
                          {deadlineWord}
                        </button>
                      }
                    />
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
      </motion.div>
    </motion.li>
  );
}

export function tomorrowOf(today: string): string {
  return dayAfter(today, 1);
}

function dayAfter(today: string, days: number): string {
  const next = new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) - 1,
      Number(today.slice(8, 10)) + days,
    ),
  );
  return next.toISOString().slice(0, 10);
}

/** THE VALUE A KEY, A SWIPE OR A PALETTE ROW SENDS.
 *
 *  The picker answers with all three fields at once, and these three gestures
 *  name a day and nothing else, so the other two are read off the record: the
 *  clock the task already carries stays with it, and the evening comes off,
 *  which is what the picker's own Today row and its grid do. Someday and the
 *  Inbox are not days at all, and a clock on neither is a shape
 *  `lib/tasks/model.ts` refuses, so both come off with the day. */
export function whenValueFor(
  task: TaskView,
  when: string | "someday" | null,
): WhenValue {
  const onADay = when !== null && when !== "someday";
  return { when, evening: false, time: onADay ? (task.time ?? null) : null };
}

/** The When chip, and the one date control behind it (D4). The chip says where
 *  the task sits in the reader's own words, and the picker says everything
 *  else: a month grid, This Evening, Someday and the reminder's clock. */
function WhenChip({
  task,
  today,
  onPick,
}: {
  task: TaskView;
  today: string;
  onPick: (value: WhenValue) => void;
}) {
  const label =
    task.when === "someday"
      ? "Someday"
      : task.when === today
        ? task.evening
          ? "This Evening"
          : "Today"
        : task.when === tomorrowOf(today)
          ? "Tomorrow"
          : task.when
            ? dayLabel(task.when)
            : "When";
  // EVERY CHIP NAMES ITS FIELD AND ITS VALUE, which is the sentence the
  // Category and Repeat chips beside it already say: "Today" alone, read out
  // next to a Deadline chip, is a date with nothing to attach it to. The
  // popover carries the same words, so the control and the panel it opens are
  // announced as one thing.
  const spoken = `When: ${label}${task.time ? ` at ${task.time}` : ""}`;
  return (
    <TasksWhenPicker
      value={{
        when: task.when ?? null,
        evening: task.evening === true,
        time: task.time ?? null,
      }}
      today={today}
      onPick={onPick}
      ariaLabel={spoken}
      trigger={
        <button type="button" className="chip" data-task-control aria-label={spoken}>
          <span className="chip-glyph">
            <Icon name="calendar" size={14} />
          </span>
          {label}
        </button>
      }
    />
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
  inert,
  task,
}: {
  selected: boolean;
  expanded: boolean;
  completeNow: () => void;
  leaveDown: (value: WhenValue, label: string) => Promise<void>;
  onExpand: (id: string | null) => void;
  today: string;
  rowKey: string;
  inert: boolean;
  /** The record the value is built over: a key names a day and the clock on it
   *  is already the task's. */
  task: TaskView;
}) {
  useEffect(() => {
    // A finished row answers no key for the same reason it answers no press:
    // there is nothing on it left to move, and `t` on a task that is already
    // in the past would file a completion under today.
    if (!selected || inert) return;
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
        const tomorrow = tomorrowOf(today);
        void leaveDown(
          whenValueFor(task, tomorrow),
          movedLabel({ when: tomorrow, evening: false }, today),
        );
        return;
      }
      if (meta || event.altKey) return;
      const move = ROW_KEYS[event.key.toLowerCase()];
      if (!move) return;
      event.preventDefault();
      void leaveDown(whenValueFor(task, move.when(today)), move.label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [completeNow, expanded, inert, leaveDown, onExpand, rowKey, selected, task, today]);
}

/** The two the palette carries too, so a key and a palette row never disagree
 *  about where `t` sends a task.
 *
 *  There is no third. Brain does have an evening now, and Things binds `e` to
 *  it, but the evening is a SECTION of today rather than a place a task is
 *  sent to: `e` would file the row where `t` already files it and then set one
 *  more field, which is the picker's Evening row one press away with the day
 *  in front of the reader. A key that half-does what a control does properly
 *  is the one shape a shortcut must not have. */
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
      // iOS releases the capture itself on `pointercancel`, and releasing a
      // capture that is already gone throws `NotFoundError`. Thrown here it
      // would abort the handler BEFORE the commit below: the finger travels,
      // the word appears, and the release silently does nothing. Wrapped, and
      // before the decision rather than inside it, so nothing about whether
      // the swipe commits depends on it.
      try {
        target.releasePointerCapture?.(state.id);
      } catch {
        // Already released. The gesture is this handler's either way.
      }
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
