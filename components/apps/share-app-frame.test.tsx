// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { apiFetch } from "@/lib/client";
import { ShareAppFrame } from "./share-app-frame";

// The factory is hoisted above every const in this file, so the double is
// made inside it and read back through `vi.mocked`.
vi.mock("@/lib/client", () => ({ apiFetch: vi.fn(), CLIENT_ID: "test-client" }));
const fetchMock = vi.mocked(apiFetch);

const answer = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

/** The address the share page's server component minted and handed over. It
 *  carries a token rather than a root and a version, because the frame's own
 *  requests for its files drop a query string on the way. */
const FRAME_SRC = "/api/app/app1/t/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhcHA6YXBwMSJ9.sig/index.html";

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(answer({ tree: [] }));
  sessionStorage.clear();
});

let host: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function mount() {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host as HTMLDivElement);
    root.render(
      <ShareAppFrame
        appId="app1"
        rootId="root1"
        shareVersion={2}
        src={FRAME_SRC}
        title="Trainer"
      />,
    );
  });
  const frame = (host as HTMLDivElement).querySelector("iframe") as HTMLIFrameElement;
  const posted: Record<string, unknown>[] = [];
  Object.defineProperty(frame.contentWindow as Window, "postMessage", {
    configurable: true,
    writable: true,
    value: (message: Record<string, unknown>) => posted.push(message),
  });
  return { frame, posted };
}

/** One request, spoken the way the frame speaks it: the host answers only a
 *  message whose `source` is the frame's own window, so the event carries it
 *  rather than a plain object. */
async function ask(
  frame: HTMLIFrameElement,
  request: Record<string, unknown>,
): Promise<void> {
  const event = new MessageEvent("message", { data: { v: 1, ...request } });
  Object.defineProperty(event, "source", { value: frame.contentWindow });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("a shared app", () => {
  it("mounts at the address it was given, and builds none of its own", () => {
    const { frame } = mount();
    // The token is the server's to cut. This island renders what it was
    // handed and nothing it worked out: a root and a version in a query
    // reached the entry and nothing under it, and a browser is the last place
    // to be deciding what a visitor may reach.
    expect(frame.getAttribute("src")).toBe(FRAME_SRC);
    expect(frame.getAttribute("src")).not.toContain("root=");
    expect(frame.getAttribute("src")).not.toContain("v=2");
    expect(frame.getAttribute("sandbox")).toBe(APP_FRAME_SANDBOX);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("title")).toBe("Trainer");
  });

  it("hides the read-only body the server drew behind it", () => {
    const { frame } = mount();
    expect(frame.closest("[data-share-app]")).not.toBeNull();
  });

  it("reads the tree through the visitor's own route", async () => {
    const { frame, posted } = mount();
    fetchMock.mockResolvedValue(answer({ tree: [{ id: "root1", parentId: null, title: "Spanish" }] }));
    await ask(frame, { rid: "r1", type: "read.tree" });
    expect(fetchMock).toHaveBeenCalledWith("/api/app-bridge/app1/share?root=root1&v=2");
    expect(posted).toEqual([
      { v: 1, rid: "r1", ok: true, data: { tree: [{ id: "root1", parentId: null, title: "Spanish" }] } },
    ]);
  });

  it("reads a page through the same route and no other", async () => {
    const { frame, posted } = mount();
    fetchMock.mockResolvedValue(answer({ meta: { id: "w1" }, markdown: "d", rev: "r" }));
    await ask(frame, { rid: "r2", type: "read.page", id: "w1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/app-bridge/app1/share?root=root1&v=2&page=w1",
    );
    expect(posted[0]).toMatchObject({ ok: true, data: { rev: "r" } });
  });

  it("says a page the share does not reach is not there", async () => {
    const { frame, posted } = mount();
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
    await ask(frame, { rid: "r3", type: "read.page", id: "outside" });
    expect(posted[0]).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses a write, and refuses a create, in the same sentence", async () => {
    const { frame, posted } = mount();
    await ask(frame, { rid: "w1", type: "write.page", id: "w", markdown: "x", rev: "r" });
    await ask(frame, { rid: "w2", type: "create.page", title: "Session", markdown: "" });
    expect(posted).toEqual([
      {
        v: 1,
        rid: "w1",
        ok: false,
        error: "this is a shared copy, so it cannot be changed",
        reason: "read_only",
      },
      {
        v: 1,
        rid: "w2",
        ok: false,
        error: "this is a shared copy, so it cannot be changed",
        reason: "read_only",
      },
    ]);
    // Nothing was even attempted: there is no write verb on the visitor's
    // route, and the island does not reach for one.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/api/app-bridge/app1/page");
    }
  });

  /** Deviation 3 of the plan head. The owner's disk never sees a stranger's
   *  progress, and the frame's own storage cannot hold it. */
  it("keeps the visitor's progress in this tab and nowhere else", async () => {
    const { frame, posted } = mount();
    await ask(frame, { rid: "s1", type: "state.set", json: { seen: 3 } });
    expect(posted[0]).toMatchObject({ ok: true, data: { ok: true } });
    expect(JSON.parse(sessionStorage.getItem("brain-app-state:app1") ?? "null")).toEqual({
      seen: 3,
    });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("/state");
    }
  });

  it("answers null to an app that has kept none", async () => {
    const { frame, posted } = mount();
    await ask(frame, { rid: "s0", type: "state.get" });
    expect(posted[0]).toMatchObject({ ok: true, data: { state: null } });
  });

  it("still remembers it when the visitor comes back to the page", async () => {
    const first = mount();
    await ask(first.frame, { rid: "s1", type: "state.set", json: { seen: 3 } });
    act(() => root?.unmount());
    root = null;
    host?.remove();

    const second = mount();
    await ask(second.frame, { rid: "s2", type: "state.get" });
    expect(second.posted[0]).toMatchObject({ ok: true, data: { state: { seen: 3 } } });
  });

  it("has no search to answer, and says so as an empty result", async () => {
    const { frame, posted } = mount();
    await ask(frame, { rid: "q1", type: "read.pages", query: "hola" });
    expect(posted[0]).toMatchObject({ ok: true, data: { hits: [] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries no em-dash in anything a visitor reads", async () => {
    const { frame } = mount();
    await ask(frame, { rid: "t1", type: "toast", text: "saved" });
    expect(host?.textContent ?? "").not.toContain("—");
  });
});
