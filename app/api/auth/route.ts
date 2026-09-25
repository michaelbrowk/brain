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
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Single-owner app: a server-controlled key cannot be bypassed with spoofed
// proxy headers, so the budget is spent before bcrypt and the correct guess does
// not get to skip the cap — otherwise the route is an unlimited password oracle
// and a bcrypt CPU DoS.
//
// Two buckets, because one was a weapon. Every request that arrives without a
// device cookie this installation signed counts against the shared key below,
// and a stranger who exhausts it used to lock the owner out with it. A request
// that carries one counts against a key of its own, which a stranger cannot
// reach: a cookie exists on a browser because a login there already succeeded.
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

export async function POST(req: NextRequest) {
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

  // Consume before bcrypt. Once the window is exhausted, no supplied password
  // (including a correct one) reaches the expensive verifier.
  const presented = req.cookies.get(DEVICE_COOKIE)?.value;
  const device = deviceBucketKey(presented);
  const limiter = device ? deviceLimiter : sharedLimiter;
  const key = device ?? SHARED_KEY;
  const attempt = limiter.consume(key);
  if (!attempt.allowed) {
    return NextResponse.json(
      { error: "too many attempts" },
      {
        status: 429,
        headers: { "Retry-After": String(attempt.retryAfterSeconds) },
      },
    );
  }

  const ok = await bcrypt.compare(password, hash);
  if (!ok) {
    return NextResponse.json({ error: "wrong password" }, { status: 401 });
  }

  limiter.reset(key);
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
