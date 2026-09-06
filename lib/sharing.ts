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

/** The one thing a link visitor tells us about themselves. Trimmed, stripped of
 *  control characters so it cannot break a frontmatter line or a log, and cut to
 *  40. There is no uniqueness check and no verification: it is a courtesy label
 *  in the page's own git history, not an identity. */
export function normalizeVisitorName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, VISITOR_NAME_MAX);
}

const VISITOR_TITLE_MAX = 200;

const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d);
const ZERO_WIDTH_NON_JOINER = String.fromCodePoint(0x200c);

/** A link visitor's title for a new subpage. Stripped of every Unicode
 *  control character (the name's C0 set, DEL, and the C1 range too) and every
 *  format character: the bidi overrides, embeddings and isolates that reorder
 *  what the owner's sidebar shows, the BOM, zero-width spaces, soft hyphens.
 *  The two joiners stay: ZWJ builds emoji sequences and ZWNJ shapes Persian
 *  and Arabic words, and neither reorders or hides anything. Then trimmed
 *  and cut to 200 code points, counted so the cut never splits a surrogate
 *  pair. A title is a line: the owner's quick-capture path allows 500, and
 *  this one lands in a directory name, a frontmatter line and the owner's
 *  sidebar, so it gets less. Nothing left after cleaning is "Untitled", the
 *  owner's own default for a new page. Anything but a string is null. */
export function normalizeVisitorTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) =>
      ch === ZERO_WIDTH_JOINER || ch === ZERO_WIDTH_NON_JOINER ? ch : "",
    )
    .trim();
  return (
    [...cleaned].slice(0, VISITOR_TITLE_MAX).join("").trim() || "Untitled"
  );
}
