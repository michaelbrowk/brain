import { describe, expect, it, vi } from "vitest";

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
    const record = {
      id: "task-alpha",
      title: "Water the plants",
      created: "2026-09-13T09:00:00.000Z",
      updated: "2026-09-13T09:00:00.000Z",
    };
    const anchor = { text: "alpha", hash: "0123456789abcdef", ordinal: 0, line: 0 };
    const group = { key: "", label: null, order: 0 };
    const noIssues = { addIssue: () => {} };

    /** Every exported function and schema, with an argument that reaches its
     *  own branch. A Today task and an inbox task are here because a clock
     *  read inside the category branch went undetected without them. */
    const exercised: Record<string, () => unknown> = {
      listOf: () => listOf(task({ when: "2026-09-20" }), TODAY),
      groupFor: () => [
        groupFor(task(), TODAY),
        groupFor(task({ when: TODAY, category: "Home" }), TODAY),
        groupFor(task({ when: TODAY }), TODAY),
        groupFor(task({ when: "someday", category: "Reading" }), TODAY),
        groupFor(task({ when: "2026-09-20" }), TODAY),
        groupFor(task({ done: true, doneAt: "2026-09-12T09:00:00.000Z" }), TODAY, 180),
        groupFor(task({ done: true }), TODAY),
      ],
      doneDayOf: () => doneDayOf("2026-09-12T22:00:00.000Z", -300),
      compareGroups: () => compareGroups(group, { key: "Home", label: "Home", order: 1 }),
      compareInGroup: () => [
        compareInGroup(task(), task({ id: "task-beta" }), "today"),
        compareInGroup(task(), task({ id: "task-beta" }), "logbook"),
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
    };

    // A new export has to be added above, or this fails before the trap runs.
    const callable = [modelModule, taskLinesModule, listsModule].flatMap((module) =>
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
    ["2026-09-20", "Sun 20"],
    ["2026-09-21", "Next week"],
    ["2026-09-27", "Next week"],
    ["2026-09-28", "Later"],
    ["2027-01-04", "Later"],
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
    ["2026-09-13T21:00:00.000Z", "Today"],
    ["2026-09-12T21:00:00.000Z", "Yesterday"],
    ["2026-09-05T21:00:00.000Z", "5 Sep"],
    ["2026-08-12T21:00:00.000Z", "12 Aug"],
  ])("labels a completion at %s as %s", (doneAt, label) => {
    expect(groupFor(task({ done: true, doneAt }), TODAY).label).toBe(label);
  });

  it("files a completion under the reader's own day, not the UTC one", () => {
    // 22:00Z on the 12th is already the 13th in Dubai and still the 12th in
    // New York. The instant is one value, the day is the reader's.
    const done = task({ done: true, doneAt: "2026-09-12T22:00:00.000Z" });
    expect(groupFor(done, TODAY, 240).label).toBe("Today");
    expect(groupFor(done, TODAY, -300).label).toBe("Yesterday");
    expect(groupFor(done, TODAY, 0).label).toBe("Yesterday");
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
    const today = groupFor(task({ done: true, doneAt: "2026-09-13T21:00:00.000Z" }), TODAY);
    const older = groupFor(task({ done: true, doneAt: "2026-09-05T21:00:00.000Z" }), TODAY);
    expect(compareGroups(today, older)).toBeLessThan(0);
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
