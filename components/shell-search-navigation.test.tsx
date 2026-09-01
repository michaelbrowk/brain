// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandPaletteSelection } from "./command-palette";
import type {
  SearchHighlightRequest,
  SearchHighlightStatus,
  SearchTextTarget,
} from "@/lib/search-navigation";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { Shell } from "./shell";

type EditorProps = {
  value: string;
  onDirty?: () => void;
  searchHighlight?: SearchHighlightRequest | null;
  onSearchHighlightStatus?: (
    requestId: number,
    status: SearchHighlightStatus,
  ) => void;
};

type PaletteProps = {
  onSelect: (selection: CommandPaletteSelection) => void;
};

const harness = vi.hoisted(() => ({
  editorProps: null as EditorProps | null,
  paletteProps: null as PaletteProps | null,
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("./command-palette", () => ({
  CommandPalette: (props: PaletteProps) => {
    harness.paletteProps = props;
    return null;
  },
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor(props: EditorProps) {
      harness.editorProps = props;
      return <div data-testid="fake-editor">{props.value}</div>;
    },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function node(id: string): TreeNode {
  const timestamp = "2026-07-29T08:00:00.000Z";
  return {
    id,
    parentId: null,
    title: `Page ${id.toUpperCase()}`,
    order: id,
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
  };
}

function target(exact: string, occurrence = 0): SearchTextTarget {
  return {
    exact,
    occurrence,
    before: "",
    after: "",
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Shell search navigation", () => {
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
    harness.editorProps = null;
    harness.paletteProps = null;
    apiFetchMock.mockReset();
    window.history.replaceState({}, "", "/");

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

  it("hands a body match to a delayed and already-open editor, then clears it for title navigation or edit", async () => {
    const delayed = deferred<Response>();
    apiFetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/page/b") return delayed.promise;
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () =>
      root.render(
        <Shell tree={[node("b")]} initialSelectedId={null} />,
      ),
    );
    await flushAnimationFrames();

    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "b",
        target: target("Needle"),
      }),
    );
    await flushAnimationFrames();
    expect(harness.editorProps).toBeNull();

    await act(async () => {
      delayed.resolve(
        response({
          meta: { title: "Page B", stickers: [] },
          markdown: "Needle, then Needle",
          rev: "rev-b",
        }),
      );
      await delayed.promise;
    });
    await settle();

    expect(harness.editorProps?.searchHighlight?.target.exact).toBe("Needle");

    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "b",
        target: target("Needle", 1),
      }),
    );
    expect(harness.editorProps?.searchHighlight?.target.occurrence).toBe(1);

    await act(async () =>
      harness.paletteProps?.onSelect({ kind: "page", id: "b" }),
    );
    expect(harness.editorProps?.searchHighlight).toBeNull();

    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "b",
        target: target("Needle"),
      }),
    );
    await act(async () => harness.editorProps?.onDirty?.());
    expect(harness.editorProps?.searchHighlight).toBeNull();

    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "b",
        target: target("Needle"),
      }),
    );
    await act(async () =>
      (
        container.querySelector(
          '[data-search-trigger="desktop"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(harness.editorProps?.searchHighlight).toBeNull();
  });

  it("keeps only the latest rapid search navigation when page loads resolve out of order", async () => {
    const pageB = deferred<Response>();
    const pageC = deferred<Response>();
    apiFetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/page/b") return pageB.promise;
      if (String(input) === "/api/page/c") return pageC.promise;
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () =>
      root.render(
        <Shell tree={[node("b"), node("c")]} initialSelectedId={null} />,
      ),
    );
    await flushAnimationFrames();
    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "b",
        target: target("Older"),
      }),
    );
    await flushAnimationFrames();
    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "c",
        target: target("Latest"),
      }),
    );
    await flushAnimationFrames();

    await act(async () => {
      pageC.resolve(
        response({
          meta: { title: "Page C", stickers: [] },
          markdown: "Latest",
          rev: "rev-c",
        }),
      );
      await pageC.promise;
    });
    await settle();
    expect(harness.editorProps?.searchHighlight?.pageId).toBe("c");
    expect(harness.editorProps?.searchHighlight?.target.exact).toBe("Latest");

    await act(async () => {
      pageB.resolve(
        response({
          meta: { title: "Page B", stickers: [] },
          markdown: "Older",
          rev: "rev-b",
        }),
      );
      await pageB.promise;
    });
    await settle();
    expect(harness.editorProps?.searchHighlight?.pageId).toBe("c");
    expect(harness.editorProps?.searchHighlight?.target.exact).toBe("Latest");
  });

  it.each(["missing", "ambiguous"] as const)(
    "opens a stale %s result without a highlight and gives nonblocking feedback",
    async (status) => {
      apiFetchMock.mockResolvedValue(
        response({
          meta: { title: "Page B", stickers: [] },
          markdown: "Current body",
          rev: "rev-b",
        }),
      );
      await act(async () =>
        root.render(<Shell tree={[node("b")]} initialSelectedId="b" />),
      );
      await flushAnimationFrames();
      await act(async () =>
        harness.paletteProps?.onSelect({
          kind: "text",
          id: "b",
          target: target("Stale"),
        }),
      );
      const requestId = harness.editorProps?.searchHighlight?.requestId;
      expect(requestId).toBeTypeOf("number");

      await act(async () =>
        harness.editorProps?.onSearchHighlightStatus?.(requestId!, status),
      );

      expect(harness.editorProps?.searchHighlight).toBeNull();
      expect(document.body.textContent).toContain(
        "That search match changed. Opened the page instead.",
      );
      expect(window.location.pathname).toBe("/p/b");
    },
  );

  it("opens a body result with no trustworthy backend anchor and reports it stale", async () => {
    apiFetchMock.mockResolvedValue(
      response({
        meta: { title: "Page B", stickers: [] },
        markdown: "Beta remains",
        rev: "rev-b",
      }),
    );
    await act(async () =>
      root.render(<Shell tree={[node("b")]} initialSelectedId="b" />),
    );
    await flushAnimationFrames();

    await act(async () =>
      harness.paletteProps?.onSelect({
        kind: "text",
        id: "b",
        target: null,
      }),
    );

    expect(harness.editorProps?.searchHighlight).toBeNull();
    expect(document.body.textContent).toContain(
      "That search match changed. Opened the page instead.",
    );
    expect(window.location.pathname).toBe("/p/b");
  });
});
