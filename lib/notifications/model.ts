import { z } from "zod";

/** THE CENTRE'S MODEL, GENERIC ON PURPOSE.
 *
 *  Three kinds ship in this release. The shape carries nothing about a task
 *  or a letter, so an agent notice or a backup failure joins later without a
 *  second store and without a migration.
 *
 *  Nothing here reads the clock, the filesystem or a Store.
 */

export const NOTIFICATION_KINDS = ["task-reminder", "task-missed", "mail-new"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Five hundred rows, oldest dropped first. The file is read whole on every
 *  request, so the cap is what keeps it a few hundred kilobytes. */
export const NOTIFICATION_CAP = 500;

/** An id is derived, never minted: the same reminder computed by two scans,
 *  or the same thread seen by two polls, has to be one row. The charset is
 *  what `mailNotificationId` can produce plus the two literal separators. */
export const NOTIFICATION_ID_RE = /^[A-Za-z0-9:_.@+-]{1,400}$/;

/** A path on this origin and nothing else. The service worker opens this
 *  value, so an absolute URL here would be an open redirect with a
 *  notification in front of it. A protocol-relative `//host` is a URL too. */
const hrefField = z
  .string()
  .min(1)
  .max(300)
  .regex(/^\/(?!\/)[A-Za-z0-9/_?=&:.,%+-]*$/, "href must be a path on this origin");

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

/** The mail id pair lives in its own zod-free module so the Mail client can
 *  import it without pulling this file's schemas into the browser bundle. It
 *  is re-exported here so a server caller still has one import. */
export { mailNotificationId, decodeMailNotificationId } from "./ids";
