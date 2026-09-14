import { NextRequest, NextResponse } from "next/server";
import { captureTimeZone } from "@/lib/owner-settings";
import { getStore, isTaskValidation } from "@/lib/store";
import {
  badRequest,
  clientId,
  isDay,
  isListName,
  isPageId,
  readJsonObject,
  readOffset,
  readsLogbook,
  refuseListQuery,
  refusePageQuery,
  type CreateBody,
} from "./shared";

/** The tasks collection.
 *
 *  Every list read takes the caller's own local calendar date as `?today=`.
 *  There is no default and no fallback: a date from the server's clock flips
 *  the list at 03:00 in Moscow and a day early in Dubai. Nothing in this file
 *  reads a clock.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  // ONE PAGE'S RECORDS, which is a lookup and not a list.
  //
  // The note editor draws a word on every task line it owns, and it has to
  // find the record behind a line whatever state that record is in: done,
  // detached, or completed longer ago than the Logbook window holds. A list
  // read answers none of those, and a line whose record it could not find
  // offers "+ Task" again and is promoted twice.
  const page = params.get("page");
  if (page !== null) {
    if (!isPageId(page)) return badRequest("bad_page");
    const refused = refusePageQuery(params);
    if (refused) return refused;
    const store = await getStore();
    return NextResponse.json({ tasks: store.pageTasks(page) });
  }

  const today = params.get("today");
  if (!isDay(today)) return badRequest("bad_today");

  const list = params.get("list");
  if (list !== null && !isListName(list)) return badRequest("bad_list");

  const offsetMinutes = readOffset(params.get("offset"));
  if (offsetMinutes === undefined) return badRequest("bad_offset");
  if (offsetMinutes === null && readsLogbook(list)) {
    return badRequest("bad_offset");
  }

  // THE ZONE, CAPTURED ONCE. A reminder fires from a timer with no request to
  // read, so the zone cannot come from a header at the moment it is needed.
  // The client offers its own with every list request and the server keeps the
  // first one; a device in another zone does not change it. A name the
  // platform does not know is dropped in silence, because the list is what the
  // caller asked for and a refusal here would take a working screen away over
  // a setting nobody asked to change.
  const zone = params.get("zone");
  if (zone !== null) await captureTimeZone(zone);

  const category = params.get("category");

  const store = await getStore();
  // THE LOGBOOK IS ENTRIES, NOT RECORDS. A repeating task finished on seven
  // days is seven rows of ONE record, so a list of records hands a caller
  // seven objects with the same `id` and nothing to tell them apart but a
  // timestamp. Each entry carries its own stable key instead, and whether an
  // untick is offered on it.
  if (list === "logbook") {
    const entries = store.listLogbook(today, {
      offsetMinutes: offsetMinutes as number,
      ...(category !== null ? { category } : {}),
    });
    return NextResponse.json({ entries });
  }
  const tasks = store.listTasks(today, {
    ...(list !== null ? { list } : {}),
    ...(category !== null ? { category } : {}),
    ...(offsetMinutes !== null ? { offsetMinutes } : {}),
  });
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const refused = refuseListQuery(req);
  if (refused) return refused;

  const body = await readJsonObject(req);
  if (!body) return badRequest("bad_body");
  // The id is the store's to mint. Taking one from a caller would let a
  // request name the file it lands in.
  if ("id" in body) return badRequest("id_is_minted");
  if (typeof body.title !== "string") return badRequest("bad_title");

  const input = body as unknown as CreateBody;
  const store = await getStore();
  try {
    const task = await store.createTask({
      title: input.title,
      ...(input.when !== undefined ? { when: input.when } : {}),
      ...(input.time !== undefined ? { time: input.time } : {}),
      ...(input.evening !== undefined ? { evening: input.evening } : {}),
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.page !== undefined ? { page: input.page } : {}),
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
      ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
      ...(clientId(req) !== undefined ? { src: clientId(req) } : {}),
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    if (isTaskValidation(error)) return badRequest(error.reason);
    throw error;
  }
}
