// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnimatePresence, MotionConfig } from "framer-motion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageFade, pageTransition } from "@/lib/motion";
import { CanvasPresence } from "./canvas-presence";

// The real framer-motion, because what is under test is its presence: the
// shared stub renders every child as present and never runs an exit.

type Preset = typeof pageTransition | typeof pageFade;

function Canvases({ at, preset }: { at: string; preset: Preset }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <CanvasPresence key={at} data-canvas={at} {...preset}>
        <div role="textbox" aria-label="Page content" contentEditable tabIndex={0} />
      </CanvasPresence>
    </AnimatePresence>
  );
}

describe("CanvasPresence", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const canvas = (at: string) =>
    host.querySelector<HTMLElement>(`[data-canvas="${at}"]`);

  for (const [name, preset, reducedMotion] of [
    ["the page transition", pageTransition, "never"],
    ["the reduced-motion crossfade", pageFade, "always"],
  ] as const) {
    it(`makes the leaving canvas inert from the commit its exit starts, under ${name}`, async () => {
      const render = (at: string) =>
        root.render(
          <MotionConfig reducedMotion={reducedMotion}>
            <Canvases at={at} preset={preset} />
          </MotionConfig>,
        );
      await act(async () => render("page:a:1"));
      expect(canvas("page:a:1")?.hasAttribute("inert")).toBe(false);
      expect(canvas("page:a:1")?.getAttribute("aria-hidden")).toBeNull();

      // Home, then straight back to the same page while the first exit runs:
      // the epoch in the key makes the return a new canvas.
      await act(async () => render("hub:2"));
      await act(async () => render("page:a:3"));

      const leaving = canvas("page:a:1");
      expect(leaving, "the leaving canvas is still in the document").not.toBeNull();
      expect(leaving?.hasAttribute("inert")).toBe(true);
      expect(leaving?.getAttribute("aria-hidden")).toBe("true");
      expect(canvas("page:a:3"), "mode wait holds the arriving canvas back").toBeNull();

      await vi.waitFor(() => expect(canvas("page:a:3")).not.toBeNull(), {
        timeout: 2_000,
      });
      expect(canvas("page:a:1")).toBeNull();
      expect(canvas("page:a:3")?.hasAttribute("inert")).toBe(false);
      expect(canvas("page:a:3")?.getAttribute("aria-hidden")).toBeNull();
    });
  }
});
