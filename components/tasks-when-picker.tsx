"use client";

/** ONE DATE CONTROL, DRAWN HERE, USED EVERYWHERE (D4).
 *
 *  `input[type=date]` and `input[type=time]` are gone from the tree, on a
 *  pointer and on touch alike. The native control is four different controls
 *  across the browsers this runs in, it renders `14/09/2026` in the browser's
 *  own metrics beside Solar glyphs, and on touch it hands the whole gesture to
 *  a sheet Brain does not draw. The 0.10.0 ruling that touch should keep the
 *  native picker is reversed here.
 *
 *  IT RETURNS DOM, and React wraps it. The note's promote popover is a
 *  ProseMirror widget with no React tree to hang a component from, and the one
 *  checkbox in this app is built the same way for the same reason
 *  (`components/tasks-checkbox.tsx`). Two drawings of one control is how they
 *  drift into two controls.
 *
 *  IT READS NO CLOCK. `today` arrives from the caller, which is
 *  `components/tasks-client.ts`, the one clock read in the subsystem.
 */

import * as Popover from "@radix-ui/react-popover";
import { motion, useDragControls, useMotionValue, useReducedMotion } from "framer-motion";
import { animate } from "framer-motion/dom";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  DUR,
  SHEET_DISMISS_OFFSET,
  SHEET_DISMISS_VELOCITY,
  SPRING_SHEET,
  SPRING_SHEET_GESTURE,
} from "@/lib/motion";
import {
  monthGridOf,
  monthLabel,
  monthName,
  monthOfDay,
  shiftDay,
  shiftMonth,
} from "@/lib/tasks/calendar";

import { EASE_OUT_CSS } from "./tasks-checkbox";
import { ScrollEdge } from "./ui/scroll-edge";
import { SOLAR } from "./ui/solar-icons.generated";
import { useSheetGesture } from "./use-sheet-gesture";

export interface WhenValue {
  /** A day, the word `someday`, or nothing set. */
  when: string | null;
  evening: boolean;
  /** `HH:MM`, the reminder. */
  time: string | null;
}

export interface WhenPickerOptions {
  value: WhenValue;
  today: string;
  mode: "when" | "deadline";
  reduce: boolean;
  onPick: (value: WhenValue) => void;
  onDone: () => void;
}

export interface WhenPickerHandle {
  readonly element: HTMLElement;
  focus(): void;
  destroy(): void;
}

/** Turning the reminder on with no time set writes this one. */
export const DEFAULT_REMINDER_TIME = "09:00";

const SVG_NS = "http://www.w3.org/2000/svg";
const MINUTE_STEP = 5;
/** The grid slides in from the side the month came from. 6px is the whole
 *  travel: the cells are 36 wide and anything further reads as a page turn. */
const MONTH_SHIFT_PX = 6;
const MONTH_TRAVEL_MS = Math.round(DUR.base * 1000);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** What a screen reader hears. A cell's accessible name is a date a person
 *  would say out loud, never the ISO string the value is stored as. */
const SPOKEN_WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
/** The reminder needs a day to be a reminder on. `lib/tasks/model.ts` refuses
 *  a clock without one and the store answers 400, so the row says why rather
 *  than minting a value no record can hold. */
const NO_DAY_YET = "Pick a day first";
/** The controls that answer their own keys. The grid's handler sits on the
 *  root so a press anywhere in the picker reaches it, and these are what it
 *  has to keep its hands off. */
const OWN_KEYS =
  ".brain-menu-item, [role='spinbutton'], [data-when-clear], [data-when-done], " +
  "[data-when-prev], [data-when-next], [data-when-time-clear], [data-when-step]";

function isDay(value: string | null): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Solar's body under a name the tests can read back. */
function glyph(name: string, size = 16): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "brain-menu-icon");
  svg.setAttribute("data-glyph", name);
  svg.innerHTML = SOLAR[name] ?? "";
  return svg;
}

function stepButton(label: string, name: string, flag: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.dataset.size = "28";
  button.dataset.whenStep = "";
  button.setAttribute(flag, "");
  button.setAttribute("aria-label", label);
  button.append(glyph(name, 14));
  return button;
}

/** "Tuesday 15 September", off the cell's own place in a Monday-first grid so
 *  no second weekday table is needed to say it. */
function spokenDate(day: string, index: number): string {
  return `${SPOKEN_WEEKDAYS[index % 7]} ${Number(day.slice(8, 10))} ${monthName(
    monthOfDay(day),
  )}`;
}

/** How many days the month holds, off the grid rather than a second table. */
function lengthOfMonth(month: string): number {
  return monthGridOf(month).filter((cell) => cell.inMonth).length;
}

export function renderWhenPicker(options: WhenPickerOptions): WhenPickerHandle {
  const { today, mode, reduce, onPick, onDone } = options;
  const deadline = mode === "deadline";

  // The three the whole control turns on. `paint()` rewrites what they say.
  // Nothing below is ever rebuilt, so a focused cell stays the focused cell.
  let value: WhenValue = { ...options.value };
  let focusedDay = isDay(value.when) ? value.when : today;
  let month = monthOfDay(focusedDay);

  const element = document.createElement("div");
  element.className = "brain-when-picker";

  /* ── The rows ─────────────────────────────────────────────────────────── */

  const row = (label: string, name: string, flag: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "brain-menu-item";
    button.setAttribute("role", "checkbox");
    button.setAttribute("aria-checked", "false");
    button.setAttribute(flag, "");
    button.append(glyph(name), document.createTextNode(label));
    return button;
  };

  const todayRow = row("Today", "star-linear", "data-when-today");
  const eveningRow = row("This Evening", "moon-linear", "data-when-evening");
  const somedayRow = row("Someday", "box-minimalistic-linear", "data-when-someday");
  const reminderRow = row("Reminder", "clock-circle-linear", "data-when-reminder");

  // Today is offered in both modes. A deadline of today is a deadline.
  element.append(todayRow);

  /* ── The head and the grid ────────────────────────────────────────────── */

  const head = document.createElement("div");
  head.className = "brain-when-head";
  const previous = stepButton("Previous month", "alt-arrow-left-linear", "data-when-prev");
  const next = stepButton("Next month", "alt-arrow-right-linear", "data-when-next");
  const label = document.createElement("div");
  label.className = "brain-when-month";
  label.setAttribute("aria-live", "polite");
  head.append(previous, label, next);

  const grid = document.createElement("div");
  grid.className = "brain-when-grid";
  grid.setAttribute("role", "grid");
  grid.setAttribute("aria-label", deadline ? "Deadline" : "When");

  const headRow = document.createElement("div");
  headRow.setAttribute("role", "row");
  for (const day of WEEKDAYS) {
    const heading = document.createElement("span");
    heading.className = "brain-when-weekday";
    heading.setAttribute("role", "columnheader");
    heading.textContent = day;
    headRow.append(heading);
  }
  grid.append(headRow);

  const cells: HTMLButtonElement[] = [];
  for (let week = 0; week < 6; week += 1) {
    const line = document.createElement("div");
    line.setAttribute("role", "row");
    for (let index = 0; index < 7; index += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      // `.focus-inset` rather than the global ring: the cells sit in a grid
      // with no gap, and a 3px outline at +2 offset lands on the four
      // neighbours and on the weekday heads above the top row.
      cell.className = "brain-when-day focus-inset";
      cell.setAttribute("role", "gridcell");
      cell.tabIndex = -1;
      cell.addEventListener("click", () => pickDay(cell.dataset.day ?? focusedDay));
      cells.push(cell);
      line.append(cell);
    }
    grid.append(line);
  }
  element.append(head, grid);

  // SOMEDAY SITS UNDER THE GRID, where the spec and Things both put it: the
  // grid is the answer to "when", and Someday is the row that says there is
  // no answer yet.
  if (!deadline) element.append(somedayRow);

  /* ── The reminder ─────────────────────────────────────────────────────── */

  const spin = document.createElement("div");
  spin.className = "brain-when-spin";
  const hour = document.createElement("div");
  const minute = document.createElement("div");
  const hourUp = stepButton("An hour later", "alt-arrow-up-linear", "data-when-hour-up");
  const hourDown = stepButton("An hour earlier", "alt-arrow-down-linear", "data-when-hour-down");
  const minuteUp = stepButton("Five minutes later", "alt-arrow-up-linear", "data-when-minute-up");
  const minuteDown = stepButton(
    "Five minutes earlier",
    "alt-arrow-down-linear",
    "data-when-minute-down",
  );
  const timeClear = document.createElement("button");

  if (!deadline) {
    for (const [box, flag, name, max] of [
      [hour, "data-when-hour", "Hours", 23],
      [minute, "data-when-minute", "Minutes", 55],
    ] as const) {
      box.setAttribute("role", "spinbutton");
      box.setAttribute("aria-label", name);
      box.setAttribute("aria-valuemin", "0");
      box.setAttribute("aria-valuemax", String(max));
      box.setAttribute(flag, "");
      box.tabIndex = 0;
    }
    const colon = document.createElement("span");
    colon.className = "brain-when-spin-sep";
    colon.textContent = ":";
    const gap = document.createElement("span");
    gap.className = "brain-when-spin-gap";

    timeClear.type = "button";
    timeClear.className = "icon-btn";
    timeClear.dataset.size = "28";
    timeClear.dataset.whenTimeClear = "";
    timeClear.setAttribute("aria-label", "Clear the reminder");
    timeClear.append(glyph("close-linear", 14));

    spin.append(hour, hourDown, hourUp, colon, minute, minuteDown, minuteUp, gap, timeClear);
    element.append(reminderRow, spin);
  }

  /* ── The foot ─────────────────────────────────────────────────────────── */

  const foot = document.createElement("div");
  foot.className = "brain-when-foot";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn btn-quiet";
  clear.dataset.whenClear = "";
  clear.append(glyph("close-linear", 14), document.createTextNode(deadline ? "No deadline" : "Clear"));
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn btn-ink";
  done.dataset.whenDone = "";
  done.textContent = "Done";
  foot.append(clear, done);
  element.append(foot);

  /* ── What the three variables draw ────────────────────────────────────── */

  const rovingCell = () =>
    cells.find((cell) => cell.dataset.day === focusedDay) ?? cells[0];

  function paint(): void {
    // A LIVE REGION IS WRITTEN ONLY WHEN IT CHANGED. `paint()` runs on every
    // pick, every clock step and every evening toggle, and assigning
    // `textContent` replaces the node whether or not the words moved, which
    // announces the month again for a gesture that never touched it.
    const words = monthLabel(month);
    if (label.textContent !== words) label.textContent = words;

    const cellsOfMonth = monthGridOf(month);
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      const { day, inMonth } = cellsOfMonth[index];
      cell.dataset.day = day;
      cell.textContent = String(Number(day.slice(8, 10)));
      cell.toggleAttribute("data-outside", !inMonth);
      cell.toggleAttribute("data-past", day < today);
      cell.toggleAttribute("data-today", day === today);
      cell.setAttribute("aria-selected", String(day === value.when));
      cell.setAttribute("aria-label", spokenDate(day, index));
      if (day === today) cell.setAttribute("aria-current", "date");
      else cell.removeAttribute("aria-current");
      cell.tabIndex = day === focusedDay ? 0 : -1;
    }

    todayRow.setAttribute("aria-checked", String(value.when === today && !value.evening));
    if (deadline) return;

    eveningRow.setAttribute("aria-checked", String(value.when === today && value.evening));
    somedayRow.setAttribute("aria-checked", String(value.when === "someday"));
    // The reminder is offered only once there is a day for it to fire on.
    const onADay = isDay(value.when);
    reminderRow.setAttribute("aria-checked", String(value.time !== null));
    reminderRow.disabled = !onADay;
    reminderRow.setAttribute("aria-disabled", String(!onADay));
    reminderRow.title = onADay ? "" : NO_DAY_YET;
    reminderRow.setAttribute("aria-label", onADay ? "Reminder" : `Reminder. ${NO_DAY_YET}`);

    // The evening is on offer only while the picked day is today, and a row
    // that does not apply is taken out rather than dimmed: a control that
    // advertises itself and then refuses is the one shape a control must not
    // have.
    const offered = (value.when ?? today) === today;
    if (offered && eveningRow.parentNode === null) {
      todayRow.after(eveningRow);
    } else if (!offered && eveningRow.parentNode !== null) {
      const held = document.activeElement === eveningRow;
      eveningRow.remove();
      if (held) todayRow.focus();
    }

    const clock = value.time ?? DEFAULT_REMINDER_TIME;
    spin.hidden = value.time === null;
    hour.textContent = clock.slice(0, 2);
    hour.setAttribute("aria-valuenow", String(Number(clock.slice(0, 2))));
    hour.setAttribute("aria-valuetext", `${clock.slice(0, 2)} hours`);
    minute.textContent = clock.slice(3, 5);
    minute.setAttribute("aria-valuenow", String(Number(clock.slice(3, 5))));
    minute.setAttribute("aria-valuetext", `${clock.slice(3, 5)} minutes`);
  }

  /** Repaint, keep the focus where it was, and carry the grid if the month
   *  travelled. Under reduced motion the grid changes and nothing moves. */
  function repaint(travel = 0): void {
    const held = grid.contains(document.activeElement);
    paint();
    if (held) rovingCell().focus();
    if (travel === 0 || reduce || typeof grid.animate !== "function") return;
    grid.animate(
      [
        { opacity: 0, transform: `translateX(${travel * MONTH_SHIFT_PX}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: MONTH_TRAVEL_MS, easing: EASE_OUT_CSS },
    );
  }

  function travelTo(nextMonth: string): number {
    return nextMonth === month ? 0 : nextMonth > month ? 1 : -1;
  }

  function setFocus(day: string): void {
    const nextMonth = monthOfDay(day);
    const travel = travelTo(nextMonth);
    focusedDay = day;
    month = nextMonth;
    repaint(travel);
  }

  function pageMonth(by: number): void {
    const nextMonth = shiftMonth(month, by);
    const dayOfMonth = Math.min(Number(focusedDay.slice(8, 10)), lengthOfMonth(nextMonth));
    focusedDay = `${nextMonth}-${pad2(dayOfMonth)}`;
    month = nextMonth;
    repaint(by > 0 ? 1 : -1);
  }

  function send(next: WhenValue, travel = 0): void {
    value = next;
    repaint(travel);
    onPick(next);
  }

  function pickDay(day: string): void {
    const travel = travelTo(monthOfDay(day));
    focusedDay = day;
    month = monthOfDay(day);
    send({ when: day, evening: value.evening && day === today, time: value.time }, travel);
  }

  function stepClock(hours: number, minutes: number): void {
    const clock = value.time ?? DEFAULT_REMINDER_TIME;
    const nextHour = (((Number(clock.slice(0, 2)) + hours) % 24) + 24) % 24;
    const nextMinute =
      (((Number(clock.slice(3, 5)) + minutes * MINUTE_STEP) % 60) + 60) % 60;
    send({ ...value, time: `${pad2(nextHour)}:${pad2(nextMinute)}` });
  }

  /* ── What the reader presses ──────────────────────────────────────────── */

  todayRow.addEventListener("click", () =>
    send({ when: today, evening: false, time: value.time }),
  );
  eveningRow.addEventListener("click", () =>
    send({ when: today, evening: true, time: value.time }),
  );
  // A clock and an evening both need a day. Someday is not one, so both come
  // off with it rather than travelling to a record that refuses the pair.
  somedayRow.addEventListener("click", () =>
    send({ when: "someday", evening: false, time: null }),
  );
  reminderRow.addEventListener("click", () => {
    if (!isDay(value.when)) return;
    send({ ...value, time: value.time === null ? DEFAULT_REMINDER_TIME : null });
  });
  timeClear.addEventListener("click", () => send({ ...value, time: null }));
  hourUp.addEventListener("click", () => stepClock(1, 0));
  hourDown.addEventListener("click", () => stepClock(-1, 0));
  minuteUp.addEventListener("click", () => stepClock(0, 1));
  minuteDown.addEventListener("click", () => stepClock(0, -1));
  previous.addEventListener("click", () => pageMonth(-1));
  next.addEventListener("click", () => pageMonth(1));
  clear.addEventListener("click", () => send({ when: null, evening: false, time: null }));
  done.addEventListener("click", () => onDone());

  const spinKeys = (box: HTMLElement, hours: number, minutes: number) => {
    box.addEventListener("keydown", (event) => {
      const by = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
      if (by === 0) return;
      event.preventDefault();
      event.stopPropagation();
      stepClock(hours * by, minutes * by);
    });
  };
  spinKeys(hour, 1, 0);
  spinKeys(minute, 0, 1);

  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDone();
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(OWN_KEYS) !== null) return;

    const week = monthGridOf(month);
    const at = week.findIndex((cell) => cell.day === focusedDay);
    switch (event.key) {
      case "ArrowLeft":
        setFocus(shiftDay(focusedDay, -1));
        break;
      case "ArrowRight":
        setFocus(shiftDay(focusedDay, 1));
        break;
      case "ArrowUp":
        setFocus(shiftDay(focusedDay, -7));
        break;
      case "ArrowDown":
        setFocus(shiftDay(focusedDay, 7));
        break;
      case "Home":
        if (at >= 0) setFocus(week[at - (at % 7)].day);
        break;
      case "End":
        if (at >= 0) setFocus(week[at - (at % 7) + 6].day);
        break;
      case "PageUp":
        pageMonth(-1);
        break;
      case "PageDown":
        pageMonth(1);
        break;
      case "Enter":
        pickDay(focusedDay);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  paint();

  return {
    element,
    focus: () => rovingCell().focus(),
    destroy: () => element.remove(),
  };
}

/* ── The same control, mounted from React ─────────────────────────────────
 *
 *  A host element with the DOM above inside it, the way the Tasks row mounts
 *  the one checkbox. Below md the body rides the sheet the composer already
 *  draws, and the grip drags it away. */

export function TasksWhenPicker({
  value,
  today,
  mode = "when",
  onPick,
  trigger,
  ariaLabel,
}: {
  value: WhenValue;
  today: string;
  mode?: "when" | "deadline";
  onPick: (value: WhenValue) => void;
  trigger: ReactNode;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion() ?? false;
  const sheet = useSheetGesture();
  const dragControls = useDragControls();
  const sheetY = useMotionValue(0);
  const pickRef = useRef(onPick);
  const valueRef = useRef(value);

  // Declared first, so the mount effect below already sees this render's
  // callback and this render's value.
  useEffect(() => {
    pickRef.current = onPick;
    valueRef.current = value;
  });

  /** A REF CALLBACK, NOT AN EFFECT. Radix mounts the popover's content a
   *  commit after `open` turns true, so an effect keyed on `open` runs while
   *  the host is still null and never runs again. The callback fires when the
   *  host arrives, whenever that is, and React 19 calls the function it
   *  returns when the host goes away. */
  const mount = useCallback(
    (host: HTMLDivElement) => {
      const handle = renderWhenPicker({
        value: valueRef.current,
        today,
        mode,
        reduce,
        onPick: (next) => pickRef.current(next),
        onDone: () => setOpen(false),
      });
      host.append(handle.element);
      handle.focus();
      return () => handle.destroy();
    },
    [today, mode, reduce],
  );

  /** THE PICKER IS 430 TALL AND SOME WINDOWS ARE NOT.
   *
   *  A landscape phone, a short laptop window, a chip already low on the
   *  page: Radix measures the room it has and hands it over as
   *  `--radix-popover-content-available-height`, and past that the grid has to
   *  scroll rather than run off the bottom edge with Done on it. The edge is
   *  the panel atom's `fade`, which is what every other list inside glass
   *  uses, and it stays invisible while the whole picker fits. */
  const body = (
    <ScrollEdge variant="fade" className="brain-when-scroll">
      <div ref={mount} />
    </ScrollEdge>
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={ariaLabel}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={`brain-menu z-[var(--z-modal)]${sheet ? " brain-when-sheet" : ""}`}
        >
          {sheet ? (
            <motion.div
              style={{ y: sheetY }}
              initial={reduce ? false : { y: 48 }}
              animate={{ y: 0 }}
              transition={reduce ? { duration: 0 } : SPRING_SHEET}
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              dragConstraints={{ top: 0 }}
              dragElastic={0}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                if (
                  info.offset.y > SHEET_DISMISS_OFFSET ||
                  info.velocity.y > SHEET_DISMISS_VELOCITY
                ) {
                  setOpen(false);
                  return;
                }
                animate(sheetY, 0, reduce ? { duration: 0 } : SPRING_SHEET_GESTURE);
              }}
            >
              <div
                aria-hidden
                className="brain-composer-grip"
                onPointerDown={(event) => dragControls.start(event)}
              >
                <span />
              </div>
              {body}
            </motion.div>
          ) : (
            body
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
