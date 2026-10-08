import { InputRule } from "@milkdown/kit/prose/inputrules";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
import { $inputRule, $prose } from "@milkdown/kit/utils";
import { webHrefFromInput } from "./web-link";

/** A URL TYPED INTO THE LINE IS A LINK AS SOON AS IT IS FINISHED.
 *
 *  GFM reads a bare `https://…` or `www.…` in running text as a link, so the
 *  file already meant it as one; the editor showed it as plain words and, on
 *  the first save, escaped its colon (H8). Here the two moments that finish
 *  an address, the space typed after it and Enter, put the link mark on it,
 *  with the address as its text. The serializer's half, writing the mark
 *  back without angle brackets, is B2's. */

/** The address GFM would read out of `raw` typed in running text: trailing
 *  punctuation is prose, and a closing bracket belongs to the address only
 *  while an opening one inside it is still unmatched. */
export function typedUrlEnd(raw: string): string {
  let url = raw;
  for (;;) {
    const trimmed = url.replace(/[.,;:!?'"*_~]+$/, "");
    if (trimmed.endsWith(")")) {
      const opened = (trimmed.match(/\(/g) ?? []).length;
      const closed = (trimmed.match(/\)/g) ?? []).length;
      if (closed > opened) {
        url = trimmed.slice(0, -1);
        continue;
      }
    }
    if (trimmed === url) return url;
    url = trimmed;
  }
}

/** The link mark on the address that ends at `end`, added to `tr`, or false
 *  where there is nothing to mark: no address before `end`, or words already
 *  linked or in inline code, which are the reader's as they are. `(^|\s)`
 *  keeps `foo.https://` from being read as an address starting mid-word. */
function markTypedUrl(tr: Transaction, state: EditorState, end: number): boolean {
  const link = state.schema.marks.link;
  const code = state.schema.marks.inlineCode;
  if (!link) return false;
  const $end = state.doc.resolve(end);
  if (!$end.parent.isTextblock || $end.parent.type.spec.code) return false;
  const before = $end.parent.textBetween(Math.max(0, $end.parentOffset - 500), $end.parentOffset);
  const match = /(^|\s)((?:https?:\/\/|www\.)\S+)$/i.exec(before);
  if (!match) return false;
  const url = typedUrlEnd(match[2]);
  if (!url) return false;
  const start = end - match[2].length;
  const stop = start + url.length;
  if (state.doc.rangeHasMark(start, stop, link)) return false;
  if (code && state.doc.rangeHasMark(start, stop, code)) return false;
  const href = webHrefFromInput(url);
  if (!href) return false;
  tr.addMark(start, stop, link.create({ href }));
  return true;
}

/** A space typed after an address links the address, and the space stays
 *  plain so the next word does not join the link. The rule puts the typed
 *  space in itself: an input rule that answers replaces the browser's own
 *  insertion. */
export const typedUrlInputRule = $inputRule(
  () =>
    new InputRule(/(?:^|\s)(?:https?:\/\/|www\.)\S*(\s)$/i, (state, match, _start, end) => {
      const tr = state.tr.insertText(match[1], state.selection.from, end);
      if (!markTypedUrl(tr, state, state.selection.from)) return null;
      return tr;
    }),
);

/** Enter after an address links it before the line splits. The handler
 *  changes the state and declines the key, so the keymap that splits the
 *  line runs next on the state with the link in it. */
export const typedUrlEnter = $prose(
  () =>
    new Plugin({
      key: new PluginKey("brainTypedUrlEnter"),
      props: {
        handleKeyDown(view, event) {
          if (event.key !== "Enter" || event.isComposing) return false;
          if (event.metaKey || event.ctrlKey || event.altKey) return false;
          const { selection } = view.state;
          if (!selection.empty) return false;
          const tr = view.state.tr;
          if (!markTypedUrl(tr, view.state, selection.from)) return false;
          view.dispatch(tr);
          return false;
        },
      },
    }),
);

export const typedUrls = [typedUrlInputRule, typedUrlEnter].flat();
