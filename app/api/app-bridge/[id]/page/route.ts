import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { getStore, isAppOwnsFull, isNotFound } from "@/lib/store";
import { appWriteClient } from "@/lib/apps/write-authority";
import { APP_ENTRY_MAX_BYTES } from "@/lib/apps/model";
import { logAppBridgeWrite } from "../../activity";

export const dynamic = "force-dynamic";

/** The longest icon the page head draws. Anything longer is a caller sending
 *  something that is not an emoji, and it is dropped rather than refused: the
 *  page is still the page the app asked for. */
const MAX_ICON_CHARS = 16;

/** THE PARENT IS NOT AN ARGUMENT.
 *
 *  Spec §4 lets an app create only under itself, so the parent is the app's
 *  own id and a `parentId` in the body is ignored rather than refused: a
 *  refusal would teach an app that the field exists somewhere.
 *
 *  Everything else about this route is the write route's shape beside it: the
 *  owner's session, the live `app` map off the index, and one activity line
 *  whatever the outcome. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await verifySession(req.cookies.get(SESSION_COOKIE)?.value))) {
    return NextResponse.json(
      { error: "sign in first", reason: "not_found" },
      { status: 401 },
    );
  }

  const store = await getStore();
  if (store.readAppMeta(id) === null) {
    return NextResponse.json(
      { error: "that page is not an app", reason: "not_found" },
      { status: 404 },
    );
  }

  const client = appWriteClient(store.readPageLabel(id)?.title ?? "");
  const line = (outcome: string, page?: string, label?: string) =>
    logAppBridgeWrite({
      client,
      tool: "create_page",
      change: "create",
      outcome,
      ...(page === undefined ? {} : { page }),
      ...(label === undefined ? {} : { label }),
    });

  const body = (await req.json().catch(() => null)) as
    | { title?: unknown; icon?: unknown; markdown?: unknown }
    | null;
  const title = typeof body?.title === "string" ? body.title.replace(/\s+/g, " ").trim() : "";
  if (title.length === 0) {
    await line("bad_request");
    return NextResponse.json(
      { error: "a new page needs a title", reason: "bad_request" },
      { status: 400 },
    );
  }

  // The same ceiling the write route takes, for the same reason: a page an app
  // creates is a page, and a two-megabyte one is a runaway loop rather than a
  // note. The bridge schema refuses it in the frame as well, which is the
  // convenience; this is the authority.
  const markdown = typeof body?.markdown === "string" ? body.markdown : "";
  if (Buffer.byteLength(markdown, "utf8") > APP_ENTRY_MAX_BYTES) {
    await line("too_large");
    return NextResponse.json(
      { error: "that page is too large to write", reason: "too_large" },
      { status: 413 },
    );
  }

  try {
    /** THE PAGE AND THE OWNERSHIP ARE ONE WRITE, AND THE STORE OWNS BOTH.
     *
     *  A page the app cannot then write is worse than no page: the app would
     *  create it again on the next run, and again. `createOwnedPage` makes
     *  the child and appends to `owns` inside one mutation, re-reading the
     *  `app` map in there, so nothing this route read a moment ago is written
     *  back over a state write or a second create that has landed since. The
     *  cap is its decision too, for the same reason. */
    const { page } = await store.createOwnedPage(
      id,
      {
        title,
        ...(typeof body?.icon === "string" && body.icon.length <= MAX_ICON_CHARS
          ? { icon: body.icon }
          : {}),
        markdown,
      },
      "claude",
    );
    await line("ok", page.id, page.title);
    return NextResponse.json({ id: page.id });
  } catch (error) {
    if (isAppOwnsFull(error)) {
      await line("too_large");
      return NextResponse.json(
        { error: "that app already owns as many pages as it may", reason: "too_large" },
        { status: 413 },
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
