// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AllSelection,
  NodeSelection,
  TextSelection,
  type EditorState,
} from "@milkdown/kit/prose/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const milkdown = vi.hoisted(() => ({ getEditor: vi.fn() }));

vi.mock("@milkdown/react", () => ({
  useInstance: () => [null, milkdown.getEditor],
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import {
  FloatingToolbar,
  placeFloatingToolbar,
  selectionRectIntersectsViewport,
  selectionIsInTable,
  selectionOwnsFloatingToolbar,
} from "./floating-toolbar";

function resolvedPosition(names: string[]) {
  return {
    depth: names.length - 1,
    node: (depth: number) => ({ type: { name: names[depth] } }),
  };
}

function editorState(
  inTable: boolean,
  selectionType: "text" | "node" | "all" = "text",
  empty = false,
): EditorState {
  const names = inTable
    ? ["doc", "table", "table_row", "table_cell", "paragraph"]
    : ["doc", "paragraph"];
  const $pos = resolvedPosition(names);
  const selection = {
    $from: $pos,
    $to: $pos,
    from: 1,
    to: empty ? 1 : 5,
    empty,
  };
  Object.setPrototypeOf(
    selection,
    selectionType === "text"
      ? TextSelection.prototype
      : selectionType === "all"
        ? AllSelection.prototype
        : NodeSelection.prototype,
  );
  return { selection } as unknown as EditorState;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe("FloatingToolbar", () => {
  let host: HTMLDivElement;
  let editorRoot: HTMLDivElement;
  let root: Root;
  let view: {
    state: EditorState;
    focus: ReturnType<typeof vi.fn>;
    hasFocus: ReturnType<typeof vi.fn>;
  };
  let editor: { action: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [
        DOMRect.fromRect({ x: 20, y: 80, width: 0, height: 18 }),
        DOMRect.fromRect({ x: 24, y: 80, width: 120, height: 18 }),
      ],
    });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => DOMRect.fromRect({ x: 24, y: 80, width: 120, height: 18 }),
    });

    host = document.createElement("div");
    editorRoot = document.createElement("div");
    editorRoot.appendChild(document.createTextNode("selected editor text"));
    document.body.append(host, editorRoot);
    root = createRoot(host);

    view = {
      state: editorState(false),
      focus: vi.fn(),
      hasFocus: vi.fn(() => true),
    };
    const ctx = { get: () => view };
    editor = {
      action: vi.fn((action: (context: typeof ctx) => unknown) => action(ctx)),
    };
    milkdown.getEditor.mockReset();
    milkdown.getEditor.mockReturnValue(editor);
  });

  afterEach(async () => {
    window.getSelection()?.removeAllRanges();
    await act(async () => root.unmount());
    host.remove();
    editorRoot.remove();
    vi.unstubAllGlobals();
  });

  async function renderWithSelection(inTable: boolean) {
    view.state = editorState(inTable);
    const range = document.createRange();
    range.setStart(editorRoot.firstChild as Text, 0);
    range.setEnd(editorRoot.firstChild as Text, 8);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    await act(async () => root.render(<FloatingToolbar container={container} />));
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
  }

  it("uses the compact table-safe controls and closes AI with Escape or outside click", async () => {
    await renderWithSelection(true);
    const toolbar = document.body.querySelector('[role="toolbar"]') as HTMLDivElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.getAttribute("aria-label")).toBe("Text formatting");

    const labels = [...toolbar.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).toEqual([
      "AI",
      "Bold",
      "Italic",
      "Strikethrough",
      "Code",
      "Link to page",
      "Colour",
    ]);
    expect(toolbar.querySelector('[aria-label="Table"]')).toBeNull();

    const selected = window.getSelection()?.toString();
    await click(toolbar.querySelector('[aria-label="AI"]') as HTMLButtonElement);
    expect(document.body.textContent).toContain("Back");
    expect(document.body.textContent).toContain("Improve");
    expect(window.getSelection()?.toString()).toBe(selected);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).not.toContain("Improve");
    expect(view.focus).toHaveBeenCalledTimes(1);

    await click(document.body.querySelector('[aria-label="AI"]') as HTMLButtonElement);
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    await settle();
    expect(document.body.textContent).not.toContain("Improve");
  });

  it("refuses a nested table even if the visible context has not refreshed yet", async () => {
    const blockedNotice = vi.fn();
    window.addEventListener("brain:nested-table-blocked", blockedNotice);
    await renderWithSelection(false);
    const table = document.body.querySelector('[aria-label="Table"]') as HTMLButtonElement;
    expect(table).not.toBeNull();

    view.state = editorState(true);
    editor.action.mockClear();
    await click(table);
    expect(editor.action).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[aria-label="Table"]')).toBeNull();
    expect(blockedNotice).toHaveBeenCalledTimes(1);
    window.removeEventListener("brain:nested-table-blocked", blockedNotice);
  });

  it("does not resurrect a stale toolbar after the editor loses focus", async () => {
    await renderWithSelection(false);
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();

    view.hasFocus.mockReturnValue(false);
    await act(async () =>
      document.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    await settle();
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull();

    await act(async () => document.dispatchEvent(new Event("scroll")));
    await settle();
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull();
  });

  it("keeps an intentional submenu open while its input owns focus", async () => {
    await renderWithSelection(false);
    await click(
      document.body.querySelector(
        '[aria-label="Link to page"]',
      ) as HTMLButtonElement,
    );
    expect(document.body.querySelector('input[aria-label="Link to page"]')).not.toBeNull();

    view.hasFocus.mockReturnValue(false);
    await act(async () =>
      document.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    await settle();
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(document.body.querySelector('input[aria-label="Link to page"]')).not.toBeNull();
  });

  it("keeps the saved selection while a main toolbar button owns focus", async () => {
    await renderWithSelection(false);
    const bold = document.body.querySelector(
      '[aria-label="Bold"]',
    ) as HTMLButtonElement;

    view.hasFocus.mockReturnValue(false);
    await act(async () => bold.focus());
    await settle();

    expect(document.activeElement).toBe(bold);
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();
  });

  it("restores editor focus when Escape closes the page-link submenu", async () => {
    await renderWithSelection(false);
    await click(
      document.body.querySelector(
        '[aria-label="Link to page"]',
      ) as HTMLButtonElement,
    );
    const input = document.body.querySelector(
      'input[aria-label="Link to page"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();

    editorRoot.tabIndex = -1;
    view.hasFocus.mockImplementation(
      () => document.activeElement === editorRoot,
    );
    view.focus.mockImplementation(() => {
      editorRoot.focus();
      const range = document.createRange();
      range.setStart(editorRoot.firstChild as Text, 0);
      range.setEnd(editorRoot.firstChild as Text, 8);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await settle();

    expect(view.focus).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('input[aria-label="Link to page"]')).toBeNull();
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();
  });

  it("ignores the NodeSelection left behind by a block drag", async () => {
    await renderWithSelection(false);
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();

    view.state = editorState(false, "node");
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull();
  });
});

describe("floating toolbar geometry", () => {
  it("detects table ancestors at either selection edge", () => {
    expect(selectionIsInTable(editorState(true))).toBe(true);
    expect(selectionIsInTable(editorState(false))).toBe(false);
  });

  it("requires a focused, non-empty text selection", () => {
    expect(selectionOwnsFloatingToolbar(editorState(false), true)).toBe(true);
    expect(selectionOwnsFloatingToolbar(editorState(false), false)).toBe(false);
    expect(selectionOwnsFloatingToolbar(editorState(false, "node"), true)).toBe(
      false,
    );
    expect(selectionOwnsFloatingToolbar(editorState(false, "all"), true)).toBe(
      true,
    );
    expect(selectionOwnsFloatingToolbar(editorState(false, "text", true), true)).toBe(
      false,
    );
  });

  it("clamps to the viewport and flips below a selection near the top", () => {
    expect(
      placeFloatingToolbar(
        { top: 4, right: 32, bottom: 24, left: 4, width: 28 },
        { width: 200, height: 40 },
        { top: 0, right: 320, bottom: 640, left: 0 },
      ),
    ).toEqual({ left: 108, top: 30 });
  });

  it("distinguishes a visible selection from one scrolled outside the viewport", () => {
    const viewport = { top: 0, right: 320, bottom: 640, left: 0 };
    expect(
      selectionRectIntersectsViewport(
        { top: 80, right: 144, bottom: 98, left: 24 },
        viewport,
      ),
    ).toBe(true);
    expect(
      selectionRectIntersectsViewport(
        { top: -80, right: 144, bottom: -62, left: 24 },
        viewport,
      ),
    ).toBe(false);
  });
});
