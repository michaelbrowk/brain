// @vitest-environment jsdom

// TEXT TYPED JUST BEFORE THE TAB GOES AWAY HAS TO REACH THE SERVER.
//
// The editor here is a stand-in that hands the shell the markdown it would
// have serialized. The server is a fake with the store's two conflict rules:
// an ordinary PUT writes when its rev or its base body is current, and a body
// patch writes when the page holds the body the patch was cut from. A
// keepalive request over 64 KiB is refused the way a browser refuses it.

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { applyBodyPatch, bodyHash, type BodyPatch } from "@/lib/body-patch";
import { canonicalPageMarkdown } from "@/lib/page-markdown";
import { resetTasksStore } from "./tasks-client";
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

const KEEPALIVE_LIMIT = 64 * 1024;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function node(id: string, title: string): TreeNode {
  const timestamp = "2026-10-07T08:00:00.000Z";
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

interface SentPut {
  keepalive: boolean;
  body: {
    markdown?: string;
    rev?: string;
    baseMarkdown?: string;
    patches?: BodyPatch[];
  };
  bytes: number;
}

describe("the newest text leaves when the tab goes away", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let server: { markdown: string; rev: number };
  let puts: SentPut[];
  /** An ordinary request the test holds. Resolving it lets the fake server
   *  process it at that moment, as a request that was slow on the wire. */
  let held: Array<() => void>;
  let holdOrdinary: boolean;
  /** A frozen tab: ordinary requests are made but never leave. */
  let frozen: boolean;
  /** Ordinary PUTs answered 503 before the server takes them again. */
  let failingPuts: number;
  const apiFetchMock = vi.mocked(apiFetch);

  function writeFull(body: SentPut["body"]): Response {
    const markdown = canonicalPageMarkdown(body.markdown ?? "");
    const baseMatches =
      body.baseMarkdown !== undefined &&
      canonicalPageMarkdown(body.baseMarkdown) === server.markdown;
    if (body.rev !== `rev-${server.rev}` && !baseMatches) {
      return response({ error: "conflict", currentRev: `rev-${server.rev}` }, 409);
    }
    if (markdown !== server.markdown) {
      server = { markdown, rev: server.rev + 1 };
    }
    return response({ markdown: server.markdown, rev: `rev-${server.rev}` });
  }

  function writePatch(body: SentPut["body"]): Response {
    const current = bodyHash(server.markdown);
    const patch = body.patches?.find((candidate) => candidate.base === current);
    const next = patch ? applyBodyPatch(server.markdown, patch) : null;
    if (next === null) {
      return response({ error: "conflict", currentRev: `rev-${server.rev}` }, 409);
    }
    if (next !== server.markdown) server = { markdown: next, rev: server.rev + 1 };
    return response({ markdown: server.markdown, rev: `rev-${server.rev}` });
  }

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
    server = { markdown: "Base", rev: 1 };
    puts = [];
    held = [];
    holdOrdinary = false;
    frozen = false;
    failingPuts = 0;
    apiFetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/page/note") {
        if (init?.method === "PUT") {
          const raw = String(init.body);
          const bytes = new TextEncoder().encode(raw).byteLength;
          const sent: SentPut = {
            keepalive: init.keepalive === true,
            body: JSON.parse(raw) as SentPut["body"],
            bytes,
          };
          if (sent.keepalive && bytes > KEEPALIVE_LIMIT) {
            return Promise.reject(new TypeError("Failed to fetch"));
          }
          puts.push(sent);
          const process = () =>
            sent.body.patches ? writePatch(sent.body) : writeFull(sent.body);
          if (!sent.keepalive) {
            if (frozen) return new Promise<Response>(() => {});
            if (failingPuts > 0) {
              failingPuts -= 1;
              return Promise.resolve(response({ error: "unavailable" }, 503));
            }
            if (holdOrdinary) {
              return new Promise<Response>((resolve) =>
                held.push(() => resolve(process())),
              );
            }
          }
          return Promise.resolve(process());
        }
        return Promise.resolve(
          response({
            meta: { id: "note", title: "Note" },
            markdown: server.markdown,
            rev: `rev-${server.rev}`,
          }),
        );
      }
      if (url.startsWith("/api/tasks")) return Promise.resolve(response({ tasks: [] }));
      if (url === "/api/notifications") {
        return Promise.resolve(response({ notifications: [], unread: 0 }));
      }
      return Promise.resolve(response({}));
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
    Reflect.deleteProperty(document, "visibilityState");
  });

  async function settle() {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }
  }

  async function flushFrames() {
    while (rafCallbacks.size) {
      const callbacks = [...rafCallbacks.values()];
      rafCallbacks.clear();
      await act(async () => callbacks.forEach((callback) => callback(0)));
      await settle();
    }
  }

  async function open(markdown = "Base") {
    server = { markdown, rev: 1 };
    await act(async () =>
      root.render(<Shell tree={[node("note", "Note")]} initialSelectedId="note" />),
    );
    await flushFrames();
    await settle();
  }

  async function type(markdown: string) {
    await act(async () => editorHarness.props?.onChange(markdown));
  }

  async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTime(ms));
    await settle();
  }

  function hide() {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function drafts(): string[] {
    return Object.keys(localStorage).filter((key) => key.startsWith("brain-draft"));
  }

  it("sends the newest text at pagehide while an older save is still on the wire", async () => {
    await open();
    holdOrdinary = true;
    await type("Base one");
    await advance(700);
    expect(held).toHaveLength(1);
    await type("Base one two");

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();

    expect(puts.filter((put) => put.keepalive)).toHaveLength(1);
    expect(server.markdown).toBe("Base one two");
  });

  it("an older save landing after the closing save is not read as a conflict", async () => {
    await open();
    holdOrdinary = true;
    await type("Base one");
    await advance(700);
    await type("Base one two");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();
    expect(server.markdown).toBe("Base one two");

    // The tab lived on (bfcache, or only hidden). The older request reaches
    // the server now, behind the newer body this tab sent itself.
    holdOrdinary = false;
    await act(async () => held.shift()?.());
    await settle();
    await advance(2_000);
    await advance(2_000);

    expect(server.markdown).toBe("Base one two");
    expect(document.body.textContent).not.toContain("Save a copy");
    expect(drafts()).toEqual([]);

    // And the page keeps saving the ordinary way.
    await type("Base one two three");
    await advance(700);
    expect(server.markdown).toBe("Base one two three");
  });

  it("a page over 64 KiB still leaves, as a span small enough for keepalive", async () => {
    const long = `${"A paragraph of an old and very long page.\n\n".repeat(2_000)}End`;
    expect(new TextEncoder().encode(long).byteLength).toBeGreaterThan(KEEPALIVE_LIMIT);
    await open(long);
    await type(`${long} and the last words`);

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();

    const keepalive = puts.filter((put) => put.keepalive);
    expect(keepalive).toHaveLength(1);
    expect(keepalive[0].bytes).toBeLessThan(1024);
    expect(server.markdown).toBe(`${long} and the last words`);
  });

  it("a hidden tab that freezes still sends the newest text", async () => {
    await open();
    frozen = true;
    await type("Typed before switching apps");

    await act(async () => hide());
    await settle();

    expect(server.markdown).toBe("Typed before switching apps");
  });

  it("never sends a closing save against a page in conflict", async () => {
    await open();
    server = { markdown: "Written elsewhere", rev: 7 };
    await type("Local edit");
    await advance(700);
    await advance(2_000);
    expect(document.body.textContent).toContain("Save a copy");
    const before = puts.length;

    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();

    expect(puts.length).toBe(before);
    expect(server.markdown).toBe("Written elsewhere");
  });
});
