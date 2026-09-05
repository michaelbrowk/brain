import { NextRequest, NextResponse } from "next/server";
import { configuredPublicOrigin, getStore } from "@/lib/store";
import { shareEditCookieName, verifyShareEditToken } from "@/lib/auth";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";
import { SHARE_WRITE_CONCURRENCY } from "@/lib/store/share-limits";

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

type StoreHandle = Awaited<ReturnType<typeof getStore>>;

const MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * MINUTE;

/** Nested, per visitor inside per root, and the ROOT bucket is spent first.
 *  That order is the load-bearing part: `FixedWindowRateLimiter.consume` fails
 *  closed on a full map (lib/rate-limit.ts:56-68) and a visitor can mint many
 *  `vid` values, so a flat per-`vid` key reached first would be a denial
 *  primitive against every other visitor of every other share. Spending the
 *  root first also means a visitor past their own limit keeps draining the
 *  root: that is accepted, the root ceiling is the one that binds under abuse
 *  and its blast radius is one share rather than the box. */
const BUCKETS: Record<
  ShareWriteBucket,
  { prefix: string; visitor: FixedWindowRateLimiter; root: FixedWindowRateLimiter }
> = {
  // Called on every editor mount and after every conflict, which is exactly
  // when writes are being attempted too. Its own bucket, so a reload loop
  // cannot leave a visitor able to read and unable to save.
  read: {
    prefix: "share-read",
    visitor: new FixedWindowRateLimiter({ limit: 120, windowMs: MINUTE, maxEntries: 1_024 }),
    root: new FixedWindowRateLimiter({ limit: 600, windowMs: MINUTE, maxEntries: 1_024 }),
  },
  write: {
    prefix: "share-write",
    visitor: new FixedWindowRateLimiter({ limit: 60, windowMs: MINUTE, maxEntries: 1_024 }),
    root: new FixedWindowRateLimiter({ limit: 300, windowMs: MINUTE, maxEntries: 1_024 }),
  },
  upload: {
    prefix: "share-upload",
    visitor: new FixedWindowRateLimiter({ limit: 20, windowMs: FIVE_MINUTES, maxEntries: 1_024 }),
    root: new FixedWindowRateLimiter({ limit: 60, windowMs: FIVE_MINUTES, maxEntries: 1_024 }),
  },
  create: {
    prefix: "share-create",
    visitor: new FixedWindowRateLimiter({ limit: 10, windowMs: FIVE_MINUTES, maxEntries: 1_024 }),
    root: new FixedWindowRateLimiter({ limit: 30, windowMs: FIVE_MINUTES, maxEntries: 1_024 }),
  },
};

let inFlight = 0;

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION_RE = /^\d{1,9}$/;

/** One shape for every authority denial: existence, authority, expiry,
 *  version, subtree, root liveness, target liveness. Byte-identical body,
 *  byte-identical headers, so a visitor cannot tell which one it was. */
export function shareWriteNotFound(): NextResponse {
  return NextResponse.json(
    { error: "not found" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function shareWriteBusy(): NextResponse {
  return NextResponse.json(
    { error: "temporarily unavailable" },
    {
      status: 503,
      headers: { "Cache-Control": "private, no-store", "Retry-After": "1" },
    },
  );
}

/** The static rule AGENTS.md invariant 8 states, as a predicate a test can
 *  run over the route tree. Returns the reason, or null when the file is fine. */
export function violatesShareRouteRule(source: string): string | null {
  if (/\bgetStore\b/.test(source)) {
    return "imports getStore instead of going through lib/share-write.ts";
  }
  if (/export\s+(async\s+)?function\s+DELETE\b/.test(source)) {
    return "exports a DELETE handler";
  }
  if (/export\s+(async\s+)?function\s+PATCH\b/.test(source)) {
    return "exports a PATCH handler";
  }
  if (!/\bwithShareWrite\b/.test(source)) {
    return "does not go through withShareWrite";
  }
  return null;
}

/**
 * The pinned refusal order. Nothing below a line may run before it.
 *
 *   1. 400 missing_share_context: `root` or `v` absent or malformed
 *   2. 403 bad_origin: Origin differs from BRAIN_PUBLIC_ORIGIN, or none is set
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
  run: (ctx: ShareWriteContext, store: StoreHandle) => Promise<Response>,
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
    return NextResponse.json({ error: "missing_share_context" }, { status: 400 });
  }

  const origin = configuredPublicOrigin();
  if (!origin || req.headers.get("origin") !== origin) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  const shareVersion = Number(requestedVersion);
  const claims = await verifyShareEditToken(
    req.cookies.get(shareEditCookieName(rootId))?.value,
    rootId,
    shareVersion,
  );
  if (!claims) return shareWriteNotFound();

  if (req.headers.get(SHARE_VID_HEADER) !== claims.vid) {
    return NextResponse.json({ error: "vid_mismatch" }, { status: 403 });
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
      store,
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
  return NextResponse.json(
    { error: "share_edit_rate" },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
