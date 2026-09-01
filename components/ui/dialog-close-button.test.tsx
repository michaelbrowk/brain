// @vitest-environment jsdom

import * as Dialog from "@radix-ui/react-dialog";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogCloseButton, DialogHeader } from "./dialog-header";

describe("dialog chrome", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the shared header iconless and closes through one plain-X control", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <Dialog.Root open onOpenChange={onOpenChange}>
          <Dialog.Portal>
            <Dialog.Content aria-describedby={undefined}>
              <DialogHeader title="Move page" closeLabel="Close move dialog" />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>,
      );
    });

    const heading = document.body.querySelector('[role="dialog"] h2');
    const close = document.body.querySelector(
      'button[aria-label="Close move dialog"]',
    ) as HTMLButtonElement;
    expect(heading?.textContent).toBe("Move page");
    expect(heading?.parentElement?.querySelector("svg")).toBeNull();
    expect(close.type).toBe("button");
    expect(close.classList.contains("brain-touch-hit")).toBe(true);
    // A plain X is drawn plain: no ring in the markup and none hidden in CSS
    // (DESIGN.md §10 ban 13). Two strokes, Solar's own 1.5 weight, no class
    // doing surgery on the drawing.
    expect(close.querySelector("circle")).toBeNull();
    expect(close.querySelectorAll("path")).toHaveLength(2);
    expect(close.querySelector("g")?.getAttribute("stroke-width")).toBe("1.5");
    expect(close.querySelector("svg")?.getAttribute("class")).toBeNull();

    await act(async () => close.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps a disabled close inert while the dialog is busy", async () => {
    const onOpenChange = vi.fn();
    await act(async () => {
      root.render(
        <Dialog.Root open onOpenChange={onOpenChange}>
          <Dialog.Portal>
            <Dialog.Content aria-describedby={undefined}>
              <Dialog.Title>History</Dialog.Title>
              <DialogCloseButton label="Close history" disabled />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>,
      );
    });

    const close = document.body.querySelector(
      'button[aria-label="Close history"]',
    ) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    await act(async () => close.click());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
