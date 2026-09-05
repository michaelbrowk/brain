import { NextRequest, NextResponse } from "next/server";
import { withShareWrite } from "@/lib/share-write";
import { normalizeVisitorTitle } from "@/lib/sharing";
import { isShareSubtreeFull } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The parent id is the guard's target, and the guard needs it before it
 *  runs, so this route reads its body first. Capped at 4 KiB: an id and a
 *  title, two orders of magnitude under anything worth buffering for a
 *  request nothing has vouched for yet. */
const MAX_CREATE_BODY_BYTES = 4 * 1024;

export async function POST(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_CREATE_BODY_BYTES) {
    return tooLarge();
  }
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_CREATE_BODY_BYTES) {
    return tooLarge();
  }
  const body = parseBody(raw);
  if (!body) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  return withShareWrite(
    req,
    { targetId: body.parentId, bucket: "create" },
    async (ctx, store) => {
      try {
        const meta = await store.createSharedSubpage({
          rootId: ctx.rootId,
          parentId: ctx.targetId,
          shareVersion: ctx.shareVersion,
          title: body.title,
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

function parseBody(raw: string): { parentId: string; title: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const { parentId, title } = parsed as Record<string, unknown>;
  if (typeof parentId !== "string") return null;
  const cleanTitle = normalizeVisitorTitle(title);
  if (cleanTitle === null) return null;
  return { parentId, title: cleanTitle };
}

function tooLarge() {
  return NextResponse.json({ error: "too_large" }, { status: 413 });
}
