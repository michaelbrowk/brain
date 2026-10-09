// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { history } from "@milkdown/kit/prose/history";
import { editorViewCtx } from "@milkdown/kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDITOR_DOC_CHANGED_EVENT } from "@/lib/editor-events";
import type { MotionProps } from "@/test/framer-motion-mock";

const milkdown = vi.hoisted(() => ({ getEditor: vi.fn() }));
const harness = vi.hoisted(() => ({ reduce: false, motion: null as MotionProps | null }));

vi.mock("@milkdown/react", () => ({
  useInstance: () => [null, milkdown.getEditor],
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: ({ props, motion }) => {
      if (props.role === "toolbar") harness.motion = motion;
    },
  });
});

import { WritingBar } from "./writing-bar";
import { currentScrollBand } from "./scroll-band";

/** The nodes the bar's own commands resolve against: a list to nest, a
 *  paragraph that refuses nesting, a quote that refuses a task, and the
 *  lines a task cannot be: a heading, a code block, a table cell. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    code_block: { content: "text*", group: "block", code: true, marks: "" },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "block+", attrs: { checked: { default: null } }, defining: true },
    table: { content: "table_row+", group: "block" },
    table_row: { content: "table_cell+" },
    table_cell: { content: "block+" },
    text: { group: "inline" },
  },
});

function paragraphDoc() {
  return schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text("one line")));
}

function listDoc() {
  const item = (text: string) =>
    schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text(text)));
  return schema.nodes.doc.create(null, schema.nodes.bullet_list.create(null, [item("one"), item("two")]));
}

function headingDoc() {
  return schema.nodes.doc.create(null, schema.nodes.heading.create(null, schema.text("a title")));
}

function codeDoc() {
  return schema.nodes.doc.create(null, schema.nodes.code_block.create(null, schema.text("let x")));
}

function tableDoc() {
  const nodes = schema.nodes;
  return nodes.doc.create(
    null,
    nodes.table.create(
      null,
      nodes.table_row.create(
        null,
        nodes.table_cell.create(null, nodes.paragraph.create(null, schema.text("cell"))),
      ),
    ),
  );
}

/** The caret inside the LAST textblock of the document. */
function stateWithCaret(doc: ReturnType<typeof paragraphDoc>) {
  let caret = 1;
  doc.descendants((node, pos) => {
    if (node.isTextblock) caret = pos + 1 + node.content.size;
  });
  return EditorState.create({
    doc,
    selection: TextSelection.create(doc, caret),
    plugins: [history()],
  });
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

function bar() {
  return document.body.querySelector<HTMLElement>('[role="toolbar"][aria-label="Writing"]');
}

function button(label: string) {
  const found = bar()?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe("WritingBar", () => {
  let host: HTMLDivElement;
  let editorRoot: HTMLDivElement;
  let root: Root;
  let coarse: boolean;
  /** The visual viewport the test drives: `resize` and `scroll` fire the
   *  listeners the hook registered, the way a real keyboard and a pan do. */
  let vv: { offsetTop: number; height: number };
  let vvListeners: Record<string, Array<() => void>>;
  let scrolls: number;
  let view: {
    state: EditorState;
    editable: boolean;
    dom: HTMLDivElement;
    dispatch: (tr: Transaction) => void;
    focus: ReturnType<typeof vi.fn>;
    hasFocus: ReturnType<typeof vi.fn>;
    setProps: ReturnType<typeof vi.fn>;
  };
  let focused: boolean;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    coarse = true;
    focused = true;
    scrolls = 0;
    harness.reduce = false;
    harness.motion = null;
    window.innerHeight = 844;
    vv = { offsetTop: 0, height: 844 };
    vvListeners = { resize: [], scroll: [] };
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation(() => ({
        matches: coarse,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get: () => ({
        get offsetTop() {
          return vv.offsetTop;
        },
        offsetLeft: 0,
        width: window.innerWidth,
        get height() {
          return vv.height;
        },
        addEventListener: (name: string, fn: () => void) => vvListeners[name]?.push(fn),
        removeEventListener: (name: string, fn: () => void) => {
          vvListeners[name] = (vvListeners[name] ?? []).filter((f) => f !== fn);
        },
      }),
    });

    host = document.createElement("div");
    editorRoot = document.createElement("div");
    editorRoot.tabIndex = 0;
    document.body.append(host, editorRoot);
    root = createRoot(host);

    view = {
      state: stateWithCaret(paragraphDoc()),
      editable: true,
      dom: editorRoot,
      dispatch: (tr) => {
        if (tr.scrolledIntoView) scrolls += 1;
        view.state = view.state.apply(tr);
      },
      focus: vi.fn(),
      hasFocus: vi.fn(() => focused),
      setProps: vi.fn(),
    };
    const commands = { call: vi.fn() };
    const ctx = { get: (key: unknown) => (key === editorViewCtx ? view : commands) };
    milkdown.getEditor.mockReset();
    milkdown.getEditor.mockReturnValue({
      action: vi.fn((action: (context: typeof ctx) => unknown) => action(ctx)),
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    editorRoot.remove();
    vi.unstubAllGlobals();
  });

  async function render(onHeight = vi.fn()) {
    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    await act(async () => root.render(<WritingBar container={container} onHeight={onHeight} />));
    await act(async () => document.dispatchEvent(new Event("focusin")));
    await settle();
    return onHeight;
  }

  async function fireViewport(name: "resize" | "scroll") {
    await act(async () => {
      for (const fn of vvListeners[name]) fn();
    });
    await settle();
  }

  async function keyboard(height: number) {
    vv.height = window.innerHeight - height;
    await fireViewport("resize");
  }

  async function pan(offsetTop: number) {
    vv.offsetTop = offsetTop;
    await fireViewport("scroll");
  }

  it("stands while the editor has the focus on a touch screen, and not on a pointer", async () => {
    await render();
    expect(bar()).not.toBeNull();
    const labels = [...bar()!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Outdent",
      "Indent",
      "Task",
      "Undo",
      "Redo",
      "Slash",
      "Dismiss keyboard",
    ]);

    focused = false;
    await act(async () => document.dispatchEvent(new Event("focusout")));
    await settle();
    expect(bar()).toBeNull();
  });

  it("is absent on a pointer device", async () => {
    coarse = false;
    await render();
    expect(bar()).toBeNull();
  });

  it("hides on a page that cannot be edited", async () => {
    view.editable = false;
    await render();
    expect(bar()).toBeNull();
  });

  // The selection toolbar's link field takes the focus out of the editor
  // while the keyboard is still up: the bar underneath stays rather than
  // dropping the toolbar by its own height.
  it("stays while the focus is in a field one of the docked bars opened", async () => {
    await render();
    const dock = document.createElement("div");
    dock.setAttribute("data-editor-dock", "");
    const input = document.createElement("input");
    dock.append(input);
    document.body.append(dock);
    focused = false;
    input.focus();
    await act(async () => document.dispatchEvent(new Event("focusin")));
    await settle();
    expect(bar()).not.toBeNull();
    dock.remove();
  });

  it("draws Indent and Outdent disabled on a line that cannot nest", async () => {
    await render();
    expect(button("Indent").getAttribute("aria-disabled")).toBe("true");
    expect(button("Outdent").getAttribute("aria-disabled")).toBe("true");
  });

  it("nests the caret's list item, lifts it back, and hands the focus back each time", async () => {
    view.state = stateWithCaret(listDoc());
    await render();
    expect(button("Indent").getAttribute("aria-disabled")).toBe("false");
    await click(button("Indent"));
    expect(view.state.doc.toString()).toContain(
      'bullet_list(list_item(paragraph("one"), bullet_list(list_item(paragraph("two")))))',
    );
    expect(view.focus).toHaveBeenCalledTimes(1);
    expect(button("Indent").getAttribute("aria-disabled")).toBe("true");
    expect(button("Outdent").getAttribute("aria-disabled")).toBe("false");
    await click(button("Outdent"));
    expect(view.state.doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("one")), list_item(paragraph("two"))))',
    );
    expect(view.focus).toHaveBeenCalledTimes(2);
  });

  it("offers Undo once there is something to undo, and Redo after it", async () => {
    await render();
    expect(button("Undo").getAttribute("aria-disabled")).toBe("true");
    expect(button("Redo").getAttribute("aria-disabled")).toBe("true");

    view.dispatch(view.state.tr.insertText(" more"));
    await act(async () => window.dispatchEvent(new Event(EDITOR_DOC_CHANGED_EVENT)));
    await settle();
    expect(button("Undo").getAttribute("aria-disabled")).toBe("false");

    await click(button("Undo"));
    expect(view.state.doc.textContent).toBe("one line");
    expect(button("Redo").getAttribute("aria-disabled")).toBe("false");
    await click(button("Redo"));
    expect(view.state.doc.textContent).toBe("one line more");
  });

  // A task is a paragraph line: the command refuses a heading, a code block
  // and a table cell, so the button says so instead of pressing for nothing.
  it("draws Task disabled on a heading, in a code block and in a table cell", async () => {
    for (const doc of [headingDoc(), codeDoc(), tableDoc()]) {
      view.state = stateWithCaret(doc);
      await render();
      expect(button("Task").getAttribute("aria-disabled")).toBe("true");
      expect(button("Task").title).toBe("A task is a paragraph line");
      await act(async () => root.unmount());
      root = createRoot(host);
    }
    view.state = stateWithCaret(paragraphDoc());
    await render();
    expect(button("Task").getAttribute("aria-disabled")).toBe("false");
  });

  // WebKit fires no `selectionchange` for a selection the editor sets, so the
  // slash menu learns of the typed slash from the editor's own event.
  it("Slash types a slash at the caret and says the document changed", async () => {
    await render();
    expect(button("Slash").title).toBe("Slash: the block menu on an empty line");
    const changed = vi.fn();
    window.addEventListener(EDITOR_DOC_CHANGED_EVENT, changed);
    await click(button("Slash"));
    window.removeEventListener(EDITOR_DOC_CHANGED_EVENT, changed);
    expect(view.state.doc.textContent).toBe("one line/");
    expect(changed).toHaveBeenCalled();
  });

  it("Dismiss keyboard takes the focus out of the editor", async () => {
    await render();
    const blur = vi.spyOn(editorRoot, "blur");
    await click(button("Dismiss keyboard"));
    expect(blur).toHaveBeenCalled();
  });

  // The keyboard arrives over several resizes (Android, one per frame), the
  // reader pans the visual viewport over the page while it is up (iOS,
  // offsetTop up to the keyboard's height), and a URL bar settles by half a
  // pixel with no keyboard at all. One scroll of the caret, when the
  // keyboard arrives; the band holds the keyboard's height through a pan
  // and ignores the drift.
  it("widens the band once the keyboard is up, holds it through a pan, scrolls the caret up once, and ignores drift", async () => {
    await render();
    expect(scrolls).toBe(0);
    expect(currentScrollBand().scrollMargin.bottom).toBe(32);
    expect(editorRoot.style.paddingBottom).toBe("");

    await keyboard(144);
    await keyboard(244);
    await keyboard(336);
    expect(scrolls).toBe(1);
    expect(currentScrollBand()).toEqual({
      scrollThreshold: { top: 64, right: 0, bottom: 336 + 24, left: 0 },
      scrollMargin: { top: 76, right: 0, bottom: 336 + 32, left: 0 },
    });
    expect(editorRoot.style.paddingBottom).toBe("336px");
    expect(bar()!.style.bottom).toBe("336px");

    for (const offsetTop of [50, 150, 336, 150, 0]) {
      await pan(offsetTop);
      expect(scrolls).toBe(1);
      expect(currentScrollBand().scrollMargin.bottom).toBe(336 + 32);
      expect(editorRoot.style.paddingBottom).toBe("336px");
      // The bar itself follows the visual viewport's bottom edge.
      expect(bar()!.style.bottom).toBe(`${336 - offsetTop}px`);
    }

    await keyboard(0);
    expect(currentScrollBand().scrollMargin.bottom).toBe(32);
    expect(editorRoot.style.paddingBottom).toBe("");
    await keyboard(0.5);
    expect(scrolls).toBe(1);
    expect(currentScrollBand().scrollMargin.bottom).toBe(32);
    expect(editorRoot.style.paddingBottom).toBe("");
    expect(bar()!.style.bottom).toBe("0.5px");
  });

  it("scrolls the caret up once more when the keyboard comes back", async () => {
    await render();
    await keyboard(336);
    await keyboard(0);
    await keyboard(336);
    expect(scrolls).toBe(2);
  });

  it("gives the band and the padding back when it leaves, and when it unmounts standing", async () => {
    await render();
    await keyboard(336);
    expect(currentScrollBand().scrollMargin.bottom).toBe(368);

    focused = false;
    await act(async () => document.dispatchEvent(new Event("focusout")));
    await settle();
    expect(currentScrollBand().scrollMargin.bottom).toBe(32);
    expect(editorRoot.style.paddingBottom).toBe("");

    focused = true;
    await act(async () => document.dispatchEvent(new Event("focusin")));
    await settle();
    expect(currentScrollBand().scrollMargin.bottom).toBe(368);
    const onHeight = vi.fn();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(currentScrollBand().scrollMargin.bottom).toBe(32);
    expect(editorRoot.style.paddingBottom).toBe("");
    expect(onHeight).not.toHaveBeenCalledWith(expect.any(Number) && 45);
  });

  it("reports its height while it stands and 0 when it unmounts standing", async () => {
    const onHeight = await render();
    expect(onHeight).toHaveBeenLastCalledWith(0);
    onHeight.mockClear();
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(onHeight).toHaveBeenLastCalledWith(0);
  });

  it("fades with no travel under reduced motion, and slides in otherwise", async () => {
    await render();
    expect(harness.motion?.initial).toEqual({ opacity: 0, y: 8 });
    await act(async () => root.unmount());
    root = createRoot(host);
    harness.reduce = true;
    await render();
    expect(harness.motion?.initial).toEqual({ opacity: 0 });
    expect(harness.motion?.animate).toEqual({ opacity: 1 });
  });
});
