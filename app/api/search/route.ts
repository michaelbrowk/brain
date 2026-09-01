import { NextRequest, NextResponse } from "next/server";
import { searchNotes } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  if (q.length > 512) {
    return NextResponse.json(
      { error: "invalid_query" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ hits: await searchNotes(q) });
  } catch (error) {
    console.error("Full-text search unavailable", error);
    return NextResponse.json(
      { error: "search_unavailable" },
      { status: 503 },
    );
  }
}
