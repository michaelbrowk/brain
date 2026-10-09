// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KEYBOARD_MIN, keyboardHeight, keyboardInset, usableViewport, useTouchDock } from "./touch-dock";

describe("touch dock", () => {
  let vv: { offsetTop: number; height: number } | undefined;

  beforeEach(() => {
    window.innerHeight = 844;
    vv = { offsetTop: 0, height: 844 };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get: () =>
        vv && {
          offsetTop: vv.offsetTop,
          offsetLeft: 0,
          width: window.innerWidth,
          height: vv.height,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The inset is where the visual viewport's bottom edge stands in the
  // layout viewport: a pan moves it, the keyboard's height does not change.
  it("tells the keyboard's height from where the visual viewport's bottom stands", () => {
    vv = { offsetTop: 0, height: 508 };
    expect(keyboardInset()).toBe(336);
    expect(keyboardHeight()).toBe(336);
    vv = { offsetTop: 150, height: 508 };
    expect(keyboardInset()).toBe(186);
    expect(keyboardHeight()).toBe(336);
    vv = { offsetTop: 336, height: 508 };
    expect(keyboardInset()).toBe(0);
    expect(keyboardHeight()).toBe(336);
  });

  it("reads no keyboard without a visual viewport, and never a negative one", () => {
    vv = undefined;
    expect(keyboardInset()).toBe(0);
    expect(keyboardHeight()).toBe(0);
    expect(usableViewport(0)).toEqual({ top: 0, bottom: 844 });
    vv = { offsetTop: 0, height: 900 };
    expect(keyboardInset()).toBe(0);
    expect(keyboardHeight()).toBe(0);
  });

  it("takes what is docked off the visual viewport's bottom", () => {
    vv = { offsetTop: 120, height: 400 };
    expect(usableViewport(44)).toEqual({ top: 120, bottom: 476 });
  });

  it("counts a keyboard only past the shell's own threshold", () => {
    expect(KEYBOARD_MIN).toBe(120);
  });

  describe("the hook", () => {
    let host: HTMLDivElement;
    let root: Root;
    let queries: string[];
    let seen: { isTouch: boolean; kbInset: number; kbHeight: number } | null;

    function Probe() {
      seen = useTouchDock();
      return null;
    }

    beforeEach(() => {
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      queries = [];
      seen = null;
      vi.stubGlobal(
        "matchMedia",
        vi.fn().mockImplementation((query: string) => {
          queries.push(query);
          return { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
        }),
      );
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      host.remove();
    });

    // A coarse pointer alone would take an iPad with a trackpad, whose
    // keyboard is a hardware one and whose rows hover.
    it("asks for a touch screen with no hover, not a coarse pointer alone", async () => {
      vv = { offsetTop: 100, height: 508 };
      await act(async () => root.render(<Probe />));
      expect(queries).toEqual(["(hover: none) and (pointer: coarse)"]);
      expect(seen).toEqual({ isTouch: true, kbInset: 236, kbHeight: 336 });
    });
  });
});
