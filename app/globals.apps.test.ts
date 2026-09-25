import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("}", start));
}

describe("the AI chip's CSS", () => {
  it("is the Label register, the muted ink and the glass hover fill", () => {
    const rule = block(".ai-chip");
    expect(rule).toContain("font-size: 11px");
    expect(rule).toContain("font-weight: 600");
    expect(rule).toContain("color: var(--ink-3)");
    expect(rule).toContain("background-color: var(--fill-glass-hover)");
    expect(rule).toContain("border-radius: 4px");
  });

  it("writes no colour of its own", () => {
    const rule = block(".ai-chip");
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rule).not.toMatch(/\b(rgb|rgba|hsl|oklch)\(/);
  });
});

/** The arithmetic behind how tall an app's frame is. `e2e/apps.spec.ts`
 *  measures the result in a browser, which is the only place it can be
 *  measured; what is here is the line that produces it. The failure it
 *  replaces was a chain with a gap in it: the canvas asked for 100% of a
 *  wrapper whose height property is `auto`, and `min-height` on a box never
 *  makes its height definite, so the percentage measured against `auto` and
 *  was handed nothing. The column had no room to give out and the frame sat
 *  at its floor with the window empty under it. The height comes down the
 *  flex chain instead: the scroller is the window's height, the wrapper is a
 *  column, the canvas is the item that fills it. */
describe("an app canvas's CSS", () => {
  it("takes the height its scroller has, never a window unit of its own", () => {
    const canvas = block(".brain-app-canvas");
    // The item in the wrapper's column, not a percentage of a box whose
    // height is auto.
    expect(canvas).toContain("flex: 1");
    expect(canvas).not.toContain("min-height");
    expect(canvas).toContain("flex-direction: column");
    // The phone's reserve stays under the frame: an app's own bottom control
    // must not sit behind Brain's.
    expect(canvas).toContain("padding-bottom: var(--tabbar-reserve)");
    // Nothing here measures the window for itself. The scroller is already
    // the window's height, and a second source for the same number is a
    // second thing to keep in step with the chrome above it.
    expect(css).not.toContain(".brain-app-canvas[data-app-canvas]");
    // And the frame takes what the head leaves, down to its own floor.
    const frame = block(".brain-app-frame");
    expect(frame).toContain("flex: 1");
    expect(frame).toContain("min-height: 420px");
  });

  it("paints the in-progress fill on the canvas, not only behind the frame", () => {
    // The canvas, because the wait starts before there is a frame: the
    // address is asked for first, and a fill on the frame alone leaves that
    // phase as the bare paper the audit photographed.
    expect(block(".brain-app-canvas_loading")).toContain(
      "background: var(--skeleton-fill)",
    );
    // The frame stands out of the way while it waits, so the two are one
    // plate rather than a tint over a tint.
    expect(block(".brain-app-canvas_loading > .brain-app-frame")).toContain(
      "background: transparent",
    );
    // And the paper again once there is a document to cover it.
    expect(block(".brain-app-frame")).toContain("background: var(--paper)");
  });
});
