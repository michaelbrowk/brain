import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { configuredPublicOrigin, getStore, isNotFound } from "@/lib/store";
import {
  createShareEditToken,
  createShareToken,
  shareEditCookieName,
  verifyShareToken,
  SHARE_EDIT_MAX_AGE_SECONDS,
} from "@/lib/auth";
import { isShareExpired, normalizeVisitorName } from "@/lib/sharing";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";
import { shareOriginAllowed } from "@/lib/share-origin";

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

// A separate bucket, deliberately. An unlocked edit mint costs no bcrypt, and
// letting cheap mints consume the comparison budget above would let one visitor
// lock every reader of that page out for a minute.
const editLimiter = new FixedWindowRateLimiter({
  limit: 30,
  windowMs: 60 * 1000,
  maxEntries: 1_024,
});

/** The read path predates this branch and is left byte for byte as it was, so
 *  this is asked only where the new capability is minted. A cross-site form
 *  can declare application/x-www-form-urlencoded, multipart/form-data or
 *  text/plain, and nothing else. */
function declaresJson(req: NextRequest): boolean {
  const type = req.headers.get("content-type");
  return type !== null && type.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

const badRequest = () =>
  NextResponse.json({ error: "bad request" }, { status: 400 });
const notFound = () =>
  NextResponse.json({ error: "not found" }, { status: 404 });

/** A visitor on a password-protected shared page exchanges the password for a
 *  signed, page-scoped cookie (30d). With `intent: "edit"` the same route mints
 *  the second, shorter-lived cookie that authorizes writes. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return badRequest();
  }
  const { id, password, intent, name } = body as Record<string, unknown>;
  // Only the exact string selects the new branch. Anything else, a typo
  // included, falls through to the read path exactly as it did before this
  // branch existed.
  if (intent === "edit") return mintEditToken(req, id, name, password);

  if (typeof id !== "string" || typeof password !== "string") {
    return badRequest();
  }

  try {
    const store = await getStore();
    const page = await store.readPage(id);
    if (
      store.isDeleted(id) ||
      !page.meta.public ||
      !page.meta.sharePass ||
      isShareExpired(page.meta.shareExpiresAt)
    )
      return notFound();

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
    if (isNotFound(e)) return notFound();
    throw e;
  }
}

async function mintEditToken(
  req: NextRequest,
  id: unknown,
  rawName: unknown,
  password: unknown,
): Promise<NextResponse> {
  // The same refusal the write guard gives, on the route that hands out the
  // capability the guard checks. Without it a cross-site
  // <form enctype="text/plain"> POST plants brain_edit_share_<root> in a
  // stranger's browser, carrying an attacker-chosen display name, for any
  // unlocked editable root whose id the attacker knows: the victim then skips
  // the name dialog and edits under that label. No read or write capability
  // is gained, but the attribution in the file and in the Hub is the
  // attacker's. Login-CSRF, and it costs one header to close.
  //
  // A form POST does send Origin, so that check alone answers it. The
  // Content-Type is belt and braces: req.json() ignores the header, and the
  // three enctypes a form can declare are not this one.
  if (!shareOriginAllowed(req.headers, configuredPublicOrigin())) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  if (!declaresJson(req)) return badRequest();
  if (typeof id !== "string") return badRequest();
  // The mint carries no root/version context of its own, so an empty name is
  // the route's ordinary 400, not a share denial.
  const name = normalizeVisitorName(rawName);
  if (!name) return badRequest();

  try {
    const store = await getStore();
    const page = await store.readPage(id);
    if (
      store.isDeleted(id) ||
      !page.meta.public ||
      !page.meta.shareEdit ||
      isShareExpired(page.meta.shareExpiresAt)
    )
      return notFound();

    const attempt = editLimiter.consume(`share-edit-session:${id}`);
    if (!attempt.allowed)
      return NextResponse.json(
        { error: "too many attempts" },
        {
          status: 429,
          headers: { "Retry-After": String(attempt.retryAfterSeconds) },
        },
      );

    const shareVersion = page.meta.shareVersion ?? 0;
    let verifiedPassword = false;
    if (page.meta.sharePass) {
      // A valid read cookie already proves the password at this version, so a
      // wrong password sent alongside a good cookie is accepted on purpose and
      // a bcrypt comparison is saved.
      const reader = await verifyShareToken(
        req.cookies.get(`brain_share_${id}`)?.value,
        id,
        shareVersion,
      );
      if (!reader) {
        if (typeof password !== "string" || !password) {
          return NextResponse.json({ error: "wrong password" }, { status: 401 });
        }
        // A guess is a guess whichever branch carries it. The comparison spends
        // the read path's five-per-minute budget, so the mint cannot widen a
        // brute force on a locked root by thirty attempts a minute.
        const guess = limiter.consume(`share:${id}`);
        if (!guess.allowed)
          return NextResponse.json(
            { error: "too many attempts" },
            {
              status: 429,
              headers: { "Retry-After": String(guess.retryAfterSeconds) },
            },
          );
        const ok = await bcrypt.compare(password, page.meta.sharePass);
        if (!ok) {
          return NextResponse.json({ error: "wrong password" }, { status: 401 });
        }
        limiter.reset(`share:${id}`);
        verifiedPassword = true;
      }
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(
      shareEditCookieName(id),
      await createShareEditToken(id, shareVersion, nanoid(12), name),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: SHARE_EDIT_MAX_AGE_SECONDS,
      },
    );
    // Only when this request did the bcrypt comparison itself: a visitor who
    // arrived with a valid read cookie already has one.
    if (verifiedPassword) {
      res.cookies.set(
        `brain_share_${id}`,
        await createShareToken(id, shareVersion),
        {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 30 * 24 * 60 * 60,
        },
      );
    }
    return res;
  } catch (e) {
    if (isNotFound(e)) return notFound();
    throw e;
  }
}
