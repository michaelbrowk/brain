import { NextResponse } from "next/server";
import { readBackupStatus } from "@/lib/backup-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "private, no-store",
};

/** Owner-only backup facts. Human session authentication is enforced by proxy.ts. */
export async function GET() {
  try {
    return NextResponse.json(await readBackupStatus(), {
      headers: HEADERS,
    });
  } catch {
    return NextResponse.json(
      { error: "backup details unavailable" },
      { status: 503, headers: HEADERS },
    );
  }
}
