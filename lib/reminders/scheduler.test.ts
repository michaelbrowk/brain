import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainNotification } from "@/lib/notifications/model";
import {
  MAX_APPENDS_PER_SCAN,
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
  const pushed: { title: string; body?: string; href: string; tag?: string }[] = [];
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
    push: async (p: { title: string; body?: string; href: string; tag?: string }) => {
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
    // THE TAG IS THE NOTIFICATION'S ID, and it travels because the worker
    // tags the notification with it. Every reminder's href is "/tasks", so a
    // worker tagging by destination showed only the last of two reminders due
    // in the same scan and dropped the other without a sound.
    expect(h.pushed).toEqual([
      {
        title: "Water the plants",
        body: "13:00",
        href: "/tasks",
        tag: "task-reminder:task-alpha:2026-09-14T13:00",
      },
    ]);
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

describe("a backlog after a long downtime", () => {
  /** Every append takes a slot in the 256-entry SSE replay journal, so a scan
   *  that found a week of missed reminders and wrote all of them would empty
   *  the journal for every other subscriber. */
  function backlog(count: number) {
    const records: Task[] = [];
    for (let index = 0; index < count; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      const hour = String(Math.floor(index / 60)).padStart(2, "0");
      records.push(
        view({ id: `task-${String(index).padStart(3, "0")}`, when: "2026-09-14", time: `${hour}:${minute}` }),
      );
    }
    const h = harness({
      tasks: async () => records,
      now: () => Date.parse("2026-09-14T23:00:00.000Z"),
      markReminded: async (id: string, at: string) => {
        for (const record of records) if (record.id === id) record.remindedAt = at;
      },
    });
    return { ...h, records };
  }

  it("caps one scan at fifty appends", () => {
    expect(MAX_APPENDS_PER_SCAN).toBe(50);
  });

  it("takes the oldest fifty and carries the rest to the next tick", async () => {
    quiet();
    const h = backlog(120);

    const first = await runReminderScan(h.port);
    expect(first.fired + first.missed).toBe(50);
    expect(h.notified).toHaveLength(50);
    // Oldest first, so a backlog drains in the order the reminders were owed.
    expect(h.notified[0]?.id).toContain("task-000");
    expect(h.notified[49]?.id).toContain("task-049");
    expect(h.records.filter((record) => record.remindedAt !== undefined)).toHaveLength(50);

    const second = await runReminderScan(h.port);
    expect(second.fired + second.missed).toBe(50);
    expect(h.notified[50]?.id).toContain("task-050");

    const third = await runReminderScan(h.port);
    expect(third.fired + third.missed).toBe(20);
    expect(h.records.every((record) => record.remindedAt !== undefined)).toBe(true);
  });

  it("says how many it carried, and says nothing when it carried none", async () => {
    const warn = quiet();
    await runReminderScan(backlog(51).port);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("51 reminders are owed");

    warn.mockClear();
    await runReminderScan(backlog(50).port);
    expect(warn).not.toHaveBeenCalled();
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

  it("arms no timer at all while it is off", () => {
    // The boot timeout is what the switch has to stop, and `setInterval` is
    // only reached from inside it. A test that watched the interval alone
    // would stay green with the switch deleted, which is what it was doing.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BRAIN_REMINDERS", "0");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");

    const dispose = scheduleReminderScans({ initialDelayMs: 60_000 });
    expect(timeout).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
    dispose();
  });

  it("arms the boot timeout while it is on, which is what the row above denies", () => {
    vi.stubEnv("NODE_ENV", "production");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const dispose = scheduleReminderScans({ initialDelayMs: 60_000 });
    expect(timeout).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("a scan that cannot open the store", () => {
  it("doubles its wait up to five minutes and says so once until it succeeds", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = quiet();
    vi.useFakeTimers();
    try {
      let failing = true;
      let attempts = 0;
      const dispose = scheduleReminderScans({
        initialDelayMs: 0,
        intervalMs: 30_000,
        scan: async () => {
          attempts += 1;
          if (failing) throw new Error("notes root is not readable");
        },
        mailScan: async () => undefined,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);

      // The first failure bought a minute, so the tick at thirty seconds is
      // one this scan sits out.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(2);
      // One line for the outage, not one line per tick.
      expect(warn).toHaveBeenCalledTimes(1);

      // Two minutes, then four, then the five-minute ceiling twice over.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(attempts).toBe(3);
      await vi.advanceTimersByTimeAsync(240_000);
      expect(attempts).toBe(4);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(attempts).toBe(5);

      failing = false;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(attempts).toBe(6);
      // One pass that worked puts it back on the thirty-second cadence.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(7);

      failing = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(8);
      expect(warn).toHaveBeenCalledTimes(2);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a tick that lands while the scan before it is still running", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = quiet();
    vi.useFakeTimers();
    try {
      let starts = 0;
      let release = () => {};
      const dispose = scheduleReminderScans({
        initialDelayMs: 0,
        intervalMs: 30_000,
        scan: () => {
          starts += 1;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
        mailScan: async () => undefined,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(starts).toBe(1);

      // Two ticks land while the first scan is still out. Both passes would
      // read the same due list, whose records are not marked yet, and ring
      // every one of them twice.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(starts).toBe(1);
      expect(warn).not.toHaveBeenCalled();

      release();
      await vi.advanceTimersByTimeAsync(0);
      // Counted, not announced tick by tick: one line for the whole overlap.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("2 ticks");

      // The guard clears on the way out, so the timer is not wedged shut.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(starts).toBe(2);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wedge the timer shut when the long scan fails", async () => {
    vi.stubEnv("NODE_ENV", "production");
    quiet();
    vi.useFakeTimers();
    try {
      let starts = 0;
      let fail = () => {};
      const dispose = scheduleReminderScans({
        initialDelayMs: 0,
        intervalMs: 30_000,
        scan: () => {
          starts += 1;
          return new Promise<void>((_resolve, reject) => {
            fail = () => {
              reject(new Error("notes root is not readable"));
            };
          });
        },
        mailScan: async () => undefined,
      });

      await vi.advanceTimersByTimeAsync(0);
      fail();
      await vi.advanceTimersByTimeAsync(0);
      // A minute of back-off after the failure, then the next tick runs.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(starts).toBe(2);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the mail poll on its own cadence while the reminders back off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    quiet();
    vi.useFakeTimers();
    try {
      let polls = 0;
      const dispose = scheduleReminderScans({
        initialDelayMs: 0,
        intervalMs: 30_000,
        scan: async () => {
          throw new Error("notes root is not readable");
        },
        mailScan: async () => {
          polls += 1;
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      // Four more ticks, every second one a poll. The notes root says nothing
      // about the mail service, which is another process.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(polls).toBe(3);
      dispose();
    } finally {
      vi.useRealTimers();
    }
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
