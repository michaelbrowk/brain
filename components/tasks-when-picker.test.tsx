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

const open = (over: Partial<WhenPickerOptions> = {}) => {
  const handle = renderWhenPicker({
    value: { when: null, evening: false, time: null },
    today: TODAY,
    mode: "when",
    reduce: false,
    onPick: (value) => picked.push(value),
    onDone: () => {
      closed.push(1);
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
const cell = (element: HTMLElement, day: string) =>
  element.querySelector<HTMLElement>(`[data-day="${day}"]`)!;
const roving = (element: HTMLElement) =>
  element.querySelector("[tabindex='0'][data-day]")?.getAttribute("data-day");
const key = (element: HTMLElement, name: string) =>
  element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
const month = (element: HTMLElement) =>
  element.querySelector(".brain-when-month")?.textContent;

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

  it("hides the evening, Someday and the reminder on a deadline", () => {
    const { element } = open({ mode: "deadline" });
    expect(rows(element)).toEqual([]);
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
    const { element } = open();
    element.querySelector<HTMLElement>("[data-when-evening]")?.click();
    expect(picked.at(-1)).toEqual({ when: TODAY, evening: true, time: null });
    element.querySelector<HTMLElement>("[data-when-today]")?.click();
    expect(picked.at(-1)).toEqual({ when: TODAY, evening: false, time: null });
    element.querySelector<HTMLElement>("[data-when-someday]")?.click();
    expect(picked.at(-1)).toEqual({ when: "someday", evening: false, time: null });
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
    const { element } = open();
    const past = cell(element, "2026-09-01");
    expect(past.hasAttribute("disabled")).toBe(false);
    expect(past.getAttribute("data-past")).toBe("");
  });

  it("keeps a day outside the month pickable and quieter still", () => {
    const { element } = open();
    const outside = cell(element, "2026-10-01");
    expect(outside.hasAttribute("disabled")).toBe(false);
    expect(outside.getAttribute("data-outside")).toBe("");
  });

  it("picks a day on a press", () => {
    const { element } = open();
    cell(element, "2026-09-20").click();
    expect(picked.at(-1)).toEqual({ when: "2026-09-20", evening: false, time: null });
    expect(cell(element, "2026-09-20").getAttribute("aria-selected")).toBe("true");
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
    expect(picked.at(-1)?.when).toBe("2026-09-14");
  });

  it("closes on Escape, and on Done", () => {
    const { element } = open();
    key(element, "Escape");
    expect(closed).toHaveLength(1);
    element.querySelector<HTMLElement>("[data-when-done]")?.click();
    expect(closed).toHaveLength(2);
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
    expect(picked.at(-1)?.time).toBe(DEFAULT_REMINDER_TIME);
    expect(DEFAULT_REMINDER_TIME).toBe("09:00");
  });

  it("steps the hour by one and wraps", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "23:00" } });
    element.querySelector<HTMLElement>("[data-when-hour-up]")?.click();
    expect(picked.at(-1)?.time).toBe("00:00");
    element.querySelector<HTMLElement>("[data-when-hour-down]")?.click();
    expect(picked.at(-1)?.time).toBe("23:00");
  });

  it("steps the minute by five and wraps", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "09:55" } });
    element.querySelector<HTMLElement>("[data-when-minute-up]")?.click();
    expect(picked.at(-1)?.time).toBe("09:00");
    element.querySelector<HTMLElement>("[data-when-minute-down]")?.click();
    expect(picked.at(-1)?.time).toBe("09:55");
  });

  it("steps from the keyboard the same way", () => {
    const { element } = open({ value: { when: TODAY, evening: false, time: "09:00" } });
    const hour = element.querySelector<HTMLElement>("[role='spinbutton'][data-when-hour]")!;
    hour.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(picked.at(-1)?.time).toBe("08:00");
    const minute = element.querySelector<HTMLElement>("[data-when-minute]")!;
    minute.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
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
    expect(picked.at(-1)).toEqual({ when: TODAY, evening: true, time: null });
  });
});

describe("clearing", () => {
  it("takes the evening and the clock with the day", () => {
    const { element } = open({ value: { when: TODAY, evening: true, time: "13:00" } });
    element.querySelector<HTMLElement>("[data-when-clear]")?.click();
    expect(picked.at(-1)).toEqual({ when: null, evening: false, time: null });
  });

  it("turns the evening off when the day stops being today", () => {
    const { element } = open({ value: { when: TODAY, evening: true, time: null } });
    cell(element, "2026-09-20").click();
    expect(picked.at(-1)).toEqual({ when: "2026-09-20", evening: false, time: null });
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
    expect(mounted?.innerHTML).toBe(drawn.element.innerHTML);
    drawn.destroy();
    await act(async () => root.unmount());
    host.remove();
  });
});

const css = readFileSync(path.join(path.resolve(__dirname, ".."), "app/globals.css"), "utf8");

/** The picker's own CSS block, from its banner to the next one. */
function pickerBlock(): string {
  const at = css.indexOf("/* ── The When picker");
  if (at === -1) throw new Error("no When picker block in app/globals.css");
  const next = css.indexOf("/* ── ", at + 10);
  return css.slice(at, next === -1 ? css.length : next);
}
