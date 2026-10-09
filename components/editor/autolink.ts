/** A TYPED ADDRESS IS A LINK AS SOON AS IT IS FINISHED.
 *
 *  GFM reads `https://x`, `www.x` and `me@x` as links without brackets, and
 *  the serializer configuration writes them back bare, so a note that was
 *  typed and a note that was imported spell an address the same way. What
 *  was missing was the moment of typing: the text sat as prose until the
 *  next open, when the parser linked it. This input rule links it on the
 *  space or punctuation that ends it, with the address GFM would read
 *  (`http://` before `www.`, `mailto:` before an email) and the trailing
 *  punctuation GFM leaves outside. Nothing happens inside code or inside a
 *  link the writer already has. */
import { linkSchema } from "@milkdown/kit/preset/commonmark";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import { $inputRule } from "@milkdown/kit/utils";

/** An address and the character that finished it. The address starts the
 *  text or follows what GFM lets precede one (whitespace, `*`, `_`, `~`,
 *  `(`), so `foo@bar` inside a word is left alone. A space, a tab or a
 *  closing parenthesis ends it; Enter reaches input rules as a newline and
 *  is not a terminator here, or the newline would land in the paragraph. */
const ADDRESS = /(?:^|[\s(*_~])((?:https?:\/\/|www\.)[^\s<]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)([ \t)])$/i;

/** GFM's trailing-punctuation rule: `?`, `!`, `.`, `,`, `:`, `*`, `_`, `~`
 *  and a `)` that has no opening one stay outside the link. */
function trimAddress(raw: string): string {
  let address = raw;
  for (;;) {
    const last = address.at(-1);
    if (last === undefined) break;
    if ("?!.,:*_~".includes(last)) {
      address = address.slice(0, -1);
      continue;
    }
    if (last === ")" && (address.match(/\(/g)?.length ?? 0) < (address.match(/\)/g)?.length ?? 0)) {
      address = address.slice(0, -1);
      continue;
    }
    break;
  }
  return address;
}

function hrefOf(address: string): string {
  if (/^https?:\/\//i.test(address)) return address;
  if (/^www\./i.test(address)) return `http://${address}`;
  return `mailto:${address}`;
}

export const autolinkRule = $inputRule((ctx) => {
  const link = linkSchema.type(ctx);
  return new InputRule(ADDRESS, (state, match, start, end) => {
    const [, raw, terminator] = match;
    if (!raw || !terminator) return null;
    // A `)` that closes a parenthesis inside the address is part of it,
    // as in a Wikipedia title; the space after will end the address.
    if (terminator === ")" && (raw.match(/\(/g)?.length ?? 0) > (raw.match(/\)/g)?.length ?? 0)) return null;
    const address = trimAddress(raw);
    if (!address) return null;
    const $start = state.doc.resolve(start);
    if ($start.parent.type.spec.code) return null;
    const code = state.schema.marks.inlineCode;
    // `end` is where the terminator is about to go; the address sits right
    // before it.
    const addressStart = end - raw.length;
    const addressEnd = addressStart + address.length;
    let marked = false;
    state.doc.nodesBetween(addressStart, addressEnd, (node) => {
      if (node.isText && node.marks.some((m) => m.type === link || m.type === code)) marked = true;
    });
    if (marked) return null;
    const tr = state.tr.insertText(terminator, end, end);
    tr.addMark(addressStart, addressEnd, link.create({ href: hrefOf(address), title: null, form: "literal" }));
    // The character that ended the address is not part of the link.
    tr.removeStoredMark(link);
    return tr;
  });
});

export const autolink = [autolinkRule].flat();
