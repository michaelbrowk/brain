import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  bumpSessionEpoch,
  createSession,
  SESSION_COOKIE,
  verifySession,
} from "@/lib/auth";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Single-owner app: a server-controlled global key cannot be bypassed with
// spoofed proxy headers. This deliberately imposes a short global lockout after
// five comparisons: without a trusted edge identity, letting the correct guess
// bypass the cap would leave an unlimited password oracle and bcrypt CPU DoS.
const LOGIN_KEY = "human-login";
const limiter = new FixedWindowRateLimiter({
  limit: 5,
  windowMs: 60 * 1000,
  maxEntries: 1,
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
  const attempt = limiter.consume(LOGIN_KEY);
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

  limiter.reset(LOGIN_KEY);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 90 * 24 * 3600,
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
