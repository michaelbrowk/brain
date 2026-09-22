import { NextRequest, NextResponse } from "next/server";
import { readModules, setModules } from "@/lib/owner-settings";
import { emitStore } from "@/lib/store/events";

/** THE OWNER'S MODULE SWITCHES. Human session authentication is enforced by
 *  proxy.ts, which also owns the 409 these switches produce on the modules'
 *  own routes. Nothing here reads a note: the switches live beside the zone
 *  in the state directory, because they are a property of this instance. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

const KEYS = ["mail", "tasks"] as const;

export async function GET() {
  return NextResponse.json(await readModules(), { headers: HEADERS });
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
  const held = body as Record<string, unknown>;
  const patch: { mail?: boolean; tasks?: boolean } = {};
  for (const key of KEYS) {
    if (!(key in held)) continue;
    if (typeof held[key] !== "boolean") return badModules();
    patch[key] = held[key] as boolean;
  }
  // A body naming nothing this route owns is a client bug, not a no-op: it
  // would answer 200 with the state unchanged and the caller would believe
  // its switch landed.
  if (Object.keys(patch).length === 0) return badModules();

  const { modules, changed } = await setModules(patch);
  // The event carries the pair, so a tab re-renders without a second request.
  // Only on a real change: a no-op would take a slot in the 256-entry SSE
  // replay journal for a state nobody moved.
  if (changed) emitStore({ type: "modules", id: "modules", modules });
  return NextResponse.json(modules, { headers: HEADERS });
}

function badModules() {
  return NextResponse.json(
    {
      error: "bad_modules",
      reason: "a module switch takes true or false, and names mail or tasks",
    },
    { status: 400, headers: HEADERS },
  );
}
