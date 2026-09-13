import { z } from "zod";

/** A task record as it lives in the frontmatter of `_tasks/<id>.md`.
 *
 *  Two shapes share one schema. An UNLINKED task is its own record and owns
 *  its `done`. A LINKED task points at a checkbox in a note through `page`
 *  and `anchor`, and its `done` is never written here: the checkbox in the
 *  note is the truth, and a second copy of it would be a second source of
 *  truth to drift.
 *
 *  Nothing in this file reads the clock, the filesystem or a Store. It is the
 *  shape only, so the editor, the store and the routes can all agree on it.
 */

/** The id rule is the page id rule (`app/api/move/route.ts:6`), because a task
 *  id reaches a path the same way a page id does and the store's own copy is
 *  module-private. No dot, so no `..`; no slash, so no traversal. */
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const MAX_TASK_TEXT = 2000;
const MAX_LOG_ENTRIES = 1000;

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/, "control characters are not allowed");

const idSchema = z.string().regex(TASK_ID_RE);

/** A calendar day. Compared as a string everywhere, never through `Date`. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** An instant. The store writes `new Date().toISOString()`; a hand edit may
 *  leave the milliseconds or the seconds off. */
const instantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/);

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

export const taskAnchorSchema = z
  .object({
    /** The task line's text as it read when the anchor was written. */
    text: z.string().max(MAX_TASK_TEXT),
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

export const taskRecordSchema = z
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
    deadline: dayField.optional(),
    category: boundedText(200).optional(),
    /** The note that holds the checkbox, for a linked task. */
    page: idSchema.optional(),
    anchor: taskAnchorSchema.optional(),
    repeat: taskRepeatSchema.optional(),
    /** The occurrence days a repeating task has already completed. */
    log: z.array(dayField).max(MAX_LOG_ENTRIES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
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
    if (value.log && !value.repeat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "log belongs to a repeating task",
        path: ["log"],
      });
    }
    // Writing it would create a second answer to "is this done?", and the
    // note's checkbox is the one a person edits.
    if (value.done !== undefined && value.page) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "done is not stored for a linked task",
        path: ["done"],
      });
    }
  });

export type TaskAnchor = z.infer<typeof taskAnchorSchema>;
export type WeekDay = z.infer<typeof weekDaySchema>;
export type TaskRepeat = z.infer<typeof taskRepeatSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;

/** A record plus the completion a reader needs. For a linked task `done` is
 *  read from the note's checkbox and `title` from the task line, so a view is
 *  what every list, group and route works with. */
export interface TaskView extends Omit<TaskRecord, "done"> {
  done: boolean;
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
