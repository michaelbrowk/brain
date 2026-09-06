import { NextRequest, NextResponse } from "next/server";
import { configuredPublicOrigin, getStore, type Store } from "@/lib/store";
import { shareEditCookieName, verifyShareEditToken } from "@/lib/auth";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";
import { SHARE_WRITE_CONCURRENCY } from "@/lib/store/share-limits";

/**
 * The one gate every link-visitor request passes through. Two things a
 * reader would otherwise infer wrongly:
 *
 * Refusals are byte-identical, not constant-time. The seven authority
 * causes (existence, authority, expiry, version, subtree, root liveness,
 * target liveness) share one body and one header set, so the response says
 * nothing about which one it was. They do not share a duration: each is
 * found at a different point inside `resolveShareAccess`, and nothing here
 * pads the difference. Timing is left to the same budget every `/share`
 * read already accepts.
 *
 * `bad_origin` and `vid_mismatch` are unmetered on purpose. Neither request
 * has proven it is the visitor the cookie names: one arrives from another
 * site, the other cannot echo the `vid` a same-site script would know. The
 * only keys on offer at that point, the root id and the cookie's `vid`, are
 * ones a stranger can present on someone else's behalf, so a meter there
 * would be a denial primitive rather than a defense. Both cost one
 * signature check at most and answer without touching the Store.
 */

/** The double submit. The value must equal the `vid` claim inside the HttpOnly
 *  edit cookie, which a cross-site page cannot read. */
export const SHARE_VID_HEADER = "x-brain-share-vid";

export type ShareWriteBucket = "read" | "write" | "upload" | "create";

export type ShareWriteContext = {
  rootId: string;
  targetId: string;
  shareVersion: number;
  vid: string;
  name: string;
};

/** What a visitor route may reach on the Store: an allowlist, so a leaf added
 *  to the Store tomorrow is hidden from visitors until someone names it here.
 *  The four read-only lookups and the three share-aware leaves, each of
 *  which re-checks authority inside its own critical section. `deletePage`,
 *  `purgePage`, `movePage`, `renamePage`, `updateMeta` and
 *  `historicalMarkdownForRev` never appear: the last one would let a visitor
 *  read a page's past bodies, which no link grants. */
export type ShareStoreHandle = Pick<
  Store,
  | "readPage"
  | "readDirectChildren"
  | "isDeleted"
  | "isWithinSubtree"
  | "writeSharedPage"
  | "createSharedSubpage"
  | "saveSharedAttachment"
>;

/** The allowlist as a value, not only as a type. A `Pick<>` is erased at build
 *  time, so a `run` that receives the live Store receives `deletePage` and
 *  `movePage` with it, one cast away, and the property the type describes does
 *  not exist where it matters. This builds the seven leaves into a fresh
 *  object, so a leaf added to the Store tomorrow is absent from the value as
 *  well as from the type. The methods are wrapped rather than bound because a
 *  wrapper keeps the Store's own `this` without putting the instance itself
 *  anywhere the callback can reach. */
function narrowStore(store: Store): ShareStoreHandle {
  return {
    readPage: (id) => store.readPage(id),
    readDirectChildren: (parentId) => store.readDirectChildren(parentId),
    isDeleted: (id) => store.isDeleted(id),
    isWithinSubtree: (rootId, targetId) =>
      store.isWithinSubtree(rootId, targetId),
    writeSharedPage: (input) => store.writeSharedPage(input),
    createSharedSubpage: (input) => store.createSharedSubpage(input),
    saveSharedAttachment: (input) => store.saveSharedAttachment(input),
  };
}

const MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * MINUTE;

/** Nested, per visitor inside per root, and the ROOT bucket is spent first.
 *  That order is the load-bearing part: `FixedWindowRateLimiter.consume` fails
 *  closed on a full map (lib/rate-limit.ts:56-68) and a visitor can mint many
 *  `vid` values, so a flat per-`vid` key reached first would be a denial
 *  primitive against every other visitor of every other share. Spending the
 *  root first also means a visitor past their own limit keeps draining the
 *  root: that is accepted, the root ceiling is the one that binds under abuse
 *  and its blast radius is one share rather than the box.
 *
 *  Visitor map sizes. Each entry is one (root, vid) pair alive for one window,
 *  the map is shared by every root, and `consume` fails closed for a NEW key
 *  once it is full. Root-first accounting caps new entries at the root limit
 *  per root per window, so maxEntries / root limit is how many roots can be
 *  driven to their ceiling at once before a first-time visitor of any other
 *  share is refused:
 *    read    8192 / 600 = 13 roots in one minute
 *    write   4096 / 300 = 13 roots in one minute
 *    upload  2048 /  60 = 34 roots in five minutes
 *    create  2048 /  30 = 68 roots in five minutes
 *  Root maps hold one entry per root, and 1,024 roots is plenty. */
const BUCKETS: Record<
  ShareWriteBucket,
  { prefix: string; visitor: FixedWindowRateLimiter; root: FixedWindowRateLimiter }
> = {
  // Called on every editor mount and after every conflict, which is exactly
  // when writes are being attempted too. Its own bucket, so a reload loop
  // cannot leave a visitor able to read and unable to save.
  read: {
    prefix: "share-read",
    visitor: new FixedWindowRateLimiter({ limit: 120, windowMs: MINUTE, maxEntries: 8_192 }),
    root: new FixedWindowRateLimiter({ limit: 600, windowMs: MINUTE, maxEntries: 1_024 }),
  },
  write: {
    prefix: "share-write",
    visitor: new FixedWindowRateLimiter({ limit: 60, windowMs: MINUTE, maxEntries: 4_096 }),
    root: new FixedWindowRateLimiter({ limit: 300, windowMs: MINUTE, maxEntries: 1_024 }),
  },
  upload: {
    prefix: "share-upload",
    visitor: new FixedWindowRateLimiter({ limit: 20, windowMs: FIVE_MINUTES, maxEntries: 2_048 }),
    root: new FixedWindowRateLimiter({ limit: 60, windowMs: FIVE_MINUTES, maxEntries: 1_024 }),
  },
  create: {
    prefix: "share-create",
    visitor: new FixedWindowRateLimiter({ limit: 10, windowMs: FIVE_MINUTES, maxEntries: 2_048 }),
    root: new FixedWindowRateLimiter({ limit: 30, windowMs: FIVE_MINUTES, maxEntries: 1_024 }),
  },
};

let inFlight = 0;

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_RE = /^\d{1,9}$/;

/** Every refusal, whatever its status, is private and uncacheable: none of
 *  them may be replayed to the next visitor by a shared cache. */
function refuse(
  status: number,
  error: string,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "private, no-store", ...headers } },
  );
}

/** One shape for every authority denial: existence, authority, expiry,
 *  version, subtree, root liveness, target liveness. Byte-identical body,
 *  byte-identical headers, so a visitor cannot tell which one it was. */
export function shareWriteNotFound(): NextResponse {
  return refuse(404, "not found");
}

export function shareWriteBusy(): NextResponse {
  return refuse(503, "temporarily unavailable", { "Retry-After": "1" });
}

/** Origin decides for every request that carries one, and a mutating request
 *  must carry one: that is the rule lib/mail/providers/gmail/public-proxy.ts
 *  applies to its POST. A same-origin GET carries no Origin at all. Browsers
 *  omit it, and a script cannot add it, Origin being a forbidden header name.
 *  So a read, and only a read, may lean on the fetch-metadata attestation
 *  instead, and only when Origin is absent. */
function originAllowed(req: NextRequest, bucket: ShareWriteBucket): boolean {
  const expected = configuredPublicOrigin();
  const sent = req.headers.get("origin");
  if (sent !== null) return expected !== null && sent === expected;
  return (
    bucket === "read" && req.headers.get("sec-fetch-site") === "same-origin"
  );
}

/** The static rule AGENTS.md invariant 8 states, as a predicate a test can
 *  run over the route tree. Returns the reason, or null when the file is
 *  fine. Comments are ignored, string literals are not: a route that only
 *  mentions `getStore` in a comment is fine, one that hides it after a `//`
 *  inside a string is not. */
export function violatesShareRouteRule(source: string): string | null {
  const code = stripComments(source);
  if (/\bgetStore\b/.test(code)) {
    return "imports getStore instead of going through lib/share-write.ts";
  }
  if (/\bexport\s*\*/.test(code)) {
    return "re-exports with export *";
  }
  const declared =
    /\bexport\s+(?:const|let|var|async\s+function|function)\s+(DELETE|PATCH)\b/.exec(
      code,
    );
  if (declared) return `exports a ${declared[1]} handler`;
  for (const list of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const spec of list[1].split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0]).trim();
      if (exported === "DELETE" || exported === "PATCH") {
        return `exports a ${exported} handler`;
      }
    }
  }
  if (!/\bwithShareWrite\b/.test(code)) {
    return "does not go through withShareWrite";
  }
  return null;
}

// Drops line and block comments and keeps everything else, string literals
// included, so a double slash inside a string does not swallow the rest of
// the line. A regex literal containing a double slash would, which no route
// here has a reason to write.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === "\\") j += 1;
        j += 1;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * The pinned refusal order. Nothing below a line may run before it.
 *
 *   1. 400 missing_share_context: `root` or `v` absent or malformed
 *   2. 403 bad_origin: see originAllowed
 *   3. 404: the edit cookie is absent or does not verify
 *   4. 403 vid_mismatch: the double submit disagrees with the cookie
 *   5. 429 share_edit_rate: the root bucket, then the visitor bucket
 *   6. 503: the global concurrency ceiling
 *   7. getStore(), then the seven authority checks, which give one 404
 *
 * Steps 1 to 6 answer before any getStore() call. Step 7 is the CHEAP check;
 * the real one runs again inside the Store leaf's own critical section, which
 * is what makes a revoke revoke for a request already queued.
 */
export async function withShareWrite(
  req: NextRequest,
  input: { targetId: string; bucket: ShareWriteBucket },
  run: (ctx: ShareWriteContext, store: ShareStoreHandle) => Promise<Response>,
): Promise<Response> {
  const rootId = req.nextUrl.searchParams.get("root");
  const requestedVersion = req.nextUrl.searchParams.get("v");
  if (
    !rootId ||
    !PAGE_ID_RE.test(rootId) ||
    !requestedVersion ||
    !VERSION_RE.test(requestedVersion) ||
    !PAGE_ID_RE.test(input.targetId)
  ) {
    return refuse(400, "missing_share_context");
  }

  if (!originAllowed(req, input.bucket)) return refuse(403, "bad_origin");

  const shareVersion = Number(requestedVersion);
  const claims = await verifyShareEditToken(
    req.cookies.get(shareEditCookieName(rootId))?.value,
    rootId,
    shareVersion,
  );
  if (!claims) return shareWriteNotFound();

  if (req.headers.get(SHARE_VID_HEADER) !== claims.vid) {
    return refuse(403, "vid_mismatch");
  }

  const bucket = BUCKETS[input.bucket];
  const rootAttempt = bucket.root.consume(`${bucket.prefix}-root:${rootId}`);
  if (!rootAttempt.allowed) return tooMany(rootAttempt.retryAfterSeconds);
  const visitorAttempt = bucket.visitor.consume(
    `${bucket.prefix}:${rootId}:${claims.vid}`,
  );
  if (!visitorAttempt.allowed) return tooMany(visitorAttempt.retryAfterSeconds);

  // A read costs the Store one lock-free resolve; only the three mutating
  // buckets queue on mutate() and therefore take a slot.
  const takesSlot = input.bucket !== "read";
  if (takesSlot) {
    if (inFlight >= SHARE_WRITE_CONCURRENCY) return shareWriteBusy();
    inFlight += 1;
  }
  try {
    const store = await getStore();
    // No `allowPasswordGate`: a locked root without its read cookie is the
    // same 404 as a missing one. A password gates read and edit alike.
    const access = await resolveShareAccess(store, {
      rootId,
      targetId: input.targetId,
      requestedVersion,
      token: req.cookies.get(`brain_share_${rootId}`)?.value,
    });
    if (access.kind !== "granted" || !access.root.meta.shareEdit) {
      return shareWriteNotFound();
    }
    return await run(
      {
        rootId,
        targetId: input.targetId,
        shareVersion: access.shareVersion,
        vid: claims.vid,
        name: claims.name,
      },
      narrowStore(store),
    );
  } catch (error) {
    if (error instanceof ShareAccessNotFoundError) return shareWriteNotFound();
    if (error instanceof ShareAccessBusyError) return shareWriteBusy();
    throw error;
  } finally {
    if (takesSlot) inFlight -= 1;
  }
}

function tooMany(retryAfterSeconds: number): NextResponse {
  return refuse(429, "share_edit_rate", {
    "Retry-After": String(retryAfterSeconds),
  });
}
