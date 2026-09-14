import { describe, expect, it } from "vitest";
import { MISSED_AFTER_MS, dueReminders, zonedInstant } from "./due";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("zonedInstant", () => {
  it("reads a summer wall clock through the zone's summer offset", () => {
    expect(iso(zonedInstant("2026-09-14", "13:00", "Europe/Lisbon"))).toBe(
      "2026-09-14T12:00:00.000Z",
    );
  });

  it("reads a winter wall clock through the zone's winter offset", () => {
    expect(iso(zonedInstant("2026-01-15", "13:00", "Europe/Lisbon"))).toBe(
      "2026-01-15T13:00:00.000Z",
    );
  });

  it("reads a zone far from UTC", () => {
    expect(iso(zonedInstant("2026-09-14", "13:00", "Asia/Dubai"))).toBe(
      "2026-09-14T09:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-09-14", "00:30", "Pacific/Auckland"))).toBe(
      "2026-09-13T12:30:00.000Z",
    );
  });

  it("maps a wall clock inside the spring-forward gap to the instant the clock jumps to", () => {
    // Lisbon 2026-03-29: 00:59:59 WET is followed by 02:00:00 WEST, so 01:30
    // never happens. The reminder rings when the clock reaches it, not an hour
    // early, so the instant is the one the jump lands on.
    expect(iso(zonedInstant("2026-03-29", "01:30", "Europe/Lisbon"))).toBe(
      "2026-03-29T01:30:00.000Z",
    );
  });

  it("takes the first of two identical wall clocks on a fall-back day", () => {
    // Lisbon 2026-10-25: 01:59:59 WEST is followed by 01:00:00 WET, so 01:30
    // happens twice. The first is the one a person means.
    expect(iso(zonedInstant("2026-10-25", "01:30", "Europe/Lisbon"))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
  });

  it("crosses a year boundary the same way", () => {
    expect(iso(zonedInstant("2026-12-31", "23:59", "Europe/Lisbon"))).toBe(
      "2026-12-31T23:59:00.000Z",
    );
  });

  it("answers null for a zone the platform does not know", () => {
    expect(zonedInstant("2026-09-14", "13:00", "Mars/Olympus")).toBeNull();
  });

  it("answers null for a day or a time it cannot read", () => {
    expect(zonedInstant("2026-9-14", "13:00", "Europe/Lisbon")).toBeNull();
    expect(zonedInstant("2026-09-14", "25:00", "Europe/Lisbon")).toBeNull();
    expect(zonedInstant("2026-09-14", "1300", "Europe/Lisbon")).toBeNull();
  });

  it("reads no clock of its own", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await readFile(path.join(process.cwd(), "lib/reminders/due.ts"), "utf8");
    expect(source).not.toContain("Date.now()");
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });
});

type Task = Record<string, unknown>;
const view = (extra: Task): Task => ({
  id: "task-alpha",
  title: "Water the plants",
  created: "2026-09-14T08:00:00.000Z",
  updated: "2026-09-14T08:00:00.000Z",
  done: false,
  ...extra,
});

// 2026-09-14 13:00 in Lisbon is 12:00:00Z.
const AT = Date.parse("2026-09-14T12:00:00.000Z");

describe("dueReminders", () => {
  const due = (tasks: Task[], nowIso: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dueReminders(tasks as any, "Europe/Lisbon", Date.parse(nowIso));

  it("fires a task whose instant has arrived", () => {
    const rows = due([view({ when: "2026-09-14", time: "13:00" })], "2026-09-14T12:00:00.000Z");
    expect(rows).toEqual([
      {
        kind: "fire",
        id: "task-alpha",
        title: "Water the plants",
        when: "2026-09-14",
        time: "13:00",
        at: AT,
      },
    ]);
  });

  it("leaves a task whose instant is still ahead", () => {
    expect(due([view({ when: "2026-09-14", time: "13:00" })], "2026-09-14T11:59:59.999Z")).toEqual(
      [],
    );
  });

  it("fires a reminder the server missed by less than a day", () => {
    const rows = due([view({ when: "2026-09-14", time: "13:00" })], "2026-09-15T11:59:00.000Z");
    expect(rows.map((r) => r.kind)).toEqual(["fire"]);
  });

  it("writes a reminder older than a day as missed", () => {
    const rows = due([view({ when: "2026-09-14", time: "13:00" })], "2026-09-15T12:00:00.000Z");
    expect(rows.map((r) => r.kind)).toEqual(["missed"]);
  });

  it("puts the boundary at exactly twenty-four hours", () => {
    expect(MISSED_AFTER_MS).toBe(86_400_000);
  });

  it("leaves a task whose reminder already fired", () => {
    expect(
      due(
        [view({ when: "2026-09-14", time: "13:00", remindedAt: "2026-09-14T12:00:00.000Z" })],
        "2026-09-14T12:30:00.000Z",
      ),
    ).toEqual([]);
  });

  it("leaves a task that is done", () => {
    expect(
      due([view({ when: "2026-09-14", time: "13:00", done: true })], "2026-09-14T12:30:00.000Z"),
    ).toEqual([]);
  });

  it("leaves a task with no time, a someday task and an undated task", () => {
    expect(
      due(
        [
          view({ id: "task-beta", when: "2026-09-14" }),
          view({ id: "task-gamma", when: "someday", time: "13:00" }),
          view({ id: "task-delta", time: "13:00" }),
        ],
        "2026-09-14T23:00:00.000Z",
      ),
    ).toEqual([]);
  });

  it("fires an evening task by its clock, not by the section", () => {
    const rows = due(
      [view({ when: "2026-09-14", time: "20:00", evening: true })],
      "2026-09-14T19:30:00.000Z",
    );
    expect(rows.map((r) => r.kind)).toEqual(["fire"]);
  });

  it("orders the due list oldest first, so the centre is written in time order", () => {
    const rows = due(
      [
        view({ id: "task-late", when: "2026-09-14", time: "14:00" }),
        view({ id: "task-early", when: "2026-09-14", time: "09:00" }),
      ],
      "2026-09-14T15:00:00.000Z",
    );
    expect(rows.map((r) => r.id)).toEqual(["task-early", "task-late"]);
  });

  it("answers an empty list for a zone the platform does not know", () => {
    expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dueReminders([view({ when: "2026-09-14", time: "13:00" })] as any, "Mars/Olympus", AT),
    ).toEqual([]);
  });
});
