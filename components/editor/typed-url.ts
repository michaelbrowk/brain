import { InputRule } from "@milkdown/kit/prose/inputrules";
import { type EditorState, Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import { $inputRule, $prose } from "@milkdown/kit/utils";
import { pasteLinkCard } from "./link-preview";
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

/** What may stand right before an address for GFM to read it as one: the
 *  start of the text, whitespace, or one of `( * _ ~`. After a letter or a
 *  dot it is the tail of a word (`foo.https://`), and stays words. */
const BEFORE_URL = String.raw`(^|[\s(*_~])`;
const TYPED_URL_BEFORE_CARET = new RegExp(`${BEFORE_URL}((?:https?:\\/\\/|www\\.)\\S+)$`, "i");

/** The address that ends at `end` in `state`, as the range to mark and the
 *  href to mark it with, or null where there is nothing to mark: no address
 *  before `end`, or words already linked or in inline code, which are the
 *  reader's as they are. */
function typedUrlBefore(state: EditorState, end: number) {
  const link = state.schema.marks.link;
  const code = state.schema.marks.inlineCode;
  if (!link) return null;
  const $end = state.doc.resolve(end);
  if (!$end.parent.isTextblock || $end.parent.type.spec.code) return null;
  const before = $end.parent.textBetween(Math.max(0, $end.parentOffset - 500), $end.parentOffset);
  const match = TYPED_URL_BEFORE_CARET.exec(before);
  if (!match) return null;
  const url = typedUrlEnd(match[2]);
  if (!url) return null;
  const start = end - match[2].length;
  const stop = start + url.length;
  if (state.doc.rangeHasMark(start, stop, link)) return null;
  if (code && state.doc.rangeHasMark(start, stop, code)) return null;
  const href = webHrefFromInput(url);
  if (!href) return null;
  return { start, stop, url, href, link, $end };
}

/** A space typed after an address links the address, and the space stays
 *  plain so the next word does not join the link. The rule puts the typed
 *  space in itself: an input rule that answers replaces the browser's own
 *  insertion. Only a typed space or tab: the input-rule plugin also runs
 *  every rule for Enter with a newline, modifier or not, and Enter is the
 *  handler below's. */
export const typedUrlInputRule = $inputRule(
  () =>
    new InputRule(
      new RegExp(`(?:^|[\\s(*_~])(?:https?:\\/\\/|www\\.)\\S*([ \\t\\u00a0])$`, "i"),
      (state, match, _start, end) => {
        const found = typedUrlBefore(state, state.selection.from);
        if (!found) return null;
        return state.tr
          .insertText(match[1], state.selection.from, end)
          .addMark(found.start, found.stop, found.link.create({ href: found.href }));
      },
    ),
);

/** Enter after an address links it. An address alone on its line is drawn
 *  as the card a paste of it draws, with the caret on the line after, so a
 *  typed address and a pasted one open the same way next time (a card is
 *  what the line reads back as). Elsewhere the handler changes the state
 *  and declines the key, so the keymap that splits the line runs next on
 *  the state with the link in it. */
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
          const found = typedUrlBefore(view.state, selection.from);
          if (!found) return false;
          const line = found.$end.parent;
          if (line.textContent === found.url && selection.from === found.$end.end()) {
            const whole = TextSelection.create(view.state.doc, found.$end.start(), found.$end.end());
            const card = pasteLinkCard(view.state.apply(view.state.tr.setSelection(whole)), found.url);
            if (card) {
              view.dispatch(card);
              return true;
            }
          }
          view.dispatch(
            view.state.tr.addMark(found.start, found.stop, found.link.create({ href: found.href })),
          );
          return false;
        },
      },
    }),
);

/** Backspace right after the space takes the link back out and leaves the
 *  address as the words it was: the preset's own `undoInputRule` binding
 *  answers for this rule as for every other, which `web-link.test.ts`
 *  holds. */
export const typedUrls = [typedUrlInputRule, typedUrlEnter].flat();
