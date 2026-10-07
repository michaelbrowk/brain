import { InitReady, remarkPluginsCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { hardbreakFilterNodes } from "@milkdown/kit/preset/commonmark";
import { tableCellSchema, tableHeaderSchema } from "@milkdown/kit/preset/gfm";
import {
  Fragment,
  type Node as ProseNode,
  type Schema,
  Slice,
} from "@milkdown/kit/prose/model";
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
} from "@milkdown/kit/prose/state";
import {
  CellSelection,
  TableMap,
  addRow,
  goToNextCell,
  handlePaste as pasteTableCells,
  selectedRect,
  tableNodeTypes,
} from "@milkdown/kit/prose/tables";
import type {
  MarkdownNode,
  RemarkPlugin,
  Root,
  SerializerState,
} from "@milkdown/kit/transformer";
import type { EditorView } from "@milkdown/kit/prose/view";
import { $prose, $useKeymap } from "@milkdown/kit/utils";
import { isInTable } from "./table-guard";

/** WHAT A TABLE CELL HOLDS, AND HOW IT KEEPS IT.
 *
 *  A GFM cell is one line of Markdown, so a line break inside it has exactly
 *  one spelling that survives the file: `<br>`. Milkdown has neither half of
 *  that. Its serializer wrote a break in a cell as a space, and its own
 *  empty-line pass strips every `<br>` on load, so `one<br>two` opened as
 *  `onetwo` and saved that way. A cell's line breaks load from `<br>` and save
 *  as `<br>` here, which is what lets Enter and a multi-line paste put a new
 *  line in the cell instead of somewhere outside it. */

const BREAK_HTML = /^<br\s*\/?>$/i;

function isBreakHtml(node: MarkdownNode | undefined) {
  return (
    node?.type === "html" &&
    typeof node.value === "string" &&
    BREAK_HTML.test(node.value.trim())
  );
}

function breaksFromHtml(node: MarkdownNode) {
  node.children = node.children?.map((child) => {
    if (isBreakHtml(child)) return { type: "break" } as MarkdownNode;
    breaksFromHtml(child);
    return child;
  });
}

function walkCells(node: MarkdownNode) {
  if (node.type === "tableCell") {
    // A cell that is nothing but `<br />` is the placeholder Milkdown writes
    // for an empty cell. It stays html, and the empty-line pass empties it.
    if (node.children?.length === 1 && isBreakHtml(node.children[0])) return;
    breaksFromHtml(node);
    return;
  }
  node.children?.forEach(walkCells);
}

/** Ahead of every other remark pass, because the preset's pass that strips
 *  `<br>` would otherwise leave nothing to read. */
const remarkCellBreaks: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(InitReady);
  const entry = {
    plugin: () => (tree: Root) => walkCells(tree as unknown as MarkdownNode),
    options: {},
  } as unknown as RemarkPlugin;
  ctx.update(remarkPluginsCtx, (plugins) => [entry, ...plugins]);
  return () => {
    ctx.update(remarkPluginsCtx, (plugins) =>
      plugins.filter((plugin) => plugin !== entry),
    );
  };
};

const BREAK_NODE = { type: "html", value: "<br>" } as MarkdownNode;

function breaksToHtml(nodes: MarkdownNode[] | undefined): MarkdownNode[] | undefined {
  return nodes?.flatMap((node): MarkdownNode[] => {
    if (node.type === "break") return [{ ...BREAK_NODE }];
    if (node.type === "text" && typeof node.value === "string" && node.value.includes("\n")) {
      return node.value.split("\n").flatMap((part, index) => [
        ...(index ? [{ ...BREAK_NODE }] : []),
        ...(part ? [{ ...node, value: part }] : []),
      ]);
    }
    if (!node.children) return [node];
    return [{ ...node, children: breaksToHtml(node.children) }];
  });
}

function serializeCell(state: SerializerState, node: ProseNode) {
  state.openNode("tableCell").next(node.content);
  const cell = state.top();
  if (cell) cell.children = breaksToHtml(cell.children);
  state.closeNode();
}

const cellSchema = tableCellSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  toMarkdown: {
    match: (node) => node.type.name === "table_cell",
    runner: serializeCell,
  },
}));

const headerSchema = tableHeaderSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  toMarkdown: {
    match: (node) => node.type.name === "table_header",
    runner: serializeCell,
  },
}));

/** One cell per tab, one row per line, each cell taking the type and the
 *  alignment of the cell it replaces, so a paste that starts in the header
 *  keeps the header a header and a column keeps its alignment. */
function tsvSlice(state: EditorState, text: string): Slice {
  const schema: Schema = state.schema;
  const types = tableNodeTypes(schema);
  const rect = selectedRect(state);
  const rows = text.split("\n").map((line, index) => {
    const row = rect.table.maybeChild(rect.top + index);
    const header = row?.firstChild?.type === types.header_cell;
    const cellType = header ? types.header_cell : types.cell;
    const cells = line.split("\t").map((value, column) =>
      cellType.create(
        row?.maybeChild(rect.left + column)?.attrs ?? null,
        schema.nodes.paragraph.create(null, value ? schema.text(value) : null),
      ),
    );
    return (row?.type ?? types.row).create(null, cells);
  });
  return new Slice(Fragment.from(rows), 0, 0);
}

/** The text with each line ending as a hard break, for the cell it is in. */
function linesSlice(schema: Schema, text: string): Slice {
  const nodes: ProseNode[] = [];
  text.split("\n").forEach((line, index) => {
    if (index) nodes.push(schema.nodes.hardbreak.create());
    if (line) nodes.push(schema.text(line));
  });
  return new Slice(Fragment.from(nodes), 0, 0);
}

/** Whether a plain-text paste into a cell was taken here; false leaves it to
 *  the clipboard. Tab-separated text is cells from the caret on, the table
 *  growing to fit. Several lines are line breaks in the cell. */
function pasteIntoCell(view: EditorView, event: ClipboardEvent): boolean {
  const { state } = view;
  const raw = event.clipboardData?.getData("text/plain") ?? "";
  const text = raw.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  if (text.includes("\t")) {
    return pasteTableCells(view, event, tsvSlice(state, text));
  }
  if (!text.includes("\n")) return false;
  if (state.selection instanceof CellSelection) {
    return pasteTableCells(view, event, linesSlice(state.schema, text));
  }
  if (!state.selection.$from.sameParent(state.selection.$to)) return false;
  view.dispatch(
    state.tr.replaceSelection(linesSlice(state.schema, text)).scrollIntoView(),
  );
  return true;
}

/** A paste into a cell stays in the table.
 *
 *  ProseMirror reads plain text as one paragraph per line, then fits those to
 *  the cell it lands in by making each line a cell of its own, so
 *  prosemirror-tables laid the lines out across the row with their tabs still
 *  in them. Milkdown's clipboard, next in line, parses the same text as
 *  Markdown blocks and splits the table around them. This answers the DOM
 *  event before either of them, from the plain text, even when the source
 *  also offered HTML: paragraphs of a web page fit the same way. Only HTML
 *  that is itself a table (a spreadsheet range, another table's cells) goes
 *  on to prosemirror-tables, which reads its cells and keeps their marks. */
const cellPaste = $prose(
  () =>
    new Plugin({
      key: new PluginKey("brainTableCellPaste"),
      props: {
        handleDOMEvents: {
          paste: (view, event) => {
            if (!view.editable || !isInTable(view.state.selection.$from)) return false;
            const html = event.clipboardData?.getData("text/html") ?? "";
            if (/<table[\s>]/i.test(html)) return false;
            if (!pasteIntoCell(view, event)) return false;
            event.preventDefault();
            return true;
          },
        },
      },
    }),
);

const newLineInCell: Command = (state, dispatch) => {
  const { selection } = state;
  if (selection instanceof CellSelection || !isInTable(selection.$from)) {
    return false;
  }
  dispatch?.(
    state.tr
      .replaceSelectionWith(state.schema.nodes.hardbreak.create())
      .scrollIntoView(),
  );
  return true;
};

/** The next cell, or from the last one a new row to write in. */
const nextCellOrNewRow: Command = (state, dispatch) => {
  if (!isInTable(state.selection.$from)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  if (dispatch) {
    const rect = selectedRect(state);
    const tr = addRow(state.tr, rect, rect.bottom);
    const table = tr.doc.nodeAt(rect.tableStart - 1);
    if (!table) return true;
    const pos =
      rect.tableStart + TableMap.get(table).positionAt(rect.bottom, 0, table);
    dispatch(
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView(),
    );
  }
  return true;
};

/** The previous cell. The first one keeps the caret rather than letting the
 *  browser carry the focus to the control before the editor. */
const previousCell: Command = (state, dispatch) => {
  if (!isInTable(state.selection.$from)) return false;
  goToNextCell(-1)(state, dispatch);
  return true;
};

/** The preset refuses Shift-Enter's line break anywhere inside a table,
 *  because its serializer could not write one there. This one can, so the
 *  refusal stays for code blocks only. */
const allowBreaksInTables: MilkdownPlugin = (ctx) => async () => {
  await ctx.wait(InitReady);
  ctx.update(hardbreakFilterNodes.key, (nodes) => nodes.filter((name) => name !== "table"));
};

/** Above the preset table keymap (100), whose Enter leaves the table and
 *  whose Tab gives up on the last cell. Mod-Enter is still the way out. */
const cellKeymap = $useKeymap("brainTableCellKeymap", {
  NewLineInCell: {
    shortcuts: "Enter",
    priority: 110,
    command: () => newLineInCell,
  },
  NextCellOrNewRow: {
    shortcuts: "Tab",
    priority: 110,
    command: () => nextCellOrNewRow,
  },
  PreviousCell: {
    shortcuts: "Shift-Tab",
    priority: 110,
    command: () => previousCell,
  },
});

export const tableCells = [
  remarkCellBreaks,
  allowBreaksInTables,
  cellSchema,
  headerSchema,
  cellPaste,
  cellKeymap,
].flat();
