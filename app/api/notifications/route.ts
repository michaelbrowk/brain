import { NextResponse } from "next/server";
import { listNotifications } from "@/lib/notifications/store";

/** The centre, whole. It is capped at two hundred rows of each kind, so there
 *  is no page cursor and no filter: one request answers the bell, the badge and
 *  the list at one instant, which is what keeps the count and the rows from
 *  disagreeing.
 *
 *  Human session authentication is enforced by proxy.ts, which exempts no path
 *  under /api/notifications. The store reads a file, so this is the Node
 *  runtime. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The house header on a private route. A bell answer is per-reader state and
// must not sit in a shared cache.
const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  const notifications = await listNotifications();
  return NextResponse.json(
    {
      notifications,
      unread: notifications.filter((row) => row.readAt === undefined).length,
    },
    { headers: HEADERS },
  );
}
