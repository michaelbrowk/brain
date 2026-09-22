// @vitest-environment jsdom

// The phone's bottom line is two objects, not one: the bar on the left inset,
// five slots with both modules on, and the New page circle on the right one.
// They are siblings with
// no wrapper between them, so what holds them together is the state they
// share: one `hidden`, two consumers. These cases pin the shape, the order
// and that shared state; the geometry they resolve to is pinned by the CSS
// contract in `mobile-surfaces.test.tsx` and measured per width by
// `e2e/mail-shots.spec.ts`.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "@/lib/templates";
import { MobileTabBar } from "./mobile-tab-bar";
import { resetMailComposeAvailable } from "./mail-compose-available";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

async function render(
  root: Root,
  hidden: boolean,
  handlers: {
    onNew?: (template: (typeof TEMPLATES)[number]) => void;
    onNewTask?: () => void;
    onNewMessage?: () => void;
  } = {},
) {
  await act(async () =>
    root.render(
      <MobileTabBar
        modules={{ mail: true, tasks: true }}
        homeActive
        searchActive={false}
        tasksActive={false}
        pagesActive={false}
        mailActive={false}
        hidden={hidden}
        onHome={() => {}}
        onSearch={() => {}}
        onTasks={() => {}}
        onNew={handlers.onNew ?? (() => {})}
        onNewTask={handlers.onNewTask ?? (() => {})}
        onNewMessage={handlers.onNewMessage ?? (() => {})}
        onPages={() => {}}
        onMail={() => {}}
      />,
    ),
  );
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("the phone's bottom line", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetMailComposeAvailable();
    // the bar is a phone object, and the menu under its plus takes the sheet
    // form on the same query every other sheet in the product reads
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({ ok: true, status: 200, json: async () => ({ apiVersion: 2, accounts: [] }) }) as Response,
      ),
    );
    // Radix's popper measures its content and captures the pointer; jsdom
    // ships neither.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("PointerEvent", MouseEvent);
    for (const name of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        value: () => (name === "hasPointerCapture" ? false : undefined),
      });
    }
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: () => undefined,
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((element) => element.remove());
    resetMailComposeAvailable();
    vi.unstubAllGlobals();
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
    expect(plus().getAttribute("aria-label")).toBe("New");
    expect(plus().getAttribute("aria-haspopup")).toBe("menu");
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
      "New",
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

  /** THE WHOLE TAP, down and up. The sheet rises over the plus, so it opens on
   *  the lift rather than on the press and a `pointerdown` alone leaves the
   *  line as it was (`components/new-menu.tsx`). */
  const tap = async () => {
    await act(async () => {
      plus().dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    await act(async () => plus().click());
    await act(async () => {
      await Promise.resolve();
    });
  };

  it("opens the New menu as a sheet instead of making a page outright", async () => {
    const onNew = vi.fn();
    const onNewTask = vi.fn();
    await render(root, false, { onNew, onNewTask });

    await tap();

    // a press on the plus makes nothing by itself now
    expect(onNew).not.toHaveBeenCalled();

    const sheet = document.querySelector<HTMLElement>(".brain-menu")!;
    expect(sheet).not.toBeNull();
    expect(sheet.classList.contains("brain-menu-sheet")).toBe(true);
    expect(sheet.querySelector(".brain-composer-grip")).not.toBeNull();

    const row = (name: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (node) => (node.textContent ?? "").trim() === name,
      );
    expect(row("Task")).not.toBeUndefined();
    expect(row("Blank page")).not.toBeUndefined();

    await act(async () => row("Blank page")!.click());
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew.mock.calls[0][0].id).toBe("blank");

    await tap();
    // Task runs once Radix has released the menu, so the caret it asks for is
    // not taken back by the focus scope on its way out
    await act(async () => row("Task")!.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it("draws three slots with both modules off, and says so to the grid", async () => {
    await act(async () =>
      root.render(
        <MobileTabBar
          modules={{ mail: false, tasks: false }}
          homeActive
          searchActive={false}
          tasksActive={false}
          pagesActive={false}
          mailActive={false}
          onHome={() => {}}
          onSearch={() => {}}
          onTasks={() => {}}
          onNew={() => {}}
          onNewTask={() => {}}
          onNewMessage={() => {}}
          onPages={() => {}}
          onMail={() => {}}
        />,
      ),
    );
    const tabs = [...bar().querySelectorAll<HTMLElement>("[data-mobile-tab]")];
    expect(tabs.map((tab) => tab.dataset.mobileTab)).toEqual([
      "home",
      "search",
      "pages",
    ]);
    expect(bar().style.getPropertyValue("--tabbar-slots")).toBe("3");
  });
});
