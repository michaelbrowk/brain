// The derive-and-sort of a list from records, with the clock nowhere near it.
// Every case hands `today` and an offset in, the way the surface hands the
// browser's own local day in, so a table of records has exactly one answer.

import { describe, expect, it } from "vitest";
import type { ListName } from "@/lib/tasks/lists";
import type { TaskView } from "@/lib/tasks/model";
import {
  countsFor,
  dayLabel,
  deadlineCaption,
  doneTimeOf,
  eveningMoon,
  headerLabel,
  movesRow,
  overdueWhenCaption,
  reminderFired,
  sectionsFor,
  timeCaption,
  whenLabel,
  type TasksView,
} from "./tasks-lists";

const TODAY = "2026-09-13"; // a Sunday
const UTC = 0;

function task(id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: id,
    created: "2026-09-01T09:00:00.000Z",
    updated: "2026-09-01T09:00:00.000Z",
    done: false,
    ...over,
  };
}

/** The shape a case asserts: the header of each group in order, with the ids
 *  under it. `null` is a group that draws no header. */
function shape(sections: ReturnType<typeof sectionsFor>) {
  return sections.map((section) => [
    section.group.label,
    section.rows.map((row) => row.task.id),
  ]);
}

const list = (name: ListName): TasksView => ({ kind: "list", list: name });

describe("sectionsFor", () => {
  it("puts the no-category group first in Today and gives it no header", () => {
    const tasks = [
      task("a", { when: TODAY, category: "Work" }),
      task("b", { when: TODAY }),
      task("c", { when: TODAY, category: "Home" }),
    ];
    expect(shape(sectionsFor(tasks, list("today"), TODAY, UTC))).toEqual([
      [null, ["b"]],
      ["Home", ["c"]],
      ["Work", ["a"]],
    ]);
  });

  it("orders newest first inside a Today group", () => {
    const tasks = [
      task("old", { when: TODAY, created: "2026-09-01T09:00:00.000Z" }),
      task("new", { when: TODAY, created: "2026-09-12T09:00:00.000Z" }),
    ];
    expect(shape(sectionsFor(tasks, list("today"), TODAY, UTC))).toEqual([
      [null, ["new", "old"]],
    ]);
  });

  it("keeps an overdue when inside its own category, with no group of its own", () => {
    const tasks = [
      task("late", { when: "2026-09-08", category: "Work" }),
      task("now", {
        when: TODAY,
        category: "Work",
        created: "2026-09-12T09:00:00.000Z",
      }),
    ];
    expect(shape(sectionsFor(tasks, list("today"), TODAY, UTC))).toEqual([
      ["Work", ["now", "late"]],
    ]);
  });

  it("groups Upcoming by day, then next week, then one group a date", () => {
    const tasks = [
      task("far", { when: "2026-10-20" }),
      task("tomorrow", { when: "2026-09-14" }),
      task("thursday", { when: "2026-09-17" }),
      task("nextweek", { when: "2026-09-24" }),
    ];
    expect(shape(sectionsFor(tasks, list("upcoming"), TODAY, UTC))).toEqual([
      ["Tomorrow", ["tomorrow"]],
      ["Thu 17", ["thursday"]],
      ["Next week", ["nextweek"]],
      // Past next week each day names itself: one "Later" pile holds months
      // of rows under one word.
      ["20 Oct", ["far"]],
    ]);
  });

  it("groups Logbook by completion day, newest day first", () => {
    const tasks = [
      task("x", { done: true, doneAt: "2026-09-13T08:00:00.000Z" }),
      task("y", { done: true, doneAt: "2026-09-13T10:00:00.000Z" }),
      task("z", { done: true, doneAt: "2026-09-12T10:00:00.000Z" }),
      task("w", { done: true, doneAt: "2026-09-11T10:00:00.000Z" }),
    ];
    expect(shape(sectionsFor(tasks, list("logbook"), TODAY, UTC))).toEqual([
      ["Today", ["y", "x"]],
      ["Yesterday", ["z"]],
      ["11 Sep", ["w"]],
    ]);
  });

  it("reads the Logbook day in the reader's own offset, never off the instant", () => {
    // 22:30 UTC on the 12th is 02:30 on the 13th in Dubai (+240)
    const tasks = [task("dubai", { done: true, doneAt: "2026-09-12T22:30:00.000Z" })];
    expect(shape(sectionsFor(tasks, list("logbook"), TODAY, 240))).toEqual([
      ["Today", ["dubai"]],
    ]);
    expect(shape(sectionsFor(tasks, list("logbook"), TODAY, UTC))).toEqual([
      ["Yesterday", ["dubai"]],
    ]);
  });

  it("groups Someday by category and Inbox not at all", () => {
    const someday = [
      task("s1", { when: "someday", category: "Reading" }),
      task("s2", { when: "someday" }),
    ];
    expect(shape(sectionsFor(someday, list("someday"), TODAY, UTC))).toEqual([
      [null, ["s2"]],
      ["Reading", ["s1"]],
    ]);

    const inbox = [
      task("i1", { created: "2026-09-02T09:00:00.000Z" }),
      task("i2", { created: "2026-09-03T09:00:00.000Z", category: "Work" }),
    ];
    expect(shape(sectionsFor(inbox, list("inbox"), TODAY, UTC))).toEqual([
      [null, ["i2", "i1"]],
    ]);
  });

  it("groups a category view by time, undated first and without a header", () => {
    const view: TasksView = { kind: "category", category: "Work" };
    const tasks = [
      task("undated", { category: "Work" }),
      task("someday", { category: "Work", when: "someday" }),
      task("today", { category: "Work", when: TODAY }),
      task("tomorrow", { category: "Work", when: "2026-09-14" }),
      task("later", { category: "Work", when: "2026-09-30" }),
      task("other", { category: "Home", when: TODAY }),
      // Finished this morning, and undated, so it sinks to the foot of the
      // headerless group it was open in rather than leaving the view.
      task("done", { category: "Work", done: true, doneAt: "2026-09-13T08:00:00.000Z" }),
    ];
    expect(shape(sectionsFor(tasks, view, TODAY, UTC))).toEqual([
      [null, ["undated", "done"]],
      ["Today", ["today"]],
      ["Tomorrow", ["tomorrow"]],
      ["Later", ["later"]],
      ["Someday", ["someday"]],
    ]);
  });

  it("selects the uncategorised tasks when the category view carries an empty word", () => {
    const view: TasksView = { kind: "category", category: "" };
    const tasks = [task("bare", { when: TODAY }), task("filed", { when: TODAY, category: "Work" })];
    expect(shape(sectionsFor(tasks, view, TODAY, UTC))).toEqual([["Today", ["bare"]]]);
  });

  it("collates category headers under the reader's own locale", () => {
    const tasks = [
      task("a", { when: TODAY, category: "Ёлка" }),
      task("b", { when: TODAY, category: "Единорог" }),
      task("c", { when: TODAY, category: "Apple" }),
    ];
    expect(
      sectionsFor(tasks, list("today"), TODAY, UTC).map((s) => s.group.label),
    ).toEqual(["Apple", "Единорог", "Ёлка"]);
  });
});

describe("movesRow", () => {
  // The four reasons a record is in Today. Today pressed on any of them
  // writes the day and moves nothing, which is what the row's fold and the
  // report both read.
  it.each([
    ["the day it is meant for is today", { when: TODAY }],
    ["that day is past", { when: "2026-09-08" }],
    ["a deadline has arrived and no day is set", { deadline: TODAY }],
    [
      "a deadline has arrived over a day still ahead",
      { when: "2026-09-20", deadline: TODAY },
    ],
  ])("is false for Today on a task already in Today: %s", (_reason, over) => {
    expect(movesRow(task("a", over), TODAY, TODAY)).toBe(false);
  });

  it("is false for Someday on a task already parked", () => {
    expect(movesRow(task("a", { when: "someday" }), "someday", TODAY)).toBe(false);
  });

  it("is true whenever the record lands in another list", () => {
    expect(movesRow(task("a", { when: TODAY }), "2026-09-14", TODAY)).toBe(true);
    expect(movesRow(task("a", { when: TODAY }), "someday", TODAY)).toBe(true);
    expect(movesRow(task("a", { when: "someday" }), TODAY, TODAY)).toBe(true);
    expect(movesRow(task("a", { when: "2026-09-20" }), TODAY, TODAY)).toBe(true);
    expect(movesRow(task("a"), TODAY, TODAY)).toBe(true);
  });

  // Upcoming groups by day, so two days that are both ahead are two places.
  it("is true for a day inside Upcoming that lands under another header", () => {
    expect(movesRow(task("a", { when: "2026-09-20" }), "2026-09-14", TODAY)).toBe(true);
  });

  // A category is not a day, so a reschedule never changes the header a task
  // stands under in Today.
  it("reads the same answer for a filed task as for a bare one", () => {
    expect(movesRow(task("a", { when: TODAY, category: "Work" }), TODAY, TODAY)).toBe(
      false,
    );
  });
});

describe("the words a row and a header say", () => {
  it("names an overdue when by its weekday and never by a count of days", () => {
    expect(overdueWhenCaption(task("a", { when: "2026-09-08" }), TODAY)).toBe("since Tue");
    expect(overdueWhenCaption(task("a", { when: TODAY }), TODAY)).toBeNull();
    expect(overdueWhenCaption(task("a", { when: "2026-09-20" }), TODAY)).toBeNull();
    expect(overdueWhenCaption(task("a", { when: "someday" }), TODAY)).toBeNull();
  });

  it.each([
    ["2026-09-15", "15 Sep", false],
    // The day itself is not late. Every task with a deadline is in Today on
    // its own day, so red here would fire for every deadline, every time.
    [TODAY, "13 Sep", false],
    ["2026-09-12", "12 Sep", true],
    ["2026-09-11", "11 Sep", true],
  ])(
    "draws the deadline %s as the bare date, red only once it is past",
    (deadline, label, overdue) => {
      expect(deadlineCaption(task("a", { deadline }), TODAY)).toEqual({
        label,
        overdue,
      });
    },
  );

  it("has no deadline caption at all when the task carries none", () => {
    expect(deadlineCaption(task("a"), TODAY)).toBeNull();
  });

  it("writes the pill tail and the Logbook header the way the spec says them", () => {
    expect(dayLabel(TODAY)).toBe("13 Sep");
    expect(headerLabel("Today", 5)).toBe("Today · 5");
    expect(headerLabel("12 Sep", 7)).toBe("12 Sep · 7");
  });

  it("reads a completion time in the reader's offset", () => {
    expect(doneTimeOf("2026-09-13T09:05:00.000Z", 0)).toMatch(/9[:.]05/);
    expect(doneTimeOf("2026-09-12T22:30:00.000Z", 240)).toMatch(/2[:.]30/);
  });
});

/** THE LOGBOOK COUNTS COMPLETIONS AND EVERY OTHER LIST COUNTS RECORDS.
 *
 *  A repeating task is never done, so it is in Today or Upcoming as one row
 *  and in the Logbook as one row per entry in its `log`. That is the only
 *  place in the column where a record draws more than one row, and it is why
 *  a section carries rows rather than tasks. */
describe("sectionsFor, the Logbook of a repeating task", () => {
  const words = (log: { scheduled: string; completedAt: string }[]): TaskView =>
    task("words", { repeat: { freq: "daily" }, when: "2026-09-14", log });

  it("draws one row per completion, under the day each was finished on", () => {
    const sections = sectionsFor(
      [
        words([
          { scheduled: "2026-09-12", completedAt: "2026-09-12T09:00:00.000Z" },
          { scheduled: "2026-09-13", completedAt: "2026-09-13T09:00:00.000Z" },
        ]),
      ],
      list("logbook"),
      TODAY,
      UTC,
    );

    expect(shape(sections)).toEqual([
      ["Today", ["words"]],
      ["Yesterday", ["words"]],
    ]);
    // One id and two rows, so the key cannot be the id: two rows answering to
    // one selection would light together.
    expect(sections.flatMap((section) => section.rows.map((row) => row.key))).toEqual([
      "words:2026-09-13T09:00:00.000Z",
      "words:2026-09-12T09:00:00.000Z",
    ]);
    expect(
      sections.flatMap((section) => section.rows.map((row) => row.untickable)),
    ).toEqual([true, false]);
  });

  it("keeps the open instance out of the Logbook and in the list it is due in", () => {
    const tasks = [
      words([{ scheduled: "2026-09-13", completedAt: "2026-09-13T09:00:00.000Z" }]),
    ];

    expect(shape(sectionsFor(tasks, list("upcoming"), TODAY, UTC))).toEqual([
      ["Tomorrow", ["words"]],
    ]);
    expect(shape(sectionsFor(tasks, list("today"), TODAY, UTC))).toEqual([]);
    expect(shape(sectionsFor(tasks, list("logbook"), TODAY, UTC))).toEqual([
      ["Today", ["words"]],
    ]);
  });

  it("gives an ordinary row the record's own id as its key", () => {
    const sections = sectionsFor([task("a", { when: TODAY })], list("today"), TODAY, UTC);

    expect(sections[0].rows.map((row) => row.key)).toEqual(["a"]);
    expect(sections[0].rows[0].untickable).toBe(true);
  });
});

/** A COMPLETION STAYS IN ITS LIST FOR THE DAY, AND IS IN THE LOGBOOK TOO.
 *
 *  Both, from the same record, on the same day. The Logbook is a read of
 *  completions and not a filter over `listOf`, so the two answers are pinned
 *  against each other here rather than one being derived from the other. */
describe("a completion made today, read both ways", () => {
  const both = [
    task("open", { when: TODAY, category: "Work" }),
    task("done", {
      when: TODAY,
      category: "Work",
      done: true,
      doneAt: `${TODAY}T09:00:00.000Z`,
    }),
  ];

  it("sits at the foot of its own group in the Today view", () => {
    expect(shape(sectionsFor(both, list("today"), TODAY, UTC))).toEqual([
      ["Work", ["open", "done"]],
    ]);
  });

  /** Every list the spec names, one row each. The Today case above is the one
   *  anybody watches. These three were right and unpinned, which is how a
   *  derive quietly loses one of them. */
  it.each([
    [
      "Upcoming",
      "upcoming" as const,
      { when: "2026-09-16" },
      ["Wed 16", ["upcoming-open", "upcoming-done"]],
    ],
    ["Inbox", "inbox" as const, {}, [null, ["inbox-open", "inbox-done"]]],
    [
      "Someday",
      "someday" as const,
      { when: "someday" },
      [null, ["someday-open", "someday-done"]],
    ],
  ])("keeps a completion made today in %s, at the foot of its group", (
    name,
    listName,
    over,
    expected,
  ) => {
    const stem = name.toLowerCase();
    const tasks = [
      task(`${stem}-open`, over),
      task(`${stem}-done`, {
        ...over,
        done: true,
        doneAt: `${TODAY}T09:00:00.000Z`,
      }),
    ];
    expect(shape(sectionsFor(tasks, list(listName), TODAY, UTC))).toEqual([expected]);
  });

  /** Spec 2 names the category view beside the four lists, and it was the one
   *  that erased the morning's work the instant it was done. */
  it("keeps it in a category view too, sunk under what is still open", () => {
    expect(
      shape(
        sectionsFor(
          both,
          { kind: "category", category: "Work" },
          TODAY,
          UTC,
        ),
      ),
    ).toEqual([["Today", ["open", "done"]]]);
  });

  it("lets a completion made YESTERDAY leave the category view for the Logbook", () => {
    const yesterday = [
      task("stale", {
        when: TODAY,
        category: "Work",
        done: true,
        doneAt: "2026-09-12T09:00:00.000Z",
      }),
    ];
    expect(
      shape(
        sectionsFor(
          yesterday,
          { kind: "category", category: "Work" },
          TODAY,
          UTC,
        ),
      ),
    ).toEqual([]);
  });

  it("sits under Today in the Logbook view, by the day it was finished", () => {
    expect(shape(sectionsFor(both, list("logbook"), TODAY, UTC))).toEqual([
      ["Today", ["done"]],
    ]);
  });

  it("reads the day it was finished in the reader's own offset, not UTC's", () => {
    // 21:00 UTC on the 13th is 01:00 on the 14th in Dubai (+240), so a reader
    // there finished it TODAY and the row has not moved out of their list.
    const late = [
      task("late", {
        when: "2026-09-14",
        category: "Work",
        done: true,
        doneAt: "2026-09-13T21:00:00.000Z",
      }),
    ];
    expect(shape(sectionsFor(late, list("today"), "2026-09-14", 240))).toEqual([
      ["Work", ["late"]],
    ]);
    expect(shape(sectionsFor(late, list("today"), "2026-09-14", UTC))).toEqual([]);
  });

  it("counts for the Done-for-today state off the completion, not off the list", () => {
    expect(countsFor(both, TODAY, UTC).doneToday).toBe(1);
  });
});

/** The three things the row's tail derives from the record and nothing else. */
describe("the row's clock, moon and fired reminder", () => {
  it("gives the stored clock back verbatim, and null when there is none", () => {
    expect(timeCaption(task("a", { when: TODAY, time: "13:00" }))).toBe("13:00");
    expect(timeCaption(task("b", { when: TODAY }))).toBeNull();
  });

  it("stands the moon on an evening today and on one still ahead", () => {
    expect(eveningMoon(task("a", { when: TODAY, evening: true }), TODAY)).toBe(true);
    expect(eveningMoon(task("b", { when: "2026-09-14", evening: true }), TODAY)).toBe(
      true,
    );
  });

  it("takes the moon off an evening already past, and off a task with no day", () => {
    expect(eveningMoon(task("a", { when: "2026-09-11", evening: true }), TODAY)).toBe(
      false,
    );
    expect(eveningMoon(task("b", { evening: true }), TODAY)).toBe(false);
    expect(eveningMoon(task("c", { when: TODAY }), TODAY)).toBe(false);
  });

  it("reads a reminder as fired only while the task is still open", () => {
    const at = `${TODAY}T12:00:00.000Z`;
    expect(reminderFired(task("a", { when: TODAY, remindedAt: at }))).toBe(true);
    expect(
      reminderFired(
        task("b", {
          when: TODAY,
          remindedAt: at,
          done: true,
          doneAt: `${TODAY}T13:00:00.000Z`,
        }),
      ),
    ).toBe(false);
    expect(reminderFired(task("c", { when: TODAY }))).toBe(false);
  });
});

/** THE WORD A MOVE IS REPORTED IN, one row per answer there is. */
describe("whenLabel", () => {
  it.each<[string | null | undefined, string]>([
    [TODAY, "Today"],
    ["2026-09-14", "Tomorrow"],
    ["someday", "Someday"],
    [null, "No date"],
    ["2026-09-20", "20 Sep"],
    // Yesterday is a date and never the word. The tail already says "since
    // Sat" over an overdue row, and a second wording here would be a second
    // answer to where the task went.
    ["2026-09-12", "12 Sep"],
  ])("reads %s as %s", (when, label) => {
    expect(whenLabel(when, TODAY)).toBe(label);
  });

  it("reads a missing day the same way it reads a cleared one", () => {
    expect(whenLabel(undefined, TODAY)).toBe("No date");
  });
});
