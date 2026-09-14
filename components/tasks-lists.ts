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
  for (const row of rowsFor(tasks, view, today, offsetMinutes)) {
    const group =
      view.kind === "list"
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
    .filter((task) => belongs(task, view, today))
    .map((task) => ({ key: task.id, task, untickable: true }));
}

function belongs(task: TaskView, view: TasksView, today: string): boolean {
  if (view.kind === "list") return listOf(task, today) === view.list;
  // A completed task is in the Logbook and nowhere else, so a category view
  // shows what is still open under that word.
  return !task.done && (task.category ?? "") === view.category;
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

export interface DeadlineCaption {
  readonly label: string;
  /** Drawn in `--red` as text, never as a fill: the one red in the section. */
  readonly overdue: boolean;
}

/** The bare date. Not "due in 3d", not "overdue 2d". A deadline that has
 *  arrived is owed today, so the boundary is the same `<=` that pulls the
 *  task into Today. */
export function deadlineCaption(task: TaskView, today: string): DeadlineCaption | null {
  if (!isDay(task.deadline)) return null;
  return { label: dayLabel(task.deadline), overdue: task.deadline <= today };
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
    const list = listOf(task, today);
    if (list === "logbook") {
      if (task.doneAt && doneDayOf(task.doneAt, offsetMinutes) === today) doneToday += 1;
      continue;
    }
    if (list === "upcoming" && withinWeek(task, today)) upcomingThisWeek += 1;
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
