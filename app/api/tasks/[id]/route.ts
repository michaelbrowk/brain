import { NextRequest, NextResponse } from "next/server";
import { getStore, isNotFound, isTaskConflict, isTaskValidation } from "@/lib/store";
import {
  PATCH_FIELDS,
  assertTaskId,
  badRequest,
  clientId,
  conflict,
  isDay,
  notFound,
  readJsonObject,
  refuseListQuery,
  refusePatchValues,
  type PatchBody,
} from "../shared";

/** One task record.
 *
 *  The id is checked against the task id rule before it reaches the store, so
 *  no caller string can name a file. Completion is a PATCH carrying
 *  `{ done: true }`, and it is the only patch that can touch a second file.
 *  Nothing in this file reads a clock.
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!assertTaskId(id)) return badRequest("bad_id");
  const refused = refuseListQuery(req);
  if (refused) return refused;

  const store = await getStore();
  const task = store.getTask(id);
  if (!task) return notFound();
  return NextResponse.json({ task });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!assertTaskId(id)) return badRequest("bad_id");

  // A patch derives no list, so the reader's offset has nothing to do here.
  if (req.nextUrl.searchParams.has("offset")) {
    return badRequest("unexpected_offset");
  }

  const today = req.nextUrl.searchParams.get("today");
  // Shape first, so a malformed date is answered before the store is reached.
  // Whether this patch may carry one at all is the store's rule, in one place.
  if (today !== null && !isDay(today)) return badRequest("bad_today");

  const body = await readJsonObject(req);
  if (!body) return badRequest("bad_body");
  const allowed: readonly string[] = PATCH_FIELDS;
  if (Object.keys(body).some((field) => !allowed.includes(field))) {
    return badRequest("unknown_field");
  }
  // And the VALUE behind each of those names, through the record's own field
  // parsers. A name on the list is permission to set the field, not proof that
  // what arrived is something the field can hold.
  const badValue = refusePatchValues(body);
  if (badValue) return badRequest(badValue);

  const patch = body as unknown as PatchBody;
  const store = await getStore();
  try {
    const task = await store.updateTask(id, {
      ...patch,
      ...(today !== null ? { today } : {}),
      src: clientId(req),
    });
    return NextResponse.json({ task });
  } catch (error) {
    if (isNotFound(error)) return notFound();
    // The instance moved between the row being drawn and the tick landing.
    // Not malformed, so not a 400: a 409 with where the task now stands.
    if (isTaskConflict(error)) return conflict(error.reason, error.currentWhen);
    if (isTaskValidation(error)) return badRequest(error.reason);
    throw error;
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!assertTaskId(id)) return badRequest("bad_id");
  const refused = refuseListQuery(req);
  if (refused) return refused;

  const store = await getStore();
  try {
    // The record goes and the line it pointed at stays. A deleted task never
    // deletes a line, in either direction.
    await store.deleteTask(id, clientId(req));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isNotFound(error)) return notFound();
    if (isTaskValidation(error)) return badRequest(error.reason);
    throw error;
  }
}
