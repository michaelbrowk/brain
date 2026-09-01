// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { Shell } from "./shell";

type EditorProps = {
  value: string;
  onChange: (markdown: string) => void;
};

const editorHarness = vi.hoisted(() => ({
  props: null as EditorProps | null,
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor(props: EditorProps) {
      editorHarness.props = props;
      return <div data-testid="fake-editor">{props.value}</div>;
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

function treeNode(id: string, title: string): TreeNode {
  const timestamp = "2026-07-27T08:00:00.000Z";
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Controllable EventSource double: instances are recorded so a test can walk
 *  the permanent-failure path (readyState CLOSED) and the reconnect. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSED = 2 as const;
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, Array<() => void>>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe("Shell failure recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    editorHarness.props = null;
    apiFetchMock.mockReset();
    FakeEventSource.instances = [];
    window.history.replaceState({}, "", "/p/page-a");

    rafCallbacks = new Map();
    nextFrame = 1;
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
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal("EventSource", FakeEventSource);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function flushAnimationFrames() {
    while (rafCallbacks.size) {
      const callbacks = [...rafCallbacks.values()];
      rafCallbacks.clear();
      await act(async () => {
        callbacks.forEach((callback) => callback(0));
      });
      await settle();
    }
  }

  function findButton(label: string): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`button not found: ${label}`);
    return button;
  }

  it("shows an error state with retry for a cold page whose GET failed, and retry loads it", async () => {
    let pageAFails = true;
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/page/page-a") {
        if (pageAFails) return response({ error: "boom" }, 502);
        return response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        });
      }
      if (url === "/api/tree") {
        return response({ tree: [treeNode("page-a", "Page A")] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const tree = [treeNode("page-a", "Page A")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();

    // no silent skeleton: the failure is named and offers a retry
    expect(container.textContent).toContain("Couldn't load this page");
    const retry = findButton("Try again");

    pageAFails = false;
    await act(async () => {
      retry.click();
    });
    await flushAnimationFrames();

    expect(container.textContent).not.toContain("Couldn't load this page");
    expect(
      container.querySelector("[data-testid='fake-editor']")?.textContent,
    ).toBe("Body A");

    // every page GET carries an abort signal (cleanup abort + 12s timeout),
    // so a hung request can never wedge a cold page on the skeleton forever
    const pageCalls = apiFetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/page/page-a",
    );
    expect(pageCalls.length).toBeGreaterThan(0);
    for (const [, init] of pageCalls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("recreates a permanently closed EventSource and reconciles on reopen", async () => {
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/page/page-a") {
        return response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        });
      }
      if (url === "/api/tree") {
        return response({ tree: [treeNode("page-a", "Page A")] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const tree = [treeNode("page-a", "Page A")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();

    expect(FakeEventSource.instances).toHaveLength(1);
    const first = FakeEventSource.instances[0];

    // open once, then die permanently (the 502-during-deploy shape)
    await act(async () => {
      first.readyState = FakeEventSource.OPEN;
      first.onopen?.();
    });
    await act(async () => {
      first.readyState = FakeEventSource.CLOSED;
      first.onerror?.();
    });

    // the browser is done with this instance — the shell must schedule its own
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);

    const second = FakeEventSource.instances[1];
    const treeCallsBefore = apiFetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/tree",
    ).length;
    await act(async () => {
      second.readyState = FakeEventSource.OPEN;
      second.onopen?.();
    });
    await settle();
    // hasOpened survived the recreation → reopen runs the reconcile pass
    const treeCallsAfter = apiFetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/tree",
    ).length;
    expect(treeCallsAfter).toBeGreaterThan(treeCallsBefore);
  });

  function pageCalls(id: string) {
    return apiFetchMock.mock.calls.filter(
      ([input]) => String(input) === `/api/page/${id}`,
    );
  }

  it("adopts an in-flight hover prefetch instead of issuing a second GET", async () => {
    const pageB = deferred<Response>();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/page/page-b") return pageB.promise;
      if (url === "/api/tree") {
        return response({
          tree: [treeNode("page-a", "Page A"), treeNode("page-b", "Page B")],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const tree = [treeNode("page-a", "Page A"), treeNode("page-b", "Page B")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId={null} />),
    );
    await flushAnimationFrames();

    // hover-intent pause on the row starts the prefetch
    const row = container.querySelector<HTMLElement>(
      '[data-tree-page-id="page-b"]',
    );
    expect(row).not.toBeNull();
    await act(async () => {
      row!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(pageCalls("page-b")).toHaveLength(1);

    // clicking while that prefetch is still on the wire must not re-fetch
    await act(async () => {
      row!.click();
    });
    await flushAnimationFrames();
    expect(pageCalls("page-b")).toHaveLength(1);

    await act(async () => {
      pageB.resolve(
        response({
          meta: { title: "Page B", stickers: [] },
          markdown: "Body B",
          rev: "rev-b",
        }),
      );
      await pageB.promise;
    });
    await settle();
    await settle();
    expect(
      container.querySelector("[data-testid='fake-editor']")?.textContent,
    ).toBe("Body B");
    expect(pageCalls("page-b")).toHaveLength(1);
  });

  it("skips the first SSE reconcile reload while the initial load is still in flight", async () => {
    const pageA = deferred<Response>();
    let pageAResolved = false;
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/page/page-a") {
        if (pageAResolved) {
          return response({
            meta: { title: "Page A", stickers: [] },
            markdown: "Body A",
            rev: "rev-a",
          });
        }
        return pageA.promise;
      }
      if (url === "/api/tree") {
        return response({ tree: [treeNode("page-a", "Page A")] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const tree = [treeNode("page-a", "Page A")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();
    expect(pageCalls("page-a")).toHaveLength(1);

    // the stream's first "ready" lands while that GET is still pending
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source.readyState = FakeEventSource.OPEN;
      source.onopen?.();
      source.listeners.get("ready")?.forEach((listener) => listener());
    });
    await settle();
    await settle();
    expect(
      apiFetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/tree",
      ).length,
    ).toBeGreaterThan(0);
    expect(pageCalls("page-a")).toHaveLength(1);

    await act(async () => {
      pageAResolved = true;
      pageA.resolve(
        response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        }),
      );
      await pageA.promise;
    });
    await settle();
    await settle();
    expect(
      container.querySelector("[data-testid='fake-editor']")?.textContent,
    ).toBe("Body A");

    // once the load has settled, a later reconcile revalidates as before
    await act(async () => {
      source.listeners.get("ready")?.forEach((listener) => listener());
    });
    await settle();
    await settle();
    expect(pageCalls("page-a")).toHaveLength(2);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
