// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Schema } from "@milkdown/kit/prose/model";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDITOR_DOC_CHANGED_EVENT, EDITOR_LINK_FIELD_EVENT } from "@/lib/editor-events";

const milkdown = vi.hoisted(() => ({ getEditor: vi.fn() }));

vi.mock("@milkdown/react", () => ({
  useInstance: () => [null, milkdown.getEditor],
}));

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import {
  FloatingToolbar,
  placeFloatingToolbar,
  selectionRectIntersectsViewport,
  selectionIsInQuote,
  selectionIsInTable,
  selectionIsTask,
  selectionOwnsFloatingToolbar,
} from "./floating-toolbar";

/** A schema small enough to read and real enough to resolve a position in.
 *  The toolbar asks the DOCUMENT which lines the selection touches, so a
 *  stubbed `$from` would only ever be testing the stub. */
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    blockquote: { content: "block+", group: "block" },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "block+", attrs: { checked: { default: null } }, defining: true },
    table: { content: "table_row+", group: "block" },
    table_row: { content: "table_cell+" },
    table_cell: { content: "block+" },
    text: { group: "inline" },
  },
  marks: {
    link: { attrs: { href: {}, title: { default: null } } },
  },
});

const LINKED_HREF = "https://example.com/old";

function documentFor(inTable: boolean, task: boolean, quote: boolean, linked = false) {
  const nodes = schema.nodes;
  const line = nodes.paragraph.create(
    null,
    linked
      ? [
          schema.text("selected", [schema.marks.link.create({ href: LINKED_HREF })]),
          schema.text(" editor text"),
        ]
      : schema.text("selected editor text"),
  );
  if (quote) {
    return nodes.doc.create(null, nodes.blockquote.create(null, line));
  }
  if (inTable) {
    return nodes.doc.create(
      null,
      nodes.table.create(null, nodes.table_row.create(null, nodes.table_cell.create(null, line))),
    );
  }
  if (task) {
    return nodes.doc.create(
      null,
      nodes.bullet_list.create(null, nodes.list_item.create({ checked: false }, line)),
    );
  }
  return nodes.doc.create(null, line);
}

function editorState(
  inTable: boolean,
  selectionType: "text" | "node" | "all" = "text",
  empty = false,
  task = false,
  quote = false,
  linked = false,
): EditorState {
  const doc = documentFor(inTable, task, quote, linked);
  let line = 0;
  doc.descendants((node, pos) => {
    if (line === 0 && node.isTextblock) line = pos + 1;
  });
  const selection =
    selectionType === "all"
      ? new AllSelection(doc)
      : selectionType === "node"
        ? NodeSelection.create(doc, line - 1)
        : TextSelection.create(doc, line, empty ? line : line + 8);
  return EditorState.create({ doc, selection });
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
    editable: boolean;
    dispatch: ReturnType<typeof vi.fn>;
    posAtDOM: ReturnType<typeof vi.fn>;
    domAtPos: ReturnType<typeof vi.fn>;
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
      editable: true,
      // A dispatch that applies, so a second action reads the first's result.
      dispatch: vi.fn((tr: Transaction) => {
        view.state = view.state.apply(tr);
      }),
      // The first line's text starts at position 1 in every document here.
      posAtDOM: vi.fn(() => 1),
      domAtPos: vi.fn(() => ({ node: editorRoot.firstChild, offset: 0 })),
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

  async function renderWithSelection(inTable: boolean, ai = false) {
    view.state = editorState(inTable);
    const range = document.createRange();
    range.setStart(editorRoot.firstChild as Text, 0);
    range.setEnd(editorRoot.firstChild as Text, 8);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    await act(async () => root.render(<FloatingToolbar container={container} ai={ai} />));
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
  }

  it("uses the compact table-safe controls and closes AI with Escape or outside click", async () => {
    await renderWithSelection(true, true);
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
      "Link",
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

  it("renders no AI control at all without the capability", async () => {
    await renderWithSelection(false);
    const toolbar = document.body.querySelector('[role="toolbar"]') as HTMLDivElement;
    expect(toolbar).not.toBeNull();
    const labels = [...toolbar.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
    expect(labels).not.toContain("AI");
    expect(labels[0]).toBe("Bold");
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
        '[aria-label="Link"]',
      ) as HTMLButtonElement,
    );
    expect(document.body.querySelector('input[aria-label="Link"]')).not.toBeNull();

    view.hasFocus.mockReturnValue(false);
    await act(async () =>
      document.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    await settle();
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(document.body.querySelector('input[aria-label="Link"]')).not.toBeNull();
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
        '[aria-label="Link"]',
      ) as HTMLButtonElement,
    );
    const input = document.body.querySelector(
      'input[aria-label="Link"]',
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
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();
    expect(document.body.querySelector('[role="toolbar"]')).not.toBeNull();
  });

  /** The field's value, through the setter React listens to. */
  async function typeInto(input: HTMLInputElement, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  }

  async function keyOn(element: Element, key: string) {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    await settle();
  }

  function linkedRuns(state: EditorState) {
    const runs: Array<{ text: string; href: string }> = [];
    state.doc.descendants((node) => {
      const mark = node.marks.find((m) => m.type.name === "link");
      if (node.isText && mark) runs.push({ text: node.text ?? "", href: String(mark.attrs.href) });
    });
    return runs;
  }

  it("takes an address in the Link field: the page rows give way to one row, and Enter links the words", async () => {
    await renderWithSelection(false);
    await click(document.body.querySelector('[aria-label="Link"]') as HTMLButtonElement);
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    expect(input.placeholder).toBe("Paste a link or search pages");
    expect(document.body.textContent).toContain("No pages");

    await typeInto(input, "example.com/spec");
    expect(document.body.textContent).toContain("Link to https://example.com/spec");
    expect(document.body.textContent).not.toContain("No pages");

    await keyOn(input, "Enter");
    expect(view.dispatch).toHaveBeenCalledTimes(1);
    expect(linkedRuns(view.state)).toEqual([{ text: "selected", href: "https://example.com/spec" }]);
    expect(view.state.doc.textContent).toBe("selected editor text");
    expect(view.focus).toHaveBeenCalled();
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();
  });

  it("opens over a clicked link with its address, rewrites it on Enter, and Remove link takes it off the words", async () => {
    view.state = editorState(false, "text", true, false, false, true);
    editorRoot.replaceChildren();
    const anchor = document.createElement("a");
    anchor.href = LINKED_HREF;
    anchor.textContent = "selected";
    editorRoot.append(anchor, document.createTextNode(" editor text"));
    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    await act(async () => root.render(<FloatingToolbar container={container} />));
    await settle();
    expect(document.body.querySelector('[role="toolbar"]')).toBeNull();

    await click(anchor);
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe(LINKED_HREF);
    expect(input.placeholder).toBe("Link address");
    expect(document.body.querySelector('[aria-label="Open link"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Remove link"]')).not.toBeNull();

    await typeInto(input, "https://example.com/new");
    await keyOn(input, "Enter");
    expect(linkedRuns(view.state)).toEqual([{ text: "selected", href: "https://example.com/new" }]);
    expect(view.state.doc.textContent).toBe("selected editor text");

    anchor.href = "https://example.com/new";
    await click(anchor);
    const remove = document.body.querySelector('[aria-label="Remove link"]') as HTMLButtonElement;
    expect(remove).not.toBeNull();
    await click(remove);
    expect(linkedRuns(view.state)).toEqual([]);
    expect(view.state.doc.textContent).toBe("selected editor text");
  });

  it("opens the field for Mod-Shift-k over the selection, and leaves the field alone when nothing is selected", async () => {
    await renderWithSelection(false);
    await act(async () => window.dispatchEvent(new CustomEvent(EDITOR_LINK_FIELD_EVENT)));
    await settle();
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("");

    await keyOn(input, "Escape");
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();

    view.state = editorState(false, "text", true);
    window.getSelection()?.removeAllRanges();
    await act(async () => window.dispatchEvent(new CustomEvent(EDITOR_LINK_FIELD_EVENT)));
    await settle();
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();
  });

  /** A linked first word in the editor's DOM, matching `editorState(…, linked)`. */
  async function renderLinkedLine(attributes: Record<string, string> = {}) {
    view.state = editorState(false, "text", true, false, false, true);
    editorRoot.replaceChildren();
    const anchor = document.createElement("a");
    anchor.href = LINKED_HREF;
    anchor.textContent = "selected";
    for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
    editorRoot.append(anchor, document.createTextNode(" editor text"));
    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    await act(async () => root.render(<FloatingToolbar container={container} />));
    await settle();
    return anchor;
  }

  it("keeps page rows under the address row, and reads a bare file-like name as a page first", async () => {
    view.state = editorState(false);
    const range = document.createRange();
    range.setStart(editorRoot.firstChild as Text, 0);
    range.setEnd(editorRoot.firstChild as Text, 8);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    const pages = [
      { id: "notes", title: "notes.md" },
      { id: "spec", title: "the example.com/spec page" },
    ];
    await act(async () => root.render(<FloatingToolbar container={container} pages={pages} />));
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
    await click(document.body.querySelector('[aria-label="Link"]') as HTMLButtonElement);
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;

    // A page is titled like a file: the page wins while one matches.
    await typeInto(input, "notes.md");
    expect(document.body.querySelector('[aria-label="notes.md"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Link to https://notes.md");
    await keyOn(input, "Enter");
    expect(linkedRuns(view.state)).toEqual([{ text: "selected", href: "/p/notes#words" }]);

    // No page matches: the bare domain is an address. (The bar went with
    // the link, and jsdom moved the selection into the field; selecting the
    // words again brings it back.)
    const reselect = document.createRange();
    reselect.setStart(editorRoot.firstChild as Text, 0);
    reselect.setEnd(editorRoot.firstChild as Text, 8);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(reselect);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
    await click(document.body.querySelector('[aria-label="Link"]') as HTMLButtonElement);
    const again = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    await typeInto(again, "other.md");
    expect(document.body.textContent).toContain("Link to https://other.md");

    // A scheme, www. or a path is an address even beside a matching page,
    // and the page rows stand under it.
    await typeInto(again, "example.com/spec");
    expect(document.body.textContent).toContain("Link to https://example.com/spec");
    expect(document.body.querySelector('[aria-label="the example.com/spec page"]')).not.toBeNull();
    const rows = [...document.body.querySelectorAll('[role="toolbar"] button')].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(rows.indexOf("Link to https://example.com/spec")).toBeLessThan(
      rows.indexOf("the example.com/spec page"),
    );
    await keyOn(again, "Enter");
    expect(linkedRuns(view.state)[0]).toEqual({ text: "selected", href: "https://example.com/spec" });
  });

  it("writes the words marker for a page address typed into the field", async () => {
    await renderWithSelection(false);
    await click(document.body.querySelector('[aria-label="Link"]') as HTMLButtonElement);
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    await typeInto(input, `${window.location.origin}/p/abc123`);
    await keyOn(input, "Enter");
    expect(linkedRuns(view.state)).toEqual([{ text: "selected", href: "/p/abc123#words" }]);
  });

  it("stays shut for a read-only editor: no field on a click or on Mod-Shift-k", async () => {
    view.editable = false;
    const anchor = await renderLinkedLine();
    await click(anchor);
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();
    await act(async () => window.dispatchEvent(new CustomEvent(EDITOR_LINK_FIELD_EVENT)));
    await settle();
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("leaves a download link alone", async () => {
    const anchor = await renderLinkedLine({ download: "" });
    await click(anchor);
    expect(document.body.querySelector('input[aria-label="Link"]')).toBeNull();
  });

  it("opens for the words, not the link, when the selection spills out of a link", async () => {
    view.state = editorState(false, "text", false, false, false, true);
    const range = document.createRange();
    range.setStart(editorRoot.firstChild as Text, 0);
    range.setEnd(editorRoot.firstChild as Text, 12);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const container = createRef<HTMLDivElement>();
    container.current = editorRoot;
    await act(async () => root.render(<FloatingToolbar container={container} />));
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
    // "selected edi": the selection runs past the link's end.
    view.state = view.state.apply(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 13)),
    );
    await click(document.body.querySelector('[aria-label="Link"]') as HTMLButtonElement);
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Paste a link or search pages");
    expect(document.body.querySelector('[aria-label="Remove link"]')).toBeNull();
  });

  it("does not rewrite a link whose address changed under the open field, and removes on an emptied Enter", async () => {
    const anchor = await renderLinkedLine();
    await click(anchor);
    const input = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    // Another hand changed the link while the field was open.
    view.state = view.state.apply(
      view.state.tr
        .removeMark(1, 9, schema.marks.link)
        .addMark(1, 9, schema.marks.link.create({ href: "https://example.com/elsewhere" })),
    );
    view.dispatch.mockClear();
    await typeInto(input, "https://example.com/new");
    await keyOn(input, "Enter");
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(linkedRuns(view.state)).toEqual([
      { text: "selected", href: "https://example.com/elsewhere" },
    ]);

    anchor.href = "https://example.com/elsewhere";
    await click(anchor);
    const field = document.body.querySelector('input[aria-label="Link"]') as HTMLInputElement;
    expect(field.value).toBe("https://example.com/elsewhere");
    await typeInto(field, "");
    await keyOn(field, "Enter");
    expect(linkedRuns(view.state)).toEqual([]);
    expect(view.state.doc.textContent).toBe("selected editor text");
  });

  it("presses the Task button only while the line is already a task, both ways", async () => {
    await renderWithSelection(false);
    const taskButton = () =>
      document.body.querySelector('[aria-label="Task"]') as HTMLButtonElement;
    expect(taskButton()).not.toBeNull();
    expect(taskButton().getAttribute("aria-pressed")).toBe("false");
    // Two controls are named Task, one here and one in the slash menu. The
    // names stay; the tooltip says which line this one acts on.
    expect(taskButton().getAttribute("title")).toBe("Task line");

    view.state = editorState(false, "text", false, true);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
    expect(taskButton().getAttribute("aria-pressed")).toBe("true");

    view.state = editorState(false);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();
    expect(taskButton().getAttribute("aria-pressed")).toBe("false");
  });

  it("refuses the Task button inside a quote, and says why", async () => {
    await renderWithSelection(false);
    const taskButton = () =>
      document.body.querySelector('[aria-label="Task"]') as HTMLButtonElement;
    expect(taskButton().getAttribute("aria-disabled")).toBe("false");

    view.state = editorState(false, "text", false, false, true);
    await act(async () => document.dispatchEvent(new Event("selectionchange")));
    await settle();

    expect(taskButton().getAttribute("aria-disabled")).toBe("true");
    expect(taskButton().getAttribute("title")).toBe("A task cannot live inside a quote");

    editor.action.mockClear();
    await click(taskButton());
    expect(editor.action).not.toHaveBeenCalled();
  });

  it("re-reads the pressed state from the editor's own transaction", async () => {
    await renderWithSelection(false);
    const taskButton = () =>
      document.body.querySelector('[aria-label="Task"]') as HTMLButtonElement;
    expect(taskButton().getAttribute("aria-pressed")).toBe("false");

    // The press rewrites the block under a caret that has not moved, so the
    // browser fires no `selectionchange` and the button used to keep saying
    // unpressed about the line it had turned into a task a moment before.
    view.state = editorState(false, "text", false, true);
    await act(async () => window.dispatchEvent(new CustomEvent(EDITOR_DOC_CHANGED_EVENT)));
    await settle();
    expect(taskButton().getAttribute("aria-pressed")).toBe("true");
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

  it("detects a quote ancestor at either selection edge", () => {
    expect(selectionIsInQuote(editorState(false, "text", false, false, true))).toBe(true);
    expect(selectionIsInQuote(editorState(false))).toBe(false);
  });

  it("detects a task-item ancestor at either selection edge", () => {
    expect(selectionIsTask(editorState(false, "text", false, true))).toBe(true);
    expect(selectionIsTask(editorState(false))).toBe(false);
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
