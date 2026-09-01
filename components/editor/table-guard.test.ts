import { Schema } from "@milkdown/kit/prose/model";
import { describe, expect, it } from "vitest";
import { containsNestedTable } from "./table-guard";

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
});
