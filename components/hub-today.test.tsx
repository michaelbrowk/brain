// @vitest-environment jsdom

// THE TODAY BLOCK ON HOME. Five rows at most, flat, in the section's own
// order, and a completion that runs the column's cycle without leaving the
// page. Every string here is the spec's, verbatim, including the one that
// deliberately differs from the column's (`Add one in Tasks`, not `Add one
// above`), which is the case a shared constant would quietly break.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "@/lib/client";
import { sectionsFor } from "./tasks-lists";
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

const { localDay, mutateTasks, resetTasksStore } = await import("./tasks-client");
const { HubToday } = await import("./hub-today");
const { WRITE_AT_MS } = await import("./tasks-row");

const apiFetchMock = vi.mocked(apiFetch);

/** Midday, so the browser's local day is this date in every zone. */
const NOON = new Date("2026-09-13T12:00:00.000Z");
const TODAY = localDay(NOON).today;

function dayFrom(days: number): string {
  return new Date(
    Date.UTC(
      Number(TODAY.slice(0, 4)),
      Number(TODAY.slice(5, 7)) - 1,
      Number(TODAY.slice(8, 10)) + days,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

/** `created` descends with the index, which is the order Today sorts on. */
function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: id,
    created: "2026-09-01T09:00:00.000Z",
    updated: "2026-09-01T09:00:00.000Z",
    done: false,
    when: TODAY,
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
const opened: string[] = [];
let token = 0;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(
  tasks: TaskView[],
  extra: (url: string) => Response | null = () => null,
  props: { notebookEmpty?: boolean } = {},
) {
  token += 1;
  apiFetchMock.mockImplementation(async (input) => {
    const url = String(input);
    const answered = extra(url);
    if (answered) return answered;
    if (url.startsWith("/api/tasks?")) return response({ tasks });
    throw new Error(`unexpected request: ${url}`);
  });
  await act(async () => {
    root.render(
      <HubToday
        refreshToken={token}
        onOpenTasks={() => opened.push("tasks")}
        onToast={(title, options) => toasts.push({ title, options })}
        pageTitleOf={(pageId) => (pageId === "page-1" ? "Trip ideas" : undefined)}
        {...props}
      />,
    );
  });
  await settle();
}

function titles(): string[] {
  return [...host.querySelectorAll(".brain-task-title")].map(
    (row) => row.textContent ?? "",
  );
}

function header(): string {
  return host.querySelector("[data-hub-today-open]")?.textContent ?? "";
}

function boxes(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".brain-task-box")];
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: NOON, toFake: ["Date", "setTimeout", "clearTimeout"] });
  harness.reduce = false;
  toasts.length = 0;
  opened.length = 0;
  resetTasksStore();
  apiFetchMock.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetTasksStore();
  vi.useRealTimers();
});

describe("the Today block on Home", () => {
  it("shows at most five open tasks, flat and ungrouped, in Today order", async () => {
    const tasks = [
      task("one"),
      task("two", { category: "Work" }),
      task("three"),
      task("four", { category: "Home" }),
      task("five"),
      task("six"),
      task("seven"),
    ];
    await mount(tasks);

    // THE SECTION'S OWN DERIVE, FLATTENED. Not a second sort: the block and
    // the column would otherwise disagree about which five matter today.
    const expected = sectionsFor(tasks, { kind: "list", list: "today" }, TODAY, 0)
      .flatMap((section) => section.rows.map((row) => row.task.title))
      .slice(0, 5);
    expect(titles()).toEqual(expected);
    expect(titles()).toHaveLength(5);
    // Flat: no group heading travelled with them.
    expect(host.querySelector(".brain-tasks-section-label")).toBeNull();
  });

  /** I12. THREE NUMBERS AND NONE OF THEM WAS THE NUMBER OF ROWS.
   *
   *  The header counted what is open over the whole day, the block painted
   *  five open plus three struck, and the link printed everything the day
   *  holds: "Today · 6", eight rows, "All today (10)". Each was defensible on
   *  its own and together they read as a contradiction with nothing to say
   *  which was which. The header keeps the open count, because that is the
   *  one number a reader is asking for; the link stops carrying a second. */
  it("collapses row six and beyond into a link that carries no number", async () => {
    await mount([
      task("one"),
      task("two"),
      task("three"),
      task("four"),
      task("five"),
      task("six"),
      task("seven"),
    ]);

    const more = host.querySelector<HTMLButtonElement>("[data-hub-today-all]");
    expect(more?.textContent).toBe("All today");

    await act(async () => more?.click());
    expect(opened).toEqual(["tasks"]);
  });

  /** THE FIVE SLOTS ARE FIVE OPEN ROWS. A completion stays in its list for the
   *  day, and a block whose window was shared with the day's work would show a
   *  reader who finished five things five struck-through rows with everything
   *  still owed folded into "All today". */
  it("fills the five from what is still open, and puts the day's work under it", async () => {
    // Ids, because every fixture here shares one `created` and the derive's
    // last key is the id: a1 to a6 open, z1 and z2 finished this morning.
    await mount([
      task("z1", { done: true, doneAt: `${TODAY}T08:00:00.000Z` }),
      task("z2", { done: true, doneAt: `${TODAY}T09:00:00.000Z` }),
      task("a1"),
      task("a2"),
      task("a3"),
      task("a4"),
      task("a5"),
      task("a6"),
    ]);

    expect(titles()).toEqual(["a1", "a2", "a3", "a4", "a5", "z1", "z2"]);
    // The count is what is owed, and the overflow names what is not drawn.
    // THE HEADER IS THE OPEN COUNT and the link is a way through, not a
    // second tally: six still owed, five of them drawn, the day's two
    // completions under them.
    expect(header()).toBe("Today · 6");
    expect(host.querySelector("[data-hub-today-all]")?.textContent).toBe("All today");
  });

  it("takes at most three of the day's completions, because the rest is a logbook", async () => {
    await mount([
      task("d1", { done: true, doneAt: `${TODAY}T05:00:00.000Z` }),
      task("d2", { done: true, doneAt: `${TODAY}T06:00:00.000Z` }),
      task("d3", { done: true, doneAt: `${TODAY}T07:00:00.000Z` }),
      task("d4", { done: true, doneAt: `${TODAY}T08:00:00.000Z` }),
      task("one"),
    ]);

    expect(titles()).toEqual(["one", "d1", "d2", "d3"]);
    expect(host.querySelector("[data-hub-today-all]")?.textContent).toBe("All today");
  });

  it("draws no overflow row while everything today fits", async () => {
    await mount([task("one"), task("two")]);
    expect(host.querySelector("[data-hub-today-all]")).toBeNull();
  });

  it("renders the header as 'Today · 4' with a tabular count", async () => {
    await mount([task("one"), task("two"), task("three"), task("four")]);

    expect(header()).toBe("Today · 4");
    const count = host.querySelector<HTMLElement>("[data-hub-count]");
    expect(count?.className).toContain("tabular-nums");
    expect(count?.className).toContain("text-ink-3");

    await act(async () => host.querySelector<HTMLButtonElement>("[data-hub-today-open]")?.click());
    expect(opened).toEqual(["tasks"]);
  });

  it("displaces the tail with an overdue deadline as red text", async () => {
    await mount([task("owed", { deadline: dayFrom(-1) })]);

    const caption = host.querySelector<HTMLElement>(".brain-task-caption");
    expect(caption?.hasAttribute("data-overdue")).toBe(true);
  });

  it("completes a task in place through the full 2.1 cycle and shortens the block", async () => {
    const patches: { url: string; body: unknown }[] = [];
    await mount([task("one"), task("two")], (url) => {
      if (!url.startsWith("/api/tasks/")) return null;
      patches.push({ url, body: null });
      return response({
        task: { ...task("one"), done: true, doneAt: NOON.toISOString() },
      });
    });
    expect(header()).toBe("Today · 2");

    // The press ticks the box at once; nothing is sent for 1300ms.
    await act(async () => boxes()[0]?.click());
    expect(patches).toHaveLength(0);
    expect(boxes()[0]?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(patches).toHaveLength(1);
    // The report follows the 2xx, never the press.
    expect(toasts.at(-1)?.title).toBe("Completed");
    expect(toasts.at(-1)?.options?.actionLabel).toBe("Undo");
    expect(header()).toBe("Today · 1");
  });

  it("reverts and says the route's reason when the completion is refused", async () => {
    await mount([task("one")], (url) =>
      url.startsWith("/api/tasks/")
        ? response({ error: "locked", reason: "The notebook is busy" }, 409)
        : null,
    );

    await act(async () => boxes()[0]?.click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe("The notebook is busy");
    expect(toasts.at(-1)?.options?.urgent).toBe(true);
    expect(header()).toBe("Today · 1");
    expect(titles()).toEqual(["one"]);
  });

  it("turns the block into 'Done for today' on the last completion", async () => {
    await mount(
      [task("one", { done: true, doneAt: NOON.toISOString(), when: undefined })],
    );

    expect(host.textContent).toContain("Done for today");
    // The count alone. "· Logbook" read as a link to the Logbook and was
    // plain text with nothing behind it.
    expect(host.textContent).toContain("1 completed");
    expect(host.textContent).not.toContain("Logbook");
  });

  it("renders 'Nothing planned today' with 'Add one in Tasks', not 'Add one above'", async () => {
    // The column's hint points at its own capture row, which Home does not
    // have. One shared constant here would send a reader on Home looking for
    // a field that is not on the screen.
    await mount([]);

    expect(host.textContent).toContain("Nothing planned today");
    expect(host.textContent).toContain("Add one in Tasks");
    expect(host.textContent).not.toContain("Add one above");
  });

  it("points at Upcoming instead when the week has something in it", async () => {
    await mount([task("later", { when: dayFrom(2) }), task("soon", { when: dayFrom(5) })]);

    expect(host.textContent).toContain("Nothing planned today");
    expect(host.textContent).toContain("Upcoming has 2 this week");
    expect(host.textContent).not.toContain("Add one in Tasks");
  });

  it("puts the category in the tail as a word", async () => {
    // Home does not group, so the word is the only thing on this block that
    // says which part of a life a task belongs to. The column groups BY
    // category and passes nothing, which the surface's own suite holds.
    await mount([task("call mum", { category: "Family" })]);

    const captions = [...host.querySelectorAll(".brain-task-caption")].map(
      (node) => node.textContent,
    );
    expect(captions).toEqual(["Family"]);
  });

  it("lets an overdue deadline displace the category as red text", async () => {
    await mount([
      task("owed", { category: "Family", deadline: dayFrom(-1) }),
    ]);

    const captions = [...host.querySelectorAll<HTMLElement>(".brain-task-caption")];
    expect(captions).toHaveLength(1);
    expect(captions[0]?.textContent).not.toBe("Family");
    expect(captions[0]?.hasAttribute("data-overdue")).toBe(true);
  });

  it("names the note a detached row's line left, the way the column does", async () => {
    await mount([
      task("visa", {
        page: "page-1",
        detachedAt: "2026-09-12T09:00:00.000Z",
        done: false,
      }),
    ]);

    expect(host.querySelector(".brain-task-caption")?.textContent).toBe(
      "line removed from Trip ideas",
    );
  });

  it("draws nothing at all on a notebook with no pages and no tasks", async () => {
    // The teaching screen below carries the whole message. Two empty states
    // stacked, in two alignments and two registers, read as two screens.
    await mount([], () => null, { notebookEmpty: true });

    expect(host.querySelector("[data-hub-today]")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("comes back the moment the notebook holds a task, pages or not", async () => {
    await mount([task("one", { when: dayFrom(4) })], () => null, {
      notebookEmpty: true,
    });

    expect(host.querySelector("[data-hub-today]")).not.toBeNull();
    expect(host.textContent).toContain("Nothing planned today");
  });

  it("takes in a task promoted in a note, with nothing asked again", async () => {
    // THE BLOCK READS THE COLUMN'S SET AND NOTHING ELSE. A task promoted on a
    // note is written by `components/editor/task-checkbox.ts` straight into
    // that set, and that is the whole of what puts it here: the tab never
    // asks again for a write it made itself, because the shell drops the SSE
    // echo of its own event.
    await mount([task("call the bank")]);
    expect(titles()).toEqual(["call the bank"]);
    const before = apiFetchMock.mock.calls.length;

    await act(async () => {
      mutateTasks((tasks) => [task("water the plants"), ...tasks]);
    });

    expect(titles()).toContain("water the plants");
    expect(header()).toContain("2");
    expect(apiFetchMock.mock.calls).toHaveLength(before);
  });

  it("says nothing at all before the browser's clock has been read", async () => {
    // Server-rendered HTML has no day, and a block that guessed one would
    // draw "Nothing planned today" over a list it has not seen.
    token += 1;
    apiFetchMock.mockImplementation(async () => response({ tasks: [] }));
    const { renderToString } = await import("react-dom/server");
    const html = renderToString(
      <HubToday refreshToken={token} onOpenTasks={() => {}} />,
    );
    expect(html).not.toContain("Nothing planned today");
    expect(html).not.toContain("Today ·");
  });
});
