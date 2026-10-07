import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Selection, type Transaction } from "@milkdown/kit/prose/state";

/** Put a container block (a callout, a toggle) where the caret is and the
 *  caret on its first line, the line the writer types into next.
 *
 *  The slash menu leaves the caret on an empty line, and that line becomes
 *  the block. `replaceSelectionWith` alone does not promise either half: in
 *  a callout or a toggle's body it put the new block above the empty line
 *  and left the caret below it, so the words meant for the block landed
 *  outside. Where the line cannot be replaced (the first line of a list
 *  item must stay a paragraph) the block goes in the way ProseMirror fits
 *  it, and the caret is still taken to the block. */
export function insertContainerBlock(tr: Transaction, node: ProseNode): Transaction {
  const { $from, empty } = tr.selection;
  const parent = $from.parent;
  if (
    empty &&
    parent.isTextblock &&
    parent.content.size === 0 &&
    $from.depth > 0 &&
    $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), node.type)
  ) {
    const start = $from.before();
    tr.replaceWith(start, $from.after(), node);
    return tr.setSelection(Selection.near(tr.doc.resolve(start + 1), 1));
  }

  const before = tr.selection.from;
  tr.replaceSelectionWith(node);
  // The inserted content lies between the two sides of where the caret was.
  const from = tr.mapping.map(before, -1);
  const to = tr.mapping.map(before, 1);
  let start = -1;
  tr.doc.nodesBetween(from, to, (child, pos) => {
    if (start >= 0) return false;
    if (child.type === node.type && pos >= from) start = pos;
    return start < 0;
  });
  if (start < 0) return tr;
  return tr.setSelection(Selection.near(tr.doc.resolve(start + 1), 1));
}
