// The derive-and-sort of a list from records, with the clock nowhere near it.
// Every case hands `today` and an offset in, the way the surface hands the
// browser's own local day in, so a table of records has exactly one answer.

import { describe, expect, it } from "vitest";
import type { ListName } from "@/lib/tasks/lists";
import type { TaskView } from "@/lib/tasks/model";
import {
  dayLabel,
  deadlineCaption,
  doneTimeOf,
  headerLabel,
  overdueWhenCaption,
  sectionsFor,
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

  it("groups Upcoming by day with Tomorrow first and Later last", () => {
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
      ["Later", ["far"]],
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
      task("done", { category: "Work", done: true, doneAt: "2026-09-13T08:00:00.000Z" }),
    ];
    expect(shape(sectionsFor(tasks, view, TODAY, UTC))).toEqual([
      [null, ["undated"]],
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

describe("the words a row and a header say", () => {
  it("names an overdue when by its weekday and never by a count of days", () => {
    expect(overdueWhenCaption(task("a", { when: "2026-09-08" }), TODAY)).toBe("since Tue");
    expect(overdueWhenCaption(task("a", { when: TODAY }), TODAY)).toBeNull();
    expect(overdueWhenCaption(task("a", { when: "2026-09-20" }), TODAY)).toBeNull();
    expect(overdueWhenCaption(task("a", { when: "someday" }), TODAY)).toBeNull();
  });

  it("shows a deadline as the bare date, and marks the ones already owed", () => {
    expect(deadlineCaption(task("a", { deadline: "2026-09-15" }), TODAY)).toEqual({
      label: "15 Sep",
      overdue: false,
    });
    expect(deadlineCaption(task("a", { deadline: "2026-09-11" }), TODAY)).toEqual({
      label: "11 Sep",
      overdue: true,
    });
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
