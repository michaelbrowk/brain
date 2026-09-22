import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { getStore, isNotFound, isRevConflict } from "@/lib/store";
import { appWriteClient } from "@/lib/apps/write-authority";
import { APP_ENTRY_MAX_BYTES } from "@/lib/apps/model";
import { logAppBridgeWrite } from "../../../activity";

export const dynamic = "force-dynamic";

/** THE ONE DOOR AN APP'S WRITE GOES THROUGH.
 *
 *  The frame has an opaque origin and no cookies, so it cannot call
 *  `/api/page/<id>` itself; the host relays, and this is where the relay
 *  lands. Three things happen here and nowhere else.
 *
 *  The authority is checked against the live index (`appMayWrite`), never
 *  against anything the frame said: a page in `owns` that has since moved out
 *  of the app's subtree or into the trash stops being writable the moment it
 *  does.
 *
 *  A rev is required. "Omit to force" is a door `write_page` opens for an
 *  agent that can read the conflict and decide; an app running in a loop has
 *  no such judgement, and a forced write from one is how a person's edit
 *  disappears.
 *
 *  A line is written whatever the outcome, the way `pageWrite` in
 *  `app/api/mcp/route.ts` writes one: an app that cannot change the notebook
 *  silently is the whole point of the bridge. */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; target: string }> },
) {
  const { id, target } = await params;
  if (!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value))) {
    return NextResponse.json(
      { error: "sign in first", reason: "not_found" },
      { status: 401 },
    );
  }

  const store = await getStore();
  const app = store.readAppMeta(id);
  if (app === null) {
    return NextResponse.json(
      { error: "that page is not an app", reason: "not_found" },
      { status: 404 },
    );
  }

  // The app's own title, off the index the authority check already reads.
  // A `store.readPage(id)` here would be a file read and a parse on the hot
  // path of an app answering a card, for a string that is already in memory.
  // `readPageLabel` is the synchronous index reader the share surfaces use.
  const client = appWriteClient(store.readPageLabel(id)?.title ?? "");
  const line = (outcome: string, label?: string) =>
    logAppBridgeWrite({
      client,
      tool: "write_page",
      change: "markdown",
      page: target,
      outcome,
      ...(label === undefined ? {} : { label }),
    });

  const body = (await req.json().catch(() => null)) as
    | { markdown?: unknown; rev?: unknown }
    | null;
  if (typeof body?.markdown !== "string" || typeof body.rev !== "string") {
    await line("bad_request");
    return NextResponse.json(
      { error: "a write needs markdown and the rev it replaces", reason: "bad_request" },
      { status: 400 },
    );
  }
  // The same ceiling the entry takes. A page an app writes is a page, and a
  // two-megabyte one is a runaway loop rather than a note.
  if (Buffer.byteLength(body.markdown, "utf8") > APP_ENTRY_MAX_BYTES) {
    await line("too_large");
    return NextResponse.json(
      { error: "that page is too large to write", reason: "too_large" },
      { status: 413 },
    );
  }

  if (!store.appMayWrite(id, target)) {
    await line("not_owned");
    return NextResponse.json(
      { error: "that page is not this app's to write", reason: "not_owned" },
      { status: 403 },
    );
  }

  try {
    const written = await store.writePage(
      target,
      body.markdown,
      body.rev,
      "claude",
      undefined,
      undefined,
    );
    await line("ok", written.meta.title);
    return NextResponse.json({ rev: written.rev });
  } catch (error) {
    if (isRevConflict(error)) {
      await line("rev_conflict");
      return NextResponse.json(
        {
          error: "that page changed since the app read it",
          reason: "rev_conflict",
          currentRev: error.currentRev,
        },
        { status: 409 },
      );
    }
    if (isNotFound(error)) {
      await line("not_found");
      return NextResponse.json(
        { error: "that page is not there", reason: "not_found" },
        { status: 404 },
      );
    }
    await line("store_failed");
    return NextResponse.json(
      { error: "the notes folder could not answer", reason: "store_failed" },
      { status: 500 },
    );
  }
}
