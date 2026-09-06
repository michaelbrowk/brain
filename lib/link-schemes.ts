import { marked, type Token } from "marked";
import { stripEditorDirectiveFences } from "./attachments";

/**
 * Which link and image destinations a link visitor may write.
 *
 * The owner's editor is not sanitized. Milkdown's commonmark link mark spreads
 * its attributes onto a real anchor, and this branch's `attachmentLinkView`
 * does the same, so a visitor's `[read this](javascript:...)` becomes a live
 * `<a href="javascript:...">` in the owner's DOM at `/p/<id>`, on an origin
 * whose policy has no `script-src`. DOMPurify covers `/share` and nothing
 * covers `/p/`. The cheap place to stop it is before the bytes land.
 *
 * An allowlist, not a blocklist: a destination with no scheme is relative and
 * fine, `http`, `https` and `mailto` are the three a note has a reason to
 * carry, and everything else is refused. That covers `javascript:` and
 * `data:` without needing to enumerate them.
 */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** The named references that can build or hide a scheme. `amp` is here so a
 *  doubly encoded `&amp;#58;` is seen for what it is on the second pass. */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  colon: ":",
  tab: "\t",
  newline: "\n",
  sol: "/",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** A CommonMark parser decodes character references inside a link
 *  destination, and marked hands them over undecoded, so the two disagree
 *  about what `javascript&#58;alert(1)` is. Decode here rather than trust
 *  either. An unknown reference is left exactly as it was, so a query string
 *  like `?a=1&copy=2` is not quietly rewritten. */
function decodeReferences(value: string): string {
  return value.replace(
    /&(#[Xx][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (whole, body: string) => {
      if (body.startsWith("#")) {
        const digits = body.slice(1);
        const code = /^[Xx]/.test(digits)
          ? Number.parseInt(digits.slice(1), 16)
          : Number.parseInt(digits, 10);
        if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return NAMED_REFERENCES[body.toLowerCase()] ?? whole;
    },
  );
}

/** The scheme a browser would read. ASCII whitespace and the C0 controls go
 *  first, because a browser drops them: a tab inside `javascript:` and a
 *  leading NUL both leave the same URL behind by the time a click happens. */
function bareScheme(value: string): string | null {
  const stripped = value.replace(/[\u0000-\u0020\u007f]/g, "");
  const match = SCHEME.exec(stripped);
  return match ? match[1].toLowerCase() : null;
}

/** True when the destination is relative or carries an allowed scheme. Both
 *  the raw form and the decoded form have to pass: over-decoding can only
 *  refuse a link that would have been fine, never admit one that would not. */
export function linkSchemeAllowed(destination: string): boolean {
  for (const form of [destination, decodeReferences(destination)]) {
    const scheme = bareScheme(form);
    if (scheme !== null && !ALLOWED_SCHEMES.has(scheme)) return false;
  }
  return true;
}

/** Every link and image destination this body names. Tokenized the way
 *  `referencedAttachmentNames` tokenizes, so prose, inline code and fenced
 *  code name nothing, and the editor's container directives are looked
 *  inside, which is what the shared page renders. */
export function linkDestinations(markdown: string): Set<string> {
  const destinations = new Set<string>();
  const tokens = marked.lexer(stripEditorDirectiveFences(markdown), {
    gfm: true,
  });
  marked.walkTokens(tokens, (token: Token) => {
    if (token.type !== "link" && token.type !== "image") return;
    destinations.add(typeof token.href === "string" ? token.href : "");
  });
  return destinations;
}

/** The first destination in this body that a visitor may not write, or null
 *  when every one of them is allowed. `held` is what the page already carries:
 *  a destination the file already holds is not the visitor's to introduce, the
 *  same rule the attachment diff follows, so an owner's own odd link never
 *  makes a page unwritable for the people the owner invited. */
export function unsafeLinkDestination(
  markdown: string,
  held: ReadonlySet<string> = new Set(),
): string | null {
  for (const destination of linkDestinations(markdown)) {
    if (held.has(destination)) continue;
    if (!linkSchemeAllowed(destination)) return destination;
  }
  return null;
}
