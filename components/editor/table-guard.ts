import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { notifyNestedTableBlocked } from "@/lib/editor-events";

const TABLE_CONTEXTS = new Set(["table", "table_row", "table_cell", "table_header"]);

export function isInTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth >= 0; depth -= 1) {
    if (TABLE_CONTEXTS.has($pos.node(depth).type.name)) return true;
  }
  return false;
}

/** A table node is nested when its resolved position has a table cell/header
 * ancestor. This document-level invariant catches toolbar/slash commands,
 * Markdown paste, TSV paste, file drop, and future programmatic entry points. */
export function containsNestedTable(doc: ProseNode): boolean {
  let nested = false;
  doc.descendants((node, pos) => {
    if (nested || node.type.name !== "table") return !nested;
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

export const noNestedTables = $prose(
  () =>
    new Plugin({
      key: new PluginKey("brainNoNestedTables"),
      filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        const blocked = containsNestedTable(transaction.doc);
        if (blocked) notifyNestedTableBlocked();
        return !blocked;
      },
    }),
);
