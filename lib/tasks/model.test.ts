import { describe, expect, it } from "vitest";

import {
  parseTaskRecord,
  taskLogEntrySchema,
  taskRecordFields,
  taskRecordSchema,
  TASK_ID_RE,
} from "./model";

/** The four required keys, so a case below carries only the key it is about. */
const base = {
  id: "task-alpha",
  title: "Water the plants",
  created: "2026-09-13T09:00:00.000Z",
  updated: "2026-09-13T09:00:00.000Z",
};

describe("the task record schema", () => {
  it("accepts a linked task with an anchor and no done key", () => {
    const parsed = taskRecordSchema.safeParse({
      ...base,
      page: "page-garden",
      anchor: {
        text: "Water the plants",
        hash: "0123456789abcdef",
        ordinal: 0,
        line: 12,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an unlinked repeating task with a log", () => {
    const parsed = taskRecordSchema.safeParse({
      ...base,
      id: "task-repeat-daily",
      when: "2026-09-13",
      repeat: { freq: "daily" },
      log: [
        { scheduled: "2026-09-11", completedAt: "2026-09-11T21:04:55.108Z" },
        { scheduled: "2026-09-12", completedAt: "2026-09-12T21:04:55.108Z" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a log entry missing completedAt, and a bare day in place of an entry", () => {
    const repeat = { freq: "daily" };
    const refused = [
      [{ scheduled: "2026-09-11" }],
      ["2026-09-11"],
      [{ scheduled: "2026-09-11", completedAt: "2026-09-11T21:04:55.108Z", note: "x" }],
      [{ scheduled: "tomorrow", completedAt: "2026-09-11T21:04:55.108Z" }],
      [{ scheduled: "2026-02-31", completedAt: "2026-09-11T21:04:55.108Z" }],
    ];
    for (const log of refused) {
      expect(taskRecordSchema.safeParse({ ...base, repeat, log }).success).toBe(false);
    }
  });

  it("takes `when`'s own three shapes as a log entry's scheduled day", () => {
    // The untick restores `when` from `scheduled`, so `scheduled` has to be
    // able to hold exactly what `when` held: a day, the word `someday`, or
    // nothing at all for a task that was in the Inbox. Anything narrower makes
    // the gesture move a task nobody asked it to move.
    const repeat = { freq: "daily" };
    const completedAt = "2026-09-11T21:04:55.108Z";
    for (const entry of [
      { scheduled: "2026-09-11", completedAt },
      { scheduled: "someday", completedAt },
      { completedAt },
    ]) {
      const parsed = parseTaskRecord({ ...base, repeat, log: [entry] });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.task.log?.[0]).toEqual(entry);
    }
  });

  it("keeps the two halves of a log entry apart, because completing early splits them", () => {
    const parsed = parseTaskRecord({
      ...base,
      when: "2026-09-14",
      repeat: { freq: "daily" },
      log: [{ scheduled: "2026-09-14", completedAt: "2026-09-13T21:04:55.108Z" }],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.task.log?.[0]).toEqual({
        scheduled: "2026-09-14",
        completedAt: "2026-09-13T21:04:55.108Z",
      });
    }
  });

  it("refuses a repeat on a linked task", () => {
    const parsed = parseTaskRecord({
      ...base,
      page: "page-garden",
      repeat: { freq: "daily" },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("repeat");
  });

  it("keeps a log after the rule that made it is gone", () => {
    // Stopping a repeat removes the rule and keeps the instance as an
    // ordinary task. Its completions are the Logbook's, up to thirty days of
    // rows including the one the person may be looking at when they pick
    // "Don't repeat", so the log outlives the rule rather than going with it.
    const parsed = parseTaskRecord({
      ...base,
      when: "2026-09-13",
      log: [{ scheduled: "2026-09-12", completedAt: "2026-09-12T21:04:55.108Z" }],
    });
    expect(parsed.ok).toBe(true);
  });

  it("still refuses a log that is not a list of entries", () => {
    const parsed = parseTaskRecord({ ...base, log: ["2026-09-12"] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("log");
  });

  it("refuses a when that is neither a date nor the word someday", () => {
    expect(taskRecordSchema.safeParse({ ...base, when: "tomorrow" }).success).toBe(
      false,
    );
    expect(taskRecordSchema.safeParse({ ...base, when: "2026-9-13" }).success).toBe(
      false,
    );
    expect(taskRecordSchema.safeParse({ ...base, when: "someday" }).success).toBe(
      true,
    );
  });

  it("refuses freq: yearly, an interval, an until and a count", () => {
    const refused = [
      { freq: "yearly" },
      { freq: "daily", interval: 2 },
      { freq: "daily", until: "2026-12-31" },
      { freq: "daily", count: 10 },
    ];
    for (const repeat of refused) {
      expect(taskRecordSchema.safeParse({ ...base, repeat }).success).toBe(false);
    }
  });

  it("refuses a byMonthDay of 0 and of 32", () => {
    for (const byMonthDay of [0, 32, 1.5]) {
      expect(
        taskRecordSchema.safeParse({
          ...base,
          repeat: { freq: "monthly", byMonthDay },
        }).success,
      ).toBe(false);
    }
    expect(
      taskRecordSchema.safeParse({
        ...base,
        repeat: { freq: "monthly", byMonthDay: 31 },
      }).success,
    ).toBe(true);
  });

  it("refuses an id with a slash, a dot-dot, or 129 characters", () => {
    for (const id of ["task/alpha", "..", "../task-alpha", "a".repeat(129), ""]) {
      expect(taskRecordSchema.safeParse({ ...base, id }).success).toBe(false);
      expect(TASK_ID_RE.test(id)).toBe(false);
    }
    expect(taskRecordSchema.safeParse({ ...base, id: "a".repeat(128) }).success).toBe(
      true,
    );
  });

  it("keeps an unknown frontmatter key out rather than passing it through", () => {
    const parsed = parseTaskRecord({ ...base, priority: "high" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("priority");
  });

  it("refuses a done on a linked task, because the note's checkbox is the truth", () => {
    const parsed = parseTaskRecord({ ...base, page: "page-garden", done: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("done");
  });

  it("reads a YAML date back as the string the file meant", () => {
    // gray-matter hands an unquoted `when: 2026-09-13` over as a Date. A
    // hand-edited file is the ordinary way to reach this, so the record takes
    // the Date and keeps the day it names.
    const parsed = parseTaskRecord({
      ...base,
      created: new Date("2026-09-13T09:00:00.000Z"),
      when: new Date("2026-09-20T00:00:00.000Z"),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.task.created).toBe("2026-09-13T09:00:00.000Z");
      expect(parsed.task.when).toBe("2026-09-20");
    }
  });

  it("names the failing key in the reason, so a skipped file can be explained", () => {
    const parsed = parseTaskRecord({ ...base, deadline: "not a date" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("deadline");
  });

  it("refuses a day the calendar does not have", () => {
    for (const deadline of [
      "2026-02-31",
      "2026-13-45",
      "2026-00-10",
      "2026-04-31",
      "2027-02-29",
      "2026-09-32",
    ]) {
      expect(taskRecordSchema.safeParse({ ...base, deadline }).success).toBe(false);
    }
    // 2028 is a leap year and 2000 was one, 1900 was not.
    expect(taskRecordSchema.safeParse({ ...base, deadline: "2028-02-29" }).success).toBe(
      true,
    );
    expect(taskRecordSchema.safeParse({ ...base, deadline: "1900-02-29" }).success).toBe(
      false,
    );
  });

  it("refuses an instant that is not UTC, because the logbook orders on the string", () => {
    for (const doneAt of [
      "2026-09-13T23:00:00+04:00",
      "2026-09-13T23:00:00",
      "2026-09-13",
      "2026-09-13T99:99Z",
      "2026-09-13T24:00:00Z",
    ]) {
      expect(taskRecordSchema.safeParse({ ...base, done: true, doneAt }).success).toBe(
        false,
      );
    }
    expect(
      taskRecordSchema.safeParse({
        ...base,
        done: true,
        doneAt: "2026-09-13T21:04:55.108Z",
      }).success,
    ).toBe(true);
  });

  it("accepts an empty anchor text, the line the template writes", () => {
    const parsed = taskRecordSchema.safeParse({
      ...base,
      page: "page-garden",
      anchor: { text: "", hash: "0123456789abcdef", ordinal: 0, line: 4 },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an anchor text that is not already normalized", () => {
    // The anchor stores `TaskLine.normalized`. 3a's similarity pass compares
    // normalized to normalized, so a raw double-spaced form stored here would
    // be compared against collapsed text for the rest of the record's life.
    for (const text of ["a  b", " a b", "a b ", "a <br /> b"]) {
      const parsed = parseTaskRecord({
        ...base,
        page: "page-garden",
        anchor: { text, hash: "0123456789abcdef", ordinal: 0, line: 4 },
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toContain("text");
    }
    expect(
      taskRecordSchema.safeParse({
        ...base,
        page: "page-garden",
        anchor: { text: "a b", hash: "0123456789abcdef", ordinal: 0, line: 4 },
      }).success,
    ).toBe(true);
  });

  it("still extends, so a route can take a subset of the same fields", () => {
    const patch = taskRecordFields
      .omit({ id: true, created: true, updated: true })
      .partial()
      .strict();
    expect(patch.safeParse({ when: "2026-09-20" }).success).toBe(true);
    expect(patch.safeParse({ when: "tomorrow" }).success).toBe(false);
    expect(patch.safeParse({ priority: "high" }).success).toBe(false);
    expect(taskRecordFields.extend({ rev: taskRecordFields.shape.id }).safeParse({
      ...base,
      rev: "rev-1",
    }).success).toBe(true);
  });
});

/** The detach rule (spec amendment `4785ca7`). Detach does not clear `page`
 *  and `anchor`: it stamps `detachedAt`, so the row can still read "line
 *  removed from ‹page›" and the record can still say where the line was.
 *
 *  That makes three shapes out of two, and the difference between them is a
 *  question about `done`. Linked means the note's checkbox answers it.
 *  Detached and unlinked both mean the record answers it. */
describe("the three shapes a task record takes", () => {
  const anchor = {
    text: "Water the plants",
    hash: "0123456789abcdef",
    ordinal: 0,
    line: 12,
  };
  const DETACHED_AT = "2026-09-13T10:32:00.000Z";
  const DONE_AT = "2026-09-13T10:31:00.000Z";

  const cases: {
    shape: string;
    record: Record<string, unknown>;
    ok: boolean;
    reason?: string;
  }[] = [
    {
      shape: "linked: a page, no detachedAt, and the note owns done",
      record: { page: "page-garden", anchor },
      ok: true,
    },
    {
      shape: "linked: done is refused, because the checkbox already answers it",
      record: { page: "page-garden", anchor, done: true },
      ok: false,
      reason: "done",
    },
    {
      shape: "detached: a page, an anchor, a detachedAt, and its own done",
      record: {
        page: "page-garden",
        anchor,
        detachedAt: DETACHED_AT,
        done: true,
        doneAt: DONE_AT,
      },
      ok: true,
    },
    {
      shape: "detached: an open one, done false and no doneAt",
      record: { page: "page-garden", anchor, detachedAt: DETACHED_AT, done: false },
      ok: true,
    },
    {
      shape: "detached: the anchor may be gone, the page may not",
      record: { page: "page-garden", detachedAt: DETACHED_AT, done: false },
      ok: true,
    },
    {
      // The promote gesture is the only thing that mints a linked record, and
      // it always knows the line. A record that names a page and no line is a
      // task born broken: the first reconcile detaches it, so it never
      // reaches a checkbox and never gets a title back from one.
      shape: "linked with no anchor is not a shape: the anchor is the link",
      record: { page: "page-garden" },
      ok: false,
      reason: "page requires anchor",
    },
    {
      shape: "detachedAt without a page is not a shape: there is no page to name",
      record: { detachedAt: DETACHED_AT, done: true, doneAt: DONE_AT },
      ok: false,
      // The rule's own message. Asserting "detachedAt" alone was satisfied by
      // the strict-key refusal from before the field existed, so the case was
      // green against a schema that had never heard of it.
      reason: "requires page",
    },
    {
      shape: "detached with no done is not a shape: it owns one now",
      record: { page: "page-garden", anchor, detachedAt: DETACHED_AT },
      ok: false,
      reason: "a detached task owns its done",
    },
    {
      shape: "repeat is refused on a detached record too, not only a linked one",
      record: {
        page: "page-garden",
        detachedAt: DETACHED_AT,
        done: false,
        repeat: { freq: "daily" },
      },
      ok: false,
      reason: "repeat",
    },
    {
      shape: "unlinked: no page, no detachedAt, and its own done",
      record: { done: true, doneAt: DONE_AT },
      ok: true,
    },
  ];

  for (const { shape, record, ok, reason } of cases) {
    it(shape, () => {
      const parsed = parseTaskRecord({ ...base, ...record });
      expect(parsed.ok).toBe(ok);
      if (!parsed.ok && reason) expect(parsed.reason).toContain(reason);
    });
  }

  it("keeps page and anchor through a detach, so the row can name the note", () => {
    const parsed = parseTaskRecord({
      ...base,
      page: "page-garden",
      anchor,
      detachedAt: DETACHED_AT,
      done: true,
      doneAt: DONE_AT,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.task.page).toBe("page-garden");
      expect(parsed.task.anchor).toEqual(anchor);
      expect(parsed.task.detachedAt).toBe(DETACHED_AT);
      expect(parsed.task.done).toBe(true);
    }
  });

  it("refuses a detachedAt that is a day, a local offset, or an hour that is not one", () => {
    for (const detachedAt of [
      "2026-09-13",
      "2026-09-13T10:32:00+04:00",
      "2026-09-13T10:32:00",
      "2026-09-13T24:00:00Z",
      "2026-02-31T10:32:00Z",
    ]) {
      expect(
        taskRecordSchema.safeParse({ ...base, page: "page-garden", detachedAt })
          .success,
      ).toBe(false);
    }
  });

  it("reads a YAML date back as the instant the file meant", () => {
    const parsed = parseTaskRecord({
      ...base,
      page: "page-garden",
      done: false,
      detachedAt: new Date("2026-09-13T10:32:00.000Z"),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.task.detachedAt).toBe("2026-09-13T10:32:00.000Z");
  });
});

describe("the clock on a record", () => {
  const base = {
    id: "task-alpha",
    title: "Water the plants",
    created: "2026-09-13T09:00:00.000Z",
    updated: "2026-09-13T09:00:00.000Z",
  };

  it("accepts a day with a time and an evening", () => {
    const parsed = parseTaskRecord({
      ...base,
      when: "2026-09-13",
      time: "13:00",
      evening: true,
    });
    expect(parsed).toMatchObject({ ok: true });
  });

  it("refuses a time on a task with no day", () => {
    expect(parseTaskRecord({ ...base, time: "13:00" })).toEqual({
      ok: false,
      reason: "time: time needs a day to be a time on",
    });
  });

  it("refuses a time on a someday task", () => {
    expect(parseTaskRecord({ ...base, when: "someday", time: "13:00" })).toEqual({
      ok: false,
      reason: "time: time needs a day to be a time on",
    });
  });

  it("refuses an evening with no day", () => {
    expect(parseTaskRecord({ ...base, evening: true })).toEqual({
      ok: false,
      reason: "evening: the evening needs a day to be the evening of",
    });
  });

  it("refuses an evening on a someday task", () => {
    expect(parseTaskRecord({ ...base, when: "someday", evening: true })).toEqual({
      ok: false,
      reason: "evening: the evening needs a day to be the evening of",
    });
  });

  it("refuses evening: false, because the absence is the only other state", () => {
    const parsed = parseTaskRecord({ ...base, when: "2026-09-13", evening: false });
    expect(parsed.ok).toBe(false);
  });

  it.each([["24:00"], ["09:60"], ["9:5"], ["13"], ["13:00:00"], [""]])(
    "refuses %s as a time",
    (time) => {
      expect(parseTaskRecord({ ...base, when: "2026-09-13", time }).ok).toBe(false);
    },
  );

  it.each([["00:00"], ["09:05"], ["13:00"], ["23:59"]])("accepts %s", (time) => {
    expect(parseTaskRecord({ ...base, when: "2026-09-13", time }).ok).toBe(true);
  });

  /** EVERY WAY A PERSON WRITES A CLOCK BY HAND.
   *
   *  YAML 1.1 is sexagesimal about anything with a colon in it, so an unquoted
   *  `time: 13:00` reaches the schema as the integer 780 and `time: 9:05` as
   *  545. Both are read back as the clock they were written as. A leading zero
   *  (`09:05`) and any quoted form arrive as text and are kept.
   *
   *  The one shape nothing can disambiguate is a bare `time: 905`, typed by
   *  somebody leaving the colon out of 9:05: it is the same 905 that `15:05`
   *  resolves to, and it reads back as 15:05. Refusing it is the worse trade,
   *  because the same refusal would fall on every unquoted `time: 13:00` and
   *  the index skips a record it refuses, losing the whole task over a pair of
   *  quotes. Brain's own files never reach the shape at all: the serializer
   *  writes the quoted form (`time: '13:00'`), so only a hand edit can make it.
   *
   *  Past the end of the day there is no clock to read, and the reason says
   *  what to write instead.
   */
  it.each<[string, unknown, string | null]>([
    ["905", 905, "15:05"],
    ["9:05", 545, "09:05"],
    ["13:00", 780, "13:00"],
    ["13:00:00", 46_800, null],
    ["1440", 1440, null],
    ["09:05", "09:05", "09:05"],
    ['"9:05"', "9:05", "09:05"],
    ['"13:00"', "13:00", "13:00"],
    ['"24:00"', "24:00", null],
  ])("reads a hand-edited time: %s", (_written, time, expected) => {
    const parsed = parseTaskRecord({ ...base, when: "2026-09-13", time });

    if (expected === null) {
      expect(parsed).toEqual({ ok: false, reason: 'time: write it as "HH:MM"' });
    } else {
      expect(parsed).toMatchObject({ ok: true, task: { time: expected } });
    }
  });

  it("accepts remindedAt as a UTC instant and refuses a local one", () => {
    expect(
      parseTaskRecord({
        ...base,
        when: "2026-09-13",
        time: "13:00",
        remindedAt: "2026-09-13T12:00:00.000Z",
      }).ok,
    ).toBe(true);
    expect(
      parseTaskRecord({
        ...base,
        when: "2026-09-13",
        time: "13:00",
        remindedAt: "2026-09-13T13:00:00+01:00",
      }).ok,
    ).toBe(false);
  });

  it("keeps a remindedAt on a task that has lost its time, rather than skipping the file", () => {
    // An inert mark costs nothing. A schema rule here would make the index skip
    // the whole record, and a person would lose the task.
    expect(
      parseTaskRecord({ ...base, remindedAt: "2026-09-13T12:00:00.000Z" }).ok,
    ).toBe(true);
  });

  it("keeps the time of a completed instance in its log entry", () => {
    const parsed = taskLogEntrySchema.safeParse({
      scheduled: "2026-09-13",
      time: "13:00",
      completedAt: "2026-09-13T12:59:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an unknown key in a log entry", () => {
    expect(
      taskLogEntrySchema.safeParse({
        completedAt: "2026-09-13T12:59:00.000Z",
        evening: true,
      }).success,
    ).toBe(false);
  });
});
