// @vitest-environment jsdom

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
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
import { CellSelection } from "@milkdown/kit/prose/tables";
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
async function mount(markdown: string, editable = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => editable }));
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

  // What Google Sheets puts on the clipboard: an HTML table and the same
  // range as tab-separated text.
  const SHEETS =
    '<meta charset="utf-8"><google-sheets-html-origin><table data-sheets-root="1"><tbody>' +
    "<tr><td>x</td><td>y</td></tr><tr><td>u</td><td><b>v</b></td></tr></tbody></table>";

  it("fills cells from a spreadsheet range that carries an HTML table too", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    const errors: string[] = [];
    window.addEventListener("error", (event) => errors.push(event.message));
    paste(view, "x\ty\nu\tv", SHEETS);
    expect(errors).toEqual([]);
    expect(count(view.state.doc, "table")).toBe(1);
    expect(rows(markdownNow())).toEqual([
      ["h1", "h2"],
      ["x", "y"],
      ["u", "v"],
    ]);
    await editor.destroy();
  });

  it("fills cells from an HTML table alone, Brain's own cell copy among them", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    // What copying two cells of a Brain table writes: the text has no tab.
    const copied =
      '<table data-pm-slice="1 1 -2 []"><tbody><tr><td style="text-align: left;"><p><strong>a1</strong></p></td>' +
      '<td style="text-align: left;"><p>a2</p></td></tr></tbody></table>';
    caret(view, after(view.state.doc, "b1"));
    paste(view, "a1\n\na2", copied);
    expect(count(view.state.doc, "table")).toBe(1);
    expect(rows(markdownNow())).toEqual([
      ["h1", "h2"],
      ["a1", "a2"],
      ["a1", "a2"],
    ]);
    caret(view, after(view.state.doc, "h1"));
    paste(view, "", "<table><tr><td>p</td><td>q</td></tr></table>");
    expect(rows(markdownNow())[0]).toEqual(["p", "q"]);
    await editor.destroy();
  });

  it("keeps the links and marks of a rich multi-line paste, one line per block", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    paste(
      view,
      "one link\ntwo",
      '<p>one <a href="https://x.io">link</a></p><p><strong>two</strong></p>',
    );
    expect(count(view.state.doc, "table")).toBe(1);
    expect(markdownNow()).toContain("| a1one [link](https://x.io)<br>**two** | a2 |");
    await editor.destroy();
  });

  it("treats one line with a tab and HTML as text for the cell, not as cells", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    caret(view, after(view.state.doc, "a1"));
    paste(view, "p\tq", "<p>p\tq</p>");
    // HTML reads the tab as white space, as a browser shows it.
    expect(rows(markdownNow())[1]).toEqual(["a1p q", "a2"]);
    await editor.destroy();
  });

  it("leaves a selection that runs out of the table to the clipboard", async () => {
    const { editor, view } = await mount(`${TABLE}\n\nafter`);
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener("error", onError);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(
          view.state.doc,
          after(view.state.doc, "a1"),
          after(view.state.doc, "after"),
        ),
      ),
    );
    paste(view, "x\ty\nz\tw");
    key(view, "Enter");
    key(view, "Tab");
    window.removeEventListener("error", onError);
    expect(errors).toEqual([]);
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

  it("keep a trailing line break, so a cell reads back as it was saved", async () => {
    for (const cell of ["one<br>", "one<br><br>", "one<br><br>two"]) {
      const md = `| a |\n| - |\n| ${cell} |`;
      const first = await mount(md);
      const saved = first.markdownNow();
      await first.editor.destroy();
      expect(rows(saved)[1], cell).toEqual([cell]);
      const second = await mount(saved);
      expect(second.markdownNow(), cell).toBe(saved);
      await second.editor.destroy();
    }
  });

  it("keep two Enters at the end of a cell across a save and a reopen", async () => {
    const first = await mount(TABLE);
    caret(first.view, after(first.view.state.doc, "a1"));
    key(first.view, "Enter");
    key(first.view, "Enter");
    expect(count(first.view.state.doc, "hardbreak")).toBe(2);
    const saved = first.markdownNow();
    await first.editor.destroy();
    const second = await mount(saved);
    expect(count(second.view.state.doc, "hardbreak")).toBe(2);
    expect(second.markdownNow()).toBe(saved);
    await second.editor.destroy();
  });

  it("save an empty cell given only an Enter as an empty cell, the same every time", async () => {
    const md = "| a | b |\n| - | - |\n| x | <br /> |";
    const first = await mount(md);
    let pos = -1;
    first.view.state.doc.descendants((node, at) => {
      if (node.type.name === "table_cell" && node.content.size <= 2) pos = at + 2;
    });
    caret(first.view, pos);
    key(first.view, "Enter");
    const saved = first.markdownNow();
    await first.editor.destroy();
    expect(rows(saved)[1]).toEqual(["x", ""]);
    const second = await mount(saved);
    expect(count(second.view.state.doc, "hardbreak")).toBe(0);
    expect(rows(second.markdownNow())[1]).toEqual(["x", ""]);
    await second.editor.destroy();
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
    // In the new row's first cell: row 3 of the table, column 0.
    const { $from } = view.state.selection;
    expect([$from.index(1), $from.index(2)]).toEqual([3, 0]);
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

describe("the edges of a cell", () => {
  it("reads a <br> inside a mark as a line break too", async () => {
    const { editor, view, markdownNow } = await mount("| a |\n| - |\n| **x<br>y** |");
    expect(count(view.state.doc, "hardbreak")).toBe(1);
    expect(markdownNow()).toContain("**x<br>y**");
    await editor.destroy();
  });

  it("writes a break the preset spells as a newline as <br> as well", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    const at = after(view.state.doc, "a1");
    // The inline flavour of a hard break, which pasted HTML can produce,
    // serializes as a newline in a text node.
    view.dispatch(
      view.state.tr.insert(at, view.state.schema.nodes.hardbreak.create({ isInline: true })),
    );
    view.dispatch(view.state.tr.insertText("z", at + 1));
    expect(markdownNow()).toContain("| a1<br>z | a2 |");
    await editor.destroy();
  });

  it("does not turn Enter over selected cells into a line break that empties them", async () => {
    const { editor, view } = await mount(TABLE);
    const $a = view.state.doc.resolve(after(view.state.doc, "a1"));
    const $b = view.state.doc.resolve(after(view.state.doc, "a2"));
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, $a.before($a.depth - 1), $b.before($b.depth - 1)),
      ),
    );
    key(view, "Enter");
    expect(count(view.state.doc, "hardbreak")).toBe(0);
    expect(view.state.doc.textContent).toContain("a1a2");
    await editor.destroy();
  });

  it("takes no paste on a page that cannot be edited", async () => {
    const { editor, view } = await mount(TABLE, false);
    const before = view.state.doc;
    caret(view, after(view.state.doc, "a1"));
    paste(view, "one\ntwo");
    paste(view, "x\ty\nz\tw");
    expect(view.state.doc.eq(before)).toBe(true);
    await editor.destroy();
  });

  it("fills the selected cells with a multi-line paste over a text range across cells", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, after(view.state.doc, "a1"), after(view.state.doc, "a2")),
      ),
    );
    paste(view, "one\ntwo");
    expect(count(view.state.doc, "table")).toBe(1);
    expect(rows(markdownNow())).toEqual([
      ["h1", "h2"],
      ["one<br>two", "one<br>two"],
      ["b1", "b2"],
    ]);
    await editor.destroy();
  });

  it("fills every cell of a selected block of cells with a multi-line paste", async () => {
    const { editor, view, markdownNow } = await mount(TABLE);
    const $a = view.state.doc.resolve(after(view.state.doc, "b2"));
    const $b = view.state.doc.resolve(after(view.state.doc, "a1"));
    view.dispatch(
      view.state.tr.setSelection(
        CellSelection.create(view.state.doc, $a.before($a.depth - 1), $b.before($b.depth - 1)),
      ),
    );
    paste(view, "one\ntwo");
    expect(rows(markdownNow()).slice(1)).toEqual([
      ["one<br>two", "one<br>two"],
      ["one<br>two", "one<br>two"],
    ]);
    await editor.destroy();
  });
});
