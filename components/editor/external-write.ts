import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorState, Transaction } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { parseDropCount } from "./load-guard";

/** A WRITE TO THE OPEN PAGE FROM SOMEWHERE ELSE, APPLIED WHERE IT LANDS.
 *
 *  Another device, Tasks or an agent through MCP can write the page this tab
 *  shows. The shell used to answer with a new editor on the new body, which
 *  threw away the caret, the scroll anchor and the undo history, and redrew
 *  every block for a change to one word. This turns the new body into one
 *  replace over the range where the two documents differ: the selection maps
 *  through it like through any edit, the view redraws only the blocks inside
 *  that range, and the transaction stays out of the undo history, so ⌘Z
 *  takes back the writer's own last step and not somebody else's.
 *
 *  It is not a merge. The shell calls it only while this tab holds no unsaved
 *  text, or when the writer has chosen the other version over their own; a
 *  write that arrives during unsaved typing is a conflict and is offered to
 *  the writer, never applied under their hands. */

/** Marks the transaction, so the editor does not count it as the writer's
 *  change (no unsaved state, no save of a body the server already holds). */
export const EXTERNAL_WRITE_META = "brainExternalWrite";

export type ExternalWriteResult =
  /** The editor now holds the new body. */
  | "applied"
  /** The editor already held it. */
  | "unchanged"
  /** Nothing changed: a view that takes no edits (a page opened read-only,
   *  a nesting move in flight), or a body whose parse would drop content.
   *  The caller remounts, which runs the load's own guard on it. */
  | "refused"
  /** Nothing changed: the editor held an edit the shell had not been handed
   *  yet, and handed it over instead (the registered apply in
   *  `milkdown-editor.tsx`). The caller treats the page as unsaved. */
  | "dirty";

/** One replace from `doc` to `next`, over the range that differs. Null when
 *  the two are the same document. */
export function externalWriteTransaction(
  state: EditorState,
  next: ProseNode,
): Transaction | null {
  const { doc } = state;
  const start = doc.content.findDiffStart(next.content);
  if (start === null) return null;
  const end = doc.content.findDiffEnd(next.content);
  let endA = end?.a ?? doc.content.size;
  let endB = end?.b ?? next.content.size;
  // Both scans stop at the first difference from their own side, so on a
  // repeated run ("aa" → "aaa") the end can land before the start. Move both
  // ends forward by the overlap: the replace then covers the same text
  // either way.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  let tr = state.tr.replace(start, endA, next.slice(start, endB));
  // The replace fits by construction (the two documents share their
  // structure up to `start` and after the ends), but a fitted slice that
  // came out different is never left in place: the whole content goes in
  // instead, still one step and still mapped.
  if (!tr.doc.eq(next)) {
    tr = state.tr.replaceWith(0, doc.content.size, next.content);
  }
  return tr.setMeta("addToHistory", false).setMeta(EXTERNAL_WRITE_META, true);
}

/** Apply `markdown` to the view in place. `parse` is the editor's own parser
 *  (`parserCtx`), so the document is the one a load of that body would build. */
export function applyExternalMarkdown(
  view: EditorView,
  parse: (markdown: string) => ProseNode | null | undefined,
  markdown: string,
): ExternalWriteResult {
  if (view.isDestroyed || !view.editable) return "refused";
  const next = parse(markdown);
  if (!next || parseDropCount(next) > 0) return "refused";
  const before = view.state.doc;
  const tr = externalWriteTransaction(view.state, next);
  if (!tr) return "unchanged";
  view.dispatch(tr);
  // A plugin that refuses the change (the load guard on a lossy page) leaves
  // the document as it was.
  return view.state.doc === before ? "refused" : "applied";
}
