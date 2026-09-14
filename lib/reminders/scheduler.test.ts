import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainNotification } from "@/lib/notifications/model";
import {
  REMINDER_SCAN_MS,
  remindersEnabled,
  runReminderScan,
  scheduleReminderScans,
} from "./scheduler";

type Task = Record<string, unknown>;
const view = (extra: Task): Task => ({
  id: "task-alpha",
  title: "Water the plants",
  created: "2026-09-14T08:00:00.000Z",
  updated: "2026-09-14T08:00:00.000Z",
  done: false,
  ...extra,
});

function harness(overrides: Record<string, unknown> = {}) {
  const notified: BrainNotification[] = [];
  const pushed: { title: string; body?: string; href: string }[] = [];
  const marked: [string, string][] = [];
  const port = {
    tasks: async () => [view({ when: "2026-09-14", time: "13:00" })],
    markReminded: async (id: string, at: string) => {
      marked.push([id, at]);
    },
    zone: async () => "Europe/Lisbon",
    notify: async (n: BrainNotification) => {
      notified.push(n);
      return true;
    },
    push: async (p: { title: string; body?: string; href: string }) => {
      pushed.push(p);
    },
    now: () => Date.parse("2026-09-14T12:00:00.000Z"),
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { port: port as any, notified, pushed, marked };
}

/** The scan warns rather than throws, and a test that expects a warning should
 *  not print one. */
function quiet() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the reminder scan", () => {
  it("scans every thirty seconds", () => {
    expect(REMINDER_SCAN_MS).toBe(30_000);
  });

  it("appends a task-reminder, pushes it and marks the record", async () => {
    const h = harness();
    expect(await runReminderScan(h.port)).toEqual({ fired: 1, missed: 0, skipped: null });
    expect(h.notified).toEqual([
      {
        id: "task-reminder:task-alpha:2026-09-14T13:00",
        kind: "task-reminder",
        at: "2026-09-14T12:00:00.000Z",
        title: "Water the plants",
        body: "13:00",
        href: "/tasks",
      },
    ]);
    expect(h.pushed).toEqual([{ title: "Water the plants", body: "13:00", href: "/tasks" }]);
    expect(h.marked).toEqual([["task-alpha", "2026-09-14T12:00:00.000Z"]]);
  });

  it("writes a missed reminder to the centre and does not push it", async () => {
    const h = harness({ now: () => Date.parse("2026-09-16T12:00:00.000Z") });
    expect(await runReminderScan(h.port)).toEqual({ fired: 0, missed: 1, skipped: null });
    expect(h.notified[0]?.kind).toBe("task-missed");
    expect(h.notified[0]?.id).toBe("task-missed:task-alpha:2026-09-14T13:00");
    expect(h.pushed).toEqual([]);
    expect(h.marked).toEqual([["task-alpha", "2026-09-16T12:00:00.000Z"]]);
  });

  it("does nothing at all when no zone is set", async () => {
    quiet();
    const h = harness({ zone: async () => null });
    expect(await runReminderScan(h.port)).toEqual({ fired: 0, missed: 0, skipped: "no-zone" });
    expect(h.notified).toEqual([]);
    expect(h.marked).toEqual([]);
  });

  it("says the zone is missing once, not on every scan", async () => {
    vi.resetModules();
    const fresh = await import("./scheduler");
    const warn = quiet();
    const h = harness({ zone: async () => null });
    await fresh.runReminderScan(h.port);
    await fresh.runReminderScan(h.port);
    await fresh.runReminderScan(h.port);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("time zone");
  });

  it("marks the record even when the push fails, so it cannot ring twice", async () => {
    quiet();
    const h = harness({
      push: async () => {
        throw new Error("push service is unreachable");
      },
    });
    expect(await runReminderScan(h.port)).toEqual({ fired: 1, missed: 0, skipped: null });
    expect(h.marked).toEqual([["task-alpha", "2026-09-14T12:00:00.000Z"]]);
  });

  it("does not push a row the centre did not store", async () => {
    const warn = quiet();
    const h = harness({ notify: async () => false });
    await runReminderScan(h.port);
    expect(h.pushed).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("marks a record the centre refused, so it is not due again", async () => {
    quiet();
    // A centre at its cap drops a `task-missed` row older than its oldest
    // entry and answers false. The mark still goes on: retrying that row every
    // thirty seconds for the life of the record is the one outcome worse than
    // losing it.
    const records: Task[] = [view({ when: "2026-09-14", time: "13:00" })];
    const h = harness({
      tasks: async () => records,
      notify: async () => false,
      markReminded: async (id: string, at: string) => {
        for (const record of records) if (record.id === id) record.remindedAt = at;
      },
    });

    expect(await runReminderScan(h.port)).toEqual({ fired: 1, missed: 0, skipped: null });
    expect(records[0]?.remindedAt).toBe("2026-09-14T12:00:00.000Z");
    expect(await runReminderScan(h.port)).toEqual({ fired: 0, missed: 0, skipped: null });
  });

  it("keeps scanning when one task's write fails", async () => {
    quiet();
    const h = harness({
      tasks: async () => [
        view({ id: "task-bad", when: "2026-09-14", time: "09:00" }),
        view({ id: "task-good", when: "2026-09-14", time: "10:00" }),
      ],
      markReminded: async (id: string) => {
        if (id === "task-bad") throw new Error("disk is full");
      },
    });
    expect((await runReminderScan(h.port)).fired).toBe(1);
  });

  it("keeps scanning when the centre refuses one row", async () => {
    quiet();
    const h = harness({
      tasks: async () => [
        view({ id: "task-bad", when: "2026-09-14", time: "09:00" }),
        view({ id: "task-good", when: "2026-09-14", time: "10:00" }),
      ],
      notify: async (n: BrainNotification) => {
        if (n.id.includes("task-bad")) throw new Error("state directory is read-only");
        return true;
      },
    });
    expect((await runReminderScan(h.port)).fired).toBe(1);
    expect(h.marked).toEqual([["task-good", "2026-09-14T12:00:00.000Z"]]);
  });
});

describe("the kill switch", () => {
  it("is off under NODE_ENV=test", () => {
    expect(remindersEnabled({ NODE_ENV: "test" })).toBe(false);
  });

  it("is off for 0, off and false, in any case", () => {
    for (const value of ["0", "off", "OFF", "false", " off "]) {
      expect(remindersEnabled({ NODE_ENV: "production", BRAIN_REMINDERS: value })).toBe(false);
    }
  });

  it("is on with no value set", () => {
    expect(remindersEnabled({ NODE_ENV: "production" })).toBe(true);
  });

  it("schedules nothing while it is off", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const dispose = scheduleReminderScans();
    expect(interval).not.toHaveBeenCalled();
    dispose();
  });
});

describe("the boot timer", () => {
  it("does not hold the process open, and the disposer stops it before it runs", () => {
    vi.stubEnv("NODE_ENV", "production");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");

    const dispose = scheduleReminderScans({ initialDelayMs: 60_000 });
    const handle = timeout.mock.results[0]?.value as NodeJS.Timeout;
    // Unref'd, the way `scheduleUpdateChecks` does it: a scan pending at
    // shutdown must not be the reason the process stays up.
    expect(handle.hasRef()).toBe(false);

    dispose();
    expect(clear).toHaveBeenCalledWith(handle);
  });
});
