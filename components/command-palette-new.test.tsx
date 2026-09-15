// @vitest-environment jsdom

// THE THREE CREATES, IN THE PALETTE TOO.
//
// The plus offers a task, a message and a page. The palette is the same offer
// typed rather than pointed at, so it lists the same three wherever it lists
// the first of them. "Compose message" was a mail-route row and could not be
// reached from a page, which is the one place a writer is most likely to want
// it. One row per act, though: on /mail the route's own Compose message row
// already names it, so the global New message row stands down there and
// stands everywhere else.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./command-palette";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function action(label: string): HTMLElement | null {
  return (
    ([...document.body.querySelectorAll("[cmdk-item]")].find(
      (item) => item.textContent?.trim() === label,
    ) as HTMLElement | undefined) ?? null
  );
}

describe("CommandPalette creates", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ hits: [] }),
      } as Response),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  async function renderPalette(
    handlers: {
      onNewPage?: () => void;
      onNewTask?: () => void;
      onNewMessage?: () => void;
    } = {},
  ) {
    await act(async () =>
      root.render(
        <CommandPalette
          open
          onOpenChange={vi.fn()}
          tree={[]}
          onSelect={vi.fn()}
          hasCurrent={false}
          {...handlers}
        />,
      ),
    );
  }

  it("lists New message beside New page and New task", async () => {
    const onNewPage = vi.fn();
    const onNewTask = vi.fn();
    const onNewMessage = vi.fn();
    await renderPalette({ onNewPage, onNewTask, onNewMessage });

    // "New page" carries its ⌘⌥N chip inside the row, so it is matched by
    // its opening words rather than by the whole line
    expect(
      [...document.body.querySelectorAll("[cmdk-item]")].some((item) =>
        item.textContent?.startsWith("New page"),
      ),
    ).toBe(true);
    expect(action("New task")).not.toBeNull();
    expect(action("New message")).not.toBeNull();

    await act(async () => action("New message")!.click());
    expect(onNewMessage).toHaveBeenCalledTimes(1);
  });

  it("finds New message by the words a writer would type", async () => {
    await renderPalette({ onNewPage: vi.fn(), onNewMessage: vi.fn() });

    const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "email");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(action("New message")).not.toBeNull();
    expect(action("New page")).toBeNull();
  });

  it("omits New message when no handler is supplied", async () => {
    await renderPalette({ onNewPage: vi.fn() });
    expect(action("New message")).toBeNull();
  });

  it("stands down on /mail, where the route's own Compose row already names the act", async () => {
    window.history.replaceState({}, "", "/mail");
    await renderPalette({ onNewPage: vi.fn(), onNewMessage: vi.fn() });

    // one row per act: the route row stands, the global one does not double it
    expect(action("Compose message")).not.toBeNull();
    expect(action("New message")).toBeNull();
  });
});
