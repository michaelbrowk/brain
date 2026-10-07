// @vitest-environment jsdom

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { tableBlock } from "@milkdown/kit/component/table-block";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentRefs } from "./attachment-refs";
import { editingCore } from "./editing-core";
import { images } from "./image";
import { noNestedTables } from "./table-guard";
import { tableCells } from "./table-cell";

/** The editor's own plugin order for everything a table cell meets: the
 *  presets, the table guard, the editing core, the table cells, Milkdown's
 *  table block and its clipboard. */
async function mount(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(gfm)
    .use(attachmentRefs)
    .use(noNestedTables)
    .use(editingCore)
    .use(images)
    .use(tableCells)
    .use(tableBlock)
    .use(history)
    .use(clipboard)
    .use(listener)
    .create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
  const markdownNow = () =>
    editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc)).trim();
  return { editor, view, markdownNow };
}

/** The position just after the first occurrence of `text` in a text node. */
function after(doc: ProseNode, text: string) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text) + text.length;
    }
    return true;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function caret(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function paste(view: EditorView, text: string, html = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) =>
        type === "text/plain" ? text : type === "text/html" ? html : "",
      files: [],
      items: [],
      types: html ? ["text/plain", "text/html"] : ["text/plain"],
    },
  });
  view.dom.dispatchEvent(event);
}

function key(view: EditorView, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function count(doc: ProseNode, name: string) {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === name) n += 1;
  });
  return n;
}

function cellOf(view: EditorView) {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "table_cell" || node.type.name === "table_header") {
      return node.textContent;
    }
  }
  return null;
}

/** The cells of a serialized table, row by row, the separator left out. */
function rows(markdown: string) {
  return markdown
    .split("\n")
    .filter((line, index) => line.startsWith("|") && index !== 1)
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim().replace(/^<br \/>$/, "")),
    );
}

const TABLE = ["| h1 | h2 |", "| -- | -- |", "| a1 | a2 |", "| b1 | b2 |"].join("\n");

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("paste into a table cell", () => {
  it("fills cells from the caret with tab-separated text and grows the table to fit", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "a2"));
    paste(view, "x1\tx2\tx3\ny1\ty2\ty3\nz1\tz2\tz3\n");
    expect(count(view.state.doc, "table")).toBe(1);
    // An empty cell saves as Milkdown's `<br />` placeholder, read as empty.
    expect(rows(markdownNow())).toEqual([
      ["h1", "h2", "", ""],
      ["a1", "x1", "x2", "x3"],
      ["b1", "y1", "y2", "y3"],
      ["", "z1", "z2", "z3"],
    ]);
    await editor.destroy();
  });

  it("keeps the header row a header when the paste starts in it", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "h1"));
    paste(view, "p\tq\nr\ts");
    expect(count(view.state.doc, "table")).toBe(1);
    const md = markdownNow();
    expect(rows(md)).toEqual([
      ["p", "q"],
      ["r", "s"],
      ["b1", "b2"],
    ]);
    // The pasted cells keep the alignment of the cells they replace.
    expect(md.split("\n")[1]).toBe("| -- | -- |");
    await editor.destroy();
  });

  it("keeps several lines of plain text in the one cell, as line breaks", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    paste(view, " one\ntwo\r\nthree");
    expect(count(view.state.doc, "table")).toBe(1);
    expect(cellOf(view)).toBe("a1 one\ntwo\nthree");
    const md = markdownNow();
    expect(md).toContain("| a1 one<br>two<br>three | a2 |");
    expect(md).toContain("| b1 ");
    await editor.destroy();
  });

  it("leaves a paste outside a table to the clipboard", async () => {
    const { editor, view } = await mount("para");
    caret(view, after(view.state.doc, "para"));
    paste(view, "x\ty\nz\tw");
    expect(count(view.state.doc, "table")).toBe(0);
    await editor.destroy();
  });
});

describe("line breaks in a cell", () => {
  it("load from <br> and save back as <br>, leaving an empty cell empty", async () => {
    const md = ["| a     | b |", "| ----- | - |", "| x<br>y |   |"].join("\n");
    const { editor, view, markdownNow } = await mount(md);
    expect(count(view.state.doc, "hardbreak")).toBe(1);
    expect(markdownNow()).toContain("| x<br>y |");
    expect(markdownNow()).not.toContain("xy");
    await editor.destroy();
  });

  it("Enter makes a new line in the cell and keeps the caret in it", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    expect(key(view, "Enter")).toBe(true);
    view.dispatch(view.state.tr.insertText("next"));
    expect(cellOf(view)).toBe("a1\nnext");
    expect(count(view.state.doc, "table")).toBe(1);
    expect(markdownNow()).toContain("| a1<br>next | a2 |");
    expect(view.state.doc.firstChild?.type.name).toBe("table");
    await editor.destroy();
  });

  it("Shift-Enter makes the same line break, and Mod-Enter still leaves the table", async () => {
    const { editor, view } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    expect(key(view, "Enter", { shiftKey: true })).toBe(true);
    expect(count(view.state.doc, "hardbreak")).toBe(1);
    // jsdom is not a Mac, so Mod is Ctrl here.
    expect(key(view, "Enter", { ctrlKey: true })).toBe(true);
    expect(cellOf(view)).toBeNull();
    await editor.destroy();
  });
});

describe("Tab in a table", () => {
  it("moves to the next cell, and on the last cell adds a row to move into", async () => {
    const { editor, view } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    expect(key(view, "Tab")).toBe(true);
    expect(cellOf(view)).toBe("a2");
    caret(view, after(view.state.doc, "b2"));
    expect(key(view, "Tab")).toBe(true);
    expect(cellOf(view)).toBe("");
    const table = view.state.doc.firstChild!;
    expect(table.childCount).toBe(4);
    await editor.destroy();
  });

  it("Shift-Tab in the first cell stays in it", async () => {
    const { editor, view } = await mount(TABLE);
    caret(view, after(view.state.doc, "h1"));
    expect(key(view, "Tab", { shiftKey: true })).toBe(true);
    expect(cellOf(view)).toBe("h1");
    await editor.destroy();
  });
});
