// @vitest-environment jsdom

import { act, createRef, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/react", () => ({ useInstance: () => [null, () => null] }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { EDITOR_DOC_CHANGED_EVENT } from "@/lib/editor-events";
import { SlashMenu } from "./slash-menu";
import { WikiLinkMenu } from "./wikilink-menu";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
type Container = RefObject<HTMLDivElement | null>;

/** THE KEYS OF THE TWO MENUS THAT FOLLOW THE CARET.
 *
 *  Both listen on the document in the capture phase, because ProseMirror
 *  handles a key on the editor itself and ignores one that arrives already
 *  prevented: capturing is how Enter picks a row instead of splitting the line.
 *  The same reach is the danger. A listener on the document hears every key on
 *  the page, so each case here is a key the menu must take, or one it must
 *  leave to whoever it belongs to: the composition an IME is building, the
 *  editor when nothing matches, a dialog that holds focus, an editor that is
 *  leaving the screen. */
const MENUS: ReadonlyArray<{
  name: string;
  trigger: string;
  unmatched: string;
  mount: (container: Container, dockOffset?: number) => ReactNode;
}> = [
  {
    name: "the slash menu",
    trigger: "/",
    unmatched: "/zzz",
    mount: (container, dockOffset) => (
      <SlashMenu
        container={container}
        createPage
        onCreatePageAtCursor={async () => {}}
        dockOffset={dockOffset}
      />
    ),
  },
  {
    name: "the wiki-link menu",
    trigger: "[[",
    unmatched: "[[zzz",
    mount: (container, dockOffset) => (
      <WikiLinkMenu
        container={container}
        pages={[{ id: "p1", title: "Alpha" }]}
        dockOffset={dockOffset}
      />
    ),
  },
];

describe.each(MENUS)("$name keys", ({ trigger, unmatched, mount }) => {
  let host: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = true;
    frames = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // jsdom lays nothing out; a menu only needs a rect to place itself.
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
    document.querySelectorAll("[data-test-dialog]").forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  /** An editor holding one line, with the caret at its end. The line is the
   *  target of every key below, as ProseMirror's own element would be. */
  async function renderLine(text: string, dockOffset?: number) {
    const container = createRef<HTMLDivElement>();
    await act(async () =>
      root.render(
        <div ref={container}>
          <p>{text}</p>
          {mount(container, dockOffset)}
        </div>,
      ),
    );
    const line = host.querySelector("p")!;
    caretAtEnd(line);
    return line;
  }

  function caretAtEnd(line: HTMLElement, announce: "selectionchange" | "doc-changed" = "selectionchange") {
    const text = line.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    if (announce === "selectionchange") document.dispatchEvent(new Event("selectionchange"));
    else window.dispatchEvent(new Event(EDITOR_DOC_CHANGED_EVENT));
  }

  const menuShown = () => host.querySelectorAll("button").length > 0;

  async function openOn(text: string) {
    const line = await renderLine(text);
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    return line;
  }

  function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  // The menu opens from a frame, so its state is an ordinary update: React
  // commits it, the browser paints, and a passive effect runs a task later.
  // Chrome dispatches input between those tasks, which is where an Enter
  // pressed as the menu appeared used to fall through to ProseMirror. These
  // two press from the microtask after the commit, before any effect.
  async function pressAsTheMenuAppears(line: HTMLElement, key: string) {
    const pressed = new Promise<KeyboardEvent>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!menuShown()) return;
        observer.disconnect();
        resolve(press(line, key));
      });
      observer.observe(host, { childList: true, subtree: true });
    });
    (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
    frames.splice(0).forEach((frame) => frame(0));
    return pressed;
  }

  it("takes Enter the moment it is on screen", async () => {
    const line = await renderLine(trigger);
    expect((await pressAsTheMenuAppears(line, "Enter")).defaultPrevented).toBe(true);
  });

  it("takes an arrow key the moment it is on screen", async () => {
    const line = await renderLine(trigger);
    expect((await pressAsTheMenuAppears(line, "ArrowDown")).defaultPrevented).toBe(true);
  });

  it("decides before the editor sees the key", async () => {
    // ProseMirror reads a key on its own element and ignores one that is
    // already prevented. Heard in the bubble phase, the menu would decide
    // after the editor had split the line.
    const line = await openOn(trigger);
    let preventedAtTheEditor: boolean | null = null;
    line.addEventListener("keydown", (event) => {
      preventedAtTheEditor = event.defaultPrevented;
    });
    press(line, "Enter");
    expect(preventedAtTheEditor).toBe(true);
  });

  it("leaves an IME's Enter to the composition", async () => {
    // Enter that commits a candidate arrives with isComposing, and Safari
    // sends the commit as keyCode 229 with isComposing already false.
    const line = await openOn(trigger);
    expect(menuShown()).toBe(true);
    expect(press(line, "Enter", { isComposing: true }).defaultPrevented).toBe(false);
    const safari = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    Object.defineProperty(safari, "keyCode", { value: 229 });
    line.dispatchEvent(safari);
    expect(safari.defaultPrevented).toBe(false);
    expect(press(line, "Enter").defaultPrevented).toBe(true);
  });

  it("leaves Enter and the arrows to the editor when nothing matches", async () => {
    const line = await openOn(unmatched);
    expect(menuShown()).toBe(false);
    expect(press(line, "Enter").defaultPrevented).toBe(false);
    expect(press(line, "ArrowDown").defaultPrevented).toBe(false);
  });

  it("takes no key once it has closed", async () => {
    const line = await openOn(trigger);
    expect(press(line, "Enter").defaultPrevented).toBe(true);
    line.textContent = "plain";
    caretAtEnd(line);
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    expect(menuShown()).toBe(false);
    expect(press(line, "Enter").defaultPrevented).toBe(false);
    expect(press(line, "ArrowDown").defaultPrevented).toBe(false);
  });

  it("takes no key from an editor that is leaving the screen", async () => {
    const line = await openOn(trigger);
    host.setAttribute("inert", "");
    expect(press(line, "Enter").defaultPrevented).toBe(false);
    expect(press(line, "ArrowDown").defaultPrevented).toBe(false);
  });

  it("takes no key typed into a dialog outside the editor", async () => {
    // The ⌘K palette opened over a menu that was still up: its Enter ran the
    // menu's row in the editor behind it, and the palette never saw the key.
    await openOn(trigger);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.dataset.testDialog = "";
    const search = document.createElement("input");
    dialog.appendChild(search);
    document.body.appendChild(dialog);
    search.focus();
    expect(press(search, "Enter").defaultPrevented).toBe(false);
    expect(press(search, "ArrowDown").defaultPrevented).toBe(false);
  });

  // A press on the phone's writing bar types the trigger without a
  // `selectionchange` (WebKit fires none for a selection the editor sets):
  // the editor's own event opens the menu.
  it("opens on the editor's doc-changed event without a selectionchange", async () => {
    const container = createRef<HTMLDivElement>();
    await act(async () =>
      root.render(
        <div ref={container}>
          <p>{trigger}</p>
          {mount(container)}
        </div>,
      ),
    );
    caretAtEnd(host.querySelector("p")!, "doc-changed");
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    expect(menuShown()).toBe(true);
  });

  // What is docked on the viewport's bottom edge (the writing bar) is not
  // room for the menu: the cap shrinks by it.
  it("keeps clear of what is docked on the viewport's bottom edge", async () => {
    window.innerHeight = 300;
    await openOn(trigger);
    const free = host.querySelector<HTMLElement>("[data-testid$=\"menu\"]")!.style.maxHeight;
    act(() => root.unmount());
    root = createRoot(host);
    await renderLine(trigger, 100);
    await act(async () => frames.splice(0).forEach((frame) => frame(0)));
    const docked = host.querySelector<HTMLElement>("[data-testid$=\"menu\"]")!.style.maxHeight;
    expect(free).toBe("280px");
    expect(docked).toBe("194px");
  });
});
