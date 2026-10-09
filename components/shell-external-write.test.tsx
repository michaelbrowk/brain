// @vitest-environment jsdom

// A WRITE TO THE OPEN PAGE FROM SOMEWHERE ELSE.
//
// Another device or an agent writes the page this tab shows. With nothing
// unsaved here, the new body goes into the live editor in place: no new
// editor, so the caret and the undo history stay (the editor half is
// `editor/external-write.test.ts`). With unsaved text here, the save meets
// the other version and the page is in conflict, and the conflict offers
// three ways out — Keep mine, Take theirs, Save a copy — after each of which
// the page saves again.
//
// The editor is a stand-in that counts its mounts, hands the shell the
// markdown it would have serialized and records what the shell applies to
// it. The server is a fake with the store's rule: a PUT writes when its rev
// or its base body is current, and is a 409 otherwise.

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { canonicalPageMarkdown } from "@/lib/page-markdown";
import { resetTasksStore } from "./tasks-client";
import { Shell } from "./shell";

type ExternalWrite = (
  markdown: string,
) => "applied" | "unchanged" | "refused" | "dirty";
type EditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onDirty?: () => void;
  registerFlush?: (flush: () => void) => (() => void) | void;
  registerExternalWrite?: (apply: ExternalWrite) => (() => void) | void;
};

const editorHarness = vi.hoisted(() => ({
  props: null as EditorProps | null,
  mounts: 0,
  applied: [] as string[],
  /** What the stand-in holds: its mount value, then each applied body. */
  holds: "",
  /** A keystroke the stand-in holds and has not serialized yet. The real
   *  editor hands it over before it applies anything. */
  unserialized: null as string | null,
  /** The editor cannot take a write in place (read-only, lossy parse). */
  refuse: false,
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor(props: EditorProps) {
      editorHarness.props = props;
      useEffect(() => {
        editorHarness.mounts += 1;
        editorHarness.holds = props.value;
        // Mount-only on purpose: a remount is what this file counts.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      useEffect(() => props.registerFlush?.(() => {}), [props]);
      useEffect(
        () =>
          props.registerExternalWrite?.((markdown) => {
            if (editorHarness.unserialized !== null) {
              const typed = editorHarness.unserialized;
              editorHarness.unserialized = null;
              editorHarness.holds = typed;
              props.onChange(typed);
              return "dirty";
            }
            if (editorHarness.refuse) return "refused";
            if (markdown === editorHarness.holds) return "unchanged";
            editorHarness.applied.push(markdown);
            editorHarness.holds = markdown;
            return "applied";
          }),
        [props],
      );
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
  const timestamp = "2026-10-09T08:00:00.000Z";
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

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}

describe("a write to the open page from somewhere else", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
  let server: { markdown: string; rev: number };
  let puts: Array<{ markdown?: string; rev?: string; baseMarkdown?: string }>;
  let posts: Array<{ title?: string; markdown?: string; parentId?: unknown }>;
  const apiFetchMock = vi.mocked(apiFetch);

  let heldPuts: Array<() => void>;
  let holdPuts: boolean;
  let heldGets: Array<() => void>;
  let holdGets: boolean;

  /** The store's rule: the rev or the base body is current, or a 409. */
  function writePut(body: { markdown?: string; rev?: string; baseMarkdown?: string }) {
    const base =
      body.baseMarkdown === undefined ? undefined : canonicalPageMarkdown(body.baseMarkdown);
    if (body.rev !== `rev-${server.rev}` && base !== server.markdown) {
      return response({ error: "conflict", currentRev: `rev-${server.rev}` }, 409);
    }
    commit(canonicalPageMarkdown(body.markdown ?? ""));
    return response({ markdown: server.markdown, rev: `rev-${server.rev}` });
  }

  function commit(markdown: string) {
    if (markdown === server.markdown) return;
    server = { markdown, rev: server.rev + 1 };
  }

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    localStorage.clear();
    editorHarness.props = null;
    editorHarness.mounts = 0;
    editorHarness.applied = [];
    editorHarness.holds = "";
    editorHarness.unserialized = null;
    editorHarness.refuse = false;
    heldPuts = [];
    holdPuts = false;
    heldGets = [];
    holdGets = false;
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
    FakeEventSource.last = null;
    vi.stubGlobal("EventSource", FakeEventSource);
    server = { markdown: "Base", rev: 1 };
    puts = [];
    posts = [];
    apiFetchMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/page/note") {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as (typeof puts)[number];
          puts.push(body);
          if (holdPuts) {
            holdPuts = false;
            // Answered with what the server holds when it is let through.
            return new Promise<Response>((resolve) =>
              heldPuts.push(() => resolve(writePut(body))),
            );
          }
          return Promise.resolve(writePut(body));
        }
        if (holdGets) {
          holdGets = false;
          return new Promise<Response>((resolve) =>
            heldGets.push(() =>
              resolve(
                response({
                  meta: { id: "note", title: "Note" },
                  markdown: server.markdown,
                  rev: `rev-${server.rev}`,
                }),
              ),
            ),
          );
        }
        return Promise.resolve(
          response({
            meta: { id: "note", title: "Note" },
            markdown: server.markdown,
            rev: `rev-${server.rev}`,
          }),
        );
      }
      if (url === "/api/page" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as (typeof posts)[number]);
        return Promise.resolve(response({ id: "copy" }));
      }
      if (url === "/api/page/copy") {
        return Promise.resolve(
          response({ meta: { id: "copy", title: "Note (recovered)" }, markdown: "", rev: "rev-c" }),
        );
      }
      if (url === "/api/tree") {
        return Promise.resolve(response({ tree: [node("note", "Note")] }));
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
  });

  async function settle() {
    for (let i = 0; i < 6; i += 1) {
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

  /** The store's event for a write this tab did not make. */
  async function writeElsewhere(markdown: string) {
    commit(markdown);
    await act(async () =>
      FakeEventSource.last?.onmessage?.({
        data: JSON.stringify({ type: "write", id: "note", rev: `rev-${server.rev}` }),
      } as MessageEvent<string>),
    );
    await settle();
    await flushFrames();
  }

  async function type(markdown: string) {
    await act(async () => {
      editorHarness.props?.onDirty?.();
      editorHarness.props?.onChange(markdown);
    });
  }

  async function advance(ms: number) {
    await act(async () => vi.advanceTimersByTime(ms));
    await settle();
  }

  function button(name: string) {
    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === name,
    );
  }

  async function press(name: string) {
    const target = button(name);
    if (!target) throw new Error(`no button ${name}`);
    await act(async () => target.click());
    await settle();
    await flushFrames();
    await advance(0);
  }

  function conflictShown() {
    return document.body.textContent?.includes("Page changed elsewhere") ?? false;
  }

  it("applies a clean external write to the live editor without a remount", async () => {
    await open("Base");
    expect(editorHarness.mounts).toBe(1);

    await writeElsewhere("Base, and a line from the phone");

    expect(editorHarness.applied).toEqual(["Base, and a line from the phone"]);
    expect(editorHarness.mounts).toBe(1);
    expect(puts).toHaveLength(0);

    // The next edit saves against the body it was applied over.
    await type("Base, and a line from the phone, and mine");
    await advance(800);
    expect(puts.at(-1)).toMatchObject({
      markdown: "Base, and a line from the phone, and mine",
      rev: "rev-2",
    });
    expect(server.markdown).toBe("Base, and a line from the phone, and mine");
  });

  it("puts a write that meets unsaved text in conflict, never under the writer", async () => {
    await open("Base");
    await type("Base, mine");
    await writeElsewhere("Base, theirs");
    expect(editorHarness.applied).toEqual([]);

    await advance(800);
    expect(server.markdown).toBe("Base, theirs");
    expect(conflictShown()).toBe(true);
    expect(button("Keep mine")).toBeDefined();
    expect(button("Take theirs")).toBeDefined();
    expect(button("Save a copy")).toBeDefined();
  });

  it("never applies a write while a keystroke still waits for its serialize", async () => {
    await open("Base");
    // The editor marks the page dirty on the keystroke; the Markdown follows
    // at the next idle moment (editor/deferred-serialize.ts).
    await act(async () => editorHarness.props?.onDirty?.());
    await writeElsewhere("Base, theirs");
    expect(editorHarness.applied).toEqual([]);
    expect(editorHarness.mounts).toBe(1);

    await act(async () => editorHarness.props?.onChange("Base, mine"));
    await advance(800);
    expect(server.markdown).toBe("Base, theirs");
    expect(conflictShown()).toBe(true);
  });

  it("hands over a keystroke typed while the previous save was out, then conflicts", async () => {
    await open("Base");
    await type("Base, one");
    holdPuts = true;
    await advance(800);
    expect(heldPuts).toHaveLength(1);
    // A key while that save is on the wire: the editor marks the page dirty
    // and holds the key until its next serialize.
    await act(async () => editorHarness.props?.onDirty?.());
    editorHarness.unserialized = "Base, one KEY";
    // The save lands, and with it the shell's dirty mark for the page goes.
    await act(async () => heldPuts.shift()!());
    await settle();
    expect(server.markdown).toBe("Base, one");

    await writeElsewhere("Base, one, theirs");
    expect(editorHarness.applied).toEqual([]);
    expect(editorHarness.mounts).toBe(1);
    expect(editorHarness.holds).toBe("Base, one KEY");

    await advance(800);
    expect(server.markdown).toBe("Base, one, theirs");
    expect(conflictShown()).toBe(true);
    expect(
      Object.keys(localStorage)
        .filter((key) => key.startsWith("brain-draft"))
        .map((key) => localStorage.getItem(key))
        .join(""),
    ).toContain("Base, one KEY");
  });

  async function inConflict() {
    await open("Base");
    await type("Base, mine");
    await writeElsewhere("Base, theirs");
    await advance(800);
    expect(conflictShown()).toBe(true);
  }

  /** After the way out, the page saves an ordinary edit again. */
  async function savesAgain(from: string) {
    const before = puts.length;
    await type(`${from} and more`);
    await advance(800);
    expect(puts.length).toBeGreaterThan(before);
    expect(server.markdown).toBe(`${from} and more`);
    expect(conflictShown()).toBe(false);
  }

  it("Keep mine writes the local text over the other version and saves again", async () => {
    await inConflict();
    await press("Keep mine");

    expect(server.markdown).toBe("Base, mine");
    expect(editorHarness.applied).toEqual([]);
    expect(editorHarness.mounts).toBe(1);
    expect(conflictShown()).toBe(false);
    await savesAgain("Base, mine");
  });

  it("Take theirs puts the other version into the editor in place and saves again", async () => {
    await inConflict();
    const putsBefore = puts.length;
    await press("Take theirs");

    expect(editorHarness.applied).toEqual(["Base, theirs"]);
    expect(editorHarness.mounts).toBe(1);
    expect(server.markdown).toBe("Base, theirs");
    expect(puts.length).toBe(putsBefore);
    expect(conflictShown()).toBe(false);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("brain-draft"))).toEqual(
      [],
    );
    await savesAgain("Base, theirs");
  });

  it("Save a copy keeps the local text as a new page, takes theirs and saves again", async () => {
    await inConflict();
    await press("Save a copy");

    expect(posts).toHaveLength(1);
    expect(posts[0].markdown).toBe("Base, mine");
    expect(editorHarness.applied).toEqual(["Base, theirs"]);
    expect(editorHarness.mounts).toBe(1);
    expect(server.markdown).toBe("Base, theirs");
    expect(window.location.pathname).toBe("/p/note");
    expect(conflictShown()).toBe(false);
    await savesAgain("Base, theirs");
  });

  function drafts() {
    return Object.keys(localStorage)
      .filter((key) => key.startsWith("brain-draft"))
      .map((key) => localStorage.getItem(key) ?? "");
  }

  /** Press a way out whose read of the other version is held, type while it
   *  is out, then let the read answer. */
  async function pressAndTypeDuringRead(name: string, typed: string) {
    holdGets = true;
    const target = button(name);
    if (!target) throw new Error(`no button ${name}`);
    await act(async () => target.click());
    await settle();
    expect(heldGets).toHaveLength(1);
    await type(typed);
    await act(async () => heldGets.shift()!());
    await settle();
    await flushFrames();
    await advance(0);
  }

  it("Take theirs keeps text typed while it read the other version", async () => {
    await inConflict();
    await pressAndTypeDuringRead("Take theirs", "Base, mine and typed during the read");

    expect(editorHarness.applied).toEqual([]);
    expect(conflictShown()).toBe(true);
    expect(drafts().join("")).toContain("Base, mine and typed during the read");
    expect(server.markdown).toBe("Base, theirs");
  });

  it("Save a copy keeps text typed while it read the other version", async () => {
    await inConflict();
    await pressAndTypeDuringRead("Save a copy", "Base, mine plus typed after the copy");

    expect(posts.map((post) => post.markdown)).toEqual(["Base, mine"]);
    expect(editorHarness.applied).toEqual([]);
    expect(conflictShown()).toBe(true);
    expect(drafts().join("")).toContain("Base, mine plus typed after the copy");
  });
});
