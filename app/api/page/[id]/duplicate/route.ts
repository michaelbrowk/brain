import { NextRequest, NextResponse } from "next/server";
import { getStore, isNotFound } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const store = await getStore();
    return NextResponse.json(await store.duplicatePage(id));
  } catch (e) {
    if (isNotFound(e))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
