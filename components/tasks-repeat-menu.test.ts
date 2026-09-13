// The four rows of the repeat menu, as words and as the rule each one would
// write. Three forms and a stop, and no fourth control: no interval field, no
// end date, no count and no "this one or all future" dialog.
//
// The weekday and the day of the month are never asked for. They come off the
// day the task is already on, so the row reads back as the sentence the person
// chose. Every date here is a `YYYY-MM-DD` string and no `Date` crosses the
// boundary.

import { describe, expect, it } from "vitest";

import type { TaskRepeat, TaskView } from "@/lib/tasks/model";

import { repeatOptions, repeatWord } from "./tasks-repeat-menu";

/** 2026-09-13 is a Sunday, 2026-09-14 a Monday, 2026-09-17 a Thursday. */
const TODAY = "2026-09-13";

function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "task-words",
    title: "Learn words",
    created: "2026-09-01T09:00:00.000Z",
    updated: "2026-09-01T09:00:00.000Z",
    done: false,
    ...over,
  };
}

describe("repeatOptions", () => {
  const cases: { name: string; when?: string; labels: string[] }[] = [
    {
      name: "a task on a Thursday offers that Thursday and that day of the month",
      when: "2026-09-17",
      labels: ["Every day", "Every week on Thu", "Every month on the 17th"],
    },
    {
      name: "a task on a Monday offers Monday",
      when: "2026-09-14",
      labels: ["Every day", "Every week on Mon", "Every month on the 14th"],
    },
    {
      name: "a someday task falls back to today",
      when: "someday",
      labels: ["Every day", "Every week on Sun", "Every month on the 13th"],
    },
    {
      name: "a task with no day at all falls back to today",
      labels: ["Every day", "Every week on Sun", "Every month on the 13th"],
    },
  ];

  for (const { name, when, labels } of cases) {
    it(name, () => {
      const options = repeatOptions(task(when === undefined ? {} : { when }), TODAY);
      expect(options.map((option) => option.label)).toEqual(labels);
    });
  }

  it("writes the weekday and the day of the month the rows named", () => {
    const options = repeatOptions(task({ when: "2026-09-17" }), TODAY);

    expect(options.map((option) => option.repeat)).toEqual([
      { freq: "daily" },
      { freq: "weekly", byWeekday: ["thu"] },
      { freq: "monthly", byMonthDay: 17 },
    ]);
  });

  // The ordinal is the one place English breaks its own pattern, and the day
  // of the month walks over every one of the breaks.
  it.each([
    ["2026-09-01", "Every month on the 1st"],
    ["2026-09-02", "Every month on the 2nd"],
    ["2026-09-03", "Every month on the 3rd"],
    ["2026-09-04", "Every month on the 4th"],
    ["2026-09-11", "Every month on the 11th"],
    ["2026-09-12", "Every month on the 12th"],
    ["2026-09-13", "Every month on the 13th"],
    ["2026-09-21", "Every month on the 21st"],
    ["2026-09-22", "Every month on the 22nd"],
    ["2026-09-23", "Every month on the 23rd"],
    ["2026-01-31", "Every month on the 31st"],
  ])("reads %s as %s", (when, label) => {
    expect(repeatOptions(task({ when }), TODAY)[2].label).toBe(label);
  });

  it("offers the stop only once there is a rule to stop", () => {
    expect(repeatOptions(task({ when: TODAY }), TODAY)).toHaveLength(3);

    const options = repeatOptions(
      task({ when: TODAY, repeat: { freq: "daily" } }),
      TODAY,
    );
    expect(options).toHaveLength(4);
    expect(options[3]).toEqual({ kind: "none", label: "Don't repeat", repeat: null });
  });

  it("offers no interval, no end date and no count", () => {
    // The rows are the whole control surface. A form the menu does not draw
    // cannot be asked for, which is what makes the "this one or all future"
    // dialog unnecessary by construction.
    for (const option of repeatOptions(task({ repeat: { freq: "daily" } }), TODAY)) {
      expect(Object.keys(option.repeat ?? {}).sort()).not.toContain("interval");
      expect(Object.keys(option.repeat ?? {}).sort()).not.toContain("until");
      expect(Object.keys(option.repeat ?? {}).sort()).not.toContain("count");
    }
  });
});

describe("repeatWord", () => {
  // The chip names the rule in ONE word, because it stands in a row of chips
  // in a 76px capsule. The menu names what each row would set, because a menu
  // row has to be unambiguous about the weekday it is about to commit to.
  it.each<[TaskRepeat | undefined, string]>([
    [undefined, "Repeat"],
    [{ freq: "daily" }, "Daily"],
    [{ freq: "weekly", byWeekday: ["mon"] }, "Weekly"],
    [{ freq: "monthly", byMonthDay: 15 }, "Monthly"],
  ])("names %o as %s", (repeat, word) => {
    expect(repeatWord(repeat)).toBe(word);
  });
});
