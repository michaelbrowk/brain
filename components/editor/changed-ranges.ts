import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import type { Transaction } from "@milkdown/kit/prose/state";
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
} from "@milkdown/kit/prose/transform";

/** Where a transaction wrote, so a plugin can look there and nowhere else.
 *
 *  A keystroke used to cost what the page weighed: four plugins answered
 *  "did this change touch a heading, a page row, a table?" by walking the
 *  whole document on every transaction. The steps already say where they
 *  wrote. These helpers read that, so the work per keystroke is the size of
 *  the block under the caret and not the size of the page. */

export interface DocRange {
  from: number;
  to: number;
}

/** The positions in `tr.doc` the transaction wrote to, each widened to the
 *  top-level block it falls in and merged with its neighbours. Mark steps
 *  write no positions and add no range. An attribute step's map is empty
 *  too, though it does change the node at its position, so that node is
 *  the range. */
export function changedTopLevelRanges(tr: Transaction): DocRange[] {
  const ranges: DocRange[] = [];
  const doc = tr.doc;
  tr.steps.forEach((step, index) => {
    const rest = tr.mapping.slice(index + 1);
    if (step instanceof AttrStep) {
      ranges.push(widenToTopLevel(doc, rest.map(step.pos, -1), rest.map(step.pos + 1, 1)));
      return;
    }
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      ranges.push(
        widenToTopLevel(doc, rest.map(newStart, -1), rest.map(newEnd, 1)),
      );
    });
  });
  return mergeRanges(ranges);
}

function widenToTopLevel(doc: ProseNode, from: number, to: number): DocRange {
  const size = doc.content.size;
  const $from = doc.resolve(Math.max(0, Math.min(from, size)));
  const $to = doc.resolve(Math.max(0, Math.min(to, size)));
  return {
    from: $from.depth > 0 ? $from.before(1) : $from.pos,
    to: $to.depth > 0 ? $to.after(1) : $to.pos,
  };
}

function mergeRanges(ranges: DocRange[]): DocRange[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: DocRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** True when every step only rewrote inline content inside one textblock,
 *  and none of those textblocks is one `isExcluded` names (it is handed the
 *  textblock and a position inside it, for the ancestors). Such a
 *  transaction changes no block's shape and no excluded block's text: a
 *  plugin that derives something from the block structure, or from the text
 *  of headings, can keep its answer. Mark steps change no text and pass; any
 *  step that is not a replace (an attribute step, say) is reported as a
 *  structural edit. */
export function editsStayInsideTextblocks(
  tr: Transaction,
  isExcluded: (textblock: ProseNode, $inside: ResolvedPos) => boolean,
): boolean {
  for (let index = 0; index < tr.steps.length; index += 1) {
    const step = tr.steps[index];
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) continue;
    if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) {
      return false;
    }
    const before = tr.docs[index];
    const after = tr.docs[index + 1] ?? tr.doc;
    let inside = true;
    step.getMap().forEach((oldStart, oldEnd, newStart, newEnd) => {
      if (!inside) return;
      inside =
        insideOneTextblock(before, oldStart, oldEnd, isExcluded) &&
        insideOneTextblock(after, newStart, newEnd, isExcluded);
    });
    if (!inside) return false;
  }
  return true;
}

function insideOneTextblock(
  doc: ProseNode,
  from: number,
  to: number,
  isExcluded: (textblock: ProseNode, $inside: ResolvedPos) => boolean,
): boolean {
  if (from < 0 || to > doc.content.size) return false;
  const $from = doc.resolve(from);
  const parent = $from.parent;
  return parent.isTextblock && !isExcluded(parent, $from) && to <= $from.end();
}

/** Whether any content the transaction removed or replaced holds a node
 *  `matches` names. Only the replaced ranges of each step are read, in the
 *  document that step started from: a step cannot take out what it did not
 *  cover. A pure insertion removes nothing and is never a match. An attribute
 *  step's map is empty, but it does rewrite the node at its position, so that
 *  node is read as replaced. */
export function removedContentHas(
  tr: Transaction,
  matches: (node: ProseNode) => boolean,
): boolean {
  for (let index = 0; index < tr.steps.length; index += 1) {
    const before = tr.docs[index];
    const step = tr.steps[index];
    if (step instanceof AttrStep) {
      const node = before.nodeAt(step.pos);
      if (node && matches(node)) return true;
      continue;
    }
    let found = false;
    step.getMap().forEach((oldStart, oldEnd) => {
      if (found || oldEnd <= oldStart) return;
      before.nodesBetween(oldStart, oldEnd, (node) => {
        if (found) return false;
        if (matches(node)) found = true;
        return !found;
      });
    });
    if (found) return true;
  }
  return false;
}
