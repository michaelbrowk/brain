// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { Hub } from "./hub";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function treeNode(id: string, title: string, updated: string): TreeNode {
  return {
    id,
    parentId: null,
    title,
    order: id,
    created: updated,
    updated,
    hasChildren: false,
    children: [],
  };
}

/** Every page is years stale — the pre-fix filter (`nowMs = 0`) passed all of
 *  them, flashing "Review all (N)" until the clock mounted. */
const staleTree = Array.from({ length: 8 }, (_, i) =>
  treeNode(`stale-${i}`, `Stale page ${i}`, "2020-01-01T00:00:00.000Z"),
);

describe("Hub activity feed clock gate", () => {
  describe("before the clock mounts (SSR HTML)", () => {
    it("renders neither the stale feed nor its empty state", () => {
      const html = renderToString(
        <Hub tree={staleTree} onSelect={() => {}} onCreate={vi.fn()} />,
      );
      expect(html).not.toContain("Review all");
      expect(html).not.toContain("Stale page 0");
      expect(html).not.toContain("Quiet week");
    });
  });

  describe("after mount", () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
      (
        globalThis as typeof globalThis & {
          IS_REACT_ACT_ENVIRONMENT: boolean;
        }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      localStorage.clear();
      sessionStorage.clear();
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((callback: FrameRequestCallback) => {
          callback(0);
          return 1;
        }),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      // a desktop pointer: the hub's field autofocuses on `(hover: hover)`
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({ matches: query === "(hover: hover)" })),
      );
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("filters stale pages out and shows the quiet-week empty state", async () => {
      await act(async () =>
        root.render(
          <Hub tree={staleTree} onSelect={() => {}} onCreate={vi.fn()} />,
        ),
      );
      expect(container.textContent).toContain("Quiet week");
      expect(container.textContent).not.toContain("Review all");
      expect(container.textContent).not.toContain("Stale page 0");
    });

    it("counts only genuinely recent pages in Review all", async () => {
      const recent = new Date(Date.now() - 60_000).toISOString();
      const tree = [
        ...Array.from({ length: 7 }, (_, i) =>
          treeNode(`recent-${i}`, `Recent page ${i}`, recent),
        ),
        ...staleTree,
      ];
      await act(async () =>
        root.render(<Hub tree={tree} onSelect={() => {}} onCreate={vi.fn()} />),
      );
      expect(container.textContent).toContain("Review all (7)");
      expect(container.textContent).not.toContain("Quiet week");
    });
  });
});
