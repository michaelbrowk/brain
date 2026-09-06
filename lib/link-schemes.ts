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

/** ASCII whitespace and the C0 controls go first, because a browser drops
 *  them: a tab inside `javascript:` and a leading NUL both leave the same URL
 *  behind by the time a click happens. */
function withoutIgnorableCharacters(value: string): string {
  return value.replace(/[\u0000-\u0020\u007f]/g, "");
}

/** A browser reads a backslash as a forward slash where the authority would
 *  start, and `new URL` agrees: `/\host`, `\\host` and `\/host` all resolve
 *  to `//host` and fetch from that host.
 *
 *  Folding costs a legitimate destination nothing here. An attachment name is
 *  `[A-Za-z0-9_-]` plus an extension and a page ref is `/p/<id>` over the same
 *  alphabet, so nothing this app writes carries a backslash at all; and were
 *  one to arrive inside a path, folding leaves it a path. One leading
 *  backslash is the case to be careful about, and it is safe for the same
 *  reason: `\host` resolves against the page, and folded it is `/host`, which
 *  is still a path rather than an authority. */
function withForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Every spelling of one destination that a browser might end up resolving:
 *  as written, with character references decoded, and each of those with
 *  backslashes folded. Testing all of them can only refuse a destination that
 *  would have been fine, never admit one that would not. */
function candidateForms(value: string): string[] {
  const forms = new Set<string>();
  for (const decoded of [value, decodeReferences(value)]) {
    forms.add(decoded);
    forms.add(withForwardSlashes(decoded));
  }
  return [...forms].map(withoutIgnorableCharacters);
}

/** True when the destination is relative or carries an allowed scheme.
 *
 *  Folding is on this test for one definition of "the forms a browser might
 *  see" rather than for correctness: `/` is not a scheme character, so folding
 *  can never create a scheme, and it ends a match exactly where the backslash
 *  already did. It is load-bearing on the authority test below. */
export function linkSchemeAllowed(destination: string): boolean {
  for (const form of candidateForms(destination)) {
    const match = SCHEME.exec(form);
    if (match && !ALLOWED_SCHEMES.has(match[1].toLowerCase())) return false;
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

/**
 * Where the visitor write path stops a beacon the /share policy cannot reach.
 *
 * That policy carries `img-src 'self' data:` and `media-src 'self'`, and the
 * owner reads the same body on two surfaces that do not carry it: the editor
 * at `/p/`, where `inlineImageView` puts the visitor's `src` on a real
 * `<img>`, and the version-history preview, which renders `renderReadOnly`
 * output into the page. A visitor writes an image on another site, the owner
 * opens their own page, and a third party learns the owner's IP, the time and
 * the user agent.
 *
 * A policy on `/p/` is the wrong fix: the owner may reference remote media in
 * their own notes and blocking `img-src` there would break that. This is the
 * visitor write path, so it costs the owner's own content nothing. A visitor
 * has no need for a remote image either, because uploading is the supported
 * path and an upload is same-origin.
 */

/** Attributes a browser fetches from. `href` is here for `<svg><image href>`
 *  and `<link href>` rather than for anchors, and refusing an anchor's href
 *  inside raw HTML with it is an over-refusal I accept: a visitor writes links
 *  in Markdown, where they are still allowed. */
const FETCHING_ATTRIBUTE =
  /\b(?:src|srcset|poster|background|data|href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi;

/** Absolute by scheme, or authority-relative, which a browser resolves against
 *  the page's own scheme and fetches from the named host just the same. Two
 *  slashes, three slashes, or any spelling a folded backslash makes into two.
 */
function isRemoteReference(value: string): boolean {
  for (const form of candidateForms(value)) {
    if (form.startsWith("//")) return true;
    if (SCHEME.test(form)) return true;
  }
  return false;
}

/** One `srcset` carries several candidates, each a URL and an optional
 *  descriptor. What counts is everything before the first space of each
 *  comma-separated part. */
function referencesIn(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim().split(/\s+/, 1)[0])
    .filter((part) => part !== "");
}

/** Every reference in this body a browser would fetch from another origin: a
 *  Markdown image destination, and any fetching attribute inside raw HTML.
 *  Tokenized the way the rest of this file tokenizes, so prose, inline code
 *  and fenced code name nothing.
 *
 *  Not covered because a visitor cannot produce them: `meta.cover` and
 *  `meta.icon`, which no visitor leaf writes, and the editor's container
 *  directives, whose only attribute that reaches the screen is the callout
 *  icon, rendered as a text child rather than as a source. */
export function remoteMediaReferences(markdown: string): Set<string> {
  const found = new Set<string>();
  const tokens = marked.lexer(stripEditorDirectiveFences(markdown), {
    gfm: true,
  });
  marked.walkTokens(tokens, (token: Token) => {
    if (token.type === "image") {
      const href = typeof token.href === "string" ? token.href : "";
      if (isRemoteReference(href)) found.add(href);
      return;
    }
    if (token.type !== "html") return;
    const raw = typeof token.raw === "string" ? token.raw : "";
    for (const match of raw.matchAll(FETCHING_ATTRIBUTE)) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      for (const reference of referencesIn(value)) {
        if (isRemoteReference(reference)) found.add(reference);
      }
    }
  });
  return found;
}

/** The first remote reference this body introduces, or null. `held` is what
 *  the page already carries: the same rule the link and attachment checks
 *  follow, so an owner's own remote image never makes a page unwritable for
 *  the people the owner invited. */
export function remoteMediaReference(
  markdown: string,
  held: ReadonlySet<string> = new Set(),
): string | null {
  for (const reference of remoteMediaReferences(markdown)) {
    if (!held.has(reference)) return reference;
  }
  return null;
}
