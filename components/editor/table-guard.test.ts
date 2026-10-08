// @vitest-environment jsdom
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NESTED_TABLE_BLOCKED_EVENT } from "@/lib/editor-events";
import { wholeDocumentWalks } from "./editor-stack.harness";
import {
  containsNestedTable,
  createNoNestedTablesPlugin,
  nestedTableWithin,
} from "./table-guard";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    text: { group: "inline" },
    table: { group: "block", content: "table_row+" },
    table_row: { content: "table_cell+" },
    table_cell: { content: "block+" },
  },
});

const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
const table = (content = paragraph("cell")) =>
  schema.node("table", null, [
    schema.node("table_row", null, [schema.node("table_cell", null, [content])]),
  ]);

describe("nested table guard", () => {
  it("allows ordinary top-level tables", () => {
    expect(containsNestedTable(schema.node("doc", null, [table()]))).toBe(false);
  });

  it("rejects a table inside a table cell", () => {
    expect(containsNestedTable(schema.node("doc", null, [table(table())]))).toBe(true);
  });

  it("looks only inside the range it is given", () => {
    const doc = schema.node("doc", null, [paragraph("a"), table(table())]);
    expect(nestedTableWithin(doc, 0, 3)).toBe(false);
    expect(nestedTableWithin(doc, 3, doc.content.size)).toBe(true);
  });
});

describe("the guard on a transaction", () => {
  const blocked = vi.fn();
  window.addEventListener(NESTED_TABLE_BLOCKED_EVENT, blocked);
  afterEach(() => blocked.mockClear());

  // "a" is 0..3, the table starts at 3, its cell's paragraph opens at 6.
  const state = () =>
    EditorState.create({
      doc: schema.node("doc", null, [paragraph("a"), table(), paragraph("b")]),
      plugins: [createNoNestedTablesPlugin()],
    });

  it("refuses a table written into a cell and says so", () => {
    const before = state();
    const after = before.apply(before.tr.insert(6, table()));
    expect(after.doc.eq(before.doc)).toBe(true);
    expect(blocked).toHaveBeenCalledOnce();
  });

  it("lets a table written beside another one through", () => {
    const before = state();
    const after = before.apply(before.tr.insert(3, table()));
    expect(after.doc.childCount).toBe(4);
    expect(blocked).not.toHaveBeenCalled();
  });

  it("walks nothing for a keystroke beside the tables", () => {
    const before = state();
    const walks = wholeDocumentWalks(() => {
      before.apply(before.tr.insertText("x", 1));
    });
    expect(walks).toBe(0);
  });
});
