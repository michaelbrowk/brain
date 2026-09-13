import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "./store";
import { brainEvents } from "./events";
import { doneDayOf, logbookRows } from "../tasks/lists";
import type { TaskRepeat } from "../tasks/model";

/** ONE OPEN INSTANCE, THROUGH THE REAL STORE.
 *
 *  `lib/tasks/recurrence.test.ts` pins the arithmetic with no clock and no
 *  disk anywhere near it. This file pins what the store does with it: which
 *  patch reaches `advance()`, that the completion is one file and one event,
 *  that the record on disk is a task the schema still accepts, and above all
 *  that a completed repeating task leaves exactly one open instance behind.
 *  Zero would lose the series and two would be the thing decision 14 exists
 *  to prevent, and neither is visible from a pure test of the helper.
 *
 *  Every date is supplied by the caller, the way a browser supplies its own
 *  local day. The clock is pinned only where the completion instant itself is
 *  the assertion, and only `Date` is faked, so the commit debounce still runs
 *  on a real timer.
 */

const DAILY: TaskRepeat = { freq: "daily" };
const MONDAYS: TaskRepeat = { freq: "weekly", byWeekday: ["mon"] };

/** 2026-09-14 is a Monday. */
const TODAY = "2026-09-14";
const TOMORROW = "2026-09-15";
const UTC = { offsetMinutes: 0 };

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-tasks-repeat-"));
  const s = new Store(root);
  await s.init();
  return { s, root };
}

async function taskFile(root: string, id: string): Promise<string> {
  return fs.readFile(path.join(root, "_tasks", `${id}.md`), "utf8");
}

/** Every file under the notes root, so a write that touched a second one is
 *  visible rather than assumed away. */
async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const names = await fs.readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, file), await fs.readFile(file, "utf8"));
  }
  return files;
}

function changedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, content] of after) {
    if (before.get(file) !== content) changed.add(file);
  }
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

function captureEvents(): { types: string[]; stop: () => void } {
  const types: string[] = [];
  const onChange = (ev: { type: string }) => types.push(ev.type);
  brainEvents.on("change", onChange);
  return { types, stop: () => brainEvents.off("change", onChange) };
}

/** The record in every list at once, which is how "exactly one open instance"
 *  is asked: not "it is in Today" but "it is somewhere, once". */
function openInstances(s: Store, id: string, today: string): number {
  return s
    .listTasks(today, UTC)
    .filter((task) => task.id === id && !task.done).length;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("completing a repeating task", () => {
  it("appends a log entry and moves when to the next occurrence", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });

    const done = await s.updateTask(created.id, { done: true, today: TODAY });

    expect(done.when).toBe(TOMORROW);
    expect(done.log).toEqual([
      { scheduled: TODAY, completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    ]);
    // A repeating task is never finished: the completion is the log entry and
    // the open instance is the new `when`. A record carrying both would sit in
    // the Logbook and in Today at the same time.
    expect(done.done).toBe(false);
    expect(done.doneAt).toBeUndefined();
    const raw = await taskFile(root, created.id);
    expect(raw).not.toContain("doneAt:");
    expect(raw).toContain(`when: '${TOMORROW}'`);
  });

  it("leaves exactly one open instance, on the day, early and late", async () => {
    const { s } = await tmpStore();
    for (const when of [TODAY, "2026-09-20", "2026-09-07", "someday"]) {
      const created = await s.createTask({ title: "Learn words", when, repeat: DAILY });
      expect(openInstances(s, created.id, TODAY)).toBe(1);

      await s.updateTask(created.id, { done: true, today: TODAY });

      expect(openInstances(s, created.id, TODAY)).toBe(1);
      // And nothing of it is in the Logbook as a record, which is what a
      // second instance would look like from the other side.
      expect(
        s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0 }).map((t) => t.id),
      ).not.toContain(created.id);
      await s.deleteTask(created.id);
    }
  });

  it("completes a week of missed days once and lands on tomorrow", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: "2026-09-07",
      repeat: DAILY,
    });

    const done = await s.updateTask(created.id, { done: true, today: TODAY });

    // Seven days away is one completion and one row, not seven of each.
    expect(done.when).toBe(TOMORROW);
    expect(done.log).toHaveLength(1);
    expect(done.log?.[0].scheduled).toBe("2026-09-07");
    expect(openInstances(s, created.id, TODAY)).toBe(1);
  });

  it("completes an instance dated tomorrow today and lands on the day after", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TOMORROW,
      repeat: DAILY,
    });

    const done = await s.updateTask(created.id, { done: true, today: TODAY });

    // The rule is read from the day it was owed, not from the day the person
    // got to it, so an early finish does not pull the series forward.
    expect(done.when).toBe("2026-09-16");
    expect(done.log?.[0].scheduled).toBe(TOMORROW);
    expect(openInstances(s, created.id, TODAY)).toBe(1);
  });

  it("files an early completion in the Logbook under today, not under its scheduled day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T18:30:00.000Z`));
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TOMORROW,
      repeat: DAILY,
    });

    const done = await s.updateTask(created.id, { done: true, today: TODAY });
    const entry = done.log?.[0];

    expect(entry?.scheduled).toBe(TOMORROW);
    expect(doneDayOf(entry?.completedAt as string, 0)).toBe(TODAY);
    const [row] = logbookRows([done], TODAY, 0);
    expect(doneDayOf(row.task.doneAt as string, 0)).toBe(TODAY);
    expect(row.task.when).toBe(TOMORROW);
  });

  it("writes one file and emits one task event", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });
    const before = await snapshot(root);
    const seen = captureEvents();
    try {
      await s.updateTask(created.id, { done: true, today: TODAY });
    } finally {
      seen.stop();
    }

    expect(changedBetween(before, await snapshot(root))).toEqual([
      path.join("_tasks", `${created.id}.md`),
    ]);
    expect(seen.types).toEqual(["task"]);
  });

  it("trims the log to its thirty most recent entries", async () => {
    const { s, root } = await tmpStore();
    await fs.mkdir(path.join(root, "_tasks"), { recursive: true });
    // Thirty completions already on disk, the oldest first.
    const log = Array.from({ length: 30 }, (_, index) => {
      const day = `2026-08-${String(index + 1).padStart(2, "0")}`;
      return `  - scheduled: '${day}'\n    completedAt: '${day}T08:00:00.000Z'`;
    }).join("\n");
    await fs.writeFile(
      path.join(root, "_tasks", "task-words.md"),
      `---\nid: task-words\ntitle: Learn words\nwhen: '${TODAY}'\nrepeat:\n  freq: daily\nlog:\n${log}\ncreated: '2026-07-01T09:00:00.000Z'\nupdated: '2026-09-13T09:00:00.000Z'\n---\n`,
    );
    await s.rebuild();

    const done = await s.updateTask("task-words", { done: true, today: TODAY });

    expect(done.log).toHaveLength(30);
    expect(done.log?.[0].scheduled).toBe("2026-08-02");
    expect(done.log?.[29].scheduled).toBe(TODAY);
  });

  it("completes a task with no rule as a plain write, and never through advance", async () => {
    const { s } = await tmpStore();
    const plain = await s.createTask({ title: "Water the plants", when: TODAY });

    const done = await s.updateTask(plain.id, { done: true });

    expect(done.done).toBe(true);
    expect(done.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(done.when).toBe(TODAY);
    expect(done.log).toBeUndefined();
    // The refusal `advance()` throws for a task with no rule is a programming
    // error, and the store reaches it through no path: it checks `repeat`
    // first and writes `done` itself. Neither it nor a `bad-today` may ever
    // leave the store as anything but a validation refusal.
    await expect(
      s.updateTask(plain.id, { done: true, today: TODAY }),
    ).rejects.toThrow(/today/);
  });
});

describe("rescheduling a repeating task", () => {
  it("changes when on this instance only, and skips the occurrence it passes", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });

    const moved = await s.updateTask(created.id, { when: "2026-09-17" });

    // "Move the daily to Thursday" is also "skip Tuesday and Wednesday",
    // because there is only ever one open instance, and that is why there is
    // no separate Skip control.
    expect(moved.when).toBe("2026-09-17");
    expect(openInstances(s, created.id, TODAY)).toBe(1);

    const done = await s.updateTask(created.id, { done: true, today: "2026-09-17" });
    expect(done.when).toBe("2026-09-18");
    expect(done.log?.[0].scheduled).toBe("2026-09-17");
  });

  it("leaves the rule and the log untouched", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: MONDAYS,
    });
    await s.updateTask(created.id, { done: true, today: TODAY });

    const moved = await s.updateTask(created.id, { when: "2026-09-23" });

    expect(moved.repeat).toEqual(MONDAYS);
    expect(moved.log).toHaveLength(1);
    expect(await taskFile(root, created.id)).toContain("byWeekday:");
    // The rule did not move with the instance: the next completion comes off
    // the day it was moved to, and the rule still names Mondays.
    const done = await s.updateTask(created.id, { done: true, today: "2026-09-23" });
    expect(done.when).toBe("2026-09-28");
  });
});

describe("the repeat rule itself", () => {
  it("takes a rule on any unlinked task and drops it again on stop", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({ title: "Learn words", when: TODAY });

    const repeating = await s.updateTask(created.id, { repeat: DAILY });
    expect(repeating.repeat).toEqual(DAILY);

    await s.updateTask(created.id, { done: true, today: TODAY });
    const stopped = await s.updateTask(created.id, { repeat: null });

    // The rule goes and the instance stays, as an ordinary task on the day the
    // rule last put it.
    expect(stopped.repeat).toBeUndefined();
    expect(stopped.when).toBe(TOMORROW);
    expect(stopped.done).toBe(false);
    const raw = await taskFile(root, created.id);
    expect(raw).not.toContain("repeat:");
    // `log` belongs to a repeating task, so it goes with the rule rather than
    // sitting in the file as a shape the schema refuses on the next load.
    expect(raw).not.toContain("log:");
    expect(stopped.log).toBeUndefined();

    // Completing it now is the plain write, with its own `done`.
    const done = await s.updateTask(created.id, { done: true });
    expect(done.done).toBe(true);
    expect(done.doneAt).toBeDefined();
  });

  it("refuses a rule on a task that came from a note line, linked and detached", async () => {
    const { s } = await tmpStore();
    const meta = await s.createPage(null, "Groceries");
    const written = await s.writePage(meta.id, "- [ ] Buy milk", undefined, "me");
    const { parseTaskLines } = await import("../tasks/task-lines");
    const [line] = parseTaskLines(written.markdown);
    const linked = await s.createTask({
      title: line.normalized,
      page: meta.id,
      anchor: {
        text: line.normalized,
        hash: line.hash,
        ordinal: line.ordinal,
        line: line.index,
      },
    });

    // The refusal names the note line and not the schema's field pair, so a
    // detached task reads right too: it has no line left, and the reason it
    // cannot repeat is still the note it came from.
    await expect(
      s.updateTask(linked.id, { repeat: DAILY }),
    ).rejects.toThrow(/note line/);
    await expect(
      s.createTask({
        title: "Buy milk",
        page: meta.id,
        anchor: {
          text: line.normalized,
          hash: line.hash,
          ordinal: line.ordinal,
          line: line.index,
        },
        repeat: DAILY,
      }),
    ).rejects.toThrow(/note line/);

    // Detached: the line is gone, the record keeps its page and owns its own
    // completion, and it still cannot take a rule.
    await s.writePage(meta.id, "a note with no tasks", undefined, "me");
    expect(s.getTask(linked.id)?.detachedAt).toBeDefined();
    await expect(
      s.updateTask(linked.id, { repeat: DAILY }),
    ).rejects.toThrow(/note line/);
  });
});

describe("unticking a repeating task in the Logbook", () => {
  it("pops the most recent log entry and restores when to its scheduled day", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });
    await s.updateTask(created.id, { done: true, today: TODAY });

    const reopened = await s.updateTask(created.id, { done: false });

    expect(reopened.when).toBe(TODAY);
    expect(reopened.log).toBeUndefined();
    expect(reopened.done).toBe(false);
    expect(await taskFile(root, created.id)).not.toContain("log:");
    expect(openInstances(s, created.id, TODAY)).toBe(1);
  });

  it("pops one entry at a time and leaves the older ones alone", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: "2026-09-13",
      repeat: DAILY,
    });
    await s.updateTask(created.id, { done: true, today: "2026-09-13" });
    await s.updateTask(created.id, { done: true, today: TODAY });
    expect(s.getTask(created.id)?.log).toHaveLength(2);

    const reopened = await s.updateTask(created.id, { done: false });

    expect(reopened.when).toBe(TODAY);
    expect(reopened.log).toHaveLength(1);
    expect(reopened.log?.[0].scheduled).toBe("2026-09-13");
  });

  it("offers no untick on an older log entry", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: "2026-09-13",
      repeat: DAILY,
    });
    await s.updateTask(created.id, { done: true, today: "2026-09-13" });
    const twice = await s.updateTask(created.id, { done: true, today: TODAY });

    // Two rows in the Logbook and one of them is interactive. The gesture is
    // not offered on the other, which is why `revert()` takes no index: there
    // is no way to ask it for an older one.
    const rows = logbookRows([twice], TODAY, 0);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.untickable)).toEqual([true, false]);
  });

  it("refuses an untick on a repeating task that has completed nothing", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });

    // Reachable only from a caller that made the request up: the Logbook draws
    // no row for a task with an empty log, so there is nothing to untick. It
    // is a refusal and never a 500.
    await expect(
      s.updateTask(created.id, { done: false }),
    ).rejects.toThrow(/completion/);
    expect(s.getTask(created.id)?.when).toBe(TODAY);
  });
});
