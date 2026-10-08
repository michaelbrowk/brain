import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { keymap } from "@milkdown/kit/prose/keymap";
import {
  type EditorState,
  Plugin,
  PluginKey,
  TextSelection,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { notifyEditorLinkField } from "@/lib/editor-events";
import {
  classifyInternalPageLink,
  linkedWordsHref,
  linkedWordsPageId,
} from "@/lib/internal-page-link";
import { linkSelection } from "./insert-inline";
import { currentPageRefOrigin } from "./page-ref";

/** WEB LINKS ON WORDS.
 *
 *  A link to the web used to have one way in: paste the address alone, and
 *  the clipboard plugin wrote it as a link whose text is the address. Pasting
 *  it over selected words replaced the words with it, a typed address stayed
 *  text and the file escaped its colon, and nothing let a reader change or
 *  take back a link that was already there. This is the editor's half of all
 *  of that: the address a reader types or pastes read as a web address, the
 *  link mark put on the words that are selected, the extent of the link the
 *  caret stands in so a field can show and change it, and the two moments
 *  typing makes a link on its own. The field itself is the floating
 *  toolbar's. */

export interface LinkRange {
  from: number;
  to: number;
  href: string;
}

/** The three schemes a note links to. `javascript:` and `data:` are refused
 *  before they reach a mark, the same allowance `lib/link-schemes.ts` makes
 *  for a visitor's body. */
const WEB_SCHEME = /^(https?:\/\/|mailto:)/i;
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[a-z]{2,}$/i;
/** `name.tld`, with an optional port and path. The last label has to be
 *  letters, so `e.g.` and a version number are not addresses. */
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i;
/** What GFM reads as a link in running text: a scheme or `www.`. Anything
 *  looser would turn `file.txt` into a link as it is typed. */
export const TYPED_URL_START = /^(https?:\/\/|www\.)/i;

/** The address a person typed into the field, as the href the mark will
 *  carry, or null where the text is not an address. A mail address becomes a
 *  `mailto:`, `www.` gets the `http://` GFM reads it with, a bare domain gets
 *  `https://`. Whitespace rules it out: `new URL` would take a space and
 *  encode it, and the words beside an address were never part of it. */
export function webHrefFromInput(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  let href: string;
  if (WEB_SCHEME.test(text)) href = text;
  else if (/^www\./i.test(text)) href = `http://${text}`;
  else if (EMAIL.test(text)) href = `mailto:${text}`;
  else if (DOMAIN.test(text)) href = `https://${text}`;
  else return null;
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return href;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
  } catch {
    return null;
  }
  return href;
}

/** The href of a link the field may edit: a web address (http, https,
 *  mailto) that is not one of this Brain's own pages. A page link and linked
 *  words open their page, an attachment downloads, and neither is the
 *  field's; null for those. */
export function webHref(href: string | null | undefined, origin: string): string | null {
  if (!href || !WEB_SCHEME.test(href)) return null;
  if (classifyInternalPageLink(href, origin) || linkedWordsPageId(href, origin)) return null;
  return href;
}

/** The address words get linked to, for what a person typed into the field
 *  or pasted over a selection. One of this Brain's own page URLs, absolute
 *  or `/p/<id>`, becomes the linked-words address E2 writes,
 *  `/p/<id>#words`: a page href on words would read back as a chip with the
 *  page's title, and the words would be gone on the next open. Anything else
 *  is a web address, or null. */
export function hrefForWords(input: string, origin: string): string | null {
  const text = input.trim();
  const page = classifyInternalPageLink(text, origin);
  if (page) return linkedWordsHref(page.id);
  const words = linkedWordsPageId(text, origin);
  if (words) return linkedWordsHref(words);
  return webHrefFromInput(text);
}

/** A pasted address: a scheme, `www.`, a mail address or one of this
 *  Brain's pages, nothing looser. The field may take `example.com`, because
 *  the reader asked for a link; a paste is also how plain words arrive, and
 *  `notes.txt` pasted over a selection must stay the words it is. The
 *  editor's own copy of a bare link is `<https://…>`, so the brackets come
 *  off first. */
function pastedHref(text: string): string | null {
  const trimmed = text.trim().replace(/^<([^<>\s]+)>$/, "$1");
  const origin = currentPageRefOrigin();
  if (classifyInternalPageLink(trimmed, origin) || linkedWordsPageId(trimmed, origin)) {
    return hrefForWords(trimmed, origin);
  }
  if (!TYPED_URL_START.test(trimmed) && !WEB_SCHEME.test(trimmed) && !EMAIL.test(trimmed)) {
    return null;
  }
  return webHrefFromInput(trimmed);
}

/** A URL pasted while words are selected links those words and keeps them,
 *  across lines too. Null for anything else, and the paste goes on to the
 *  card and the clipboard plugin: nothing selected, a selection that starts
 *  in code or outside text, or text that is not one address. */
export function pasteUrlOverSelection(state: EditorState, pasted: string): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  const { $from, $to } = selection;
  if (!$from.parent.isTextblock || !$to.parent.isTextblock || $from.parent.type.spec.code) {
    return null;
  }
  const href = pastedHref(pasted);
  if (!href) return null;
  return linkSelection(state, href);
}

/** The link the caret stands in, over its whole extent: the run of text
 *  carrying the same link mark, across the other marks it may also carry. At
 *  a boundary the caret belongs to the link it is leaving, the one typing
 *  there would extend (`$pos.marks()`); at the start of a link that follows
 *  plain words, where a click on the link lands, it belongs to that link.
 *  Null where the position carries no link. */
export function linkRangeAt(state: EditorState, pos: number): LinkRange | null {
  const link = state.schema.marks.link;
  if (!link) return null;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const children: ProseNode[] = [];
  parent.forEach((child) => children.push(child));
  let index = $pos.index();
  let mark = link.isInSet($pos.marks());
  if (mark && $pos.textOffset === 0 && index > 0 && !mark.isInSet(children[index]?.marks ?? [])) {
    index -= 1;
  }
  if (!mark && children[index]) mark = link.isInSet(children[index].marks);
  if (!mark) return null;
  let first = index;
  let last = index;
  while (first > 0 && mark.isInSet(children[first - 1].marks)) first -= 1;
  while (last + 1 < children.length && mark.isInSet(children[last + 1].marks)) last += 1;
  let from = $pos.start();
  for (let i = 0; i < first; i += 1) from += children[i].nodeSize;
  let to = from;
  for (let i = first; i <= last; i += 1) to += children[i].nodeSize;
  return { from, to, href: typeof mark.attrs.href === "string" ? mark.attrs.href : "" };
}

/** A new address over the whole link, the words and their other marks kept,
 *  and the title the link may carry kept with them. */
export function setLinkHref(state: EditorState, range: LinkRange, href: string): Transaction {
  const link = state.schema.marks.link;
  const existing = link.isInSet(state.doc.resolve(range.from).nodeAfter?.marks ?? []);
  return state.tr
    .removeMark(range.from, range.to, link)
    .addMark(range.from, range.to, link.create({ href, title: existing?.attrs.title ?? null }));
}

/** The words stay, the link goes. */
export function removeLink(state: EditorState, range: LinkRange): Transaction {
  return state.tr.removeMark(range.from, range.to, state.schema.marks.link);
}

/** Mod-Shift-k asks for the field; Mod-k is the palette's. */
export const linkFieldKeymap = $prose(() =>
  keymap({
    "Mod-Shift-k": () => {
      notifyEditorLinkField();
      return true;
    },
  }),
);

/** The paste runs before the link card's own, so a URL over selected words
 *  links the words rather than drawing a card in their place. */
export const webLinkPaste = $prose(
  () =>
    new Plugin({
      key: new PluginKey("brainWebLinkPaste"),
      props: {
        handlePaste(view, event) {
          if (!view.editable) return false;
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const tr = pasteUrlOverSelection(view.state, text);
          if (!tr) return false;
          view.dispatch(tr.setMeta("uiEvent", "paste"));
          return true;
        },
      },
    }),
);

export const webLinks = [webLinkPaste, linkFieldKeymap].flat();
