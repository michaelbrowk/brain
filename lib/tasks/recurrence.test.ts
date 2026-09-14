import { describe, expect, it, vi } from "vitest";

import { parseTaskRecord, type TaskRecord, type TaskRepeat } from "./model";
import * as recurrenceModule from "./recurrence";
import { advance, nextOccurrence, RecurrenceError, revert } from "./recurrence";

/** Every date here is a `YYYY-MM-DD` string and is compared as one. The
 *  weekdays the fixtures rely on: 2026-09-13 is a Sunday, so 2026-09-14 and
 *  2026-09-21 are Mondays and 2026-09-17 is a Thursday. 2026 is not a leap
 *  year and 2024 is. */
const DAILY: TaskRepeat = { freq: "daily" };
const MONDAYS: TaskRepeat = { freq: "weekly", byWeekday: ["mon"] };
const MON_AND_THU: TaskRepeat = { freq: "weekly", byWeekday: ["mon", "thu"] };
const WEDNESDAYS: TaskRepeat = { freq: "weekly", byWeekday: ["wed"] };
const MON_WED_FRI: TaskRepeat = { freq: "weekly", byWeekday: ["mon", "wed", "fri"] };
const THE_31ST: TaskRepeat = { freq: "monthly", byMonthDay: 31 };
const THE_15TH: TaskRepeat = { freq: "monthly", byMonthDay: 15 };

/** The week the "from each weekday" rows walk. 2026-09-14 is a Monday. */
const THAT_WEEK = [
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
  "2026-09-19",
  "2026-09-20",
];

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

    // Weekly, from every day of the week against one weekday, which is the
    // spec's own case and the only way each arm of the seven-step scan runs.
    ...THAT_WEEK.map((from, index) => ({
      name: `weekly, Wednesday from day ${index + 1} of the week (${from})`,
      rule: WEDNESDAYS,
      // Monday and Tuesday reach the Wednesday inside their own week. From
      // Wednesday itself and every day after it, the answer is the week after.
      expected: index <= 1 ? "2026-09-16" : "2026-09-23",
      from,
    })),

    // Weekly with three weekdays, walked round the whole rule.
    {
      name: "weekly, three weekdays, Monday to Wednesday",
      rule: MON_WED_FRI,
      from: "2026-09-14",
      expected: "2026-09-16",
    },
    {
      name: "weekly, three weekdays, Wednesday to Friday",
      rule: MON_WED_FRI,
      from: "2026-09-16",
      expected: "2026-09-18",
    },
    {
      name: "weekly, three weekdays, Friday round to Monday",
      rule: MON_WED_FRI,
      from: "2026-09-18",
      expected: "2026-09-21",
    },
    {
      name: "weekly, three weekdays, from a day none of them names",
      rule: MON_WED_FRI,
      from: "2026-09-19",
      expected: "2026-09-21",
    },

    // The two clamp landings the spec names by value.
    {
      name: "monthly, the 31st into a leap February",
      rule: THE_31ST,
      from: "2024-01-31",
      expected: "2024-02-29",
    },
    {
      name: "monthly, the 31st into April",
      rule: THE_31ST,
      from: "2026-03-31",
      expected: "2026-04-30",
    },

    // A `from` far in the past. A rule is read off the calendar, so a task
    // untouched for decades still lands on a real date and not on an offset
    // from whenever it was last seen.
    {
      name: "daily, from the last day of the last century",
      rule: DAILY,
      from: "1999-12-31",
      expected: "2000-01-01",
    },
    {
      name: "weekly, from the first day of the epoch, a Thursday",
      rule: MONDAYS,
      from: "1970-01-01",
      expected: "1970-01-05",
    },
    {
      name: "monthly, from a day in 1970",
      rule: THE_15TH,
      from: "1970-01-20",
      expected: "1970-02-15",
    },

    // The century rules inside `daysInMonth`, which decide whether the day
    // after 28 February exists. `model.ts` holds a second copy of this rule,
    // so a drift between the two would otherwise go unnoticed in both files.
    {
      name: "daily, 1900 is not a leap year because of the 100 rule",
      rule: DAILY,
      from: "1900-02-28",
      expected: "1900-03-01",
    },
    {
      name: "daily, 2000 is a leap year because of the 400 rule",
      rule: DAILY,
      from: "2000-02-28",
      expected: "2000-02-29",
    },
    {
      name: "daily, 2100 is not a leap year because of the 100 rule",
      rule: DAILY,
      from: "2100-02-28",
      expected: "2100-03-01",
    },
  ];

  for (const { name, rule, from, expected } of cases) {
    it(name, () => {
      expect(nextOccurrence(rule, from)).toBe(expected);
    });
  }

  it("walks the 31st through a leap year by value, every clamp named", () => {
    // The property test below asserts only that each date is later than the
    // last, which an implementation that added a day every time would pass.
    // This one names all thirteen landings.
    const expected = [
      "2024-02-29",
      "2024-03-31",
      "2024-04-30",
      "2024-05-31",
      "2024-06-30",
      "2024-07-31",
      "2024-08-31",
      "2024-09-30",
      "2024-10-31",
      "2024-11-30",
      "2024-12-31",
      "2025-01-31",
      "2025-02-28",
    ];

    const walked: string[] = [];
    let day = "2024-01-31";
    for (let step = 0; step < expected.length; step += 1) {
      day = nextOccurrence(THE_31ST, day);
      walked.push(day);
    }

    expect(walked).toEqual(expected);
  });

  it("refuses a weekly rule with no weekday rather than answering the eighth day", () => {
    // Unreachable while the schema holds, which is why the loop bound would
    // otherwise be free to shrink. A rule with no weekday has no next date.
    const empty = { freq: "weekly", byWeekday: [] } as unknown as TaskRepeat;

    expect(() => nextOccurrence(empty, "2026-09-14")).toThrow(RecurrenceError);
    expect(() => nextOccurrence(empty, "2026-09-14")).toThrow(/at least one weekday/);
  });

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
    scheduled: string | undefined;
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
      // The entry keeps `when` exactly, so the untick can put the task back
      // on `someday` rather than on a day nobody chose. The arithmetic still
      // counts from today, because `someday` is no day to count from.
      name: "someday is logged as someday and still advances from today",
      fields: { repeat: DAILY, when: "someday" },
      today: "2026-09-14",
      when: "2026-09-15",
      scheduled: "someday",
    },
    {
      name: "no when at all is logged as no scheduled day",
      fields: { repeat: DAILY, when: undefined },
      today: "2026-09-14",
      when: "2026-09-15",
      scheduled: undefined,
    },
  ];

  // The caller's day and the completion instant's UTC day disagree here, which
  // is the whole reason `today` is a separate argument. Every case above uses
  // an instant whose UTC day equals `today`, so an implementation that read
  // `completedAt.slice(0, 10)` would pass all of them.
  const LATE_AT_NIGHT = "2026-09-15T02:00:00.000Z"; // the 14th at 21:00 in New York

  it("advances off the caller's day, not the completion instant's UTC day", () => {
    const record = repeating({ repeat: DAILY, when: "someday" });

    const result = advance(record, { completedAt: LATE_AT_NIGHT, today: "2026-09-14" });

    expect(result.log).toEqual([
      { scheduled: "someday", completedAt: LATE_AT_NIGHT },
    ]);
    expect(result.when).toBe("2026-09-15");
  });

  it("advances from the caller's day, not the completion instant's UTC day", () => {
    const record = repeating({ repeat: DAILY, when: "2026-09-01" });

    const result = advance(record, { completedAt: LATE_AT_NIGHT, today: "2026-09-14" });

    expect(result.when).toBe("2026-09-15");
  });

  for (const { name, fields, today, when, scheduled } of cases) {
    it(name, () => {
      const record = repeating(fields);

      const result = advance(record, { completedAt: COMPLETED_AT, today });

      expect(result.when).toBe(when);
      expect(result.log).toEqual([
        scheduled === undefined
          ? { completedAt: COMPLETED_AT }
          : { scheduled, completedAt: COMPLETED_AT },
      ]);
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

  it("refuses a task that does not repeat, on the completion path", () => {
    // The spec's failure-mode table says refused. Returning it unchanged
    // would hand a call site a byte-identical record to write and report as a
    // completion, and the task would stay open with nothing saying so.
    const plain = repeating({ repeat: undefined, log: undefined });

    expect(() => advance(plain, { completedAt: COMPLETED_AT, today: "2026-09-14" })).toThrow(
      RecurrenceError,
    );
    try {
      advance(plain, { completedAt: COMPLETED_AT, today: "2026-09-14" });
      expect.unreachable("advance accepted a task with no rule");
    } catch (error) {
      expect((error as RecurrenceError).reason).toBe("no-repeat");
    }
  });

  it("refuses a task that does not repeat, on the reschedule path", () => {
    const plain = repeating({ repeat: undefined, log: undefined });

    expect(() => advance(plain, { to: "2026-09-20" })).toThrow(RecurrenceError);
    try {
      advance(plain, { to: "2026-09-20" });
      expect.unreachable("advance accepted a task with no rule");
    } catch (error) {
      expect((error as RecurrenceError).reason).toBe("no-repeat");
    }
  });

  // `today` reaches the digit arithmetic directly. Unchecked, each of these
  // produces a `when` the schema refuses, which drops the task out of every
  // list on the next load rather than failing where the mistake was made.
  const badDays: { name: string; today: string }[] = [
    { name: "the word someday, which sorts above every real day", today: "someday" },
    { name: "the empty string", today: "" },
    { name: "a day the calendar does not have", today: "2026-02-31" },
    { name: "a month the calendar does not have", today: "2026-13-01" },
    { name: "an instant rather than a day", today: "2026-09-14T18:30:00.000Z" },
  ];

  for (const { name, today } of badDays) {
    it(`refuses ${name} as today`, () => {
      const record = repeating();

      expect(() => advance(record, { completedAt: COMPLETED_AT, today })).toThrow(
        RecurrenceError,
      );
      try {
        advance(record, { completedAt: COMPLETED_AT, today });
        expect.unreachable("advance accepted a today that is not a calendar day");
      } catch (error) {
        expect((error as RecurrenceError).reason).toBe("bad-today");
        // The measured wrong answers were "0NaN-NaN-01" and "0000-00-01".
        expect((error as Error).message).not.toContain("NaN");
      }
    });
  }

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
    /** Caught rather than propagated, because the harness below treats any
     *  throw as a clock read. A refusal is a return value here. */
    const refusalOf = (run: () => unknown): unknown => {
      try {
        return run();
      } catch (error) {
        return error;
      }
    };
    const exercised: Record<string, () => unknown> = {
      RecurrenceError: () => new RecurrenceError("no-repeat"),
      nextOccurrence: () => [
        nextOccurrence(DAILY, "2026-09-14"),
        nextOccurrence(MON_AND_THU, "2026-09-14"),
        nextOccurrence(THE_31ST, "2026-01-31"),
      ],
      advance: () => [
        advance(record, { completedAt: COMPLETED_AT, today: "2026-09-14" }),
        advance(record, { to: "2026-09-20" }),
        refusalOf(() => advance(repeating({ repeat: undefined }), { to: "2026-09-20" })),
        refusalOf(() => advance(record, { completedAt: COMPLETED_AT, today: "someday" })),
      ],
      revert: () => [
        revert(
          repeating({
            log: [{ scheduled: "2026-09-13", completedAt: "2026-09-13T08:00:00.000Z" }],
          }),
        ),
        refusalOf(() => revert(record)),
        refusalOf(() => revert(repeating({ repeat: undefined, log: undefined }))),
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

/** The Logbook's untick, which is the completion read backwards.
 *
 *  Only the newest entry is offered, so this pops one and puts `when` back to
 *  the day that entry was owed. Older entries are history and no gesture
 *  reaches them; `revert` never takes an index for that reason. */
describe("revert", () => {
  const FIRST = { scheduled: "2026-09-12", completedAt: "2026-09-12T08:00:00.000Z" };
  const SECOND = { scheduled: "2026-09-13", completedAt: "2026-09-13T08:00:00.000Z" };

  it("pops the newest entry and restores when to the day it was owed", () => {
    const record = repeating({ when: "2026-09-14", log: [FIRST, SECOND] });

    const result = revert(record);

    expect(result.when).toBe("2026-09-13");
    expect(result.log).toEqual([FIRST]);
    expect(result.repeat).toEqual(DAILY);
    expect(parseTaskRecord(result).ok).toBe(true);
  });

  it("drops the log entirely when the last entry goes", () => {
    // `log` beside no entries is a key the schema allows and nothing reads.
    // Removing it keeps a record that has never been completed and one that
    // has been completed and unticked byte for byte the same file.
    const record = repeating({ when: "2026-09-14", log: [SECOND] });

    const result = revert(record);

    expect(result.when).toBe("2026-09-13");
    expect("log" in result).toBe(false);
    expect(parseTaskRecord(result).ok).toBe(true);
  });

  it("undoes exactly what advance did, for every shape when can hold", () => {
    // A round trip, including the two shapes that are not a day: a repeat
    // parked on `someday` comes back on `someday`, and one in the Inbox comes
    // back with no day at all rather than dated to the morning it was ticked.
    for (const when of ["2026-09-14", "2026-09-20", "2026-09-01", "someday", undefined]) {
      const record = repeating({ when });
      const completed = advance(record, {
        completedAt: COMPLETED_AT,
        today: "2026-09-14",
      });
      expect(revert(completed)).toEqual(record);
      expect("when" in revert(completed)).toBe(when !== undefined);
    }
  });

  it("refuses a task that does not repeat", () => {
    const plain = repeating({ repeat: undefined, log: undefined });

    try {
      revert(plain);
      expect.unreachable("revert accepted a task with no rule");
    } catch (error) {
      expect(error).toBeInstanceOf(RecurrenceError);
      expect((error as RecurrenceError).reason).toBe("no-repeat");
    }
  });

  it("refuses a repeating task that has completed nothing", () => {
    for (const log of [undefined, []]) {
      try {
        revert(repeating({ log }));
        expect.unreachable("revert invented a completion");
      } catch (error) {
        expect(error).toBeInstanceOf(RecurrenceError);
        expect((error as RecurrenceError).reason).toBe("empty-log");
      }
    }
  });

  it("never mutates the record it was given", () => {
    const log = [FIRST, SECOND];
    const record = repeating({ log });
    const before = structuredClone(record);

    revert(record);

    expect(record).toEqual(before);
    expect(record.log).toBe(log);
    expect(log).toHaveLength(2);
  });
});
