import { NextResponse } from "next/server";
import { sendPush } from "@/lib/push/send";

/** "Send a test" in Settings. It goes out as a task reminder, because that is
 *  the kind a person turned push on for, and it obeys that kind's toggle: a
 *  test that ignored the switch would prove the wrong thing.
 *
 *  Human session authentication is enforced by proxy.ts, which exempts no path
 *  under /api/push. The sender reads the state directory, so this is the Node
 *  runtime. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The house header on a private route. What this answers describes one
// owner's devices.
const HEADERS = { "Cache-Control": "private, no-store" };

export async function POST() {
  const result = await sendPush("task-reminder", {
    title: "Brain",
    body: "Notifications are working on this device.",
    href: "/tasks",
  });
  return NextResponse.json(result, { headers: HEADERS });
}
