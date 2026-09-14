// @vitest-environment jsdom

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

describe("CommandPalette tasks commands", () => {
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
      onOpenTasks?: () => void;
      onNewTask?: () => void;
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

  it("offers Open Tasks and New task, each running its handler", async () => {
    const onOpenTasks = vi.fn();
    const onNewTask = vi.fn();
    await renderPalette({ onOpenTasks, onNewTask });

    expect(action("Open Tasks")).not.toBeNull();
    expect(action("New task")).not.toBeNull();

    await act(async () => action("Open Tasks")!.click());
    expect(onOpenTasks).toHaveBeenCalledTimes(1);

    await act(async () => action("New task")!.click());
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it("finds both by a word that is not in the label", async () => {
    await renderPalette({ onOpenTasks: vi.fn(), onNewTask: vi.fn() });

    const input = document.body.querySelector<HTMLInputElement>("[cmdk-input]");
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "todo");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(action("Open Tasks")).not.toBeNull();
    expect(action("New task")).not.toBeNull();
  });

  it("omits both when the shell supplies neither handler", async () => {
    await renderPalette();

    expect(action("Open Tasks")).toBeNull();
    expect(action("New task")).toBeNull();
  });
});
