import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** List trashed pages (roots of deleted subtrees). */
export async function GET() {
  const store = await getStore();
  return NextResponse.json({ trash: store.trashList() });
}

/** Empty the trash — permanent. */
export async function DELETE() {
  const store = await getStore();
  await store.emptyTrash();
  return NextResponse.json({ ok: true });
}
