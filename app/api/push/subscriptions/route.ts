import { NextResponse } from "next/server";
import { deviceView, parsePushSubscription } from "@/lib/push/model";
import { removePushSubscription, savePushSubscription } from "@/lib/push/store";

/** A device registers here and is removed here. The endpoint arrives in a
 *  body and never in a URL: a push endpoint is a capability, and a path is
 *  logged by every proxy in front of it.
 *
 *  Human session authentication is enforced by proxy.ts, which exempts no path
 *  under /api/push. The store writes a file, so this is the Node runtime. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The house header on a private route. A device list is per-owner state.
const HEADERS = { "Cache-Control": "private, no-store" };

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const body = await readBody(req);
  if (!body) {
    return NextResponse.json({ error: "bad_subscription" }, { status: 400, headers: HEADERS });
  }
  const record = parsePushSubscription({ ...body, at: new Date().toISOString() });
  if (!record) {
    return NextResponse.json({ error: "bad_subscription" }, { status: 400, headers: HEADERS });
  }
  return NextResponse.json(
    { device: deviceView(await savePushSubscription(record)) },
    { status: 201, headers: HEADERS },
  );
}

export async function DELETE(req: Request) {
  const body = await readBody(req);
  const id = body?.id;
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400, headers: HEADERS });
  }
  return NextResponse.json({ removed: await removePushSubscription(id) }, { headers: HEADERS });
}
