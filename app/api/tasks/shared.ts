import { NextRequest, NextResponse } from "next/server";
import type { ListName, TaskAnchor, TaskRepeat } from "@/lib/store";
// The id rule comes from the module that owns it rather than the store's
// barrel, so validating an id never depends on the Store being reachable.
import { TASK_ID_RE } from "@/lib/tasks/model";

/** What the two task route files share: the query contract, the field
 *  allowlists and the one error shape. Nothing here reads a clock. */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const LIST_NAMES = [
  "inbox",
  "today",
  "upcoming",
  "someday",
  "logbook",
] as const;

export function isListName(value: string): value is ListName {
  return (LIST_NAMES as readonly string[]).includes(value);
}

export function isDay(value: string | null): value is string {
  return value !== null && DAY_RE.test(value);
}

/** Real UTC offsets run from -12:00 to +14:00. */
const MAX_OFFSET_MINUTES = 840;

/** The reader's own UTC offset in minutes, east positive, as
 *  `-new Date().getTimezoneOffset()` gives it. `null` when the query has
 *  none, `undefined` when it has one this is not. */
export function readOffset(value: string | null): number | null | undefined {
  if (value === null) return null;
  // Digits and an optional sign, because `Number("")` is 0 and an empty
  // parameter is a client that failed to compute one, not a reader in UTC.
  if (!/^-?\d{1,4}$/.test(value)) return undefined;
  const minutes = Number(value);
  return Math.abs(minutes) > MAX_OFFSET_MINUTES ? undefined : minutes;
}

/** A read that can return a completed task needs the offset, because `doneAt`
 *  is a UTC instant and the Logbook day it falls on is the reader's. */
export function readsLogbook(list: string | null): boolean {
  return list === null || list === "logbook";
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

/** The instance moved between the row being drawn and the tick reaching the
 *  store. Nothing about the request is malformed, so it is a 409 and not a
 *  400, and it carries where the task actually stands so a client can re-read
 *  without a second round trip. */
export function conflict(error: string, currentWhen: string | undefined): NextResponse {
  return NextResponse.json(
    { error, reason: "when_moved", ...(currentWhen !== undefined ? { currentWhen } : {}) },
    { status: 409 },
  );
}

export function notFound(): NextResponse {
  // The same body for a task that never existed and one the caller may not
  // name, so a 404 says nothing about what is on disk.
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export function assertTaskId(id: string): boolean {
  return TASK_ID_RE.test(id);
}

/** A page id is bounded the same way a task id is (`app/api/move/route.ts`),
 *  so no query string can name a path. It reaches no `path.join` here, and it
 *  is still checked: an id this rule refuses can only be a caller mistake, and
 *  answering it with an empty list would hide that. */
export function isPageId(value: string): boolean {
  return TASK_ID_RE.test(value);
}

/** Originating client id, threaded into the store event so the writer's own
 *  SSE echo can be ignored client-side. */
export function clientId(req: NextRequest): string | undefined {
  return req.headers.get("x-brain-client") ?? undefined;
}

/** `today` and `offset` are taken only where a list is derived. Anywhere else
 *  they are a caller mistake worth an answer rather than a value to ignore. */
export function refuseListQuery(req: NextRequest): NextResponse | null {
  const params = req.nextUrl.searchParams;
  if (params.has("today")) return badRequest("unexpected_today");
  if (params.has("offset")) return badRequest("unexpected_offset");
  return null;
}

/** `?page=` is a lookup of one note's records and derives no list, so the
 *  reader's day and offset have nothing to do here, and a `list` or `category`
 *  would narrow an answer that has to be complete: the editor draws a word on
 *  every task line of the page, whatever state its record is in. */
export function refusePageQuery(params: URLSearchParams): NextResponse | null {
  if (params.has("today")) return badRequest("unexpected_today");
  if (params.has("offset")) return badRequest("unexpected_offset");
  if (params.has("list")) return badRequest("unexpected_list");
  if (params.has("category")) return badRequest("unexpected_category");
  return null;
}

export async function readJsonObject(
  req: NextRequest,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The create surface. Every value is still untrusted here: the store parses
 *  the whole record with the zod schema and answers a 400 with the reason. */
export interface CreateBody {
  title: string;
  when?: string;
  deadline?: string;
  category?: string;
  page?: string;
  anchor?: TaskAnchor;
  repeat?: TaskRepeat;
}

/** The patch surface. `page` and `anchor` are not on it: a task is linked by
 *  promoting a line, never by a caller naming a page. */
export const PATCH_FIELDS = [
  "title",
  "when",
  "deadline",
  "category",
  "repeat",
  "done",
  "expectedWhen",
] as const;

export interface PatchBody {
  title?: string;
  when?: string | null;
  deadline?: string | null;
  category?: string | null;
  repeat?: TaskRepeat | null;
  done?: boolean;
  /** Not a field to set: the `when` of the instance the caller was looking at,
   *  which a repeating task's completion is refused against when the record
   *  has moved since. `null` for an instance filed under no day. */
  expectedWhen?: string | null;
}
