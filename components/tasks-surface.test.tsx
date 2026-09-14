// @vitest-environment jsdom

// The column: which rows stand where, what the head says, what the seven
// empty states say, and the two motions that change what is on screen,
// completion and reschedule. Every string here is the spec's, verbatim.

import { act } from "react";
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
  resetTasksStore();
  apiFetchMock.mockReset();
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
  resetTasksStore();
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

  it("puts the no-category group first in Today and gives it no header", async () => {
    await mount([
      task("filed", { when: TODAY, category: "Work" }),
      task("bare", { when: TODAY }),
    ]);
    expect(rowTitles()).toEqual(["bare", "filed"]);
    expect(headers()).toEqual(["Work"]);
  });

  it("groups Upcoming by day with Tomorrow first and Later last", async () => {
    await mount(
      [
        task("far", { when: dayFrom(40) }),
        task("soon", { when: dayFrom(1) }),
        task("week", { when: dayFrom(10) }),
      ],
      { list: "upcoming" },
    );
    expect(headers()).toEqual(["Tomorrow", "Next week", "Later"]);
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
      "2 completed · Logbook",
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

  it("reports Completed only once the write has landed, with action Undo", async () => {
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
    expect(toasts).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();
    // the write is out and the row has moved, and the sentence has not been
    // said yet: a report issued before the answer can be wrong
    expect(writes()).toHaveLength(1);
    expect(toasts).toHaveLength(0);

    await act(async () => {
      resolveWrite?.(
        response({ task: task("a", { done: true, doneAt: `${TODAY}T12:00:00.000Z` }) }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(toasts[0]?.title).toBe("Completed");
    expect(toasts[0]?.options?.actionLabel).toBe("Undo");
    // ⌘Z needs no key handler here: the shell binds it to any toast carrying
    // an action, so carrying one IS the wiring
    expect(typeof toasts[0]?.options?.onAction).toBe("function");
    expect(toasts[0]?.options?.durationMs).toBe(9000);
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
    // ONE pill, in the route's own words, and no "Completed" claiming the
    // opposite of what happened
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe("done is not stored for a linked task");
    expect(toasts[0]?.options?.urgent).toBe(true);
    expect(toasts.some((entry) => entry.title === "Completed")).toBe(false);
    expect(toasts[0]?.options?.onAction).toBeUndefined();

    // and a refused tick never sends the undo of a completion that never was
    await act(async () => {
      vi.advanceTimersByTime(SMART_UNDO_MS * 2);
    });
    await settle();
    const bodies = writes().map(([, init]) => String(init?.body));
    expect(bodies).toEqual([JSON.stringify({ done: true })]);
    expect(bodies.some((body) => body.includes("false"))).toBe(false);
  });

  it("collapses the group and materialises the Done for today empty state", async () => {
    const done = task("a", { when: TODAY, category: "Work" });
    await mount([done]);
    expect(headers()).toEqual(["Work"]);

    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [done] });
      return response({ task: { ...done, done: true, doneAt: `${TODAY}T12:00:00.000Z` } });
    });

    await act(async () => boxIn(rowFor("a")).click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    // jsdom runs no WAAPI, so the fold resolves at once and the group goes
    expect(headers()).toEqual([]);
    expect(rowTitles()).toEqual([]);
    const empty = document.querySelector(".brain-tasks-empty") as HTMLElement;
    expect(empty.textContent).toContain("Done for today");
    expect(empty.textContent).toContain("1 completed · Logbook");
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
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe("Moved to Tomorrow");
    expect(toasts.at(-1)?.options?.actionLabel).toBe("Undo");
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({ when: dayFrom(1) });
    expect(rowTitles()).toEqual([]);
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
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
    });
    await settle();
    expect(toasts.at(-1)?.title).toBe("Moved to Today");

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
});
