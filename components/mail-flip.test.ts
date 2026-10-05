// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ghostFlip, playFlip, snapshotFlip } from "./mail-flip";

// What a section's Done asks of the column's motion: rows that leave go as
// ghosts on a fade, and rows that come back rise in the way a row enters the
// list. jsdom has no Web Animations API, so `animate` is recorded here and the
// keyframes are what is pinned: the values are the list's own, and reduced
// motion keeps the opacity and nothing else.

type Played = {
  readonly node: HTMLElement;
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
};

describe("the column's flip, as a section's Done uses it", () => {
  let played: Played[];
  let root: HTMLElement;

  beforeEach(() => {
    played = [];
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      writable: true,
      value: function animate(
        this: HTMLElement,
        keyframes: Keyframe[],
        options: KeyframeAnimationOptions,
      ) {
        played.push({ node: this, keyframes, options });
        return { finished: new Promise(() => {}), cancel: () => {} };
      },
    });
    root = document.createElement("div");
    document.body.append(root);
  });

  afterEach(() => {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    root.remove();
  });

  function row(key: string): HTMLElement {
    const element = document.createElement("div");
    element.dataset.flip = key;
    element.textContent = key;
    root.append(element);
    return element;
  }

  it("raises a returning row the 4px a row rises entering the list, on the fast duration", () => {
    const before = snapshotFlip(root);
    const back = row("row:a:1");
    const stranger = row("row:a:2");
    playFlip(root, before, { rise: new Set(["row:a:1"]), reduce: false });
    expect(played).toEqual([
      {
        node: back,
        keyframes: [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        options: { duration: 120, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      },
    ]);
    // A row nobody named arrives as a refresh brings it: with no motion.
    expect(played.some((each) => each.node === stranger)).toBe(false);
  });

  it("only fades a returning row under reduced motion", () => {
    const before = snapshotFlip(root);
    const back = row("row:a:1");
    playFlip(root, before, { rise: new Set(["row:a:1"]), reduce: true });
    expect(played).toEqual([
      {
        node: back,
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        options: { duration: 120, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
      },
    ]);
  });

  it("does not raise a row that never left", () => {
    row("row:a:1");
    const before = snapshotFlip(root);
    playFlip(root, before, { rise: new Set(["row:a:1"]), reduce: false });
    expect(played).toEqual([]);
  });

  it("fades a leaving row's ghost where it stood, with and without reduced motion", () => {
    for (const reduce of [false, true]) {
      played.length = 0;
      const leaving = row("row:a:1");
      const letGo = ghostFlip(root, [leaving], "fade", reduce);
      leaving.remove();
      letGo();
      expect(played).toHaveLength(1);
      expect(played[0]!.node).not.toBe(leaving);
      expect(played[0]!.node.getAttribute("aria-hidden")).toBe("true");
      expect(played[0]!.node.dataset.flip).toBeUndefined();
      expect(played[0]!.keyframes).toEqual([{ opacity: 1 }, { opacity: 0 }]);
      expect(played[0]!.options.duration).toBe(120);
      played[0]!.node.remove();
    }
  });
});
