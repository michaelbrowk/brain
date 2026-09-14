// @vitest-environment jsdom

// A sticker save and the page's own autosave, in both orders.
//
// The note is the owner's: one sticker pinned on it, a body being typed, one
// tab, one device. Nothing about that is a foreign change, so the sticker
// toast that says one happened must never appear, in either order, and
// including the first sticker on a page that has none, whose baseline is `[]`
// because a page with no stickers holds no `stickers` key to read.
//
// The fake server answers the sticker PATCH with the store's own rule: an
// empty list and an absent one are the same state (`metadataValuesEqual` in
// `lib/store/store.ts`), and a baseline naming a list the page does not hold
// is still the 409 it always was, which is the last case here.

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sticker, TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
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

/** The store's rule, stated once: a list the page does not hold and an empty
 *  one are the same state. */
const sameList = (current: Sticker[] | undefined, expected: unknown) =>
  JSON.stringify(current ?? []) ===
  JSON.stringify(Array.isArray(expected) ? expected : []);

interface FakeServer {
  markdown: string;
  stickers: Sticker[] | undefined;
  revision: number;
  patches: { stickers: Sticker[]; expected?: Sticker[] }[];
  conflicts: number;
}

const CONFLICT_TOAST = "Stickers changed elsewhere";

function toastShown() {
  return document.body.textContent?.includes(CONFLICT_TOAST) ?? false;
}

describe("Shell sticker saves and the page's own autosave", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let server: FakeServer;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    editorHarness.props = null;
    apiFetchMock.mockReset();
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
    server = {
      markdown: "A paragraph about the garden.",
      stickers: undefined,
      revision: 1,
      patches: [],
      conflicts: 0,
    };
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url !== "/api/page/note") throw new Error(`Unexpected request: ${url}`);
      if (init?.method === "PUT") {
        server.markdown = (
          JSON.parse(String(init.body)) as { markdown: string }
        ).markdown;
        server.revision += 1;
        return response({ rev: `rev-${server.revision}` });
      }
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as {
          stickers: Sticker[];
          expected?: { stickers?: unknown };
        };
        server.patches.push({
          stickers: body.stickers,
          expected: body.expected?.stickers as Sticker[] | undefined,
        });
        if (
          body.expected !== undefined &&
          !sameList(server.stickers, body.expected.stickers)
        ) {
          server.conflicts += 1;
          return response({ error: "conflict", fields: ["stickers"] }, 409);
        }
        server.stickers = body.stickers.length ? body.stickers : undefined;
        server.revision += 1;
        return response({ id: "note", title: "Note", stickers: server.stickers });
      }
      return response({
        meta: { id: "note", title: "Note", stickers: server.stickers },
        markdown: server.markdown,
        rev: `rev-${server.revision}`,
      });
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => {
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
  }

  async function type(markdown: string) {
    await act(async () => editorHarness.props?.onChange(markdown));
    await act(async () => vi.advanceTimersByTime(700));
    await settle();
  }

  /** The gesture: the "Sticker" button in the page head. */
  async function addSticker() {
    const add = [...host.querySelectorAll("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === "Add sticker",
    ) as HTMLButtonElement;
    expect(add).toBeDefined();
    await act(async () => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(async () => vi.advanceTimersByTime(500));
    await settle();
  }

  it("saves the first sticker after the body autosave, with no conflict toast", async () => {
    await open();
    await type("A paragraph about the garden, longer.");
    await addSticker();

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0].expected).toEqual([]);
    expect(server.conflicts).toBe(0);
    expect(server.stickers).toHaveLength(1);
    expect(server.markdown).toBe("A paragraph about the garden, longer.");
    expect(toastShown()).toBe(false);
  });

  it("saves the first sticker before the body autosave, with no conflict toast", async () => {
    await open();
    await addSticker();
    await type("A paragraph about the garden, longer.");

    expect(server.patches).toHaveLength(1);
    expect(server.patches[0].expected).toEqual([]);
    expect(server.conflicts).toBe(0);
    expect(server.stickers).toHaveLength(1);
    expect(server.markdown).toBe("A paragraph about the garden, longer.");
    expect(toastShown()).toBe(false);
  });

  it("still says so when the stickers really did change elsewhere", async () => {
    await open();
    // another writer pinned one while this tab was reading its own page
    server.stickers = [{ id: "theirs", x: 80, y: 80, text: "from the phone" }];
    await addSticker();

    expect(server.conflicts).toBe(1);
    expect(toastShown()).toBe(true);
  });
});
