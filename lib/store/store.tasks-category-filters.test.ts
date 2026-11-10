import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TaskRecord } from "../tasks/model";
import { Store } from "./store";

const TODAY = "2026-09-14";
const roots: string[] = [];

function record(id: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: id,
    created: "2026-08-01T09:00:00.000Z",
    updated: "2026-09-14T09:00:00.000Z",
    done: false,
    when: TODAY,
    ...fields,
  };
}

async function notebook(records: TaskRecord[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-task-category-filters-"));
  roots.push(root);
  const store = new Store(root);
  await store.init();
  for (const task of records) await store.importTask(task, "");
  return store;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("task category filter identity", () => {
  it.each(["today", undefined] as const)(
    "matches the category picker in list %s without rewriting legacy names",
    async (list) => {
      const store = await notebook([
        record("mixed", { category: "Work" }),
        record("upper", { category: "WORK" }),
        record("spaced", { category: " work  " }),
        record("unicode", { category: "Ｗｏｒｋ" }),
        record("other", { category: "Personal" }),
        record("bare"),
      ]);
      const read = (category?: string) => store.listTasks(TODAY, {
        ...(list === undefined ? {} : { list }),
        offsetMinutes: 0,
        ...(category === undefined ? {} : { category }),
      }).map((task) => task.id).sort();

      for (const category of ["Work", "WORK", " work  ", "Ｗｏｒｋ"]) {
        expect(read(category)).toEqual(["mixed", "spaced", "unicode", "upper"]);
      }
      expect(read("")).toEqual(["bare"]);
      expect(read()).toEqual(["bare", "mixed", "other", "spaced", "unicode", "upper"]);
      expect(read("Missing")).toEqual([]);
      expect(store.getTask("spaced")?.category).toBe(" work  ");
      expect(store.getTask("upper")?.category).toBe("WORK");
    },
  );

  it("uses the same category identity for both logbook reads and preserves the completion window", async () => {
    const done = { done: true, doneAt: "2026-09-13T09:00:00.000Z" };
    const store = await notebook([
      record("mixed", { ...done, category: "Work" }),
      record("upper", { ...done, category: "WORK" }),
      record("spaced", { ...done, category: " work  " }),
      record("unicode", { ...done, category: "Ｗｏｒｋ" }),
      record("other", { ...done, category: "Personal" }),
      record("bare", done),
      record("boundary", { done: true, doneAt: "2026-08-15T00:00:00.000Z", category: "WORK" }),
      record("outside", { done: true, doneAt: "2026-08-14T23:59:59.999Z", category: "Work" }),
      record("repeat", {
        category: " work  ",
        repeat: { freq: "daily" },
        log: [
          { scheduled: "2026-08-14", completedAt: "2026-08-14T09:00:00.000Z" },
          { scheduled: "2026-08-15", completedAt: "2026-08-15T09:00:00.000Z" },
          { scheduled: "2026-09-13", completedAt: "2026-09-13T09:00:00.000Z" },
        ],
      }),
    ]);
    const reads = [
      (category?: string) => store.listLogbook(TODAY, { offsetMinutes: 0, category }).map((row) => row.task),
      (category?: string) => store.listTasks(TODAY, { list: "logbook", offsetMinutes: 0, category }),
    ];

    for (const read of reads) {
      for (const category of ["Work", "WORK", " work  ", "Ｗｏｒｋ"]) {
        const tasks = read(category);
        expect(tasks.map((task) => task.id).sort()).toEqual([
          "boundary", "mixed", "repeat", "repeat", "spaced", "unicode", "upper",
        ]);
        expect(tasks.filter((task) => task.id === "repeat").map((task) => task.doneAt)).toEqual([
          "2026-09-13T09:00:00.000Z", "2026-08-15T09:00:00.000Z",
        ]);
      }
      expect(read("").map((task) => task.id)).toEqual(["bare"]);
      expect(read().map((task) => task.id).sort()).toEqual([
        "bare", "boundary", "mixed", "other", "repeat", "repeat", "spaced", "unicode", "upper",
      ]);
      expect(read("Missing")).toEqual([]);
    }
  });
});
