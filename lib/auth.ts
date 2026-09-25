import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isPrivateNetworkHost } from "@/lib/private-origin";

export const SESSION_COOKIE = "brain_session";
const SESSION_DAYS = 90;
const ISSUER = "brain";
const SESSION_AUDIENCE = "brain:web";
/** The subject every session and OAuth token is issued to. It names the role,
 *  not a person: one owner per installation, whoever installed it. */
export const OWNER_SUBJECT = "owner";
/** What that subject used to be, back when this ran on one person's server.
 *  Session cookies live 90 days, so issuing only the new value would sign
 *  every existing session out the day the rename deployed. Validation accepts
 *  it, nothing issues it, and it ages out with the last old cookie. */
export const LEGACY_OWNER_SUBJECT = "michael";

/**
 * True for a subject this installation considers its owner — the current value
 * or the one it replaced.
 *
 * ONE predicate, TWO token domains: the human session cookie and every OAuth
 * token (authorization request, access, refresh). That is safe today because
 * the subject is not what separates them — they carry different `kind` claims,
 * different `iss`/`aud`, and are signed with different derived keys, so a share
 * token or an OAuth access token can never be spent as a session.
 *
 * The consequence to know before editing: a third accepted subject added here
 * for one domain silently widens the other. If a domain ever needs a subject of
 * its own, give it its own predicate rather than a third entry in this one.
 */
export function isOwnerSubject(subject: unknown): boolean {
  return subject === OWNER_SUBJECT || subject === LEGACY_OWNER_SUBJECT;
}

/** WHETHER A COOKIE THIS INSTALLATION SETS MAY BE MARKED `Secure`.
 *
 *  `Secure` is not a hint. A browser accepts such a cookie only from a
 *  potentially-trustworthy origin, and of the private names Brain now serves on
 *  (`lib/private-origin.ts`) only `localhost`, `127.0.0.1` and `[::1]` are one.
 *  So on `http://brain.lan` the session cookie was set with `Secure: true`,
 *  the login POST answered 200, the browser threw the cookie away, and the
 *  password screen came back — with nothing in any log saying why, and every
 *  session-gated route unreachable. The same held for the two share cookies,
 *  which read `NODE_ENV` and so went `Secure` in any production build.
 *
 *  One rule, read off the origin the owner configured, for every cookie Brain
 *  sets. The two loopback names are in the plain-http set as well: one rule
 *  reads better than one rule with an exception, and a cookie sent in the clear
 *  to `127.0.0.1` reaches nobody the session does not already belong to.
 *
 *  `whenUnconfigured` is what the caller did before there was a rule, and it is
 *  what an installation with no `BRAIN_PUBLIC_ORIGIN` — or one whose value is
 *  not an origin, or is plain http on a public name, which MCP refuses outright
 *  — still gets. Nothing about those cases is safer for being changed here. */
export function cookieSecure(whenUnconfigured: boolean): boolean {
  const raw = process.env.BRAIN_PUBLIC_ORIGIN?.trim();
  if (!raw) return whenUnconfigured;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return whenUnconfigured;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && isPrivateNetworkHost(url.hostname)) {
    return false;
  }
  return whenUnconfigured;
}
const SESSION_KIND = "session";
const SHARE_KIND = "share";
const SHARE_EDIT_KIND = "share-edit";
/** 12 hours against the read cookie's 30 days: an edit grant is a capability,
 *  and a capability held open on a stranger's laptop is the wrong default. */
export const SHARE_EDIT_MAX_AGE_SECONDS = 12 * 60 * 60;

// ── session epoch: server-side revocation for the 90-day cookie ────────
// Cookies embed the epoch they were minted under; "log out everywhere" bumps
// the persisted counter, and every earlier cookie stops verifying. Before
// this existed the only revocation lever was rotating AUTH_SECRET, which
// also killed all OAuth grants and share cookies (audit 2026-08-19).
const EPOCH_FILE = "session-epoch.json";
const EPOCH_CACHE_TTL_MS = 5_000;

function epochDirectory(): string {
  if (process.env.BRAIN_AUTH_STATE_DIR) {
    return process.env.BRAIN_AUTH_STATE_DIR;
  }
  if (process.env.NODE_ENV === "production") {
    return "/var/lib/brain/auth";
  }
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-auth-${process.getuid?.() ?? "dev"}`,
  );
}

let cachedEpoch: { value: number; directory: string; readAt: number } | null =
  null;

async function readEpochFromDisk(directory: string): Promise<number> {
  try {
    const raw = await fs.readFile(
      /* turbopackIgnore: true */ path.join(directory, EPOCH_FILE),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { epoch?: unknown };
    if (
      typeof parsed.epoch === "number" &&
      Number.isSafeInteger(parsed.epoch) &&
      parsed.epoch >= 0
    ) {
      return parsed.epoch;
    }
  } catch {
    // A missing or unreadable file is epoch 0. Deliberately fail-open: a
    // filesystem blip must degrade to the pre-feature behavior (old cookies
    // stay valid), never lock the owner out of their own notes.
  }
  return 0;
}

/** Cached for a few seconds — verifySession runs on every proxied request. */
export async function currentSessionEpoch(): Promise<number> {
  const directory = epochDirectory();
  const now = Date.now();
  if (
    cachedEpoch &&
    cachedEpoch.directory === directory &&
    now - cachedEpoch.readAt < EPOCH_CACHE_TTL_MS
  ) {
    return cachedEpoch.value;
  }
  const value = await readEpochFromDisk(directory);
  cachedEpoch = { value, directory, readAt: now };
  return value;
}

/** Invalidate every session cookie issued so far. Atomic write, then the
 *  cache is updated so this process enforces the new epoch immediately. */
export async function bumpSessionEpoch(): Promise<number> {
  const directory = epochDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const next = (await readEpochFromDisk(directory)) + 1;
  const file = path.join(directory, EPOCH_FILE);
  const temp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(temp, JSON.stringify({ epoch: next }) + "\n", {
    mode: 0o600,
  });
  await fs.rename(temp, file);
  cachedEpoch = { value: next, directory, readAt: Date.now() };
  return next;
}

function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

/** New human and share tokens use separate signing domains. The raw key is
 *  retained only to verify already-issued legacy cookies during migration. */
function secret(
  scope?: "session" | "share" | "share-edit" | "app-frame",
): Uint8Array {
  const raw = authSecret();
  return new TextEncoder().encode(scope ? `${raw}\0brain:${scope}:v1` : raw);
}

/** The fourth signing domain, for the token in an app frame's address
 *  (`lib/apps/frame-token.ts`). It lives here rather than there so every key
 *  this installation derives is derived in one function: a domain added
 *  somewhere else is a domain nobody can see is separate. The key itself
 *  never leaves the process. */
export function appFrameSigningKey(): Uint8Array {
  return secret("app-frame");
}

export async function createSession(): Promise<string> {
  return new SignJWT({ kind: SESSION_KIND, epoch: await currentSessionEpoch() })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setSubject(OWNER_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret("session"));
}

export async function verifySession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret("session"), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (!isOwnerSubject(payload.sub) || payload.kind !== SESSION_KIND) {
      return false;
    }
    // Tokens minted before the epoch claim existed count as epoch 0.
    const tokenEpoch = typeof payload.epoch === "number" ? payload.epoch : 0;
    return tokenEpoch === (await currentSessionEpoch());
  } catch {}

  // Migration path for the old cookie signed with the raw
  // AUTH_SECRET. Exact claims matter: a legacy share:<id> token must never
  // cross into the human session domain. Natural expiry removes these in 90d.
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    return (
      isOwnerSubject(payload.sub) &&
      payload.iss === undefined &&
      payload.aud === undefined &&
      payload.kind === undefined &&
      // legacy raw-secret cookies predate epochs — the first
      // "log out everywhere" retires them for good
      (await currentSessionEpoch()) === 0
    );
  } catch {
    return false;
  }
}

/** Per-page pass for password-protected shared pages: the visitor exchanges
 *  the password for a signed cookie scoped to that page id. */
export async function createShareToken(
  pageId: string,
  shareVersion: number,
): Promise<string> {
  return new SignJWT({ kind: SHARE_KIND, shareVersion })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(`brain:share:${pageId}`)
    .setSubject(`share:${pageId}`)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secret("share"));
}

export async function verifyShareToken(
  token: string | undefined,
  pageId: string,
  shareVersion: number,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, secret("share"), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: `brain:share:${pageId}`,
    });
    return (
      payload.sub === `share:${pageId}` &&
      payload.kind === SHARE_KIND &&
      payload.shareVersion === shareVersion
    );
  } catch {}

  // Existing page-scoped cookies are safe to keep only until the first share
  // rotation. Version 0 represents metadata written before versioning existed.
  if (shareVersion !== 0) return false;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
    });
    return (
      payload.sub === `share:${pageId}` &&
      payload.iss === undefined &&
      payload.aud === undefined &&
      payload.kind === undefined &&
      payload.shareVersion === undefined
    );
  } catch {
    return false;
  }
}

/** The cookie a link visitor holds while they are allowed to write. Root-scoped
 *  and HttpOnly, so a cross-site page cannot read the `vid` inside it, which is
 *  what makes the `x-brain-share-vid` double submit worth anything. The prefix
 *  is `brain_edit_share_`, not `brain_share_edit_`: the read cookie is
 *  `brain_share_<id>`, and with a shared prefix a page id starting with `edit_`
 *  would name another page's edit cookie. */
export function shareEditCookieName(rootId: string): string {
  return `brain_edit_share_${rootId}`;
}

export async function createShareEditToken(
  rootId: string,
  shareVersion: number,
  vid: string,
  name: string,
): Promise<string> {
  return new SignJWT({ kind: SHARE_EDIT_KIND, shareVersion, vid, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(`brain:share-edit:${rootId}`)
    .setSubject(`share-edit:${rootId}`)
    .setIssuedAt()
    .setExpirationTime(`${SHARE_EDIT_MAX_AGE_SECONDS}s`)
    .sign(secret("share-edit"));
}

/** No legacy acceptance path: this domain is new, so there is no raw-secret
 *  cookie to migrate and nothing to widen. */
export async function verifyShareEditToken(
  token: string | undefined,
  rootId: string,
  shareVersion: number,
): Promise<{ vid: string; name: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret("share-edit"), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: `brain:share-edit:${rootId}`,
    });
    if (
      payload.sub !== `share-edit:${rootId}` ||
      payload.kind !== SHARE_EDIT_KIND ||
      payload.shareVersion !== shareVersion ||
      typeof payload.vid !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }
    return { vid: payload.vid, name: payload.name };
  } catch {
    return null;
  }
}

/** A digest of a credential, keyed with a value minted once per process: it is
 *  comparable inside this process, means nothing outside it, and turns a string
 *  of any length into 32 fixed bytes. */
const COMPARISON_KEY = randomBytes(32);
function comparisonDigest(value: string): Buffer {
  return createHmac("sha256", COMPARISON_KEY).update(value, "utf8").digest();
}

/** Constant-time compare for a strictly formed MCP bearer credential.
 *
 *  Both sides are folded to a fixed-width digest before they are compared, so a
 *  token of the wrong length is refused by the same comparison as one of the
 *  right length with the wrong bytes. The earlier version returned early on a
 *  length mismatch, and that answer came back fast enough to tell a prober how
 *  long the real token is — the one thing about it a prober cannot guess. */
export function verifyMcpToken(header: string | null): boolean {
  const expected = process.env.MCP_TOKEN;
  if (!expected || !header) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(comparisonDigest(match[1]), comparisonDigest(expected));
}
