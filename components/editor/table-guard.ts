import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { notifyNestedTableBlocked } from "@/lib/editor-events";
import { changedTopLevelRanges } from "./changed-ranges";

const TABLE_CONTEXTS = new Set(["table", "table_row", "table_cell", "table_header"]);

export function isInTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    if (TABLE_CONTEXTS.has($pos.node(depth).type.name)) return true;
  }
  return false;
}

/** A table node is nested when its resolved position has a table cell/header
 * ancestor. Only the tables between `from` and `to` are read, with their
 * ancestry: a table that stands outside the range cannot have moved into a
 * cell by a change that did not touch it. */
export function nestedTableWithin(doc: ProseNode, from: number, to: number): boolean {
  let nested = false;
  doc.nodesBetween(from, to, (node, pos) => {
    if (nested) return false;
    if (node.type.name !== "table") return true;
    const $pos = doc.resolve(pos);
    for (let depth = $pos.depth; depth >= 0; depth -= 1) {
      const name = $pos.node(depth).type.name;
      if (name === "table_cell" || name === "table_header") {
        nested = true;
        return false;
      }
    }
    return true;
  });
  return nested;
}

/** The document-level invariant, whole: what a load or a test asks. */
export function containsNestedTable(doc: ProseNode): boolean {
  return nestedTableWithin(doc, 0, doc.content.size);
}

/** Refuses any transaction that leaves a table inside a cell. This catches
 * toolbar/slash commands, Markdown paste, TSV paste, file drop, and future
 * programmatic entry points, and it reads only the top-level blocks the
 * transaction wrote: nesting a table needs a write where the table ends up,
 * so the rest of the page need not be walked per keystroke. */
export function createNoNestedTablesPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("brainNoNestedTables"),
    filterTransaction(transaction) {
      if (!transaction.docChanged) return true;
      const blocked = changedTopLevelRanges(transaction).some(({ from, to }) =>
        nestedTableWithin(transaction.doc, from, to),
      );
      if (blocked) notifyNestedTableBlocked();
      return !blocked;
    },
  });
}

export const noNestedTables = $prose(() => createNoNestedTablesPlugin());
