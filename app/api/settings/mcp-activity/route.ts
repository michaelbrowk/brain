import { NextResponse } from "next/server";
import { clearMcpActivity, readMcpActivity } from "@/lib/mcp/activity-log";

export const dynamic = "force-dynamic";

/** What agents changed through MCP, for the settings pane. Owner-only for the
 *  same reason the sibling MCP route is: `proxy.ts` walls every `/api/*` path
 *  with no earlier exemption, and this one has none.
 *
 *  The log holds 2000 lines. Fifty is what a person reads in one pass, and
 *  the answer is newest first, so the last thing an agent did is the first
 *  line on the screen. */
const SHOWN = 50;

export async function GET() {
  return NextResponse.json({ entries: await readMcpActivity(SHOWN) });
}

export async function DELETE() {
  try {
    await clearMcpActivity();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "couldn't clear the agent activity log" }, { status: 500 });
  }
}
