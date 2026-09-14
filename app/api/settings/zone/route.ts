import { NextRequest, NextResponse } from "next/server";
import { isTimeZone, readTimeZone, setTimeZone } from "@/lib/owner-settings";

/** The owner's own zone. Human session authentication is enforced by proxy.ts.
 *  Nothing here reads a clock; it reads and writes one name. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

export async function GET() {
  return NextResponse.json({ timeZone: await readTimeZone() }, { headers: HEADERS });
}

export async function PUT(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400, headers: HEADERS });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "bad_body" }, { status: 400, headers: HEADERS });
  }
  const zone = (body as { timeZone?: unknown }).timeZone;
  if (!isTimeZone(zone)) {
    return NextResponse.json(
      { error: "bad_zone", reason: "that is not a zone this machine knows" },
      { status: 400, headers: HEADERS },
    );
  }
  await setTimeZone(zone);
  return NextResponse.json({ timeZone: zone }, { headers: HEADERS });
}
