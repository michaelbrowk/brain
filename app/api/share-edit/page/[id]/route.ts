import { NextRequest, NextResponse } from "next/server";
import {
  pageWriteConflictResponse,
  resolvePageWrite,
  type PageWriteHistory,
} from "@/lib/api/page-write";
import { shareWriteNotFound, withShareWrite } from "@/lib/share-write";
import { isNotFound, isShareAttachmentScope } from "@/lib/store";
import { MAX_SHARE_WRITE_BYTES } from "@/lib/store/share-limits";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** A visitor's stale rev is never resolved through the page's git history.
 *  The owner's route does that for legacy crash drafts; a visitor's editor
 *  has none, and a page's past bodies are not part of what a link grants.
 *  The conflict rule itself is still the shared one. */
const NO_HISTORY: PageWriteHistory = {
  historicalMarkdownForRev: async () => null,
};

/** What the editor mounts on, and what it re-reads after a conflict. Never
 *  the full meta: a visitor gets the body, the rev and the title. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return withShareWrite(
    req,
    { targetId: id, bucket: "read" },
    async (ctx, store) => {
      try {
        const page = await store.readPage(ctx.targetId);
        return NextResponse.json({
          markdown: page.markdown,
          rev: page.rev,
          title: page.meta.title,
        });
      } catch (error) {
        if (isNotFound(error)) return shareWriteNotFound();
        throw error;
      }
    },
  );
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return withShareWrite(
    req,
    { targetId: id, bucket: "write" },
    async (ctx, store) => {
      // Decided from Content-Length before the body is buffered. The count
      // after the read covers a request that declared nothing.
      if (Number(req.headers.get("content-length") ?? 0) > MAX_SHARE_WRITE_BYTES) {
        return tooLarge();
      }
      const raw = await req.text();
      if (Buffer.byteLength(raw, "utf8") > MAX_SHARE_WRITE_BYTES) {
        return tooLarge();
      }
      const body = parseBody(raw);
      if (!body) {
        return NextResponse.json({ error: "bad request" }, { status: 400 });
      }
      try {
        const outcome = await resolvePageWrite(
          NO_HISTORY,
          { id: ctx.targetId, rev: body.rev, baseMarkdown: body.baseMarkdown },
          () =>
            store.writeSharedPage({
              rootId: ctx.rootId,
              targetId: ctx.targetId,
              shareVersion: ctx.shareVersion,
              markdown: body.markdown,
              expectedRev: body.rev,
              expectedMarkdown: body.baseMarkdown,
              visitorName: ctx.name,
              src: `share-edit:${ctx.vid}`,
            }),
        );
        if (outcome.status === "conflict") {
          return pageWriteConflictResponse(outcome);
        }
        if (outcome.status === "not-found") return shareWriteNotFound();
        return NextResponse.json({ rev: outcome.page.rev });
      } catch (error) {
        if (isShareAttachmentScope(error)) {
          return NextResponse.json(
            { error: "attachment_not_yours" },
            { status: 422 },
          );
        }
        throw error;
      }
    },
  );
}

/** The body the editor sends. `markdown` is required: a PUT without one is a
 *  broken client, not a request to blank the page. The two optional fields
 *  are taken only as strings. */
function parseBody(
  raw: string,
): { markdown: string; rev?: string; baseMarkdown?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const { markdown, rev, baseMarkdown } = parsed as Record<string, unknown>;
  if (typeof markdown !== "string") return null;
  return {
    markdown,
    rev: typeof rev === "string" ? rev : undefined,
    baseMarkdown: typeof baseMarkdown === "string" ? baseMarkdown : undefined,
  };
}

function tooLarge() {
  return NextResponse.json({ error: "too_large" }, { status: 413 });
}
