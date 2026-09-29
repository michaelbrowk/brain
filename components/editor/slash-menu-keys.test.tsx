// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/react", () => ({ useInstance: () => [null, () => null] }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { SlashMenu } from "./slash-menu";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

/** THE MENU'S KEYS ARE LIVE FROM THE COMMIT THAT PAINTS IT.
 *
 *  The menu opens from a frame after the selection lands on `/`, and the state
 *  that frame sets is an ordinary update: React commits it, the browser paints
 *  the menu, and effects run in a task after that. Chrome dispatches input
 *  between those tasks, so an Enter pressed the moment the menu showed went to
 *  ProseMirror instead: the line split under a menu still on screen, and "New
 *  page" never ran. `e2e/critical-flows.spec.ts` presses Enter as soon as the
 *  menu is visible, and on a busy renderer it lost that race about one run in
 *  ten. These cases press the key from the microtask that follows the commit,
 *  which is the earliest a person could, and which no effect has run by. */
describe("SlashMenu keys", () => {
  let host: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    frames = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // jsdom lays nothing out; the menu only needs a rect to place itself.
    Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    Element.prototype.scrollIntoView = () => {};
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderWithTrigger() {
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    const container = createRef<HTMLDivElement>();
    await act(async () =>
      root.render(
        <div ref={container}>
          <p>/</p>
          <SlashMenu container={container} createPage onCreatePageAtCursor={async () => {}} />
        </div>,
      ),
    );
    const text = host.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return host.querySelector("p")!;
  }

  /** Runs the menu's frame the way a browser does, outside `act`, and presses
   *  `key` in the microtask after the commit that inserts the menu. */
  async function pressAsTheMenuAppears(line: HTMLElement, key: string) {
    const pressed = new Promise<KeyboardEvent>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!host.querySelector('[data-testid="slash-menu"]')) return;
        observer.disconnect();
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        line.dispatchEvent(event);
        resolve(event);
      });
      observer.observe(host, { childList: true, subtree: true });
    });
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
    frames.splice(0).forEach((frame) => frame(0));
    return pressed;
  }

  it("takes Enter away from the editor the moment the menu is on screen", async () => {
    const line = await renderWithTrigger();
    const event = await pressAsTheMenuAppears(line, "Enter");
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes an arrow key the moment the menu is on screen", async () => {
    const line = await renderWithTrigger();
    const event = await pressAsTheMenuAppears(line, "ArrowDown");
    expect(event.defaultPrevented).toBe(true);
  });
});
