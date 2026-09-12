import { describe, expect, it } from "vitest";
import { pcShortcut } from "./shortcut-keys";

describe("pcShortcut", () => {
  it("spells the Mac modifiers the way Windows and Linux do", () => {
    expect(pcShortcut("⌘K")).toBe("Ctrl+K");
    expect(pcShortcut("⌘⌥N")).toBe("Ctrl+Alt+N");
    expect(pcShortcut("⌘⇧B")).toBe("Ctrl+Shift+B");
    expect(pcShortcut("⌘⌥1")).toBe("Ctrl+Alt+1");
  });

  it("keeps a punctuation key as the key", () => {
    expect(pcShortcut("⌘\\")).toBe("Ctrl+\\");
    expect(pcShortcut("⌘/")).toBe("Ctrl+/");
  });

  it("names the return key instead of drawing it", () => {
    expect(pcShortcut("⌘↵")).toBe("Ctrl+Enter");
    expect(pcShortcut("⌘⏎")).toBe("Ctrl+Enter");
  });

  it("leaves a label with no Mac modifier exactly as it is", () => {
    for (const label of ["Esc", "Enter", "J", "↑", "/", "[["]) {
      expect(pcShortcut(label)).toBe(label);
    }
  });

  it("does not say the same modifier twice", () => {
    expect(pcShortcut("⌃⌘K")).toBe("Ctrl+K");
  });

  it("treats a modifier glyph after the key as part of the key", () => {
    // Nothing in the product spells one this way. The rule matters anyway:
    // only leading glyphs are modifiers, so a stray one cannot reorder a label.
    expect(pcShortcut("K⌘")).toBe("K⌘");
  });
});
