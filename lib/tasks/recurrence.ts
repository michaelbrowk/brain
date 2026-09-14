import type { TaskLogEntry, TaskRecord, TaskRepeat, WeekDay } from "./model";

/** Where a repeating task goes next, and the one write that takes it there.
 *
 *  Fixed calendar, not counted from the completion. A task due on the 1st and
 *  finished on the 9th is next due on the 1st, not on the 9th of next month,
 *  because the rule is a statement about the calendar and a late finish is
 *  not a decision to move the series.
 *
 *  Missed days never pile up either. The next date is the first rule date
 *  strictly after the later of today and the day it was scheduled for, so a
 *  daily task left for a fortnight comes back tomorrow with one row, not with
 *  fourteen. There is only ever one open instance of a repeating task.
 *
 *  Every date is a `YYYY-MM-DD` string and every comparison is a string
 *  comparison. No `Date` is built here: `new Date("2026-09-13")` parses as UTC
 *  midnight, so its local day is the day before for every reader west of
 *  Greenwich, and a repeat rule that drifts by a day per timezone is worse
 *  than no repeat rule. `recurrence.test.ts` pins that with the clock trapped.
 *
 *  Nothing here reads the clock, the filesystem or a Store. `today` and
 *  `completedAt` are always supplied by the caller.
 */

/** The Logbook shows 30 days, which is 30 entries at the densest rule. Older
 *  entries are dropped rather than kept forever in a file a person may open. */
const MAX_LOG_ENTRIES = 30;

/** 0 is Monday, matching `WeekDay`'s own order. */
const WEEKDAY_ORDER: WeekDay[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type RecurrenceRefusal =
  | "no-repeat"
  | "bad-today"
  | "empty-weekdays"
  | "empty-log";

const REFUSAL_MESSAGES: Record<RecurrenceRefusal, string> = {
  "no-repeat": "this task carries no repeat rule",
  "bad-today": "advance() needs today as a YYYY-MM-DD calendar day",
  "empty-weekdays": "a weekly rule needs at least one weekday",
  "empty-log": "this repeating task has no completion to undo",
};

/** Thrown rather than answered with a plausible record.
 *
 *  Each of these four is a caller that has already gone wrong, and each of
 *  them has a quiet wrong answer available. A task with no rule would come
 *  back unchanged and a call site would write it and report success. A bad
 *  `today` would come back as `when: "0NaN-NaN-01"`, which the schema refuses,
 *  so the task drops out of every list on the next load. An empty log would
 *  come back with `when` untouched and the Logbook row still standing.
 *  `reason` is there so a route can map each one to its own status rather
 *  than to one 500. */
export class RecurrenceError extends Error {
  readonly reason: RecurrenceRefusal;

  constructor(reason: RecurrenceRefusal) {
    super(REFUSAL_MESSAGES[reason]);
    this.name = "RecurrenceError";
    this.reason = reason;
  }
}

/** The first date the rule names strictly after `from`.
 *
 *  Strictly after, so calling it with the occurrence that was completed always
 *  moves. A rule that could return `from` would leave a task due today after
 *  it had been ticked today. */
export function nextOccurrence(rule: TaskRepeat, from: string): string {
  if (rule.freq === "daily") return addOneDay(from);

  if (rule.freq === "weekly") {
    const wanted = new Set(rule.byWeekday);
    // Seven steps hold every weekday a rule can name, so the loop always
    // returns while the schema holds (`byWeekday` is `min(1)`). Falling out of
    // it means an empty rule, and there is no date that answers it. Throwing
    // rather than returning the eighth day keeps the bound real.
    let day = addOneDay(from);
    for (let step = 0; step < 7; step += 1) {
      if (wanted.has(WEEKDAY_ORDER[weekdayIndex(day)])) return day;
      day = addOneDay(day);
    }
    throw new RecurrenceError("empty-weekdays");
  }

  // Monthly. The day of the month is the rule's, clamped to the month it
  // lands in, so the 31st is the last day of February and is the 31st again
  // in March. Clamping a month never moves the rule itself, which is what
  // fixed calendar means here.
  const year = yearOf(from);
  const month = monthOf(from);
  const thisMonth = clampedDay(year, month, rule.byMonthDay);
  if (thisMonth > from) return thisMonth;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return clampedDay(nextYear, nextMonth, rule.byMonthDay);
}

/** A completion, taken with the caller's own day so that a tick late at night
 *  in Dubai is not filed under the day after. */
export interface CompleteOptions {
  /** The instant the person ticked it, UTC. */
  completedAt: string;
  /** The caller's own calendar day. */
  today: string;
  to?: undefined;
}

/** A move. The rule is untouched, so the next completion comes off the day
 *  the task was moved to. */
export interface RescheduleOptions {
  /** The day the task moves to, or the word `someday`. */
  to: string;
  completedAt?: undefined;
  today?: undefined;
}

export type AdvanceOptions = CompleteOptions | RescheduleOptions;

/** One repeating task, moved on. Completing it, completing it early and
 *  moving it are one operation on one record, because all three come down to
 *  where the single open instance now sits.
 *
 *  A task with no `repeat` is refused on both paths, per the spec's
 *  failure-mode table. Returning it unchanged was the other option and it is
 *  the worse one: the record comes back byte-identical, a call site written as
 *  `write(advance(task, ...))` reports success, and the task stays open with
 *  nothing anywhere saying so. The caller checks `repeat` first. Completing an
 *  ordinary task is the store's plain write of `done` and `doneAt`.
 *
 *  `updated` is not written here. It is a clock read, and the store owns it.
 */
export function advance(record: TaskRecord, options: AdvanceOptions): TaskRecord {
  if (!record.repeat) throw new RecurrenceError("no-repeat");

  if (options.completedAt !== undefined) {
    // `today` gets the same calendar check `when` gets. Left unchecked, the
    // word `someday` wins every string comparison against a real day, because
    // `s` sorts above every digit, and the arithmetic below then writes
    // `when: "0NaN-NaN-01"`. The schema refuses that, so the task drops out of
    // every list on the next load. Supplied by the caller is not the same as
    // checked.
    if (!isDay(options.today)) throw new RecurrenceError("bad-today");

    // The entry remembers `when` EXACTLY, because the untick is this read
    // backwards and it has to put the task back where it stood. A repeat
    // parked on `someday` that came back dated, or an Inbox one that came
    // back on a day, would be the gesture moving something nobody asked it to
    // move. So the word and the absence are both kept, and only the
    // arithmetic below insists on a real day.
    const entry: TaskLogEntry = {
      ...(record.when !== undefined ? { scheduled: record.when } : {}),
      ...(record.time !== undefined ? { time: record.time } : {}),
      completedAt: options.completedAt,
    };
    const log = [...(record.log ?? []), entry].slice(-MAX_LOG_ENTRIES);
    // Where to count from. A task with no day the rule can read is owed
    // today: `someday` sorts above every digit and would win every
    // comparison, and nothing at all has no day to compare.
    const from = isDay(record.when) ? later(options.today, record.when) : options.today;

    const advanced: TaskRecord = {
      ...record,
      when: nextOccurrence(record.repeat, from),
      log,
    };
    // `done` and `doneAt` are removed rather than set. A repeating task is
    // never finished: the completion is the log entry and the open instance
    // is the new `when`. A record carrying both would put one task in the
    // Logbook and in Today at once.
    delete advanced.done;
    delete advanced.doneAt;
    // The mark belongs to the instance that was finished a moment ago, not to the
    // one this mints. Left in place, the next occurrence would count as already
    // reminded and its reminder would never fire.
    delete advanced.remindedAt;
    return advanced;
  }

  if (options.to !== undefined) return { ...record, when: options.to };

  // Unreachable through `AdvanceOptions`, which always carries one of the two.
  // Here for a caller that is not TypeScript.
  return record;
}

/** One completion taken back, which is `advance()`'s completion read
 *  backwards: the newest `log` entry is popped and `when` returns to exactly
 *  what it was when that entry was written, the word `someday` and no day at
 *  all included.
 *
 *  The newest and no other. The Logbook offers an untick on the most recent
 *  entry of a repeating task only, so there is no index to take: an older
 *  entry is history, and undoing one would leave the series sitting on a day
 *  that neither the rule nor any completion put it on.
 *
 *  `log` goes away with its last entry rather than staying as an empty array,
 *  so a task that has never been completed and one that has been completed and
 *  unticked are the same file.
 */
export function revert(record: TaskRecord): TaskRecord {
  if (!record.repeat) throw new RecurrenceError("no-repeat");
  const log = record.log ?? [];
  const newest = log[log.length - 1];
  if (!newest) throw new RecurrenceError("empty-log");

  const reverted: TaskRecord = { ...record };
  if (newest.scheduled === undefined) delete reverted.when;
  else reverted.when = newest.scheduled;
  const rest = log.slice(0, -1);
  if (rest.length === 0) delete reverted.log;
  else reverted.log = rest;
  return reverted;
}

/** The calendar, not the shape. `2026-02-31` passes a `\d{2}` check and then
 *  names a day the calendar does not have, and a rule would advance off it.
 *  This is `model.ts`'s rule for `when`, applied to `today` as well. */
const isDay = (value: string | undefined): value is string => {
  if (value === undefined || !DAY_RE.test(value)) return false;
  const month = monthOf(value);
  if (month < 1 || month > 12) return false;
  const day = dayOfMonth(value);
  return day >= 1 && day <= daysInMonth(yearOf(value), month);
};

const later = (a: string, b: string): string => (a > b ? a : b);

const yearOf = (day: string): number => Number(day.slice(0, 4));
const monthOf = (day: string): number => Number(day.slice(5, 7));
const dayOfMonth = (day: string): number => Number(day.slice(8, 10));

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

/** The rule's day of the month in one particular month, never past its end. */
function clampedDay(year: number, month: number, byMonthDay: number): string {
  const day = Math.min(byMonthDay, daysInMonth(year, month));
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function addOneDay(day: string): string {
  const year = yearOf(day);
  const month = monthOf(day);
  const next = dayOfMonth(day) + 1;
  if (next <= daysInMonth(year, month)) return `${pad(year, 4)}-${pad(month, 2)}-${pad(next, 2)}`;
  if (month === 12) return `${pad(year + 1, 4)}-01-01`;
  return `${pad(year, 4)}-${pad(month + 1, 2)}-01`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** 0 is Monday. Days since 1970-01-01 by Howard Hinnant's days_from_civil,
 *  written out because a calendar day has to stay a number here: an instant
 *  would carry a timezone into a weekday, and a weekly rule that fires on
 *  Sunday evening in one zone is the bug this file exists to avoid.
 *  1970-01-01 was a Thursday, which is the 3 below. */
function weekdayIndex(day: string): number {
  const year = yearOf(day);
  const month = monthOf(day);
  const shiftedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + dayOfMonth(day) - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const days = era * 146_097 + dayOfEra - 719_468;
  return (((days + 3) % 7) + 7) % 7;
}
