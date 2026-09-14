import { describe, expect, it, vi } from "vitest";

import * as calendarModule from "./calendar";
import {
  monthGridOf,
  monthLabel,
  monthName,
  monthOfDay,
  shiftDay,
  shiftMonth,
} from "./calendar";
import * as modelModule from "./model";
import { parseTaskRecord, taskRecordRules } from "./model";
import type { TaskView } from "./model";
import * as taskLinesModule from "./task-lines";
import { hashTaskText, normalizeTaskText, parseTaskLines } from "./task-lines";
import * as listsModule from "./lists";
import {
  compareGroups,
  compareInGroup,
  doneDayOf,
  groupFor,
  listOf,
  logbookRows,
  type ListName,
  type TaskGroup,
} from "./lists";

/** Every date in this file is a `YYYY-MM-DD` string and is compared as one.
 *  `new Date("2026-09-13")` parses as UTC midnight, so `.getDate()` in any
 *  western timezone returns the day before, a bug that waits for the first
 *  traveller. No function in `lib/tasks` reads a clock, and the last case in
 *  the first block pins that for every one of them. */
const TODAY = "2026-09-13"; // a Sunday

function task(fields: Partial<TaskView> = {}): TaskView {
  return {
    id: "task-alpha",
    title: "Water the plants",
    created: "2026-09-13T09:00:00.000Z",
    updated: "2026-09-13T09:00:00.000Z",
    done: false,
    ...fields,
  };
}

const listCases: { name: string; fields: Partial<TaskView>; expected: ListName }[] = [
  { name: "done is the logbook", fields: { done: true }, expected: "logbook" },
  { name: "when is today", fields: { when: TODAY }, expected: "today" },
  {
    name: "a past when is today, not a separate overdue list",
    fields: { when: "2026-09-01" },
    expected: "today",
  },
  { name: "a deadline today is today", fields: { deadline: TODAY }, expected: "today" },
  {
    name: "a past deadline is today",
    fields: { deadline: "2026-09-01" },
    expected: "today",
  },
  { name: "a future when is upcoming", fields: { when: "2026-09-20" }, expected: "upcoming" },
  { name: "someday is someday", fields: { when: "someday" }, expected: "someday" },
  {
    name: "a future deadline alone is upcoming",
    fields: { deadline: "2026-09-20" },
    expected: "upcoming",
  },
  { name: "nothing set is the inbox", fields: {}, expected: "inbox" },
  {
    name: "someday with a future deadline stays someday",
    fields: { when: "someday", deadline: "2026-09-20" },
    expected: "someday",
  },
  {
    name: "someday with a past deadline is today",
    fields: { when: "someday", deadline: "2026-09-01" },
    expected: "today",
  },
  {
    name: "done wins over everything",
    fields: { done: true, when: "2026-09-20" },
    expected: "logbook",
  },
  {
    name: "a deadline today pulls a future when forward",
    fields: { when: "2026-09-20", deadline: TODAY },
    expected: "today",
  },
];

describe("listOf", () => {
  it.each(listCases)("$name", ({ fields, expected }) => {
    expect(listOf(task(fields), TODAY)).toBe(expected);
  });

  it("splits every combination of the five fields the way the clause order says", () => {
    const dones = [false, true];
    const whens = [undefined, "2026-09-01", TODAY, "2026-09-20", "someday"] as const;
    const deadlines = [undefined, "2026-09-01", TODAY, "2026-09-20"] as const;
    const categories = [undefined, "Home"] as const;
    const pages = [undefined, "page-garden"] as const;

    const buckets = new Map<ListName, number>();
    for (const done of dones) {
      for (const when of whens) {
        for (const deadline of deadlines) {
          for (const category of categories) {
            for (const page of pages) {
              const list = listOf(task({ done, when, deadline, category, page }), TODAY);
              buckets.set(list, (buckets.get(list) ?? 0) + 1);
            }
          }
        }
      }
    }

    // Counted by hand from the clause order, over 2 x 5 x 4 whens and
    // deadlines, times the 4 combinations of category and page that no clause
    // reads. Done takes half of everything. Of the remaining 20 shapes, 14 are
    // Today: the four whens in the past or on the day, the four on today, the
    // two futures a due deadline pulls forward, the two somedays a due
    // deadline pulls forward, and the two bare deadlines that have arrived.
    // Moving a clause changes these numbers.
    expect(Object.fromEntries(buckets)).toEqual({
      logbook: 80,
      today: 56,
      upcoming: 12,
      someday: 8,
      inbox: 4,
    });
  });

  it("reads no clock, in any exported function of lib/tasks", () => {
    // The `time` is YAML's own reading of `13:00`, a sexagesimal 780, so the
    // schema's number branch runs under the trap rather than the string one
    // that needs no conversion. A clock read on the way to `"13:00"` would be
    // the same bug in a quieter place.
    const record = {
      id: "task-alpha",
      title: "Water the plants",
      created: "2026-09-13T09:00:00.000Z",
      updated: "2026-09-13T09:00:00.000Z",
      when: TODAY,
      time: 780,
    };
    const anchor = { text: "alpha", hash: "0123456789abcdef", ordinal: 0, line: 0 };
    const group = { key: "", label: null, order: 0 };
    const noIssues = { addIssue: () => {} };

    /** Every exported function and schema, with an argument that reaches its
     *  own branch. A Today task and an inbox task are here because a clock
     *  read inside the category branch went undetected without them. */
    const exercised: Record<string, () => unknown> = {
      listOf: () => [
        listOf(task({ when: "2026-09-20" }), TODAY),
        // With an offset, which is the completion-day read: it turns one UTC
        // instant into the reader's day, and a `Date` in there would put the
        // whole feature a day out for half the planet.
        listOf(task({ done: true, doneAt: `${TODAY}T22:30:00.000Z` }), TODAY, 180),
      ],
      groupFor: () => [
        groupFor(task(), TODAY),
        groupFor(task({ when: TODAY, category: "Home" }), TODAY),
        groupFor(task({ when: TODAY }), TODAY),
        groupFor(task({ when: TODAY, evening: true }), TODAY),
        groupFor(task({ when: "someday", category: "Reading" }), TODAY),
        groupFor(task({ when: "2026-09-20" }), TODAY),
        groupFor(task({ done: true, doneAt: "2026-09-12T09:00:00.000Z" }), TODAY, 180),
        groupFor(task({ done: true }), TODAY),
      ],
      doneDayOf: () => doneDayOf("2026-09-12T22:00:00.000Z", -300),
      logbookRows: () =>
        logbookRows(
          [
            task({ done: true, doneAt: "2026-09-12T09:00:00.000Z" }),
            task({ done: true }),
            task({ id: "task-open" }),
            task({
              id: "task-words",
              repeat: { freq: "daily" },
              when: "2026-09-14",
              log: [
                { scheduled: "2026-09-12", completedAt: "2026-09-12T09:00:00.000Z" },
                { scheduled: "2026-07-01", completedAt: "2026-07-01T09:00:00.000Z" },
              ],
            }),
          ],
          TODAY,
          180,
        ),
      compareGroups: () => compareGroups(group, { key: "Home", label: "Home", order: 1 }),
      compareInGroup: () => [
        compareInGroup(task(), task({ id: "task-beta" }), "today"),
        compareInGroup(task(), task({ id: "task-beta" }), "logbook"),
        compareInGroup(
          task({ when: TODAY, time: "09:00" }),
          task({ id: "task-beta", when: TODAY }),
          "today",
        ),
      ],
      parseTaskLines: () => parseTaskLines("- [ ] alpha\n- [x] beta"),
      normalizeTaskText: () => normalizeTaskText(" a  b "),
      hashTaskText: () => hashTaskText("a b"),
      parseTaskRecord: () => parseTaskRecord(record),
      isLinkedTask: () => [
        modelModule.isLinkedTask({}),
        modelModule.isLinkedTask({ page: "page-garden" }),
        modelModule.isLinkedTask({
          page: "page-garden",
          detachedAt: "2026-09-14T08:15:00.000Z",
        }),
      ],
      taskRecordRules: () => taskRecordRules(record as never, noIssues as never),
      taskRecordSchema: () => modelModule.taskRecordSchema.safeParse(record),
      taskRecordFields: () => modelModule.taskRecordFields.safeParse(record),
      taskAnchorSchema: () => modelModule.taskAnchorSchema.safeParse(anchor),
      taskRepeatSchema: () => modelModule.taskRepeatSchema.safeParse({ freq: "daily" }),
      taskLogEntrySchema: () =>
        modelModule.taskLogEntrySchema.safeParse({
          scheduled: "2026-09-13",
          completedAt: "2026-09-13T21:04:55.108Z",
        }),
      weekDaySchema: () => modelModule.weekDaySchema.safeParse("mon"),
      monthGridOf: () => monthGridOf("2026-09"),
      shiftMonth: () => shiftMonth("2026-09", 1),
      shiftDay: () => shiftDay("2026-09-13", 7),
      monthOfDay: () => monthOfDay("2026-09-13"),
      monthLabel: () => monthLabel("2026-09"),
      monthName: () => monthName("2026-09"),
    };

    // A new export has to be added above, or this fails before the trap runs.
    const modules = [modelModule, taskLinesModule, listsModule, calendarModule];
    const callable = modules.flatMap((module) =>
      Object.entries(module)
        .filter(
          ([, value]) =>
            typeof value === "function" ||
            typeof (value as { safeParse?: unknown })?.safeParse === "function",
        )
        .map(([name]) => name),
    );
    expect(Object.keys(exercised).sort()).toEqual([...new Set(callable)].sort());

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
      // Prove the trap bites before trusting it, so this case cannot pass by
      // stubbing something the modules never look at.
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

describe("groupFor", () => {
  it("gives the inbox one headerless group", () => {
    expect(groupFor(task(), TODAY)).toMatchObject({ label: null, order: 0 });
  });

  it("groups today by category, the no-category group first and headerless", () => {
    const plain = groupFor(task({ when: TODAY }), TODAY);
    const filed = groupFor(task({ when: TODAY, category: "Home" }), TODAY);
    expect(plain).toMatchObject({ key: "", label: null, order: 0 });
    expect(filed).toMatchObject({ key: "Home", label: "Home", order: 1 });
    expect(compareGroups(plain, filed)).toBeLessThan(0);
  });

  it("groups someday by category", () => {
    expect(groupFor(task({ when: "someday", category: "Reading" }), TODAY)).toMatchObject({
      key: "Reading",
      label: "Reading",
    });
  });

  it.each([
    ["2026-09-14", "Tomorrow"],
    ["2026-09-15", "Tue 15"],
    ["2026-09-16", "Wed 16"],
    ["2026-09-17", "Thu 17"],
    // The four the boundary turns on. Today is Sunday the 13th, so day 6 is
    // still this week, day 7 opens the next one, day 13 closes it, and day 14
    // is the week after: "Next week" for a day a fortnight out was the one
    // label here that was untrue rather than loose.
    ["2026-09-19", "Sat 19"],
    ["2026-09-20", "Next week"],
    ["2026-09-26", "Next week"],
    ["2026-09-27", "27 Sep"],
    ["2026-09-28", "28 Sep"],
    ["2027-01-04", "4 Jan"],
  ])("labels the upcoming day %s as %s", (when, label) => {
    expect(groupFor(task({ when }), TODAY).label).toBe(label);
  });

  it("groups an upcoming task on the day that pulled it forward", () => {
    const pulled = groupFor(task({ when: "2026-09-25", deadline: "2026-09-16" }), TODAY);
    expect(pulled.label).toBe("Wed 16");
  });

  it("orders upcoming groups by day", () => {
    const soon = groupFor(task({ when: "2026-09-15" }), TODAY);
    const later = groupFor(task({ when: "2026-09-28" }), TODAY);
    expect(compareGroups(soon, later)).toBeLessThan(0);
  });

  it.each([
    ["2026-09-12T21:00:00.000Z", "Yesterday"],
    ["2026-09-05T21:00:00.000Z", "5 Sep"],
    ["2026-08-12T21:00:00.000Z", "12 Aug"],
  ])("labels a completion at %s as %s", (doneAt, label) => {
    expect(groupFor(task({ done: true, doneAt }), TODAY).label).toBe(label);
  });

  it("has no Today group, because today's completion has not reached the logbook", () => {
    // The Logbook's oldest label was "Today" and there is no longer anything
    // to put under it: a completion stays in the list it was made in until the
    // day changes. The group it gets is the group it had while it was open.
    const closed = task({ done: true, doneAt: `${TODAY}T21:00:00.000Z` });
    expect(listOf(closed, TODAY, 0)).toBe("inbox");
    expect(groupFor(closed, TODAY, 0)).toMatchObject({ key: "", label: null });
  });

  it("files a completion under the reader's own day, not the UTC one", () => {
    // 22:00Z on the 11th is already the 12th in Dubai and still the 11th in
    // New York. The instant is one value, the day is the reader's.
    const done = task({ done: true, doneAt: "2026-09-11T22:00:00.000Z" });
    expect(groupFor(done, TODAY, 240).label).toBe("Yesterday");
    expect(groupFor(done, TODAY, -300).label).toBe("11 Sep");
    expect(groupFor(done, TODAY, 0).label).toBe("11 Sep");
  });

  it("holds a completion back from the logbook for the reader whose day it still is", () => {
    // The same instant, and the two readers are a day apart on it: 22:00Z on
    // the 12th is already the 13th in Dubai, where the completion is still
    // today's, and the 12th in New York, where it is history.
    const done = task({ done: true, doneAt: "2026-09-12T22:00:00.000Z" });
    expect(listOf(done, TODAY, 240)).toBe("inbox");
    expect(listOf(done, TODAY, -300)).toBe("logbook");
    expect(groupFor(done, TODAY, -300).label).toBe("Yesterday");
  });

  it("puts a done task with no doneAt at the foot of the logbook", () => {
    const orphan = groupFor(task({ done: true }), TODAY);
    const dated = groupFor(task({ done: true, doneAt: "2026-08-12T21:00:00.000Z" }), TODAY);
    expect(orphan).toMatchObject({ key: "", label: null });
    expect(compareGroups(dated, orphan)).toBeLessThan(0);
  });
});

describe("doneDayOf", () => {
  it.each([
    ["2026-09-12T22:00:00.000Z", 240, "2026-09-13"],
    ["2026-09-12T22:00:00.000Z", -300, "2026-09-12"],
    ["2026-09-13T02:00:00.000Z", -300, "2026-09-12"],
    ["2026-09-13T12:00:00.000Z", 0, "2026-09-13"],
    ["2026-01-01T02:00:00.000Z", -300, "2025-12-31"],
    ["2028-03-01T02:00:00.000Z", -300, "2028-02-29"],
    ["2026-09-13T23:30:00.000Z", 840, "2026-09-14"],
  ])("reads %s at offset %i as %s", (iso, offsetMinutes, day) => {
    expect(doneDayOf(iso, offsetMinutes)).toBe(day);
  });

  it("orders logbook groups newest first", () => {
    const newer = groupFor(task({ done: true, doneAt: "2026-09-12T21:00:00.000Z" }), TODAY);
    const older = groupFor(task({ done: true, doneAt: "2026-09-05T21:00:00.000Z" }), TODAY);
    expect(compareGroups(newer, older)).toBeLessThan(0);
  });
});

describe("compareGroups", () => {
  it("collates category labels rather than comparing code units", () => {
    const groups: TaskGroup[] = [
      { key: "Ёлка", label: "Ёлка", order: 1 },
      { key: "Единорог", label: "Единорог", order: 1 },
      { key: "", label: null, order: 0 },
    ];
    expect([...groups].sort(compareGroups).map((group) => group.key)).toEqual([
      "",
      "Единорог",
      "Ёлка",
    ]);
  });
});

describe("compareInGroup", () => {
  it.each<ListName>(["today", "upcoming", "someday", "inbox"])(
    "puts the newest first in %s",
    (list) => {
      const older = task({ id: "task-older", created: "2026-09-01T09:00:00.000Z" });
      const newer = task({ id: "task-newer", created: "2026-09-12T09:00:00.000Z" });
      expect([older, newer].sort((a, b) => compareInGroup(a, b, list))).toEqual([
        newer,
        older,
      ]);
    },
  );

  it("breaks a tie on the id, so a sort is stable across two reads", () => {
    const alpha = task({ id: "task-alpha" });
    const beta = task({ id: "task-beta" });
    expect(compareInGroup(alpha, beta, "today")).toBeLessThan(0);
    expect(compareInGroup(beta, alpha, "today")).toBeGreaterThan(0);
  });

  it("orders the logbook by completion time", () => {
    const first = task({
      id: "task-first",
      done: true,
      created: "2026-09-12T09:00:00.000Z",
      doneAt: "2026-09-12T10:00:00.000Z",
    });
    const last = task({
      id: "task-last",
      done: true,
      created: "2026-09-01T09:00:00.000Z",
      doneAt: "2026-09-13T10:00:00.000Z",
    });
    expect([first, last].sort((a, b) => compareInGroup(a, b, "logbook"))).toEqual([
      last,
      first,
    ]);
  });
});

/** THE LOGBOOK IS DRAWN FROM COMPLETIONS, NOT FROM RECORDS.
 *
 *  A repeating task is never done: completing it appends a `log` entry and
 *  moves `when` on, so the record itself is always open and would never reach
 *  the Logbook at all. History is per instance even though storage is per
 *  series, so every entry is a row of its own, carrying the day that instance
 *  was owed and the instant it was finished.
 */
describe("logbookRows", () => {
  const entry = (day: string, hour = "09") => ({
    scheduled: day,
    completedAt: `${day}T${hour}:00:00.000Z`,
  });

  const repeating = (fields: Partial<TaskView> = {}): TaskView =>
    task({
      id: "task-words",
      title: "Learn words",
      repeat: { freq: "daily" },
      when: "2026-09-14",
      ...fields,
    });

  it("draws one row per log entry, newest first, each carrying its own completion", () => {
    const rows = logbookRows(
      [repeating({ log: [entry("2026-09-11"), entry("2026-09-12"), entry("2026-09-13")] })],
      TODAY,
      0,
    );

    expect(rows.map((row) => row.task.doneAt)).toEqual([
      "2026-09-13T09:00:00.000Z",
      "2026-09-12T09:00:00.000Z",
      "2026-09-11T09:00:00.000Z",
    ]);
    // The day each instance was owed, which is not the day it was finished
    // once a completion runs early or late.
    expect(rows.map((row) => row.task.when)).toEqual([
      "2026-09-13",
      "2026-09-12",
      "2026-09-11",
    ]);
    expect(rows.every((row) => row.task.done)).toBe(true);
    expect(rows.every((row) => row.task.id === "task-words")).toBe(true);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it("offers the untick on the newest entry and on no other", () => {
    const rows = logbookRows(
      [repeating({ log: [entry("2026-09-12"), entry("2026-09-13")] })],
      TODAY,
      0,
    );

    expect(rows.map((row) => row.untickable)).toEqual([true, false]);
  });

  it("keeps a completion early and one late apart, by their own two days", () => {
    // Scheduled the 12th, finished on the 11th; scheduled the 13th, finished
    // on the 14th. The row's day is the completion's and its `when` is the
    // instance's, and neither can stand in for the other.
    const rows = logbookRows(
      [
        repeating({
          log: [
            { scheduled: "2026-09-12", completedAt: "2026-09-11T09:00:00.000Z" },
            { scheduled: "2026-09-13", completedAt: "2026-09-14T09:00:00.000Z" },
          ],
        }),
      ],
      "2026-09-14",
      0,
    );

    expect(rows.map((row) => [row.task.when, row.task.doneAt])).toEqual([
      ["2026-09-13", "2026-09-14T09:00:00.000Z"],
      ["2026-09-12", "2026-09-11T09:00:00.000Z"],
    ]);
    // Read a day on, where the row has reached the Logbook: its group is the
    // day it was finished on, the 14th, and not the 13th it was owed.
    expect(groupFor(rows[0].task, "2026-09-15", 0).label).toBe("Yesterday");
  });

  it("stops the log at the thirty day window, in the reader's own days", () => {
    const inside = entry("2026-08-15");
    const outside = entry("2026-08-13");
    const rows = logbookRows([repeating({ log: [outside, inside] })], TODAY, 0);

    expect(rows.map((row) => row.task.doneAt)).toEqual([inside.completedAt]);
  });

  it("a repeating task that has completed nothing draws no row", () => {
    expect(logbookRows([repeating()], TODAY, 0)).toEqual([]);
    expect(logbookRows([repeating({ log: [] })], TODAY, 0)).toEqual([]);
  });

  it("draws one row for an ordinary done task and none for an open one", () => {
    const done = task({
      id: "task-plants",
      done: true,
      doneAt: "2026-09-13T10:00:00.000Z",
    });
    const open = task({ id: "task-milk", when: TODAY });

    const rows = logbookRows([done, open], TODAY, 0);

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("task-plants");
    expect(rows[0].task).toBe(done);
    expect(rows[0].untickable).toBe(true);
  });

  it("keeps a done record with no doneAt, which lists.ts files at the foot", () => {
    const orphan = task({ id: "task-orphan", done: true });

    const rows = logbookRows([orphan], TODAY, 0);

    expect(rows.map((row) => row.key)).toEqual(["task-orphan"]);
  });

  it("orders every row by completion, across records and entries alike", () => {
    const plain = task({
      id: "task-plants",
      done: true,
      doneAt: "2026-09-12T12:00:00.000Z",
    });
    const rows = logbookRows(
      [plain, repeating({ log: [entry("2026-09-12", "08"), entry("2026-09-13")] })],
      TODAY,
      0,
    );

    expect(rows.map((row) => row.task.doneAt)).toEqual([
      "2026-09-13T09:00:00.000Z",
      "2026-09-12T12:00:00.000Z",
      "2026-09-12T08:00:00.000Z",
    ]);
  });

  it("reads the window edge in the reader's zone, not in UTC", () => {
    // 22:00Z on the 13th of August is already the 14th in Dubai, so the same
    // entry is inside the window there and a day outside it in UTC.
    const edge = { scheduled: "2026-08-13", completedAt: "2026-08-13T22:00:00.000Z" };

    expect(logbookRows([repeating({ log: [edge] })], TODAY, 240)).toHaveLength(1);
    expect(logbookRows([repeating({ log: [edge] })], TODAY, 0)).toHaveLength(0);
  });
});

/** THE DERIVATION IS TOTAL OVER THE LOGBOOK.
 *
 *  A record `listOf` files in the Logbook that `logbookRows` draws no row for
 *  is a record nothing on the surface can reach: every other list rejects it
 *  for being done, and the Logbook does not draw it. So the two sources are
 *  added rather than chosen between. */
describe("logbookRows, every record listOf files in the logbook", () => {
  /** Every completion here is yesterday's, because that is when a record is in
   *  the Logbook at all: today's stays in the list it was made in. */
  const shapes: { name: string; fields: Partial<TaskView>; rows: number }[] = [
    {
      name: "an ordinary done record",
      fields: { done: true, doneAt: "2026-09-12T09:00:00.000Z" },
      rows: 1,
    },
    {
      name: "a done record that also carries a rule, which an import can make",
      fields: {
        done: true,
        doneAt: "2026-09-12T09:00:00.000Z",
        repeat: { freq: "daily" },
      },
      rows: 1,
    },
    {
      name: "a done record with a rule and a log",
      fields: {
        done: true,
        doneAt: "2026-09-12T12:00:00.000Z",
        repeat: { freq: "daily" },
        log: [{ scheduled: "2026-09-12", completedAt: "2026-09-12T09:00:00.000Z" }],
      },
      rows: 2,
    },
    {
      name: "a done record with no instant at all",
      fields: { done: true },
      rows: 1,
    },
  ];

  for (const { name, fields, rows } of shapes) {
    it(`draws ${rows} for ${name}`, () => {
      const record = task(fields);
      expect(listOf(record, TODAY)).toBe("logbook");
      expect(logbookRows([record], TODAY, 0)).toHaveLength(rows);
    });
  }

  it("draws a row for today's completion, which listOf keeps in its own list", () => {
    // The other direction is no longer total, and this is the one place that
    // says so: a completion made today has a Logbook row and is filed in
    // Today, so whoever draws the Logbook owns what today's rows do there.
    const closed = task({ done: true, when: TODAY, doneAt: `${TODAY}T09:00:00.000Z` });

    expect(listOf(closed, TODAY, 0)).toBe("today");
    expect(logbookRows([closed], TODAY, 0)).toHaveLength(1);
  });

  it("keeps the history of a repeat that was stopped", () => {
    // Stopping a rule leaves the instance as an ordinary open task and keeps
    // its completions, so the rows outlive the rule. They are history from
    // there on: there is no rule left to put the series back on.
    const stopped = task({
      when: "2026-09-14",
      log: [
        { scheduled: "2026-09-12", completedAt: "2026-09-12T09:00:00.000Z" },
        { scheduled: "2026-09-13", completedAt: "2026-09-13T09:00:00.000Z" },
      ],
    });

    const rows = logbookRows([stopped], TODAY, 0);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.untickable)).toEqual([false, false]);
    // And the record itself is still open, in the list its day puts it in.
    expect(listOf(stopped, TODAY)).toBe("upcoming");
  });

  it("puts the untick on the record's own done, not on its newest entry", () => {
    // A record that owns its `done` answers the untick through that. Offering
    // it on the log entry as well would be two gestures for one state.
    const both = task({
      done: true,
      doneAt: "2026-09-13T12:00:00.000Z",
      repeat: { freq: "daily" },
      log: [{ scheduled: "2026-09-13", completedAt: "2026-09-13T09:00:00.000Z" }],
    });

    const rows = logbookRows([both], TODAY, 0);

    expect(rows.map((row) => row.untickable)).toEqual([true, false]);
    expect(rows[0].key).toBe(both.id);
  });

  it("restores what when held, including the word and the absence", () => {
    const parked = task({
      repeat: { freq: "daily" },
      when: "2026-09-14",
      log: [
        { scheduled: "someday", completedAt: "2026-09-12T09:00:00.000Z" },
        { completedAt: "2026-09-13T09:00:00.000Z" },
      ],
    });

    const rows = logbookRows([parked], TODAY, 0);

    // The row carries the instance's own `when`, which is what the untick puts
    // back: a `someday` repeat comes back on `someday` and an Inbox one comes
    // back with no day at all.
    expect(rows[0].task.when).toBeUndefined();
    expect("when" in rows[0].task).toBe(false);
    expect(rows[1].task.when).toBe("someday");
  });
});

describe("a completion stays where it was for the rest of the day", () => {
  const doneToday = (over: Partial<TaskView> = {}): TaskView =>
    task({ done: true, doneAt: `${TODAY}T09:00:00.000Z`, ...over });

  it.each([
    ["a dated task", { when: TODAY }, "today"],
    ["a task due tomorrow", { when: "2026-09-14" }, "upcoming"],
    ["a parked task", { when: "someday" }, "someday"],
    ["an inbox task", {}, "inbox"],
  ])("files %s completed today in %s", (_name, fields, expected) => {
    expect(listOf(doneToday(fields), TODAY, 0)).toBe(expected);
  });

  it("files the same record in the logbook the next day", () => {
    expect(listOf(doneToday({ when: TODAY }), "2026-09-14", 0)).toBe("logbook");
  });

  it("reads the completion day in the reader's own offset", () => {
    // 22:30 UTC is half past one in the morning in Moscow, so the reader's day
    // is the 14th and the completion is already history for them.
    const late = task({ done: true, doneAt: `${TODAY}T22:30:00.000Z`, when: TODAY });
    expect(listOf(late, "2026-09-14", 180)).toBe("today");
    expect(listOf(late, TODAY, 180)).toBe("logbook");
  });

  it("files a completion with no instant in the logbook, as it always did", () => {
    expect(listOf(task({ done: true }), TODAY, 0)).toBe("logbook");
  });

  it("keeps the group it would have had open", () => {
    expect(groupFor(doneToday({ when: TODAY, category: "Home" }), TODAY, 0)).toMatchObject({
      key: "Home",
      label: "Home",
    });
  });

  it("sorts a completion after every open row of its group", () => {
    const open = task({ id: "task-open", when: TODAY, created: "2026-09-01T09:00:00.000Z" });
    const closed = doneToday({ id: "task-closed", when: TODAY, created: "2026-09-13T09:00:00.000Z" });
    expect(compareInGroup(closed, open, "today")).toBeGreaterThan(0);
    expect(compareInGroup(open, closed, "today")).toBeLessThan(0);
  });
});

describe("This Evening", () => {
  it("is the last group of today", () => {
    const evening = groupFor(task({ when: TODAY, evening: true }), TODAY);
    expect(evening).toEqual({ key: "evening", label: "This Evening", order: 2 });
    expect(compareGroups(groupFor(task({ when: TODAY, category: "Home" }), TODAY), evening))
      .toBeLessThan(0);
    expect(compareGroups(groupFor(task({ when: TODAY }), TODAY), evening)).toBeLessThan(0);
  });

  it("outranks the category, because the evening is when and a category is what", () => {
    expect(groupFor(task({ when: TODAY, evening: true, category: "Home" }), TODAY).key)
      .toBe("evening");
  });

  it("groups an evening task tomorrow by its day, not by the evening", () => {
    expect(groupFor(task({ when: "2026-09-14", evening: true }), TODAY).label).toBe("Tomorrow");
  });

  it("makes an overdue evening an ordinary overdue row", () => {
    const late = task({ when: "2026-09-11", evening: true });
    expect(listOf(late, TODAY)).toBe("today");
    expect(groupFor(late, TODAY)).toMatchObject({ key: "", label: null });
  });

  it("keeps a completed evening task in This Evening, at the bottom", () => {
    const closed = task({
      when: TODAY,
      evening: true,
      done: true,
      doneAt: `${TODAY}T20:30:00.000Z`,
    });
    expect(groupFor(closed, TODAY, 0).key).toBe("evening");
  });
});

describe("the clock sorts inside a group", () => {
  const at = (id: string, time?: string): TaskView =>
    task({ id, when: TODAY, ...(time ? { time } : {}) });

  it("puts timed rows first, by the clock", () => {
    const rows = [at("task-c"), at("task-b", "13:00"), at("task-a", "09:00")];
    expect(rows.sort((a, b) => compareInGroup(a, b, "today")).map((row) => row.id)).toEqual([
      "task-a",
      "task-b",
      "task-c",
    ]);
  });

  it("leaves untimed rows on the comparator they already had", () => {
    const older = task({ id: "task-old", when: TODAY, created: "2026-09-01T09:00:00.000Z" });
    const newer = task({ id: "task-new", when: TODAY, created: "2026-09-12T09:00:00.000Z" });
    expect(compareInGroup(newer, older, "today")).toBeLessThan(0);
  });

  it("sinks a completion under every open row, whatever clock it kept", () => {
    // THE ORDER OF THE TWO KEYS, falsified. Swapping the done key and the
    // clock key above leaves every other case in this file green, and an open
    // 18:00 row would then sort below a done 09:00 one.
    const open = at("task-evening", "18:00");
    const untimed = at("task-untimed");
    const finished = task({
      id: "task-morning",
      when: TODAY,
      time: "09:00",
      done: true,
      doneAt: `${TODAY}T09:00:00.000Z`,
    });
    const rows = [finished, untimed, open];
    expect(rows.sort((a, b) => compareInGroup(a, b, "today")).map((row) => row.id)).toEqual([
      "task-evening",
      "task-untimed",
      "task-morning",
    ]);
  });

  it("keeps the logbook on completion order, whatever the clock says", () => {
    const early = task({ id: "task-a", time: "09:00", done: true, doneAt: `${TODAY}T18:00:00.000Z` });
    const late = task({ id: "task-b", time: "18:00", done: true, doneAt: `${TODAY}T09:00:00.000Z` });
    expect(compareInGroup(early, late, "logbook")).toBeLessThan(0);
  });
});
