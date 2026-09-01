import { NextRequest, NextResponse } from "next/server";
import { smartSort } from "@/lib/smart-sort";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Preview only — proposes a grouping, writes nothing. */
export async function POST(req: NextRequest) {
  const { parentId } = await req.json();
  if (!parentId) return NextResponse.json({ error: "parentId required" }, { status: 400 });
  try {
    return NextResponse.json(await smartSort(parentId));
  } catch {
    return NextResponse.json({ error: "smart sort unavailable" }, { status: 503 });
  }
}
