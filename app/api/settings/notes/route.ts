import { NextResponse } from "next/server";
import { readNotesStatus } from "@/lib/notes-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

/** Owner-only notes facts. Human session authentication is enforced by proxy.ts. */
export async function GET() {
  try {
    return NextResponse.json(await readNotesStatus(), { headers: HEADERS });
  } catch {
    return NextResponse.json({ error: "notes status unavailable" }, { status: 503, headers: HEADERS });
  }
}
