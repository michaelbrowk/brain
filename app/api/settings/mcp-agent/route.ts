import { NextResponse } from "next/server";
import {
  readAgentSettingsState,
  writeAgentSettings,
} from "@/lib/mcp/agent-settings";
import { readBoundedText } from "@/lib/oauth/http";

export const dynamic = "force-dynamic";

/** The two switches the owner can throw without revoking a grant, for the
 *  settings pane. Reached only with a valid human session cookie: `proxy.ts`
 *  walls every `/api/*` path that is not exempted earlier, and this one is in
 *  no exemption. An agent never reaches this route; it reads the same file
 *  through `lib/mcp/agent-settings.ts`.
 *
 *  Two booleans is the whole body, so the bound is 256 bytes: enough for the
 *  object with room to spare, small enough that a client sending something
 *  else is refused before it is parsed. */
const MAX_BODY_BYTES = 256;

export async function GET() {
  // `unreadable` travels with the two switches because the screen has to say
  // the same thing the tools do. A settings file this process cannot read
  // makes `send_mail` and `reply_mail` refuse, and the screen used to draw
  // the on-by-default beside that refusal.
  const state = await readAgentSettingsState();
  return NextResponse.json({ ...state.settings, unreadable: state.unreadable });
}

export async function PUT(request: Request) {
  try {
    const body: unknown = JSON.parse(await readBoundedText(request, MAX_BODY_BYTES));
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("tellRecipients" in body) ||
      !("allowSending" in body) ||
      typeof body.tellRecipients !== "boolean" ||
      typeof body.allowSending !== "boolean"
    ) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    // A write leaves a file this process just wrote, so nothing is unreadable
    // from here on and the screen can stop saying so.
    return NextResponse.json({
      ...(await writeAgentSettings({
        tellRecipients: body.tellRecipients,
        allowSending: body.allowSending,
      })),
      unreadable: false,
    });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
