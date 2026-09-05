// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDraft } from "@/lib/autosave";

// The editor itself is not under test here. The stub records what the island
// hands it, so a test can drive one change, register a flush and read the
// capability set without mounting Milkdown.
type StubProps = {
  value: string;
  onChange: (md: string) => void;
  registerFlush?: (flush: () => void) => () => void;
  capabilities?: {
    upload?: {
      endpoint: string;
      fetcher?: typeof fetch;
      headers?: Record<string, string>;
      onUploaded?: () => void;
    };
    unfurl?: boolean;
    ai?: boolean;
    createPage?: boolean;
  };
};
const editorProps = vi.hoisted(() => ({ current: null as null | StubProps }));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
vi.mock("./milkdown-editor", () => ({
  MilkdownEditor: (props: StubProps) => {
    editorProps.current = props;
    return <div data-editor>{props.value}</div>;
  },
}));

import ShareEditor, {
  SHARE_AUTOSAVE_DEBOUNCE_MS,
  SHARE_CONFLICT_COPY,
  SHARE_GONE_COPY,
  SHARE_UNSAVED_COPY,
  shareDraftKey,
} from "./share-editor";
import { attachmentSrc, noteAttachmentLoadFailure } from "./attachment-src";

const VID = "vid123456789";
const REV = "abcdefabcdef";
const PAGE_URL = "/api/share-edit/page/page-9?root=root-1&v=2";
const DRAFT_KEY = shareDraftKey("root-1", "page-9");

type Seen = {
  url: string;
  method: string;
  vid: string | null;
  keepalive: boolean;
  body: string | null;
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  editorProps.current = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Records every request and answers by method: `put` is consulted per PUT
 *  in order (the last one repeats), the GET answers the conflict re-read. */
function recordFetch(answers: { put: Array<() => Response>; get?: () => Response }) {
  const seen: Seen[] = [];
  let puts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    seen.push({
      url: typeof input === "string" ? input : String(input),
      method,
      vid: new Headers(init?.headers).get("x-brain-share-vid"),
      keepalive: init?.keepalive === true,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (method === "PUT") return (answers.put[puts++] ?? answers.put.at(-1)!)();
    if (method === "GET") return (answers.get ?? json({}, 200))();
    return new Response(JSON.stringify({ name: "n", url: "/_attachments-v2/n.png" }), {
      status: 200,
    });
  });
  return seen;
}

const json = (body: unknown, status: number) => () =>
  new Response(JSON.stringify(body), { status });

async function mount(initialMarkdown: string, onReload?: () => void) {
  await act(async () => {
    root.render(
      <ShareEditor
        rootId="root-1"
        pageId="page-9"
        shareVersion={2}
        vid={VID}
        initialMarkdown={initialMarkdown}
        initialRev={REV}
        onReload={onReload}
      />,
    );
  });
}

async function change(markdown: string) {
  await act(async () => {
    editorProps.current!.onChange(markdown);
  });
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function type(markdown: string) {
  await change(markdown);
  await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
}

const editorText = () => host.querySelector("[data-editor]")?.textContent;
const banner = () => host.querySelector<HTMLElement>("[data-share-save-state]");

describe("the visitor editor", () => {
  it("sends every request it makes to /api/share-edit/, with the vid header", async () => {
    // First PUT is stale, the re-read shows the visitor's own text already
    // landed, the retry PUT succeeds: three requests on one route.
    const seen = recordFetch({
      put: [json({ error: "conflict", currentRev: "b" }, 409), json({ rev: "c" }, 200)],
      get: json({ markdown: "hello, edited", rev: "b", title: "T" }, 200),
    });
    await mount("hello");
    await type("hello, edited");
    await elapse(2000); // the retry wait inside saveMarkdown
    // The upload capability goes through the same fetcher.
    const upload = editorProps.current!.capabilities!.upload!;
    await upload.fetcher!(upload.endpoint, { method: "POST", body: new FormData() });

    expect(seen.map((s) => s.method)).toEqual(["PUT", "GET", "PUT", "POST"]);
    for (const { url, vid } of seen) {
      expect(url.startsWith("/api/share-edit/"), url).toBe(true);
      expect(vid, url).toBe(VID);
    }
    expect(seen[0].url).toBe(PAGE_URL);
    expect(seen[3].url).toBe("/api/share-edit/upload?root=root-1&v=2&page=page-9");
    expect(upload.headers).toEqual({ "x-brain-share-vid": VID });
    expect(banner()).toBeNull();
  });

  it("gives the editor upload only: no unfurl, no AI, no page creation", async () => {
    recordFetch({ put: [json({ rev: "b" }, 200)] });
    await mount("");
    const capabilities = editorProps.current!.capabilities!;
    expect(Object.keys(capabilities)).toEqual(["upload"]);
    expect(capabilities.unfurl).toBeUndefined();
    expect(capabilities.ai).toBeUndefined();
    expect(capabilities.createPage).toBeUndefined();
    expect(typeof capabilities.upload!.onUploaded).toBe("function");
  });

  it("renders a bare attachment path with the access triple, and clears the resolver on unmount", async () => {
    await mount("");
    expect(attachmentSrc("/_attachments-v2/abc123456789.png")).toBe(
      "/api/media/abc123456789.png?root=root-1&page=page-9&v=2",
    );
    expect(attachmentSrc("https://example.com/x.png")).toBe("https://example.com/x.png");

    await act(async () => root.unmount());
    expect(attachmentSrc("/_attachments-v2/abc123456789.png")).toBe(
      "/_attachments-v2/abc123456789.png",
    );
    root = createRoot(host); // afterEach unmounts again harmlessly
  });

  it("shows the visitor's conflict banner, keeps the text, and reloads only on the press", async () => {
    // A stranger's body is on the server: the PUT is stale and the re-read
    // is neither the visitor's text nor their baseline.
    recordFetch({
      put: [json({ error: "conflict", currentRev: "f" }, 409)],
      get: json({ markdown: "theirs", rev: "f", title: "T" }, 200),
    });
    const reload = vi.fn();
    await mount("mine", reload);
    await type("mine, edited");

    expect(banner()?.dataset.shareSaveState).toBe("conflict");
    expect(banner()?.getAttribute("role")).toBe("status");
    expect(banner()?.textContent).toBe(`${SHARE_CONFLICT_COPY}Reload`);
    expect(editorText()).toBe("mine, edited");
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();

    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload")!.click();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(editorText()).toBe("mine, edited");
    // The press means "show me their version": the draft would otherwise be
    // restored on the reload and put the same conflict straight back.
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  describe("a save that fails for any other reason", () => {
    it("says so, keeps the text, and clears once a later save lands", async () => {
      recordFetch({
        put: [json({ error: "share_edit_rate" }, 429), json({ error: "x" }, 500), json({ error: "x" }, 503), json({ rev: "b" }, 200)],
      });
      await mount("mine");
      await type("mine, edited");
      await elapse(5000); // saveMarkdown's own retries on 429 and 5xx

      expect(banner()?.dataset.shareSaveState).toBe("unsaved");
      expect(banner()?.textContent).toBe(SHARE_UNSAVED_COPY);
      expect(banner()?.querySelector("button")).toBeNull();
      expect(editorText()).toBe("mine, edited");

      await type("mine, edited more");
      expect(banner()).toBeNull();
    });

    it("tells the visitor the link no longer edits on the guard's 404", async () => {
      recordFetch({ put: [json({ error: "not found" }, 404)] });
      await mount("mine");
      await type("mine, edited");

      expect(banner()?.dataset.shareSaveState).toBe("gone");
      expect(banner()?.textContent).toBe(SHARE_GONE_COPY);
      expect(banner()?.querySelector("button")).toBeNull();
      expect(editorText()).toBe("mine, edited");
    });
  });

  describe("the pending save", () => {
    it("is written to a local draft on every change and removed once the server confirms it", async () => {
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await change("hello, edited");

      const raw = localStorage.getItem(DRAFT_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toMatchObject({
        markdown: "hello, edited",
        revision: REV,
        baseMarkdown: "hello",
      });

      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it("keeps the draft when the save did not land", async () => {
      recordFetch({ put: [json({ error: "x" }, 500)] });
      await mount("hello");
      await type("hello, edited");
      await elapse(5000);
      expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toMatchObject({
        markdown: "hello, edited",
      });
    });

    it("is flushed through the editor the moment the tab hides, ahead of the debounce", async () => {
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      const editorFlush = vi.fn(() => editorProps.current!.onChange("hello, edited"));
      editorProps.current!.registerFlush!(editorFlush);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(editorFlush).toHaveBeenCalledTimes(1);
      expect(seen.map((s) => [s.method, s.keepalive])).toEqual([["PUT", false]]);
      expect(JSON.parse(seen[0].body!)).toMatchObject({ markdown: "hello, edited", rev: REV });
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
      expect(seen).toHaveLength(1); // the debounced save was the one flushed
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it("is sent with keepalive on pagehide and the draft stays until confirmed", async () => {
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await change("hello, edited");
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(seen.map((s) => [s.method, s.url, s.keepalive])).toEqual([["PUT", PAGE_URL, true]]);
      expect(seen[0].vid).toBe(VID);
      expect(JSON.parse(seen[0].body!)).toMatchObject({ markdown: "hello, edited", rev: REV });
      expect(localStorage.getItem(DRAFT_KEY)).not.toBeNull();
    });

    it("is flushed on the next change after an upload, and a failed image is retried once the save lands", async () => {
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      const img = document.createElement("img");
      document.body.append(img);
      noteAttachmentLoadFailure(img, "/_attachments-v2/abc123456789.png");

      editorProps.current!.capabilities!.upload!.onUploaded!();
      await change("hello ![](/_attachments-v2/abc123456789.png)");
      await elapse(0);

      expect(seen.map((s) => s.method)).toEqual(["PUT"]);
      expect(
        img.getAttribute("src")?.startsWith(
          "/api/media/abc123456789.png?root=root-1&page=page-9&v=2",
        ),
        img.getAttribute("src") ?? "",
      ).toBe(true);
      img.remove();
    });
  });

  describe("a draft left by an earlier visit", () => {
    it("is put back and saved at once when the server has not moved", async () => {
      localStorage.setItem(DRAFT_KEY, encodeDraft("draft text", REV, "op-1", 1, "hello"));
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(0);

      expect(editorText()).toBe("draft text");
      expect(seen.map((s) => s.method)).toEqual(["PUT"]);
      expect(JSON.parse(seen[0].body!)).toMatchObject({ markdown: "draft text", rev: REV });
      expect(banner()).toBeNull();
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it("is put back behind the conflict banner when someone else saved meanwhile", async () => {
      localStorage.setItem(DRAFT_KEY, encodeDraft("draft text", "olderrev0000", "op-1", 1, "older body"));
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      const reload = vi.fn();
      await mount("theirs", reload);
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(editorText()).toBe("draft text");
      expect(banner()?.dataset.shareSaveState).toBe("conflict");
      expect(seen).toEqual([]);

      await act(async () => {
        [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload")!.click();
      });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it("is dropped when it is already what the server holds", async () => {
      localStorage.setItem(DRAFT_KEY, encodeDraft("hello\n", REV, "op-1", 1, "hello"));
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(editorText()).toBe("hello");
      expect(seen).toEqual([]);
      expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    });
  });

  it("has no owner-only path literal anywhere in the editor's own modules", async () => {
    // What this proves, and only this: every string literal in the files
    // directly under components/editor that starts with "/api/…" or
    // "/_attachments…" is either a share-edit path, a media path, or sits in
    // one of the files named below, each of which is behind a capability or
    // is the attachment-path authority itself. It is not recursive, it does
    // not follow imports into lib/ or components/ui, it reads comments as
    // well as code, and it cannot see a URL built from pieces. The mount
    // tests above cover the paths actually taken; this covers the ones that
    // exist as text.
    const dir = import.meta.dirname;
    const allowed = new Set([
      "attachments.ts", // /api/upload — capabilities.upload
      "link-preview.ts", // /api/unfurl — capabilities.unfurl
      "floating-toolbar.tsx", // /api/ai — capabilities.ai
      "slash-menu.tsx", // /api/ai — capabilities.ai
      "attachment-src.ts", // /_attachments-v2 — the resolver and its inverse
    ]);
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of await fs.readdir(dir)) {
      if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
      scanned += 1;
      const source = await fs.readFile(path.join(dir, name), "utf8");
      const hits = source.match(/["'`]\/(?:api\/[a-z-]+|_attachments(?:-v2)?)/g) ?? [];
      for (const hit of hits) {
        if (hit.includes("/api/share-edit") || hit.includes("/api/media")) continue;
        if (allowed.has(name)) continue;
        offenders.push(`${name}: ${hit}`);
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
