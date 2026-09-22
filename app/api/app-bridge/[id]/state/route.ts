import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { APP_STATE_MAX_BYTES } from "@/lib/apps/model";

export const dynamic = "force-dynamic";

/** WHY NOTHING IS LOGGED HERE.
 *
 *  A line per state write would be a line per card answered, and the log is
 *  the file a person opens to see what an agent DID to their notebook. The
 *  state is the app's own memory: nothing outside the app's folder changes,
 *  nothing another client reads moves, and the file is capped at 256 KiB. The
 *  writes that do change the notebook, a page in `owns` and a child created,
 *  are logged, and those are the two an owner asks about. */

/** The owner's session and the live `app` map, the same two questions the two
 *  write routes ask first. Both answers are 404 so a caller learns nothing
 *  from the difference between a page that is not an app and one that is not
 *  theirs. */
async function open(
  req: NextRequest,
  id: string,
): Promise<
  | { ok: true; store: Awaited<ReturnType<typeof getStore>> }
  | { ok: false; response: NextResponse }
> {
  if (!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value))) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "sign in first", reason: "not_found" },
        { status: 401 },
      ),
    };
  }
  const store = await getStore();
  if (store.readAppMeta(id) === null) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "that page is not an app", reason: "not_found" },
        { status: 404 },
      ),
    };
  }
  return { ok: true, store };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const opened = await open(req, id);
  if (!opened.ok) return opened.response;
  try {
    // `null` is the honest answer for an app that has never written any, and
    // it is what the frame reads as "start from nothing".
    return NextResponse.json({ state: (await opened.store.readAppState(id)) ?? null });
  } catch {
    return NextResponse.json(
      { error: "the notes folder could not answer", reason: "store_failed" },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const opened = await open(req, id);
  if (!opened.ok) return opened.response;

  const body = (await req.json().catch(() => null)) as { json?: unknown } | null;
  // The key has to be there. `{ }` with no payload would otherwise write the
  // string "undefined" over the app's memory, which is the one shape JSON has
  // no room for.
  if (body === null || typeof body !== "object" || !("json" in body)) {
    return NextResponse.json(
      { error: "a state write needs a json payload", reason: "bad_request" },
      { status: 400 },
    );
  }

  // Inside a try of its own: `req.json()` will parse a payload nested deeper
  // than `JSON.stringify` can walk, and the `RangeError` out of it would reach
  // Next as a bare 500 with no reason the app could branch on.
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(body.json);
  } catch {
    return NextResponse.json(
      { error: "that state is not something Brain can keep", reason: "bad_request" },
      { status: 400 },
    );
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > APP_STATE_MAX_BYTES) {
    return NextResponse.json(
      { error: "that state is too large to keep", reason: "too_large" },
      { status: 413 },
    );
  }

  try {
    // The flag rides with the file, inside the store's own mutation. A route
    // that wrote the file and then patched the frontmatter left a window where
    // a crash between the two puts a `state.json` on disk that `readAppState`
    // will not read.
    await opened.store.writeAppState(id, body.json);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "the notes folder could not answer", reason: "store_failed" },
      { status: 500 },
    );
  }
}
