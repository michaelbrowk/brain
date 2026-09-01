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
]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Open surfaces: login and public shares. Attachment requests reach their
  // route unauthenticated, but that route enforces owner or page-scoped access.
  if (
    pathname === "/login" ||
    pathname === "/api/auth" ||
    pathname === "/api/share-auth" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/revoke" ||
    pathname.startsWith("/.well-known/") ||
    PUBLIC_ASSETS.has(pathname) ||
    pathname.startsWith("/fonts/") ||
    pathname.startsWith("/_attachments-v2/") ||
    pathname.startsWith("/_attachments/") ||
    pathname.startsWith("/api/media/") ||
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
