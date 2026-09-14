import { NextResponse } from "next/server";
import { PUSH_KINDS, deviceView, type PushKindPreferences } from "@/lib/push/model";
import { listPushSubscriptions, readPushKinds, writePushKinds } from "@/lib/push/store";

/** What Settings draws: the devices by label, and the two toggles. No
 *  endpoint reaches the browser. */
export const dynamic = "force-dynamic";

export async function GET() {
  const [records, kinds] = await Promise.all([listPushSubscriptions(), readPushKinds()]);
  return NextResponse.json({ devices: records.map(deviceView), kinds });
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const kinds = (body as { kinds?: unknown }).kinds;
  if (typeof kinds !== "object" || kinds === null || Array.isArray(kinds)) {
    return NextResponse.json({ error: "bad_kinds" }, { status: 400 });
  }
  const patch: Partial<PushKindPreferences> = {};
  for (const [key, value] of Object.entries(kinds)) {
    if (!(PUSH_KINDS as readonly string[]).includes(key) || typeof value !== "boolean") {
      return NextResponse.json({ error: "bad_kinds" }, { status: 400 });
    }
    patch[key as keyof PushKindPreferences] = value;
  }
  return NextResponse.json({ kinds: await writePushKinds(patch) });
}
