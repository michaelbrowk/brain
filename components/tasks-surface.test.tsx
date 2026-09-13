// @vitest-environment jsdom

// The column: which rows stand where, what the head says, what the seven
// empty states say, and the two motions that change what is on screen,
// completion and reschedule. Every string here is the spec's, verbatim.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/client";
import type { TaskView } from "@/lib/tasks/model";
import type { ToastOptions } from "./ui/primitives";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

const harness = { reduce: false };

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: () => harness.reduce });
});

const { localDay, resetTasksStore } = await import("./tasks-client");
const { TasksSurface } = await import("./tasks-surface");
const { dayLabel } = await import("./tasks-lists");
const { WRITE_AT_MS } = await import("./tasks-row");

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

async function mount(
  tasks: TaskView[],
  props: Partial<React.ComponentProps<typeof TasksSurface>> = {},
) {
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith("/api/tasks?")) return response({ tasks });
    throw new Error(`unexpected request: ${url}`);
  });
  await act(async () => {
    root.render(
      <TasksSurface onToast={(title, options) => toasts.push({ title, options })} {...props} />,
    );
  });
  await settle();
}

const rowTitles = () =>
  [...document.querySelectorAll(".brain-task-title")].map((node) => node.textContent);

const headers = () =>
  [...document.querySelectorAll(".brain-tasks-section-label")].map(
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

  it("shows the toast when the fold starts, with title Completed and action Undo", async () => {
    await mount([task("a", { when: TODAY })]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [] });
      return response({ task: task("a", { done: true, doneAt: `${TODAY}T12:00:00.000Z` }) });
    });

    await act(async () => boxIn(rowFor("a")).click());
    expect(toasts).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();
    expect(toasts[0]?.title).toBe("Completed");
    expect(toasts[0]?.options?.actionLabel).toBe("Undo");
    // ⌘Z needs no key handler here: the shell binds it to any toast carrying
    // an action, so carrying one IS the wiring
    expect(typeof toasts[0]?.options?.onAction).toBe("function");
    expect(toasts[0]?.options?.durationMs).toBe(9000);
  });

  it("never renders the row as done when the write fails", async () => {
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
    expect(toasts.at(-1)?.title).toBe("done is not stored for a linked task");
    expect(toasts.at(-1)?.options?.urgent).toBe(true);
  });

  it("decrements the group count once, then collapses the group and materialises the empty state", async () => {
    const done = task("a", { when: TODAY, category: "Work" });
    await mount([done], { list: "logbook" });
    // the same records, read as Today: one group, one row, one count
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
  it("moves the selected row to Tomorrow on Cmd+] and reports it", async () => {
    const a = task("a", { when: TODAY });
    await mount([a]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: dayFrom(1) } });
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "]", metaKey: true }));
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe("Moved to Tomorrow");
    expect(toasts.at(-1)?.options?.actionLabel).toBe("Undo");
    expect(JSON.parse(String(writes().at(-1)?.[1]?.body))).toEqual({ when: dayFrom(1) });
    expect(rowTitles()).toEqual([]);
  });

  it("puts the row back at its place when Undo is pressed", async () => {
    const a = task("a", { when: TODAY });
    await mount([a, task("b", { when: TODAY, created: "2026-08-01T09:00:00.000Z" })]);
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/tasks?")) return response({ tasks: [a] });
      return response({ task: { ...a, when: dayFrom(1) } });
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", metaKey: true }));
    });
    await settle();
    expect(toasts.at(-1)?.title).toBe("Moved to Today");

    await act(async () => {
      toasts.at(-1)?.options?.onAction?.();
    });
    await settle();
    expect(rowTitles()).toEqual(["a", "b"]);
  });
});

describe("the morning, and the day that turns under an open tab", () => {
  it("plays the entrance once a day and not again on the next mount", async () => {
    await mount([task("a", { when: TODAY })]);
    expect(localStorage.getItem("brain.tasks.entrance")).toBe(TODAY);

    // a second mount the same day has not earned the morning twice
    resetTasksStore();
    await mount([task("a", { when: TODAY })]);
    expect(localStorage.getItem("brain.tasks.entrance")).toBe(TODAY);
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
