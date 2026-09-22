import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

const PUBLIC_ASSETS = new Set([
  "/favicon.ico",
  "/icon.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/logo-small.png",
  "/logo.png",
  "/file.svg",
  "/globe.svg",
  "/window.svg",
  "/manifest.webmanifest",
  // Two pure functions and three listeners, with no secret in them. It is in
  // the allowlist so the browser's periodic update fetch cannot be answered
  // with the login page's HTML and quietly freeze the installed worker.
  "/sw.js",
]);

/** `/api/app-bridge/<app>/share`, and nothing else under that prefix. */
const APP_BRIDGE_SHARE = /^\/api\/app-bridge\/[^/]+\/share$/;

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Open surfaces: login and public shares. Attachment requests reach their
  // route unauthenticated, but that route enforces owner or page-scoped access.
  if (
    pathname === "/login" ||
    pathname === "/api/auth" ||
    pathname === "/api/share-auth" ||
    // The one write surface a link visitor can reach. Everything a visitor may
    // do is under this prefix; everything they may not do has no route at all.
    // The route itself enforces origin, the double submit, the buckets and the
    // authority. This only stops the session wall from answering 401 first.
    // The trailing slash is deliberate: the bare prefix stays behind the wall.
    pathname.startsWith("/api/share-edit/") ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/revoke" ||
    pathname.startsWith("/.well-known/") ||
    PUBLIC_ASSETS.has(pathname) ||
    pathname.startsWith("/fonts/") ||
    pathname.startsWith("/_attachments-v2/") ||
    pathname.startsWith("/_attachments/") ||
    pathname.startsWith("/api/media/") ||
    // An app's own files, for the same reason and on the same terms as the
    // attachment routes above: the route enforces the owner's session or a
    // live share grant itself, and not every request that reaches it can
    // carry a session. The frame's document has an opaque origin, so every
    // subresource it asks for is a cross-site request with no SameSite cookie
    // on it, and a link visitor's frame has no session at all. A 401 from the
    // wall here is an app that never shows one of its own pictures and a
    // shared app that is a blank rectangle, with nothing in any console the
    // owner will ever open.
    pathname.startsWith("/api/app/") ||
    // The one read a shared app's frame makes, and the only route under
    // `/api/app-bridge/` a link visitor may reach. The others are the owner's
    // three write doors and stay behind the wall; this matcher names one path
    // shape rather than a prefix so a route added beside it is not let out by
    // accident. The route itself resolves the live grant on every request and
    // has no write verb at all.
    APP_BRIDGE_SHARE.test(pathname) ||
    pathname.startsWith("/share/")
  )
    return NextResponse.next();

  // Deliberately tiny public liveness endpoint. Release metadata is non-secret.
  if (req.method === "GET" && pathname === "/api/health")
    return NextResponse.next();

  // Machine credentials are verified only by the exported MCP route family.
  if (pathname === "/api/mcp" || pathname.startsWith("/api/mcp/")) {
    // The exported route wrappers are the authoritative OAuth boundary.
    // Keeping state verification out of proxy avoids two runtimes opening the
    // deliberately single-process OAuth state directory.
    return NextResponse.next();
  }

  const authed = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname.startsWith("/api/")) {
    if (authed) return NextResponse.next();
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!authed) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname === "/oauth/authorize") {
      url.searchParams.set("returnTo", `${pathname}${req.nextUrl.search}`);
    }
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Match every application path regardless of filename extension. Page ids
  // come from note metadata, so treating `*.png` as implicitly static creates
  // an authentication bypass for ids such as `private.png`. Only Next-owned
  // asset routes are excluded here; public files are allowlisted exactly above.
  matcher: ["/((?!_next/).*)"],
};
