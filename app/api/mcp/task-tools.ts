import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  getStore,
  isNotFound,
  isTaskConflict,
  isTaskValidation,
  type CreateTaskInput,
  type UpdateTaskPatch,
} from "@/lib/store";
import { appendMcpActivity } from "@/lib/mcp/activity-log";
import { readTimeZone } from "@/lib/owner-settings";
import { listOf } from "@/lib/tasks/lists";
import { TASK_ID_RE, isLinkedTask, taskRecordFields } from "@/lib/tasks/model";
import { normalizeTaskText, parseTaskLines } from "@/lib/tasks/task-lines";
import {
  clientNameOf,
  hasScope,
  insufficientScope,
  refusal,
  text,
} from "./tool-kit";

/** THE TASK TOOLS: TWO READS, SIX WRITES, ONE PROMOTE.
 *
 *  An agent owns tasks outright from 0.11.0. It used to own none of them, on
 *  the reasoning that an agent writes a checkbox line and the person promotes
 *  it, and that is still how a line becomes a record: `promote_task_line` is
 *  the editor's own gesture, building the editor's own anchor over the same
 *  markdown, so a line promoted by an agent and the same line promoted by a
 *  person are one record either way.
 *
 *  Nothing here reads a task's file. `lib/store` is the only writer of the
 *  notes filesystem and the only reader of a record, and the day arithmetic
 *  below is the caller's day and the caller's offset, never a clock inside
 *  `lib/tasks`.
 */

type McpToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

type ToolExtra = { authInfo?: { scopes: string[]; clientId?: string } };

const TASK_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Real UTC offsets run from -12:00 to +14:00. */
const MAX_OFFSET_MINUTES = 840;

/** Inbox is the one list that is a property of the record alone: no `when`,
 *  no `deadline`, not done. Every day gives the same answer, so a caller who
 *  asked only for the Inbox is not made to supply one. */
const ANY_DAY = "1970-01-01";

/** The record's own field parsers, reused rather than retyped, the way
 *  `app/api/tasks/shared.ts` reuses them. A rule that changes there changes
 *  here: `2026-02-31` is refused as a calendar day on both surfaces, and the
 *  200 character bound on a category is one bound. */
const fields = taskRecordFields.shape;

/** THE ONE FIELD THAT IS NOT THE RECORD'S OWN.
 *
 *  The record preprocesses `time` so a hand-edited YAML `time: 13:00`, which
 *  YAML 1.1 resolves to the integer 780, is read back as the clock somebody
 *  meant. That rescue exists for a person's own file. An agent sends JSON and
 *  has no such excuse, and `time: 905` comes back as 15:05 on purpose, so the
 *  tools take the written form and nothing else.
 */
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'write it as "HH:MM"');

const daySchema = z.string().regex(TASK_DAY_RE, "write it as YYYY-MM-DD");

const offsetSchema = z
  .number()
  .int()
  .min(-MAX_OFFSET_MINUTES)
  .max(MAX_OFFSET_MINUTES);

const NO_ZONE = "this list needs a day and no time zone is captured yet";
const NO_ZONE_REASON =
  "pass today as YYYY-MM-DD, or set the zone in Settings, Account";

/** A tool's answer and the one word the activity log records beside it. An
 *  outcome is a code a person scanning the log can group on, never the
 *  sentence the answer carries. */
interface TaskAnswer {
  answer: ReturnType<typeof text> & { isError?: boolean };
  outcome: string;
}

const ok = (data: unknown): TaskAnswer => ({ answer: text(data), outcome: "ok" });

const no = (outcome: string, error: string, reason?: string): TaskAnswer => ({
  answer: refusal(error, reason),
  outcome,
});

/** The store's three error classes, as answers an agent can act on.
 *
 *  `RecurrenceError` is deliberately absent: `advanceTaskUnlocked` turns it
 *  into a `TaskValidationError` before it leaves the store, so a branch for it
 *  here would be a branch nothing reaches.
 */
function taskRefusal(error: unknown): TaskAnswer {
  if (isTaskConflict(error)) {
    return {
      answer: {
        ...text({
          error: "conflict",
          reason: error.message,
          currentWhen: error.currentWhen,
        }),
        isError: true,
      },
      outcome: "conflict",
    };
  }
  if (isTaskValidation(error)) {
    return no("refused", "that task change was refused", error.message);
  }
  if (isNotFound(error)) return no("not_found", "not_found");
  throw error;
}

/** The ids one write touched. A tool fills them in as it learns them, so a
 *  create logs the record it minted and a refusal logs only what it knew.
 *  `change` is `update_task`'s own: the field names its patch carried, in the
 *  schema's own order, joined with "+". */
interface TaskMarks {
  task?: string;
  page?: string;
  change?: string;
}

async function logTaskWrite(
  extra: ToolExtra,
  tool: string,
  marks: TaskMarks,
  outcome: string,
): Promise<void> {
  // The grant's name is a nicety and the line is the record, so a state store
  // that cannot be read costs the name rather than the line.
  let client = "Unknown app";
  try {
    client = await clientNameOf(extra);
  } catch {
    client = "Unknown app";
  }
  try {
    await appendMcpActivity({
      at: new Date().toISOString(),
      client,
      tool,
      ...(marks.task !== undefined ? { task: marks.task } : {}),
      ...(marks.page !== undefined ? { page: marks.page } : {}),
      ...(marks.change !== undefined ? { change: marks.change } : {}),
      outcome,
    });
  } catch (cause) {
    // The write already landed. A log line that cannot be appended must not
    // turn a task that exists into a transport error, because the agent would
    // retry it and make a second one. Logged so a dropped line is at least
    // visible on the server's own console.
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[brain/mcp] task activity line dropped: ${reason}`);
  }
}

/** The log writes currently in flight. A write reads the state directory from
 *  the environment on its own turn, well after the tool's answer went out, so
 *  a test that swaps the directory between two writes needs a way to wait for
 *  the earlier one to land first. Nothing outside a test reads this. */
const pendingActivityWrites = new Set<Promise<void>>();

/** Waits for every task activity line in flight to land. A test's own
 *  `afterEach` calls this before it tears down the state directory the write
 *  reads, so a write a test fired is never orphaned into the next test's
 *  fresh one. */
export async function flushTaskActivityForTests(): Promise<void> {
  await Promise.all(pendingActivityWrites);
}

/** Every task write runs through here: the scope check, the store's refusals
 *  turned into readable ones, and one activity line whatever the outcome. The
 *  line is fire and forget: an agent waiting on a task write is not made to
 *  wait on the log append behind it too. */
async function taskWrite(
  extra: ToolExtra,
  tool: string,
  work: (marks: TaskMarks) => Promise<TaskAnswer>,
) {
  if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
  const marks: TaskMarks = {};
  let result: TaskAnswer;
  try {
    result = await work(marks);
  } catch (error) {
    result = taskRefusal(error);
  }
  const write = logTaskWrite(extra, tool, marks, result.outcome);
  pendingActivityWrites.add(write);
  void write.finally(() => pendingActivityWrites.delete(write));
  return result.answer;
}

/** The owner's own day and UTC offset, from the one zone this instance has
 *  captured. `Intl` is the whole calendar: a zone's offset moves twice a year,
 *  so a stored number would be wrong for half of it. Null for a zone the
 *  platform cannot read, which is the same answer as no zone at all. */
export function dayInZone(
  zone: string,
  now: Date,
): { today: string; offsetMinutes: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const numbers = (["year", "month", "day", "hour", "minute", "second"] as const).map(
    (type) => Number(value(type)),
  );
  if (numbers.some((part) => Number.isNaN(part))) return null;
  const [year, month, day, hour, minute, second] = numbers;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  return {
    today: `${value("year")}-${value("month")}-${value("day")}`,
    offsetMinutes: Math.round((wall - now.getTime()) / 60_000),
  };
}

/** The day a derived list is read against, and the offset a completion's day
 *  is computed with. The caller's own values come first: an agent that knows
 *  the person it is working for is a better answer than a stored zone. The
 *  zone is the fallback, and it is the only clock Brain has of its own. */
async function callerDay(
  today: string | undefined,
  offsetMinutes: number | undefined,
): Promise<{ today: string | null; offsetMinutes: number | undefined }> {
  if (today !== undefined && offsetMinutes !== undefined) {
    return { today, offsetMinutes };
  }
  const zone = await readTimeZone();
  const derived = zone === null ? null : dayInZone(zone, new Date());
  return {
    today: today ?? derived?.today ?? null,
    offsetMinutes: offsetMinutes ?? derived?.offsetMinutes,
  };
}

/** The page's own category, the way the editor's promote reads one. An empty
 *  string is no category, which is what `pageCategory` in
 *  `components/editor/task-checkbox.ts` answers too. */
function categoryOf(meta: unknown): string | undefined {
  const value = (meta as { category?: unknown } | null)?.category;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function registerTaskTools(server: McpToolServer): void {
  server.tool(
    "list_tasks",
    "List the tasks of one list, or every record on one note. Pass the caller's own local calendar date as `today`; leave it out and Brain uses the owner's own time zone. Every list but `logbook` answers `{tasks}`, one record each; `logbook` answers `{entries}`, one per completion, because a repeating task has many completions and one record, and each entry carries its own `key`. A completion stays in the list it was in until the day changes, so pass `offsetMinutes` to read the day the way the owner does.",
    {
      list: z
        .enum(["inbox", "today", "upcoming", "someday", "logbook"])
        .optional(),
      page: z
        .string()
        .optional()
        .describe("one note's records, complete, instead of a list"),
      today: z
        .string()
        .optional()
        .describe("YYYY-MM-DD; the owner's own zone is used when it is left out"),
      offsetMinutes: offsetSchema
        .optional()
        .describe(
          "the caller's own UTC offset in minutes, east positive, required for the logbook",
        ),
      category: z.string().optional(),
    },
    async ({ list, page, today, offsetMinutes, category }) => {
      // The page branch runs before every other check because it answers a
      // different question. `pageTasks` is a lookup and not a list: it takes no
      // day, drops nothing hidden and does not stop at the Logbook window,
      // because the editor draws a word on every task line of the note
      // whatever state that line's record is in. The four refusals below are
      // the HTTP route's own (`app/api/tasks/shared.ts` `refusePageQuery`), so
      // the two surfaces answer "what does this note own" the same way.
      if (page !== undefined) {
        if (today !== undefined) {
          return refusal(
            "page answers every record on one note, so it takes no day",
            "unexpected_today",
          );
        }
        if (offsetMinutes !== undefined) {
          return refusal(
            "page answers every record on one note, so it takes no offset",
            "unexpected_offset",
          );
        }
        if (list !== undefined) {
          return refusal(
            "page answers every record on one note, so it takes no list",
            "unexpected_list",
          );
        }
        if (category !== undefined) {
          return refusal(
            "page answers every record on one note, so it takes no category",
            "unexpected_category",
          );
        }
        if (!TASK_ID_RE.test(page)) return refusal("bad_page");
        const store = await getStore();
        return text({ tasks: store.pageTasks(page) });
      }
      if (list === undefined) {
        return refusal("name one list, or one page", "missing_list");
      }
      if (today !== undefined && !TASK_DAY_RE.test(today)) {
        return refusal("bad_today");
      }
      if (list === "inbox") {
        const store = await getStore();
        return text({
          tasks: store.listTasks(today ?? ANY_DAY, {
            list,
            ...(offsetMinutes !== undefined ? { offsetMinutes } : {}),
            ...(category !== undefined ? { category } : {}),
          }),
        });
      }
      const day = await callerDay(today, offsetMinutes);
      if (day.today === null) return refusal(NO_ZONE, NO_ZONE_REASON);
      // `doneAt` is one UTC instant and the Logbook day it falls on is the
      // caller's, so the logbook cannot be answered without their offset.
      if (list === "logbook" && day.offsetMinutes === undefined) {
        return refusal("bad_offset");
      }
      const store = await getStore();
      // THE LOGBOOK IS ENTRIES, NOT RECORDS. A repeating task finished on
      // seven days is seven completions of ONE record, so a list of records
      // answers with seven objects carrying the same `id`. Each entry is
      // handed over with its own stable `key` instead.
      if (list === "logbook") {
        return text({
          entries: store.listLogbook(day.today, {
            offsetMinutes: day.offsetMinutes as number,
            ...(category !== undefined ? { category } : {}),
          }),
        });
      }
      return text({
        tasks: store.listTasks(day.today, {
          list,
          ...(day.offsetMinutes !== undefined
            ? { offsetMinutes: day.offsetMinutes }
            : {}),
          ...(category !== undefined ? { category } : {}),
        }),
      });
    },
  );

  server.tool(
    "get_task",
    "Read one task record, including whether its note line was removed and which page it is linked to.",
    { id: z.string() },
    async ({ id }) => {
      if (!TASK_ID_RE.test(id)) return refusal("bad_id");
      const store = await getStore();
      const task = store.getTask(id);
      if (!task) return refusal("not_found");
      // A trashed page's tasks are hidden from every list, so reading one by
      // id answers the same way rather than handing back a row the surface
      // would never show.
      if (store.taskPageTrashed(id)) return refusal("page_trashed");
      return text({ task });
    },
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Make a task. It is unlinked: it owns its own completion and belongs to no note. To turn a checkbox line of a note into a task, use promote_task_line. `time` and `evening` are statements about a day, so both need `when` to be a day rather than `someday`.",
      inputSchema: z
        .object({
          title: fields.title,
          when: fields.when,
          time: timeSchema.optional(),
          evening: fields.evening,
          deadline: fields.deadline,
          category: fields.category,
          repeat: fields.repeat,
        })
        .strict(),
    },
    async ({ title, when, time, evening, deadline, category, repeat }, extra) =>
      taskWrite(extra, "create_task", async (marks) => {
        const store = await getStore();
        const input: CreateTaskInput = {
          title,
          ...(when !== undefined ? { when } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(evening !== undefined ? { evening } : {}),
          ...(deadline !== undefined ? { deadline } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(repeat !== undefined ? { repeat } : {}),
          src: "claude",
        };
        const task = await store.createTask(input);
        marks.task = task.id;
        return ok({ task });
      }),
  );

  server.registerTool(
    "promote_task_line",
    {
      description:
        "Turn one checkbox line of a note into a task linked to that line. `line` is a zero-based markdown line number, or the line's own text with runs of whitespace collapsed. The note's category is inherited unless one is named here. The line keeps owning the task's title and its completion. Takes no `rev`: the anchor is built from the note as read a moment before the record is made, the same window the editor's own promote gesture has, and a later edit to the line is repaired on the next reconcile.",
      inputSchema: z
        .object({
          page: z.string(),
          line: z.union([
            z.number().int().min(0).max(1_000_000),
            z.string().min(1),
          ]),
          when: fields.when,
          time: timeSchema.optional(),
          evening: fields.evening,
          deadline: fields.deadline,
          category: fields.category,
        })
        .strict(),
    },
    async ({ page, line, when, time, evening, deadline, category }, extra) =>
      taskWrite(extra, "promote_task_line", async (marks) => {
        if (!TASK_ID_RE.test(page)) return no("bad_page", "bad_page");
        marks.page = page;
        const store = await getStore();
        // THE SAME ANCHOR THE EDITOR BUILDS, from the same function over the
        // same markdown. `components/editor/task-checkbox.ts:1194-1234` is the
        // reference: a second normalisation here is how the two ends of a
        // reconcile start to disagree about which line is which task.
        const note = await store.readPage(page);
        const lines = parseTaskLines(note.markdown);
        const found =
          typeof line === "number"
            ? lines.filter((candidate) => candidate.index === line)
            : lines.filter(
                (candidate) => candidate.normalized === normalizeTaskText(line),
              );
        if (found.length === 0) {
          return no("no_line", "that line is not a checkbox", `line ${line}`);
        }
        if (found.length > 1) {
          return no(
            "ambiguous_line",
            "that line appears more than once, pass its line number",
            `lines ${found.map((candidate) => candidate.index).join(", ")}`,
          );
        }
        const target = found[0];
        if (target.normalized === "") {
          return no("empty_line", "that line is empty", "write the line first");
        }
        const owner = store
          .pageTasks(page)
          .find(
            (task) => isLinkedTask(task) && task.anchor?.line === target.index,
          );
        if (owner) {
          return no("already_linked", "that line already has a task", owner.id);
        }
        // `hashTaskText` is not called here: `parseTaskLines` already put the
        // hash on the line, and taking it again would be a second place that
        // could disagree about which bytes were hashed.
        const inheritedCategory = categoryOf(note.meta);
        const task = await store.createTask({
          title: target.normalized,
          page,
          anchor: {
            text: target.normalized,
            hash: target.hash,
            ordinal: target.ordinal,
            line: target.index,
          },
          ...(when !== undefined ? { when } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(evening !== undefined ? { evening } : {}),
          ...(deadline !== undefined ? { deadline } : {}),
          // The caller's own category wins; the note's is what the same
          // gesture in the editor inherits, and a line promoted two ways has
          // to land in one place.
          ...(category !== undefined
            ? { category }
            : inheritedCategory !== undefined
              ? { category: inheritedCategory }
              : {}),
          src: "claude",
        });
        marks.task = task.id;
        return ok({ task });
      }),
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Change one task. A field left out is left alone and `null` clears it. `when` takes a day, the word `someday`, or null for the Inbox. `time` and `evening` are statements about a day, so a change that parks the task or sends it back to the Inbox clears both whether or not they are named here. Clearing `time` is also how a reminder is stopped.",
      inputSchema: z
        .object({
          id: z.string(),
          title: fields.title.optional(),
          when: fields.when.nullable(),
          time: timeSchema.nullable().optional(),
          evening: fields.evening.nullable(),
          deadline: fields.deadline.nullable(),
          category: fields.category.nullable(),
          repeat: fields.repeat.nullable(),
        })
        .strict(),
    },
    async (
      { id, title, when, time, evening, deadline, category, repeat },
      extra,
    ) =>
      taskWrite(extra, "update_task", async (marks) => {
        if (!TASK_ID_RE.test(id)) return no("bad_id", "bad_id");
        marks.task = id;
        const store = await getStore();
        const patch: UpdateTaskPatch = {
          ...(title !== undefined ? { title } : {}),
          ...(when !== undefined ? { when } : {}),
          ...(time !== undefined ? { time } : {}),
          ...(evening !== undefined ? { evening } : {}),
          ...(deadline !== undefined ? { deadline } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(repeat !== undefined ? { repeat } : {}),
          src: "claude",
        };
        // The field names the patch carries, in the schema's own order
        // (`Object.keys` walks a string-keyed object in insertion order), so
        // a person scanning the log can tell a retitle from a reschedule
        // without opening the record.
        marks.change = Object.keys(patch)
          .filter((key) => key !== "src")
          .join("+");
        return ok({ task: await store.updateTask(id, patch) });
      }),
  );

  server.registerTool(
    "complete_task",
    {
      description:
        "Tick one task. `today` is the caller's own local calendar date and is required: it files the completion under that day in the Logbook and the server has no timezone of the caller's to fall back on. A completion stays in the list it was in, struck through, until the day changes, which is what the answer's `list` says. `expectedWhen` is the `when` the caller was looking at, and only a repeating task's completion is refused against it.",
      inputSchema: z
        .object({
          id: z.string(),
          today: daySchema,
          offsetMinutes: offsetSchema
            .optional()
            .describe("the caller's own UTC offset in minutes, east positive"),
          expectedWhen: fields.when.nullable(),
        })
        .strict(),
    },
    async ({ id, today, offsetMinutes, expectedWhen }, extra) =>
      taskWrite(extra, "complete_task", async (marks) => {
        if (!TASK_ID_RE.test(id)) return no("bad_id", "bad_id");
        marks.task = id;
        const store = await getStore();
        const task = await store.updateTask(id, {
          done: true,
          today,
          ...(expectedWhen !== undefined ? { expectedWhen } : {}),
          src: "claude",
        });
        // The caller's own offset when it gave one, else the owner's zone
        // through the same fallback list_tasks uses, never a bare UTC 0: a
        // completion near local midnight would read the wrong day under it.
        const day = await callerDay(today, offsetMinutes);
        return ok({ task, list: listOf(task, today, day.offsetMinutes) });
      }),
  );

  server.registerTool(
    "reopen_task",
    {
      description:
        "Untick one task. `today` is the caller's own local calendar date and is required, for the same reason a completion needs one. Unticking a repeating task restores the instance its newest completion came from.",
      inputSchema: z
        .object({
          id: z.string(),
          today: daySchema,
          offsetMinutes: offsetSchema
            .optional()
            .describe("the caller's own UTC offset in minutes, east positive"),
        })
        .strict(),
    },
    async ({ id, today, offsetMinutes }, extra) =>
      taskWrite(extra, "reopen_task", async (marks) => {
        if (!TASK_ID_RE.test(id)) return no("bad_id", "bad_id");
        marks.task = id;
        const store = await getStore();
        const task = await store.updateTask(id, {
          done: false,
          today,
          src: "claude",
        });
        // `listOf` does not read the offset once `done` is false, but the
        // same fallback as complete_task keeps the two answers derived one
        // way rather than two.
        const day = await callerDay(today, offsetMinutes);
        return ok({ task, list: listOf(task, today, day.offsetMinutes) });
      }),
  );

  server.registerTool(
    "delete_task",
    {
      description:
        "Delete one task record. A linked task's checkbox line stays in its note; the record that pointed at it is what goes.",
      inputSchema: z.object({ id: z.string() }).strict(),
    },
    async ({ id }, extra) =>
      taskWrite(extra, "delete_task", async (marks) => {
        if (!TASK_ID_RE.test(id)) return no("bad_id", "bad_id");
        marks.task = id;
        const store = await getStore();
        await store.deleteTask(id, "claude");
        return ok({ ok: true });
      }),
  );
}
