import { NextRequest, NextResponse } from "next/server";
import {
  pageWriteConflictResponse,
  resolvePageWrite,
  type PageWriteHistory,
} from "@/lib/api/page-write";
import { readBoundedText } from "@/lib/bounded-body";
import { shareWriteNotFound, withShareWrite } from "@/lib/share-write";
import {
  isNotFound,
  isShareAttachmentScope,
  isShareLinkScheme,
  isShareRemoteMedia,
} from "@/lib/store";
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
      // Bounded by what is actually read, not by a header a chunked request
      // is free to omit.
      const raw = await readBoundedText(req, MAX_SHARE_WRITE_BYTES);
      if (raw === null) return tooLarge();
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
        // The three refusals a visitor can act on. Each carries its own
        // reason code and a sentence the editor can show as written: a bare
        // code leaves the visitor with a save that stopped working and no way
        // to tell what to do about it.
        if (isShareAttachmentScope(error)) return refused("attachment_not_yours");
        if (isShareLinkScheme(error)) return refused("unsafe_link");
        if (isShareRemoteMedia(error)) return refused("remote_media");
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

/** What a visitor may be told about their own write, and what to do next.
 *  These three codes and messages are the contract the editor renders; the
 *  authority denials stay the one uniform 404 and say nothing. */
const REFUSALS: Record<string, string> = {
  attachment_not_yours:
    "That image is not part of this shared page any more. Upload it again to use it here.",
  unsafe_link:
    "A link here can point to a web address, an email address, or another page in this share.",
  remote_media:
    "An image has to be uploaded here. One loaded from another site cannot be used.",
};

function refused(error: keyof typeof REFUSALS) {
  return NextResponse.json(
    { error, message: REFUSALS[error] },
    { status: 422 },
  );
}

function tooLarge() {
  return NextResponse.json({ error: "too_large" }, { status: 413 });
}
