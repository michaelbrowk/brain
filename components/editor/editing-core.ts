import { gapCursor } from "@milkdown/kit/prose/gapcursor";
import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Core caret behaviors every block editor needs.
 *
 *  gapcursor gives the caret a place to land BETWEEN atom blocks (image /
 *  math / embed) — without it, arrowing past adjacent atoms had no valid
 *  cursor position.
 *
 *  trailingParagraph keeps an (empty) paragraph as the document's last node,
 *  so there is always a writable line under a trailing photo or widget. An
 *  empty paragraph serializes to nothing, so the markdown on disk is
 *  untouched.
 *
 *  focusCaret makes a focus the reader did not aim — Enter from the title, a
 *  dialog handing focus back — land on a line that can take a key. Without it
 *  a page opening with a page reference took the focus and dropped the keys. */

export const gapCursorPlugin = $prose(() => gapCursor());
export const TRAILING_PARAGRAPH_TRANSACTION_META =
  "brainTrailingParagraphTransaction";

export function needsTrailingParagraph(doc: ProseNode, paragraph: NodeType): boolean {
  const last = doc.lastChild;
  if (!last || last.type !== paragraph) return true;

  // A page-ref is an inline atom wrapped in a paragraph. ProseMirror can paint
  // a gap cursor below that paragraph, but it is not a writable line: typing
  // joins the atom's paragraph. Keep one real empty paragraph after a trailing
  // standalone page-ref so `/` opens the slash menu where the caret is shown.
  return last.childCount === 1 && last.firstChild?.type.name === "page_ref";
}

function trailingParagraphTransaction(state: EditorState): Transaction | null {
  const { doc, schema } = state;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph || !needsTrailingParagraph(doc, paragraph)) return null;
  return state.tr
    .insert(doc.content.size, paragraph.create())
    .setMeta("addToHistory", false)
    .setMeta(TRAILING_PARAGRAPH_TRANSACTION_META, true);
}

export function redirectTrailingPageRefTextInput(
  state: EditorState,
  text: string,
): Transaction | null {
  const { doc, schema, selection } = state;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph || !text || !selection.empty || doc.childCount < 2) return null;

  const trailing = doc.lastChild;
  const pageRefParagraph = doc.child(doc.childCount - 2);
  if (
    trailing?.type !== paragraph ||
    trailing.content.size !== 0 ||
    pageRefParagraph.type !== paragraph ||
    pageRefParagraph.childCount !== 1 ||
    pageRefParagraph.firstChild?.type.name !== "page_ref"
  ) {
    return null;
  }

  const trailingStart = doc.content.size - trailing.nodeSize;
  const selectionIsInPageRef = selection.$from.parent === pageRefParagraph;
  const selectionIsGapBeforeTrailing =
    selection.$from.depth === 0 && selection.from === trailingStart;
  if (!selectionIsInPageRef && !selectionIsGapBeforeTrailing) return null;

  const insertAt = trailingStart + 1;
  const transaction = state.tr.insertText(text, insertAt);
  return transaction
    .setSelection(TextSelection.create(transaction.doc, insertAt + text.length))
    .scrollIntoView();
}

export function createTrailingParagraphPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("brainTrailingParagraph"),
    props: {
      handleTextInput: (view, _from, _to, text) => {
        const transaction = redirectTrailingPageRefTextInput(view.state, text);
        if (!transaction) return false;
        view.dispatch(transaction);
        return true;
      },
    },
    view: (view) => {
      let destroyed = false;
      // appendTransaction does not run for the document used to construct an
      // EditorState. Bootstrap once after EditorView finishes mounting so a
      // loaded page that ends in a page-ref gets the same writable line as a
      // document changed during editing.
      queueMicrotask(() => {
        if (destroyed) return;
        const transaction = trailingParagraphTransaction(view.state);
        if (transaction) view.dispatch(transaction);
      });
      return {
        destroy: () => {
          destroyed = true;
        },
      };
    },
    appendTransaction: (_transactions, _oldState, state) =>
      trailingParagraphTransaction(state),
  });
}

export const trailingParagraph = $prose(() => createTrailingParagraphPlugin());

/** A block the browser will accept a keystroke in. A paragraph whose only
 *  child is a page-ref atom is not one: it takes a caret and drops the key,
 *  because the atom is `contenteditable="false"` and there is no text node
 *  beside it. This is the same fact `redirectTrailingPageRefTextInput` works
 *  around once typing has started. */
export function acceptsTypedText(node: ProseNode): boolean {
  if (!node.isTextblock) return false;
  return !(node.childCount === 1 && node.firstChild?.type.name === "page_ref");
}

/** True when the editor holds the focus but nothing in it holds a caret. */
export function focusedWithoutCaret(
  dom: HTMLElement,
  selection: { anchorNode: Node | null } | null,
): boolean {
  const anchor = selection?.anchorNode ?? null;
  return !anchor || !dom.contains(anchor);
}

/** Where a caret handed the editor from outside should land, or null when the
 *  selection is to be left alone.
 *
 *  Only a collapsed caret parked in a block that drops keystrokes is moved. A
 *  node selection — a rule, an image the reader picked — and a range the
 *  reader drew are selections they mean, not a missing caret. And it moves to
 *  the *nearest* top-level block that takes a key, the one after on a tie:
 *  a caret on a page row in the middle of a long page used to jump to the
 *  first line of the document, off screen, and the next keys landed there.
 *  Top-level blocks only, because a focus the reader did not aim should not
 *  drop them inside a column, a callout or a table cell. */
export function writableCaretPos(state: EditorState): number | null {
  const { doc, selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (acceptsTypedText($from.parent)) return null;
  const origin = $from.index(0);
  let best: { pos: number; distance: number } | null = null;
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    const child = doc.child(index);
    if (acceptsTypedText(child)) {
      const distance = Math.abs(index - origin);
      if (
        best === null ||
        distance < best.distance ||
        (distance === best.distance && index > origin)
      ) {
        best = { pos: pos + 1, distance };
      }
    }
    pos += child.nodeSize;
  }
  return best?.pos ?? null;
}

/** The view the focus handler needs — narrowed so a test can hand it a stub. */
export interface FocusCaretView {
  isDestroyed: boolean;
  hasFocus(): boolean;
  dom: HTMLElement;
  state: EditorState;
  dispatch(tr: Transaction): void;
  focus(): void;
}

/** What one focus does, after the browser has had its own chance to place
 *  the caret: nothing, unless the DOM holds no caret at all and the document's
 *  own selection is a caret that cannot take a key. */
export function settleFocusCaret(view: FocusCaretView): boolean {
  if (view.isDestroyed || !view.hasFocus()) return false;
  // A selection already in the DOM is the reader's — a click, a select-all,
  // a fill — and ProseMirror is about to read it. Writing anything over it
  // now would hand the next keys to a caret the reader never placed.
  const selection = view.dom.ownerDocument.getSelection();
  if (!focusedWithoutCaret(view.dom, selection)) return false;
  const pos = writableCaretPos(view.state);
  if (pos === null) return false;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, pos))
      .scrollIntoView(),
  );
  view.focus();
  return true;
}

/** Focus is not a caret.
 *
 *  A page that opens with a standalone page reference gives the browser no
 *  text position to take on its own: the first block holds a single
 *  `contenteditable="false"` atom. Focusing the editor without a click — Enter
 *  from the title, a dialog handing focus back — left the element focused with
 *  an empty selection, and every keystroke after it was dropped in silence.
 *  ProseMirror's own focus sync cannot repair that: it writes the selection
 *  only when the DOM disagrees with the one it recorded, and one empty
 *  selection equals another. Put the caret on a line that can take a key, then
 *  write it to the DOM.
 *
 *  Two gates, and the DOM is not touched unless both open. The DOM has to
 *  hold no caret: one it does hold is the reader's, and the editor must not
 *  write its own, possibly stale, selection over it — `view.focus()` does
 *  exactly that. And the document's selection has to be a collapsed caret in
 *  a block that drops keys (`writableCaretPos`): a rule the reader selected or
 *  a range they drew is a selection they mean, and once read "no caret" and
 *  sent them to the top of the page. */
export function createFocusCaretPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("brainFocusCaret"),
    props: {
      handleDOMEvents: {
        focus: (view) => {
          // After the browser has had its own chance to place the caret, and
          // before ProseMirror's own 20ms check reads the same DOM.
          window.setTimeout(() => settleFocusCaret(view), 0);
          return false;
        },
      },
    },
  });
}

export const focusCaret = $prose(() => createFocusCaretPlugin());

/** Slash hint: mark the empty paragraph the caret sits in so a CSS ::before can
 *  show "Press / for commands" — the slash menu is the door to every block, and
 *  a blank line should teach it (the way Notion does), not sit mute. Only the
 *  active empty line, so the rest of the page stays quiet. An `::empty-block`
 *  (the explicit empty paragraph templates and imports use) is the same blank
 *  line to the writer, so it gets the same hint. */
const SLASH_HINT_TEXTBLOCKS = new Set(["paragraph", "empty_block"]);

export function createSlashHintPlugin() {
  return new Plugin({
    key: new PluginKey("brainSlashHint"),
    props: {
      decorations(state) {
        const { selection } = state;
        if (!selection.empty) return null;
        const parent = selection.$from.parent;
        if (!SLASH_HINT_TEXTBLOCKS.has(parent.type.name) || parent.content.size !== 0) {
          return null;
        }
        const start = selection.$from.before();
        return DecorationSet.create(state.doc, [
          Decoration.node(start, start + parent.nodeSize, { class: "brain-slash-hint" }),
        ]);
      },
    },
  });
}

export const slashHint = $prose(() => createSlashHintPlugin());

/** Caret position inside the first empty `::empty-block` — the writable line
 *  under a template's first heading. A page made from a template opens with
 *  the caret there, so the slash hint shows where writing starts. */
export function firstEmptyBlockPos(doc: ProseNode): number | null {
  let pos: number | null = null;
  doc.descendants((node, nodePos) => {
    if (pos !== null) return false;
    if (node.type.name === "empty_block" && node.content.size === 0) {
      pos = nodePos + 1;
      return false;
    }
    return true;
  });
  return pos;
}

/** Move the caret into the first empty section and focus the editor. */
export function focusFirstEmptyBlock(view: {
  state: EditorState;
  dispatch: (tr: Transaction) => void;
  focus: () => void;
}): boolean {
  const pos = firstEmptyBlockPos(view.state.doc);
  if (pos === null) return false;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, pos))
      .scrollIntoView(),
  );
  view.focus();
  return true;
}

export const editingCore = [
  gapCursorPlugin,
  trailingParagraph,
  focusCaret,
  slashHint,
].flat();
