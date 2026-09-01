// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { CommandPalette } from "./command-palette";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

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

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The desktop palette is a real modal dialog: Radix owns the focus trap,
 *  Escape, and hides the rest of the app from assistive tech. */
describe("CommandPalette desktop dialog", () => {
  let app: HTMLDivElement;
  let container: HTMLDivElement;
  let root: Root;
  let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    onOpenChange = vi.fn();
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
    // a sibling standing in for the app shell behind the portal
    app = document.createElement("div");
    app.innerHTML = '<button type="button">App control</button>';
    document.body.appendChild(app);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    app.remove();
    vi.unstubAllGlobals();
  });

  async function renderPalette(open = true) {
    await act(async () =>
      root.render(
        <CommandPalette
          open={open}
          onOpenChange={onOpenChange}
          tree={[node()]}
          onSelect={vi.fn()}
          hasCurrent={false}
          onNewPage={vi.fn()}
        />,
      ),
    );
    await settle();
  }

  function dialog(): HTMLElement {
    const element = document.body.querySelector<HTMLElement>(
      '[data-testid="desktop-command-palette"]',
    );
    if (!element) throw new Error("desktop palette not mounted");
    return element;
  }

  function input(): HTMLInputElement {
    return dialog().querySelector("input[cmdk-input]") as HTMLInputElement;
  }

  it("mounts as a labelled modal dialog on the testid wrapper", async () => {
    await renderPalette();

    const panel = dialog();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("data-state")).toBe("open");
    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe(
      "Search and commands",
    );
    const describedBy = panel.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "Search pages",
    );
    // the overlay rides the shared dialog scrim keyframes
    expect(
      document.body.querySelector(".brain-dialog-overlay[data-state='open']"),
    ).not.toBeNull();
    // the app behind the portal is hidden from assistive tech
    expect(app.getAttribute("aria-hidden")).toBe("true");
  });

  it("focuses the search input and traps Tab inside the panel", async () => {
    await renderPalette();

    expect(document.activeElement).toBe(input());

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      input().dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());

    const shiftTab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      input().dispatchEvent(shiftTab);
    });
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });

  it("closes on Escape through onOpenChange", async () => {
    await renderPalette();

    await act(async () => {
      input().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("releases the app once closed", async () => {
    await renderPalette();
    expect(app.getAttribute("aria-hidden")).toBe("true");

    await renderPalette(false);
    expect(
      document.body.querySelector('[data-testid="desktop-command-palette"]'),
    ).toBeNull();
    expect(app.getAttribute("aria-hidden")).not.toBe("true");
  });
});
