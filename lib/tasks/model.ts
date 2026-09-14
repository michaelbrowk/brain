import { z } from "zod";

import { MAX_TASK_TEXT, normalizeTaskText } from "./task-lines";

/** A task record as it lives in the frontmatter of `_tasks/<id>.md`.
 *
 *  Three shapes share one schema. An UNLINKED task is its own record and owns
 *  its `done`. A LINKED task points at a checkbox in a note through `page`
 *  and `anchor`, and its `done` is never written here: the checkbox in the
 *  note is the truth, and a second copy of it would be a second source of
 *  truth to drift. A DETACHED task is one whose line the reconcile could not
 *  find: it keeps `page` and `anchor` as the last known position, carries
 *  `detachedAt`, and owns its `done` again because there is no checkbox left
 *  to read it from.
 *
 *  Nothing in this file reads the clock, the filesystem or a Store. It is the
 *  shape only, so the editor, the store and the routes can all agree on it.
 *  The two `Date` mentions below are an `instanceof` and a method call on a
 *  value YAML handed in, not a clock read.
 */

/** The id rule is the page id rule (`app/api/move/route.ts:6`), because a task
 *  id reaches a path the same way a page id does and the store's own copy is
 *  module-private. No dot, so no `..`, and no slash, so no traversal. */
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `advance()` trims the log to its 30 most recent entries, which covers the
 *  30 day Logbook window at the densest rule. The schema leaves headroom above
 *  that so a hand-edited or not-yet-trimmed file is read rather than skipped. */
const MAX_LOG_ENTRIES = 100;

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/, "control characters are not allowed");

const idSchema = z.string().regex(TASK_ID_RE);

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
};

/** The calendar, not the shape. `2026-02-31` passes a `\d{2}` check and then
 *  files itself under 3 March, which is a quiet wrong answer where the posture
 *  for a bad record is a warning and a skipped file. */
const isCalendarDay = (value: string): boolean => {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
};

/** A calendar day. Compared as a string everywhere, never through `Date`. */
const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDay, "not a day the calendar has");

/** An instant, always UTC (spec field table, `doneAt`). Never a local offset
 *  string: the Logbook orders on this value as a string, and two completions
 *  written in different offsets would sort backwards. The client derives its
 *  own local day from the instant with `doneDayOf` in `lists.ts`. */
const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?Z$/)
  .refine((value) => isCalendarDay(value.slice(0, 10)), "not a day the calendar has");

/** YAML turns an unquoted `2026-09-13` or `2026-09-13T09:00:00.000Z` into a
 *  Date before we ever see it, and a hand-edited file is the ordinary way a
 *  task record is written. Take the Date and keep the day or the instant it
 *  names, so a person's own file is not skipped over its quoting. */
const fromYamlDay = (value: unknown) =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : value;

const fromYamlInstant = (value: unknown) =>
  value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : value;

const dayField = z.preprocess(fromYamlDay, daySchema);
const instantField = z.preprocess(fromYamlInstant, instantSchema);

/** A wall clock, 24-hour, in the owner's zone. No zone in the record: the zone
 *  is one owner setting, so a day and a clock in a file mean the same thing on
 *  every device the owner uses. */
const timeSchema = z
  .string({ invalid_type_error: 'write it as "HH:MM"' })
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** YAML 1.1 is sexagesimal about anything with a colon in it, so an unquoted
 *  `time: 13:00` in a hand-edited file is resolved to the integer 780 and
 *  `time: 9:05` to 545, while `09:05` keeps its leading zero and stays a
 *  string.
 *
 *  A NUMBER IS REFUSED. `time: 905`, which is how somebody writes 9:05 with
 *  the colon left out, resolves to 905, and 905 is also exactly what `15:05`
 *  resolves to: by the time the value reaches this function there is nothing
 *  left in it that says which of the two was written. Reading it as minutes
 *  answered one of them with the other's clock and said nothing, and a
 *  reminder six hours off is worse than one that never fired. So every number
 *  falls through to the schema, whose reason says what to write instead.
 *
 *  A string is padded: `09:05` and a quoted `"9:05"` are both the ordinary way
 *  somebody writes this by hand, and neither is ambiguous. Anything else
 *  passes through untouched and the schema names it. */
const fromYamlTime = (value: unknown) => {
  if (typeof value !== "string") return value;
  const parts = /^(\d{1,2}):([0-5]\d)$/.exec(value);
  if (!parts) return value;
  const hour = Number(parts[1]);
  return hour > 23 ? value : `${pad2(hour)}:${parts[2]}`;
};

const timeField = z.preprocess(fromYamlTime, timeSchema);

export const taskAnchorSchema = z
  .object({
    /** `TaskLine.normalized`: the collapsed form the hash is taken over, and
     *  the form 3a's similarity pass compares against. Stored already
     *  normalized, so a raw double-spaced line cannot enter here and be
     *  compared against collapsed text forever after. The empty string is
     *  allowed: it is the line the template writes, `- [ ] <br />`. */
    text: z
      .string()
      .max(MAX_TASK_TEXT)
      .refine((value) => normalizeTaskText(value) === value, "must be normalized text"),
    /** First 16 hex of the sha1 of the normalized text (`task-lines.ts`). */
    hash: z.string().regex(/^[0-9a-f]{16}$/),
    /** Which occurrence of that text on the page, from 0. */
    ordinal: z.number().int().min(0).max(10_000),
    /** Zero-based line in the note's markdown when the anchor was written. */
    line: z.number().int().min(0).max(1_000_000),
  })
  .strict();

export const weekDaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

/** Three forms and no others: no interval, no yearly, no end date, no count.
 *  Every one of those is a rule somebody has to read off a row later, and the
 *  three here cover what a task list is for. */
export const taskRepeatSchema = z.discriminatedUnion("freq", [
  z.object({ freq: z.literal("daily") }).strict(),
  z
    .object({
      freq: z.literal("weekly"),
      byWeekday: z.array(weekDaySchema).min(1).max(7),
    })
    .strict(),
  z
    .object({
      freq: z.literal("monthly"),
      byMonthDay: z.number().int().min(1).max(31),
    })
    .strict(),
]);

/** One completed occurrence of a repeating task. Both halves are load-bearing:
 *  completing early gives an instance scheduled tomorrow a completion today,
 *  so the day it was due and the instant it was finished are two values.
 *  Untick pops the newest entry and restores `when` to its `scheduled`.
 *
 *  `scheduled` is exactly what `when` was, which is why it takes `when`'s own
 *  three shapes and not only a day. An untick has to be the completion read
 *  backwards: a repeat parked on `someday` that came back as a dated task, or
 *  an Inbox one that came back dated, would be the gesture changing something
 *  nobody asked it to. The word and the absence are both restored. */
export const taskLogEntrySchema = z
  .object({
    scheduled: z.union([dayField, z.literal("someday")]).optional(),
    /** The clock that instance carried, so a completion of a timed instance
     *  keeps its time in the log. */
    time: timeField.optional(),
    completedAt: instantField,
  })
  .strict();

/** The field list on its own, before the cross-field rules turn the schema
 *  into a `ZodEffects`. A route that wants a subset extends this rather than
 *  retyping the fields. */
export const taskRecordFields = z
  .object({
    id: idSchema,
    title: boundedText(MAX_TASK_TEXT),
    created: instantField,
    updated: instantField,
    /** Unlinked only. A linked task's completion lives in the note. */
    done: z.boolean().optional(),
    doneAt: instantField.optional(),
    /** The day it is meant for, or the word `someday`. */
    when: z.union([dayField, z.literal("someday")]).optional(),
    /** The clock on that day, `HH:MM`. Requires `when` to be a day. */
    time: timeField.optional(),
    /** The evening of that day. A section, not a clock: a task may carry both,
     *  an evening task with a 20:00 reminder. `true` or absent, because a
     *  `false` would be a second spelling of the absence. */
    evening: z.literal(true).optional(),
    /** When this instance's reminder fired. `advance()` clears it for the next
     *  instance, and editing `when` or `time` clears it so it fires again. */
    remindedAt: instantField.optional(),
    deadline: dayField.optional(),
    category: boundedText(200).optional(),
    /** The note that holds the checkbox, for a linked task. */
    page: idSchema.optional(),
    anchor: taskAnchorSchema.optional(),
    /** When the reconcile could no longer find this task's line. Detach keeps
     *  `page` and `anchor` so the row can read "line removed from ‹page›" and
     *  still say where the line was, and this instant is the mark that says
     *  the record, not a checkbox, now answers `done`. */
    detachedAt: instantField.optional(),
    repeat: taskRepeatSchema.optional(),
    /** The occurrences a repeating task has already completed. Logbook draws
     *  one row per entry. */
    log: z.array(taskLogEntrySchema).max(MAX_LOG_ENTRIES).optional(),
  })
  .strict();

/** The rules no single field can carry. Exported beside the object so an
 *  extended schema can re-apply them. */
export const taskRecordRules = (
  value: z.infer<typeof taskRecordFields>,
  ctx: z.RefinementCtx,
): void => {
  // A repeating task advances its own `when` on completion. A linked task
  // gets its completion from a checkbox that has no second occurrence, so
  // the two cannot both be true of one record (decision 14).
  if (value.repeat && value.page) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "repeat and page cannot both be set on one task",
      path: ["repeat"],
    });
  }
  // `log` outlives `repeat` on purpose. Stopping a repeat removes the rule and
  // keeps the instance as an ordinary task, and the completions it already has
  // are the Logbook's: up to thirty days of rows, including the one the person
  // may be looking at when they pick "Don't repeat". A rule that forced the
  // two to travel together made that gesture erase history, so there is no
  // rule here any more. A record with a log and no rule completes nothing
  // further; its entries are read-only history.
  // A detach names the note the line was removed from, so there is no such
  // thing as being detached from nothing.
  if (value.detachedAt !== undefined && !value.page) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "detachedAt requires page",
      path: ["detachedAt"],
    });
  }
  // And it requires a completion, because there is no checkbox left to ask.
  // A detached record read back with `done` undefined reads as reopened, and
  // a task somebody finished reappears in Today.
  if (value.detachedAt !== undefined && value.done === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a detached task owns its done",
      path: ["done"],
    });
  }
  // Writing it would create a second answer to "is this done?", and the
  // note's checkbox is the one a person edits. Only while the record is
  // linked: once `detachedAt` is set there is no checkbox left to ask, so the
  // record takes ownership of `done` exactly like an unlinked one. Without
  // that ownership a detached task comes back from disk with `done`
  // undefined, which reads as reopened.
  if (value.done !== undefined && value.page && value.detachedAt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "done is not stored for a linked task",
      path: ["done"],
    });
  }
  // A linked record is a pointer at one checkbox, and the anchor is the
  // pointer. Without it the reconcile has nothing to look for, so the record
  // detaches on the first write to its page: a task born broken, with no
  // checkbox to answer its `done` and no line to refresh its title. The
  // promote gesture is the only thing that mints a linked record and it
  // always knows the line, so the shape has no honest source. A DETACHED
  // record is exempt: it may have carried no anchor into the detach, and
  // refusing it now would make a record on disk unreadable.
  if (value.page !== undefined && value.anchor === undefined && value.detachedAt === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "page requires anchor",
      path: ["anchor"],
    });
  }
  // A time and an evening are both statements about a DAY. `someday` is the
  // explicit absence of one, and a record with neither has no day to put a
  // clock on, so both would name an instant nothing could compute.
  const onADay = typeof value.when === "string" && value.when !== "someday";
  if (value.time !== undefined && !onADay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "time needs a day to be a time on",
      path: ["time"],
    });
  }
  if (value.evening !== undefined && !onADay) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "the evening needs a day to be the evening of",
      path: ["evening"],
    });
  }
};

export const taskRecordSchema = taskRecordFields.superRefine(taskRecordRules);

export type TaskAnchor = z.infer<typeof taskAnchorSchema>;
export type WeekDay = z.infer<typeof weekDaySchema>;
export type TaskRepeat = z.infer<typeof taskRepeatSchema>;
export type TaskLogEntry = z.infer<typeof taskLogEntrySchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;

/** A record plus the completion a reader needs. For a linked task `done` is
 *  read from the note's checkbox and `title` from the task line, so a view is
 *  what every list, group and route works with. */
export interface TaskView extends Omit<TaskRecord, "done"> {
  done: boolean;
  /** The name a link visitor gave, when this task's completion came from
   *  their tick (spec row 145). Read from the note's own `updatedByName` at
   *  read time and never stored on the record: the note owns a linked task's
   *  `done`, so it owns who answered it too. Absent everywhere else. */
  updatedByName?: string;
}

/** Whether the note's checkbox still answers this record's `done`.
 *
 *  The one reading of the three shapes, because five copies of
 *  `page !== undefined` is how a detached record ends up linked in one of
 *  them. A detached record keeps its `page`, so `page` alone has not been the
 *  question since the detach rule landed.
 */
export function isLinkedTask(
  task: Pick<TaskRecord, "page" | "detachedAt">,
): boolean {
  return task.page !== undefined && task.detachedAt === undefined;
}

export type ParseTaskRecordResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: string };

/** A result, never a throw: a file Brain cannot read is still the person's
 *  file, so the index skips it with a warning and leaves it alone. */
export function parseTaskRecord(raw: unknown): ParseTaskRecordResult {
  const parsed = taskRecordSchema.safeParse(raw);
  if (parsed.success) return { ok: true, task: parsed.data };
  const issue = parsed.error.issues[0];
  const key = issue?.path.join(".");
  const message = issue?.message ?? "does not match the task record shape";
  return { ok: false, reason: key ? `${key}: ${message}` : message };
}
