import type { Node as ProseNode, ResolvedPos } from "@milkdown/kit/prose/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

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
 *  `insertInline` is null when the line cannot hold it (a code block, a
 *  toggle's title), so a paste the editor cannot place is left to the
 *  browser. `insertInlineNear` is for what arrives later (an upload) and
 *  must land somewhere: the nearest place that takes it. */
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

/** THE LINE ADDED FOR THE CARET GOES AGAIN IF NOTHING IS WRITTEN ON IT.
 *
 *  A page row and a block image have no place a key can land, so the caret
 *  goes to a line after them, and where the next block is not an empty line
 *  one is added. An empty line between blocks is written to the file as
 *  `<br />`, so a line the writer never typed on would stay in the note as a
 *  blank they did not ask for. This remembers the line it added, and takes it
 *  out once the caret has left it empty. Out of the undo history: the undo of
 *  the insertion takes the line with it anyway. Typing on it, or Enter on
 *  it, makes it the writer's, and it is never taken. */
const addedLineKey = new PluginKey<number | null>("brainAddedLine");

export const addedLine = $prose(
  () =>
    new Plugin<number | null>({
      key: addedLineKey,
      state: {
        init: () => null,
        apply(tr, previous) {
          const meta = tr.getMeta(addedLineKey) as number | null | undefined;
          if (meta !== undefined) return meta;
          if (previous === null || !tr.docChanged) return previous;
          const mapped = tr.mapping.mapResult(previous, 1);
          return mapped.deleted ? null : mapped.pos;
        },
      },
      props: {
        // Enter on the added line is the writer taking it: it stays, as a
        // line they made, and Enter opens the next one the ordinary way.
        // Without this the new line took the caret and the one it left was
        // taken away, so Enter looked like it did nothing.
        handleKeyDown(view, event) {
          if (event.key !== "Enter" || event.isComposing) return false;
          const pos = addedLineKey.getState(view.state);
          if (pos === null || pos === undefined) return false;
          const line = view.state.doc.nodeAt(pos);
          const { from, to } = view.state.selection;
          if (!line || from < pos || to > pos + line.nodeSize) return false;
          view.dispatch(view.state.tr.setMeta(addedLineKey, null));
          return false;
        },
      },
      appendTransaction(_transactions, _old, state) {
        const pos = addedLineKey.getState(state);
        if (pos === null || pos === undefined) return null;
        const line = state.doc.nodeAt(pos);
        if (!line || line.type.name !== "paragraph" || line.content.size > 0) {
          return state.tr.setMeta(addedLineKey, null);
        }
        const { from, to } = state.selection;
        if (from >= pos && to <= pos + line.nodeSize) return null;
        return state.tr
          .delete(pos, pos + line.nodeSize)
          .setMeta(addedLineKey, null)
          .setMeta("addToHistory", false);
      },
    }),
);

/** The first position of an empty paragraph right after the block that ends
 *  at `after`, adding one (and saying so to `addedLine`) when the next block
 *  is anything else. */
function lineAfter(tr: Transaction, after: number): number {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const next = tr.doc.resolve(after).nodeAfter;
  if (!(next?.type === paragraph && next.content.size === 0)) {
    tr.insert(after, paragraph.create());
    tr.setMeta(addedLineKey, after);
  }
  return after + 1;
}

/** `content` in place of `range` on `tr`, with the caret after it. */
function placeInline(tr: Transaction, content: ProseNode, range: InlineRange): Transaction {
  tr.replaceWith(range.from, range.to, content);
  let caret = range.from + content.nodeSize;
  const $caret = tr.doc.resolve(caret);
  const line = $caret.parent;
  if (content.type.name === "page_ref" && line.childCount === 1) {
    const container = $caret.node($caret.depth - 1);
    if (line.type.name === "paragraph" && ROW_CONTAINERS.has(container.type.name)) {
      caret = lineAfter(tr, $caret.after());
    } else {
      // A caret after a ref that is alone on its line takes no key: the
      // browser carries the next one to the line below. A space gives it a
      // place, and the file never keeps it (`remarkPageRefSpacer`).
      tr.insertText(" ", caret);
      caret += 1;
    }
  }
  tr.setSelection(TextSelection.create(tr.doc, caret));
  // A link mark reaches the next key typed after it: the words written after
  // an attachment became part of its label.
  const link = tr.doc.type.schema.marks.link;
  if (link && content.isText && link.isInSet(content.marks)) tr.removeStoredMark(link);
  return tr.scrollIntoView();
}

/** Put `content` (an inline node: a page ref, a linked text, an inline image)
 *  in place of `range`, the selection by default. Null where that line cannot
 *  hold it.
 *
 *  A page ref that ends up alone on its line is a page row, the block the
 *  subpage list and a centre drop are made of. The caret goes to a line after
 *  it (see `addedLine`). Alone in a list item or a cell it is followed by a
 *  space instead. */
export function insertInline(
  state: EditorState,
  content: ProseNode,
  range: InlineRange = state.selection,
): Transaction | null {
  const $from = state.doc.resolve(range.from);
  const $to = state.doc.resolve(range.to);
  if (!fits($from, $to, content)) return null;
  return placeInline(state.tr, content, range);
}

/** `block` after the nearest block around the caret that has room for it,
 *  and where it went. */
function blockNear(state: EditorState, block: ProseNode): { tr: Transaction; at: number } | null {
  const { $to } = state.selection;
  for (let depth = $to.depth; depth >= 1; depth -= 1) {
    const parent = $to.node(depth - 1);
    const index = $to.indexAfter(depth - 1);
    if (!parent.canReplaceWith(index, index, block.type)) continue;
    const at = $to.after(depth);
    return { tr: state.tr.insert(at, block), at };
  }
  return null;
}

/** `insertInline` for what arrives after the caret may have moved (an
 *  upload): where the caret is, or at the end of the selection when it spans
 *  lines, or else on a new line after the nearest block that takes one.
 *  Dropping it there would leave the file uploaded and the note without it. */
export function insertInlineNear(state: EditorState, content: ProseNode): Transaction | null {
  const here = insertInline(state, content);
  if (here) return here;
  const end = state.selection.to;
  const collapsed = insertInline(state, content, { from: end, to: end });
  if (collapsed) return collapsed;
  const near = blockNear(state, state.schema.nodes.paragraph.create());
  if (!near) return null;
  return placeInline(near.tr, content, { from: near.at + 1, to: near.at + 1 });
}

/** "Link to page" over selected words: the words become the link and stay
 *  the words. Replacing them with the page's title threw away what the
 *  reader wrote. The address is `linkedWordsHref`, which every reader of a
 *  body already takes for an ordinary link, so the next open keeps the words
 *  too.
 *
 *  The mark goes on text only. A page ref inside the selection is already a
 *  link, and a link mark around it wrote a link inside a link, which the
 *  file kept as visible brackets. Null where the selection holds no text. */
export function linkSelection(state: EditorState, href: string): Transaction | null {
  const link = state.schema.marks.link;
  const { from, to, empty } = state.selection;
  if (!link || empty) return null;
  const mark = link.create({ href });
  const tr = state.tr;
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !parent?.type.allowsMarkType(link)) return;
    tr.addMark(Math.max(from, pos), Math.min(to, pos + node.nodeSize), mark);
  });
  return tr.docChanged ? tr.scrollIntoView() : null;
}

/** An image from the picker. On a line of its own it becomes the block image
 *  the page shows full width, in place of the empty line, with the caret on
 *  the line after it: left selected, the next key typed replaced it. On a
 *  line with words, in a heading or a cell, it is the inline image the
 *  Markdown reads back there. Where neither fits (a code block, a toggle's
 *  title) it goes after the nearest block that takes it, as a block image. */
export function insertImage(
  state: EditorState,
  attrs: { src: string; alt?: string },
): Transaction | null {
  const { schema, selection } = state;
  const { $from, empty } = selection;
  const block = schema.nodes.brain_image;
  const parent = $from.parent;
  const image = block?.create({ src: attrs.src, alt: attrs.alt ?? "" });
  if (
    image &&
    empty &&
    parent.type.name === "paragraph" &&
    parent.content.size === 0 &&
    $from.depth > 0 &&
    $from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), image.type)
  ) {
    const start = $from.before();
    const tr = state.tr.replaceWith(start, $from.after(), image);
    const caret = lineAfter(tr, start + image.nodeSize);
    return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView();
  }
  const inline = schema.nodes.image;
  const here = inline && insertInline(state, inline.create({ src: attrs.src, alt: attrs.alt ?? "" }));
  if (here) return here;
  if (!image) return null;
  const near = blockNear(state, image);
  if (!near) return null;
  const tr = near.tr;
  const caret = lineAfter(tr, near.at + image.nodeSize);
  return tr.setSelection(TextSelection.create(tr.doc, caret)).scrollIntoView();
}
