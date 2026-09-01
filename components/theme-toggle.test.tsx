// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./theme-toggle";

const themeHarness = vi.hoisted(() => ({
  resolvedTheme: "light" as string,
  setTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: themeHarness.resolvedTheme,
    setTheme: themeHarness.setTheme,
  }),
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

describe("ThemeToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    themeHarness.setTheme.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  /** Both icons stay permanently mounted — an AnimatePresence swap used to
   *  leave the button empty when a toggle interrupted the exit animation. */
  it("keeps both icons mounted and flips only their visibility", async () => {
    themeHarness.resolvedTheme = "light";
    await act(async () => root.render(<ThemeToggle />));

    const spans = () => container.querySelectorAll("button > span");
    expect(spans()).toHaveLength(2);
    // light theme → moon shown (second span), sun hidden
    expect(spans()[0].getAttribute("aria-hidden")).toBe("true");
    expect(spans()[1].getAttribute("aria-hidden")).toBe("false");

    themeHarness.resolvedTheme = "dark";
    await act(async () => root.render(<ThemeToggle />));
    expect(spans()).toHaveLength(2);
    expect(spans()[0].getAttribute("aria-hidden")).toBe("false");
    expect(spans()[1].getAttribute("aria-hidden")).toBe("true");
  });

  it("toggles to the opposite theme on click", async () => {
    themeHarness.resolvedTheme = "dark";
    await act(async () => root.render(<ThemeToggle />));
    const button = container.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(themeHarness.setTheme).toHaveBeenCalledWith("light");
  });
});
