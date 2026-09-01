import { describe, expect, it } from "vitest";
import { clampMenuLeft, shouldFlipAbove } from "./menu-position";

describe("caret menu placement", () => {
  it("opens at the caret when the panel fits", () => {
    expect(clampMenuLeft(40, 672, 220)).toBe(40);
  });

  it("clamps to the editor's right edge on a narrow viewport", () => {
    // 320px phone column: a caret at 200px would push a 260px panel off-screen
    expect(clampMenuLeft(200, 320, 260)).toBe(320 - 260 - 8);
  });

  it("never goes negative when the editor is narrower than the panel", () => {
    expect(clampMenuLeft(10, 200, 260)).toBe(0);
  });

  it("flips above the caret only when there is no room below and enough above", () => {
    const caret = { top: 600, bottom: 620 };
    expect(shouldFlipAbove(caret, 700, 280)).toBe(true);
    expect(shouldFlipAbove(caret, 1000, 280)).toBe(false);
    // near the top of a short viewport: nowhere to flip to, stay below
    expect(shouldFlipAbove({ top: 100, bottom: 120 }, 300, 280)).toBe(false);
  });
});
