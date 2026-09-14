// @vitest-environment jsdom

// The phone's bottom line is two objects, not one: the five-slot bar on the
// left inset and the New page circle on the right one. They are siblings with
// no wrapper between them, so what holds them together is the state they
// share: one `hidden`, two consumers. These cases pin the shape, the order
// and that shared state; the geometry they resolve to is pinned by the CSS
// contract in `mobile-surfaces.test.tsx` and measured per width by
// `e2e/mail-shots.spec.ts`.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTabBar } from "./mobile-tab-bar";

function render(root: Root, hidden: boolean, onNew = vi.fn()) {
  return act(() =>
    root.render(
      <MobileTabBar
        homeActive
        searchActive={false}
        tasksActive={false}
        pagesActive={false}
        mailActive={false}
        hidden={hidden}
        onHome={() => {}}
        onSearch={() => {}}
        onTasks={() => {}}
        onNew={onNew}
        onPages={() => {}}
        onMail={() => {}}
      />,
    ),
  );
}

describe("the phone's bottom line", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const bar = () => document.querySelector<HTMLElement>(".brain-mobile-tabbar")!;
  const plus = () => document.querySelector<HTMLButtonElement>(".brain-mobile-new")!;

  it("stands five tabs in the bar and one plus outside it", async () => {
    await render(root, false);

    const tabs = Array.from(
      bar().querySelectorAll<HTMLElement>("[data-mobile-tab]"),
    ).map((el) => el.dataset.mobileTab);
    expect(tabs).toEqual(["home", "search", "tasks", "pages", "mail"]);
    expect(bar().querySelector(".brain-mobile-new")).toBeNull();

    // the bar is still the navigation and the plus is not part of it
    expect(bar().getAttribute("aria-label")).toBe("Primary");
    expect(plus().closest("nav")).toBeNull();
    expect(plus().getAttribute("aria-label")).toBe("New page");
    expect(plus().querySelector("svg")).not.toBeNull();
    expect(plus().textContent).toBe("");
    // `brain-touch-min` pins anything it is on to `position: relative`
    // unless the element says it places itself, and a circle that loses its
    // `fixed` leaves the line for wherever the flow puts it.
    expect(plus().classList.contains("fixed")).toBe(true);
    expect(plus().classList.contains("brain-touch-min")).toBe(true);
    expect(plus().classList.contains("focus-inset")).toBe(true);
  });

  it("puts the plus last, after Mail, so Tab reads left to right", async () => {
    await render(root, false);

    const order = Array.from(
      host.querySelectorAll<HTMLButtonElement>("button"),
    ).map((el) => el.dataset.mobileTab ?? el.getAttribute("aria-label"));
    expect(order).toEqual([
      "home",
      "search",
      "tasks",
      "pages",
      "mail",
      "New page",
    ]);
    expect(bar().compareDocumentPosition(plus())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("hides both on one state and brings both back", async () => {
    await render(root, false);
    expect(bar().hasAttribute("data-hidden")).toBe(false);
    expect(plus().hasAttribute("data-hidden")).toBe(false);
    expect(plus().tabIndex).toBe(0);

    await render(root, true);
    // A sheet, the keyboard or the palette takes the line away whole: a plus
    // left standing over an open sheet is the one state this must not have.
    expect(bar().hasAttribute("data-hidden")).toBe(true);
    expect(plus().hasAttribute("data-hidden")).toBe(true);
    expect(bar().getAttribute("aria-hidden")).toBe("true");
    expect(plus().getAttribute("aria-hidden")).toBe("true");
    expect(plus().tabIndex).toBe(-1);
    for (const tab of bar().querySelectorAll<HTMLButtonElement>("button")) {
      expect(tab.tabIndex).toBe(-1);
    }

    await render(root, false);
    expect(bar().hasAttribute("data-hidden")).toBe(false);
    expect(plus().hasAttribute("data-hidden")).toBe(false);
  });

  it("keeps New page on the same handler it had inside the bar", async () => {
    const onNew = vi.fn();
    await render(root, false, onNew);
    await act(async () => plus().click());
    expect(onNew).toHaveBeenCalledTimes(1);
  });
});
