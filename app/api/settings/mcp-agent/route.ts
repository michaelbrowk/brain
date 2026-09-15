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

const SWITCHES = ["tellRecipients", "allowSending"] as const;

/** ONE SWITCH IS ONE FIELD.
 *
 *  A body names the switch the owner threw and nothing else. It used to have
 *  to carry both, which made the screen send a value it was only standing in
 *  for: with the settings file unreadable the reader answers the documented
 *  defaults, so flipping "Tell recipients" wrote `allowSending: true` back and
 *  turned sending on again, with no toast and no row saying so.
 *
 *  A body naming neither switch is refused rather than written as a no-op: it
 *  is a client that meant something this route cannot tell. */
export async function PUT(request: Request) {
  try {
    const body: unknown = JSON.parse(await readBoundedText(request, MAX_BODY_BYTES));
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const named = Object.keys(body);
    const known: readonly string[] = SWITCHES;
    if (
      named.length === 0 ||
      named.some((key) => !known.includes(key)) ||
      SWITCHES.some(
        (key) => key in body && typeof (body as Record<string, unknown>)[key] !== "boolean",
      )
    ) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    const patch = body as Partial<Record<(typeof SWITCHES)[number], boolean>>;
    const state = await readAgentSettingsState();
    // THE BASE IS WHAT THE TOOLS ARE DOING, NOT WHAT THE FILE SAYS. An
    // unreadable file already refuses every agent send, so that is the value a
    // write naming the other switch preserves; taking the reader's
    // on-by-default here would be the same resurrection in one fewer place.
    const base = {
      ...state.settings,
      ...(state.unreadable ? { allowSending: false } : {}),
    };
    // A write leaves a file this process has written, so nothing is
    // unreadable from here on and the screen can stop saying so.
    return NextResponse.json({
      ...(await writeAgentSettings({ ...base, ...patch })),
      unreadable: false,
    });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
