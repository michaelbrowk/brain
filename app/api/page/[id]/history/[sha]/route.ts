import { NextRequest, NextResponse } from "next/server";
import { getStore, isNotFound, isRevConflict } from "@/lib/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; sha: string }> };

/** Preview: the page's markdown at a past commit. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id, sha } = await params;
  const store = await getStore();
  const markdown = await store.markdownAt(id, sha);
  if (markdown === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ markdown });
}

/** Restore: roll the page body back to this version. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id, sha } = await params;
  let rev: unknown;
  try {
    ({ rev } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof rev !== "string" || !rev) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const store = await getStore();
  try {
    const page = await store.restoreVersion(
      id,
      sha,
      rev,
      req.headers.get("x-brain-client") ?? undefined,
    );
    return NextResponse.json({ ok: true, rev: page.rev });
  } catch (error) {
    if (isRevConflict(error)) {
      return NextResponse.json(
        { error: "conflict", currentRev: error.currentRev },
        { status: 409 },
      );
    }
    if (!isNotFound(error)) throw error;
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
