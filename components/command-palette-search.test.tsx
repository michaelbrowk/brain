// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import {
  CommandPalette,
  type CommandPaletteSelection,
} from "./command-palette";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const target = {
  exact: "Needle",
  occurrence: 1,
  before: "First Needle ",
  after: " selected",
};

function node(): TreeNode {
  const timestamp = "2026-07-29T08:00:00.000Z";
  return {
    id: "page",
    parentId: null,
    title: "Reference page",
    order: "a",
    created: timestamp,
    updated: timestamp,
    hasChildren: false,
    children: [],
  };
}

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("CommandPalette body-result selection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn<(value: CommandPaletteSelection) => void>>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    onSelect = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          hits: [
            {
              id: "page",
              title: "Reference page",
              source: "body",
              snippet: {
                before: "First ",
                match: "Needle",
                after: " selected",
              },
              target,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
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

  async function renderPalette(mobile = false) {
    await act(async () =>
      root.render(
        <CommandPalette
          open
          onOpenChange={vi.fn()}
          tree={[node()]}
          onSelect={onSelect}
          hasCurrent={false}
          mobile={mobile}
        />,
      ),
    );
    const input = document.body.querySelector(
      'input[aria-label="Search pages and text"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTime(200));
    await settle();
    return input;
  }

  it("returns the same exact body intent from desktop click", async () => {
    await renderPalette();
    const item = [...document.body.querySelectorAll("[cmdk-item]")].find(
      (candidate) => candidate.textContent?.includes("Needle"),
    ) as HTMLElement;

    await act(async () => item.click());

    expect(onSelect).toHaveBeenCalledWith({
      kind: "text",
      id: "page",
      target,
    });
  });

  it("returns the exact body intent from desktop Enter", async () => {
    const input = await renderPalette();

    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      ),
    );

    expect(onSelect).toHaveBeenCalledWith({
      kind: "text",
      id: "page",
      target,
    });
  });

  it("returns the same exact body intent from mobile tap", async () => {
    await renderPalette(true);
    const item = [...document.body.querySelectorAll("[cmdk-item]")].find(
      (candidate) => candidate.textContent?.includes("Needle"),
    ) as HTMLElement;

    await act(async () => item.click());

    expect(onSelect).toHaveBeenCalledWith({
      kind: "text",
      id: "page",
      target,
    });
  });

  it("keeps a body result as a fail-closed text intent when its target is absent", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({
        hits: [
          {
            id: "page",
            title: "Reference page",
            source: "body",
            snippet: {
              before: "",
              match: "Needle",
              after: "",
            },
          },
        ],
      }),
    );
    await renderPalette();
    const item = [...document.body.querySelectorAll("[cmdk-item]")].find(
      (candidate) => candidate.textContent?.includes("Needle"),
    ) as HTMLElement;

    await act(async () => item.click());

    expect(onSelect).toHaveBeenCalledWith({
      kind: "text",
      id: "page",
      target: null,
    });
  });

  it("keeps title results page-only", async () => {
    await act(async () =>
      root.render(
        <CommandPalette
          open
          onOpenChange={vi.fn()}
          tree={[node()]}
          onSelect={onSelect}
          hasCurrent={false}
        />,
      ),
    );
    const input = document.body.querySelector(
      'input[aria-label="Search pages and text"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "Reference");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const title = [...document.body.querySelectorAll("[cmdk-item]")].find(
      (candidate) => candidate.textContent?.includes("Reference page"),
    ) as HTMLElement;

    await act(async () => title.click());

    expect(onSelect).toHaveBeenCalledWith({ kind: "page", id: "page" });
  });
});
