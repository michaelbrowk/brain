import { NextResponse } from "next/server";
import { readVapidKeys } from "@/lib/push/store";

/** The public half of the VAPID pair, which the browser bakes into the
 *  PushSubscription it creates. The private half never leaves the state
 *  directory and is never in a response, a log or the repository. */
export const dynamic = "force-dynamic";

export async function GET() {
  const { publicKey } = await readVapidKeys();
  return NextResponse.json({ publicKey });
}
