import { describe, expect, it } from "vitest";

import { parseTaskRecord, taskRecordSchema, TASK_ID_RE } from "./model";

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
      log: ["2026-09-11", "2026-09-12"],
    });
    expect(parsed.success).toBe(true);
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
});
