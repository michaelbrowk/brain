const MAX_SHARE_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;

/** Malformed persisted values fail closed: an invalid deadline never keeps a
 * public page available. */
export function isShareExpired(
  expiresAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const deadline = Date.parse(expiresAt);
  return !Number.isFinite(deadline) || deadline <= now;
}
export function parseShareExpiry(
  value: unknown,
  now = Date.now(),
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("invalid share expiry");
  const deadline = Date.parse(value);
  if (
    !Number.isFinite(deadline) ||
    new Date(deadline).toISOString() !== value ||
    deadline <= now ||
    deadline > now + MAX_SHARE_LIFETIME_MS
  ) {
    throw new Error("invalid share expiry");
  }
  return value;
}

export const VISITOR_NAME_MAX = 40;

export const VISITOR_TITLE_MAX = 200;

const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const ZERO_WIDTH_NON_JOINER = String.fromCodePoint(0x200c);

/** Every Unicode control and format character out, except the two joiners.
 *  ZWJ builds emoji sequences and ZWNJ shapes Persian and Arabic words, and
 *  neither reorders or hides anything. The rest are the bidi overrides,
 *  embeddings and isolates that reorder what a reader sees, the BOM, the
 *  zero-width spaces and the soft hyphens. One policy, because a visitor's
 *  name and a visitor's title land on the same owner surfaces. */
function stripUnsafeCharacters(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, (ch) =>
    ch === ZERO_WIDTH_JOINER || ch === ZERO_WIDTH_NON_JOINER ? ch : "",
  );
}

/** The one thing a link visitor tells us about themselves. Trimmed, stripped
 *  by the rule above so it cannot break a frontmatter line or a log and cannot
 *  reorder the owner's Hub row it is drawn in, and cut to 40. There is no
 *  uniqueness check and no verification: it is a courtesy label in the page's
 *  own git history, not an identity. Nothing re-cleans it downstream — the
 *  value is signed into the edit claim here and written to frontmatter as it
 *  stands — so this is the only place it can be stopped. */
export function normalizeVisitorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = stripUnsafeCharacters(value).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, VISITOR_NAME_MAX);
}

/** What is left of a visitor's title, with no fallback. Stripped of every
 *  Unicode control and format character by the rule above, which the
 *  visitor's name shares. Then trimmed and cut to 200 code points, counted so
 *  the cut never splits a surrogate pair. A title is a line: the owner's
 *  quick-capture path allows 500, and this one lands in a directory name, a
 *  frontmatter line and the owner's sidebar, so it gets less. Empty when
 *  nothing usable is left.
 *
 *  The dialog that asks a visitor for a title asks with this one, so a name
 *  the route would turn into "Untitled" is never sent. A visitor cannot
 *  rename, so a page born unnamed stays unnamed. */
export function cleanVisitorTitle(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = stripUnsafeCharacters(value).trim();
  return [...cleaned].slice(0, VISITOR_TITLE_MAX).join("").trim();
}

/** The title the create route keeps. Nothing left after cleaning is
 *  "Untitled", the owner's own default for a new page. Anything but a string
 *  is null. */
export function normalizeVisitorTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return cleanVisitorTitle(value) || "Untitled";
}
