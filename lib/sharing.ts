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

const VISITOR_NAME_MAX = 40;

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
