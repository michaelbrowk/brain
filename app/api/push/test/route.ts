import { NextResponse } from "next/server";
import { sendPush } from "@/lib/push/send";

/** "Send a test" in Settings. It goes out as a task reminder, because that is
 *  the kind a person turned push on for, and it obeys that kind's toggle: a
 *  test that ignored the switch would prove the wrong thing. */
export const dynamic = "force-dynamic";

export async function POST() {
  const result = await sendPush("task-reminder", {
    title: "Brain",
    body: "Notifications are working on this device.",
    href: "/tasks",
  });
  return NextResponse.json(result);
}
