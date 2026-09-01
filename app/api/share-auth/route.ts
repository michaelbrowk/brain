import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getStore, isNotFound } from "@/lib/store";
import { createShareToken } from "@/lib/auth";
import { isShareExpired } from "@/lib/sharing";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// The key is a validated, existing page id. It cannot be multiplied with fake
// forwarding headers, and the hard cap bounds memory even with many pages. As
// on owner login, five comparisons can cause a short one-minute page lockout;
// that tradeoff is required for a real pre-bcrypt cap without trusted client IP.
const limiter = new FixedWindowRateLimiter({
  limit: 5,
  windowMs: 60 * 1000,
  maxEntries: 1_024,
});

/** A visitor on a password-protected shared page exchanges the password for a
 *  signed, page-scoped cookie (30d). */
export async function POST(req: NextRequest) {
  let id: unknown;
  let password: unknown;
  try {
    ({ id, password } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof id !== "string" || typeof password !== "string")
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  try {
    const store = await getStore();
    const page = await store.readPage(id);
    if (
      store.isDeleted(id) ||
      !page.meta.public ||
      !page.meta.sharePass ||
      isShareExpired(page.meta.shareExpiresAt)
    )
      return NextResponse.json({ error: "not found" }, { status: 404 });

    const attempt = limiter.consume(`share:${id}`);
    if (!attempt.allowed)
      return NextResponse.json(
        { error: "too many attempts" },
        {
          status: 429,
          headers: { "Retry-After": String(attempt.retryAfterSeconds) },
        },
      );

    const ok = await bcrypt.compare(password, page.meta.sharePass);
    if (!ok) {
      return NextResponse.json({ error: "wrong password" }, { status: 401 });
    }

    limiter.reset(`share:${id}`);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(
      `brain_share_${id}`,
      await createShareToken(id, page.meta.shareVersion ?? 0),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        // The page-scoped token is also needed by /api/media for attachments
        // referenced by this exact shared page. Its signed audience still binds
        // it to id + shareVersion, so a root cookie broadens delivery, not power.
        path: "/",
        maxAge: 30 * 24 * 60 * 60,
      },
    );
    return res;
  } catch (e) {
    if (isNotFound(e))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
