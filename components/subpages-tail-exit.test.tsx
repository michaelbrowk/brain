// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";

/** The exit the component asks for, held so the test can complete it. The
 *  shared stub's `AnimatePresence` is a passthrough and never fires this, so
 *  the standing tail could not otherwise be exercised at all. */
let finishExit: (() => void) | null = null;

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: false,
    AnimatePresence: ({ children, onExitComplete }) => {
      finishExit = onExitComplete ?? null;
      return children;
    },
  });
});

const { Subpages } = await import("./subpages");

const ORIGIN = "https://brain.example";

function child(id: string, title: string): TreeNode {
  const timestamp = "2026-08-12T08:00:00.000Z";
  return {
    id,
    parentId: "parent",
    title,
    order: id,
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
  };
}

describe("the derived tail leaves rather than being deleted", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    finishExit = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(markdown: string) {
    await act(async () =>
      root.render(
        <Subpages
          pages={[child("a", "Alpha")]}
          markdown={markdown}
          currentOrigin={ORIGIN}
          onNavigate={vi.fn()}
        />,
      ),
    );
  }

  it("stands until its exit completes, then renders nothing at all", async () => {
    await render("Body with no links");
    expect(host.querySelector("[data-derived-page-refs]")).not.toBeNull();

    // The body now names the child — which is what Apply does to every child
    // at once. The rows go, but the component has to stay mounted or the
    // exit it just asked for would be thrown away with it.
    await render("Body linking [Alpha](/p/a)");
    expect(host.querySelector("[data-derived-page-refs]")).toBeNull();
    expect(host.innerHTML).not.toBe("");
    expect(finishExit).not.toBeNull();

    await act(async () => finishExit?.());
    expect(host.innerHTML).toBe("");
  });

  it("renders nothing for a page that never had a tail", async () => {
    await render("Body linking [Alpha](/p/a)");
    expect(host.innerHTML).toBe("");
  });
});
