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

/** The clause order is the rule. Read top to bottom: a completion that is not
 *  today's, then the day it is meant for, then the day it is owed, then the
 *  future, then someday.
 *
 *  A COMPLETION STAYS WHERE IT WAS UNTIL THE DAY CHANGES. Finishing a task is
 *  not the task leaving: the row stays in the list it was in, struck through
 *  and at the foot of its group, and reaches the Logbook on the day change.
 *  That is why this needs the reader's own offset: `doneAt` is one UTC instant
 *  and the day it falls on is theirs. Zero means UTC, which is what a caller
 *  with no offset to give already gets for the Logbook window.
 */
export function listOf(task: TaskView, today: string, offsetMinutes = 0): ListName {
  if (task.done) {
    const day = task.doneAt === undefined ? undefined : doneDayOf(task.doneAt, offsetMinutes);
    if (day !== today) return "logbook";
  }
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
 *  from `-new Date().getTimezoneOffset()`. It is read wherever a UTC instant
 *  has to become somebody's day, which is the Logbook's header and, since a
 *  completion stays in its list for the rest of the day, the list itself.
 *  Zero means UTC. */
export function groupFor(
  task: TaskView,
  today: string,
  offsetMinutes = 0,
): TaskGroup {
  const list = listOf(task, today, offsetMinutes);
  // THE EVENING IS A SECTION OF TODAY AND OF NO OTHER DAY. A task carrying it
  // on a day still ahead is grouped by that day, and one carrying it on a day
  // already past is an ordinary overdue row: an evening that has been and gone
  // is not a section anybody is looking at.
  if (list === "today" && task.evening === true && task.when === today) {
    return { key: EVENING_GROUP_KEY, label: "This Evening", order: 2 };
  }
  if (list === "today" || list === "someday") return categoryGroup(task);
  if (list === "upcoming") return upcomingGroup(task, today);
  if (list === "logbook") return logbookGroup(task, today, offsetMinutes);
  return { key: "", label: null, order: 0 };
}

/** The last group of Today. The renderer draws the moon beside the label, and
 *  a group carries no glyph and gains none.
 *
 *  NAMESPACED, because a category is a word a person typed and one of the
 *  words they can type is "evening". `categoryGroup` keys a group by the raw
 *  category, and whoever draws a list keys its sections on `group.key`, so a
 *  shared key put a category's rows and tonight's rows in one section with
 *  the "This Evening" header gone. The prefix is not reachable from a
 *  category, which cannot hold a colon by any route the picker offers. */
export const EVENING_GROUP_KEY = "group:evening";

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

/** The Logbook holds 30 days.
 *
 *  Its one home. `lib/tasks/index-store.ts` re-exports it for the store's own
 *  window rather than carrying a second 30: this module opens no files, so a
 *  server module can import it, and the reverse could never be true. */
export const LOGBOOK_WINDOW_DAYS = 30;

/** The oldest day the Logbook shows, in the reader's own days. */
function logbookWindowStart(today: string): string {
  return dayString(dayNumber(today) - LOGBOOK_WINDOW_DAYS);
}

/** One line of the Logbook.
 *
 *  A repeating task is never done: completing it appends a `log` entry and
 *  moves `when` on to the next occurrence, so the record itself is always
 *  open and would never reach the Logbook at all. History is per instance
 *  even though storage is per series, so every entry draws a row of its own.
 */
export interface LogbookRow {
  /** Stable across two reads and unique inside a day, which one record id is
   *  not: a daily task has a row for every day it was finished. */
  readonly key: string;
  /** The record, carrying THIS row's completion: `doneAt` is the entry's
   *  instant and `when` is the day that instance was owed. Never written. */
  readonly task: TaskView;
  /** Whether an untick is offered. Every ordinary done record, and the newest
   *  entry of a task that still repeats: an older entry is history, and so is
   *  every entry of a task whose rule has been stopped, because there is no
   *  rule left to put the series back on. */
  readonly untickable: boolean;
}

/** Every completion the Logbook shows, newest first.
 *
 *  TOTAL over the records `listOf` files in the Logbook, which is the property
 *  that matters: a record this returns no row for, and that every other list
 *  rejects, is a record nothing on the surface can reach again. So the two
 *  sources are added rather than chosen between. A record can contribute log
 *  entries, its own `done`, both, or neither.
 *
 *  Total in that direction only. A completion stays in the list it was made in
 *  until the day changes, so today's completion has a row here AND a place in
 *  Today, and whoever draws the Logbook owns what today's rows do there. This
 *  read has never been a filter over `listOf` and is not one now.
 *
 *  Where the rows come from:
 *
 *  - `log` entries are read whether or not the rule is still there. Stopping a
 *    repeat keeps the history (`model.ts`), so those rows outlive the rule.
 *  - `done` draws its own row on top, which is the ordinary case and also the
 *    one a hand-edited or imported `{done, repeat}` record lands in.
 *
 *  `offsetMinutes` decides the window edge for the same reason it decides the
 *  group header: a completion is one UTC instant and the day it falls on is
 *  the reader's.
 */
export function logbookRows(
  tasks: readonly TaskView[],
  today: string,
  offsetMinutes: number,
): LogbookRow[] {
  const windowStart = logbookWindowStart(today);
  // A completion with no instant has no day to measure, and this file places
  // it deliberately at the foot of the Logbook under no header, so the window
  // must not be the thing that drops it.
  const inWindow = (instant: string | undefined): boolean =>
    instant === undefined || doneDayOf(instant, offsetMinutes) >= windowStart;

  const rows: LogbookRow[] = [];
  for (const task of tasks) {
    const log = task.log ?? [];
    for (const [at, completion] of log.entries()) {
      if (!inWindow(completion.completedAt)) continue;
      const projected: TaskView = {
        ...task,
        done: true,
        doneAt: completion.completedAt,
      };
      if (completion.scheduled === undefined) delete projected.when;
      else projected.when = completion.scheduled;
      rows.push({
        key: `${task.id}:${completion.completedAt}`,
        task: projected,
        // The newest, and only while a rule is there to undo it against. A
        // record that is itself done owns its completion through `done`, and
        // that is the row the untick belongs to.
        untickable: at === log.length - 1 && task.repeat !== undefined && !task.done,
      });
    }
    if (task.done && inWindow(task.doneAt)) {
      rows.push({ key: task.id, task, untickable: true });
    }
  }
  return rows.sort(
    (a, b) => compareInGroup(a.task, b.task, "logbook") || ascending(a.key, b.key),
  );
}

/** Groups sort by rank first, then by label under the reader's own collation,
 *  so `Ёлка` files after `Единорог` rather than after every Latin word. */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareGroups(a: TaskGroup, b: TaskGroup): number {
  if (a.order !== b.order) return a.order - b.order;
  return collator.compare(a.label ?? "", b.label ?? "");
}

/** Three keys, in this order: open before done, then timed before untimed and
 *  timed by the clock, then newest first. The logbook keeps its own first key,
 *  completion descending, and takes neither of the other two: it is a reading
 *  of when things were finished, and a task with no `doneAt` sorts last there
 *  rather than jumping to the top.
 *
 *  Plain string comparison, not `localeCompare`: these are UTC ISO instants,
 *  `HH:MM` clocks and ids, and a locale has no business ordering any of them.
 */
export function compareInGroup(a: TaskView, b: TaskView, list: ListName): number {
  if (list === "logbook") {
    const byDone = descending(a.doneAt ?? "", b.doneAt ?? "");
    if (byDone !== 0) return byDone;
  } else {
    // A COMPLETION SINKS TO THE FOOT OF ITS GROUP and stays there for the rest
    // of the day. This is the sort the row's own sink animates against.
    if (a.done !== b.done) return a.done ? 1 : -1;
    // Then the clock, ascending: a row that names an hour is a row with a
    // place in the day, and a row without one has not claimed a place yet.
    if ((a.time ?? "") !== (b.time ?? "")) {
      if (a.time === undefined) return 1;
      if (b.time === undefined) return -1;
      return ascending(a.time, b.time);
    }
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
  // days stop at six and the week after this one takes over.
  if (distance <= 6) {
    return {
      key: day,
      label: `${WEEKDAYS[weekdayIndex(day)]} ${Number(day.slice(8, 10))}`,
      order: dayNumber(day),
    };
  }
  // NEXT WEEK IS SEVEN DAYS, not a rolling fortnight. Day 7 to day 13 is the
  // week after the six named ones; day 14 is the week after that, and calling
  // it "next week" was the one label on this surface that was untrue rather
  // than loose.
  if (distance <= 13) {
    return { key: "next-week", label: "Next week", order: dayNumber(today) + 7 };
  }
  // And past that a single bucket would hold months of rows under one word,
  // so each day names its own date, the way the Logbook's older groups do.
  return {
    key: day,
    label: `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`,
    order: dayNumber(day),
  };
}

/** Grouped by the reader's completion day, newest group first. A record with
 *  `done` but no `doneAt` is reachable from a hand edit, and it goes to the
 *  foot of the Logbook under no header rather than claiming a day.
 *
 *  EXPORTED FOR THE LOGBOOK VIEW. `groupFor` cannot answer that view: a
 *  completion made today is filed by `listOf` in the list it was made in, so
 *  it would hand a row drawn in the Logbook the category group it wears in
 *  Today. `components/tasks-lists.ts` therefore asks for this group by name,
 *  and asks for THIS one: the copy it carried was a second answer to which
 *  day a completion is filed under. */
export function logbookGroup(
  task: TaskView,
  today: string,
  offsetMinutes: number,
): TaskGroup {
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
