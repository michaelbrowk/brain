import { shiftDay } from "@/lib/tasks/calendar";
import { nextOccurrence } from "@/lib/tasks/recurrence";
import {
  compareGroups,
  compareInGroup,
  doneDayOf,
  groupFor,
  listOf,
  logbookRows,
  type ListName,
  type TaskGroup,
} from "@/lib/tasks/lists";
import type { TaskView } from "@/lib/tasks/model";

/** The surface renders, it does not derive.
 *
 *  `lib/tasks/lists.ts` owns which list a record is in and which group inside
 *  it; this file turns that answer into the sections a column draws, and
 *  writes the few words a row and a header say. Nothing here reads the clock:
 *  the browser's own local day arrives as `today` and its offset as
 *  `offsetMinutes`, the same two values the routes take.
 *
 *  A category view is the one shape `lib/tasks/lists.ts` has no grouping for,
 *  because a category crosses every list: it is grouped by time instead, with
 *  the undated tasks leading under no header, the shape Today already uses
 *  for its uncategorised group.
 */

/** One drawn row. A row is not a record: the Logbook draws one per COMPLETION,
 *  and a repeating task has as many of those as it has days it was finished on
 *  (`logbookRows` in `lib/tasks/lists.ts`). Everywhere else the two are the
 *  same thing and `key` is the record's id. */
export interface TaskRow {
  readonly key: string;
  readonly task: TaskView;
  /** False on a Logbook row that is history: an older completion of a
   *  repeating task, which has nothing left to undo. */
  readonly untickable: boolean;
}

export interface TaskSection {
  readonly group: TaskGroup;
  readonly rows: readonly TaskRow[];
}

/** What the column is looking at. `category: ""` is the uncategorised view,
 *  which is how the route asks for "no category" as well. */
export type TasksView =
  | { readonly kind: "list"; readonly list: ListName }
  | { readonly kind: "category"; readonly category: string };

export function sectionsFor(
  tasks: readonly TaskView[],
  view: TasksView,
  today: string,
  offsetMinutes: number,
): TaskSection[] {
  const sections = new Map<string, { group: TaskGroup; rows: TaskRow[] }>();
  const logbook = view.kind === "list" && view.list === "logbook";
  for (const row of rowsFor(tasks, view, today, offsetMinutes)) {
    const group = logbook
      ? logbookDayGroup(row.task, today, offsetMinutes)
      : view.kind === "list"
        ? groupFor(row.task, today, offsetMinutes)
        : categoryGroup(row.task, today);
    const existing = sections.get(group.key);
    if (existing) existing.rows.push(row);
    else sections.set(group.key, { group, rows: [row] });
  }
  // The logbook reads by completion and everything else by creation, and a
  // category view is everything else.
  const order: ListName = view.kind === "list" ? view.list : "today";
  return [...sections.values()]
    .sort((a, b) => compareGroups(a.group, b.group))
    .map((section) => ({
      group: section.group,
      rows: section.rows.sort((a, b) => compareInGroup(a.task, b.task, order)),
    }));
}

/** THE LOGBOOK COUNTS COMPLETIONS AND EVERY OTHER LIST COUNTS RECORDS.
 *
 *  A repeating task is never done, so its record is in Today or Upcoming and
 *  its history is in `log`. The Logbook therefore cannot be a filter over the
 *  records: it is a read of the completions, one row each, and that is the one
 *  place a record can draw more than a single row. */
function rowsFor(
  tasks: readonly TaskView[],
  view: TasksView,
  today: string,
  offsetMinutes: number,
): TaskRow[] {
  if (view.kind === "list" && view.list === "logbook") {
    return logbookRows(tasks, today, offsetMinutes);
  }
  return tasks
    .filter((task) => belongs(task, view, today, offsetMinutes))
    .map((task) => ({ key: task.id, task, untickable: true }));
}

function belongs(
  task: TaskView,
  view: TasksView,
  today: string,
  offsetMinutes: number,
): boolean {
  // The offset is not optional here. A completion stays in the list it was
  // made in until the DAY changes, and which day a UTC instant fell on is the
  // reader's question: at 01:00 in Dubai a task finished ten minutes ago
  // carries yesterday's UTC date, and reading it at zero would drop the row
  // out of Today the moment it was ticked.
  if (view.kind === "list") return listOf(task, today, offsetMinutes) === view.list;
  // A CATEGORY VIEW KEEPS THE DAY'S WORK TOO (spec 2). It is the one list
  // organised by the part of a life the work belongs to, so erasing a task the
  // instant it is finished would make it the one list with nothing to show for
  // the morning. The same rule as everywhere else, asked the same way: a
  // completion belongs here until `listOf` files it in the Logbook, which is
  // the day change. `sectionsFor` already sorts a category view with the
  // `today` comparator, which sinks it to the foot of its group.
  if ((task.category ?? "") !== view.category) return false;
  return !task.done || listOf(task, today, offsetMinutes) !== "logbook";
}

/** THE LOGBOOK VIEW GROUPS BY THE DAY THE COMPLETION WAS MADE, always.
 *
 *  `groupFor` cannot answer this one. A completion made TODAY is filed by
 *  `listOf` in the list it was made in, so `groupFor` would hand a row drawn
 *  in the Logbook the category group it wears in Today and the `Today · N`
 *  header would be gone. The Logbook is a read of completions, and the day
 *  each one carries is the only thing it groups on.
 *
 *  `offsetMinutes` for the same reason the header needs it: the instant is
 *  UTC and the day is the reader's. A row with no instant is reachable from a
 *  hand edit and goes to the foot under no header rather than claiming a day,
 *  which is the answer `lib/tasks/lists.ts` gives it too. */
function logbookDayGroup(
  task: TaskView,
  today: string,
  offsetMinutes: number,
): TaskGroup {
  const day = task.doneAt ? doneDayOf(task.doneAt, offsetMinutes) : undefined;
  if (!isDay(day)) return { key: "", label: null, order: Number.MAX_SAFE_INTEGER };
  const distance = dayNumber(today) - dayNumber(day);
  const label = distance === 0 ? "Today" : distance === 1 ? "Yesterday" : dayLabel(day);
  return { key: day, label, order: -dayNumber(day) };
}

/** WHETHER A RESCHEDULE MOVES THE ROW.
 *
 *  A task is in Today for four reasons: the day it is meant for is today,
 *  that day is past, a deadline has arrived, or a deadline has arrived over a
 *  day still ahead. Today pressed on any of them is a real write and not a
 *  move, and the same holds for Someday pressed on a task already parked.
 *
 *  Two callers, one answer. The row plays its leaving fold only when this is
 *  true, because the fold fills forwards and one started on a row that never
 *  unmounts would hold it at height 0 with the record correct underneath it
 *  until the next load; and `tasks-actions` reports "Moved to Today" only
 *  when this is true, because a task that was already there did not move.
 *
 *  It has no rule of its own: the list and the group are both
 *  `lib/tasks/lists.ts`, asked twice, of the record and of what the write
 *  makes of it. So a row can never fold out of a place the derive keeps it
 *  in. */
export function movesRow(
  task: TaskView,
  when: string | "someday" | null,
  today: string,
): boolean {
  const next: TaskView = { ...task, when: when ?? undefined };
  return (
    listOf(task, today) !== listOf(next, today) ||
    groupFor(task, today).key !== groupFor(next, today).key
  );
}

/** Today, Tomorrow, Later, Someday, and the undated tasks first, under no
 *  header, because a heading over the top rows of a short list is chrome
 *  nobody reads (the rule `lib/tasks/lists.ts` already applies to Today). */
function categoryGroup(task: TaskView, today: string): TaskGroup {
  const list = listOf(task, today);
  if (list === "today") return { key: "today", label: "Today", order: 1 };
  if (list === "someday") return { key: "someday", label: "Someday", order: 4 };
  if (list === "upcoming") {
    return dueDay(task, today) === dayNumber(today) + 1
      ? { key: "tomorrow", label: "Tomorrow", order: 2 }
      : { key: "later", label: "Later", order: 3 };
  }
  return { key: "", label: null, order: 0 };
}

/** The day a scheduled task shows under: the earlier of the day it is meant
 *  for and the day it is owed, the same rule Upcoming groups on. */
function dueDay(task: TaskView, today: string): number {
  const days = [task.when, task.deadline]
    .filter((value): value is string => isDay(value) && value > today)
    .sort();
  return days.length > 0 ? dayNumber(days[0] as string) : Number.MAX_SAFE_INTEGER;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isDay = (value: string | undefined): value is string =>
  value !== undefined && DAY_RE.test(value);

/** Days since the epoch for a civil date. `Date.UTC` is arithmetic on the
 *  digits handed in and reads no clock and no zone, which is the whole
 *  reason a day is a string everywhere else in this subsystem. */
function dayNumber(day: string): number {
  return (
    Date.UTC(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
    ) / 86_400_000
  );
}

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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `13 Sep`: the pill's tail and a deadline, one shape. */
export function dayLabel(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

export function weekdayOf(day: string): string {
  return WEEKDAYS[new Date(dayNumber(day) * 86_400_000).getUTCDay()] as string;
}

/** THE WORD A MOVE IS REPORTED IN.
 *
 *  "Moved to Tomorrow" over the row on its way out, and the same five
 *  answers wherever a picked value has to be said out loud. Today and Tomorrow
 *  carry their names because those are the two days a person says rather than
 *  dates; every other day carries the `20 Sep` the tail already uses, and that
 *  includes yesterday. A task filed into the past is overdue and
 *  `overdueWhenCaption` says so in its own words, so a second wording here
 *  would be a second answer to where the row went. */
export function whenLabel(when: string | null | undefined, today: string): string {
  if (when === null || when === undefined) return "No date";
  if (when === "someday") return "Someday";
  if (when === today) return "Today";
  if (when === shiftDay(today, 1)) return "Tomorrow";
  return dayLabel(when);
}

/** `Today · 5`. The count is the group's size, which one task cannot know. */
export function headerLabel(label: string, count: number): string {
  return `${label} · ${count}`;
}

/** `since Tue`: the weekday the task was meant for, never a count of days.
 *  A day count is arithmetic the reader has to undo to know which day it was,
 *  and by Thursday "overdue 3d" says less than "since Mon". */
export function overdueWhenCaption(task: TaskView, today: string): string | null {
  if (!isDay(task.when) || task.when >= today) return null;
  return `since ${weekdayOf(task.when)}`;
}

/** The clock on the row, as the file holds it.
 *
 *  Verbatim, never through `Intl`. `time` is a WALL CLOCK in the owner's zone,
 *  so the 13:00 the picker wrote is the 13:00 the file holds and the 13:00 the
 *  row says, on every device. `doneTimeOf` below does use a formatter, and
 *  rightly: that one turns a UTC instant into the reader's own clock, which is
 *  a different question with a different answer per device. */
export function timeCaption(task: TaskView): string | null {
  return task.time ?? null;
}

/** Whether the moon stands in this row's tail.
 *
 *  An evening that has been and gone is not a section anybody is looking at:
 *  an overdue evening task is an ordinary overdue row, with the "since Tue"
 *  caption and no moon. */
export function eveningMoon(task: TaskView, today: string): boolean {
  return task.evening === true && isDay(task.when) && task.when >= today;
}

/** A reminder that has already spoken, on a task still open. Once the task is
 *  done the clock has nothing left to announce. */
export function reminderFired(task: TaskView): boolean {
  return task.remindedAt !== undefined && !task.done;
}

export interface DeadlineCaption {
  readonly label: string;
  /** Drawn in `--red` as text, never as a fill: the one red in the section. */
  readonly overdue: boolean;
}

/** The bare date. Not "due in 3d", not "overdue 2d".
 *
 *  Red is for a deadline that is PAST, strictly: the spec's own words are
 *  "`--ink-3` while it is ahead and `--red` once it is past". A deadline is
 *  owed today on its own day, which is why it pulls the task into Today, and
 *  drawing it red there spent the section's one red on every deadline on the
 *  one day it is not yet late. A signal that fires every time stops being
 *  one. */
export function deadlineCaption(task: TaskView, today: string): DeadlineCaption | null {
  if (!isDay(task.deadline)) return null;
  return { label: dayLabel(task.deadline), overdue: task.deadline < today };
}

/** The reader's day for a completion instant. Re-exported rather than
 *  re-derived: `lib/tasks/lists.ts` owns this arithmetic, and a second copy
 *  of it is a second answer to which day the Logbook files a task under. */
export { doneDayOf };

/** A completion's time in the reader's own offset. The instant is UTC, the
 *  clock on the row is theirs, and the shift is arithmetic on the instant so
 *  the formatter never has to be handed a zone name nobody stored. */
export function doneTimeOf(iso: string, offsetMinutes: number): string {
  const shifted = new Date(Date.parse(iso) + offsetMinutes * 60_000);
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(shifted);
}

/** The day the next occurrence lands on, or null for a task that does not
 *  repeat.
 *
 *  `nextOccurrence` measures from the later of the day the task is meant for
 *  and today, which is `advance()`'s own `max(when, today)` and the rule's
 *  definition of "next" (`lib/tasks/recurrence.ts`). The browser computes it
 *  for two reasons and both are about the same 1.3 seconds: the tail says
 *  where the series went before the row folds, and the optimistic write moves
 *  the record there so the count beside it decrements on the same beat rather
 *  than waiting for the answer. A rule the helper refuses gives null rather
 *  than a guess, and the server's answer replaces all of it either way. */
export function repeatNextDay(task: TaskView, today: string): string | null {
  if (!task.repeat) return null;
  const from = isDay(task.when) && task.when > today ? task.when : today;
  try {
    return nextOccurrence(task.repeat, from);
  } catch {
    return null;
  }
}

/** Where the next one lands, in the Upcoming group's own `Thu 17` shape.
 *
 *  Read during the completion hold so the row says where the series went
 *  before it folds. */
export function repeatNextLabel(task: TaskView, today: string): string | null {
  const day = repeatNextDay(task, today);
  return day === null ? null : `${weekdayOf(day)} ${Number(day.slice(8, 10))}`;
}

/** The open tasks of one category, for the count beside it in the menu. */
export function categoriesOf(
  tasks: readonly TaskView[],
): { category: string; open: number }[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.done || !task.category) continue;
    counts.set(task.category, (counts.get(task.category) ?? 0) + 1);
  }
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  return [...counts.entries()]
    .map(([category, open]) => ({ category, open }))
    .sort((a, b) => collator.compare(a.category, b.category));
}

/** The number on the sidebar's Tasks row: what is open today. */
export function openTodayCount(tasks: readonly TaskView[], today: string): number {
  return tasks.filter((task) => !task.done && listOf(task, today) === "today").length;
}

/** The two numbers a Today empty state reports, and nothing else.
 *
 *  Both the column and the Today block on Home say "Done for today · N
 *  completed" and "Upcoming has N this week", and they say it about the same
 *  records. So the arithmetic is here, once, beside the derive that decides
 *  which list those records are in. */
export interface TaskCounts {
  doneToday: number;
  upcomingThisWeek: number;
}

export function countsFor(
  tasks: readonly TaskView[],
  today: string,
  offsetMinutes: number,
): TaskCounts {
  if (!today) return { doneToday: 0, upcomingThisWeek: 0 };
  let doneToday = 0;
  let upcomingThisWeek = 0;
  for (const task of tasks) {
    // Counted off the COMPLETION and not off the list it landed in: a task
    // finished today stays in the list it was finished in for the rest of the
    // day, so "N completed" would have read 0 all day and turned into the
    // right number at midnight.
    if (task.done && task.doneAt && doneDayOf(task.doneAt, offsetMinutes) === today) {
      doneToday += 1;
      continue;
    }
    if (listOf(task, today, offsetMinutes) === "upcoming" && withinWeek(task, today)) {
      upcomingThisWeek += 1;
    }
  }
  return { doneToday, upcomingThisWeek };
}

function withinWeek(task: TaskView, today: string): boolean {
  const days = [task.when, task.deadline].filter(
    (value): value is string => typeof value === "string" && value > today,
  );
  if (days.length === 0) return false;
  const soonest = days.sort()[0] as string;
  const limit = new Date(
    Date.UTC(
      Number(today.slice(0, 4)),
      Number(today.slice(5, 7)) - 1,
      Number(today.slice(8, 10)) + 7,
    ),
  )
    .toISOString()
    .slice(0, 10);
  return soonest <= limit;
}
