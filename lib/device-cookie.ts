import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { deviceSigningKey } from "@/lib/auth";

/** THE COOKIE THAT KEEPS A LOGIN LIMIT FROM BECOMING A LOCKOUT.
 *
 *  The login limiter has to consume its budget before bcrypt, or the comparison
 *  itself is the denial of service. With one global bucket that made the cap a
 *  weapon: a stranger sending five wrong passwords a minute kept the owner out
 *  for as long as they cared to keep sending, and nothing the owner could do
 *  from the login screen shortened it.
 *
 *  So the owner's browser carries something a stranger cannot have. It is set
 *  only by a login that already succeeded, and it is the key the limiter counts
 *  against: a flood spends the global bucket, and a request arriving with a
 *  cookie this installation signed is counted somewhere the flood never
 *  reaches.
 *
 *  It is not a credential and it authorizes nothing — a stolen one buys its
 *  holder five password guesses a minute, which is what the login screen offers
 *  anyone. It is not an identifier either: 32 random bytes and their signature,
 *  no name, no session, no reference to anything on disk. A year, because the
 *  point is to still be there the day a stranger starts knocking. */
export const DEVICE_COOKIE = "brain_device";
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function mac(id: string): Buffer {
  return createHmac("sha256", deviceSigningKey()).update(id, "utf8").digest();
}

export function createDeviceCookie(): string {
  const id = randomBytes(32).toString("base64url");
  return `${id}.${mac(id).toString("base64url")}`;
}

/** The limiter key for a browser carrying a cookie this installation signed, or
 *  null for every other request — no cookie, an unsigned value, a forged
 *  signature, one signed before the secret was rotated. Null means the caller
 *  uses its shared key, so a forged cookie buys nothing but the bucket a
 *  stranger already had.
 *
 *  The key is the signature rather than the value, so the map the limiter keeps
 *  never holds what the browser sent. */
export function deviceBucketKey(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const separator = cookie.indexOf(".");
  if (separator < 1 || separator === cookie.length - 1) return null;
  const presented = Buffer.from(cookie.slice(separator + 1), "base64url");
  const expected = mac(cookie.slice(0, separator));
  // A digest's length is not a secret, and timingSafeEqual throws on a pair
  // that disagrees about it.
  if (presented.length !== expected.length) return null;
  if (!timingSafeEqual(presented, expected)) return null;
  return `device:${expected.toString("base64url")}`;
}
