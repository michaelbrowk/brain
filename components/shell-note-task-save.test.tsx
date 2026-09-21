// @vitest-environment jsdom

// THE NOTE'S OTHER TWO TASK GESTURES, AND THE SET THREE SCREENS READ.
//
// A promote and a reschedule are API writes, and their writer hands the
// answered record to `components/tasks-client` itself. A checkbox TICKED in
// the editor and a task line DELETED are not: they are the note's own
// markdown, so they reach the store as PUT /api/page, which runs the
// reconcile. That event carries this tab's own `src` and the shell drops its
// echo, and the page answer carries a rev and nothing about the records the
// reconcile decided — so there is nothing to hand over and the set has to be
// re-asked. Until it was, a task ticked in a note stayed open in Tasks, in
// Home's Today block and on the sidebar badge until a reload or midnight.
//
// The editor here is a stand-in: what is under test is the save-settled path
// in the shell, not Milkdown. `onChange` is the markdown the editor would
// have serialized after the gesture.

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import type { TaskView } from "@/lib/tasks/model";
import { apiFetch } from "@/lib/client";
import { liveTask, localDay, resetTasksStore } from "./tasks-client";
import { Shell } from "./shell";

type EditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  registerFlush?: (flush: () => void) => (() => void) | void;
};

const editorHarness = vi.hoisted(() => ({ props: null as EditorProps | null }));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor(props: EditorProps) {
      editorHarness.props = props;
      useEffect(() => props.registerFlush?.(() => {}), [props]);
      return <div className="ProseMirror" tabIndex={0} />;
    },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function node(id: string, title: string): TreeNode {
  const timestamp = "2026-09-14T08:00:00.000Z";
  return {
    id,
    parentId: null,
    title,
    order: id,
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
  };
}

const LINE = "water the plants";
const WITH_TASK = `- [ ] ${LINE}\n`;
const TICKED = `- [x] ${LINE}\n`;
const PROSE = "A paragraph about the garden.\n";

describe("a task ticked or deleted in a note, and the set three screens read", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  /** The record the store holds for the line, as the fake reconcile leaves
   *  it. `null` is a record the reconcile removed. */
  let record: TaskView | null;
  let markdown: string;
  let revision: number;
  let taskReads: number;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    editorHarness.props = null;
    apiFetchMock.mockReset();
    resetTasksStore();
    window.history.replaceState({}, "", "/p/note");
    rafCallbacks = new Map();
    let nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrame++;
        rafCallbacks.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => rafCallbacks.delete(id)),
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        addEventListener() {}
        close() {}
      },
    );
    markdown = WITH_TASK;
    revision = 1;
    taskReads = 0;
    record = {
      id: "task-1",
      title: LINE,
      page: "note",
      // Filed today, so the sidebar's count has something to draw: the badge
      // is `openTodayCount` over this same set, and it is the third screen
      // this seam feeds.
      when: localDay().today,
      done: false,
      created: "2026-09-14T08:00:00.000Z",
      updated: "2026-09-14T08:00:00.000Z",
    };
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      // THE RECONCILE, IN ONE LINE: the note's markdown decides the record.
      // The line gone takes the record with it, and `[x]` marks it done —
      // which is what the store's own `reconcilePageTasks` does, and it
      // answers none of it through the page route.
      if (url === "/api/page/note") {
        if (init?.method === "PUT") {
          markdown = (JSON.parse(String(init.body)) as { markdown: string }).markdown;
          revision += 1;
          if (!markdown.includes(LINE)) record = null;
          else if (record) record = { ...record, done: markdown.includes("[x]") };
          return response({ rev: `rev-${revision}` });
        }
        return response({
          meta: { id: "note", title: "Note" },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      if (url.startsWith("/api/tasks?")) {
        taskReads += 1;
        return response({ tasks: record ? [record] : [] });
      }
      if (url === "/api/notifications") return response({ notifications: [], unread: 0 });
      throw new Error(`Unexpected request: ${url}`);
    });
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

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function flushFrames() {
    while (rafCallbacks.size) {
      const callbacks = [...rafCallbacks.values()];
      rafCallbacks.clear();
      await act(async () => callbacks.forEach((callback) => callback(0)));
      await settle();
    }
  }

  async function open() {
    await act(async () =>
      root.render(<Shell tree={[node("note", "Note")]} initialSelectedId="note" />),
    );
    await flushFrames();
    await settle();
  }

  /** The gesture, as the editor would serialize it, and the save that
   *  settles after it. */
  async function save(next: string) {
    await act(async () => editorHarness.props?.onChange(next));
    await act(async () => vi.advanceTimersByTime(700));
    await settle();
    await settle();
  }

  /** The number the sidebar's Tasks row draws, straight off the same set. */
  function badge(): string | null {
    const row = [...document.querySelectorAll<HTMLButtonElement>("button.tree-row")].find(
      (button) => button.textContent?.includes("Tasks"),
    );
    return row?.querySelector(".tree-row-count")?.textContent ?? null;
  }

  it("ticks the record in the shared set when the box is ticked in the note", async () => {
    await open();
    expect(liveTask("task-1")?.done).toBe(false);
    expect(badge()).toBe("1");

    await save(TICKED);

    expect(liveTask("task-1")?.done).toBe(true);
    // and the badge, which is `openTodayCount` over that same set
    expect(badge()).toBeNull();
  });

  it("takes the record out of the set when the line is deleted", async () => {
    await open();
    expect(liveTask("task-1")).toBeDefined();

    await save(PROSE);

    expect(liveTask("task-1")).toBeUndefined();
    expect(badge()).toBeNull();
  });

  it("asks nothing again for a save of a note that has no task line either way", async () => {
    markdown = PROSE;
    record = null;
    await open();
    const before = taskReads;

    await save("A paragraph about the garden, longer.\n");

    expect(taskReads).toBe(before);
  });
});
