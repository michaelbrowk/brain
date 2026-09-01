import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Version history (git commits) of a page. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const store = await getStore();
  try {
    return NextResponse.json({ history: await store.history(id) });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
