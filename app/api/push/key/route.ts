import { NextResponse } from "next/server";
import { readVapidKeys } from "@/lib/push/store";

/** The public half of the VAPID pair, which the browser bakes into the
 *  PushSubscription it creates. The private half never leaves the state
 *  directory and is never in a response, a log or the repository.
 *
 *  Human session authentication is enforced by proxy.ts, which exempts no path
 *  under /api/push. The store reads a file, so this is the Node runtime. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The house header on a private route. This key names one instance and must
// not sit in a shared cache.
const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  const { publicKey } = await readVapidKeys();
  return NextResponse.json({ publicKey }, { headers: HEADERS });
}
