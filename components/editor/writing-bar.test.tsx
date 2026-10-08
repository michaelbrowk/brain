// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { history } from "@milkdown/kit/prose/history";
import { editorViewCtx } from "@milkdown/kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDITOR_DOC_CHANGED_EVENT } from "@/lib/editor-events";

const milkdown = vi.hoisted(() => ({ getEditor: vi.fn() }));

vi.mock("@milkdown/react", () => ({
  useInstance: () => [null, milkdown.getEditor],
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { WritingBar } from "./writing-bar";
import { currentScrollBand } from "./scroll-band";

/** The nodes the bar's own commands resolve against: a list to nest, a
 *  paragraph that refuses nesting, a quote that refuses a task. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "block+", attrs: { checked: { default: null } }, defining: true },
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
  let keyboard: number;
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
    keyboard = 0;
    focused = true;
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
    // jsdom has no visualViewport; the one here shrinks by `keyboard`.
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get: () => ({
        offsetTop: 0,
        offsetLeft: 0,
        width: window.innerWidth,
        height: window.innerHeight - keyboard,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
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

  it("draws Indent and Outdent disabled on a line that cannot nest", async () => {
    await render();
    expect(button("Indent").getAttribute("aria-disabled")).toBe("true");
    expect(button("Outdent").getAttribute("aria-disabled")).toBe("true");
  });

  it("nests the caret's list item and lifts it back", async () => {
    view.state = stateWithCaret(listDoc());
    await render();
    expect(button("Indent").getAttribute("aria-disabled")).toBe("false");
    await click(button("Indent"));
    expect(view.state.doc.toString()).toContain(
      'bullet_list(list_item(paragraph("one"), bullet_list(list_item(paragraph("two")))))',
    );
    expect(button("Indent").getAttribute("aria-disabled")).toBe("true");
    expect(button("Outdent").getAttribute("aria-disabled")).toBe("false");
    await click(button("Outdent"));
    expect(view.state.doc.toString()).toBe(
      'doc(bullet_list(list_item(paragraph("one")), list_item(paragraph("two"))))',
    );
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

  // WebKit fires no `selectionchange` for a selection the editor sets, so the
  // slash menu learns of the typed slash from the editor's own event.
  it("Slash types a slash at the caret and says the document changed", async () => {
    await render();
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

  it("widens the editor's bottom scroll band by the keyboard and itself, and gives it back", async () => {
    keyboard = 300;
    await render();
    expect(currentScrollBand()).toEqual({
      scrollThreshold: { top: 64, right: 0, bottom: 300 + 24, left: 0 },
      scrollMargin: { top: 76, right: 0, bottom: 300 + 32, left: 0 },
    });
    // The band is a plugin prop, never a `setProps`: that re-runs the view's
    // update and flushes the DOM observer under a keystroke.
    expect(view.setProps).not.toHaveBeenCalled();
    expect(editorRoot.style.paddingBottom).toBe("300px");

    focused = false;
    await act(async () => document.dispatchEvent(new Event("focusout")));
    await settle();
    expect(currentScrollBand()).toEqual({
      scrollThreshold: { top: 64, right: 0, bottom: 24, left: 0 },
      scrollMargin: { top: 76, right: 0, bottom: 32, left: 0 },
    });
    expect(editorRoot.style.paddingBottom).toBe("");
  });
});
