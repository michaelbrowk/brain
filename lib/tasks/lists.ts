import type { TaskView } from "./model";

/** Which list a task belongs to, and which group inside that list.
 *
 *  Derivation, not storage: no list is written to a file, so moving a task
 *  between lists is only ever a change to `when`, `deadline` or `done`. That
 *  is why a hand edit cannot put a task in an impossible place.
 *
 *  `today` is always supplied by the caller as a `YYYY-MM-DD` string, and
 *  every comparison in this file is a string comparison. Nothing here reads
 *  the clock and nothing here builds a `Date`: `new Date("2026-09-13")` parses
 *  as UTC midnight, so its local day is the day before for every traveller
 *  west of Greenwich. `lists.test.ts` pins that with the clock trapped.
 *
 *  `doneAt` is a UTC instant, which is what makes the Logbook sort, and the
 *  reader's local day comes from `doneDayOf(instant, offsetMinutes)` with the
 *  offset supplied the same way `today` is.
 */

export type ListName = "logbook" | "today" | "upcoming" | "someday" | "inbox";

/** One group inside a list. `label` is null for a group that shows no header,
 *  which is the inbox and the uncategorised group at the top of Today.
 *
 *  The label carries no count. A Logbook header reads `Today · 5`, and the
 *  count is the group's size, which one task cannot know: whoever renders the
 *  header appends `· ${rows.length}`. */
export interface TaskGroup {
  key: string;
  label: string | null;
  order: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (value: string | undefined): value is string =>
  value !== undefined && DAY_RE.test(value);

/** The clause order is the rule. Read top to bottom: done, then the day it is
 *  meant for, then the day it is owed, then the future, then someday. */
export function listOf(task: TaskView, today: string): ListName {
  if (task.done) return "logbook";
  if (isDay(task.when) && task.when <= today) return "today";
  // A deadline that has arrived pulls the task into Today whatever `when`
  // says, including `someday`: the day it is owed outranks the day it was
  // filed under.
  if (isDay(task.deadline) && task.deadline <= today) return "today";
  if (isDay(task.when) && task.when > today) return "upcoming";
  if (task.when === "someday") return "someday";
  if (isDay(task.deadline) && task.deadline > today) return "upcoming";
  return "inbox";
}

/** `offsetMinutes` is the reader's offset east of UTC, which a browser gets
 *  from `-new Date().getTimezoneOffset()`. It is only read for the Logbook,
 *  where a UTC instant has to become somebody's day. Zero means UTC. */
export function groupFor(
  task: TaskView,
  today: string,
  offsetMinutes = 0,
): TaskGroup {
  const list = listOf(task, today);
  if (list === "today" || list === "someday") return categoryGroup(task);
  if (list === "upcoming") return upcomingGroup(task, today);
  if (list === "logbook") return logbookGroup(task, today, offsetMinutes);
  return { key: "", label: null, order: 0 };
}

/** The day a UTC instant falls on for a reader at `offsetMinutes` east of UTC.
 *  Arithmetic on the digits, so the module stays clock-free and the caller's
 *  zone is the only zone in the answer. */
export function doneDayOf(iso: string, offsetMinutes: number): string {
  const day = iso.slice(0, 10);
  const minutesIntoDay =
    Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16)) + offsetMinutes;
  const carry = Math.floor(minutesIntoDay / (24 * 60));
  return carry === 0 ? day : dayString(dayNumber(day) + carry);
}

/** Groups sort by rank first, then by label under the reader's own collation,
 *  so `Ёлка` files after `Единорог` rather than after every Latin word. */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareGroups(a: TaskGroup, b: TaskGroup): number {
  if (a.order !== b.order) return a.order - b.order;
  return collator.compare(a.label ?? "", b.label ?? "");
}

/** Newest first everywhere except the logbook, which reads by completion. A
 *  task with no `doneAt` sorts last rather than jumping to the top.
 *
 *  Plain string comparison, not `localeCompare`: these are UTC ISO instants
 *  and ids, and a locale has no business ordering either. */
export function compareInGroup(a: TaskView, b: TaskView, list: ListName): number {
  if (list === "logbook") {
    const byDone = descending(a.doneAt ?? "", b.doneAt ?? "");
    if (byDone !== 0) return byDone;
  }
  const byCreated = descending(a.created, b.created);
  return byCreated !== 0 ? byCreated : ascending(a.id, b.id);
}

const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const descending = (a: string, b: string): number => ascending(b, a);

/** The uncategorised group leads and shows no header, because a heading over
 *  the first rows of an empty-ish list is chrome nobody reads. */
function categoryGroup(task: TaskView): TaskGroup {
  const category = task.category;
  if (!category) return { key: "", label: null, order: 0 };
  return { key: category, label: category, order: 1 };
}

/** The day a task shows under in Upcoming is the earlier of the day it is
 *  meant for and the day it is owed, the same reason a due deadline pulls a
 *  task into Today. */
function upcomingGroup(task: TaskView, today: string): TaskGroup {
  const days = [task.when, task.deadline].filter(
    (value): value is string => isDay(value) && value > today,
  );
  const day = days.sort()[0];
  if (!day) return { key: "", label: null, order: 0 };

  const distance = dayNumber(day) - dayNumber(today);
  if (distance === 1) return { key: day, label: "Tomorrow", order: dayNumber(day) };
  // A weekday name is unambiguous only inside a week of today, so the named
  // days stop at seven and the two coarse buckets take over.
  if (distance <= 7) {
    return {
      key: day,
      label: `${WEEKDAYS[weekdayIndex(day)]} ${Number(day.slice(8, 10))}`,
      order: dayNumber(day),
    };
  }
  if (distance <= 14) {
    return { key: "next-week", label: "Next week", order: dayNumber(today) + 8 };
  }
  return { key: "later", label: "Later", order: dayNumber(today) + 15 };
}

/** Grouped by the reader's completion day, newest group first. A record with
 *  `done` but no `doneAt` is reachable from a hand edit, and it goes to the
 *  foot of the Logbook under no header rather than claiming a day. */
function logbookGroup(task: TaskView, today: string, offsetMinutes: number): TaskGroup {
  const day = task.doneAt ? doneDayOf(task.doneAt, offsetMinutes) : undefined;
  if (!isDay(day)) return { key: "", label: null, order: Number.MAX_SAFE_INTEGER };
  const distance = dayNumber(today) - dayNumber(day);
  const label =
    distance === 0
      ? "Today"
      : distance === 1
        ? "Yesterday"
        : `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  return { key: day, label, order: -dayNumber(day) };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Days since 1970-01-01 for a civil date, by Howard Hinnant's algorithm.
 *  Written out because the arithmetic is the point: a calendar day is a
 *  number here and never an instant, so no timezone can shift it. */
function dayNumber(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const dayOfMonth = Number(day.slice(8, 10));
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + dayOfMonth - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The inverse of `dayNumber`, Hinnant's civil_from_days. Needed because an
 *  offset can carry an instant into the previous or the next day, and the
 *  answer has to be a real calendar date across a month, a year and a leap
 *  day. */
function dayString(days: number): string {
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 0 is Monday. 1970-01-01 was a Thursday, which is the 3 below. */
function weekdayIndex(day: string): number {
  return (((dayNumber(day) + 3) % 7) + 7) % 7;
}
