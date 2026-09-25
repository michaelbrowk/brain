import { createHmac, randomBytes } from "node:crypto";

/** WHY A FLOOD MUST NOT DENY THE RIGHT PASSWORD.
 *
 *  The share gate spends its budget before bcrypt for the same reason the login
 *  does, and per page, which made five wrong guesses a minute a way to take a
 *  password-protected link away from everyone holding it. Every reader shares
 *  that page's bucket, and a reader who types the right password is refused by
 *  a window somebody else emptied.
 *
 *  So a comparison that came back right is remembered for the rest of the
 *  window, and while it is, that exact password is admitted without a
 *  comparison. The cap on bcrypt is untouched — a remembered verdict runs no
 *  comparison at all — and a guess that was never right has nothing to match: a
 *  flooder can exhaust the window, and the password they do not know still
 *  works for everyone who does.
 *
 *  What it holds is a keyed digest of the page id, the stored hash and the
 *  password, under a key minted once per process. Nothing here survives a
 *  restart, none of it is a credential, and it stops meaning anything the moment
 *  the owner changes the password: a new hash is a new digest. */
const WINDOW_MS = 60 * 1000;
export const SHARE_PASSWORD_VERDICT_CAPACITY = 64;

const DIGEST_KEY = randomBytes(32);
/** Digest to the moment its window ends, in insertion order. */
const verdicts = new Map<string, number>();

export function sharePasswordVerdictKey(
  pageId: string,
  sharePass: string,
  password: string,
): string {
  return createHmac("sha256", DIGEST_KEY)
    .update(`${pageId}\0${sharePass}\0${password}`, "utf8")
    .digest("base64url");
}

export function rememberSharePasswordVerdict(key: string, at = Date.now()): void {
  verdicts.delete(key);
  verdicts.set(key, at + WINDOW_MS);
  for (const oldest of verdicts.keys()) {
    if (verdicts.size <= SHARE_PASSWORD_VERDICT_CAPACITY) break;
    verdicts.delete(oldest);
  }
}

/** True while this exact password stands proven for this exact page. */
export function sharePasswordVerdictHolds(key: string, at = Date.now()): boolean {
  const endsAt = verdicts.get(key);
  if (endsAt === undefined) return false;
  if (endsAt <= at) {
    verdicts.delete(key);
    return false;
  }
  return true;
}
