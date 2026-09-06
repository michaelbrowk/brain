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
  onNavigate?: (id: string) => void;
  pages?: unknown;
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
/** The per-tab identity, faked: `@/lib/client` is process-wide, so the mock
 *  answers `CLIENT_ID` from here and a test changes it between mounts to
 *  play a second tab. An island captures the id once, on its first render. */
const tab = vi.hoisted(() => ({ id: "tab-main" }));

vi.mock("@/lib/client", () => ({
  get CLIENT_ID() {
    return tab.id;
  },
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));
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
  SHARE_DRAFT_MAX_AGE_MS,
  SHARE_GONE_COPY,
  SHARE_HEARTBEAT_MS,
  SHARE_HEARTBEAT_STALE_MS,
  SHARE_PARKED_MAX,
  SHARE_REFUSED_COPY,
  SHARE_REFUSED_TAIL,
  SHARE_DISCARD_CONFIRM_COPY,
  SHARE_STORAGE_FULL_COPY,
  SHARE_UNSAVED_COPY,
  shareAliveKey,
  shareEditingCopy,
  shareRecoveryCopy,
  shareDraftKey,
  shareDraftPrefix,
  shareRecoveryKey,
  shareRecoveryPrefix,
} from "./share-editor";
import { attachmentSrc, noteAttachmentLoadFailure } from "./attachment-src";
import { pageRefHref } from "./page-ref";

const VID = "vid123456789";
const REV = "abcdefabcdef";
const PAGE_URL = "/api/share-edit/page/page-9?root=root-1&v=2";
const PREFIX = shareDraftPrefix("root-1", 2, "page-9");
const RECOVERY_PREFIX = shareRecoveryPrefix("root-1", 2, "page-9");
const ownKey = () => shareDraftKey("root-1", 2, "page-9", tab.id);
const recoveryKey = (id = tab.id) => shareRecoveryKey("root-1", 2, "page-9", id);
const DAY = 24 * 60 * 60 * 1000;

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
  vi.setSystemTime(new Date("2026-09-06T10:00:00Z"));
  tab.id = "tab-main";
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

type Answer = () => Response | Promise<Response>;

/** Records every request and answers by method: `put` is consulted per PUT
 *  in order (the last one repeats), the GET answers the conflict re-read. */
function recordFetch(answers: { put: Answer[]; get?: Answer }) {
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

/** A PUT that answers only when the test says so. */
function deferred(body: unknown, status: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer: Answer = () => gate.then(() => new Response(JSON.stringify(body), { status }));
  return { answer, release };
}

async function mount(
  initialMarkdown: string,
  onReload?: () => void,
  page: {
    pageId?: string;
    initialRev?: string;
    linkablePageIds?: readonly string[];
    onNavigate?: (href: string) => void;
  } = {},
) {
  await act(async () => {
    root.render(
      <ShareEditor
        rootId="root-1"
        pageId={page.pageId ?? "page-9"}
        shareVersion={2}
        vid={VID}
        visitorName="Ada"
        initialMarkdown={initialMarkdown}
        initialRev={page.initialRev ?? REV}
        onReload={onReload}
        linkablePageIds={page.linkablePageIds}
        onNavigate={page.onNavigate}
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

async function press(label: string) {
  await act(async () => {
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
  });
}

const editorText = () => host.querySelector("[data-editor]")?.textContent;
const banner = () => host.querySelector<HTMLElement>("[data-share-save-state]");
const recoveryBanner = () => host.querySelector<HTMLElement>("[data-share-recovery]");
const live = (which: "polite" | "assertive") =>
  host.querySelector<HTMLElement>(`[data-share-live="${which}"]`);
const puts = (seen: Seen[]) => seen.filter((s) => s.method === "PUT");
/** The two fields a test reasons about; the body also carries the base. */
const putBodies = (seen: Seen[]) =>
  puts(seen).map((s) => {
    const { markdown, rev } = JSON.parse(s.body!) as { markdown: string; rev: string };
    return { markdown, rev };
  });

function draftsUnder(prefix: string) {
  const found: Array<{ key: string; markdown: string }> = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)!;
    if (!key.startsWith(prefix)) continue;
    found.push({ key, markdown: JSON.parse(localStorage.getItem(key)!).markdown });
  }
  return found;
}

function parkedUnder(prefix: string) {
  const found: Array<{ key: string; markdown: string }> = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)!;
    if (!key.startsWith(prefix)) continue;
    for (const entry of JSON.parse(localStorage.getItem(key)!) as Array<{ markdown: string }>) {
      found.push({ key, markdown: entry.markdown });
    }
  }
  return found;
}

function seedParked(id: string, bodies: string[], updatedAt = Date.now(), prefix = RECOVERY_PREFIX) {
  localStorage.setItem(
    `${prefix}${id}`,
    JSON.stringify(bodies.map((markdown, i) => ({ markdown, updatedAt: updatedAt + i }))),
  );
}

/** Mounts a second island beside the first, as another tab would. */
function secondHost() {
  const other = document.createElement("div");
  document.body.append(other);
  const otherRoot = createRoot(other);
  return {
    async mount(initialMarkdown: string) {
      await act(async () => {
        otherRoot.render(
          <ShareEditor
            rootId="root-1"
            pageId="page-9"
            shareVersion={2}
            vid={VID}
            visitorName="Ada"
            initialMarkdown={initialMarkdown}
            initialRev={REV}
          />,
        );
      });
    },
    text: () => other.querySelector("[data-editor]")?.textContent,
    async unmount() {
      await act(async () => otherRoot.unmount());
      other.remove();
    },
  };
}

/** Storage that refuses some writes, the way a full quota does. */
function refuseWrites(when: (key: string, value: string) => boolean) {
  const real = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (when(key, value)) throw new DOMException("quota", "QuotaExceededError");
    real.call(this, key, value);
  });
}

function seedDraft(
  tab: string,
  markdown: string,
  revision: string,
  base: string,
  updatedAt = Date.now(),
  prefix = PREFIX,
) {
  localStorage.setItem(`${prefix}${tab}`, encodeDraft(markdown, revision, `op-${tab}`, updatedAt, base));
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

  it("points a page ref at the share for a page inside it, and nowhere for one outside", async () => {
    const moved: string[] = [];
    await mount("", undefined, {
      linkablePageIds: ["page-3", "root-1"],
      onNavigate: (href) => moved.push(href),
    });
    // The editor gets no page directory: titles come from the baked labels.
    expect(editorProps.current!.pages).toBeUndefined();
    expect(pageRefHref("page-3")).toBe("/share/root-1?page=page-3");
    expect(pageRefHref("root-1")).toBe("/share/root-1");
    expect(pageRefHref("elsewhere")).toBeNull();

    editorProps.current!.onNavigate!("page-3");
    editorProps.current!.onNavigate!("elsewhere");
    expect(moved).toEqual(["/share/root-1?page=page-3"]);

    await act(async () => root.unmount());
    expect(pageRefHref("page-3")).toBeNull();
    root = createRoot(host); // afterEach unmounts again harmlessly
  });

  describe("a conflict", () => {
    async function intoConflict(onReload?: () => void) {
      // A stranger's body is on the server: the PUT is stale and the re-read
      // is neither the visitor's text nor their baseline.
      const seen = recordFetch({
        put: [json({ error: "conflict", currentRev: "f" }, 409)],
        get: json({ markdown: "theirs", rev: "f", title: "T" }, 200),
      });
      await mount("mine", onReload);
      await type("mine, edited");
      expect(banner()?.dataset.shareSaveState).toBe("conflict");
      return seen;
    }

    it("shows the banner, keeps the text, and reloads only on the press", async () => {
      const reload = vi.fn();
      await intoConflict(reload);

      expect(live("assertive")?.textContent).toBe(`${SHARE_CONFLICT_COPY}Reload`);
      expect(banner()?.textContent).toBe(`${SHARE_CONFLICT_COPY}Reload`);
      expect(editorText()).toBe("mine, edited");
      expect(reload).not.toHaveBeenCalled();

      await press("Reload");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(editorText()).toBe("mine, edited");
    });

    it("parks the text under this tab's recovery slot on Reload, so the sentence stays true", async () => {
      await intoConflict(vi.fn());
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["mine, edited"]);

      await press("Reload");
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([{ key: recoveryKey(), markdown: "mine, edited" }]);
      expect(recoveryKey().endsWith(":tab-main")).toBe(true);
      // The draft would otherwise be restored on the reload and put the same
      // banner straight back.
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("keeps at most SHARE_PARKED_MAX parked bodies for the page, the oldest going first", async () => {
      const older = Array.from({ length: SHARE_PARKED_MAX }, (_, i) => `older ${i}`);
      await intoConflict(vi.fn());
      // Other tabs parked these earlier; they are read at park time.
      seedParked("tab-a", older.slice(0, 2), Date.now() - 100_000);
      seedParked("tab-b", older.slice(2), Date.now() - 50_000);
      await press("Reload");

      const kept = parkedUnder(RECOVERY_PREFIX).map((p) => p.markdown);
      expect(kept).toHaveLength(SHARE_PARKED_MAX);
      expect(kept).toContain("mine, edited");
      expect(kept).not.toContain("older 0");
      expect(kept).toEqual(expect.arrayContaining(older.slice(1)));
    });

    it("retries the slot smaller when storage refuses the write, down to the body being parked", async () => {
      const reload = vi.fn();
      await intoConflict(reload);
      await press("Reload"); // parks "mine, edited"; this host does not reload
      await change("mine, edited, and a good deal more text");
      // Room for one parked body under this slot, not two.
      refuseWrites((key, value) => key.startsWith(RECOVERY_PREFIX) && value.length > 100);
      await press("Reload");

      expect(parkedUnder(RECOVERY_PREFIX).map((p) => p.markdown)).toEqual([
        "mine, edited, and a good deal more text",
      ]);
      expect(reload).toHaveBeenCalledTimes(2);
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("still reloads when parking fails but the draft holds the text, and keeps that draft", async () => {
      const reload = vi.fn();
      await intoConflict(reload);
      refuseWrites((key) => key.startsWith(RECOVERY_PREFIX));
      await press("Reload");

      expect(reload).toHaveBeenCalledTimes(1);
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([]);
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["mine, edited"]);
    });

    it("tells the visitor and does not reload when neither the park nor the draft can be written", async () => {
      const reload = vi.fn();
      await intoConflict(reload);
      refuseWrites(() => true);
      await change("mine, edited, and more");
      await press("Reload");

      expect(reload).not.toHaveBeenCalled();
      expect(banner()?.dataset.shareSaveState).toBe("storage");
      expect(banner()?.textContent).toBe(`${SHARE_STORAGE_FULL_COPY}Reload anyway`);
      expect(editorText()).toBe("mine, edited, and more");
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([]);
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["mine, edited"]);

      // A deliberate second press, after copying the text out, does reload.
      await press("Reload anyway");
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("keeps an earlier parked body when the same tab parks again", async () => {
      // A host whose onReload does not reload: the second press must not
      // overwrite what the first one parked.
      await intoConflict(vi.fn());
      await press("Reload");
      await change("mine, edited, then more");
      await press("Reload");

      expect(parkedUnder(RECOVERY_PREFIX).map((p) => p.markdown)).toEqual([
        "mine, edited",
        "mine, edited, then more",
      ]);
    });

    it("stops saving: a later edit is kept as a draft, sent by neither the debounce nor pagehide", async () => {
      const seen = await intoConflict();
      const before = seen.length;

      await type("mine, edited again");
      await act(async () => {
        window.dispatchEvent(new Event("pagehide"));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(seen).toHaveLength(before);
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["mine, edited again"]);
      expect(editorText()).toBe("mine, edited again");
    });
  });

  describe("the parked text", () => {
    it("is offered back on the next mount and put back on the press, then saved", async () => {
      seedParked("tab-gone", ["parked"]);
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");

      expect(editorText()).toBe("theirs");
      expect(recoveryBanner()?.textContent).toBe(
        `${shareRecoveryCopy(Date.now(), 1)}Put it backDiscard`,
      );
      expect(seen).toEqual([]);

      await press("Put it back");
      await elapse(0);
      expect(editorText()).toBe("parked");
      expect(putBodies(seen)).toEqual([{ markdown: "parked", rev: REV }]);
      expect(recoveryBanner()).toBeNull();
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([]);
      await elapse(0);
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("keeps the text on the first Discard and asks before removing it", async () => {
      // The draft went when the conflicted reload parked this body, so the
      // parked entry is the only copy. One press must not destroy it.
      seedParked("tab-gone", ["parked"]);
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");

      await press("Discard");
      expect(recoveryBanner()?.textContent).toBe(
        `${SHARE_DISCARD_CONFIRM_COPY}Keep itDiscard for good`,
      );
      expect(parkedUnder(RECOVERY_PREFIX).map((p) => p.markdown)).toEqual(["parked"]);

      // Backing out leaves the offer as it was.
      await press("Keep it");
      expect(recoveryBanner()?.textContent).toBe(
        `${shareRecoveryCopy(Date.now(), 1)}Put it backDiscard`,
      );
      expect(parkedUnder(RECOVERY_PREFIX).map((p) => p.markdown)).toEqual(["parked"]);

      await press("Discard");
      await press("Discard for good");
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(editorText()).toBe("theirs");
      expect(recoveryBanner()).toBeNull();
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([]);
      expect(seen).toEqual([]);
    });

    it("says how old the text is and how many are queued behind it", async () => {
      // Up to SHARE_PARKED_MAX are offered one at a time with the same
      // sentence; without the age and the count both buttons are a guess.
      seedParked("tab-a", ["from a"], Date.now() - 20 * 60_000);
      seedParked("tab-b", ["from b"], Date.now() - 5 * 60_000);
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");

      expect(recoveryBanner()?.textContent).toContain("Your text from 5m ago is kept (1 of 2).");

      await press("Discard");
      await press("Discard for good");
      expect(recoveryBanner()?.textContent).toContain("Your text from 20m ago is kept.");
    });

    it("offers every parked body from every tab, newest first, one at a time", async () => {
      // Two tabs each reloaded out of a conflict; a third visit meets both.
      seedParked("tab-a", ["from a"], Date.now() - 60_000);
      seedParked("tab-b", ["from b"], Date.now() - 1_000);
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");

      expect(recoveryBanner()).not.toBeNull();
      await press("Put it back");
      await elapse(0);
      expect(editorText()).toBe("from b");
      expect(putBodies(seen).map((b) => b.markdown)).toEqual(["from b"]);

      expect(recoveryBanner()).not.toBeNull();
      await press("Discard");
      await press("Discard for good");
      expect(recoveryBanner()).toBeNull();
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([]);
    });

    it("belongs to one share version: a body parked under an earlier link is not offered", async () => {
      seedParked("tab-a", ["old link"], Date.now(), shareRecoveryPrefix("root-1", 1, "page-9"));
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");
      expect(recoveryBanner()).toBeNull();
      expect(editorText()).toBe("theirs");
    });

    it("is not offered once it is older than the bound", async () => {
      seedParked("tab-a", ["parked"], Date.now() - SHARE_DRAFT_MAX_AGE_MS - DAY);
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");
      expect(recoveryBanner()).toBeNull();
      expect(parkedUnder(RECOVERY_PREFIX)).toEqual([]);
    });

    it("comes before a resumed conflict: one banner at a time, the decision first", async () => {
      seedDraft("tab-a", "draft text", "olderrev0000", "older body");
      seedParked("tab-b", ["parked"]);
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("theirs");

      expect(editorText()).toBe("draft text");
      expect(recoveryBanner()).not.toBeNull();
      expect(banner()).toBeNull();

      await press("Discard");
      await press("Discard for good");
      expect(recoveryBanner()).toBeNull();
      expect(banner()?.dataset.shareSaveState).toBe("conflict");
    });
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

    it("shows what the route refused and what to do about it", async () => {
      // The write route names three refusals a visitor can act on and writes
      // the sentence for each. Nothing was written, so their text is theirs
      // to correct and a corrected save lands.
      recordFetch({
        put: [
          json(
            {
              error: "remote_media",
              message:
                "An image has to be uploaded here. One loaded from another site cannot be used.",
            },
            422,
          ),
          json({ rev: "b" }, 200),
        ],
      });
      await mount("mine");
      await type("mine, with a picture from elsewhere");

      expect(banner()?.dataset.shareSaveState).toBe("refused");
      expect(banner()?.textContent).toBe(
        `An image has to be uploaded here. One loaded from another site cannot be used. ${SHARE_REFUSED_TAIL}`,
      );
      // Typing will not clear this one, so it interrupts.
      expect(live("assertive")?.textContent).toContain("An image has to be uploaded here.");
      expect(editorText()).toBe("mine, with a picture from elsewhere");

      await type("mine, corrected");
      expect(banner()).toBeNull();
    });

    it("still says something when a refusal arrives with no message", async () => {
      recordFetch({ put: [json({ error: "bad request" }, 422)] });
      await mount("mine");
      await type("mine, edited");

      expect(banner()?.textContent).toBe(`${SHARE_REFUSED_COPY} ${SHARE_REFUSED_TAIL}`);
    });

    it("calls a conflict a conflict when their version cannot be read", async () => {
      // The PUT was refused as a conflict; a refresh GET that fails for any
      // other reason does not make it an ordinary failed save, and "keep
      // typing" would be the wrong instruction.
      recordFetch({
        put: [json({ error: "conflict" }, 409)],
        get: json({ error: "rate" }, 429),
      });
      await mount("mine");
      await type("mine, edited");

      expect(banner()?.dataset.shareSaveState).toBe("conflict");
      expect(banner()?.textContent).toBe(`${SHARE_CONFLICT_COPY}Reload`);
      expect(editorText()).toBe("mine, edited");
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

  it("says who is editing and that typing saves", async () => {
    // The read-only body and the editable body are identical, so without this
    // there is no moment at which the page says the state changed, and the
    // first signal the visitor gets is a failure.
    await mount("mine");

    expect(host.querySelector("[data-share-editing-as]")?.textContent).toBe(
      shareEditingCopy("Ada"),
    );
  });

  describe("what a screen reader is told", () => {
    it("holds both regions in the DOM from mount, empty", async () => {
      // A region created together with its first content is not reliably
      // announced, and this island has no other save feedback to fall back
      // on. The regions exist before there is anything to say.
      await mount("mine");

      expect(live("polite")?.getAttribute("role")).toBe("status");
      expect(live("polite")?.getAttribute("aria-live")).toBe("polite");
      expect(live("polite")?.textContent).toBe("");
      expect(live("assertive")?.getAttribute("role")).toBe("alert");
      expect(live("assertive")?.getAttribute("aria-live")).toBe("assertive");
      expect(live("assertive")?.textContent).toBe("");
    });

    it("interrupts for a revoked link and waits its turn for a failed save", async () => {
      recordFetch({ put: [json({ error: "not found" }, 404)] });
      await mount("mine");
      await type("mine, edited");

      expect(live("assertive")?.textContent).toBe(SHARE_GONE_COPY);
      expect(live("polite")?.textContent).toBe("");
    });

    it("keeps an ordinary failed save polite", async () => {
      recordFetch({ put: [json({ error: "server" }, 500)] });
      await mount("mine");
      await type("mine, edited");
      await elapse(5000); // saveMarkdown's own retries on 429 and 5xx

      expect(live("polite")?.textContent).toBe(SHARE_UNSAVED_COPY);
      expect(live("assertive")?.textContent).toBe("");
    });

    it("keeps a parked body's offer polite: it is a decision, not a failure", async () => {
      seedParked("tab-gone", ["parked"]);
      recordFetch({ put: [json({ rev: "r2" }, 200)] });
      await mount("mine");

      expect(live("polite")?.textContent).toContain("Put it back");
      expect(live("assertive")?.textContent).toBe("");
    });
  });

  describe("the pending save", () => {
    it("is written to this tab's draft on every change and removed once the server confirms it", async () => {
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await change("hello, edited");

      const raw = localStorage.getItem(ownKey());
      expect(raw).not.toBeNull();
      expect(ownKey().endsWith(":tab-main")).toBe(true);
      expect(JSON.parse(raw!)).toMatchObject({
        markdown: "hello, edited",
        revision: REV,
        baseMarkdown: "hello",
      });
      expect(JSON.parse(raw!).operationId).toMatch(/^[^:]+:[0-9a-f-]{36}$/);

      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("keeps the draft when the save did not land", async () => {
      recordFetch({ put: [json({ error: "x" }, 500)] });
      await mount("hello");
      await type("hello, edited");
      await elapse(5000);
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["hello, edited"]);
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
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("is not enqueued twice when the tab hides during the request", async () => {
      const put = deferred({ rev: "b" }, 200);
      const seen = recordFetch({ put: [put.answer] });
      await mount("hello");
      await type("hello, edited");
      expect(puts(seen)).toHaveLength(1);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        put.release();
        await vi.advanceTimersByTimeAsync(0);
      });
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(puts(seen)).toHaveLength(1);
      expect(draftsUnder(PREFIX)).toEqual([]);
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
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["hello, edited"]);
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
      seedDraft("tab-a", "draft text", REV, "hello");
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(0);

      expect(editorText()).toBe("draft text");
      expect(putBodies(seen)).toEqual([{ markdown: "draft text", rev: REV }]);
      expect(banner()).toBeNull();
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("keeps a newer edit's draft and pending when the restore save lands during it", async () => {
      // The restore PUT is in flight when the visitor types. The edit gets
      // its own id, so the response for the restore removes nothing of it.
      seedDraft("tab-a", "draft text", REV, "hello");
      const put = deferred({ rev: "b" }, 200);
      const seen = recordFetch({ put: [put.answer, json({ rev: "c" }, 200)] });
      await mount("hello");
      await elapse(0);
      expect(puts(seen)).toHaveLength(1);

      await change("draft text, newer");
      await act(async () => {
        put.release();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(draftsUnder(PREFIX)).toEqual([{ key: ownKey(), markdown: "draft text, newer" }]);

      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
      expect(putBodies(seen).map((b) => b.markdown)).toEqual(["draft text", "draft text, newer"]);
      expect(putBodies(seen)[1].rev).toBe("b");
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("is put back and saved when only the revision moved and the body did not", async () => {
      // A metadata-only rev bump (a rename, an icon) is not a stranger's edit.
      seedDraft("tab-a", "draft text", "olderrev0000", "hello");
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(0);

      expect(editorText()).toBe("draft text");
      expect(banner()).toBeNull();
      expect(putBodies(seen)).toEqual([{ markdown: "draft text", rev: REV }]);
    });

    it("is put back behind the conflict banner when someone else saved meanwhile", async () => {
      seedDraft("tab-a", "draft text", "olderrev0000", "older body");
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      const reload = vi.fn();
      await mount("theirs", reload);
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(editorText()).toBe("draft text");
      expect(banner()?.dataset.shareSaveState).toBe("conflict");
      expect(seen).toEqual([]);

      await press("Reload");
      expect(reload).toHaveBeenCalledTimes(1);
      expect(draftsUnder(PREFIX)).toEqual([]);
      expect(parkedUnder(RECOVERY_PREFIX).map((p) => p.markdown)).toEqual(["draft text"]);
    });

    it("is dropped when it is already what the server holds", async () => {
      seedDraft("tab-a", "hello\n", REV, "hello");
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(editorText()).toBe("hello");
      expect(seen).toEqual([]);
      expect(draftsUnder(PREFIX)).toEqual([]);
    });

    it("is not taken while the tab that holds it is still alive, and is once it stops", async () => {
      // Tab A is mid-edit and its own save hangs, so its draft stays. Tab B
      // opens the same link and must not pick up A's in-flight text: that
      // would save it and hand A a conflict with itself.
      const hanging = deferred({ rev: "b" }, 200);
      const seen = recordFetch({ put: [hanging.answer, json({ rev: "b" }, 200)] });
      tab.id = "tab-a";
      await mount("hello");
      await type("hello, a is typing");
      expect(puts(seen)).toHaveLength(1);
      expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["hello, a is typing"]);
      expect(localStorage.getItem(shareAliveKey("root-1", 2, "page-9", "tab-a"))).not.toBeNull();

      tab.id = "tab-b";
      const b = secondHost();
      await b.mount("hello");
      expect(b.text()).toBe("hello");
      await elapse(SHARE_HEARTBEAT_STALE_MS * 2);
      expect(puts(seen)).toHaveLength(1); // B sent nothing
      await b.unmount();

      // A goes away without its save landing: its beat stops. The next tab
      // takes the draft and saves it.
      await act(async () => root.unmount());
      root = createRoot(host);
      expect(localStorage.getItem(shareAliveKey("root-1", 2, "page-9", "tab-a"))).toBeNull();
      tab.id = "tab-c";
      await mount("hello");
      await elapse(0);
      expect(editorText()).toBe("hello, a is typing");
      expect(putBodies(seen).map((b) => b.markdown)).toEqual(["hello, a is typing", "hello, a is typing"]);
    });

    it("judges liveness by the beat's age, so a crashed tab's draft is taken and a fresh one is not", async () => {
      seedDraft("tab-x", "x text", REV, "hello");
      localStorage.setItem(
        shareAliveKey("root-1", 2, "page-9", "tab-x"),
        String(Date.now() - SHARE_HEARTBEAT_STALE_MS + 1_000),
      );
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      expect(editorText()).toBe("hello");

      await act(async () => root.unmount());
      root = createRoot(host);
      localStorage.setItem(
        shareAliveKey("root-1", 2, "page-9", "tab-x"),
        String(Date.now() - SHARE_HEARTBEAT_STALE_MS - 1_000),
      );
      await mount("hello");
      expect(editorText()).toBe("x text");
    });

    it("treats a beat from the future as stale, and sweeps it", async () => {
      // A clock glitch or a restored snapshot must not lock a slot forever.
      seedDraft("tab-x", "x text", REV, "hello");
      const aliveKey = shareAliveKey("root-1", 2, "page-9", "tab-x");
      localStorage.setItem(aliveKey, String(Date.now() + SHARE_HEARTBEAT_MS * 2));
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      expect(editorText()).toBe("x text");
      expect(localStorage.getItem(aliveKey)).toBeNull();

      // Within one interval ahead is clock skew, not a glitch: still alive.
      await act(async () => root.unmount());
      root = createRoot(host);
      seedDraft("tab-y", "y text", REV, "hello");
      localStorage.setItem(
        shareAliveKey("root-1", 2, "page-9", "tab-y"),
        String(Date.now() + SHARE_HEARTBEAT_MS / 2),
      );
      await mount("hello");
      expect(editorText()).not.toBe("y text");
    });

    it("beats while mounted and refreshes on every change", async () => {
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      const key = shareAliveKey("root-1", 2, "page-9", "tab-main");
      const first = Number(localStorage.getItem(key));
      expect(Number.isFinite(first)).toBe(true);
      await elapse(SHARE_HEARTBEAT_MS + 10);
      expect(Number(localStorage.getItem(key))).toBeGreaterThan(first);
      const beforeChange = Number(localStorage.getItem(key));
      await elapse(1_000);
      await change("hello, edited");
      expect(Number(localStorage.getItem(key))).toBeGreaterThan(beforeChange);
    });

    it("takes the newest of several tabs' drafts", async () => {
      seedDraft("tab-a", "older tab", REV, "hello", Date.now() - 60_000);
      seedDraft("tab-b", "newer tab", REV, "hello", Date.now() - 1_000);
      recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      expect(editorText()).toBe("newer tab");
    });

    it("belongs to one share version: a draft from before a rotation is not touched", async () => {
      seedDraft("tab-a", "old link text", REV, "hello", Date.now(), shareDraftPrefix("root-1", 1, "page-9"));
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);

      expect(editorText()).toBe("hello");
      expect(seen).toEqual([]);
    });

    it("is ignored and removed past the age bound, and kept inside it", async () => {
      seedDraft("tab-old", "stale", REV, "hello", Date.now() - SHARE_DRAFT_MAX_AGE_MS - DAY);
      const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
      await mount("hello");
      await elapse(SHARE_AUTOSAVE_DEBOUNCE_MS + 50);
      expect(editorText()).toBe("hello");
      expect(seen).toEqual([]);
      expect(draftsUnder(PREFIX)).toEqual([]);

      await act(async () => root.unmount());
      root = createRoot(host);
      seedDraft("tab-recent", "recent", REV, "hello", Date.now() - SHARE_DRAFT_MAX_AGE_MS + DAY);
      await mount("hello");
      expect(editorText()).toBe("recent");
    });
  });

  it("starts over when the page changes: nothing captured for one page reaches another", async () => {
    const seen = recordFetch({ put: [json({ rev: "b" }, 200)] });
    await mount("nine");
    await change("nine, edited");

    await mount("three", undefined, { pageId: "page-3", initialRev: "rev3rev3rev3" });
    expect(editorText()).toBe("three");
    await type("three, edited");

    expect(puts(seen).map((s) => s.url)).toEqual(["/api/share-edit/page/page-3?root=root-1&v=2"]);
    expect(putBodies(seen)).toEqual([{ markdown: "three, edited", rev: "rev3rev3rev3" }]);
    expect(attachmentSrc("/_attachments-v2/abc123456789.png")).toBe(
      "/api/media/abc123456789.png?root=root-1&page=page-3&v=2",
    );
    // Page 9's edit is not lost: it is its draft, for the next visit there.
    expect(draftsUnder(PREFIX).map((d) => d.markdown)).toEqual(["nine, edited"]);
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
