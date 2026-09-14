// @vitest-environment jsdom

// THE WRITES A ROW CAN ASK FOR, through the column that asks for them.
//
// Two properties live here. The first is the words a refused untick is
// reported in: unticking a LINKED task writes `[ ]` back into somebody's
// note, and a failure there is a failure in that note, which no route
// `reason` can name. The second is a shape the store refuses. `updateTask`
// will not take a schedule, a title, a deadline, a category or a rule in the
// same call as a linked task's `done` or a repeating task's completion, in
// two separate reasons, and the point of this file is that no gesture in the
// column can produce one.

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

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const { localDay, resetTasksStore } = await import("./tasks-client");
const { TasksSurface } = await import("./tasks-surface");
const { WRITE_AT_MS } = await import("./tasks-row");
const { SMART_UNDO_MS } = await import("./shell/helpers");

const apiFetchMock = vi.mocked(apiFetch);

const NOON = new Date("2026-09-13T12:00:00.000Z");
const TODAY = localDay(NOON).today;

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
let token = 0;
const toasts: { title: string; options?: ToastOptions }[] = [];
const patches: { url: string; body: Record<string, unknown> }[] = [];

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(
  tasks: TaskView[],
  {
    list = null,
    patchAnswer,
  }: {
    list?: React.ComponentProps<typeof TasksSurface>["list"];
    patchAnswer?: (body: Record<string, unknown>) => Response;
  } = {},
) {
  token += 1;
  apiFetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/tasks?")) return response({ tasks });
    if (url.startsWith("/api/tasks/")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      patches.push({ url, body });
      return patchAnswer
        ? patchAnswer(body)
        : response({ task: { ...tasks[0], ...body } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  await act(async () => {
    root.render(
      <TasksSurface
        list={list}
        refreshToken={token}
        onToast={(title, options) => toasts.push({ title, options })}
        pageTitleOf={(pageId) => (pageId === "page-1" ? "Groceries" : undefined)}
      />,
    );
  });
  await settle();
}

/** The box of ONE row, by its title. Not "the first box on screen": every
 *  capturable list draws a ghost row above the tasks and that row has a box
 *  of its own. */
function boxFor(title: string): HTMLButtonElement {
  const node = [...host.querySelectorAll<HTMLElement>(".brain-task-title")].find(
    (candidate) => candidate.textContent === title,
  );
  if (!node) throw new Error(`no row titled ${title}`);
  const box = node
    .closest(".brain-task-row-item")
    ?.querySelector<HTMLButtonElement>(".brain-task-box");
  if (!box) throw new Error(`no box on the row titled ${title}`);
  return box;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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
  toasts.length = 0;
  patches.length = 0;
  resetTasksStore();
  apiFetchMock.mockReset();
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetTasksStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the untick's own words", () => {
  it("names the note when a linked untick is refused", async () => {
    await mount(
      [
        task("shopping", {
          done: true,
          doneAt: NOON.toISOString(),
          page: "page-1",
        }),
      ],
      {
        list: "logbook",
        patchAnswer: () =>
          response({ error: "page_missing", reason: "That page is gone" }, 409),
      },
    );

    await act(async () => boxFor("shopping").click());
    await settle();

    expect(toasts.at(-1)?.title).toBe("Couldn't untick in Groceries");
    expect(toasts.at(-1)?.options?.urgent).toBe(true);
  });

  it("says 'that note' where the note's title is not in this tab's tree", async () => {
    await mount(
      [
        task("shopping", {
          done: true,
          doneAt: NOON.toISOString(),
          page: "page-elsewhere",
        }),
      ],
      {
        list: "logbook",
        patchAnswer: () => response({ error: "busy", reason: "The notebook is busy" }, 409),
      },
    );

    await act(async () => boxFor("shopping").click());
    await settle();

    expect(toasts.at(-1)?.title).toBe("Couldn't untick in that note");
  });

  it("names the note when a linked completion is refused", async () => {
    // Spec line 493: ticking a LINKED task writes `[x]` into somebody's note,
    // so a failure there is a failure in that note, exactly as the untick's
    // is. The row goes back open and the sentence says where.
    await mount([task("shopping", { when: TODAY, page: "page-1" })], {
      patchAnswer: () =>
        response({ error: "page_missing", reason: "That page is gone" }, 409),
    });

    await act(async () => boxFor("shopping").click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe("Couldn't tick in Groceries");
    expect(toasts.at(-1)?.options?.urgent).toBe(true);
  });

  it("keeps the route's own reason for a completion no note owns", async () => {
    await mount([task("shopping", { when: TODAY })], {
      patchAnswer: () =>
        response({ error: "busy", reason: "The notebook is busy" }, 409),
    });

    await act(async () => boxFor("shopping").click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(toasts.at(-1)?.title).toBe("The notebook is busy");
  });

  it("keeps the route's own reason for a task no note owns", async () => {
    await mount([task("shopping", { done: true, doneAt: NOON.toISOString() })], {
      list: "logbook",
      patchAnswer: () => response({ error: "busy", reason: "The notebook is busy" }, 409),
    });

    await act(async () => boxFor("shopping").click());
    await settle();

    expect(toasts.at(-1)?.title).toBe("The notebook is busy");
  });
});

describe("the pill and the fold", () => {
  it("reports at the fold and corrects itself when the answer lands", async () => {
    // Spec 2.1: the pill shows when the fold STARTS. Waiting for the 2xx put
    // it 740ms later, so on a slow write the row was gone and the way back had
    // not appeared. The report is true the moment the reader made it; the
    // Undo is not offered until the write it would reverse exists.
    await mount([task("water", { when: TODAY })]);

    await act(async () => boxFor("water").click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(
      toasts.map((entry) => [entry.title, entry.options?.actionLabel ?? null]),
    ).toEqual([
      ["Completed", null],
      ["Completed", "Undo"],
    ]);
    // The first stands until the second replaces it: no window, and no way
    // back to press for a completion that has not landed.
    expect(toasts[0]?.options?.durationMs).toBeNull();
    expect(toasts[0]?.options?.onAction).toBeUndefined();
    // One message, said twice.
    expect(toasts[0]?.options?.id).toBeDefined();
    expect(toasts[1]?.options?.id).toBe(toasts[0]?.options?.id);
    expect(toasts[1]?.options?.durationMs).toBe(SMART_UNDO_MS);
  });

  it("replaces its own report with the refusal rather than standing over it", async () => {
    await mount([task("water", { when: TODAY })], {
      patchAnswer: () =>
        response({ error: "busy", reason: "The notebook is busy" }, 409),
    });

    await act(async () => boxFor("water").click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(toasts.map((entry) => entry.title)).toEqual([
      "Completed",
      "The notebook is busy",
    ]);
    // The refusal wears the report's id, so a pill claiming the opposite of
    // what happened cannot be left standing with no window to take it down.
    expect(toasts[1]?.options?.id).toBe(toasts[0]?.options?.id);
    expect(toasts[1]?.options?.urgent).toBe(true);
  });
});

describe("one field per request, where the store says so", () => {
  it("never sends a schedule in the same call as a completion", async () => {
    await mount([
      task("weekly", { when: TODAY, repeat: { freq: "daily" } }),
    ]);

    await act(async () => boxFor("weekly").click());
    await act(async () => {
      vi.advanceTimersByTime(WRITE_AT_MS);
    });
    await settle();

    expect(patches).toHaveLength(1);
    // `done`, and the instance this tab was looking at, which is a
    // precondition and not a schedule. Nothing else.
    expect(Object.keys(patches[0]!.body).sort()).toEqual(["done", "expectedWhen"]);
    expect(patches[0]!.body.done).toBe(true);
  });

  it("never sends a completion in the same call as a reschedule", async () => {
    await mount([task("water", { when: TODAY })]);

    // `t` moves the selected row to Today; the row has to be selected first,
    // which a press does.
    const row = boxFor("water").closest(".brain-task-row") as HTMLElement;
    await act(async () => row.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    });
    await settle();

    expect(patches).toHaveLength(1);
    expect(Object.keys(patches[0]!.body)).toEqual(["when"]);
    expect(patches[0]!.body.when).toBe("someday");
  });

  it("sends only `done: false` on an untick", async () => {
    await mount(
      [task("shopping", { done: true, doneAt: NOON.toISOString(), page: "page-1" })],
      { list: "logbook" },
    );

    await act(async () => boxFor("shopping").click());
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ done: false });
  });

  it("sends the live record's when when a repeat's newest completion is unticked", async () => {
    // The row is `logbookRows`' projection of ONE completion: its `when` is
    // the day that instance was owed. The record behind it is open and stands
    // on the NEXT occurrence, and that is the value the store's guard compares
    // against, so a projection's `when` would refuse every first untick.
    await mount(
      [
        task("daily", {
          when: "2026-09-14",
          repeat: { freq: "daily" },
          log: [{ scheduled: TODAY, completedAt: NOON.toISOString() }],
        }),
      ],
      { list: "logbook" },
    );

    await act(async () => boxFor("daily").click());
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toEqual({ done: false, expectedWhen: "2026-09-14" });
  });
});
