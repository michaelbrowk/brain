// @vitest-environment jsdom

// The When picker on its own: the rows it offers, the grid it draws, the
// keyboard it answers, the two spinners, and the one thing every one of them
// sends back. Nothing here is mounted on a surface yet, because Task 7 wires
// it, so the
// harness opens the DOM the picker returns and presses it directly.

import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_REMINDER_TIME,
  renderWhenPicker,
  TasksWhenPicker,
  type WhenPickerHandle,
  type WhenPickerOptions,
  type WhenValue,
} from "./tasks-when-picker";

const TODAY = "2026-09-13"; // a Sunday

const picked: WhenValue[] = [];
const closed: number[] = [];
const handles: WhenPickerHandle[] = [];

/** The harness is a HOST, because the picker no longer decides when its value
 *  goes out: it collects, and the host commits. This one commits the way the
 *  note's promote popover does, the moment the picker asks to close. */
const open = (over: Partial<WhenPickerOptions> = {}) => {
  const handle: WhenPickerHandle = renderWhenPicker({
    value: { when: null, evening: false, time: null },
    today: TODAY,
    mode: "when",
    reduce: false,
    onPick: (value) => {
      picked.push(value);
    },
    onDone: () => {
      closed.push(1);
      handle.commit();
    },
    ...over,
  });
  // Mounted, because a roving tab stop that is never in the document cannot
  // prove it kept focus.
  document.body.append(handle.element);
  handles.push(handle);
  return handle;
};

const rows = (element: HTMLElement) =>
  [...element.querySelectorAll(".brain-menu-item")].map((row) =>
    (row.textContent ?? "").trim(),
  );
const glyphs = (element: HTMLElement) =>
  [...element.querySelectorAll(".brain-menu-item [data-glyph]")].map((mark) =>
    mark.getAttribute("data-glyph"),
  );
/** The picker's children in drawn order: a row by its words, a box by its
 *  class. `rows()` collects `.brain-menu-item` only, so the grid's place
 *  between them is invisible to it. */
const shape = (element: HTMLElement) =>
  [...element.children].map((child) =>
    child.classList.contains("brain-menu-item")
      ? (child.textContent ?? "").trim()
      : child.className,
  );
const cell = (element: HTMLElement, day: string) =>
  element.querySelector<HTMLElement>(`[data-day="${day}"]`)!;
const roving = (element: HTMLElement) =>
  element.querySelector("[tabindex='0'][data-day]")?.getAttribute("data-day");
const key = (element: HTMLElement, name: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
const month = (element: HTMLElement) =>
  element.querySelector(".brain-when-month")?.textContent;
/** The detailed path's own commit: Done sends what the reader settled on. */
const done = (element: HTMLElement) =>
  element.querySelector<HTMLElement>("[data-when-done]")?.click();
const clock = (element: HTMLElement) =>
  `${element.querySelector("[data-when-hour]")?.textContent}:${
    element.querySelector("[data-when-minute]")?.textContent
  }`;

/** Every WAAPI animation the picker starts, in order, on the same recorder the
 *  row's tests use, so a keyframe that stopped matching fails here. */
const animations: { element: Element; frames: Keyframe[] }[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  // Radix's popper measures its content, and jsdom ships no ResizeObserver.
  (globalThis as typeof globalThis & { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  picked.length = 0;
  closed.length = 0;
  handles.length = 0;
  animations.length = 0;
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value(frames: Keyframe[]) {
      animations.push({ element: this as Element, frames });
      return { finished: Promise.resolve(), cancel: () => {} };
    },
  });
});

afterEach(() => {
  for (const handle of handles) handle.destroy();
  document.body.innerHTML = "";
  Reflect.deleteProperty(Element.prototype, "animate");
});

describe("the picker's rows", () => {
  it("offers Today, This Evening, Someday, Reminder, Clear and Done", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    expect(rows(element)).toEqual(["Today", "This Evening", "Someday", "Reminder"]);
    expect(element.querySelector("[data-when-clear]")?.textContent).toBe("Clear");
    expect(element.querySelector("[data-when-done]")?.textContent).toBe("Done");
  });

  it("offers This Evening only while the picked day is today", () => {
    const { element } = open({ value: { when: "2026-09-14", evening: false, time: null } });
    expect(rows(element)).not.toContain("This Evening");
  });

  it("defaults to today, which is why the evening is on offer at rest", () => {
    expect(rows(open().element)).toContain("This Evening");
  });

  it("hides the evening, Someday and the reminder on a deadline, and keeps Today", () => {
    const { element } = open({ mode: "deadline" });
    expect(rows(element)).toEqual(["Today"]);
    expect(element.querySelector("[data-when-clear]")?.textContent).toBe("No deadline");
  });

  it("draws Today with the star, the evening with the moon, Someday with the box", () => {
    const { element } = open();
    expect(glyphs(element).slice(0, 3)).toEqual([
      "star-linear",
      "moon-linear",
      "box-minimalistic-linear",
    ]);
  });

  it("sends the day, the evening and Someday from their rows", () => {
    // A picker each: a quick row commits and closes, and a picker writes once.
    const evening = open();
    evening.element.querySelector<HTMLElement>("[data-when-evening]")?.click();
    expect(picked.at(-1)).toEqual({ when: TODAY, evening: true, time: null });

    const day = open({ value: { when: "someday", evening: false, time: null } });
    day.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(picked.at(-1)).toEqual({ when: TODAY, evening: false, time: null });

    const someday = open({ value: { when: TODAY, evening: false, time: null } });
    someday.element.querySelector<HTMLElement>("[data-when-someday]")?.click();
    expect(picked.at(-1)).toEqual({ when: "someday", evening: false, time: null });
  });

  it("draws Someday under the grid, which is the order the popover reads in", () => {
    expect(shape(open().element)).toEqual([
      "Today",
      "This Evening",
      "brain-when-head",
      "brain-when-grid",
      "Someday",
      "Reminder",
      "brain-when-spin",
      "brain-when-foot",
    ]);
  });

  it("says which row is the current one", () => {
    const { element } = open({ value: { when: "someday", evening: false, time: null } });
    expect(
      element.querySelector("[data-when-someday]")?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(element.querySelector("[data-when-today]")?.getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});

describe("the month grid", () => {
  it("draws six weeks from Monday, with today marked", () => {
    const { element } = open();
    expect(element.querySelectorAll("[data-day]")).toHaveLength(42);
    expect(element.querySelector("[data-today]")?.getAttribute("data-day")).toBe(TODAY);
    expect(month(element)).toBe("September 2026");
  });

  it("names the week's days above it, Monday first", () => {
    const { element } = open();
    expect(
      [...element.querySelectorAll(".brain-when-weekday")].map((head) => head.textContent),
    ).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  });

  it("keeps a day before today pickable and quiet", () => {
    // A deadline in the past is a real thing a person records, so the press
    // has to land. Marking the cell disabled reddens this.
    const { element } = open();
    const past = cell(element, "2026-09-01");
    expect(past.getAttribute("data-past")).toBe("");
    past.click();
    done(element);
    expect(picked.at(-1)?.when).toBe("2026-09-01");
  });

  it("keeps a day outside the month pickable and quieter still", () => {
    const { element } = open();
    const outside = cell(element, "2026-10-01");
    expect(outside.getAttribute("data-outside")).toBe("");
    outside.click();
    done(element);
    expect(picked.at(-1)?.when).toBe("2026-10-01");
  });

  it("says the date out loud, and names today as today", () => {
    const { element } = open();
    expect(cell(element, "2026-09-15").getAttribute("aria-label")).toBe(
      "Tuesday 15 September",
    );
    expect(cell(element, "2026-09-13").getAttribute("aria-current")).toBe("date");
    expect(cell(element, "2026-09-14").hasAttribute("aria-current")).toBe(false);
  });

  it("picks a day on a press", () => {
    const { element } = open();
    cell(element, "2026-09-20").click();
    expect(cell(element, "2026-09-20").getAttribute("aria-selected")).toBe("true");
    done(element);
    expect(picked.at(-1)).toEqual({ when: "2026-09-20", evening: false, time: null });
  });

  it("moves one day on the arrows and seven on up and down", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    key(element, "ArrowRight");
    expect(roving(element)).toBe("2026-09-14");
    key(element, "ArrowDown");
    expect(roving(element)).toBe("2026-09-21");
    key(element, "ArrowLeft");
    expect(roving(element)).toBe("2026-09-20");
    key(element, "ArrowUp");
    expect(roving(element)).toBe("2026-09-13");
  });

  it("keeps exactly one cell in the tab order, and the focus on it", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    element.querySelector<HTMLElement>("[tabindex='0'][data-day]")?.focus();
    key(element, "ArrowRight");
    expect(element.querySelectorAll("[data-day][tabindex='0']")).toHaveLength(1);
    expect(document.activeElement?.getAttribute("data-day")).toBe("2026-09-14");
  });

  it("goes to the week's ends on Home and End", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    key(element, "Home");
    expect(roving(element)).toBe("2026-09-07");
    key(element, "End");
    expect(roving(element)).toBe("2026-09-13");
  });

  it("picks the focused day on Enter", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    key(element, "ArrowRight");
    key(element, "Enter");
    expect(cell(element, "2026-09-14").getAttribute("aria-selected")).toBe("true");
    done(element);
    expect(picked.at(-1)?.when).toBe("2026-09-14");
  });

  it("keeps the panel standing through the grid and the clock, and sends nothing yet", () => {
    // THE DETAILED PATH. A reminder needs its day first, so picking a day has
    // to be something a reader can follow with a clock, and a clock set one
    // arrow at a time is one decision rather than six writes.
    const { element } = open({ value: { when: TODAY, evening: false, time: "09:00" } });
    cell(element, "2026-09-20").click();
    element.querySelector<HTMLElement>("[data-when-hour-up]")?.click();
    element.querySelector<HTMLElement>("[data-when-minute-up]")?.click();
    key(element, "PageDown");
    expect(closed).toHaveLength(0);
    expect(picked).toHaveLength(0);

    done(element);
    expect(closed).toHaveLength(1);
    expect(picked).toEqual([{ when: "2026-09-20", evening: false, time: "10:05" }]);
  });

  it("closes on a quick row, which is one tap and one write", () => {
    // Today, This Evening, Someday and Clear are the words a reader presses to
    // be done with the question, the way the menu they replaced answered.
    const { element } = open({ value: { when: "2026-09-20", evening: false, time: null } });
    element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(closed).toHaveLength(1);
    expect(picked).toEqual([{ when: TODAY, evening: false, time: null }]);
  });

  it("throws the picked value away on Escape", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    cell(element, "2026-09-20").click();
    key(element, "Escape");
    expect(closed).toHaveLength(1);
    expect(picked).toHaveLength(0);
  });

  it("sends nothing when the value ends where it began", () => {
    // A row already in Today, and Today pressed on it: a write nobody asked
    // for, in every request body and in every git diff.
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(closed).toHaveLength(1);
    expect(picked).toHaveLength(0);

    const second = open({ value: { when: TODAY, evening: false, time: "09:00" } });
    second.element.querySelector<HTMLElement>("[data-when-hour-up]")?.click();
    second.element.querySelector<HTMLElement>("[data-when-hour-down]")?.click();
    done(second.element);
    expect(picked).toHaveLength(0);
  });

  it("changes the month on PageUp and PageDown, and on the two arrows", () => {
    const { element } = open();
    key(element, "PageDown");
    expect(month(element)).toBe("October 2026");
    key(element, "PageUp");
    key(element, "PageUp");
    expect(month(element)).toBe("August 2026");
    element.querySelector<HTMLElement>("[data-when-next]")?.click();
    expect(month(element)).toBe("September 2026");
  });

  it("carries the tab stop into the month it paged to", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    element.querySelector<HTMLElement>("[data-when-next]")?.click();
    expect(roving(element)).toBe("2026-10-13");
    expect(element.querySelectorAll("[data-day][tabindex='0']")).toHaveLength(1);
  });

  it("follows the focused day across a month boundary", () => {
    const { element } = open({ value: { when: "2026-09-30", evening: false, time: null } });
    key(element, "ArrowRight");
    expect(month(element)).toBe("October 2026");
    expect(roving(element)).toBe("2026-10-01");
  });

  it("sends nothing when only the month changed", () => {
    const { element } = open();
    key(element, "PageDown");
    expect(picked).toHaveLength(0);
  });
});

describe("the reminder", () => {
  it("turns on at 09:00", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    element.querySelector<HTMLElement>("[data-when-reminder]")?.click();
    expect(clock(element)).toBe(DEFAULT_REMINDER_TIME);
    done(element);
    expect(picked.at(-1)?.time).toBe(DEFAULT_REMINDER_TIME);
    expect(DEFAULT_REMINDER_TIME).toBe("09:00");
  });

  it("steps the hour by one and wraps", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "23:00" } });
    element.querySelector<HTMLElement>("[data-when-hour-up]")?.click();
    expect(clock(element)).toBe("00:00");
    element.querySelector<HTMLElement>("[data-when-hour-down]")?.click();
    expect(clock(element)).toBe("23:00");
    // Back where it started, so the whole gesture sent nothing.
    done(element);
    expect(picked).toHaveLength(0);
  });

  it("steps the minute by five and wraps", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "09:55" } });
    element.querySelector<HTMLElement>("[data-when-minute-up]")?.click();
    expect(clock(element)).toBe("09:00");
    element.querySelector<HTMLElement>("[data-when-minute-down]")?.click();
    expect(clock(element)).toBe("09:55");
  });

  it("steps from the keyboard the same way", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "09:00" } });
    const hour = element.querySelector<HTMLElement>("[role='spinbutton'][data-when-hour]")!;
    hour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(clock(element)).toBe("08:00");
    const minute = element.querySelector<HTMLElement>("[data-when-minute]")!;
    minute.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(clock(element)).toBe("08:05");
    done(element);
    expect(picked.at(-1)?.time).toBe("08:05");
  });

  it("leaves the day alone while the clock is being set", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "09:00" } });
    const hour = element.querySelector<HTMLElement>("[data-when-hour]")!;
    hour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(roving(element)).toBe(TODAY);
  });

  it("says what it is to a screen reader", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "13:05" } });
    const hour = element.querySelector("[data-when-hour]")!;
    expect(hour.getAttribute("aria-valuenow")).toBe("13");
    expect(hour.getAttribute("aria-valuemax")).toBe("23");
    expect(hour.getAttribute("aria-valuemin")).toBe("0");
    expect(element.querySelector("[data-when-minute]")?.getAttribute("aria-valuemax")).toBe(
      "55",
    );
    expect(element.querySelector("[data-when-minute]")?.getAttribute("aria-valuenow")).toBe(
      "5",
    );
  });

  it("keeps the spinners away until there is a time to show", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: null } });
    expect(element.querySelector(".brain-when-spin")?.hasAttribute("hidden")).toBe(true);
    element.querySelector<HTMLElement>("[data-when-reminder]")?.click();
    expect(element.querySelector(".brain-when-spin")?.hasAttribute("hidden")).toBe(false);
  });

  it("clears the time and nothing else", () => {
    const { element } = open({ value: { when: TODAY, evening: true, time: "13:00" } });
    element.querySelector<HTMLElement>("[data-when-time-clear]")?.click();
    done(element);
    expect(picked.at(-1)).toEqual({ when: TODAY, evening: true, time: null });
  });
});

describe("clearing", () => {
  // `lib/tasks/model.ts` refuses a clock without a day to be a clock on, and
  // `lib/store/store.test.ts` pins the store answering 400 to exactly that
  // pair. Every value that leaves this control has to be one a record can
  // hold, which is why the three cases below sit beside each other.
  it("takes the clock and the evening off when the day becomes Someday", () => {
    const { element } = open({ value: { when: TODAY, evening: true, time: "13:00" } });
    element.querySelector<HTMLElement>("[data-when-someday]")?.click();
    expect(picked.at(-1)).toEqual({ when: "someday", evening: false, time: null });
  });

  it.each([
    ["nothing set", null],
    ["someday", "someday"],
  ])("does not offer a reminder while the day is %s", (_name, when) => {
    const { element } = open({ value: { when, evening: false, time: null } });
    const row = element.querySelector<HTMLButtonElement>("[data-when-reminder]")!;
    expect(row.disabled).toBe(true);
    expect(row.title).toBe("Pick a day first");
    row.click();
    expect(picked).toHaveLength(0);
  });

  it("offers it the moment a day is picked", () => {
    // THE WHOLE REASON THE GRID DOES NOT CLOSE THE PICKER: the day has to be
    // there before the reminder is a reminder on anything.
    const { element } = open();
    const row = element.querySelector<HTMLButtonElement>("[data-when-reminder]")!;
    expect(row.disabled).toBe(true);
    cell(element, "2026-09-20").click();
    expect(row.disabled).toBe(false);
    row.click();
    done(element);
    expect(picked.at(-1)).toEqual({
      when: "2026-09-20",
      evening: false,
      time: DEFAULT_REMINDER_TIME,
    });
  });

  it("takes the evening and the clock with the day", () => {
    const { element } = open({ value: { when: TODAY, evening: true, time: "13:00" } });
    element.querySelector<HTMLElement>("[data-when-clear]")?.click();
    expect(picked.at(-1)).toEqual({ when: null, evening: false, time: null });
  });

  it("turns the evening off when the day stops being today", () => {
    const { element } = open({ value: { when: TODAY, evening: true, time: null } });
    cell(element, "2026-09-20").click();
    done(element);
    expect(picked.at(-1)).toEqual({ when: "2026-09-20", evening: false, time: null });
  });
});

describe("the commit contract", () => {
  it("keeps a refused pick one press away", () => {
    // `sent` IS A CLAIM ABOUT THE RECORD, so it may only move when the host
    // says the record did. A route that answers 409 or 400 leaves the panel
    // standing with the reason in it, and the reader presses the same row
    // again: that press has to write, or the panel dismisses on the second
    // try with nothing filed and no second reason.
    const answers: WhenValue[] = [];
    let takes = false;
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: (value) => {
        answers.push(value);
        return takes;
      },
    });
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toHaveLength(1);

    takes = true;
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toEqual([
      { when: TODAY, evening: false, time: null },
      { when: TODAY, evening: false, time: null },
    ]);
  });

  it("waits for a host whose answer is a promise before it believes it", async () => {
    // The note's popover cannot answer at the press: the refusal comes back
    // from the route. So the acceptance may settle late, and a refusal that
    // settles late puts the value back all the same.
    const answers: WhenValue[] = [];
    let settle!: (took: boolean) => void;
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: (value) => {
        answers.push(value);
        return new Promise<boolean>((resolve) => {
          settle = resolve;
        });
      },
    });
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toHaveLength(1);
    // While it is in flight the same value is not sent twice.
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toHaveLength(1);

    settle(false);
    await Promise.resolve();
    await Promise.resolve();
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toHaveLength(2);
  });

  it("writes every word when there is no record for one to repeat", () => {
    // A HOST WITH NO RECORD YET, which is the note's line before it is a task.
    // `Clear` there means "file it with no day", the same word the popover's
    // own Inbox row says, and the no-op rule has nothing to measure it
    // against: a baseline of `null` is not a record that says nothing set.
    const handle = open({ value: { when: null, evening: false, time: null }, baseline: null });
    handle.element.querySelector<HTMLElement>("[data-when-clear]")?.click();
    expect(picked).toEqual([{ when: null, evening: false, time: null }]);
  });

  it("still sends nothing after Escape on a picker with no baseline", () => {
    const handle = open({ value: { when: null, evening: false, time: null }, baseline: null });
    cell(handle.element, "2026-09-20").click();
    key(handle.element, "Escape");

    expect(picked).toHaveLength(0);
  });

  it("leaves a quick row's write alone when Escape lands inside the exit window", () => {
    // The material plays its exit for 120ms, so the panel and this handler are
    // still mounted after a quick row has closed it and the focus has not gone
    // back to the trigger yet. Escape in that window used to put the value
    // back and cancel a write the reader had already asked for.
    const sent: WhenValue[] = [];
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: (value) => {
        sent.push(value);
      },
      // A host that commits once the panel has gone, which is the row's.
      onDone: () => closed.push(1),
    });
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    key(handle.element, "Escape");
    handle.commit();

    expect(sent).toEqual([{ when: TODAY, evening: false, time: null }]);
  });

  it("leaves Done's write alone when Escape lands inside the exit window", () => {
    // DONE ANSWERED THE QUESTION TOO. The 120ms exit keeps this handler
    // mounted after Done as squarely as after a quick row, and a reader who
    // presses Done and reaches for Escape on the way out asked for one write,
    // not for none. The guard was on the rows alone, so the detailed path lost
    // the day it had been told to file a keystroke earlier.
    const sent: WhenValue[] = [];
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: (value) => {
        sent.push(value);
      },
      // A host that commits once the panel has gone, which is the row's.
      onDone: () => closed.push(1),
    });
    cell(handle.element, "2026-09-20").click();
    done(handle.element);
    key(handle.element, "Escape");
    handle.commit();

    expect(sent).toEqual([{ when: "2026-09-20", evening: false, time: null }]);
  });

  it("leaves a value the reader sent on top of a refusal where it is", async () => {
    // THE IDENTITY GUARD ON THE LATE ROLLBACK. Two writes out, the second
    // taken and the first refused after it: putting the picker back where the
    // first write found it would undo a value the record has since taken, and
    // the row the reader last pressed would mint a second write on the next
    // press.
    const answers: WhenValue[] = [];
    let refuseFirst!: (took: boolean) => void;
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: (value) => {
        answers.push(value);
        if (answers.length > 1) return true;
        return new Promise<boolean>((resolve) => {
          refuseFirst = resolve;
        });
      },
    });
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    handle.element.querySelector<HTMLElement>("[data-when-someday]")?.click();
    expect(answers).toHaveLength(2);

    refuseFirst(false);
    await Promise.resolve();
    await Promise.resolve();

    // Someday is what the record says now, so the row that says it sends
    // nothing.
    handle.element.querySelector<HTMLElement>("[data-when-someday]")?.click();
    expect(answers).toHaveLength(2);
  });

  it("reads a host's rejection as a refusal, and handles it", async () => {
    // A HOST WHOSE PROMISE THROWS HAS FILED NOTHING. Read as an acceptance it
    // spends the value, so the same row sends nothing on the second press, and
    // it leaves the rejection unhandled beside it: this file fails the run on
    // one of those, which is the other half of the case.
    const answers: WhenValue[] = [];
    let fail!: (error: Error) => void;
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: (value) => {
        answers.push(value);
        if (answers.length > 1) return true;
        return new Promise<boolean>((_resolve, reject) => {
          fail = reject;
        });
      },
    });
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    fail(new Error("the route could not be reached"));
    await Promise.resolve();
    await Promise.resolve();

    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toHaveLength(2);
  });

  it("reads an async host that answers nothing as an acceptance", async () => {
    // Nothing is an acceptance on the direct arm, so a host that cannot refuse
    // says nothing at all. An `async` host says the same thing by resolving
    // with nothing, and reading that as a refusal would send its value a
    // second time.
    const answers: WhenValue[] = [];
    const handle = open({
      value: { when: null, evening: false, time: null },
      onPick: async (value) => {
        answers.push(value);
      },
    });
    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    await Promise.resolve();
    await Promise.resolve();

    handle.element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(answers).toHaveLength(1);
  });

  it("still throws away a half-made pick on Escape, because nothing answered yet", () => {
    const sent: WhenValue[] = [];
    const handle = open({
      value: { when: TODAY, evening: false, time: null },
      onPick: (value) => {
        sent.push(value);
      },
      onDone: () => closed.push(1),
    });
    cell(handle.element, "2026-09-20").click();
    key(handle.element, "Escape");
    handle.commit();

    expect(sent).toHaveLength(0);
  });
});

describe("the motion", () => {
  it("carries the grid the way the month travelled", () => {
    const { element } = open();
    key(element, "PageDown");
    expect(animations).toHaveLength(1);
    expect(animations[0].element).toBe(element.querySelector(".brain-when-grid"));
    expect(animations[0].frames[0].transform).toBe("translateX(6px)");
    key(element, "PageUp");
    expect(animations[1].frames[0].transform).toBe("translateX(-6px)");
  });

  it("moves nothing at all under reduced motion", () => {
    const { element } = open({ reduce: true });
    key(element, "PageDown");
    expect(animations).toHaveLength(0);
    expect(month(element)).toBe("October 2026");
  });

  it("leaves the picker's own transitions to the sheet's blanket collapse", () => {
    // Every transition in the block is colour, so reduced motion needs no
    // exemption here: the global `*` rule collapses them and nothing travels.
    // An `!important` escape in this block would be the bug this case names.
    const block = pickerBlock();
    const declared = [...block.matchAll(/transition:([^;]+);/g)].map((hit) => hit[1].trim());
    expect(declared.length).toBeGreaterThan(0);
    for (const rule of declared) expect(rule).toMatch(/^background-color /);
    expect(block).not.toContain("!important");
    expect(block).not.toContain("prefers-reduced-motion");
  });
});

describe("the React wrapper", () => {
  it("mounts the same drawing the DOM builder returns", async () => {
    const value: WhenValue = { when: TODAY, evening: false, time: "13:00" };
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(
        <TasksWhenPicker
          value={value}
          today={TODAY}
          onPick={() => {}}
          ariaLabel="When"
          trigger={<button type="button">When</button>}
        />,
      );
    });
    await act(async () => {
      host.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    const mounted = document.querySelector<HTMLElement>(".brain-when-picker");
    const drawn = renderWhenPicker({
      value,
      today: TODAY,
      mode: "when",
      reduce: false,
      onPick: () => {},
      onDone: () => {},
    });
    expect(mounted?.outerHTML).toBe(drawn.element.outerHTML);
    drawn.destroy();
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the popover open after a pick and writes once it has gone", async () => {
    // THE ROW FOLDS AFTER THE PICKER HAS CLOSED, NEVER UNDER IT. A reschedule
    // folds the row downward, and a fold that starts while the panel is still
    // drawn takes the row out from under the thing the reader is holding. So
    // this host sends nothing until the popover is off the tree.
    const sent: WhenValue[] = [];
    const host = document.createElement("div");
    document.body.append(host);
    let root!: Root;
    await act(async () => {
      root = createRoot(host);
      root.render(
        <TasksWhenPicker
          value={{ when: TODAY, evening: false, time: null }}
          today={TODAY}
          onPick={(value) => sent.push(value)}
          ariaLabel="When"
          trigger={<button type="button">When</button>}
        />,
      );
    });
    await act(async () => {
      host.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    expect(document.querySelectorAll(".brain-when-picker")).toHaveLength(1);

    const drawn = document.querySelector<HTMLElement>(".brain-when-picker")!;
    await act(async () => {
      drawn
        .querySelector<HTMLElement>('[data-day="2026-09-20"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelectorAll(".brain-when-picker")).toHaveLength(1);
    expect(sent).toHaveLength(0);

    await act(async () => {
      drawn
        .querySelector<HTMLElement>("[data-when-done]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelectorAll(".brain-when-picker")).toHaveLength(0);
    expect(sent).toEqual([{ when: "2026-09-20", evening: false, time: null }]);

    await act(async () => root.unmount());
    host.remove();
  });

  it("writes with the picker already gone from the document", async () => {
    // THE CLAUSE THE ROW'S FOLD RESTS ON, made falsifiable. The two facts the
    // case above asserts are both true whether the write leaves in the click
    // handler or in the teardown, because neither of them watches the ORDER.
    // This one does: the host records, from inside the write itself, whether
    // the panel was still drawn at that moment.
    const drawnAtWrite: boolean[] = [];
    const mounted = await mountWrapper((value) => {
      drawnAtWrite.push(document.querySelector(".brain-when-picker") !== null);
      mounted.sent.push(value);
    });

    await act(async () => {
      pickDay(mounted.picker(), "2026-09-20");
    });
    await act(async () => {
      press(mounted.picker(), "[data-when-done]");
    });

    expect(mounted.sent).toHaveLength(1);
    expect(drawnAtWrite).toEqual([false]);
    await mounted.end();
  });

  it("commits on a press outside, which is an answer and not a cancel", async () => {
    // Radix's own dismissals reach the wrapper through `onOpenChange`, and a
    // press outside is the reader saying they are done with the panel. The
    // phone sheet's drag away is the same answer, pinned on the row.
    const mounted = await mountWrapper();
    await act(async () => {
      pickDay(mounted.picker(), "2026-09-20");
    });
    expect(mounted.sent).toHaveLength(0);

    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    // Radix arms the outside listener a tick after the content mounts, and
    // reads the whole press rather than its first half.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      elsewhere.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
      elsewhere.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      elsewhere.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    elsewhere.remove();

    expect(document.querySelectorAll(".brain-when-picker")).toHaveLength(0);
    expect(mounted.sent).toEqual([{ when: "2026-09-20", evening: false, time: null }]);
    await mounted.end();
  });

  it("sends nothing when the picker goes away without a close", async () => {
    // A LIST REFETCH, A ROW LEAVING, A ROUTE CHANGE. None of them is a reader
    // saying they are done, and the detailed path's whole contract is that a
    // day picked while they reach for the clock is not a value yet. Writing it
    // on an unmount nobody asked for files a record on a press that was never
    // finished, with no panel left to show what happened.
    const mounted = await mountWrapper();
    await act(async () => {
      pickDay(mounted.picker(), "2026-09-20");
    });

    await mounted.end();

    expect(mounted.sent).toHaveLength(0);
  });
});

/** The wrapper on a page, opened, with the four things a case needs back. */
async function mountWrapper(onPick?: (value: WhenValue) => void) {
  const sent: WhenValue[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(
      <TasksWhenPicker
        value={{ when: TODAY, evening: false, time: null }}
        today={TODAY}
        onPick={
          onPick ??
          ((value) => {
            sent.push(value);
          })
        }
        ariaLabel="When"
        trigger={<button type="button">When</button>}
      />,
    );
  });
  await act(async () => {
    host
      .querySelector("button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  return {
    sent,
    picker: () => document.querySelector<HTMLElement>(".brain-when-picker")!,
    end: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const press = (element: HTMLElement, selector: string) =>
  element
    .querySelector<HTMLElement>(selector)
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

const pickDay = (element: HTMLElement, day: string) =>
  press(element, `[data-day="${day}"]`);

const css = readFileSync(path.join(path.resolve(__dirname, ".."), "app/globals.css"), "utf8");

/** The picker's own CSS block, from its banner to the next one. */
function pickerBlock(): string {
  const at = css.indexOf("/* ── The When picker");
  if (at === -1) throw new Error("no When picker block in app/globals.css");
  const next = css.indexOf("/* ── ", at + 10);
  return css.slice(at, next === -1 ? css.length : next);
}
