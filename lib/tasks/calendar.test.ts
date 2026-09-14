// The month grid's arithmetic, on the same table shape `lists.test.ts` uses.
// Every date here is a `YYYY-MM-DD` string compared as one, and the last case
// pins that no function in this module reaches for a clock.

import { describe, expect, it, vi } from "vitest";

import {
  monthGridOf,
  monthLabel,
  monthName,
  monthOfDay,
  shiftDay,
  shiftMonth,
} from "./calendar";

describe("the month grid", () => {
  it("is six rows of seven, Monday first", () => {
    const grid = monthGridOf("2026-09");
    expect(grid).toHaveLength(42);
    // 1 September 2026 is a Tuesday, so the grid opens on Monday 31 August.
    expect(grid[0]).toEqual({ day: "2026-08-31", inMonth: false });
    expect(grid[1]).toEqual({ day: "2026-09-01", inMonth: true });
    expect(grid[41].day).toBe("2026-10-11");
  });

  it("opens on the 1st when the 1st is a Monday", () => {
    // 1 June 2026 is a Monday.
    expect(monthGridOf("2026-06")[0]).toEqual({ day: "2026-06-01", inMonth: true });
  });

  it("holds a four-row February in six rows all the same", () => {
    // February 2027 opens on a Monday and closes on a Sunday, so its own days
    // fill four rows exactly. The grid still draws six, because a control that
    // resizes under the pointer is a control that gets mis-pressed.
    const grid = monthGridOf("2027-02");
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ day: "2027-02-01", inMonth: true });
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(28);
    expect(grid[41].day).toBe("2027-03-14");
  });

  it("carries a year boundary inside one grid", () => {
    const grid = monthGridOf("2026-12");
    expect(grid[41].day).toBe("2027-01-10");
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it("knows a century that is not a leap year", () => {
    expect(monthGridOf("2100-02").filter((cell) => cell.inMonth)).toHaveLength(28);
    expect(shiftDay("2100-02-28", 1)).toBe("2100-03-01");
  });

  it("holds a leap February whole", () => {
    const grid = monthGridOf("2028-02");
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(29);
  });

  it.each([
    ["2026-09", 1, "2026-10"],
    ["2026-12", 1, "2027-01"],
    ["2026-01", -1, "2025-12"],
    ["2026-09", -13, "2025-08"],
  ])("shifts %s by %s to %s", (month, by, expected) => {
    expect(shiftMonth(month, by)).toBe(expected);
  });

  it.each([
    ["2026-09-13", 1, "2026-09-14"],
    ["2026-09-13", 7, "2026-09-20"],
    ["2026-09-30", 1, "2026-10-01"],
    ["2026-01-01", -1, "2025-12-31"],
    ["2028-02-28", 1, "2028-02-29"],
  ])("shifts the day %s by %s to %s", (day, by, expected) => {
    expect(shiftDay(day, by)).toBe(expected);
  });

  it("names the month for a reader", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
  });

  it("names the month on its own, for a sentence a reader hears", () => {
    expect(monthName("2026-09")).toBe("September");
    expect(monthName("2026-01")).toBe("January");
    expect(monthName("2026-12")).toBe("December");
  });

  it("takes the month off a day", () => {
    expect(monthOfDay("2026-09-13")).toBe("2026-09");
  });

  it("reads no clock", () => {
    const boom = () => {
      throw new Error("lib/tasks must not read the clock");
    };
    const trap = function TrappedDate() {
      boom();
    } as unknown as DateConstructor;
    Object.assign(trap, { now: boom, parse: boom, UTC: boom });
    vi.stubGlobal("Date", trap);
    try {
      expect(() => {
        monthGridOf("2026-09");
        shiftMonth("2026-09", 1);
        shiftDay("2026-09-13", 7);
        monthOfDay("2026-09-13");
        monthLabel("2026-09");
        monthName("2026-09");
      }).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
