import { describe, expect, it } from "vitest";
import { clampMenuLeft, placeCaretMenu } from "./menu-position";

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

  it("opens below the caret at full height when the menu fits there", () => {
    expect(placeCaretMenu({ top: 100, bottom: 120 }, { top: 0, bottom: 1000 }, 280)).toEqual({
      side: "below",
      maxHeight: 280,
    });
  });

  it("flips above the caret when only the room above holds it", () => {
    expect(placeCaretMenu({ top: 600, bottom: 620 }, { top: 0, bottom: 700 }, 280)).toEqual({
      side: "above",
      maxHeight: 280,
    });
  });

  // The iPhone keyboard takes the bottom 336 of an 844 screen and the writing
  // bar another 44 above it; a caret in the middle has 280 on neither side.
  // Then the menu takes the larger side and shrinks to it, which is what
  // keeps it out from under the keyboard.
  it("takes the roomier side and caps its height when neither side holds it", () => {
    expect(placeCaretMenu({ top: 250, bottom: 270 }, { top: 0, bottom: 464 }, 280)).toEqual({
      side: "above",
      maxHeight: 244,
    });
    expect(placeCaretMenu({ top: 100, bottom: 120 }, { top: 0, bottom: 300 }, 280)).toEqual({
      side: "below",
      maxHeight: 174,
    });
  });

  it("measures the room above from the viewport's own top, not the page's", () => {
    // visualViewport scrolled: its top is 200 into the layout viewport
    expect(placeCaretMenu({ top: 300, bottom: 320 }, { top: 200, bottom: 500 }, 280)).toEqual({
      side: "below",
      maxHeight: 174,
    });
  });

  // The boundaries, exactly: room equal to the menu is room enough, and
  // equal room on both sides stays below, where the eye already is.
  it("takes a side whose room equals the menu, and stays below on equal room", () => {
    expect(placeCaretMenu({ top: 100, bottom: 120 }, { top: 0, bottom: 406 }, 280)).toEqual({
      side: "below",
      maxHeight: 280,
    });
    expect(placeCaretMenu({ top: 286, bottom: 300 }, { top: 0, bottom: 400 }, 280)).toEqual({
      side: "above",
      maxHeight: 280,
    });
    expect(placeCaretMenu({ top: 106, bottom: 120 }, { top: 0, bottom: 226 }, 280)).toEqual({
      side: "below",
      maxHeight: 100,
    });
  });
});
