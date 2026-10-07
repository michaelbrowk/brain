import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import { type EditorState, TextSelection, type Transaction } from "@milkdown/kit/prose/state";

/** INLINE THINGS GO WHERE THE CARET IS.
 *
 *  A page link, an attachment and an image placed from a menu, a picker or a
 *  paste used to go in through Milkdown's `insert(markdown)`. That parses the
 *  Markdown into blocks and drops them at the caret, so a link picked in the
 *  middle of a sentence split the sentence into three lines (a table into two
 *  tables), and a title with `]` or `*` in it broke the link it was written
 *  into. Here the thing is a ProseMirror node built from its attributes, the
 *  serializer escapes it like any other text, and it goes into the line the
 *  caret is in: one transaction, one undo, with the caret after it.
 *
 *  Null when the line cannot hold it (a code block, a toggle's title), and the
 *  caller does nothing rather than put it somewhere the reader did not ask. */
export interface InlineRange {
  from: number;
  to: number;
}

/** Blocks a page row stands in as a line of its own, with lines after it. A
 *  list item and a table cell are not among them: the line after a link in
 *  one of those is the next item or the next cell, not a new paragraph in it. */
const ROW_CONTAINERS = new Set(["doc", "blockquote", "callout", "toggle", "col"]);

function fits($from: ResolvedPos, $to: ResolvedPos, content: ProseNode) {
  const parent = $from.parent;
  return (
    $from.sameParent($to) &&
    parent.isTextblock &&
    !parent.type.spec.code &&
    parent.canReplaceWith($from.index(), $to.indexAfter(), content.type, content.marks)
  );
}

/** The first position of an empty paragraph right after the block that ends
 *  at `after`, adding one when the next block is anything else. */
function lineAfter(tr: Transaction, after: number): number {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const next = tr.doc.resolve(after).nodeAfter;
  if (!(next?.type === paragraph && next.content.size === 0)) {
    tr.insert(after, paragraph.create());
  }
  return after + 1;
}

/** Put `content` (an inline node: a page ref, a linked text, an inline image)
 *  in place of `range`, the selection by default.
 *
 *  A page ref that ends up alone on its line is a page row, the block the
 *  subpage list and a centre drop are made of. The caret goes to a line after
 *  it, because a row has no place a typed key can land. Alone in a list item
 *  or a cell it is followed by a space instead, which is where the next words
 *  go and which the file does not keep. */
export function insertInline(
  state: EditorState,
  content: ProseNode,
  range: InlineRange = state.selection,
): Transaction | null {
  const $from = state.doc.resolve(range.from);
  const $to = state.doc.resolve(range.to);
  if (!fits($from, $to, content)) return null;

  const tr = state.tr.replaceWith(range.from, range.to, content);
  let caret = range.from + content.nodeSize;
  const $caret = tr.doc.resolve(caret);
  const line = $caret.parent;
  if (content.type.name === "page_ref" && line.childCount === 1) {
    const container = $caret.node($caret.depth - 1);
    if (line.type.name === "paragraph" && ROW_CONTAINERS.has(container.type.name)) {
      caret = lineAfter(tr, $caret.after());
    } else {
      tr.insertText(" ", caret);
      caret += 1;
    }
  }
  tr.setSelection(TextSelection.create(tr.doc, caret));
  // A link mark reaches the next key typed after it: the words written after
  // an attachment became part of its label.
  const link = state.schema.marks.link;
  if (link && content.isText && link.isInSet(content.marks)) tr.removeStoredMark(link);
  return tr.scrollIntoView();
}

/** "Link to page" over selected words: the words become the link and stay
 *  the words. Replacing them with the page's title threw away what the
 *  reader wrote. Null on an empty selection, where there are no words. */
export function linkSelection(state: EditorState, href: string): Transaction | null {
  const link = state.schema.marks.link;
  const { from, to, empty } = state.selection;
  if (!link || empty) return null;
  return state.tr.addMark(from, to, link.create({ href })).scrollIntoView();
}

/** An image from the picker. On a line of its own it becomes the block image
 *  the page shows full width, in place of the empty line, with the caret on
 *  the line after it: left selected, the next key typed replaced it. On a
 *  line with words, in a heading or a cell, it is the inline image the
 *  Markdown reads back there. */
export function insertImage(
  state: EditorState,
  attrs: { src: string; alt?: string },
): Transaction | null {
  const { schema, selection } = state;
  const { $from, empty } = selection;
  const block = schema.nodes.brain_image;
  const parent = $from.parent;
  if (
    block &&
    empty &&
    parent.type.name === "paragraph" &&
    parent.content.size === 0 &&
    $from.depth > 0 &&
    $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), block)
  ) {
    const start = $from.before();
    const image = block.create({ src: attrs.src, alt: attrs.alt ?? "" });
    const tr = state.tr.replaceWith(start, $from.after(), image);
    const caret = lineAfter(tr, start + image.nodeSize);
    return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView();
  }
  const inline = schema.nodes.image;
  if (!inline) return null;
  return insertInline(state, inline.create({ src: attrs.src, alt: attrs.alt ?? "" }));
}
