import { NextResponse } from "next/server";
import { deviceView, parsePushSubscription, pushSubscriptionId } from "@/lib/push/model";
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

/** THE ENDPOINT THIS REGISTRATION REPLACES, as a row id.
 *
 *  `pushsubscriptionchange` gives the worker the subscription the browser is
 *  retiring, and the worker sends its endpoint here so the row goes with it.
 *  It is read to the same bounds as the endpoint it names and it is never a
 *  refusal: a body this cannot read is an ordinary registration, because a
 *  device whose endpoint has gone must not also be refused a new one. */
function previousRowId(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  if (!value.startsWith("https://")) return null;
  return pushSubscriptionId(value);
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
  const previous = previousRowId(body.previousEndpoint);
  return NextResponse.json(
    { device: deviceView(await savePushSubscription(record, undefined, previous)) },
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
