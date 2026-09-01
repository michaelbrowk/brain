import { NextRequest, NextResponse } from "next/server";
import { getStore, isNotFound, redactPageMeta } from "@/lib/store";

export const dynamic = "force-dynamic";

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface MoveBody {
  id: string;
  newParentId: string | null;
  beforeId: string | null;
}

function parseBody(value: unknown): MoveBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const validOptionalId = (id: unknown) =>
    id === null || (typeof id === "string" && PAGE_ID_RE.test(id));
  const newParentId = body.newParentId ?? null;
  const beforeId = body.beforeId ?? null;
  if (
    typeof body.id !== "string" ||
    !PAGE_ID_RE.test(body.id) ||
    !validOptionalId(newParentId) ||
    !validOptionalId(beforeId)
  ) {
    return null;
  }
  return {
    id: body.id,
    newParentId: newParentId as string | null,
    beforeId: beforeId as string | null,
  };
}

// reparent + reorder a page
export async function POST(req: NextRequest) {
  let body: MoveBody | null;
  try {
    body = parseBody(await req.json());
  } catch {
    body = null;
  }
  if (!body) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    const store = await getStore();
    const moved = await store.movePageWithBodyReport(
      body.id,
      body.newParentId,
      body.beforeId,
      req.headers.get("x-brain-client") ?? undefined,
    );
    // `unlinkedFrom` is how the client knows the move edited a document and
    // not only the tree, so it can say so instead of changing a page silently.
    return NextResponse.json({
      ...redactPageMeta(moved.meta),
      unlinkedFrom: moved.unlinkedFrom,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "move failed" }, { status: 500 });
  }
}
