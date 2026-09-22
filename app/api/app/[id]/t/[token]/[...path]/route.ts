import { NextRequest, NextResponse } from "next/server";
import { configuredPublicOrigin, getStore } from "@/lib/store";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import { APP_ASSETS_DIR, APP_ENTRY_PATH } from "@/lib/apps/model";
import { appFrameCsp } from "@/lib/apps/csp";
import { injectAppKit } from "@/lib/apps/kit";
import { verifyAppFrameToken } from "@/lib/apps/frame-token";

export const dynamic = "force-dynamic";

/** ONE AUTHORITY, AND IT IS IN THE PATH.
 *
 *  THIS ROUTE READS NO COOKIE. It cannot: the frame is sandboxed without
 *  `allow-same-origin`, so its document has an opaque origin and every
 *  subresource it asks for is a cross-site request that carries no SameSite
 *  cookie. The entry would load (that navigation is started by the same-site
 *  top document) and then every `assets/card.png` under it would arrive with
 *  nothing on it and be refused, invisibly: no CSP violation, no console line,
 *  just a picture that never appears.
 *
 *  A query string cannot carry it either, because `assets/card.png` is
 *  relative and resolves against the path, dropping the query. So the grant is
 *  a signed token in a path segment, where a relative URL carries it by
 *  construction, and the same token authorises the document and every file
 *  under it.
 *
 *  A share token is re-resolved against the live share on every request, so a
 *  link that has been revoked, has expired or has been rotated stops serving
 *  an app's files at once rather than when the token ages out. */

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

/** The canvas asks this before it mounts anything, so it runs on every app
 *  open. Next auto-implements HEAD by running GET whole and dropping the
 *  body, which here means decoding the entry and splicing the kit into it for
 *  a body nobody reads. This is the same decision with none of that work.
 *
 *  It answers no `Content-Length`, because the length is the length after the
 *  kit is spliced in and finding it out is the work the verb exists to skip.
 *  A HEAD may omit it; a wrong one would be worse than none. */
type Params = { id: string; token: string; path: string[] };

export async function HEAD(req: NextRequest, ctx: { params: Promise<Params> }) {
  return serve(req, ctx, "HEAD");
}

export async function GET(req: NextRequest, ctx: { params: Promise<Params> }) {
  return serve(req, ctx, "GET");
}

async function serve(
  req: NextRequest,
  { params }: { params: Promise<Params> },
  method: "GET" | "HEAD",
) {
  const { id, token, path } = await params;
  const relative = storePathOf(path ?? []);
  if (relative === null) return missing();

  // The whole authority, in one line. A forged token, an edited one, an
  // expired one and one minted for another app are all the same null and all
  // the same 404: telling them apart would tell a caller which.
  const grant = await verifyAppFrameToken(token, id);
  if (grant === null) return missing();

  const store = await getStore();
  if (grant.kind === "share") {
    // The token says a grant existed when it was cut. This says one exists
    // now: the root still public and not expired, the version still the one
    // the token names, the page still inside the subtree and not in the
    // trash. A revoke or a rotation stops an app mid-session rather than when
    // the token ages out.
    try {
      const access = await resolveShareAccess(store, {
        rootId: grant.root,
        targetId: id,
        requestedVersion: String(grant.version),
        // The password, where the link has one, was proven before this token
        // was minted: the share page resolved a granted access with the
        // visitor's own cookie and only then cut it. This request carries no
        // cookie of any kind, so the gate would refuse every file of every
        // locked link's app. Everything else the resolver checks still runs,
        // before the gate and after it.
        verifyToken: async () => true,
      });
      if (access.kind !== "granted") return missing();
    } catch (error) {
      if (error instanceof ShareAccessBusyError) return busy();
      if (error instanceof ShareAccessNotFoundError) return missing();
      throw error;
    }
  }

  // A page is an app only when its own `app` map parses. A hand-written
  // `kind: app`, or a restore that has not reached the frontmatter yet,
  // leaves a page that claims to be an app and is not one; `readAppMeta`
  // answers null for it and nothing of it is served. The canvas draws the
  // missing-files state off the same 404. Asked after the grant, so a caller
  // who has shown nothing touches nothing, index included.
  if (store.readAppMeta(id) === null) return missing();

  const file = await store.readAppFile(id, relative);
  if (file.kind !== "file") return missing();

  const headers: Record<string, string> = {
    "Content-Type": file.mimeType,
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
  };

  if (method === "HEAD") return new NextResponse(null, { status: 200, headers });

  // The kit is injected at serve time when the entry asks for it, because the
  // policy above forbids the frame fetching a stylesheet of its own. An entry
  // that inlines its own styles instead passes through untouched.
  const body =
    relative === APP_ENTRY_PATH
      ? new TextEncoder().encode(injectAppKit(new TextDecoder().decode(file.data)))
      : file.data;

  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: { ...headers, "Content-Length": String(body.byteLength) },
  });
}

function missing() {
  return NextResponse.json(
    { error: "not found" },
    { status: 404, headers: REFUSAL_HEADERS },
  );
}

/** A refusal is typed the way an answer is. Everything this route serves is
 *  asked for by a frame, so a refusal reaches an `<img>` or a `<script>` as
 *  readily as the bytes would, and a route where only the happy path says
 *  `nosniff` is the one somebody copies the unhappy path out of. */
const REFUSAL_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

/** Said once per process, not once per request: a log line on every asset of
 *  every app open would be the noise that hides it. */
let warnedAboutProxy = false;

// The origin the frame's policy names. See the comment at the header.
function appOrigin(req: NextRequest): string {
  const configured = configuredPublicOrigin();
  if (configured) return configured;
  // Behind a proxy with nothing configured, the origin below is the bind
  // host, the frame's `frame-ancestors` does not match the address the
  // browser is actually on, and the browser refuses the frame with no console
  // anybody will open. The forwarded header is NOT used to fix it, because a
  // policy built from a header is a policy the client wrote. It is read for
  // this one sentence and for nothing else.
  if (!warnedAboutProxy && req.headers.get("x-forwarded-host")) {
    warnedAboutProxy = true;
    console.warn(
      "An app frame is being served behind a proxy with no BRAIN_PUBLIC_ORIGIN set. " +
        "Its policy will name this server's own address, and the browser will refuse " +
        "to render the app. Set BRAIN_PUBLIC_ORIGIN to the address people open Brain on.",
    );
  }
  return req.nextUrl.origin;
}

function busy() {
  return NextResponse.json(
    { error: "temporarily unavailable" },
    { status: 503, headers: { ...REFUSAL_HEADERS, "Retry-After": "1" } },
  );
}
