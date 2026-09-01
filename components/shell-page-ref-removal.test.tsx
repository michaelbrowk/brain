// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import type {
  PageRefNestingScope,
  PageRefNestingSource,
  ReparentPageRef,
} from "./editor/page-ref-nesting";
import { apiFetch } from "@/lib/client";
import { Shell } from "./shell";

type EditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onDirty?: () => void;
  registerFlush?: (flush: () => void) => (() => void) | void;
  mutationsFrozen?: boolean;
  pageRefNestingPending?: boolean;
  onReparentPageRef?: ReparentPageRef;
};

const editorHarness = vi.hoisted(() => ({
  props: null as EditorProps | null,
}));

type SortableTreeHarnessProps = {
  onMove: (
    id: string,
    newParentId: string | null,
    beforeId: string | null,
  ) => Promise<boolean>;
};

const sortableTreeHarness = vi.hoisted(() => ({
  props: null as SortableTreeHarnessProps | null,
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor(props: EditorProps) {
      editorHarness.props = props;
      useEffect(() => props.registerFlush?.(() => {}), [props]);
      const refs = [...props.value.matchAll(/\[([^\]]+)\]\(\/p\/([\w-]+)\)/g)];
      return (
        <div className="ProseMirror" tabIndex={0}>
          {refs.map((match, occurrence) => (
            <p
              key={`${match[2]}-${occurrence}`}
              className="brain-page-ref-only"
            >
              <a href={`/p/${match[2]}`} data-page-ref={match[2]} tabIndex={0}>
                {match[1]}
              </a>
            </p>
          ))}
        </div>
      );
    },
}));

vi.mock("./tree/sortable-tree", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./tree/sortable-tree")
  >();
  return {
    ...actual,
    SortableTree: (props: Parameters<typeof actual.SortableTree>[0]) => {
      sortableTreeHarness.props = props as unknown as SortableTreeHarnessProps;
      return createElement(actual.SortableTree, props);
    },
  };
});

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function node(
  id: string,
  title: string,
  parentId: string | null,
  children: TreeNode[] = [],
): TreeNode {
  const timestamp = "2026-07-30T08:00:00.000Z";
  return {
    id,
    parentId,
    title,
    order: id,
    created: timestamp,
    updated: timestamp,
    hasChildren: children.length > 0,
    children,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        button: 0,
      }),
    );
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  ) as HTMLButtonElement;
}

describe("Shell standalone page-ref removal", () => {
  let host: HTMLDivElement;
  let root: Root;
  let rafCallbacks: Map<number, FrameRequestCallback>;
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
    sortableTreeHarness.props = null;
    apiFetchMock.mockReset();
    window.history.replaceState({}, "", "/p/source");
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
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function flushFrames() {
    while (rafCallbacks.size) {
      const callbacks = [...rafCallbacks.values()];
      rafCallbacks.clear();
      await act(async () => callbacks.forEach((callback) => callback(0)));
      await settle();
    }
  }

  async function openRemoveDialog(ref: Element) {
    (ref as HTMLElement).focus();
    await act(async () => {
      ref.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      );
      ref.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      );
    });
    await settle();

    const removeMenuItem = [
      ...document.body.querySelectorAll('[role="menuitem"]'),
    ].find((item) => item.textContent?.trim() === "Remove reference");
    expect(removeMenuItem).toBeDefined();
    await act(async () => {
      (removeMenuItem as HTMLElement).focus();
      removeMenuItem!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
    await act(async () => vi.advanceTimersByTime(1));
    await flushFrames();
  }

  it("does not synthesize a missing child ref or trash the child after body edits", async () => {
    let markdown = "Plain body";
    let revision = 1;
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        markdown = (JSON.parse(String(init.body)) as { markdown: string }).markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    expect(editorHarness.props?.value).toBe("Plain body");

    await act(async () => editorHarness.props?.onChange("Edited body"));
    await act(async () => vi.advanceTimersByTime(700));
    await settle();

    expect(markdown).toBe("Edited body");
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/page/target" &&
          init?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("shows structural children for an empty doc without changing or saving Markdown", async () => {
    apiFetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown: "",
          rev: "rev-source-1",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              { ...node("first", "First child", "source"), icon: "1️⃣" },
              node("second", "Second child", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    await act(async () => vi.advanceTimersByTime(800));
    await settle();

    expect(editorHarness.props?.value).toBe("");
    expect(host.querySelector('section[aria-label="Subpages"]')).toBeNull();
    const derived = host.querySelector("[data-derived-page-refs]");
    expect(derived).not.toBeNull();
    expect(
      [...(derived?.querySelectorAll("a.brain-page-ref") ?? [])].map((link) => ({
        id: link.getAttribute("data-page-ref"),
        text: link.textContent,
        parent: link.parentElement?.classList.contains("brain-page-ref-only"),
      })),
    ).toEqual([
      { id: "first", text: "1️⃣ First child", parent: true },
      { id: "second", text: "📄 Second child", parent: true },
    ]);
    expect(derived?.querySelector("ul, ol, li, header, h2")).toBeNull();
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/page/source" && init?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("adopts the destination body after a successful same-client move", async () => {
    let moved = false;
    let destinationReads = 0;
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/destination") {
        destinationReads += 1;
        return response({
          meta: { id: "destination", title: "Destination", stickers: [] },
          markdown: moved ? "Destination\n\n[Source](/p/source)" : "Destination",
          rev: moved ? "rev-destination-2" : "rev-destination-1",
        });
      }
      if (url === "/api/move" && init?.method === "POST") {
        moved = true;
        return response({ ok: true });
      }
      if (url === "/api/tree") {
        return response({
          tree: [
            node("destination", "Destination", null, [
              node("source", "Source", "destination"),
            ]),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null),
            node("destination", "Destination", null),
          ]}
          initialSelectedId="destination"
        />,
      ),
    );
    await flushFrames();

    let saved = false;
    await act(async () => {
      saved =
        (await sortableTreeHarness.props?.onMove(
          "source",
          "destination",
          null,
        )) ?? false;
    });
    await flushFrames();

    expect(saved).toBe(true);
    expect(destinationReads).toBeGreaterThanOrEqual(2);
    expect(editorHarness.props?.value).toBe(
      "Destination\n\n[Source](/p/source)",
    );
  });

  it("does not confirm a timed-out move until tree and destination ref agree", async () => {
    let destinationReads = 0;
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown: "Source body",
          rev: "rev-source-1",
        });
      }
      if (url === "/api/move" && init?.method === "POST") {
        throw new Error("response lost");
      }
      if (url === "/api/tree") {
        return response({
          tree: [
            node("destination", "Destination", null, [
              node("source", "Source", "destination"),
            ]),
          ],
        });
      }
      if (url === "/api/page/destination") {
        destinationReads += 1;
        return response({
          meta: { id: "destination", title: "Destination", stickers: [] },
          markdown:
            destinationReads > 1 ? "[Source](/p/source)" : "Destination body",
          rev: `rev-destination-${destinationReads}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null),
            node("destination", "Destination", null),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();

    let moveResult: Promise<boolean> | undefined;
    await act(async () => {
      moveResult = sortableTreeHarness.props?.onMove(
        "source",
        "destination",
        null,
      );
      await Promise.resolve();
    });
    expect(destinationReads).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(350));
    await settle();
    await expect(moveResult).resolves.toBe(true);
    expect(destinationReads).toBe(2);
  });

  it("blocks a move into the open page when its pending draft cannot save", async () => {
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/destination" && init?.method === "PUT") {
        return response({}, 400);
      }
      if (url === "/api/page/destination") {
        return response({
          meta: { id: "destination", title: "Destination", stickers: [] },
          markdown: "Destination",
          rev: "rev-destination-1",
        });
      }
      if (url === "/api/tree") {
        return response({
          tree: [
            node("source", "Source", null),
            node("destination", "Destination", null),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null),
            node("destination", "Destination", null),
          ]}
          initialSelectedId="destination"
        />,
      ),
    );
    await flushFrames();
    await act(async () => {
      editorHarness.props?.onDirty?.();
      editorHarness.props?.onChange("Unsaved destination");
    });

    let saved = true;
    await act(async () => {
      saved =
        (await sortableTreeHarness.props?.onMove(
          "source",
          "destination",
          null,
        )) ?? true;
    });

    expect(saved).toBe(false);
    expect(document.body.textContent).toContain(
      "Couldn't save this page. Move cancelled.",
    );
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/move" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("accepts exact stale cleanup for a tree-scope sidebar retry", async () => {
    const sourceRef = "[Source](/p/source)";
    const nestBodies: Array<{
      scope?: PageRefNestingScope;
      sourceOccurrence?: number | null;
      sourceFingerprint?: string | null;
    }> = [];
    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/parent") {
        return response({
          meta: { id: "parent", title: "Parent", stickers: [] },
          markdown: sourceRef,
          rev: "rev-parent-1",
        });
      }
      if (url === "/api/page-ref/nest" && init?.method === "POST") {
        nestBodies.push(JSON.parse(String(init.body)));
        return response({
          removed: true,
          moved: { id: "source", title: "Source" },
          parent: {
            meta: { id: "parent", title: "Parent", stickers: [] },
            markdown: "",
            rev: "rev-parent-2",
          },
        });
      }
      if (url === "/api/tree") {
        return response({
          tree: [
            node("parent", "Parent", null),
            node("target", "Target", null, [node("source", "Source", "target")]),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("parent", "Parent", null),
            node("target", "Target", null, [node("source", "Source", "target")]),
          ]}
          initialSelectedId="parent"
        />,
      ),
    );
    await flushFrames();

    let request: ReturnType<ReparentPageRef> = null;
    await act(async () => {
      request = editorHarness.props?.onReparentPageRef?.(
        { id: "source", occurrence: 0 } satisfies PageRefNestingSource,
        "target",
        "tree",
      ) ?? null;
      await request?.result;
    });
    await settle();

    expect(request).not.toBeNull();
    expect(nestBodies).toEqual([
      expect.objectContaining({
        scope: "tree",
        sourceOccurrence: 0,
        sourceFingerprint: sourceRef,
      }),
    ]);
    expect(editorHarness.props?.value).toBe("");
  });

  it("removes only the selected duplicate after read-back and restores it around later text", async () => {
    const original = [
      "[First target](/p/target)",
      "Middle",
      "[Second target](/p/target)",
      "Tail",
    ].join("\n\n");
    const removed = [
      "[First target](/p/target)",
      "Middle",
      "Tail",
    ].join("\n\n");
    const final = `${original}\n\nLate text`;
    let markdown = original;
    let revision = 1;
    let deferRemovalReadBack = false;
    let deferRestoreReadBack = false;
    const removalReadBack = deferred<Response>();
    const restoreReadBack = deferred<Response>();

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        markdown = body.markdown;
        revision += 1;
        if (markdown === removed) deferRemovalReadBack = true;
        if (markdown === final) deferRestoreReadBack = true;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        if (deferRemovalReadBack) {
          deferRemovalReadBack = false;
          return removalReadBack.promise;
        }
        if (deferRestoreReadBack) {
          deferRestoreReadBack = false;
          return restoreReadBack.promise;
        }
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      if (url === "/api/tree") {
        return response({
          tree: [
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();

    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    expect(refs).toHaveLength(2);
    (refs[1] as HTMLElement).focus();
    await act(async () => {
      refs[1].dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      );
      refs[1].dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      );
    });
    await settle();

    const removeMenuItem = [
      ...document.body.querySelectorAll('[role="menuitem"]'),
    ].find((item) => item.textContent?.trim() === "Remove reference");
    expect(removeMenuItem).toBeDefined();
    await act(async () => {
      (removeMenuItem as HTMLElement).focus();
      removeMenuItem!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await settle();
    await act(async () => vi.advanceTimersByTime(1));
    await flushFrames();
    expect(document.body.textContent).toContain(
      "Remove reference to “Target”?",
    );
    expect(document.body.textContent).toContain(
      "The page itself will stay where it is.",
    );

    await click(button("Remove reference"));
    expect(document.body.textContent).toContain("Removing…");
    expect(document.body.textContent).not.toContain("Reference removed");
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/page/target" &&
          init?.method === "DELETE",
      ),
    ).toBe(false);
    expect(
      apiFetchMock.mock.calls.some(
        ([input]) => String(input) === "/api/page-ref/nest",
      ),
    ).toBe(false);
    expect(
      apiFetchMock.mock.calls.some(
        ([input]) => String(input) === "/api/move",
      ),
    ).toBe(false);

    await act(async () => {
      removalReadBack.resolve(
        response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown: removed,
          rev: `rev-${revision}`,
        }),
      );
      await removalReadBack.promise;
    });
    await settle();
    expect(document.body.textContent).toContain("Reference removed");
    expect(markdown).toBe(removed);

    await act(async () =>
      editorHarness.props?.onChange(`${removed}\n\nLate text`),
    );
    await click(button("Undo"));
    expect(editorHarness.props?.mutationsFrozen).toBe(true);
    await act(async () =>
      editorHarness.props?.onChange(`${removed}\n\nLate text\n\nRacing edit`),
    );
    await act(async () => vi.advanceTimersByTime(700));
    expect(markdown).toBe(final);

    await act(async () => {
      restoreReadBack.resolve(
        response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown: final,
          rev: `rev-${revision}`,
        }),
      );
      await restoreReadBack.promise;
    });
    await settle();
    await act(async () => vi.advanceTimersByTime(700));

    expect(markdown).toBe(final);
    expect(editorHarness.props?.mutationsFrozen).toBe(false);
    expect(
      apiFetchMock.mock.calls.some(([input, init]) => {
        if (String(input) !== "/api/page/source" || init?.method !== "PUT") {
          return false;
        }
        return String(init.body).includes("Racing edit");
      }),
    ).toBe(false);
    expect(document.body.textContent).not.toContain("Reference removed");
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/page/target" &&
          ["DELETE", "PATCH", "PUT"].includes(String(init?.method)),
      ),
    ).toBe(false);
  });

  it("recomputes removal from the reloaded body after a 409", async () => {
    const original = "Intro\n\n[Target](/p/target)\n\nTail";
    const firstAttempt = "Intro\n\nTail";
    const external = `External\n\n${original}`;
    const retried = "External\n\nIntro\n\nTail";
    let markdown = original;
    let revision = 1;
    let conflictNextRemoval = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (conflictNextRemoval) {
          conflictNextRemoval = false;
          markdown = external;
          revision += 1;
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    await openRemoveDialog(
      host.querySelector('a[data-page-ref="target"]') as Element,
    );

    await click(button("Remove reference"));
    expect(button("Retry")).toBeDefined();
    expect(editorHarness.props?.value).toBe(external);

    await click(button("Retry"));
    expect(putBodies).toEqual([firstAttempt, retried]);
    expect(markdown).toBe(retried);
    expect(document.body.textContent).toContain("Reference removed");
  });

  it("maps the confirmed occurrence when an identical ref is inserted before it", async () => {
    const original = [
      "[Same](/p/target)",
      "Between",
      "[Same](/p/target)",
      "Original tail",
    ].join("\n\n");
    const firstAttempt = [
      "[Same](/p/target)",
      "Between",
      "Original tail",
    ].join("\n\n");
    const concurrent = [
      "[Same](/p/target)",
      "Between",
      "[Same](/p/target)",
      "Inserted marker",
      "[Same](/p/target)",
      "Original tail",
    ].join("\n\n");
    const retried = [
      "[Same](/p/target)",
      "Between",
      "[Same](/p/target)",
      "Inserted marker",
      "Original tail",
    ].join("\n\n");
    let markdown = original;
    let revision = 1;
    let conflictNextRemoval = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (conflictNextRemoval) {
          conflictNextRemoval = false;
          markdown = concurrent;
          revision += 1;
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    await openRemoveDialog(refs[1]);

    await click(button("Remove reference"));
    expect(button("Retry")).toBeDefined();
    expect(editorHarness.props?.value).toBe(concurrent);

    await click(button("Retry"));
    expect(putBodies).toEqual([firstAttempt, retried]);
    expect(markdown).toBe(retried);
    expect(markdown).toContain(
      "[Same](/p/target)\n\nInserted marker\n\nOriginal tail",
    );
  });

  it("recomputes Undo from the refreshed body after a restore conflict", async () => {
    const original = "Intro\n\n[Target](/p/target)\n\nTail";
    const removed = "Intro\n\nTail";
    const externalRemoved = `External\n\n${removed}`;
    const retriedRestore = `External\n\n${original}`;
    let markdown = original;
    let revision = 1;
    let conflictFirstRestore = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (body.markdown === original && conflictFirstRestore) {
          conflictFirstRestore = false;
          markdown = externalRemoved;
          revision += 1;
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    await openRemoveDialog(
      host.querySelector('a[data-page-ref="target"]') as Element,
    );
    await click(button("Remove reference"));
    expect(markdown).toBe(removed);

    await click(button("Undo"));
    expect(document.body.textContent).toContain(
      "Couldn't restore reference",
    );
    expect(editorHarness.props?.value).toBe(externalRemoved);

    await click(button("Retry"));
    expect(putBodies).toEqual([removed, original, retriedRestore]);
    expect(markdown).toBe(retriedRestore);
    expect(document.body.textContent).not.toContain(
      "Couldn't restore reference",
    );
  });

  it("removes a broken standalone link without requiring its target in the tree", async () => {
    const original = "[Gone page](/p/missing)\n\nBody";
    const removed = "Body";
    let markdown = original;
    let revision = 1;

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        markdown = (
          JSON.parse(String(init.body)) as { markdown: string }
        ).markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[node("source", "Source", null)]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    await openRemoveDialog(
      host.querySelector('a[data-page-ref="missing"]') as Element,
    );

    expect(document.body.textContent).toContain(
      "Remove reference to “Gone page”?",
    );
    expect(document.body.textContent).toContain(
      "The referenced page may no longer exist; no page will be changed.",
    );
    await click(button("Remove reference"));

    expect(markdown).toBe(removed);
    expect(
      apiFetchMock.mock.calls.some(
        ([input, init]) =>
          String(input) === "/api/page/missing" &&
          ["DELETE", "PATCH", "PUT"].includes(String(init?.method)),
      ),
    ).toBe(false);
  });

  it("does not remove the next identical duplicate after a committed response-lost removal", async () => {
    const original = [
      "[Same](/p/target)",
      "Middle",
      "[Same](/p/target)",
      "Tail",
    ].join("\n\n");
    const removed = [
      "Middle",
      "[Same](/p/target)",
      "Tail",
    ].join("\n\n");
    const concurrent = `${removed}\n\nConcurrent edit`;
    let markdown = original;
    let revision = 1;
    let loseRemovalResponse = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (body.markdown === removed && loseRemovalResponse) {
          loseRemovalResponse = false;
          markdown = concurrent;
          revision += 2;
          throw new Error("response lost after commit");
        }
        if (body.markdown === removed && markdown === concurrent) {
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    await openRemoveDialog(refs[0]);

    await click(button("Remove reference"));
    expect(document.body.textContent).toContain("Removing…");
    await act(async () => vi.advanceTimersByTime(1_500));
    await settle();
    expect(button("Retry")).toBeDefined();
    expect(markdown).toBe(concurrent);

    await click(button("Retry"));
    expect(putBodies).toEqual([removed, removed]);
    expect(markdown).toBe(concurrent);
    expect([...markdown.matchAll(/\/p\/target/g)]).toHaveLength(1);
    expect(document.body.textContent).toContain("Reference removed");
  });

  it("fails closed when a surviving adjacent duplicate occupies the committed deletion gap", async () => {
    const original = [
      "[Same](/p/target)",
      "[Same](/p/target)",
      "[Same](/p/target)",
    ].join("\n\n");
    const removed = [
      "[Same](/p/target)",
      "[Same](/p/target)",
    ].join("\n\n");
    const concurrent = `${removed}\n\nConcurrent append`;
    let markdown = original;
    let revision = 1;
    let loseRemovalResponse = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (body.markdown === removed && loseRemovalResponse) {
          loseRemovalResponse = false;
          markdown = concurrent;
          revision += 2;
          throw new Error("response lost after commit");
        }
        if (body.markdown === removed && markdown === concurrent) {
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    await openRemoveDialog(refs[1]);

    await click(button("Remove reference"));
    await act(async () => vi.advanceTimersByTime(1_500));
    await settle();
    expect(button("Retry")).toBeDefined();
    expect(markdown).toBe(concurrent);

    await click(button("Retry"));
    expect(putBodies).toEqual([removed, removed]);
    expect(markdown).toBe(concurrent);
    expect([...markdown.matchAll(/\/p\/target/g)]).toHaveLength(2);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't safely verify this removal.",
    );
  });

  it("fails closed when a prepended change leaves an adjacent duplicate in the committed deletion gap", async () => {
    const original = [
      "[Same](/p/target)",
      "[Same](/p/target)",
      "[Same](/p/target)",
    ].join("\n\n");
    const removed = [
      "[Same](/p/target)",
      "[Same](/p/target)",
    ].join("\n\n");
    const concurrent = `Concurrent prepend\n\n${removed}`;
    let markdown = original;
    let revision = 1;
    let loseRemovalResponse = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (body.markdown === removed && loseRemovalResponse) {
          loseRemovalResponse = false;
          markdown = concurrent;
          revision += 2;
          throw new Error("response lost after commit");
        }
        if (body.markdown === removed && markdown === concurrent) {
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    await openRemoveDialog(refs[1]);

    await click(button("Remove reference"));
    await act(async () => vi.advanceTimersByTime(1_500));
    await settle();
    expect(button("Retry")).toBeDefined();
    expect(markdown).toBe(concurrent);

    await click(button("Retry"));
    expect(putBodies).toEqual([removed, removed]);
    expect(markdown).toBe(concurrent);
    expect([...markdown.matchAll(/\/p\/target/g)]).toHaveLength(2);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't safely verify this removal.",
    );
  });

  it("fails closed when a committed removal plus an identical append recreates the original bytes", async () => {
    const original = [
      "[Same](/p/target)",
      "[Same](/p/target)",
      "[Same](/p/target)",
    ].join("\n\n");
    const removed = [
      "[Same](/p/target)",
      "[Same](/p/target)",
    ].join("\n\n");
    const concurrent = `${removed}\n\n[Same](/p/target)`;
    expect(concurrent).toBe(original);
    let markdown = original;
    let revision = 1;
    let loseRemovalResponse = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (body.markdown === removed && loseRemovalResponse) {
          loseRemovalResponse = false;
          markdown = concurrent;
          revision += 2;
          throw new Error("response lost after commit");
        }
        if (body.markdown === removed && markdown === concurrent) {
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    await openRemoveDialog(refs[1]);

    await click(button("Remove reference"));
    await act(async () => vi.advanceTimersByTime(1_500));
    await settle();
    await act(async () => vi.advanceTimersByTime(1_500));
    await settle();
    expect(button("Retry")).toBeDefined();
    expect(markdown).toBe(original);

    await click(button("Retry"));
    expect(putBodies).toEqual([removed, removed, removed]);
    expect(markdown).toBe(original);
    expect([...markdown.matchAll(/\/p\/target/g)]).toHaveLength(3);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't safely verify this removal.",
    );
  });

  it.each([
    { edge: "first", occurrence: 0 },
    { edge: "last", occurrence: 1 },
  ])(
    "fails closed when removing the $edge of two adjacent refs is hidden by an identical concurrent ref",
    async ({ occurrence }) => {
      const ref = "[Same](/p/target)";
      const original = [ref, ref].join("\n\n");
      const removed = ref;
      const concurrent =
        occurrence === 0
          ? `${removed}\n\n${ref}`
          : `${ref}\n\n${removed}`;
      expect(concurrent).toBe(original);
      let markdown = original;
      let revision = 1;
      let loseRemovalResponse = true;
      const putBodies: string[] = [];

      apiFetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url === "/api/page/source" && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as { markdown: string };
          putBodies.push(body.markdown);
          if (body.markdown === removed && loseRemovalResponse) {
            loseRemovalResponse = false;
            markdown = concurrent;
            revision += 2;
            throw new Error("response lost after commit");
          }
          if (body.markdown === removed && markdown === concurrent) {
            return response({}, 409);
          }
          markdown = body.markdown;
          revision += 1;
          return response({ rev: `rev-${revision}` });
        }
        if (url === "/api/page/source") {
          return response({
            meta: { id: "source", title: "Source", stickers: [] },
            markdown,
            rev: `rev-${revision}`,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      await act(async () =>
        root.render(
          <Shell
            tree={[
              node("source", "Source", null, [
                node("target", "Target", "source"),
              ]),
            ]}
            initialSelectedId="source"
          />,
        ),
      );
      await flushFrames();
      const refs = host.querySelectorAll('a[data-page-ref="target"]');
      await openRemoveDialog(refs[occurrence]);

      await click(button("Remove reference"));
      await act(async () => vi.advanceTimersByTime(1_500));
      await settle();
      await act(async () => vi.advanceTimersByTime(1_500));
      await settle();
      expect(button("Retry")).toBeDefined();
      expect(markdown).toBe(original);

      await click(button("Retry"));
      expect(putBodies).toEqual([removed, removed, removed]);
      expect(markdown).toBe(original);
      expect([...markdown.matchAll(/\/p\/target/g)]).toHaveLength(2);
      expect(
        document.body.querySelector('[role="alert"]')?.textContent,
      ).toContain("Couldn't safely verify this removal.");
    },
  );

  it("does not insert a second identical ref after a committed response-lost Undo", async () => {
    const original = [
      "[Same](/p/target)",
      "Middle",
      "[Same](/p/target)",
      "Tail",
    ].join("\n\n");
    const removed = [
      "Middle",
      "[Same](/p/target)",
      "Tail",
    ].join("\n\n");
    const concurrent = `${original}\n\nConcurrent edit`;
    let markdown = original;
    let revision = 1;
    let loseRestoreResponse = true;
    const putBodies: string[] = [];

    apiFetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/page/source" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { markdown: string };
        putBodies.push(body.markdown);
        if (
          body.markdown === original &&
          putBodies.length > 1 &&
          loseRestoreResponse
        ) {
          loseRestoreResponse = false;
          markdown = concurrent;
          revision += 2;
          throw new Error("response lost after commit");
        }
        if (body.markdown === original && markdown === concurrent) {
          return response({}, 409);
        }
        markdown = body.markdown;
        revision += 1;
        return response({ rev: `rev-${revision}` });
      }
      if (url === "/api/page/source") {
        return response({
          meta: { id: "source", title: "Source", stickers: [] },
          markdown,
          rev: `rev-${revision}`,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await act(async () =>
      root.render(
        <Shell
          tree={[
            node("source", "Source", null, [
              node("target", "Target", "source"),
            ]),
          ]}
          initialSelectedId="source"
        />,
      ),
    );
    await flushFrames();
    const refs = host.querySelectorAll('a[data-page-ref="target"]');
    await openRemoveDialog(refs[0]);
    await click(button("Remove reference"));
    expect(markdown).toBe(removed);

    await click(button("Undo"));
    expect(document.body.textContent).toContain("Restoring reference…");
    await act(async () => vi.advanceTimersByTime(1_500));
    await settle();
    expect(document.body.textContent).toContain(
      "Couldn't restore reference",
    );
    expect(markdown).toBe(concurrent);

    await click(button("Retry"));
    expect(putBodies).toEqual([removed, original, original]);
    expect(markdown).toBe(concurrent);
    expect([...markdown.matchAll(/\/p\/target/g)]).toHaveLength(2);
    expect(document.body.textContent).not.toContain(
      "Couldn't restore reference",
    );
  });
});
