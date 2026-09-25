import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  bumpSessionEpoch,
  cookieSecure,
  createSession,
  SESSION_COOKIE,
  verifySession,
} from "@/lib/auth";
import {
  createDeviceCookie,
  DEVICE_COOKIE,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  deviceBucketKey,
} from "@/lib/device-cookie";
import { declaresJson } from "@/lib/json-body";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";
import { shareOriginAllowed } from "@/lib/share-origin";
import { configuredPublicOrigin } from "@/lib/store";

export const dynamic = "force-dynamic";

// Single-owner app: a server-controlled key cannot be bypassed with spoofed
// proxy headers, so the budget is spent before bcrypt and the correct guess does
// not get to skip the cap — otherwise the route is an unlimited password oracle
// and a bcrypt CPU DoS.
//
// Two buckets, because one was a weapon. Every request counts against the shared
// key below, and a stranger who exhausts it used to lock the owner out with it. A
// request carrying a device cookie this installation signed gets a budget of its
// own FIRST, which a stranger cannot reach: such a cookie exists on a browser
// because a login there already succeeded.
//
// The device budget is spent before the shared one and falls through to it, never
// instead of it. Keying on the cookie alone left a browser whose own five were
// spent — or whose cookie somebody had copied and spent for it — with less than a
// browser carrying no cookie at all, which is backwards for the one thing the
// cookie exists to protect.
const SHARED_KEY = "human-login";
const sharedLimiter = new FixedWindowRateLimiter({
  limit: 10,
  windowMs: 30 * 1000,
  maxEntries: 1,
});
// One bucket per device, as many devices as an owner plausibly has, and the
// oldest window goes when they are all in use — see `lib/rate-limit.ts` for why
// this map evicts where the shared one refuses.
const deviceLimiter = new FixedWindowRateLimiter({
  limit: 5,
  windowMs: 60 * 1000,
  maxEntries: 1_024,
  evictOldest: true,
});

/** WHETHER THIS POST CAME FROM SOMEWHERE ALLOWED TO SEND IT.
 *
 *  Asked before the budget and before bcrypt, because a cross-site
 *  `<form enctype="text/plain">` POST needs neither script nor a reply to be an
 *  attack here: from any page a visitor opens, it drained the shared budget and
 *  burned a comparison per request in somebody else's Brain.
 *
 *  Same rule as the share-edit mint (`lib/share-origin.ts`), with one difference
 *  it cannot have: an installation with no `BRAIN_PUBLIC_ORIGIN` must still be
 *  able to log in. With nothing to compare an Origin against, the browser's own
 *  account of where the request came from is what decides, and a client outside a
 *  browser — the standalone and compose smokes both post with node `fetch` —
 *  sends neither header and is admitted, bounded by the budget like everything
 *  else. */
function originAllowed(req: NextRequest): boolean {
  const expected = configuredPublicOrigin();
  if (expected !== null) {
    return shareOriginAllowed(req.headers, expected, {
      attestationMayDecide: true,
    });
  }
  const site = req.headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}

interface SpentBudget {
  /** The limiter and key a comparison was charged to, so a success can clear it. */
  readonly limiter: FixedWindowRateLimiter;
  readonly key: string;
}

/** Charge this request's comparison to the device's own budget if it has one and
 *  there is any left, and to the shared budget otherwise. Null is a refusal, and
 *  only both of them saying no is a refusal; its number is the sooner of the two
 *  windows, which is the first moment a budget exists again. */
function chargeComparison(device: string | null): SpentBudget | { retryAfterSeconds: number } {
  let soonest = Infinity;
  if (device) {
    const attempt = deviceLimiter.consume(device);
    if (attempt.allowed) return { limiter: deviceLimiter, key: device };
    soonest = attempt.retryAfterSeconds;
  }
  const shared = sharedLimiter.consume(SHARED_KEY);
  if (shared.allowed) return { limiter: sharedLimiter, key: SHARED_KEY };
  return { retryAfterSeconds: Math.min(soonest, shared.retryAfterSeconds) };
}

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  // `req.json()` ignores the header, so this refuses the request rather than
  // reads it: the three enctypes a form can declare are none of them this one.
  if (!declaresJson(req.headers)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  let password: unknown;
  try {
    ({ password } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof password !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const hash = process.env.AUTH_PASSWORD_HASH;
  if (!hash) return NextResponse.json({ error: "auth not configured" }, { status: 500 });

  // Charge before bcrypt. Once every budget this request can reach is spent, no
  // supplied password (including a correct one) reaches the expensive verifier.
  const presented = req.cookies.get(DEVICE_COOKIE)?.value;
  const device = deviceBucketKey(presented);
  const charged = chargeComparison(device);
  if (!("limiter" in charged)) {
    return NextResponse.json(
      { error: "too many attempts" },
      {
        status: 429,
        headers: { "Retry-After": String(charged.retryAfterSeconds) },
      },
    );
  }

  const ok = await bcrypt.compare(password, hash);
  if (!ok) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  // The password was right, so every bucket this browser could have been counted
  // in is cleared, not only the one that paid for this comparison.
  charged.limiter.reset(charged.key);
  if (device) deviceLimiter.reset(device);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    // `true` unless the owner configured a plain-http private origin, where a
    // Secure cookie is discarded and the login loops. `cookieSecure` has the
    // whole of it.
    secure: cookieSecure(true),
    sameSite: "lax",
    path: "/",
    maxAge: 90 * 24 * 3600,
  });
  // A login is the only thing that mints this, and every login refreshes the
  // year. The value a valid cookie already carries is kept, so a browser keeps
  // the bucket it has been counting against.
  res.cookies.set(DEVICE_COOKIE, device && presented ? presented : createDeviceCookie(), {
    httpOnly: true,
    secure: cookieSecure(true),
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  let everywhere = false;
  try {
    const body = (await req.json()) as { scope?: unknown };
    everywhere = body?.scope === "everywhere";
  } catch {
    // no body — plain single-cookie logout
  }
  if (everywhere) {
    // Bumping the epoch kills every issued cookie, so it must prove a live
    // session first — this path is on the proxy's public allowlist, and an
    // anonymous caller must not be able to log the owner out everywhere.
    const authed = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
    if (!authed) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    await bumpSessionEpoch();
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
