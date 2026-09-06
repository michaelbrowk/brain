import { NextResponse } from "next/server";
import { isNotFound, isRevConflict, type Page } from "@/lib/store";

export type PageWriteOutcome =
  | { status: "ok"; page: Page }
  | { status: "conflict"; currentRev: string; baseMarkdown?: string }
  | { status: "not-found" };

export interface PageWriteHistory {
  historicalMarkdownForRev(id: string, rev: string): Promise<string | null>;
}

const REV_TOKEN_RE = /^[0-9a-f]{12}$/;

/**
 * One conflict rule for both writers. The owner's PUT and the link visitor's
 * PUT differ only in which Store leaf they hand in as `write`; everything about
 * what a 409 means, and what a client may do with it, is decided here.
 */
export async function resolvePageWrite(
  store: PageWriteHistory,
  input: { id: string; rev?: unknown; baseMarkdown?: unknown },
  write: () => Promise<Page>,
): Promise<PageWriteOutcome> {
  try {
    return { status: "ok", page: await write() };
  } catch (e) {
    if (isRevConflict(e)) {
      // Schema-v2 crash drafts predate baseMarkdown. Resolve their exact old
      // 12-hex revision only through this page's id-bound, capped Git history.
      // Any missing/uncommitted/ambiguous revision stays a normal safe 409.
      let historicalBase: string | null = null;
      if (
        typeof input.baseMarkdown !== "string" &&
        typeof input.rev === "string" &&
        REV_TOKEN_RE.test(input.rev)
      ) {
        historicalBase = await store
          .historicalMarkdownForRev(input.id, input.rev)
          .catch(() => null);
      }
      return {
        status: "conflict",
        currentRev: e.currentRev,
        ...(historicalBase !== null ? { baseMarkdown: historicalBase } : {}),
      };
    }
    if (isNotFound(e)) return { status: "not-found" };
    throw e;
  }
}

/** The 409 body, byte for byte, for whichever route produced the conflict. */
export function pageWriteConflictResponse(
  outcome: Extract<PageWriteOutcome, { status: "conflict" }>,
): NextResponse {
  return NextResponse.json(
    {
      error: "conflict",
      currentRev: outcome.currentRev,
      ...(outcome.baseMarkdown !== undefined
        ? { baseMarkdown: outcome.baseMarkdown }
        : {}),
    },
    { status: 409 },
  );
}
