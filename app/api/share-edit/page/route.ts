import { NextRequest, NextResponse } from "next/server";
import { withShareWrite } from "@/lib/share-write";
import { normalizeVisitorTitle } from "@/lib/sharing";
import { isShareSubtreeFull } from "@/lib/store";

export const dynamic = "force-dynamic";

/** A title is all the body carries. 4 KiB is two orders of magnitude over
 *  the longest one the route will keep. */
const MAX_CREATE_BODY_BYTES = 4 * 1024;

/** The parent rides on the URL as `?parent=`, the way the upload's page does,
 *  so the guard has its target before a byte of body is read: the cookie,
 *  the CSRF header, both rate limiters and the concurrency ceiling all answer
 *  before an unauthenticated request gets to allocate anything. */
export async function POST(req: NextRequest) {
  const parentId = req.nextUrl.searchParams.get("parent") ?? "";
  return withShareWrite(
    req,
    { targetId: parentId, bucket: "create" },
    async (ctx, store) => {
      // Decided from Content-Length before the body is buffered. The count
      // after the read covers a request that declared nothing.
      if (Number(req.headers.get("content-length") ?? 0) > MAX_CREATE_BODY_BYTES) {
        return tooLarge();
      }
      const raw = await req.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_CREATE_BODY_BYTES) {
        return tooLarge();
      }
      const title = parseTitle(raw);
      if (title === null) {
        return NextResponse.json({ error: "bad request" }, { status: 400 });
      }
      try {
        const meta = await store.createSharedSubpage({
          rootId: ctx.rootId,
          parentId: ctx.targetId,
          shareVersion: ctx.shareVersion,
          title,
          visitorName: ctx.name,
          src: `share-edit:${ctx.vid}`,
        });
        return NextResponse.json({ id: meta.id });
      } catch (error) {
        if (isShareSubtreeFull(error)) {
          return NextResponse.json({ error: "subtree_full" }, { status: 409 });
        }
        throw error;
      }
    },
  );
}

function parseTitle(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return normalizeVisitorTitle((parsed as Record<string, unknown>).title);
}

function tooLarge() {
  return NextResponse.json({ error: "too_large" }, { status: 413 });
}
