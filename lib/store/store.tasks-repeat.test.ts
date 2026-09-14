import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "./store";
import { brainEvents } from "./events";
import { doneDayOf, listOf, logbookRows } from "../tasks/lists";
import type { TaskRepeat, TaskView } from "../tasks/model";

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
      // The Logbook shows the COMPLETION and not a second instance: one row,
      // done, which is what a repeat's history looks like from the other side.
      const logged = s
        .listTasks(TODAY, { list: "logbook", offsetMinutes: 0 })
        .filter((t) => t.id === created.id);
      expect(logged).toHaveLength(1);
      expect(logged[0].done).toBe(true);
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
  it("takes a rule on any unlinked task and drops it again on stop, keeping the history", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createTask({ title: "Learn words", when: "2026-09-12" });

    const repeating = await s.updateTask(created.id, { repeat: DAILY });
    expect(repeating.repeat).toEqual(DAILY);

    await s.updateTask(created.id, { done: true, today: "2026-09-12" });
    await s.updateTask(created.id, { done: true, today: "2026-09-13" });
    await s.updateTask(created.id, { done: true, today: TODAY });
    const stopped = await s.updateTask(created.id, { repeat: null });

    // The rule goes and the instance stays, as an ordinary task on the day the
    // rule last put it.
    expect(stopped.repeat).toBeUndefined();
    expect(stopped.when).toBe(TOMORROW);
    expect(stopped.done).toBe(false);
    const raw = await taskFile(root, created.id);
    expect(raw).not.toContain("repeat:");

    // AND THE LOG STAYS. Those three completions are the Logbook's, including
    // the row the person may be looking at when they pick "Don't repeat", so
    // stopping a repeat is not a way to erase a month of history.
    expect(stopped.log).toHaveLength(3);
    expect(raw).toContain("log:");
    expect(logbookRows([stopped], TODAY, 0)).toHaveLength(3);
    // Read-only history now: there is no rule left to put the series back on,
    // so no row of it offers an untick.
    expect(logbookRows([stopped], TODAY, 0).map((row) => row.untickable)).toEqual([
      false,
      false,
      false,
    ]);
    // And it survives a reload, which is what the schema had to be relaxed for.
    await s.rebuild();
    expect(s.getTask(created.id)?.log).toHaveLength(3);

    // Completing it now is the plain write, with its own `done`, and the
    // Logbook shows that row on top of the three.
    const done = await s.updateTask(created.id, { done: true });
    expect(done.done).toBe(true);
    expect(done.doneAt).toBeDefined();
    expect(logbookRows([done], TODAY, 0)).toHaveLength(4);
  });

  it("refuses a rule on a task that is already done", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({ title: "Water the plants", when: TODAY });
    const done = await s.updateTask(created.id, { done: true });
    expect(done.done).toBe(true);

    // A rule on a done record promises a next occurrence nothing will write:
    // `listOf` files it in the Logbook because `done` is true, and it would
    // sit there claiming to repeat. The surface does not offer the chip on a
    // done row and this is the same answer for a caller that asks anyway.
    await expect(
      s.updateTask(created.id, { repeat: DAILY }),
    ).rejects.toThrow(/already done/);
    expect(s.getTask(created.id)?.repeat).toBeUndefined();

    // Reopened, it takes one.
    await s.updateTask(created.id, { done: false });
    await expect(
      s.updateTask(created.id, { repeat: DAILY }),
    ).resolves.toMatchObject({ repeat: DAILY });
  });

  it("draws a row for a done record that carries a rule, which only an import can make", async () => {
    const { s, root } = await tmpStore();
    await fs.mkdir(path.join(root, "_tasks"), { recursive: true });
    // The patch path refuses this shape; a hand edit and `importTask` reach
    // it. The derivation has to stay TOTAL over what `listOf` files in the
    // Logbook: a record with no row anywhere is a record nothing can reach.
    // Completed the day BEFORE `TODAY`. A completion now stays in the list it
    // was in until the day turns, so one made today reads as `inbox` and the
    // Logbook is the wrong place to look for it. This case is about a done
    // record that carries a rule, and it wants a completion whose day is over.
    await fs.writeFile(
      path.join(root, "_tasks", "task-odd.md"),
      `---\nid: task-odd\ntitle: Learn words\ndone: true\ndoneAt: '2026-09-13T09:00:00.000Z'\nrepeat:\n  freq: daily\ncreated: '2026-09-01T09:00:00.000Z'\nupdated: '${TODAY}T09:00:00.000Z'\n---\n`,
    );
    await s.rebuild();

    const odd = s.getTask("task-odd") as TaskView;
    expect(listOf(odd, TODAY)).toBe("logbook");
    const rows = logbookRows([odd], TODAY, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("task-odd");
    expect(rows[0].untickable).toBe(true);
    // And the untick is the ordinary one: it owns its `done`, so it clears it
    // rather than popping a log entry it does not have.
    const reopened = await s.updateTask("task-odd", { done: false });
    expect(reopened.done).toBe(false);
    expect(reopened.repeat).toEqual(DAILY);
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

/** TWO TICKS OF ONE INSTANCE.
 *
 *  Completing a repeat is not idempotent: each one appends an entry and moves
 *  `when` a rule date on. `mutate()` serialises the two writes, so the second
 *  reads the already-advanced record and cannot notice on its own. It would
 *  advance again and the series would skip a period with nothing said. The
 *  caller sends the `when` it was looking at, and a stale one is refused. */
describe("completing the same instance twice", () => {
  it("advances once and refuses the second with a 409 reason", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });

    // Both tabs drew the row while it stood on TODAY, so both send that.
    const results = await Promise.allSettled([
      s.updateTask(created.id, { done: true, today: TODAY, expectedWhen: TODAY }),
      s.updateTask(created.id, { done: true, today: TODAY, expectedWhen: TODAY }),
    ]);

    const landed = results.filter((result) => result.status === "fulfilled");
    const refused = results.filter((result) => result.status === "rejected");
    expect(landed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "TaskConflictError",
      currentWhen: TOMORROW,
    });

    // One period, one entry, one open instance. Without the check the second
    // write would have advanced to the 16th and logged twice.
    const after = s.getTask(created.id) as TaskView;
    expect(after.when).toBe(TOMORROW);
    expect(after.log).toHaveLength(1);
    expect(openInstances(s, created.id, TODAY)).toBe(1);
  });

  it("checks nothing when the caller sends no expectedWhen", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });

    // MCP and a script have no row to have been looking at. They are not
    // refused; the check is opt-in and belongs to a client that drew a row.
    await expect(
      s.updateTask(created.id, { done: true, today: TODAY }),
    ).resolves.toMatchObject({ when: TOMORROW });
  });

  it("pops one entry and refuses a second untick of the same instance", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });
    await s.updateTask(created.id, { done: true, today: TODAY, expectedWhen: TODAY });

    // Both tabs drew the Logbook row while the record stood on TOMORROW. A
    // double press on Undo used to pop two entries and put `when` two
    // occurrences into the past, with no error anywhere.
    const results = await Promise.allSettled([
      s.updateTask(created.id, { done: false, expectedWhen: TOMORROW }),
      s.updateTask(created.id, { done: false, expectedWhen: TOMORROW }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((result) => result.status === "rejected");
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      name: "TaskConflictError",
      currentWhen: TODAY,
    });

    const after = s.getTask(created.id) as TaskView;
    expect(after.when).toBe(TODAY);
    expect(after.log ?? []).toHaveLength(0);
  });

  it("takes null as the expected when of an instance filed under no day", async () => {
    const { s } = await tmpStore();
    const created = await s.createTask({ title: "Learn words", repeat: DAILY });
    expect(created.when).toBeUndefined();

    await expect(
      s.updateTask(created.id, { done: true, today: TODAY, expectedWhen: TODAY }),
    ).rejects.toThrow(/moved on/);
    await expect(
      s.updateTask(created.id, { done: true, today: TODAY, expectedWhen: null }),
    ).resolves.toMatchObject({ when: TOMORROW });
  });
});

/** The Logbook a caller that is not the surface gets.
 *
 *  The surface fetches every record and derives its own rows. `?list=logbook`
 *  and MCP's `list_tasks` cannot: they ask the store for the list. A filter
 *  over records answers that nothing repeating was ever finished, because a
 *  repeating record is never done. */
describe("listTasks(list: logbook)", () => {
  it("answers with completions, one row per log entry", async () => {
    const { s } = await tmpStore();
    const words = await s.createTask({
      title: "Learn words",
      when: "2026-09-13",
      repeat: DAILY,
    });
    await s.updateTask(words.id, { done: true, today: "2026-09-13" });
    await s.updateTask(words.id, { done: true, today: TODAY });
    const plants = await s.createTask({ title: "Water the plants", when: TODAY });
    await s.updateTask(plants.id, { done: true });

    const logbook = s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0 });

    // Two completions of the repeat plus the ordinary one, newest first.
    expect(logbook.map((t) => t.id)).toEqual([plants.id, words.id, words.id]);
    expect(logbook.every((t) => t.done)).toBe(true);
    // Each repeat row carries its own completion and the day that instance
    // was owed, which is the whole reason the rows are not records.
    expect(logbook[1].when).toBe(TODAY);
    expect(logbook[2].when).toBe("2026-09-13");

    // And the open instance is still answered as itself by every other read.
    expect(s.listTasks(TODAY, { list: "upcoming" }).map((t) => t.id)).toEqual([
      words.id,
    ]);
    expect(s.getTask(words.id)?.done).toBe(false);
  });

  it("gives listLogbook a distinct key per completion where the id repeats", async () => {
    const { s } = await tmpStore();
    const words = await s.createTask({
      title: "Learn words",
      when: "2026-09-13",
      repeat: DAILY,
    });
    await s.updateTask(words.id, { done: true, today: "2026-09-13" });
    await s.updateTask(words.id, { done: true, today: TODAY });

    const entries = s.listLogbook(TODAY, { offsetMinutes: 0 });

    expect(entries).toHaveLength(2);
    // One record, two completions: keying an agent's own map on the id would
    // collapse them into one or mis-attribute the second.
    expect(new Set(entries.map((entry) => entry.task.id)).size).toBe(1);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
    // The newest is the only one an untick is offered on, because there is
    // one rule to put the series back on.
    expect(entries.map((entry) => entry.untickable)).toEqual([true, false]);
    expect(entries[0].task.when).toBe(TODAY);
    expect(entries[1].task.when).toBe("2026-09-13");
  });

  it("refuses listLogbook without the reader's own offset", async () => {
    const { s } = await tmpStore();
    expect(() =>
      s.listLogbook(TODAY, { offsetMinutes: undefined as unknown as number }),
    ).toThrow();
  });

  it("leaves the unfiltered read as records, because the surface derives its own rows", async () => {
    const { s } = await tmpStore();
    const words = await s.createTask({
      title: "Learn words",
      when: TODAY,
      repeat: DAILY,
    });
    await s.updateTask(words.id, { done: true, today: TODAY });

    const all = s.listTasks(TODAY, UTC);

    expect(all.map((t) => t.id)).toEqual([words.id]);
    expect(all[0].done).toBe(false);
    expect(all[0].when).toBe(TOMORROW);
    expect(all[0].log).toHaveLength(1);
  });

  it("keeps the window and the category filter on the completion rows", async () => {
    const { s, root } = await tmpStore();
    await fs.mkdir(path.join(root, "_tasks"), { recursive: true });
    await fs.writeFile(
      path.join(root, "_tasks", "task-words.md"),
      `---\nid: task-words\ntitle: Learn words\nwhen: '${TODAY}'\ncategory: Study\nrepeat:\n  freq: daily\nlog:\n  - scheduled: '2026-09-13'\n    completedAt: '2026-09-13T09:00:00.000Z'\n  - scheduled: '2026-07-01'\n    completedAt: '2026-07-01T09:00:00.000Z'\ncreated: '2026-06-01T09:00:00.000Z'\nupdated: '2026-09-13T09:00:00.000Z'\n---\n`,
    );
    await s.rebuild();

    // The July entry is outside the 30 day window and the August one is not.
    const logbook = s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0 });
    expect(logbook).toHaveLength(1);
    expect(logbook[0].doneAt).toBe("2026-09-13T09:00:00.000Z");

    expect(
      s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0, category: "Study" }),
    ).toHaveLength(1);
    expect(
      s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0, category: "Admin" }),
    ).toEqual([]);
  });

  it("hides the completions of a task whose page is in the trash", async () => {
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
    await s.updateTask(linked.id, { done: true });
    expect(
      s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0 }).map((t) => t.id),
    ).toEqual([linked.id]);

    await s.deletePage(meta.id);

    expect(s.listTasks(TODAY, { list: "logbook", offsetMinutes: 0 })).toEqual([]);
  });

  it("still refuses a logbook read without the reader's offset", async () => {
    const { s } = await tmpStore();
    expect(() => s.listTasks(TODAY, { list: "logbook" })).toThrow(/bad_offset/);
  });
});
