import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Restore a trashed page (and its subtree) back into the tree. */
export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const store = await getStore();
  try {
    await store.restorePage(id, req.headers.get("x-brain-client") ?? undefined);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

/** Permanently remove a trashed page. */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const store = await getStore();
  try {
    await store.purgePage(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
