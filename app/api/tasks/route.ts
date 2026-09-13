import { NextRequest, NextResponse } from "next/server";
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

  const category = params.get("category");

  const store = await getStore();
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
