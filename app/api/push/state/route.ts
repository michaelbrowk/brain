import { NextResponse } from "next/server";
import { PUSH_KINDS, deviceView, type PushKindPreferences } from "@/lib/push/model";
import { listPushSubscriptions, readPushKinds, writePushKinds } from "@/lib/push/store";

/** What Settings draws: the devices by label, and the two toggles. No
 *  endpoint reaches the browser.
 *
 *  Human session authentication is enforced by proxy.ts, which exempts no path
 *  under /api/push. The store reads a file, so this is the Node runtime. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The house header on a private route. Device labels and notification
// preferences are per-owner state and must not sit in a shared cache.
const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  const [records, kinds] = await Promise.all([listPushSubscriptions(), readPushKinds()]);
  return NextResponse.json({ devices: records.map(deviceView), kinds }, { headers: HEADERS });
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400, headers: HEADERS });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_body" }, { status: 400, headers: HEADERS });
  }
  const kinds = (body as { kinds?: unknown }).kinds;
  if (typeof kinds !== "object" || kinds === null || Array.isArray(kinds)) {
    return NextResponse.json({ error: "bad_kinds" }, { status: 400, headers: HEADERS });
  }
  const patch: Partial<PushKindPreferences> = {};
  for (const [key, value] of Object.entries(kinds)) {
    if (!(PUSH_KINDS as readonly string[]).includes(key) || typeof value !== "boolean") {
      return NextResponse.json({ error: "bad_kinds" }, { status: 400, headers: HEADERS });
    }
    patch[key as keyof PushKindPreferences] = value;
  }
  return NextResponse.json({ kinds: await writePushKinds(patch) }, { headers: HEADERS });
}
