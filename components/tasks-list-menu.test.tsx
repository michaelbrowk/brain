// @vitest-environment jsdom

// The Tasks list menu is Mail's nav menu with other rows: the same material,
// the same scroller for a window shorter than the list, and so the same three
// things a scroller needs for a keyboard. `mail-nav.test.tsx` says why each is
// there; this holds that the copy carries them too.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TasksListMenu } from "./tasks-list-menu";

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: false });
});

describe("TasksListMenu", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("PointerEvent", MouseEvent);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function open() {
    await act(async () =>
      root.render(
        <TasksListMenu
          view={{ kind: "list", list: "today" }}
          today="2026-09-28"
          categories={[
            { category: "Home", open: 2 },
            { category: "Work", open: 5 },
          ]}
          onSelect={vi.fn()}
        />,
      ),
    );
    const trigger = document.body.querySelector('button[aria-label="Today"]');
    if (!trigger) throw new Error("Tasks list trigger not found");
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  }

  function rows(): HTMLElement[] {
    return [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  }

  it("keeps the keyboard's row whole inside the scroller", async () => {
    await open();

    expect(rows()).toHaveLength(7);
    for (const item of rows()) {
      expect(item.classList.contains("focus-inset")).toBe(true);
    }
    const scroller = rows()[0].closest(".edge-fade");
    expect(scroller?.classList.contains("scroll-pt-3")).toBe(true);
    expect(scroller?.classList.contains("scroll-pb-5")).toBe(true);
  });

  it("says whether the keys or the pointer moved focus last", async () => {
    await open();
    const menu = document.body.querySelector<HTMLElement>(".brain-menu");
    if (!menu) throw new Error("Menu is not open");

    expect(menu.dataset.keyRing).toBe("pointer");
    await act(async () => {
      rows()[0].dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(menu.dataset.keyRing).toBe("keys");
    for (const clientX of [40, 41]) {
      await act(async () => {
        rows()[1].dispatchEvent(
          new MouseEvent("pointermove", { bubbles: true, clientX, clientY: 80 }),
        );
      });
    }
    expect(menu.dataset.keyRing).toBe("pointer");
  });
});
