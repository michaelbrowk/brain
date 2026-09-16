// @vitest-environment jsdom

// The column: which rows stand where, what the head says, what the seven
// empty states say, and the two motions that change what is on screen,
// completion and reschedule. Every string here is the spec's, verbatim.

import { readFileSync } from "node:fs";
import path from "node:path";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/client";
import type { TaskView } from "@/lib/tasks/model";
import type { MotionRender } from "@/test/framer-motion-mock";
import { SMART_UNDO_MS } from "./shell/helpers";
import type { ToastOptions } from "./ui/primitives";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

const harness = { reduce: false };
const renders: MotionRender[] = [];

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: (render) => {
      renders.push(render);
    },
  });
});

const { localDay, resetTasksStore, useTasks } = await import("./tasks-client");
const { TasksSurface } = await import("./tasks-surface");
const { dayLabel, openTodayCount } = await import("./tasks-lists");
const { WRITE_AT_MS } = await import("./tasks-row");
const { emitTaskCommand } = await import("./tasks-commands");
/** The shell's own modal, for the one case that needs a layer this column
 *  never hears about. It is the palette a reader reaches with ⌘K over an open
 *  row, not a stand-in for one. */
const { CommandPalette } = await import("./command-palette");

const apiFetchMock = vi.mocked(apiFetch);

/** The clock is trapped at midday, so the browser's own local day is the same
 *  date in every zone a machine running this might be set to. */
const NOON = new Date("2026-09-13T12:00:00.000Z");
const TODAY = localDay(NOON).today;

function dayFrom(days: number): string {
  const base = Date.UTC(
    Number(TODAY.slice(0, 4)),
    Number(TODAY.slice(5, 7)) - 1,
    Number(TODAY.slice(8, 10)) + days,
  );
  return new Date(base).toISOString().slice(0, 10);
}

function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: id,
    created: "2026-09-01T09:00:00.000Z",
    updated: "2026-09-01T09:00:00.000Z",
    done: false,
    ...over,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

let host: HTMLDivElement;
let root: Root;
const toasts: { title: string; options?: ToastOptions }[] = [];

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Every mount takes a token of its own, because `tasks-client` dedupes on
 *  (day, token): a second mount inside one case would otherwise read the
 *  first one's records and the new fixture would never arrive. */
let token = 0;

/** What the sidebar's Tasks row would show, off the same records the column
 *  draws from. Recorded on every render, so a race would show as two steps. */
const counts: number[] = [];
/** The records the store held at each render, so an OPTIMISTIC step is
 *  readable before the write lands. What is on screen during a fold is the
 *  row's pre-write copy and not this. */
const records: (readonly TaskView[])[] = [];

function CountProbe() {
  const state = useTasks(token);
  counts.push(state.day ? openTodayCount(state.tasks, state.day.today) : -1);
  records.push(state.tasks);
  return null;
}

const storeNow = (): readonly TaskView[] => records.at(-1) ?? [];

async function mount(
  tasks: TaskView[],
  props: Partial<React.ComponentProps<typeof TasksSurface>> = {},
) {
  token += 1;
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/tasks?")) return response({ tasks });
    throw new Error(`unexpected request: ${url}`);
  });
  await act(async () => {
    root.render(
      <>
        <TasksSurface
          onToast={(title, options) => toasts.push({ title, options })}
          refreshToken={token}
          {...props}
        />
        <CountProbe />
      </>,
    );
  });
  await settle();
}

/** A whole new mount of the surface, the way walking to Mail and back is. */
async function remount(
  tasks: TaskView[],
  props: Partial<React.ComponentProps<typeof TasksSurface>> = {},
) {
  await act(async () => root.unmount());
  resetTasksStore();
  host.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await mount(tasks, props);
}

/** The framer props each row MOUNTED with. First render wins: the entrance
 *  flag goes down in a microtask right after it, and framer ignores a later
 *  `initial` anyway, so the last render would say the opposite of what the
 *  row actually played. */
function rowMotion() {
  const seen = new Map<string, MotionRender>();
  for (const render of renders) {
    if (String(render.props.className) !== "brain-task-row-item") continue;
    const id = String(render.props["data-task-id"]);
    if (!seen.has(id)) seen.set(id, render);
  }
  return [...seen.values()];
}

/** React tracks an input's value on the node, so a bare assignment is
 *  swallowed; the prototype setter is the way in. */
function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The stylesheet, for the rules a surface computes for itself and no
 *  fixture draws. */
const css = readFileSync(
  path.join(path.resolve(__dirname, ".."), "app/globals.css"),
  "utf8",
);
const tasksBlock = () => css;

/** Every declaration block whose selector list carries this exact selector.
 *  The waiting pill and the column's own top padding are rules the surface
 *  computes for itself, and jsdom loads no stylesheet. */
const ruleBodies = (selector: string): string[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, list]) => list.split(",").some((one) => one.trim() === selector))
    .map(([, , body]) => body);

const rowTitles = () =>
  [...document.querySelectorAll(".brain-task-title")].map((node) => node.textContent);

/** The whole header, word and size, the way a reader reads it. */
const headers = () =>
  [...document.querySelectorAll(".brain-tasks-section-head")].map(
    (node) => node.textContent,
  );

const rowFor = (title: string): HTMLElement => {
  const node = [...document.querySelectorAll<HTMLElement>(".brain-task-title")].find(
    (candidate) => candidate.textContent === title,
  );
  if (!node) throw new Error(`no row titled ${title}`);
  return node.closest(".brain-task-row-item") as HTMLElement;
};

const boxIn = (row: HTMLElement): HTMLButtonElement =>
  row.querySelector(".brain-task-box") as HTMLButtonElement;

const writes = () =>
  apiFetchMock.mock.calls.filter(([, init]) => init?.method !== undefined);

/** EVERY WAAPI ANIMATION, WITH THE ELEMENT IT WAS STARTED ON.
 *
 *  The fold is the one motion on this surface that is not framer's, and jsdom
 *  has no Web Animations at all, so `foldRow` would otherwise take its own
 *  early exit and a row folding where it should not would look exactly like a
 *  row standing still. It fills FORWARDS in a browser, which is why a fold
 *  started on a row that never unmounts holds it at height 0 until the next
 *  load. `tasks-row.test.tsx` records the same way. */
const animations: { element: Element; frames: Keyframe[] }[] = [];

/** The fold played on one row, if it played at all. */
const foldOf = (row: HTMLElement) =>
  animations.find((entry) => entry.element === row);

/** EVERY INTERSECTION OBSERVER, WITH WHAT IT WATCHES.
 *
 *  jsdom has none, and the real hook hands an engine without one the flag set
 *  (the pill a reader has always had), so a title that stopped being observed
 *  would look exactly like a title that had scrolled away. The stub lets a
 *  case cross the line in both directions. */
const observers: {
  cb: (entries: { isIntersecting: boolean }[]) => void;
  targets: Element[];
}[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  harness.reduce = false;
  toasts.length = 0;
  renders.length = 0;
  counts.length = 0;
  records.length = 0;
  localStorage.clear();
  animations.length = 0;
  observers.length = 0;
  resetTasksStore();
  apiFetchMock.mockReset();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly entry: (typeof observers)[number];
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets.length = 0;
      }
    },
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    writable: true,
    value(frames: Keyframe[]) {
      animations.push({ element: this as Element, frames });
      return { finished: Promise.resolve(), cancel: () => {} };
    },
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(NOON);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "animate");
  resetTasksStore();
});

/** `/tasks?task=<id>`: the seam a link from anywhere else in the app lands on. */
describe("a task named in the URL", () => {
  const scrolled: HTMLElement[] = [];

  beforeEach(() => {
    scrolled.length = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value(this: HTMLElement) {
        scrolled.push(this);
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    window.history.replaceState({}, "", "/tasks");
  });

  it("selects the row, brings it into view and takes the query off the URL", async () => {
    window.history.replaceState({}, "", "/tasks?task=b");
    await mount([task("a", { when: TODAY }), task("b", { when: TODAY })]);

    expect(rowFor("b").querySelector("[data-selected]")).not.toBeNull();
    expect(rowFor("a").querySelector("[data-selected]")).toBeNull();
    expect(scrolled).toContain(rowFor("b"));
    // A `?task=` left in the bar would take the reader back to that row every
    // time they came to Tasks.
    expect(window.location.search).toBe("");
  });

  it("opens the list the task lives in and lands on the row once it is drawn", async () => {
    const onSelectList = vi.fn();
    const rows = [task("now", { when: TODAY }), task("later", { when: dayFrom(4) })];
    window.history.replaceState({}, "", "/tasks?task=later");
    await mount(rows, { onSelectList });

    expect(onSelectList).toHaveBeenCalledWith("upcoming");
    // Nothing has been answered yet, so nothing has been tidied.
    expect(document.querySelector("[data-selected]")).toBeNull();

    // The shell opens it, which is a navigation and may write the bare path.
    window.history.replaceState({}, "", "/tasks");
    await mount(rows, { onSelectList, list: "upcoming" });

    expect(rowFor("later").querySelector("[data-selected]")).not.toBeNull();
    expect(scrolled).toContain(rowFor("later"));
  });

  it("says nothing for an id no record answers to, and takes the query off", async () => {
    window.history.replaceState({}, "", "/tasks?task=gone");
    await mount([task("a", { when: TODAY })]);

    expect(document.querySelector("[data-selected]")).toBeNull();
    expect(scrolled).toHaveLength(0);
    // Quietly: a link to a task somebody has since deleted is not an error to
    // report to whoever followed it. The query goes with the answer all the
    // same, because it HAS been answered: there is no such task. A `?task=`
    // left standing is read again on every dependency change, so an id that
    // becomes resolvable later would select that row and scroll the column
    // long after the reader followed the link.
    expect(toasts).toEqual([]);
    expect(window.location.search).toBe("");
  });
});

/** THE COLUMN GETS THE HEAD A NOTE HAS. The list's name on paper in the
 *  page-title register, the one caption Today has under it, and the band's
 *  pill waiting above for the title to leave — the lone breadcrumb's rule,
 *  on the surface that had no title at all. */
describe("the head of the column", () => {
  const title = (): HTMLButtonElement => {
    const node = document.querySelector<HTMLButtonElement>(".brain-tasks-title");
    if (!node) throw new Error("the column has no title");
    return node;
  };

  const caption = () =>
    document.querySelector(".brain-tasks-title-block .brain-page-meta");

  /** The title crosses the scroller's top edge, in either direction. */
  async function crossLine(inView: boolean) {
    const watched = title();
    const observer = observers.find((entry) => entry.targets.includes(watched));
    if (!observer) throw new Error("the title is not observed");
    await act(async () => observer.cb([{ isIntersecting: inView }]));
  }

  /** Radix opens a dropdown on `pointerdown`, not on a click. */
  async function openMenu(trigger: HTMLElement) {
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    });
  }

  const menuRows = () => [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
  ];

  it("starts the column where a note's own column starts", async () => {
    expect(ruleBodies(".brain-tasks-scrollpad").join("\n")).toContain(
      "padding-top: var(--canvas-top)",
    );
  });

  /** THE COLUMN HAS TO BE THE THING THAT SCROLLS, or the head it floats and
   *  the pill waiting in that head both leave with the rows. `min-height:
   *  100%` never bound it: the wrapper it sits in has an indefinite height, so
   *  the percentage resolved to nothing and the surface grew to its content
   *  inside the shell's scroller. */
  it("binds the column to the window, so its own scroller is the one that moves", () => {
    const surface = ruleBodies(".brain-tasks").join("\n");
    expect(surface).toMatch(/height:\s*100dvh/);
    expect(surface).not.toMatch(/min-height:\s*100%/);
  });

  /** A WHEEL OVER THE PILL HAS TO MOVE THE COLUMN. The head used to be a
   *  sibling of the scroller, so once the column became the thing that
   *  scrolls the chain from the pill ran through four boxes that scroll
   *  nothing and the ~90x36 it covers at the top of the column went dead —
   *  reachable exactly while the reader is scrolling. It stands inside the
   *  scroller now, on the scroll edge's own construction: sticky at the
   *  inset, its height cancelled by its own negative margin, so it floats
   *  where it always did and contributes no box to the flow.
   *
   *  jsdom scrolls nothing, so what a case here can hold is the containment
   *  the browser's own chain follows, and the rule that keeps it floating.
   *  The wheel itself is measured in a browser (`pr5-report.md`). */
  it("stands the head inside the scroller, so a wheel over the pill moves the column", async () => {
    await mount([task("a", { when: TODAY })]);
    const scroller = document.querySelector(".brain-tasks-scroll") as HTMLElement;
    const head = document.querySelector(".brain-tasks-head") as HTMLElement;
    expect(scroller.contains(head)).toBe(true);
    // the top edge and its sentinel still open the scroller: BlurEdge reads
    // its own parentElement for the scroller it observes
    expect(scroller.firstElementChild?.nextElementSibling?.className).toContain("edge");

    const rules = ruleBodies(".brain-tasks-head");
    expect(rules.length).toBeGreaterThan(0);
    const head_css = rules.join("\n");
    expect(head_css).toMatch(/position:\s*sticky/);
    expect(head_css).toMatch(/margin-bottom:\s*calc\(-1 \* var\(--task-chrome\)\)/);
  });

  /** §7's own reserve, the one `.brain-page-scroll` keeps: the band a floating
   *  head covers, plus 16. The column owns a floating head and became its own
   *  scroller in the same branch, so it has to keep the band itself — nothing
   *  the browser scrolls into view may land under the pill. */
  it("reserves the head's own band for anything scrolled into view", () => {
    expect(ruleBodies(".brain-tasks-scroll").join("\n")).toMatch(
      /scroll-padding-top:\s*calc\(var\(--inset\) \+ var\(--task-chrome\) \+ 16px\)/,
    );
  });

  /** §8: reduced motion drops the scale and keeps the fill. The title's press
   *  is the product's `scale(.97)`, and that includes the drop. */
  it("drops the title's press scale under reduced motion", () => {
    const bodies = ruleBodies(".brain-tasks-title:active");
    expect(bodies.length).toBe(2);
    expect(bodies.join("\n")).toMatch(/transform:\s*scale\(0\.97\)/);
    expect(bodies.join("\n")).toMatch(/transform:\s*none/);
  });

  /** `.btn:hover` spells its durations out so the press keeps its 100ms; a
   *  bare `transition-duration` on a multi-property list takes the press with
   *  it. The title's list is two properties, not the button's three. */
  it("keeps the press at 100ms while the hover shortens the fill", () => {
    expect(ruleBodies(".brain-tasks-title:hover").join("\n")).toMatch(
      /transition-duration:\s*80ms,\s*100ms/,
    );
  });

  it("names Today in the page-title register and dates it underneath", async () => {
    await mount([task("a", { when: TODAY })]);
    expect(title().textContent).toContain("Today");
    expect(title().className).toContain("text-title");
    // it stands on open paper with the whole canvas around it, so the ring is
    // the global one at +2; `focus-inset` is for a ring inside a capsule and
    // drew itself through the word's own descenders
    expect(title().className).not.toContain("focus-inset");
    // the pill carries one, so the title carries one: a long category clips
    // in both and only one of them answered a hover
    expect(title().getAttribute("title")).toBe("Today");
    // NOON is 13 September 2026, a Sunday
    expect(caption()?.textContent).toBe("Sunday, 13 September");
    expect(caption()?.className).toContain("text-caption");
  });

  it("writes the caption as the weekday and the full month", async () => {
    vi.setSystemTime(new Date("2025-09-16T12:00:00.000Z"));
    await mount([]);
    expect(caption()?.textContent).toBe("Tuesday, 16 September");
  });

  it("gives every other list its word and no caption line at all", async () => {
    await mount([task("b", { when: dayFrom(3) })], { list: "upcoming" });
    expect(title().textContent).toContain("Upcoming");
    expect(caption()).toBeNull();

    await mount([task("c", { when: "someday" })], { list: "someday" });
    expect(title().textContent).toContain("Someday");
    expect(caption()).toBeNull();
  });

  it("titles a category view by the word, and an empty category No category", async () => {
    await mount([task("call mum", { category: "Family" })], {
      list: { category: "Family" },
    });
    expect(title().textContent).toContain("Family");
    expect(caption()).toBeNull();

    await mount([task("loose", {})], { list: { category: "" } });
    expect(title().textContent).toContain("No category");
  });

  it("opens the list menu from the title and reports the row that was picked", async () => {
    const onSelectList = vi.fn();
    await mount([task("a", { when: TODAY }), task("b", { category: "Family" })], {
      onSelectList,
    });
    await openMenu(title());
    const rows = menuRows();
    expect(rows.map((row) => row.textContent?.trim())).toContain("Upcoming");

    const upcoming = rows.find((row) => row.textContent?.trim() === "Upcoming");
    await act(async () => upcoming?.click());
    expect(onSelectList).toHaveBeenLastCalledWith("upcoming");
  });

  it("keeps the band's pill waiting until the title has left the scroller", async () => {
    await mount([task("a", { when: TODAY })]);
    const surface = document.querySelector(".brain-tasks") as HTMLElement;
    expect(surface.hasAttribute("data-title-out")).toBe(false);

    await crossLine(false);
    expect(surface.hasAttribute("data-title-out")).toBe(true);

    await crossLine(true);
    expect(surface.hasAttribute("data-title-out")).toBe(false);
  });

  it("hides the waiting pill the way the lone breadcrumb is hidden", async () => {
    // one rule, shared by selector, so the two cannot drift apart
    const rest = ruleBodies(".brain-tasks-head > .toolbar-pill").join("\n");
    expect(rest).toMatch(/visibility:\s*hidden/);
    const out = ruleBodies(
      ".brain-tasks[data-title-out] .brain-tasks-head > .toolbar-pill",
    ).join("\n");
    expect(out).toMatch(/visibility:\s*visible/);
  });

  it("puts the ghost row after the title, so Tab reaches the switcher first", async () => {
    await mount([task("a", { when: TODAY })]);
    const pad = document.querySelector(".brain-tasks-scrollpad") as HTMLElement;
    const ghost = pad.querySelector('input[aria-label="New task"]') as HTMLElement;
    expect(
      title().compareDocumentPosition(ghost) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("the lists", () => {
  it("renders the ghost row first, above every task, in every list", async () => {
    await mount([task("a", { when: TODAY }), task("b", { when: TODAY })]);
    const rows = [...document.querySelectorAll("li")];
    expect(rows.length).toBeGreaterThan(2);
    expect(rows[0]?.querySelector("input")?.getAttribute("aria-label")).toBe("New task");
    expect(rows[0]?.querySelector("input")?.getAttribute("placeholder")).toBe("New task…");

    await mount([task("c", { when: "someday" })], { list: "someday" });
    expect(
      [...document.querySelectorAll("li")][0]?.querySelector("input")?.getAttribute(
        "aria-label",
      ),
    ).toBe("New task");
  });

  /** I11. THE LOUDEST TEXT IN THE COLUMN BELONGED TO THE ROW WITH NO TASK IN
   *  IT. The ghost row drew its When chip as a full glass pill with ink 600
   *  text before anything had been typed, while every written row's chips stay
   *  hidden until the row is opened. At rest it is the glyph and the word; the
   *  pill is what a cursor and a keyboard bring. */
  it("draws the capture row's When chip bare until it is hovered or focused", async () => {
    await mount([task("a", { when: TODAY })]);
    const ghost = document.querySelector(".brain-task-row_ghost") as HTMLElement;
    const chip = ghost.querySelector(".chip") as HTMLElement;
    expect(chip.textContent).toBe("When");
    expect(chip.querySelector("svg")).not.toBeNull();

    const sheet = tasksBlock();
    const rest = sheet.slice(sheet.indexOf(".brain-task-row_ghost .chip {"));
    const body = rest.slice(0, rest.indexOf("}"));
    expect(body).toContain("background-color: transparent");
    expect(body).toContain("box-shadow: none");
    expect(body).toContain("color: var(--ink-3)");
    // And the pill is what a cursor or a keyboard brings back, each behind
    // its own gate: §8 guards the hover, and the focus half must not be.
    expect(sheet).toContain(".brain-task-row_ghost .chip:hover {");
    expect(sheet).toContain(".brain-task-row_ghost .chip:focus-visible {");
  });

  it("puts the no-category group first in Today and gives it no header", async () => {
    await mount([
      task("filed", { when: TODAY, category: "Work" }),
      task("bare", { when: TODAY }),
    ]);
    expect(rowTitles()).toEqual(["bare", "filed"]);
    expect(headers()).toEqual(["Work"]);
  });

  /** Spec 2. The moon is the section's own drawing, so This Evening reads as
   *  a part of the day and not as one more category. `lib/tasks/lists.ts`
   *  says a group carries no glyph and the renderer draws this one, which was
   *  a claim about a renderer that drew nothing. */
  it("stands the moon beside the This Evening header and beside no other", async () => {
    await mount([
      task("tonight", { when: TODAY, evening: true }),
      task("filed", { when: TODAY, category: "Work" }),
    ]);
    const heads = [...document.querySelectorAll(".brain-tasks-section-head")];
    const withMoon = heads.filter((head) => head.querySelector("svg") !== null);
    expect(withMoon).toHaveLength(1);
    expect(withMoon[0]?.textContent).toContain("This Evening");
    expect(
      withMoon[0]?.querySelector("svg")?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("groups Upcoming by day, then next week, then one group a date", async () => {
    await mount(
      [
        task("far", { when: dayFrom(40) }),
        task("soon", { when: dayFrom(1) }),
        task("week", { when: dayFrom(10) }),
      ],
      { list: "upcoming" },
    );
    expect(headers()).toEqual(["Tomorrow", "Next week", "23 Oct"]);
    expect(rowTitles()).toEqual(["soon", "week", "far"]);
  });

  it("moves the Logbook header's count when a row leaves it", async () => {
    const x = task("x", { done: true, doneAt: `${TODAY}T09:00:00.000Z` });
    const y = task("y", { done: true, doneAt: `${TODAY}T10:00:00.000Z` });
    await mount([x, y], { list: "logbook" });
    expect(headers()).toEqual(["Today · 2"]);

    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [x, y] });
      return response({ task: { ...y, done: false, doneAt: undefined } });
    });
    await act(async () => boxIn(rowFor("y")).click());
    await settle();
    expect(headers()).toEqual(["Today · 1"]);
  });

  it("groups Logbook by completion day with the count in the header", async () => {
    await mount(
      [
        task("x", { done: true, doneAt: `${TODAY}T09:00:00.000Z` }),
        task("y", { done: true, doneAt: `${TODAY}T10:00:00.000Z` }),
        task("z", { done: true, doneAt: `${dayFrom(-1)}T10:00:00.000Z` }),
      ],
      { list: "logbook" },
    );
    expect(headers()).toEqual(["Today · 2", "Yesterday · 1"]);
  });

  it("shows an overdue when inside its own category with the caption since Tue and no red", async () => {
    // eight days back from a Sunday is the Saturday before; the caption names
    // the weekday of the day the task was meant for, whichever that is
    const late = dayFrom(-5);
    const weekday = new Date(`${late}T00:00:00.000Z`).toUTCString().slice(0, 3);
    await mount([task("late", { when: late, category: "Work" })]);
    expect(headers()).toEqual(["Work"]);
    expect(
      [...document.querySelectorAll(".brain-task-caption")].map((n) => n.textContent),
    ).toEqual([`since ${weekday}`]);
    expect(document.querySelectorAll("[data-overdue]").length).toBe(0);
  });

  it("never puts a category in a tail, because the header above already says it", async () => {
    // Home's Today block is flat and passes `showCategory`; the column groups
    // BY category, so the same word in every tail under the header that names
    // the group is the word said twice.
    await mount([task("call mum", { when: TODAY, category: "Family" })]);

    expect(headers()).toEqual(["Family"]);
    expect(
      [...document.querySelectorAll(".brain-task-caption")].map((n) => n.textContent),
    ).toEqual([]);
  });

  it("shows an overdue deadline as red text and never as a fill", async () => {
    await mount([task("owed", { deadline: dayFrom(-2) })]);
    const caption = document.querySelector("[data-overdue]") as HTMLElement;
    expect(caption.textContent).toBe(dayLabel(dayFrom(-2)));
    // text, not a plate: the mark is on a caption span and nothing else
    expect(caption.className).toContain("brain-task-caption");
    expect(caption.closest(".brain-task-row")?.hasAttribute("data-overdue")).toBe(false);
  });

  it("renders exactly one red element in a section", async () => {
    await mount([
      task("owed", { deadline: dayFrom(-2) }),
      task("ahead", { when: TODAY, deadline: dayFrom(4) }),
      task("plain", { when: TODAY }),
    ]);
    expect(document.querySelectorAll("[data-overdue]").length).toBe(1);
  });

  it("shows the date and not a count in the Today pill tail", async () => {
    await mount([task("a", { when: TODAY }), task("b", { when: TODAY })]);
    const trigger = document.querySelector(".brain-tasks-nav") as HTMLElement;
    expect(trigger.textContent).toContain("Today");
    expect(trigger.textContent).toContain(dayLabel(TODAY));
    expect(trigger.querySelector(".tree-row-count")).toBeNull();
    expect(trigger.textContent).not.toContain("2");
  });
});

describe("the empty states", () => {
  it.each([
    ["today-empty", [] as TaskView[], null, "Nothing planned today", "Add one above"],
    [
      "today-empty-with-upcoming",
      [task("u1", { when: dayFrom(2) }), task("u2", { when: dayFrom(3) }), task("u3", { when: dayFrom(4) })],
      null,
      "Nothing planned today",
      "Upcoming has 3 this week",
    ],
    [
      "today-done",
      [
        task("d1", { done: true, doneAt: `${TODAY}T09:00:00.000Z` }),
        task("d2", { done: true, doneAt: `${TODAY}T09:10:00.000Z` }),
      ],
      null,
      "Done for today",
      "2 completed",
    ],
    ["inbox", [], "inbox", "Inbox is clear", "Checkboxes in notes and MCP land here"],
    ["upcoming", [], "upcoming", "Nothing scheduled", undefined],
    ["someday", [], "someday", "Nothing parked", undefined],
    ["logbook", [], "logbook", "Nothing done yet", "Completed tasks land here, by day"],
  ])(
    "renders the %s empty state",
    async (_name, tasks, list, title, hint) => {
      await mount(tasks as TaskView[], list ? { list: list as "inbox" } : {});
      const empty = document.querySelector(".brain-tasks-empty") as HTMLElement;
      expect(empty.textContent).toContain(title as string);
      if (hint) expect(empty.textContent).toContain(hint as string);
    },
  );
});

describe("completion (motion 2.1)", () => {
  it("sends no request when the completion is cancelled inside the hold", async () => {
    await mount([task("a", { when: TODAY })]);
    const box = boxIn(rowFor("a"));

    await act(async () => box.click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS - 1);
    });
    expect(writes()).toHaveLength(0);

    // a second press on the box inside the window takes it back
    await act(async () => box.click());
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    await settle();
    expect(writes()).toHaveLength(0);
    expect(rowTitles()).toEqual(["a"]);
  });

  it("issues the write at 1300 ms and not at 0, and holds the row still until then", async () => {
    await mount([task("a", { when: TODAY })]);
    const box = boxIn(rowFor("a"));

    await act(async () => box.click());
    expect(writes()).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS - 1);
    });
    expect(writes()).toHaveLength(0);
    // the row has not moved for the whole window
    expect(rowTitles()).toEqual(["a"]);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(writes()).toHaveLength(1);
    expect(String(writes()[0]?.[0])).toBe("/api/tasks/a");
    expect(writes()[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual({ done: true });
  });

  it("reports Completed with the fold and grows its Undo when the write lands", async () => {
    await mount([task("a", { when: TODAY })]);
    let resolveWrite: ((value: Response) => void) | null = null;
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      return new Promise<Response>((resolve) => {
        resolveWrite = resolve;
      });
    });

    await act(async () => boxIn(rowFor("a")).click());
    // Nothing is said inside the window a reader can change their mind in.
    expect(toasts).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();
    // Spec 2.1: when the fold starts, the pill shows. The write is still out,
    // so the sentence is a REPORT of what the reader did and carries no way
    // back: an Undo offered here would send a second PATCH for a completion
    // that has not landed.
    expect(writes()).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe("Completed");
    expect(toasts[0]?.options?.actionLabel).toBeUndefined();
    expect(toasts[0]?.options?.onAction).toBeUndefined();
    // No window either: it stands until the answer replaces it.
    expect(toasts[0]?.options?.durationMs).toBeNull();

    await act(async () => {
      resolveWrite?.(
        response({ task: task("a", { done: true, doneAt: `${TODAY}T12:00:00.000Z` }) }),
      );
      await Promise.resolve();
    });
    await settle();
    // The same sentence again under the same id, now with the way back: a
    // report and its completion are one message, not two owed to the reader.
    expect(toasts).toHaveLength(2);
    expect(toasts[1]?.title).toBe("Completed");
    expect(toasts[1]?.options?.id).toBe(toasts[0]?.options?.id);
    expect(toasts[1]?.options?.actionLabel).toBe("Undo");
    // ⌘Z needs no key handler here: the shell binds it to any toast carrying
    // an action, so carrying one IS the wiring
    expect(typeof toasts[1]?.options?.onAction).toBe("function");
    expect(toasts[1]?.options?.durationMs).toBe(9000);
  });

  it("says one thing and sends nothing more when the write is refused", async () => {
    await mount([task("a", { when: TODAY })]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [task("a", { when: TODAY })] });
      return response({ error: "bad_request", reason: "done is not stored for a linked task" }, 400);
    });

    await act(async () => boxIn(rowFor("a")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(rowTitles()).toEqual(["a"]);
    expect(boxIn(rowFor("a")).getAttribute("aria-checked")).toBe("false");
    // The report went up with the fold and the refusal REPLACES it, under the
    // same id: what is left on screen is the route's own words, with no way
    // back to press for a completion that never happened.
    expect(toasts).toHaveLength(2);
    expect(toasts[0]?.title).toBe("Completed");
    expect(toasts.at(-1)?.title).toBe("done is not stored for a linked task");
    expect(toasts.at(-1)?.options?.urgent).toBe(true);
    expect(toasts.at(-1)?.options?.id).toBe(toasts[0]?.options?.id);
    expect(toasts.at(-1)?.options?.onAction).toBeUndefined();

    // and a refused tick never sends the undo of a completion that never was
    await act(async () => {
      vi.advanceTimersByTime(SMART_UNDO_MS * 2);
    });
    await settle();
    const bodies = writes().map(([, init]) => String(init?.body));
    expect(bodies).toEqual([JSON.stringify({ done: true })]);
    expect(bodies.some((body) => body.includes("false"))).toBe(false);
  });

  /** D3. A COMPLETION IS NOT A LEAVING. The row is struck through and sinks to
   *  the foot of its group, and the group it was in is still there: what the
   *  reader finished this morning is the whole of what the list has to show
   *  for it. Only the count beside the list steps down. */
  it("collapses an expanded row when it is completed", async () => {
    // The box stops the press from reaching the row, `openRow` refuses an
    // inert row and every key on it is dead, so an expansion left open over a
    // completion would sit there with its chips live and no way to shut it.
    const a = task("a", { when: TODAY });
    await mount([a]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, done: true, doneAt: `${TODAY}T12:00:00.000Z` } });
    });

    await act(async () => {
      (rowFor("a").querySelector(".brain-task-title") as HTMLElement).click();
    });
    const capsule = () => rowFor("a").querySelector(".brain-task-row") as HTMLElement;
    expect(capsule().hasAttribute("data-expanded")).toBe(true);
    expect(rowFor("a").querySelectorAll("[data-task-control]").length).toBeGreaterThan(0);

    await act(async () => boxIn(rowFor("a")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(capsule().hasAttribute("data-done")).toBe(true);
    expect(capsule().hasAttribute("data-expanded")).toBe(false);
    expect(rowFor("a").querySelectorAll("[data-task-control]").length).toBe(0);
  });

  it("keeps the completed row in its group and steps the count down", async () => {
    const done = task("a", { when: TODAY, category: "Work" });
    const open = task("b", {
      when: TODAY,
      category: "Work",
      created: "2026-08-01T09:00:00.000Z",
    });
    await mount([done, open]);
    expect(headers()).toEqual(["Work"]);
    expect(rowTitles()).toEqual(["a", "b"]);
    expect(counts.at(-1)).toBe(2);

    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [done, open] });
      return response({ task: { ...done, done: true, doneAt: `${TODAY}T12:00:00.000Z` } });
    });

    await act(async () => boxIn(rowFor("a")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    // The header stands, the row stands, and it has sunk below the open one.
    expect(headers()).toEqual(["Work"]);
    expect(rowTitles()).toEqual(["b", "a"]);
    expect(document.querySelector(".brain-tasks-empty")).toBeNull();
    // and nothing folded it out: a fold fills forwards, so one played here
    // would hold a row that never unmounts at height 0 until the next load
    expect(foldOf(rowFor("a"))).toBeUndefined();
    expect(counts.at(-1)).toBe(1);
  });

  it("decrements the count once at 1300, not once per source", async () => {
    const a = task("a", { when: TODAY });
    const b = task("b", { when: TODAY, created: "2026-08-01T09:00:00.000Z" });
    await mount([a, b]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a, b] });
      return response({ task: { ...a, done: true, doneAt: `${TODAY}T12:00:00.000Z` } });
    });
    expect(counts.at(-1)).toBe(2);

    await act(async () => boxIn(rowFor("a")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS - 1);
    });
    // the hold moves nothing: the number the sidebar shows is untouched
    expect(counts.at(-1)).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await settle();

    // ONE step down, and the route's own answer landing afterwards does not
    // take a second one
    expect(counts.at(-1)).toBe(1);
    // -1 is before the browser's day is known, 0 is the day without its
    // records, 2 is the records, and 1 is the one step the completion takes.
    // A second source decrementing would add a 0 to the end of this.
    const steps = counts.filter((value, index) => value !== counts[index - 1]);
    expect(steps).toEqual([-1, 0, 2, 1]);
  });

  it("moves the keyboard selection to the next row at once on Cmd+Enter", async () => {
    await mount([
      task("first", { when: TODAY, created: "2026-09-05T09:00:00.000Z" }),
      task("second", { when: TODAY, created: "2026-09-04T09:00:00.000Z" }),
    ]);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(rowFor("first").querySelector("[data-selected]")).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    });
    // the capsule is on the next row before the fold has played at all
    expect(rowFor("second").querySelector("[data-selected]")).not.toBeNull();
    expect(writes()).toHaveLength(0);
  });
});

describe("reschedule (motion 2.2)", () => {
  const selectFirst = async () => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
  };

  it("moves the selected row to Tomorrow on Cmd+] and reports it", async () => {
    const a = task("a", { when: TODAY });
    await mount([a]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: dayFrom(1) } });
    });

    await selectFirst();
    const leaving = rowFor("a");
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe("Moved to Tomorrow");
    expect(toasts.at(-1)?.options?.actionLabel).toBe("Undo");
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({ when: dayFrom(1) });
    expect(rowTitles()).toEqual([]);
    // a row that DOES leave folds down on its way out, into its bottom edge
    expect(foldOf(leaving)?.frames.at(-1)?.clipPath).toBe("inset(100% 0 0 0)");
  });

  it("collapses the group header and its rule when the reschedule empties it", async () => {
    // The one write that still empties a group: a completion stays where it
    // was until the day changes, a reschedule leaves at once.
    const a = task("a", { when: TODAY, category: "Work" });
    await mount([a]);
    expect(headers()).toEqual(["Work"]);

    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: dayFrom(1) } });
    });

    await selectFirst();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    await settle();

    // jsdom runs no WAAPI, so the fold resolves at once and the group goes
    expect(headers()).toEqual([]);
    expect(rowTitles()).toEqual([]);
    const empty = document.querySelector(".brain-tasks-empty") as HTMLElement;
    expect(empty.textContent).toContain("Nothing planned today");
  });

  /** A TASK IS IN TODAY FOR FOUR REASONS, and Today pressed on any of them is
   *  a write that moves nothing: the record is drawn in the same list, under
   *  the same header, carrying the day the server answered with. So the row
   *  does not fold, the count beside the list does not dip, and nothing is
   *  reported as a move that did not happen. */
  it.each([
    ["the day it is meant for is today", { when: TODAY }],
    ["that day is past", { when: dayFrom(-1) }],
    ["a deadline has arrived and no day is set", { deadline: TODAY }],
    [
      "a deadline has arrived over a day still ahead",
      { when: dayFrom(7), deadline: TODAY },
    ],
  ])("keeps a task already in Today where it is: %s", async (_reason, over) => {
    const a = task("a", over);
    await mount([a, task("b", { when: TODAY, created: "2026-08-01T09:00:00.000Z" })]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: TODAY } });
    });

    await selectFirst();
    animations.length = 0;
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    });
    await settle();

    // the write is right, and the row is still standing in Today under it
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({ when: TODAY });
    expect(rowTitles()).toEqual(["a", "b"]);
    expect(storeNow().find((entry) => entry.id === "a")?.when).toBe(TODAY);
    // nothing left, so nothing folded: the fold fills forwards, and one
    // played here would hold this row at height 0 until the next load
    expect(foldOf(rowFor("a"))).toBeUndefined();
    // and nothing was said, because nothing moved
    expect(toasts).toEqual([]);
    // the number beside the list never dipped either
    expect(counts.at(-1)).toBe(2);
  });

  // ⌘T is New Tab and ⌘N is New Window: no chord the browser reserves is
  // bound, and `preventDefault` is not a way to take one back.
  it.each([
    ["t", "Moved to Today", TODAY],
    ["s", "Moved to Someday", "someday"],
  ])("moves the focused row on the bare key %s", async (key, title, when) => {
    const a = task("a", { when: dayFrom(3) });
    await mount([a], { list: "upcoming" });
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when } });
    });

    await selectFirst();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: key as string }));
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe(title);
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({ when });
  });

  // Things has a third key, `e` for This evening. Brain's record holds a day
  // or the word `someday` and nothing between, so there is no evening to file
  // a task into and no key that pretends there is.
  it("binds no key for a state the record does not have", async () => {
    const a = task("a", { when: dayFrom(3) });
    await mount([a], { list: "upcoming" });
    await selectFirst();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "e" }));
    });
    await settle();
    expect(writes()).toHaveLength(0);
    expect(toasts).toHaveLength(0);
  });

  it("binds no chord the browser reserves", async () => {
    const a = task("a", { when: dayFrom(3) });
    await mount([a], { list: "upcoming" });
    await selectFirst();
    for (const key of ["t", "n", "w"]) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true }));
        window.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true }));
      });
    }
    await settle();
    expect(writes()).toHaveLength(0);
  });

  it("leaves the bare keys alone while the caret is in a field", async () => {
    const a = task("a", { when: dayFrom(3) });
    await mount([a], { list: "upcoming" });
    await selectFirst();

    const field = document.querySelector("input") as HTMLInputElement;
    field.focus();
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "s", bubbles: true }));
    });
    await settle();
    expect(writes()).toHaveLength(0);
  });

  it("gives the palette the same three moves for the focused row", async () => {
    const a = task("a", { when: dayFrom(3) });
    await mount([a], { list: "upcoming" });
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: "someday" } });
    });

    // with nothing selected the command is a no-op rather than a guess
    await act(async () => emitTaskCommand("move-someday"));
    await settle();
    expect(writes()).toHaveLength(0);

    await selectFirst();
    await act(async () => emitTaskCommand("move-someday"));
    await settle();
    expect(toasts.at(-1)?.title).toBe("Moved to Someday");
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({ when: "someday" });
  });

  it("puts the row back at its place, with the insertion motion", async () => {
    const a = task("a", { when: TODAY });
    await mount([a, task("b", { when: TODAY, created: "2026-08-01T09:00:00.000Z" })]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: dayFrom(1) } });
    });

    await selectFirst();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    await settle();
    expect(toasts.at(-1)?.title).toBe("Moved to Tomorrow");

    renders.length = 0;
    await act(async () => {
      toasts.at(-1)?.options?.onAction?.();
    });
    await settle();
    expect(rowTitles()).toEqual(["a", "b"]);
    // it re-enters, height 0 to its own plus opacity, rather than appearing
    // in one frame
    const restored = rowMotion().find((render) => render.props["data-task-id"] === "a");
    expect(restored?.motion.initial).toEqual({ opacity: 0, height: 0 });
  });
});

describe("the morning, and the day that turns under an open tab", () => {
  it("plays the entrance once a day and not again on the next mount", async () => {
    await mount([task("a", { when: TODAY })]);
    expect(localStorage.getItem("brain.tasks.entrance")).toBe(TODAY);
    // the morning: rows arrive with the y offset and a stagger
    expect(rowMotion()[0]?.motion.initial).toEqual({ opacity: 0, y: 6 });

    renders.length = 0;
    await remount([task("a", { when: TODAY })]);
    // the same day, a second time: the rows are already there
    expect(rowMotion()[0]?.motion.initial).toBe(false);

    // and the next morning it plays again
    renders.length = 0;
    localStorage.setItem("brain.tasks.entrance", "2020-01-01");
    await remount([task("a", { when: TODAY })]);
    expect(rowMotion()[0]?.motion.initial).toEqual({ opacity: 0, y: 6 });
  });

  it("staggers the groups and the rows, to a ceiling of 0.42", async () => {
    await mount([
      task("a", { when: TODAY }),
      task("b", { when: TODAY, category: "Work", created: "2026-08-02T09:00:00.000Z" }),
      task("c", { when: TODAY, category: "Work", created: "2026-08-01T09:00:00.000Z" }),
    ]);
    const delays = rowMotion().map((render) =>
      (render.motion.transition as { delay: number }).delay,
    );
    // group 0 row 0, then group 1 rows 0 and 1: 0, 0.05, 0.08
    expect(delays[0]).toBeCloseTo(0);
    expect(delays[1]).toBeCloseTo(0.05);
    expect(delays[2]).toBeCloseTo(0.08);
    expect(Math.max(...delays)).toBeLessThanOrEqual(0.42);
  });

  it("re-asks for the day at local midnight and does not replay the entrance", async () => {
    await mount([task("a", { when: TODAY })]);
    const reads = () =>
      apiFetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/tasks?"))
        .length;
    const before = reads();

    await act(async () => {
      vi.setSystemTime(new Date(NOON.getTime() + 24 * 60 * 60 * 1000));
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    });
    await settle();

    expect(reads()).toBeGreaterThan(before);
    // the flag is already down for this tab: a date change does not replay it
    expect(localStorage.getItem("brain.tasks.entrance")).toBe(TODAY);
  });
});

describe("reduced motion, on the column", () => {
  beforeEach(() => {
    harness.reduce = true;
  });

  it("drops the y offset and the stagger from the morning entrance", async () => {
    await mount([
      task("a", { when: TODAY }),
      task("b", { when: TODAY, category: "Work" }),
    ]);
    for (const render of rowMotion()) {
      // opacity only: nothing travels and nothing waits its turn
      expect(render.motion.initial).toEqual({ opacity: 0 });
      expect((render.motion.transition as { delay: number }).delay).toBe(0);
    }
    const header = renders.find((render) =>
      String(render.props.className).includes("brain-tasks-section-label"),
    );
    expect(header?.motion.initial).toEqual({ opacity: 0 });
    const rule = renders.find((render) =>
      String(render.props.className).includes("brain-tasks-rule"),
    );
    // the rule does not draw itself in from the left
    expect(rule?.motion.initial).toBe(false);
  });

  it("materialises the Empty state as a crossfade, with no scale", async () => {
    await mount([]);
    const empty = renders.find((render) =>
      String(render.props.className).includes("brain-tasks-empty"),
    );
    expect(empty?.motion.initial).toEqual({ opacity: 0 });
    expect(JSON.stringify(empty?.motion.animate)).not.toContain("scale");
    expect(empty?.motion.transition).toEqual({ duration: 0.12 });
  });
});

describe("where a captured task lands", () => {
  const captureInto = async (
    list: Parameters<typeof mount>[1],
  ): Promise<Record<string, unknown>> => {
    await mount([], list);
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      if (init?.method === "POST") {
        return response({ task: task("new", JSON.parse(String(init.body))) }, 201);
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const field = document.querySelector("input") as HTMLInputElement;
    await act(async () => type(field, "Buy milk"));
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
    return JSON.parse(String(writes().at(-1)?.[1]?.body));
  };

  it("gives a task the day of the list it was typed into", async () => {
    expect(await captureInto({})).toEqual({ title: "Buy milk", when: TODAY });
    // Upcoming is strictly after today, so the first day it can hold is
    // tomorrow; the alternative files the task in the Inbox, where the reader
    // is not looking
    expect(await captureInto({ list: "upcoming" })).toEqual({
      title: "Buy milk",
      when: dayFrom(1),
    });
    expect(await captureInto({ list: "someday" })).toEqual({
      title: "Buy milk",
      when: "someday",
    });
    expect(await captureInto({ list: "inbox" })).toEqual({ title: "Buy milk" });
    expect(await captureInto({ list: { category: "Work" } })).toEqual({
      title: "Buy milk",
      category: "Work",
    });
  });

  it("takes the day the capture row's own chip was given, over the list's", async () => {
    // The chip is an override and nothing more: a line typed into Today with
    // no picking still lands today, which the case above holds.
    await mount([], { list: "upcoming" });
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      if (init?.method === "POST") {
        return response({ task: task("new", JSON.parse(String(init.body))) }, 201);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const field = document.querySelector("input") as HTMLInputElement;
    await act(async () => type(field, "Buy milk"));
    const chip = document.querySelector<HTMLElement>(
      '.brain-task-row_ghost .chip',
    ) as HTMLElement;
    await act(async () => chip.click());
    await settle();
    await act(async () => {
      document.querySelector<HTMLElement>('[data-day="2026-09-20"]')?.click();
    });
    // The grid moves the picker's own value; Done is what sends it back.
    await act(async () => {
      document.querySelector<HTMLElement>("[data-when-done]")?.click();
    });
    await settle();
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();

    // ONE RECORD. Reaching for the chip blurs the field, and a create on that
    // blur filed the title under the list's own day before the reader had
    // finished saying where it goes.
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({
      title: "Buy milk",
      when: "2026-09-20",
    });
  });

  it("offers no ghost row in the Logbook", async () => {
    await mount([task("a", { done: true, doneAt: `${TODAY}T09:00:00.000Z` })], {
      list: "logbook",
    });
    expect(document.querySelector('[aria-label="New task"]')).toBeNull();

    await mount([task("a", { when: TODAY })]);
    expect(document.querySelector('[aria-label="New task"]')).not.toBeNull();
  });
});

/** SPEC 2.4: THREE CASES AND ONLY ONE IS VISIBLE.
 *
 *  A repeating task is never done. Completing it appends a log entry and moves
 *  `when` to the next occurrence, so in Today the row leaves and nothing takes
 *  its place, and in Upcoming the next instance materialises below, in the
 *  future, which is the one screen a person watches it happen on. */
describe("a repeating task", () => {
  const words = (over: Partial<TaskView> = {}) =>
    task("words", { repeat: { freq: "daily" }, when: TODAY, ...over });

  /** The record the route answers a completion with: the log grew and `when`
   *  moved on, and `done` never went true. */
  const advanced = (scheduled: string, next: string) =>
    words({
      when: next,
      log: [{ scheduled, completedAt: `${TODAY}T12:00:00.000Z` }],
    });

  it("sends the reader's own day and moves the day rather than the done", async () => {
    await mount([words()]);
    expect(counts.at(-1)).toBe(1);
    let resolveWrite: ((value: Response) => void) | null = null;
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [words()] });
      return new Promise<Response>((resolve) => {
        resolveWrite = resolve;
      });
    });

    await act(async () => boxIn(rowFor("words")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    // `today` rides along because the next occurrence comes off
    // max(when, today), and the server has no timezone to fall back on.
    expect(String(writes()[0]?.[0])).toBe(`/api/tasks/words?today=${TODAY}`);
    // `expectedWhen` is the instance this tab drew. Completing a repeat is not
    // idempotent, so a second tick of the same one from another tab is
    // refused with a 409 rather than silently skipping a period.
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual({
      done: true,
      expectedWhen: TODAY,
    });
    // MID-FLIGHT, which is the whole point: the count has already decremented
    // at 1300, and the record the browser is holding has moved to tomorrow
    // rather than gone done. A `done: true` here would file the series in the
    // Logbook for as long as the write takes and then pull it back out.
    expect(counts.at(-1)).toBe(0);
    const optimistic = storeNow().find((entry) => entry.id === "words");
    expect(optimistic?.done).toBe(false);
    expect(optimistic?.when).toBe(dayFrom(1));

    await act(async () => {
      resolveWrite?.(response({ task: advanced(TODAY, dayFrom(1)) }));
      await Promise.resolve();
    });
    await settle();
    expect(rowTitles()).toEqual([]);
    expect(toasts[0]?.title).toBe("Completed");
  });

  it("materialises the next occurrence in the following day's group in Upcoming", async () => {
    const early = words({ when: dayFrom(1) });
    await mount([early], { list: "upcoming" });
    expect(headers()).toEqual(["Tomorrow"]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [early] });
      return response({ task: advanced(dayFrom(1), dayFrom(2)) });
    });

    await act(async () => boxIn(rowFor("words")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    // Completed early, so the rule counts from the day it was OWED: the next
    // one is the day after tomorrow, and it draws its own header and rule.
    expect(headers()).toEqual(["Tue 15"]);
    expect(rowTitles()).toEqual(["words"]);
    // And it arrives the way a new row does, height 0 to its own plus
    // opacity, rather than appearing in one frame. The LAST render, because
    // the row it replaces mounted before the write with no entrance at all.
    const arrived = [...renders]
      .reverse()
      .find(
        (render) =>
          String(render.props.className) === "brain-task-row-item" &&
          render.props["data-task-id"] === "words",
      );
    expect(arrived?.motion.initial).toEqual({ opacity: 0, height: 0 });
  });

  it("arrives on opacity alone under reduced motion", async () => {
    harness.reduce = true;
    const early = words({ when: dayFrom(1) });
    await mount([early], { list: "upcoming" });
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [early] });
      return response({ task: advanced(dayFrom(1), dayFrom(2)) });
    });

    await act(async () => boxIn(rowFor("words")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    // Nothing travels and no height animates: the same crossfade 2.1 and 2.3
    // collapse to.
    const arrived = [...renders]
      .reverse()
      .find(
        (render) =>
          String(render.props.className) === "brain-task-row-item" &&
          render.props["data-task-id"] === "words",
      );
    expect(arrived?.motion.initial).toEqual({ opacity: 0 });
    expect(arrived?.motion.animate).toEqual({ opacity: 1 });
  });

  it("leaves the open instance alone when the untick is refused", async () => {
    // The row the Logbook hands back is a PROJECTION of one completion: done,
    // dated to that entry, sitting on the day that instance was owed. The
    // record behind it is open on its next occurrence. Writing the projection
    // back on a refusal would leave a repeating record reading as done, which
    // `listOf` files in the Logbook, and the open instance would be gone from
    // every list until a reload.
    const twice = words({
      when: dayFrom(1),
      log: [{ scheduled: TODAY, completedAt: `${TODAY}T09:00:00.000Z` }],
    });
    await mount([twice], { list: "logbook" });

    let refetched = 0;
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) {
        refetched += 1;
        return response({ tasks: [twice] });
      }
      return response({ error: "this repeating task has no completion to undo" }, 400);
    });

    const [row] = [...document.querySelectorAll<HTMLElement>(".brain-task-row-item")];
    await act(async () => boxIn(row).click());
    await settle();

    // One thing said, in the route's own words.
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toContain("no completion to undo");
    // And the record this tab holds is the SERVER's, re-read: still open,
    // still on its next occurrence, still in Upcoming.
    expect(refetched).toBeGreaterThan(0);
    const record = storeNow().find((entry) => entry.id === "words");
    expect(record?.done).toBe(false);
    expect(record?.when).toBe(dayFrom(1));
  });

  it("draws one Logbook row per completion and unticks only the newest", async () => {
    const twice = words({
      when: dayFrom(1),
      log: [
        { scheduled: dayFrom(-1), completedAt: `${dayFrom(-1)}T09:00:00.000Z` },
        { scheduled: TODAY, completedAt: `${TODAY}T09:00:00.000Z` },
      ],
    });
    await mount([twice], { list: "logbook" });

    expect(headers()).toEqual(["Today · 1", "Yesterday · 1"]);
    expect(rowTitles()).toEqual(["words", "words"]);

    const [newest, older] = [
      ...document.querySelectorAll<HTMLElement>(".brain-task-row-item"),
    ];
    // History: an older completion has nothing left to undo, so its box does
    // not answer. The newest one pops its entry and puts `when` back.
    await act(async () => boxIn(older).click());
    await settle();
    expect(writes()).toHaveLength(0);

    // AND IT DOES NOT ADVERTISE ONE EITHER. A capsule that lights up under the
    // cursor, takes a tab stop and then refuses every gesture is the one shape
    // a control must not have. The mark is drawn, the control is not there.
    const olderRow = older.querySelector<HTMLElement>(".brain-task-row");
    const newestRow = newest.querySelector<HTMLElement>(".brain-task-row");
    expect(olderRow?.hasAttribute("data-historic")).toBe(true);
    expect(newestRow?.hasAttribute("data-historic")).toBe(false);
    const olderBox = older.querySelector<HTMLElement>(".brain-task-box");
    expect(olderBox?.tagName).toBe("SPAN");
    expect(olderBox?.className).toContain("brain-task-box_static");
    expect(olderBox?.getAttribute("aria-disabled")).toBe("true");
    expect(olderBox?.getAttribute("aria-checked")).toBe("true");
    expect(olderBox?.hasAttribute("tabindex")).toBe(false);
    expect(newest.querySelector(".brain-task-box")?.tagName).toBe("BUTTON");
    // And a press on it selects nothing, so the refusal is not one gesture
    // away either.
    await act(async () => olderRow?.click());
    await settle();
    expect(olderRow?.hasAttribute("data-selected")).toBe(false);

    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [twice] });
      return response({ task: words({ when: TODAY, log: twice.log?.slice(0, 1) }) });
    });
    await act(async () => boxIn(newest).click());
    await settle();
    expect(writes()).toHaveLength(1);
    expect(String(writes()[0]?.[0])).toBe("/api/tasks/words");
    // `expectedWhen` is the LIVE record's day, not this row's: the row is one
    // completion's projection and carries the day that instance was owed. A
    // second press is refused against it rather than popping a second entry.
    expect(JSON.parse(String(writes()[0]?.[1]?.body))).toEqual({
      done: false,
      expectedWhen: dayFrom(1),
    });
  });

  it("steps the keyboard selection over a history row", async () => {
    const twice = words({
      when: dayFrom(1),
      log: [
        { scheduled: dayFrom(-1), completedAt: `${dayFrom(-1)}T09:00:00.000Z` },
        { scheduled: TODAY, completedAt: `${TODAY}T09:00:00.000Z` },
      ],
    });
    await mount([twice], { list: "logbook" });
    const [newest, older] = [
      ...document.querySelectorAll<HTMLElement>(".brain-task-row-item"),
    ];

    // Two steps down: the first lands on the newest completion, the second
    // has nowhere to go, because the older row answers no key and must not
    // take the capsule either.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(newest.querySelector("[data-selected]")).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    expect(newest.querySelector("[data-selected]")).not.toBeNull();
    expect(older.querySelector("[data-selected]")).toBeNull();
  });
});

/** ESCAPE PEELS ONE LAYER AT A TIME.
 *
 *  One Escape with the calendar up closed the calendar AND folded the row
 *  under it: the picker answered on its own element, the column's listener
 *  answered on the window, and the reader who asked for the panel to go lost
 *  the row they were working in. A press outside has never spent two
 *  dismissals at once — the panel takes the press and the row is the next one
 *  — and the key is the same sentence.
 *
 *  So Escape #1 closes the layer and leaves the row standing with the focus
 *  back on the chip that opened it, and Escape #2 folds the row. Things
 *  behaves this way.
 *
 *  THE ORDERING IS THE WHOLE OF IT. Radix dismisses its layers from a
 *  `keydown` listener on the DOCUMENT in the capture phase, so by any listener
 *  further along the path the layer is already gone and the column would fold
 *  on the key that closed it. The column's own listener is on the WINDOW in
 *  capture, which is the first stop on the path a key takes, and it reads the
 *  row's signal while the layer is still standing to be read. */
describe("Escape peels one layer at a time", () => {
  const capsuleOf = (title: string) =>
    rowFor(title).querySelector(".brain-task-row") as HTMLElement;

  const expand = async (title: string) => {
    await act(async () => {
      (rowFor(title).querySelector(".brain-task-title") as HTMLElement).click();
    });
  };

  const chipOn = (title: string, named: string): HTMLElement => {
    const chip = [...rowFor(title).querySelectorAll<HTMLElement>(".chip")].find((node) =>
      (node.getAttribute("aria-label") ?? node.textContent ?? "").startsWith(named),
    );
    if (!chip) throw new Error(`no ${named} chip on the expanded row`);
    return chip;
  };

  /** A REAL PRESS FOCUSES THE BUTTON IT LANDS ON and jsdom's `click()` does
   *  not. Radix remembers what held the focus as the layer opened and hands it
   *  back there, so a chip that was never focused would hand it to the body
   *  and the assertion would be about jsdom rather than about the row.
   *
   *  And it is a WHOLE press: down, up, click. A popover opens on the click
   *  and a dropdown menu on the `pointerdown`, so half a press opens one of the
   *  two — and the fold on a press outside is decided on the way down and spent
   *  on the lift, so half a press would never ask the question a chip in
   *  another row has to answer. */
  const press = (node: HTMLElement, type: string) => {
    const event = new MouseEvent(type, { bubbles: true, button: 0 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    node.dispatchEvent(event);
  };

  const openLayer = async (chip: HTMLElement) => {
    await act(async () => {
      chip.focus();
      press(chip, "pointerdown");
      press(chip, "pointerup");
      chip.click();
    });
    await settle();
  };

  /** THE PALETTE, IN ITS OWN ROOT, the way the shell draws it: a sibling of
   *  the column rather than something inside it. Radix owns its Escape, so
   *  `open` is state here and the dialog answers the key on its own. */
  let paletteHost: HTMLDivElement | null = null;
  let paletteRoot: Root | null = null;

  const paletteNode = () =>
    document.body.querySelector<HTMLElement>('[data-testid="desktop-command-palette"]');

  function Palette() {
    const [open, setOpen] = useState(true);
    return (
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        tree={[]}
        onSelect={() => {}}
        hasCurrent={false}
        onNewPage={() => {}}
      />
    );
  }

  const openPalette = async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value() {},
    });
    paletteHost = document.createElement("div");
    document.body.appendChild(paletteHost);
    paletteRoot = createRoot(paletteHost);
    await act(async () => paletteRoot?.render(<Palette />));
    await settle();
  };

  afterEach(async () => {
    if (paletteRoot) await act(async () => paletteRoot?.unmount());
    paletteHost?.remove();
    paletteRoot = null;
    paletteHost = null;
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  /** The key, from wherever the reader's focus actually is. */
  const escape = async () => {
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    // Radix hands the focus back to the trigger in a macrotask.
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
  };

  it("closes the When picker and leaves the row standing, and folds on the next key", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    const when = chipOn("a", "When:");
    await openLayer(when);
    expect(document.querySelector(".brain-when-picker")).not.toBeNull();

    await escape();

    expect(document.querySelector(".brain-when-picker")).toBeNull();
    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(true);
    expect(document.activeElement).toBe(when);
    // ESCAPE THROWS THE VALUE AWAY, which is the picker's own rule and is not
    // touched here: nothing was picked, so nothing was written either.
    expect(writes()).toHaveLength(0);

    await escape();

    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(false);
    expect(document.activeElement).toBe(capsuleOf("a"));
    expect(writes()).toHaveLength(0);
  });

  it("does the same for the category picker", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    const category = chipOn("a", "+ Category");
    await openLayer(category);
    expect(document.querySelector('input[aria-label="Category name"]')).not.toBeNull();

    await escape();

    expect(document.querySelector('input[aria-label="Category name"]')).toBeNull();
    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(true);
    expect(document.activeElement).toBe(category);

    await escape();

    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(false);
  });

  it("does the same for the repeat menu", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    const repeat = chipOn("a", "Repeat");
    await openLayer(repeat);
    expect(document.querySelector("[role='menuitemradio']")).not.toBeNull();

    await escape();

    expect(document.querySelector("[role='menuitemradio']")).toBeNull();
    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(true);
    expect(document.activeElement).toBe(repeat);

    await escape();

    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(false);
  });

  /** THE TITLE EDITOR IS A LAYER TOO, and the one no flag in the DOM answers
   *  for: it is an `input` the row swapped its own words for, with no Radix
   *  `data-state` on anything. The row says so itself, which is why the signal
   *  the column reads is the row's own and not a query for an open panel. */
  it("does the same for the title editor", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    // Held, because the words are what `rowFor` reads the row back by and the
    // caret takes them out of the document.
    const item = rowFor("a");
    const capsule = item.querySelector(".brain-task-row") as HTMLElement;
    // The caret goes in on a SECOND press of the words, not on the expansion.
    await act(async () => {
      (item.querySelector(".brain-task-title") as HTMLElement).click();
    });
    expect(item.querySelector(".brain-task-input")).not.toBeNull();

    await escape();

    expect(item.querySelector(".brain-task-input")).toBeNull();
    expect(capsule.hasAttribute("data-expanded")).toBe(true);
    expect(document.activeElement).toBe(capsule);

    await escape();

    expect(capsule.hasAttribute("data-expanded")).toBe(false);
  });

  it("folds a row that has no layer open, the way it always did", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(true);

    await escape();

    expect(capsuleOf("a").hasAttribute("data-expanded")).toBe(false);
    expect(document.activeElement).toBe(capsuleOf("a"));
  });

  /* A PRESS THAT ALREADY ANSWERED IS NOT UNDONE BY THE KEY THAT FOLLOWS IT is
     the picker's own rule, and it is pinned where the picker is:
     `tasks-when-picker.test.tsx:690`, which holds the panel open for its exit
     and presses the key inside that window. A case here could not: by the time
     this surface can deliver the key, the quick row's write has folded the row
     and taken the panel with it, so the key lands on nothing and the write
     count is one for reasons that have nothing to do with the rule. It was
     written, measured, and taken out rather than left standing as a case that
     cannot go red. */

  /** THE CAPTURE ROW'S PICKER IS A LAYER TOO, and it is the one layer that does
   *  not belong to the row it stands over: the reader writing a line at the top
   *  of the column reaches for its When chip with a task row open below, and
   *  the key that closes that panel was spending the row as well. One dismissal
   *  per key, wherever on this surface the panel was opened from. */
  it("closes the capture row's picker and leaves an expanded row standing", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    const capsule = capsuleOf("a");
    const ghost = document.querySelector<HTMLElement>(
      ".brain-task-row_ghost .chip",
    ) as HTMLElement;
    await openLayer(ghost);
    expect(document.querySelector(".brain-when-picker")).not.toBeNull();
    // THE PRESS THAT OPENED IT BELONGS TO THAT PANEL, which is the rule the
    // row's own fold-on-outside already keeps: one dismissal per press, and
    // this press spent its one opening the picker.
    expect(capsule.hasAttribute("data-expanded")).toBe(true);

    await escape();

    expect(document.querySelector(".brain-when-picker")).toBeNull();
    expect(capsule.hasAttribute("data-expanded")).toBe(true);
    expect(document.activeElement).toBe(ghost);

    await escape();

    expect(capsule.hasAttribute("data-expanded")).toBe(false);
  });

  /** A LAYER NOBODY REGISTERED IS STILL A LAYER.
   *
   *  The register holds what this column draws: its rows' panels and the
   *  capture row's. ⌘K over an open row draws a layer the column never hears
   *  about, and the key that dismisses it was folding the row underneath —
   *  the same double dismissal this block exists to remove, one level up. So
   *  the column reads the document as well, in the capture phase, where the
   *  panel is still there to be seen. */
  it("leaves the row standing for a layer nobody registered", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    const capsule = capsuleOf("a");
    await openPalette();
    expect(paletteNode()).not.toBeNull();

    await escape();

    expect(paletteNode()).toBeNull();
    expect(capsule.hasAttribute("data-expanded")).toBe(true);

    await escape();

    expect(capsule.hasAttribute("data-expanded")).toBe(false);
  });

  /** AND THE COLUMN HAS TO BE FIRST ON THE PATH TO SEE IT.
   *
   *  A panel that is not React's takes itself out of the document inside the
   *  keydown that dismissed it — the shape the note's own promote popover has
   *  (`components/editor/task-checkbox.ts`), and the shape Radix decides in,
   *  from a `keydown` listener on the DOCUMENT in capture. A column that read
   *  the document any later than the window's own capture phase would find
   *  the panel already gone and fold the row on the key that closed it. This
   *  is the case that goes red if the `true` comes off that listener. */
  it("reads the document before the layer's own listener can empty it", async () => {
    await mount([task("a", { when: TODAY })]);
    await expand("a");
    const capsule = capsuleOf("a");

    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.dataset.state = "open";
    document.body.append(panel);
    const dismiss = (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") panel.remove();
    };
    document.addEventListener("keydown", dismiss, true);

    try {
      await escape();

      expect(panel.isConnected).toBe(false);
      expect(capsule.hasAttribute("data-expanded")).toBe(true);
    } finally {
      document.removeEventListener("keydown", dismiss, true);
      panel.remove();
    }

    await escape();

    expect(capsule.hasAttribute("data-expanded")).toBe(false);
  });
});
