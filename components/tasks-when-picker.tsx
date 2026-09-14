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
 *
 *  IT HOLDS TWO KINDS OF CONTROL, and they answer differently.
 *
 *  The QUICK ROWS are Today, This Evening, Someday and Clear: the words a
 *  reader presses to be done with the question. One tap, one write, the panel
 *  closes, exactly as the menu they replaced answered.
 *
 *  The GRID, the reminder and its clock are the DETAILED path. They move the
 *  picker's own value and the panel stands, because a reminder needs its day
 *  first and because a clock set one arrow at a time is one decision and not
 *  six. `Done` and a tap outside send what the reader settled on, Escape
 *  throws it away, and a value that ends where it began sends nothing at all.
 *  The host says when the write goes out, through `commit()` on the handle.
 *
 *  ONE WRITE AT A TIME, AND NO QUEUE. From the moment a value goes out until
 *  the host answers, the panel is PENDING: `aria-busy`, the rows and the grid
 *  quiet and out of reach, Done and the clock disabled. A press made there is
 *  neither sent nor remembered, because a word held back is a word the reader
 *  can no longer see. Escape still answers and cancels nothing: the value is
 *  with the host, and the record will say what the host made of it whether or
 *  not this panel is still on screen. An acceptance is the panel's last act.
 *  A refusal gives it back: the pending state lifts, the host shows the reason
 *  where the reader is looking, and the same press writes again.
 */

import * as Popover from "@radix-ui/react-popover";
import { motion, useDragControls, useMotionValue, useReducedMotion } from "framer-motion";
import { animate } from "framer-motion/dom";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import {
  DUR,
  SHEET_DISMISS_OFFSET,
  SHEET_DISMISS_VELOCITY,
  SHEET_ENTER_Y,
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

/** WHETHER THE HOST TOOK THE VALUE.
 *
 *  Nothing and `true` are an acceptance, so a host that cannot refuse says
 *  nothing at all. `false`, now or when the promise settles, puts the picker
 *  back where it was and the same press writes again: a route that answers
 *  409 or 400 has not moved the record, and a picker that believed it had
 *  would dismiss the second press with nothing filed and no second reason.
 *
 *  A PROMISE IS READ THE SAME WAY, and its settlement strictly. Only `false`
 *  is a refusal, so an `async` host with no answer to give resolves with
 *  nothing and is taken at its word, exactly as the host that returns nothing
 *  is. A REJECTION IS A REFUSAL: a host that threw has filed nothing, and
 *  reading the throw as an acceptance would spend the value and leave the
 *  rejection unhandled beside it. A host that answers late holds the panel
 *  PENDING until it settles, which is the whole of the waiting state. */
export type WhenAccepted = void | boolean | Promise<boolean | void>;

export interface WhenPickerOptions {
  value: WhenValue;
  /** WHAT THE RECORD ALREADY SAYS, when that is not the value the picker
   *  opens on. Defaults to `value`, which is the row's case: the chip opens
   *  on the record it belongs to. `null` says there is NO record yet, so
   *  nothing a press could send would repeat one, and every control here is
   *  live: on a line that is not a task, `Clear` means "file it with no day"
   *  the way the note's own Inbox row does, rather than closing the panel
   *  having done nothing. */
  baseline?: WhenValue | null;
  today: string;
  mode: "when" | "deadline";
  reduce: boolean;
  /** THE WRITE. Reached only through `commit()`, which the host calls, and
   *  never with a value the record already carries. */
  onPick: (value: WhenValue) => WhenAccepted;
  onDone: () => void;
}

/** The one reading of "these two say the same thing", so the no-op rule and
 *  every host that has to measure a press against a record answer it the same
 *  way. */
export function sameWhenValue(a: WhenValue, b: WhenValue): boolean {
  return a.when === b.when && a.evening === b.evening && a.time === b.time;
}

export interface WhenPickerHandle {
  readonly element: HTMLElement;
  focus(): void;
  /** Sends what the reader settled on, unless it is what the record already
   *  says, or a write from this panel is still out. The HOST chooses the
   *  moment, because the moment differs: the row's popover commits once it has
   *  closed, so the fold never plays under it, and the note's promote popover
   *  commits while it is still open, because a refusal has to be shown on the
   *  control the reader is holding. Calling it twice on one answer writes
   *  once, a value the host would not take stays one press away, and it is
   *  safe after `destroy()`. */
  commit(): void;
  /** A ROW THE HOST DRAWS, ANSWERED BY THE PICKER'S OWN RULES. The note's
   *  promote popover keeps one word above the picker (Inbox) that no grid can
   *  say, and a press of it has to keep the no-op rule, the pending state and
   *  the refusal path the picker's own `Clear` keeps: two controls one word
   *  apart cannot answer to different rules. So the host hands the value here
   *  rather than writing on its own. Inert while the panel is pending, like
   *  every row below it. */
  pick(value: WhenValue): void;
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

/** One value with its own arrow pair, up over down. */
function spinUnit(
  box: HTMLElement,
  up: HTMLButtonElement,
  down: HTMLButtonElement,
): HTMLElement {
  const unit = document.createElement("div");
  unit.className = "brain-when-spin-unit";
  const arrows = document.createElement("div");
  arrows.className = "brain-when-spin-arrows";
  arrows.append(up, down);
  unit.append(box, arrows);
  return unit;
}

/** A spinner's step: 16px, because a pair of them stands beside one 13px
 *  value and the atom's smallest is 28. Everything else about it is
 *  `.icon-btn`'s. */
function arrowButton(label: string, name: string, flag: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.dataset.whenStep = "";
  button.setAttribute(flag, "");
  button.setAttribute("aria-label", label);
  button.append(glyph(name, 12));
  return button;
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

  /** WHAT THE RECORD ALREADY SAYS, as far as this picker knows: the baseline
   *  it was opened on, and then every value a host has TAKEN. It advances on
   *  an acceptance and on nothing else, so a value a route refused is still a
   *  value this picker can send again, and no refusal has to walk a chain of
   *  optimistic values back to find where the record was. A commit that would
   *  repeat it sends nothing, which is how a gesture that ends where it began
   *  writes no PATCH at all, and how a second press of one quick row cannot
   *  mint a second write. `null` is a record that does not exist yet: nothing
   *  can repeat what is not there, so every press writes. */
  let sent: WhenValue | null =
    options.baseline === undefined
      ? { ...options.value }
      : options.baseline === null
        ? null
        : { ...options.baseline };
  /** THE ONE WRITE THIS PANEL HAS OUT, and the pending state with it. While
   *  it is here every control is inert and `commit()` sends nothing: one write
   *  at a time, and a press made in that window is neither queued nor kept. It
   *  is also the identity a settlement is read against, so an answer to a
   *  write this panel has left behind lifts nothing and moves nothing. */
  let inFlight: WhenValue | null = null;
  /** TRUE ONCE A QUICK ROW OR DONE HAS ANSWERED THE QUESTION. The panel is
   *  closing from that press on, and its 120ms exit keeps this element and its
   *  keydown listener mounted for the whole of it. Escape in that window used
   *  to put the value back and cancel a write the reader had already asked
   *  for, so Escape is inert once either of them has answered. */
  let answered = false;

  const element = document.createElement("div");
  element.className = "brain-when-picker";
  // Focusable by script and not by Tab: a disabled control drops the focus to
  // the document, and the key that closes a waiting panel is on the panel.
  element.tabIndex = -1;

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

  /** I5. THE PANEL NAMES ITS FIELD, in deadline mode.
   *
   *  It drew Today, the grid, "No deadline" and "Done", and the word deadline
   *  appeared once, on the button that clears it. The chip that opened it has
   *  already turned from "Deadline" into "15 Sep" by then, so on the row the
   *  only thing separating when from deadline was a 14px flag glyph beside a
   *  14px calendar glyph. The `aria-label` said "Deadline" and nothing
   *  visible did. */
  const caption = document.createElement("div");
  caption.className = "brain-when-caption text-label";
  caption.textContent = "Deadline";

  const todayRow = row("Today", "star-linear", "data-when-today");
  const eveningRow = row("This Evening", "moon-linear", "data-when-evening");
  const somedayRow = row("Someday", "box-minimalistic-linear", "data-when-someday");
  const reminderRow = row("Reminder", "clock-circle-linear", "data-when-reminder");

  if (deadline) element.append(caption);
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
  const hourUp = arrowButton("An hour later", "alt-arrow-up-linear", "data-when-hour-up");
  const hourDown = arrowButton(
    "An hour earlier",
    "alt-arrow-down-linear",
    "data-when-hour-down",
  );
  const minuteUp = arrowButton(
    "Five minutes later",
    "alt-arrow-up-linear",
    "data-when-minute-up",
  );
  const minuteDown = arrowButton(
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

    // TWO SPINNERS, NOT SEVEN SIBLINGS IN A ROW. The children were `hour,
    // hourDown, hourUp, colon, minute, minuteDown, minuteUp` with a uniform
    // 2px between every one of them: nothing bound an arrow pair to the value
    // it steps, the hour's "later" arrow touched the colon, and down came
    // before up, inverted from every stepper a reader has used. Each value
    // now carries its own vertical pair, up over down, and the colon stands
    // clear of the pair before it.
    spin.append(
      spinUnit(hour, hourUp, hourDown),
      colon,
      spinUnit(minute, minuteUp, minuteDown),
      gap,
      timeClear,
    );
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
  // I9. ONE INK FILL PER SURFACE (DESIGN.md ban 5). The chosen day is an
  // ink-filled square and Done was an ink-filled primary, two black masses at
  // opposite ends of a 430px panel. The day keeps its capsule, because that is
  // the answer the panel exists to give; Done is the quiet button the rows
  // are, carrying its weight in ink text, and Clear stands beside it a step
  // quieter still.
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn btn-quiet";
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

  /** THE PANEL WAITING ON ITS ONE WRITE, drawn. Every control that could
   *  start a second write says so and takes none: `aria-busy` on the panel,
   *  the rows and the grid quiet and out of reach through the one rule in
   *  `app/globals.css`, Done, Clear, the month arrows and the clock disabled.
   *  The guards on the handlers below say the same thing to the keyboard. */
  function paintPending(): void {
    const busy = inFlight !== null;
    const held = element.contains(document.activeElement);
    if (busy) element.setAttribute("aria-busy", "true");
    else element.removeAttribute("aria-busy");
    for (const row of [todayRow, eveningRow, somedayRow]) {
      row.setAttribute("aria-disabled", String(busy));
    }
    // The reminder has a rule of its own (a clock needs a day), and waiting is
    // one more reason to be out of reach rather than a reason to be back in it.
    reminderRow.setAttribute("aria-disabled", String(busy || reminderRow.disabled));
    for (const control of [
      clear,
      done,
      previous,
      next,
      hourUp,
      hourDown,
      minuteUp,
      minuteDown,
      timeClear,
    ]) {
      control.disabled = busy;
    }
    for (const box of [hour, minute]) {
      box.setAttribute("aria-disabled", String(busy));
      box.tabIndex = busy ? -1 : 0;
    }
    // A disabled control drops the focus to the document, and Escape is heard
    // here. So the panel takes the focus from the control it has disabled.
    if (busy && held && !element.contains(document.activeElement)) element.focus();
  }

  /** Repaint, keep the focus where it was, and carry the grid if the month
   *  travelled. Under reduced motion the grid changes and nothing moves. */
  function repaint(travel = 0): void {
    const held = grid.contains(document.activeElement);
    paint();
    paintPending();
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
    if (inFlight !== null) return;
    const nextMonth = monthOfDay(day);
    const travel = travelTo(nextMonth);
    focusedDay = day;
    month = nextMonth;
    repaint(travel);
  }

  function pageMonth(by: number): void {
    if (inFlight !== null) return;
    const nextMonth = shiftMonth(month, by);
    const dayOfMonth = Math.min(Number(focusedDay.slice(8, 10)), lengthOfMonth(nextMonth));
    focusedDay = `${nextMonth}-${pad2(dayOfMonth)}`;
    month = nextMonth;
    repaint(by > 0 ? 1 : -1);
  }

  /** THE DETAILED PATH. The grid, the reminder switch and the clock edit the
   *  picker's own value and the panel stands: a reminder needs its day first,
   *  so picking a day has to be something the reader can follow with a clock.
   *  Nothing leaves here. */
  function edit(next: WhenValue, travel = 0): void {
    // A PRESS MADE WHILE THE PANEL IS WAITING DOES NOTHING AND IS NOT KEPT.
    // One write at a time: a value parked here would be filed a moment later,
    // out of sight of the reader who named it.
    if (inFlight !== null) return;
    value = next;
    repaint(travel);
  }

  /** A QUICK ROW: one tap, one write, and the picker is gone. Today, This
   *  Evening, Someday and Clear are the words a reader presses to be done, the
   *  way the menu they replaced answered and the way Things answers. The write
   *  itself is the host's, a moment later, through `commit()`. */
  function quick(next: WhenValue): void {
    if (inFlight !== null) return;
    value = next;
    answered = true;
    repaint();
    onDone();
  }

  function commit(): void {
    // ONE WRITE AT A TIME. A second value cannot leave while the first is
    // still out, and it is not parked for later either: the panel is inert
    // while it waits, so there is no press to park.
    if (inFlight !== null) return;
    if (sent !== null && sameWhenValue(value, sent)) return;
    const going: WhenValue = { ...value };
    const answer = onPick(going);
    // A HOST THAT ANSWERS AT THE PRESS answers now. `false` is a refusal and
    // has moved nothing, so the record stands where it stood and the same
    // press writes again.
    if (answer === false) return;
    // Anything that is not a promise has answered already. A `void` host
    // whose last statement happens to have a value is one of these, which is
    // why the promise is recognised by shape rather than by what it is not.
    if (answer === null || typeof answer !== "object") {
      sent = going;
      return;
    }
    // A HOST THAT ANSWERS LATER holds the panel until it does. Only `false`
    // is a refusal, and so is a throw: a host whose promise rejects has filed
    // nothing, and a rejection read as an acceptance would spend the value and
    // go unhandled beside it. An `async` host that resolves with nothing says
    // what a plain one says by returning nothing.
    inFlight = going;
    paintPending();
    const settle = (took: boolean): void => {
      // The answer to a write this panel has already left behind lifts
      // nothing and moves nothing.
      if (inFlight !== going) return;
      inFlight = null;
      if (took) sent = going;
      paint();
      paintPending();
    };
    void answer.then((took) => settle(took !== false), () => settle(false));
  }

  function pickDay(day: string): void {
    if (inFlight !== null) return;
    const travel = travelTo(monthOfDay(day));
    focusedDay = day;
    month = monthOfDay(day);
    edit({ when: day, evening: value.evening && day === today, time: value.time }, travel);
  }

  function stepClock(hours: number, minutes: number): void {
    const clock = value.time ?? DEFAULT_REMINDER_TIME;
    const nextHour = (((Number(clock.slice(0, 2)) + hours) % 24) + 24) % 24;
    const nextMinute =
      (((Number(clock.slice(3, 5)) + minutes * MINUTE_STEP) % 60) + 60) % 60;
    edit({ ...value, time: `${pad2(nextHour)}:${pad2(nextMinute)}` });
  }

  /* ── What the reader presses ──────────────────────────────────────────── */

  todayRow.addEventListener("click", () =>
    quick({ when: today, evening: false, time: value.time }),
  );
  eveningRow.addEventListener("click", () =>
    quick({ when: today, evening: true, time: value.time }),
  );
  // A clock and an evening both need a day. Someday is not one, so both come
  // off with it rather than travelling to a record that refuses the pair.
  somedayRow.addEventListener("click", () =>
    quick({ when: "someday", evening: false, time: null }),
  );
  reminderRow.addEventListener("click", () => {
    if (!isDay(value.when)) return;
    edit({ ...value, time: value.time === null ? DEFAULT_REMINDER_TIME : null });
  });
  timeClear.addEventListener("click", () => edit({ ...value, time: null }));
  hourUp.addEventListener("click", () => stepClock(1, 0));
  hourDown.addEventListener("click", () => stepClock(-1, 0));
  minuteUp.addEventListener("click", () => stepClock(0, 1));
  minuteDown.addEventListener("click", () => stepClock(0, -1));
  previous.addEventListener("click", () => pageMonth(-1));
  next.addEventListener("click", () => pageMonth(1));
  clear.addEventListener("click", () => quick({ when: null, evening: false, time: null }));
  // DONE ANSWERS THE QUESTION as squarely as a quick row does, and what
  // follows it is the same 120ms exit with the same listener on it.
  done.addEventListener("click", () => {
    answered = true;
    onDone();
  });

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
      // A PRESS THAT ALREADY ANSWERED IS NOT UNDONE BY THE KEY THAT FOLLOWS
      // IT. The panel plays its exit for 120ms with this listener still on it,
      // and a reader who taps Today, or Done, and reaches for Escape on the
      // way out asked for one write, not for none.
      // ESCAPE CLOSES A WAITING PANEL AND CANCELS NOTHING. The value is with
      // the host, so there is nothing here left to throw away: the write lands
      // or is refused off screen, and the record says so the way it says any
      // other write.
      if (inFlight !== null) {
        onDone();
        return;
      }
      if (answered) return;
      // ESCAPE THROWS THE VALUE AWAY. It is the one way out that leaves the
      // record where it was, so a reader halfway through a month has a way
      // back that is not another five presses. Put back what the record says,
      // or what the panel opened on when there is no record, and take that as
      // the baseline: every commit after it is a commit of nothing.
      value = sent === null ? { ...options.value } : { ...sent };
      sent = { ...value };
      onDone();
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(OWN_KEYS) !== null) return;
    // The grid is inert while the panel waits, on the keyboard as under a
    // finger, so the keys it would answer are left to the panel around it.
    if (inFlight !== null) return;

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
  paintPending();

  return {
    element,
    focus: () => rovingCell().focus(),
    commit,
    pick: quick,
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
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const pickRef = useRef(onPick);
  const valueRef = useRef(value);
  /** TRUE ONCE THE POPOVER HAS BEEN ASKED TO CLOSE, by Done, by a quick row,
   *  by Escape or by a tap outside. Read in the teardown below, which also
   *  runs when a dependency changes under an OPEN popover, which is a remount
   *  and not a decision to write anything. */
  const closing = useRef(false);

  /** THE ONE WAY OUT, so the sheet leaves the same way whichever gesture
   *  asked it to.
   *
   *  C3. The sheet used to carry two arrivals and two dismissals at once: the
   *  material's `materialize-in`/`materialize-out` keyframes on the
   *  `Popover.Content` and framer's `SPRING_SHEET` on the box inside it. So it
   *  popped rather than rose, and on release it faded and scaled where it
   *  stood over the list it was drawn on, with the calendar's week rows and
   *  the rows underneath both legible and neither readable. The material
   *  animates nothing in the sheet form now; what holds the node while the
   *  exit plays is a keyframe that moves nothing, and the travel off the
   *  bottom is this spring, alone. Reduced motion collapses that keyframe
   *  through the global rule, and there the sheet goes at once. */
  const close = useCallback(() => {
    closing.current = true;
    if (sheet && !reduce) {
      const height = sheetRef.current?.offsetHeight ?? 0;
      const away = sheetY.get() + (height > 0 ? height : window.innerHeight);
      animate(sheetY, away, SPRING_SHEET);
    }
    setOpen(false);
  }, [reduce, sheet, sheetY]);

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
      closing.current = false;
      const handle = renderWhenPicker({
        value: valueRef.current,
        today,
        mode,
        reduce,
        onPick: (next) => pickRef.current(next),
        onDone: close,
      });
      host.append(handle.element);
      handle.focus();
      /** THE WRITE LANDS WHEN THE POPOVER HAS GONE, and not a frame earlier.
       *  A reschedule folds the row downward, and a fold that starts while
       *  the picker is still drawn takes the row out from under the panel
       *  the reader is holding. This teardown is that moment: Radix keeps the
       *  content mounted for its 120ms retrace and React calls back here as
       *  it takes the host away. The picker is taken out of the document
       *  FIRST, so "the panel has gone" is a fact the write can be measured
       *  against rather than a claim about React's commit order. */
      return () => {
        handle.destroy();
        if (closing.current) handle.commit();
      };
    },
    [close, today, mode, reduce],
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
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        // A TAP OUTSIDE IS AN ANSWER, and Radix's own dismissals come through
        // here rather than through `onDone`.
        if (!next) {
          close();
          return;
        }
        // A sheet that was carried away last time starts its next arrival
        // from its resting place, not from wherever the dismissal left it.
        sheetY.set(0);
        setOpen(true);
      }}
    >
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        {/* ONE OBJECT CARRIES THE MATERIAL AND THE SPRING (C3).
            The sheet used to be a `motion.div` INSIDE the content, so the
            glass, the blur and the shadow stayed where they were while the
            box inside them slid away: for the length of the exit an empty
            pane of the material sat over the list. `asChild` makes the
            content the moving element, so what the reader sees leave the
            screen is the whole sheet. */}
        <Popover.Content
          asChild={sheet}
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          aria-label={ariaLabel}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={sheet ? undefined : "brain-menu brain-when-panel z-[var(--z-modal)]"}
        >
          {sheet ? (
            <motion.div
              ref={sheetRef}
              className="brain-menu brain-when-panel brain-when-sheet z-[var(--z-modal)]"
              style={{ y: sheetY }}
              initial={reduce ? false : { y: SHEET_ENTER_Y }}
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
                  // THE GRIP IS A CLOSE, NOT A CANCEL. On a phone it is the
                  // primary way out of this panel, and the same panel on a
                  // pointer commits what a press outside settled on. Two
                  // dismissals of one control cannot mean opposite things.
                  close();
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
