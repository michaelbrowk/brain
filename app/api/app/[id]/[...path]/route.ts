import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { configuredPublicOrigin, getStore } from "@/lib/store";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import { APP_ASSETS_DIR, APP_ENTRY_PATH } from "@/lib/apps/model";
import { appFrameCsp } from "@/lib/apps/csp";
import { injectAppKit } from "@/lib/apps/kit";

export const dynamic = "force-dynamic";

/** WHAT THE FRAME MAY ASK FOR.
 *
 *  Two addresses, and the URL never carries the `app/` prefix the store uses:
 *  `index.html` is the entry and `assets/<name>` is an asset. `state.json` is
 *  deliberately not addressable here — the state is the bridge's, where a
 *  write can be measured and logged, and the frame has `connect-src 'none'`
 *  so it could not fetch it anyway. Anything else is a 404 before the store
 *  is touched. */
function storePathOf(segments: readonly string[]): string | null {
  if (segments.length === 1 && segments[0] === "index.html") return APP_ENTRY_PATH;
  if (segments.length < 2 || segments[0] !== "assets") return null;
  const name = segments.slice(1).join("/");
  // The store checks the name against `appAssetPath` and answers `missing`
  // for anything it will not address. This is the first lock, so a traversal
  // never becomes a path at all.
  if (segments.slice(1).some((segment) => segment === "." || segment === "..")) return null;
  return `${APP_ASSETS_DIR}/${name}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> },
) {
  const { id, path } = await params;
  const relative = storePathOf(path ?? []);
  if (relative === null) return missing();

  const store = await getStore();
  // A page is an app only when its own `app` map parses. A hand-written
  // `kind: app`, or a restore that has not reached the frontmatter yet,
  // leaves a page that claims to be an app and is not one; `readAppMeta`
  // answers null for it and nothing of it is served. The canvas draws the
  // missing-files state off the same 404.
  if (store.readAppMeta(id) === null) return missing();
  if (!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value))) {
    // A link visitor reaches an app the same way they reach its media: the
    // root they came through and the share version they were served, checked
    // against the live grant on every request.
    const rootId = req.nextUrl.searchParams.get("root");
    const requestedVersion = req.nextUrl.searchParams.get("v");
    if (!rootId || requestedVersion === null) return missing();
    try {
      const access = await resolveShareAccess(store, {
        rootId,
        targetId: id,
        requestedVersion,
        token: req.cookies.get(`brain_share_${rootId}`)?.value,
      });
      if (access.kind !== "granted") return missing();
    } catch (error) {
      if (error instanceof ShareAccessBusyError) return busy();
      if (error instanceof ShareAccessNotFoundError) return missing();
      throw error;
    }
  }

  const file = await store.readAppFile(id, relative);
  if (file.kind !== "file") return missing();

  // The kit is injected at serve time when the entry asks for it, because the
  // policy above forbids the frame fetching a stylesheet of its own. An entry
  // that inlines its own styles instead passes through untouched.
  const body =
    relative === APP_ENTRY_PATH
      ? new TextEncoder().encode(injectAppKit(new TextDecoder().decode(file.data)))
      : file.data;

  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(body.byteLength),
      // The policy is built here rather than in `next.config.ts` because it
      // names the public origin and this app's id, and a config block can
      // only carry a static string. The origin is the configured one
      // (`BRAIN_PUBLIC_ORIGIN`, what share links are built from); behind
      // nginx `req.nextUrl.origin` is the bind host, not the address the
      // browser will fetch assets from, so it is only the fallback for an
      // install with no public origin configured. `Host` and
      // `X-Forwarded-Host` are the client's to set and are not read.
      "Content-Security-Policy": appFrameCsp(appOrigin(req), id),
      // An app's files are mutable: a rebuild replaces them at the same
      // address. Nothing here may be cached, or a rebuild would be invisible.
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function missing() {
  return NextResponse.json(
    { error: "not found" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );
}

// The origin the frame's policy names. See the comment at the header.
function appOrigin(req: NextRequest): string {
  return configuredPublicOrigin() ?? req.nextUrl.origin;
}

function busy() {
  return NextResponse.json(
    { error: "temporarily unavailable" },
    {
      status: 503,
      headers: { "Cache-Control": "private, no-store", "Retry-After": "1" },
    },
  );
}
