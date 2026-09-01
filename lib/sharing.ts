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
