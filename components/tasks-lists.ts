import { nextOccurrence } from "@/lib/tasks/recurrence";
import {
  compareGroups,
  compareInGroup,
  doneDayOf,
  groupFor,
  listOf,
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

export interface TaskSection {
  readonly group: TaskGroup;
  readonly tasks: readonly TaskView[];
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
  const sections = new Map<string, { group: TaskGroup; tasks: TaskView[] }>();
  for (const task of tasks) {
    if (!belongs(task, view, today)) continue;
    const group =
      view.kind === "list"
        ? groupFor(task, today, offsetMinutes)
        : categoryGroup(task, today);
    const existing = sections.get(group.key);
    if (existing) existing.tasks.push(task);
    else sections.set(group.key, { group, tasks: [task] });
  }
  // The logbook reads by completion and everything else by creation, and a
  // category view is everything else.
  const order: ListName = view.kind === "list" ? view.list : "today";
  return [...sections.values()]
    .sort((a, b) => compareGroups(a.group, b.group))
    .map((section) => ({
      group: section.group,
      tasks: section.tasks.sort((a, b) => compareInGroup(a, b, order)),
    }));
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

/** Where the next one lands, in the Upcoming group's own `Thu 17` shape.
 *
 *  Read during the completion hold so the row says where the series went
 *  before it folds. `nextOccurrence` measures from the later of the day the
 *  task is meant for and today, which is the rule's own definition of "next"
 *  (`lib/tasks/recurrence.ts`); a rule it refuses gives no label rather than
 *  a guess. */
export function repeatNextLabel(task: TaskView, today: string): string | null {
  if (!task.repeat) return null;
  const from = isDay(task.when) && task.when > today ? task.when : today;
  try {
    const day = nextOccurrence(task.repeat, from);
    return `${weekdayOf(day)} ${Number(day.slice(8, 10))}`;
  } catch {
    return null;
  }
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
