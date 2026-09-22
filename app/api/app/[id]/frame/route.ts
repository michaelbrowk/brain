import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { APP_ENTRY_PATH } from "@/lib/apps/model";
import {
  APP_FRAME_TOKEN_MAX_AGE_SECONDS,
  mintAppFrameToken,
} from "@/lib/apps/frame-token";

export const dynamic = "force-dynamic";

/** THE OWNER'S DOOR TO THEIR OWN APP.
 *
 *  The canvas asks here before it mounts anything, and this answers with the
 *  address to mount. It is a POST because it mints a capability: the answer is
 *  a bearer token in a URL, which is not a thing to hand out on a GET a
 *  prefetch or a crawler can make.
 *
 *  It is the one route under `/api/app/` that reads the session cookie. It
 *  can: this request is made by the shell, which is same-site. Everything
 *  under `/t/<token>/` is made by the frame, which is not, and reads no cookie
 *  at all.
 *
 *  It also answers the question the old HEAD preflight answered, in the same
 *  call: a 404 here is a page whose entry is not on disk, and the canvas draws
 *  the missing-files state off it rather than mounting a frame onto an error
 *  document. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value))) {
    return refuse(401);
  }

  const store = await getStore();
  if (store.readAppMeta(id) === null) return refuse(404);
  const entry = await store.readAppFile(id, APP_ENTRY_PATH);
  if (entry.kind !== "file") return refuse(404);

  const exp = Math.floor(Date.now() / 1000) + APP_FRAME_TOKEN_MAX_AGE_SECONDS;
  const token = await mintAppFrameToken({
    pageId: id,
    grant: { kind: "owner" },
    exp,
  });
  return NextResponse.json(
    { src: `/api/app/${encodeURIComponent(id)}/t/${token}/index.html`, exp },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function refuse(status: 401 | 404) {
  return NextResponse.json(
    { error: status === 401 ? "unauthorized" : "not found" },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}
