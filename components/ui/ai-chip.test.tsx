// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AiChip } from "./ai-chip";

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function render() {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host as HTMLDivElement).render(<AiChip />);
  });
  return host.firstElementChild as HTMLElement;
}

describe("the AI chip", () => {
  it("is two letters in one span with the one class", () => {
    const chip = render();
    expect(chip.tagName).toBe("SPAN");
    expect(chip.textContent).toBe("AI");
    expect(chip.className).toBe("ai-chip");
  });

  it("says what it means to a pointer and to a screen reader", () => {
    const chip = render();
    expect(chip.getAttribute("title")).toBe("Built by an agent");
    expect(chip.getAttribute("aria-label")).toBe("Built by an agent");
  });

  it("carries no em-dash in anything a reader sees", () => {
    const chip = render();
    expect(chip.outerHTML).not.toContain("—");
  });
});
