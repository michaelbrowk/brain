import { NextResponse } from "next/server";
import { NOTIFICATION_CAP } from "@/lib/notifications/model";
import { markNotificationsRead } from "@/lib/notifications/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_body" },
      { status: 400, headers: HEADERS },
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { error: "bad_body" },
      { status: 400, headers: HEADERS },
    );
  }
  const ids = (body as { ids?: unknown }).ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > NOTIFICATION_CAP ||
    ids.some((id) => typeof id !== "string")
  ) {
    return NextResponse.json(
      {
        error: "bad_ids",
        reason: `ids must be one to ${NOTIFICATION_CAP} notification ids`,
      },
      { status: 400, headers: HEADERS },
    );
  }
  // An id the centre does not hold is answered with a count of zero and not a
  // 404: Mail marks a thread read without knowing whether a notification for
  // it was ever produced, and a refusal there would be noise on a healthy path.
  const read = await markNotificationsRead(ids as string[], new Date().toISOString());
  return NextResponse.json({ read }, { headers: HEADERS });
}
