// @vitest-environment jsdom

import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { apiFetch } from "@/lib/client";
import { Shell } from "./shell";
// warm the settings-surface module so its dynamic import resolves from the
// cache under fake timers (see the next/dynamic mock)
import "./settings/settings-surface";

type EditorProps = {
  value: string;
  onChange: (markdown: string) => void;
};

const editorHarness = vi.hoisted(() => ({
  props: null as EditorProps | null,
}));

const presenceHarness = vi.hoisted(() => ({
  waitKeys: [] as string[],
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

// The editor stays a harness stub; the settings surface resolves for real
// (its module is imported statically below, so the dynamic import() hits a
// warm cache and resolves in a microtask even under fake timers).
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    if (String(loader).includes("settings-surface")) {
      let Resolved: React.ComponentType<Record<string, unknown>> | null = null;
      return function SettingsSurfaceStub(props: Record<string, unknown>) {
        const [, force] = useReducer((n: number) => n + 1, 0);
        useEffect(() => {
          if (Resolved) return;
          void Promise.resolve(loader()).then((mod) => {
            Resolved = mod as React.ComponentType<Record<string, unknown>>;
            force();
          });
        }, []);
        return Resolved ? <Resolved {...props} /> : null;
      };
    }
    return function FakeEditor(props: EditorProps) {
      editorHarness.props = props;
      return <div data-testid="fake-editor">{props.value}</div>;
    };
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    AnimatePresence: ({ children, mode }) => {
      const child = children as { key?: string | null } | null;
      if (mode === "wait" && typeof child?.key === "string") {
        presenceHarness.waitKeys.push(child.key);
      }
      return children;
    },
  });
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
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

describe("Shell page transitions", () => {
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
    presenceHarness.waitKeys = [];
    apiFetchMock.mockReset();
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

  it("does not save the old editor body under the newly selected page", async () => {
    apiFetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/page/page-a") {
        return response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    const tree = [treeNode("page-a", "Page A"), treeNode("page-b", "Page B")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();

    expect(container.querySelector("[data-testid='fake-editor']")?.textContent).toBe(
      "Body A",
    );
    const oldEditorChange = editorHarness.props?.onChange;
    expect(oldEditorChange).toBeTypeOf("function");

    await act(async () => {
      window.history.pushState({}, "", "/p/page-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // Page B loads on the queued frame. Before that frame, page A must not stay
    // editable and its captured callback must be unable to create B's draft.
    expect(container.querySelector("[data-testid='fake-editor']")).toBeNull();
    await act(async () => oldEditorChange?.("Body A typed during navigation"));
    await act(async () => vi.advanceTimersByTime(800));
    await settle();

    expect(localStorage.getItem("brain-draft-v2:page-b:test-client")).toBeNull();
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/page/page-b" && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("uses a fresh presence identity when navigation returns A to B to A", async () => {
    apiFetchMock.mockImplementation(async (input) => {
      const id = String(input).replace("/api/page/", "");
      if (id === "page-a" || id === "page-b") {
        return response({
          meta: { title: `Page ${id.at(-1)?.toUpperCase()}`, stickers: [] },
          markdown: `Body ${id.at(-1)?.toUpperCase()}`,
          rev: `rev-${id}`,
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    const tree = [treeNode("page-a", "Page A"), treeNode("page-b", "Page B")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();

    await act(async () => {
      window.history.pushState({}, "", "/p/page-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      window.history.pushState({}, "", "/p/page-a");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(presenceHarness.waitKeys).toEqual(
      expect.arrayContaining(["page:page-a:0", "page:page-b:1", "page:page-a:2"]),
    );
  });

  it("resolves a cold page inside one canvas mount: skeleton to body without re-keying", async () => {
    const pageB = deferred<Response>();
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/page/page-a") {
        return response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        });
      }
      if (url === "/api/page/page-b") return pageB.promise;
      throw new Error(`Unexpected request: ${url}`);
    });

    const tree = [treeNode("page-a", "Page A"), treeNode("page-b", "Page B")];
    await act(async () =>
      root.render(<Shell tree={tree} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();

    await act(async () => {
      window.history.pushState({}, "", "/p/page-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flushAnimationFrames();

    // Cold: the canvas for B is mounted and shows the skeleton inside it.
    const canvasKeysWhileCold = new Set(presenceHarness.waitKeys);
    expect(canvasKeysWhileCold.has("page:page-b:1")).toBe(true);
    const frame = container.querySelector(".brain-page-frame");
    expect(frame).not.toBeNull();
    expect(frame?.querySelector(".animate-pulse")).not.toBeNull();
    expect(frame?.querySelector(".brain-page-body")).toBeNull();

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

    // Resolved: the same presence child (no new canvas key) now carries the
    // body and the skeleton has left it.
    expect(new Set(presenceHarness.waitKeys)).toEqual(canvasKeysWhileCold);
    expect(presenceHarness.waitKeys.at(-1)).toBe("page:page-b:1");
    const resolvedFrame = container.querySelector(".brain-page-frame");
    expect(resolvedFrame?.querySelector(".brain-page-body")).not.toBeNull();
    expect(
      resolvedFrame?.querySelector(".brain-page-body [data-testid='fake-editor']")
        ?.textContent,
    ).toBe("Body B");
    expect(resolvedFrame?.querySelector(".animate-pulse")).toBeNull();
  });

  it("paints an SSR-seeded page at once and still revalidates it", async () => {
    const revalidation = deferred<Response>();
    apiFetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/page/page-a") return revalidation.promise;
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[treeNode("page-a", "Page A")]}
          initialSelectedId="page-a"
          initialPage={{
            id: "page-a",
            meta: { title: "Page A", stickers: [] },
            markdown: "Seeded A",
            rev: "rev-a",
          }}
        />,
      ),
    );

    // Before the load effect's frame: content, no skeleton.
    const frame = container.querySelector(".brain-page-frame");
    expect(frame?.querySelector(".animate-pulse")).toBeNull();
    expect(
      frame?.querySelector(".brain-page-body [data-testid='fake-editor']")
        ?.textContent,
    ).toBe("Seeded A");

    await flushAnimationFrames();
    const gets = apiFetchMock.mock.calls.filter(
      ([input, init]) =>
        String(input) === "/api/page/page-a" && init?.method === undefined,
    );
    expect(gets).toHaveLength(1);

    await act(async () => {
      revalidation.resolve(
        response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Server A",
          rev: "rev-a2",
        }),
      );
      await revalidation.promise;
    });
    await settle();
    expect(
      container.querySelector("[data-testid='fake-editor']")?.textContent,
    ).toBe("Server A");
  });

  it("uses a fresh presence identity when navigation returns hub to page to hub", async () => {
    window.history.replaceState({}, "", "/");
    apiFetchMock.mockImplementation(async (input) => {
      if (String(input) === "/api/page/page-a") {
        return response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    await act(async () =>
      root.render(
        <Shell tree={[treeNode("page-a", "Page A")]} initialSelectedId={null} />,
      ),
    );
    await act(async () => {
      window.history.pushState({}, "", "/p/page-a");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(presenceHarness.waitKeys).toEqual(
      expect.arrayContaining(["hub:0", "page:page-a:1", "hub:2"]),
    );
  });

  it("uses a fresh presence identity when navigation returns mail to hub to mail", async () => {
    window.history.replaceState({}, "", "/mail");
    await act(async () =>
      root.render(
        <Shell
          tree={[treeNode("page-a", "Page A")]}
          initialSelectedId={null}
          initialSurface="mail"
        />,
      ),
    );

    await act(async () => {
      window.history.pushState({}, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      window.history.pushState({}, "", "/mail");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(presenceHarness.waitKeys).toEqual(
      expect.arrayContaining(["mail:0", "hub:1", "mail:2"]),
    );
  });

  it("awaits Settings revoke read-back before reporting sharing off", async () => {
    const readBack = deferred<Response>();
    const shared = { ...treeNode("page-a", "Page A"), public: true };
    const disabledScope = {
      rootId: "page-a",
      descendantCount: 0,
      overlappingRoots: [],
      scopeToken: "a".repeat(64),
      public: false,
      shareLocked: false,
      shareExpiresAt: null,
      shareVersion: 2,
    };
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/page-a") {
        return response({
          meta: { title: "Page A", stickers: [] },
          markdown: "Body A",
          rev: "rev-a",
        });
      }
      if (url === "/api/page/page-a/share" && init?.method === "POST") {
        return response(disabledScope);
      }
      if (url === "/api/page/page-a/share") return readBack.promise;
      if (url === "/api/tree") {
        return response({
          tree: [{ ...shared, public: undefined }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(<Shell tree={[shared]} initialSelectedId="page-a" />),
    );
    await flushAnimationFrames();
    await act(async () => {
      (
        container.querySelector(
          '[data-settings-trigger="desktop"]',
        ) as HTMLButtonElement
      ).click();
    });
    await settle();
    // the settings surface replaces the canvas at /settings/appearance;
    // the Sharing section is one sidebar-slot row away
    expect(window.location.pathname).toBe("/settings/appearance");
    const findSharingRow = () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[aria-label="Settings sections"] button',
        ),
      ].find((row) => row.textContent === "Sharing");
    for (let round = 0; round < 20 && !findSharingRow(); round += 1) {
      await settle();
    }
    await act(async () => findSharingRow()?.click());
    await settle();
    expect(window.location.pathname).toBe("/settings/sharing");
    let stop: HTMLButtonElement | null = null;
    for (let round = 0; round < 20 && !stop; round += 1) {
      await settle();
      stop = document.body.querySelector(
        '[aria-label="Stop sharing Page A"]',
      );
    }
    if (!stop) throw new Error("sharing section did not resolve");
    await act(async () => stop.click());
    expect(document.body.textContent).toContain("Stopping…");
    expect(document.body.textContent).not.toContain("Sharing is off");

    await act(async () => {
      readBack.resolve(response(disabledScope));
      await readBack.promise;
    });
    await settle();

    const shareCalls = apiFetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/page/page-a/share",
    );
    expect(shareCalls).toHaveLength(2);
    expect(shareCalls[0][1]?.method).toBe("POST");
    expect(shareCalls[1][1]?.method).toBeUndefined();
    expect(document.body.textContent).toContain("Sharing is off");
  });
});
