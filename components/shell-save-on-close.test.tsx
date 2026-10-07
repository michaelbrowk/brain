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
import { mergeCheckboxStates } from "@/lib/tasks/merge-checkboxes";
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
  let held: Array<{ resolve: () => void; fail: () => void }>;
  let holdOrdinary: boolean;
  /** A frozen tab: ordinary requests are made but never leave. */
  let frozen: boolean;
  /** Ordinary PUTs answered 503 before the server takes them again. */
  let failingPuts: number;
  /** The closing-tab save reaches the server, and its answer never reaches
   *  the tab: frozen, or closed and restored from the back-forward cache. */
  let keepaliveAnswerLost: boolean;
  /** Every body the server held, in order. */
  let history: string[];
  const apiFetchMock = vi.mocked(apiFetch);

  function commit(markdown: string) {
    if (markdown === server.markdown) return;
    server = { markdown, rev: server.rev + 1 };
    history.push(markdown);
  }

  function conflictResponse() {
    return response({ error: "conflict", currentRev: `rev-${server.rev}` }, 409);
  }

  /** The store's rule: the rev, or the base body, or a tick-only merge. */
  function writeFull(body: SentPut["body"]): Response {
    const markdown = canonicalPageMarkdown(body.markdown ?? "");
    const base =
      body.baseMarkdown === undefined ? undefined : canonicalPageMarkdown(body.baseMarkdown);
    if (body.rev === `rev-${server.rev}` || base === server.markdown) {
      commit(markdown);
    } else {
      const merged =
        base === undefined ? null : mergeCheckboxStates(base, markdown, server.markdown);
      if (!merged?.ok) return conflictResponse();
      commit(canonicalPageMarkdown(merged.merged));
    }
    return response({ markdown: server.markdown, rev: `rev-${server.rev}` });
  }

  function writePatch(body: SentPut["body"]): Response {
    const current = bodyHash(server.markdown);
    const patch = body.patches?.find((candidate) => candidate.base === current);
    const next = patch ? applyBodyPatch(server.markdown, patch) : null;
    if (next === null) return conflictResponse();
    commit(next);
    return response({ markdown: server.markdown, rev: `rev-${server.rev}` });
  }

  /** Somebody else ticks a box: Tasks, a phone, the assistant. */
  function tickElsewhere(from: string, to: string) {
    commit(server.markdown.replace(from, to));
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
    keepaliveAnswerLost = false;
    history = [];
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
              return new Promise<Response>((resolve, reject) =>
                held.push({
                  resolve: () => resolve(process()),
                  fail: () => reject(new TypeError("Failed to fetch")),
                }),
              );
            }
          }
          const answer = process();
          if (sent.keepalive && keepaliveAnswerLost) return new Promise<Response>(() => {});
          return Promise.resolve(answer);
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
    await act(async () => held.shift()?.resolve());
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
    // The older body never went back over the newer one, not even for a
    // moment before the next save healed it.
    expect(history).toEqual(["Base one two", "Base one two three"]);
  });

  it("a landed closing save becomes the tab's base, in memory and in the draft", async () => {
    await open();
    holdOrdinary = true;
    await type("Base one");
    await advance(700);
    await type("Base one two");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    await settle();
    expect(server.markdown).toBe("Base one two");

    const [key] = drafts();
    const draft = JSON.parse(localStorage.getItem(key) ?? "{}") as {
      revision?: string;
      baseMarkdown?: string;
    };
    expect(draft).toMatchObject({
      revision: `rev-${server.rev}`,
      baseMarkdown: "Base one two",
    });
    holdOrdinary = false;
    await act(async () => held.shift()?.resolve());
    await advance(2_000);
  });

  // The reviewer's shape: the closing save lands, somebody ticks a box, and
  // the tab comes back and keeps typing. Nobody else edited text, so nothing
  // here may come out as a conflict.
  for (const answer of ["seen", "lost"] as const) {
    it(`a tick after a landed closing save is merged, not a conflict (answer ${answer})`, async () => {
      await open("- [ ] task\n\ntext");
      keepaliveAnswerLost = answer === "lost";
      holdOrdinary = true;
      await type("- [ ] task\n\ntext more");
      await act(async () => hide());
      await settle();
      expect(server.markdown).toBe("- [ ] task\n\ntext more");

      tickElsewhere("- [ ] task", "- [x] task");
      await act(async () => {
        Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      holdOrdinary = false;
      while (held.length) await act(async () => held.shift()?.resolve());
      await advance(2_000);
      await type("- [ ] task\n\ntext more and more");
      await advance(700);
      await advance(2_000);

      expect(document.body.textContent).not.toContain("Save a copy");
      expect(server.markdown).toBe("- [x] task\n\ntext more and more");
    });
  }

  it("an older save queued behind a closing save cannot tick-merge over it", async () => {
    await open("- [ ] a\n- [ ] b");
    keepaliveAnswerLost = true;
    holdOrdinary = true;
    // Tick a, tick b, then think better of a and untick it.
    await type("- [x] a\n- [ ] b");
    await advance(700);
    expect(held).toHaveLength(1);
    await type("- [x] a\n- [x] b");
    await advance(700);
    await type("- [ ] a\n- [x] b");
    await act(async () => hide());
    await settle();
    expect(server.markdown).toBe("- [ ] a\n- [x] b");

    // The first request dies on the wire and is retried; the queue moves on.
    holdOrdinary = false;
    await act(async () => held.shift()?.fail());
    for (let second = 0; second < 10; second += 1) await advance(1_000);

    // The owner's untick of a was never undone by a merge of an older body.
    expect(history).not.toContain("- [x] a\n- [x] b");
    expect(server.markdown).toBe("- [ ] a\n- [x] b");
    expect(document.body.textContent).not.toContain("Save a copy");
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

  it("keeps retrying a failing save with backoff while the tab lives, and says so", async () => {
    await open();
    // Two whole rounds of three attempts fail; the third round gets through.
    failingPuts = 6;
    await type("Text the server refused for a while");
    await advance(700);
    await advance(1_500);
    await advance(1_500);
    await flushFrames();
    expect(puts).toHaveLength(3);
    expect(document.body.textContent).toContain("Couldn't save. Your draft is safe.");

    // Backed off: nothing for a few seconds, then the next round by itself.
    await advance(4_000);
    expect(puts).toHaveLength(3);
    for (let second = 0; second < 40 && server.markdown === "Base"; second += 1) {
      await advance(1_000);
    }
    expect(puts.length).toBeGreaterThanOrEqual(7);
    expect(server.markdown).toBe("Text the server refused for a while");
    expect(drafts()).toEqual([]);
  });

  it("a save that lands cancels the retry a failure scheduled", async () => {
    await open();
    failingPuts = 3;
    await type("First");
    await advance(700);
    await advance(1_500);
    await advance(1_500);
    expect(puts).toHaveLength(3);
    // A retry is now due 5 s after the failure. The next edit saves first.
    await type("First and second");
    await advance(700);
    expect(server.markdown).toBe("First and second");
    const afterSuccess = puts.length;
    // Typed so its own debounce ends just after the retry would have fired.
    await advance(3_900);
    await type("First and second and third");
    await advance(500);
    expect(puts).toHaveLength(afterSuccess);
    await advance(300);
    expect(server.markdown).toBe("First and second and third");
  });

  it("does not retry a refusal that a retry cannot change", async () => {
    await open();
    apiFetchMock.mockImplementation((input, init) => {
      if (String(input) === "/api/page/note" && init?.method === "PUT") {
        puts.push({ keepalive: false, body: {}, bytes: 0 });
        return Promise.resolve(
          response({ error: "refused", message: "That body is refused." }, 422),
        );
      }
      return Promise.resolve(response({ tasks: [], notifications: [], unread: 0 }));
    });
    await type("A body the server refuses");
    await advance(700);
    expect(puts).toHaveLength(1);
    for (let second = 0; second < 30; second += 1) await advance(1_000);
    expect(puts).toHaveLength(1);
  });
});
