import { z } from "zod";

/** THE CENTRE'S MODEL, GENERIC ON PURPOSE.
 *
 *  Four kinds. The shape carries nothing about a task, a letter or a tool
 *  call, so a backup failure joins later without a second store and without a
 *  migration: `agent-action` joined on exactly that promise and cost the enum
 *  one word.
 *
 *  Nothing here reads the clock, the filesystem or a Store.
 */

export const NOTIFICATION_KINDS = [
  "task-reminder",
  "task-missed",
  "mail-new",
  /** One mutation an agent made through MCP and the log line recorded as
   *  `ok` (`lib/notifications/agent-producer.ts`). */
  "agent-action",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** TWO HUNDRED ROWS OF EACH KIND, OLDEST OF THAT KIND DROPPED FIRST.
 *
 *  The bound is per kind and not over the file, because mail opens a new row
 *  every time the last one was read: a few busy days of letters are a few
 *  hundred rows, all newer than the reminders under them, and one shared bound
 *  let them evict the thing that wanted the reader at 13:00. A kind can now
 *  only ever push out its own.
 *
 *  The file is still read whole on every request, so it still has to stay a few
 *  hundred kilobytes: four kinds of two hundred is what bounds it. */
export const NOTIFICATION_KIND_CAP = 200;

/** Every kind at its own bound, which is the most the file can hold. Nothing
 *  trims to this figure — it is what trimming each kind adds up to — and the
 *  read route's bound on how many ids one request may mark read is the same
 *  number for the same reason: the whole centre, and no more. */
export const NOTIFICATION_CAP = NOTIFICATION_KIND_CAP * NOTIFICATION_KINDS.length;

/** An id is derived, never minted: the same reminder computed by two scans
 *  has to be one row, and the mail row carries the instant it opened. The
 *  charset is what those producers write plus the literal separators. */
export const NOTIFICATION_ID_RE = /^[A-Za-z0-9:_.@+-]{1,400}$/;

/** A path on this origin and nothing else. The service worker opens this
 *  value, so an absolute URL here would be an open redirect with a
 *  notification in front of it. A protocol-relative `//host` is a URL too. */
const HREF_RE = /^\/(?!\/)[A-Za-z0-9/_?=&:.,%+-]*$/;
const MAX_HREF = 300;

/** The same rule, for a producer building a path out of an id it was handed.
 *  It asks before it writes and falls back to the surface, so a row is never
 *  written and announced only for the schema to drop it at the next read. */
export function isNotificationHref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HREF &&
    HREF_RE.test(value)
  );
}

const hrefField = z
  .string()
  .min(1)
  .max(MAX_HREF)
  .regex(HREF_RE, "href must be a path on this origin");

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

/** The calendar, not the shape. `2026-02-31T00:00:00.000Z` passes a `\d{2}`
 *  check and then sorts as if it were a day, which is how one nonsense row
 *  pins itself at the head of the bell and stays there: the centre orders on
 *  this string and never through `Date`. The clock range is in the pattern for
 *  the same reason, so `T99:99` cannot outrank every real instant. */
const isCalendarDay = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

/** UTC to the millisecond, the one shape `new Date().toISOString()` produces.
 *  A local offset is refused because the centre compares this value as a
 *  string, and two rows written in different offsets would sort backwards. */
export function isNotificationInstant(value: unknown): value is string {
  return typeof value === "string" && INSTANT_RE.test(value) && isCalendarDay(value.slice(0, 10));
}

const instantField = z
  .string()
  .regex(INSTANT_RE, "must be an ISO instant")
  .refine((value) => isCalendarDay(value.slice(0, 10)), "not a day the calendar has");

export const notificationSchema = z
  .object({
    id: z.string().regex(NOTIFICATION_ID_RE),
    kind: z.enum(NOTIFICATION_KINDS),
    at: instantField,
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(400).optional(),
    href: hrefField,
    readAt: instantField.optional(),
  })
  .strict();

export type BrainNotification = z.infer<typeof notificationSchema>;

export function taskReminderNotificationId(taskId: string, when: string, time: string): string {
  return `task-reminder:${taskId}:${when}T${time}`;
}

export function taskMissedNotificationId(taskId: string, when: string, time: string): string {
  return `task-missed:${taskId}:${when}T${time}`;
}

/** The id readers live in their own zod-free module so the browser can import
 *  them without pulling this file's schemas into a route bundle. Re-exported
 *  here so a server caller still has one import. */
export { decodeTaskNotificationId } from "./ids";
