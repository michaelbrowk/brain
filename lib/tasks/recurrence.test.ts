import { describe, expect, it, vi } from "vitest";

import { parseTaskRecord, type TaskRecord, type TaskRepeat } from "./model";
import * as recurrenceModule from "./recurrence";
import { advance, nextOccurrence } from "./recurrence";

/** Every date here is a `YYYY-MM-DD` string and is compared as one. The
 *  weekdays the fixtures rely on: 2026-09-13 is a Sunday, so 2026-09-14 and
 *  2026-09-21 are Mondays and 2026-09-17 is a Thursday. 2026 is not a leap
 *  year and 2024 is. */
const DAILY: TaskRepeat = { freq: "daily" };
const MONDAYS: TaskRepeat = { freq: "weekly", byWeekday: ["mon"] };
const MON_AND_THU: TaskRepeat = { freq: "weekly", byWeekday: ["mon", "thu"] };
const THE_31ST: TaskRepeat = { freq: "monthly", byMonthDay: 31 };
const THE_15TH: TaskRepeat = { freq: "monthly", byMonthDay: 15 };

const COMPLETED_AT = "2026-09-14T18:30:00.000Z";

function repeating(fields: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-repeat-daily",
    title: "Water the plants",
    created: "2026-09-01T09:00:00.000Z",
    updated: "2026-09-01T09:00:00.000Z",
    repeat: DAILY,
    when: "2026-09-14",
    ...fields,
  };
}

describe("nextOccurrence", () => {
  const cases: { name: string; rule: TaskRepeat; from: string; expected: string }[] = [
    // Daily.
    { name: "daily, mid-month", rule: DAILY, from: "2026-09-14", expected: "2026-09-15" },
    { name: "daily, over a month end", rule: DAILY, from: "2026-01-31", expected: "2026-02-01" },
    { name: "daily, into a leap day", rule: DAILY, from: "2024-02-28", expected: "2024-02-29" },
    {
      name: "daily, out of a short February",
      rule: DAILY,
      from: "2026-02-28",
      expected: "2026-03-01",
    },
    { name: "daily, over a year end", rule: DAILY, from: "2026-12-31", expected: "2027-01-01" },

    // Weekly.
    { name: "weekly, the next Monday", rule: MONDAYS, from: "2026-09-13", expected: "2026-09-14" },
    {
      name: "weekly, from the weekday itself, is strictly after",
      rule: MONDAYS,
      from: "2026-09-14",
      expected: "2026-09-21",
    },
    {
      name: "weekly, two weekdays, Monday to Thursday",
      rule: MON_AND_THU,
      from: "2026-09-14",
      expected: "2026-09-17",
    },
    {
      name: "weekly, two weekdays, Thursday round to Monday",
      rule: MON_AND_THU,
      from: "2026-09-17",
      expected: "2026-09-21",
    },
    {
      name: "weekly, the order the rule lists weekdays in does not matter",
      rule: { freq: "weekly", byWeekday: ["thu", "mon"] },
      from: "2026-09-14",
      expected: "2026-09-17",
    },
    {
      name: "weekly, every day of the week is the next day",
      rule: { freq: "weekly", byWeekday: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
      from: "2026-09-14",
      expected: "2026-09-15",
    },
    {
      name: "weekly, Sunday from the Saturday before it",
      rule: { freq: "weekly", byWeekday: ["sun"] },
      from: "2026-09-12",
      expected: "2026-09-13",
    },

    // Monthly.
    {
      name: "monthly, later the same month",
      rule: THE_15TH,
      from: "2026-09-14",
      expected: "2026-09-15",
    },
    {
      name: "monthly, from the day itself, is strictly after",
      rule: THE_15TH,
      from: "2026-09-15",
      expected: "2026-10-15",
    },
    {
      name: "monthly, the 31st clamps to the last day of a short month",
      rule: THE_31ST,
      from: "2026-01-31",
      expected: "2026-02-28",
    },
    {
      name: "monthly, a clamped month does not drag the series down",
      rule: THE_31ST,
      from: "2026-02-28",
      expected: "2026-03-31",
    },
    {
      name: "monthly, the 29th in a year with no 29 February",
      rule: { freq: "monthly", byMonthDay: 29 },
      from: "2026-01-29",
      expected: "2026-02-28",
    },
    {
      name: "monthly, the 29th in a leap year keeps its day",
      rule: { freq: "monthly", byMonthDay: 29 },
      from: "2024-01-29",
      expected: "2024-02-29",
    },
    {
      name: "monthly, over a year end",
      rule: THE_15TH,
      from: "2026-12-20",
      expected: "2027-01-15",
    },
    {
      name: "monthly, the 1st from the end of the month before",
      rule: { freq: "monthly", byMonthDay: 1 },
      from: "2026-09-30",
      expected: "2026-10-01",
    },
  ];

  for (const { name, rule, from, expected } of cases) {
    it(name, () => {
      expect(nextOccurrence(rule, from)).toBe(expected);
    });
  }

  it("always moves forward, over forty occurrences of every rule", () => {
    for (const rule of [DAILY, MONDAYS, MON_AND_THU, THE_31ST, THE_15TH]) {
      let day = "2026-01-30";
      for (let step = 0; step < 40; step += 1) {
        const next = nextOccurrence(rule, day);
        expect(next > day).toBe(true);
        // A real calendar day, so a clamp can never produce 2026-02-30.
        expect(parseTaskRecord({ ...repeating(), when: next }).ok).toBe(true);
        day = next;
      }
    }
  });
});

describe("advance", () => {
  const cases: {
    name: string;
    fields: Partial<TaskRecord>;
    today: string;
    when: string;
    scheduled: string;
  }[] = [
    {
      name: "completing on the day it was due moves to the next one",
      fields: { repeat: DAILY, when: "2026-09-14" },
      today: "2026-09-14",
      when: "2026-09-15",
      scheduled: "2026-09-14",
    },
    {
      name: "completing early advances from the scheduled day, not from today",
      fields: { repeat: DAILY, when: "2026-09-20" },
      today: "2026-09-14",
      when: "2026-09-21",
      scheduled: "2026-09-20",
    },
    {
      name: "completing late advances from today, so missed days never pile up",
      fields: { repeat: DAILY, when: "2026-09-01" },
      today: "2026-09-14",
      when: "2026-09-15",
      scheduled: "2026-09-01",
    },
    {
      name: "a weekly task missed for a fortnight lands on the next Monday, not the first",
      fields: { repeat: MONDAYS, when: "2026-08-31" },
      today: "2026-09-14",
      when: "2026-09-21",
      scheduled: "2026-08-31",
    },
    {
      name: "a weekly task completed early keeps the weekday after it",
      fields: { repeat: MON_AND_THU, when: "2026-09-17" },
      today: "2026-09-14",
      when: "2026-09-21",
      scheduled: "2026-09-17",
    },
    {
      name: "the 31st clamps when the next month is short",
      fields: { repeat: THE_31ST, when: "2026-01-31" },
      today: "2026-01-31",
      when: "2026-02-28",
      scheduled: "2026-01-31",
    },
    {
      name: "someday has no scheduled day, so the completion day is the one logged",
      fields: { repeat: DAILY, when: "someday" },
      today: "2026-09-14",
      when: "2026-09-15",
      scheduled: "2026-09-14",
    },
    {
      name: "no when at all is the same",
      fields: { repeat: DAILY, when: undefined },
      today: "2026-09-14",
      when: "2026-09-15",
      scheduled: "2026-09-14",
    },
  ];

  for (const { name, fields, today, when, scheduled } of cases) {
    it(name, () => {
      const record = repeating(fields);

      const result = advance(record, { completedAt: COMPLETED_AT, today });

      expect(result.when).toBe(when);
      expect(result.log).toEqual([{ scheduled, completedAt: COMPLETED_AT }]);
      expect(result.repeat).toEqual(record.repeat);
      expect(parseTaskRecord(result).ok).toBe(true);
    });
  }

  it("leaves exactly one open instance, with no done and no doneAt", () => {
    const record = repeating({ done: false, doneAt: "2026-09-13T08:00:00.000Z" });

    const result = advance(record, { completedAt: COMPLETED_AT, today: "2026-09-14" });

    expect(result.when).toBe("2026-09-15");
    expect("done" in result).toBe(false);
    expect("doneAt" in result).toBe(false);
    expect(parseTaskRecord(result).ok).toBe(true);
  });

  it("appends to an existing log, newest last", () => {
    const record = repeating({
      log: [{ scheduled: "2026-09-13", completedAt: "2026-09-13T08:00:00.000Z" }],
    });

    const result = advance(record, { completedAt: COMPLETED_AT, today: "2026-09-14" });

    expect(result.log).toEqual([
      { scheduled: "2026-09-13", completedAt: "2026-09-13T08:00:00.000Z" },
      { scheduled: "2026-09-14", completedAt: COMPLETED_AT },
    ]);
  });

  it("trims the log to its thirty most recent entries", () => {
    // Thirty days of a daily task, the oldest first.
    const log = Array.from({ length: 30 }, (_, index) => {
      const day = `2026-08-${String(index + 1).padStart(2, "0")}`;
      return { scheduled: day, completedAt: `${day}T08:00:00.000Z` };
    });
    const record = repeating({ log });

    const result = advance(record, { completedAt: COMPLETED_AT, today: "2026-09-14" });

    expect(result.log).toHaveLength(30);
    expect(result.log?.[0]).toEqual(log[1]);
    expect(result.log?.[29]).toEqual({ scheduled: "2026-09-14", completedAt: COMPLETED_AT });
  });

  it("reschedules by moving when and touching nothing else", () => {
    const record = repeating({
      log: [{ scheduled: "2026-09-13", completedAt: "2026-09-13T08:00:00.000Z" }],
    });

    const result = advance(record, { to: "2026-09-20" });

    expect(result.when).toBe("2026-09-20");
    expect(result.repeat).toEqual(DAILY);
    expect(result.log).toEqual(record.log);
    expect(parseTaskRecord(result).ok).toBe(true);
  });

  it("reschedules to someday", () => {
    const result = advance(repeating(), { to: "someday" });

    expect(result.when).toBe("someday");
    expect(parseTaskRecord(result).ok).toBe(true);
  });

  it("leaves a task that does not repeat exactly as it was", () => {
    const plain = repeating({ repeat: undefined, log: undefined });

    expect(advance(plain, { completedAt: COMPLETED_AT, today: "2026-09-14" })).toEqual(plain);
    expect(advance(plain, { to: "2026-09-20" })).toEqual(plain);
  });

  it("never mutates the record it was given", () => {
    const log = [{ scheduled: "2026-09-13", completedAt: "2026-09-13T08:00:00.000Z" }];
    const record = repeating({ log });
    const before = structuredClone(record);

    advance(record, { completedAt: COMPLETED_AT, today: "2026-09-14" });
    advance(record, { to: "2026-09-20" });

    expect(record).toEqual(before);
    expect(record.log).toBe(log);
    expect(log).toHaveLength(1);
  });

  it("reads no clock, in every export of recurrence.ts", () => {
    const record = repeating();
    const exercised: Record<string, () => unknown> = {
      nextOccurrence: () => [
        nextOccurrence(DAILY, "2026-09-14"),
        nextOccurrence(MON_AND_THU, "2026-09-14"),
        nextOccurrence(THE_31ST, "2026-01-31"),
      ],
      advance: () => [
        advance(record, { completedAt: COMPLETED_AT, today: "2026-09-14" }),
        advance(record, { to: "2026-09-20" }),
        advance(repeating({ repeat: undefined }), { to: "2026-09-20" }),
      ],
    };

    // A new export has to be added above, or this fails before the trap runs.
    const callable = Object.entries(recurrenceModule)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    expect(Object.keys(exercised).sort()).toEqual(callable.sort());

    const boom = () => {
      throw new Error("lib/tasks must not read the clock");
    };
    const trap = function TrappedDate() {
      boom();
    } as unknown as DateConstructor;
    Object.assign(trap, { now: boom, parse: boom, UTC: boom });

    let ran = 0;
    let thrown: unknown = null;
    let trapArmed = false;
    vi.stubGlobal("Date", trap);
    try {
      try {
        new Date();
      } catch {
        trapArmed = true;
      }
      for (const run of Object.values(exercised)) {
        run();
        ran += 1;
      }
    } catch (error) {
      thrown = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(trapArmed).toBe(true);
    expect(thrown).toBeNull();
    expect(ran).toBe(Object.keys(exercised).length);
  });
});
