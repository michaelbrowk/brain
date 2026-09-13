import { describe, expect, it, vi } from "vitest";

import { parseTaskRecord } from "./model";
import type { TaskView } from "./model";
import { parseTaskLines } from "./task-lines";
import {
  compareGroups,
  compareInGroup,
  groupFor,
  listOf,
  type ListName,
  type TaskGroup,
} from "./lists";

/** Every date in this file is a `YYYY-MM-DD` string and is compared as one.
 *  `new Date("2026-09-13")` parses as UTC midnight, so `.getDate()` in any
 *  western timezone returns the day before — a bug that waits for the first
 *  traveller. There is no `Date` in `lib/tasks`, and the last case here pins
 *  that. */
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

  it("lands every combination of the five fields in exactly one list", () => {
    const dones = [false, true];
    const whens = [undefined, "2026-09-01", TODAY, "2026-09-20", "someday"] as const;
    const deadlines = [undefined, "2026-09-01", TODAY, "2026-09-20"] as const;
    const categories = [undefined, "Home"] as const;
    const pages = [undefined, "page-garden"] as const;
    const names: ListName[] = ["logbook", "today", "upcoming", "someday", "inbox"];

    const buckets = new Map<string, number>();
    let total = 0;
    for (const done of dones) {
      for (const when of whens) {
        for (const deadline of deadlines) {
          for (const category of categories) {
            for (const page of pages) {
              const list = listOf(task({ done, when, deadline, category, page }), TODAY);
              expect(names).toContain(list);
              buckets.set(list, (buckets.get(list) ?? 0) + 1);
              total += 1;
            }
          }
        }
      }
    }

    expect(total).toBe(160);
    expect([...buckets.values()].reduce((sum, count) => sum + count, 0)).toBe(total);
    // Each of the five is reachable, so no clause is dead.
    expect([...buckets.keys()].sort()).toEqual([...names].sort());
  });

  it("reads no clock", () => {
    const boom = () => {
      throw new Error("lib/tasks must not read the clock");
    };
    const trap = function TrappedDate() {
      boom();
    } as unknown as DateConstructor;
    Object.assign(trap, { now: boom, parse: boom, UTC: boom });

    let results: unknown[] = [];
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
      results = [
        listOf(task({ when: "2026-09-20" }), TODAY),
        groupFor(task({ when: "2026-09-20" }), TODAY),
        groupFor(task({ done: true, doneAt: "2026-09-12T09:00:00.000Z" }), TODAY),
        parseTaskLines("- [ ] alpha"),
        parseTaskRecord({
          id: "task-alpha",
          title: "Water the plants",
          created: "2026-09-13T09:00:00.000Z",
          updated: "2026-09-13T09:00:00.000Z",
        }),
      ];
    } catch (error) {
      thrown = error;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(trapArmed).toBe(true);
    expect(thrown).toBeNull();
    expect(results).toHaveLength(5);
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
  it("puts the newest first everywhere but the logbook", () => {
    const older = task({ id: "task-older", created: "2026-09-01T09:00:00.000Z" });
    const newer = task({ id: "task-newer", created: "2026-09-12T09:00:00.000Z" });
    expect([older, newer].sort((a, b) => compareInGroup(a, b, "today"))).toEqual([
      newer,
      older,
    ]);
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
