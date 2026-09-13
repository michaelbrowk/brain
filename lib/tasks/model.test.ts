import { describe, expect, it } from "vitest";

import {
  parseTaskRecord,
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
      [{ completedAt: "2026-09-11T21:04:55.108Z" }],
      ["2026-09-11"],
      [{ scheduled: "2026-09-11", completedAt: "2026-09-11T21:04:55.108Z", note: "x" }],
    ];
    for (const log of refused) {
      expect(taskRecordSchema.safeParse({ ...base, repeat, log }).success).toBe(false);
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

  it("refuses a log with no repeat", () => {
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
