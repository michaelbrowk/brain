// @vitest-environment jsdom

// The chip carries both spellings of a shortcut and lets CSS show the one the
// platform stamp asks for. The point of the test is the shape of the HTML: the
// server cannot know the platform, so a chip that rendered one spelling would
// either flash the wrong glyph at a Linux reader or disagree with the server
// at hydration.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kbd } from "./primitives";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
  return host.querySelector("kbd")!;
}

describe("Kbd", () => {
  it("carries the Mac spelling and the Ctrl one side by side", () => {
    const chip = render(<Kbd>⌘⌥N</Kbd>);
    expect(chip.querySelector(".kbd-mac")?.textContent).toBe("⌘⌥N");
    expect(chip.querySelector(".kbd-pc")?.textContent).toBe("Ctrl+Alt+N");
  });

  it("leaves a label that means the same everywhere as one run of text", () => {
    const chip = render(<Kbd>Esc</Kbd>);
    expect(chip.textContent).toBe("Esc");
    expect(chip.querySelector(".kbd-mac")).toBeNull();
    expect(chip.querySelector(".kbd-pc")).toBeNull();
  });

  it("keeps a non-string child as it was given", () => {
    const chip = render(
      <Kbd>
        <em>?</em>
      </Kbd>,
    );
    expect(chip.querySelector("em")?.textContent).toBe("?");
    expect(chip.querySelector(".kbd-pc")).toBeNull();
  });

  it("keeps the caller's own class on the chip", () => {
    const chip = render(<Kbd className="ml-auto">⌘K</Kbd>);
    expect(chip.className).toContain("kbd");
    expect(chip.className).toContain("ml-auto");
  });
});
