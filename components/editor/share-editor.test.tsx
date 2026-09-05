// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The editor itself is not under test here. The stub records what the island
// hands it, so a test can drive one change and read the capability set
// without mounting Milkdown.
const editorProps = vi.hoisted(() => ({
  current: null as null | {
    value: string;
    onChange: (md: string) => void;
    capabilities?: {
      upload?: { endpoint: string; fetcher?: typeof fetch; headers?: Record<string, string> };
      unfurl?: boolean;
      ai?: boolean;
    };
  },
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
vi.mock("./milkdown-editor", () => ({
  MilkdownEditor: (props: NonNullable<typeof editorProps.current>) => {
    editorProps.current = props;
    return <div data-editor>{props.value}</div>;
  },
}));

import ShareEditor, { SHARE_AUTOSAVE_DEBOUNCE_MS } from "./share-editor";
import { attachmentSrc } from "./attachment-src";

const VID = "vid123456789";
const REV = "abcdefabcdef";

type Seen = { url: string; method: string; vid: string | null };

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.useFakeTimers();
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
 *  in order, the GET answers the conflict re-read. */
function recordFetch(answers: {
  put: Array<() => Response>;
  get: () => Response;
}) {
  const seen: Seen[] = [];
  let puts = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    seen.push({
      url: typeof input === "string" ? input : String(input),
      method,
      vid: new Headers(init?.headers).get("x-brain-share-vid"),
    });
    if (method === "PUT") return (answers.put[puts++] ?? answers.put.at(-1)!)();
    if (method === "GET") return answers.get();
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

async function type(markdown: string) {
  await act(async () => {
    editorProps.current!.onChange(markdown);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
  });
}

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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000); // the retry wait inside saveMarkdown
    });
    // The upload capability goes through the same fetcher.
    const upload = editorProps.current!.capabilities!.upload!;
    await upload.fetcher!(upload.endpoint, { method: "POST", body: new FormData() });

    expect(seen.map((s) => s.method)).toEqual(["PUT", "GET", "PUT", "POST"]);
    for (const { url, vid } of seen) {
      expect(url.startsWith("/api/share-edit/"), url).toBe(true);
      expect(vid, url).toBe(VID);
    }
    expect(seen[0].url).toBe("/api/share-edit/page/page-9?root=root-1&v=2");
    expect(seen[3].url).toBe("/api/share-edit/upload?root=root-1&v=2&page=page-9");
    expect(upload.headers).toEqual({ "x-brain-share-vid": VID });
    expect(host.querySelector("[data-share-conflict]")).toBeNull();
  });

  it("gives the editor upload only: no unfurl, no AI", async () => {
    recordFetch({ put: [json({ rev: "b" }, 200)], get: json({}, 200) });
    await mount("");
    const capabilities = editorProps.current!.capabilities!;
    expect(Object.keys(capabilities)).toEqual(["upload"]);
    expect(capabilities.unfurl).toBeUndefined();
    expect(capabilities.ai).toBeUndefined();
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

    const banner = host.querySelector("[data-share-conflict]");
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toBe(
      "Someone else saved this page while you were writing. Your text is still here. Reload to see their version.Reload",
    );
    expect(host.querySelector("[data-editor]")?.textContent).toBe("mine, edited");
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Reload")!.click();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-editor]")?.textContent).toBe("mine, edited");
  });

  it("has no owner-only call site anywhere in the editor's own modules", async () => {
    // The mount test above only proves the paths taken. This proves the paths
    // that exist: every literal "/api/…" in components/editor must be either a
    // share-edit path or one of the four owner-only files the plan names, each
    // of which is behind a capability.
    const dir = import.meta.dirname;
    const allowed = new Set([
      "attachments.ts", // /api/upload — capabilities.upload
      "link-preview.ts", // /api/unfurl — capabilities.unfurl
      "floating-toolbar.tsx", // /api/ai — capabilities.ai
      "slash-menu.tsx", // /api/ai — capabilities.ai
    ]);
    const offenders: string[] = [];
    let scanned = 0;
    for (const name of await fs.readdir(dir)) {
      if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
      scanned += 1;
      const source = await fs.readFile(path.join(dir, name), "utf8");
      const hits = source.match(/["'`]\/api\/[a-z-]+/g) ?? [];
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
