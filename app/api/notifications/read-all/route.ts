import { NextResponse } from "next/server";
import { markAllNotificationsRead } from "@/lib/notifications/store";

/** Clears the CENTRE and nothing else. A `mail-new` row's thread stays
 *  unread: one press would otherwise loop an unbounded number of thread
 *  mutations at a service that can stop answering mid-run, with no undo. A
 *  single row marked read does mark its thread read, which is exact and
 *  reversible. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

export async function POST() {
  return NextResponse.json(
    { read: await markAllNotificationsRead(new Date().toISOString()) },
    { headers: HEADERS },
  );
}
