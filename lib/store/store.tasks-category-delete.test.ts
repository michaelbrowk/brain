import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as taskFiles from "../tasks/index-store";
import type { TaskRecord } from "../tasks/model";
import { hashTaskText, normalizeTaskText } from "../tasks/task-lines";
import { brainEvents, type StoreEvent } from "./events";
import { readTaskCatalog } from "./task-categories";
import { Store } from "./store";

const roots: string[] = [];
async function notebook() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-category-delete-"));
  roots.push(root);
  const store = new Store(root);
  await store.init();
  return {root, store};
}

function record(id: string, fields: Partial<TaskRecord> = {}): TaskRecord {
  return {id, title: id, created: "2026-08-01T09:00:00.000Z", updated: "2026-08-01T09:00:00.000Z", done: false, ...fields};
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive: true, force: true})));
});

describe("deleting a task category", () => {
  it("clears all equivalent labels without changing tasks, linked notes or their history, including after reload", async () => {
    const {root, store} = await notebook();
    const source = await store.createPage(null, "Source");
    const context = await store.createPage(null, "Context");
    await store.writePage(source.id, "- [ ] Review\nOther note content\n");
    await store.createTaskCategory("Work", "✨");
    await store.createTaskCategory("Empty", "📌");
    const open = await store.createTask({title: "Open", category: " work  ", body: "Notes without a trailing newline", relatedPageIds: [context.id]});
    const oldDone = await store.importTask(record("old_done", {category: "WORK", done: true, doneAt: "2026-08-02T09:00:00.000Z"}), "Old completion notes");
    const repeat = await store.importTask(record("repeat", {category: "Ｗｏｒｋ", when: "2026-11-11", time: "13:00", remindedAt: "2026-11-11T09:00:00.000Z", repeat: {freq: "daily"}, log: [{scheduled: "2026-11-10", completedAt: "2026-11-10T09:00:00.000Z"}]}), "Repeat notes");
    const text = normalizeTaskText("Review");
    const linked = await store.createTask({title: "Review", category: "Work", page: source.id, anchor: {text, hash: hashTaskText(text), ordinal: 0, line: 0}, body: "Linked notes", relatedPageIds: [context.id]});
    await store.updateTask(linked.id, {done: true});
    const other = await store.createTask({title: "Other", category: "Personal", body: "Other notes"});
    const bare = await store.createTask({title: "No category"});
    const ids = [open.id, oldDone.id, repeat.id, linked.id];
    const before = await Promise.all(ids.map(id => store.readTaskDetails(id)));
    const noteBefore = await store.readPage(source.id);
    const untouchedBefore = await Promise.all([other.id, bare.id].map(id => fs.readFile(path.join(root, "_tasks", `${id}.md`), "utf8")));

    expect(await store.deleteTaskCategory("  ＷＯＲＫ ")).toEqual({cleared: 4});
    const reloaded = new Store(root);
    await reloaded.init();
    for (const current of [store, reloaded]) {
      expect(current.allTasks()).toHaveLength(6);
      for (let index = 0; index < ids.length; index += 1) {
        const after = await current.readTaskDetails(ids[index]);
        const expectedTask = {...before[index].task};
        delete expectedTask.category;
        expect(after).toEqual({...before[index], task: {...expectedTask, updated: after.task.updated}});
        expect(after.task).not.toHaveProperty("category");
      }
      expect(await current.readPage(source.id)).toEqual(noteBefore);
      expect(await current.listTaskCategories()).toEqual([{name: "Empty", icon: "📌"}, {name: "Personal"}]);
    }
    expect(await Promise.all([other.id, bare.id].map(id => fs.readFile(path.join(root, "_tasks", `${id}.md`), "utf8")))).toEqual(untouchedBefore);
    expect(await fs.readFile(path.join(root, "_tasks", `${linked.id}.md`), "utf8")).not.toMatch(/^done:/m);
  });

  it("deletes legacy-only and empty categories and makes retries harmless", async () => {
    const {store, root} = await notebook();
    const legacy = await store.createTask({title: "Legacy", category: "Legacy"});
    expect(await readTaskCatalog(root)).toEqual([]);
    expect(await store.deleteTaskCategory("LEGACY")).toEqual({cleared: 1});
    expect(store.getTask(legacy.id)).not.toHaveProperty("category");
    await store.createTaskCategory("Empty", "✨");
    expect(await store.deleteTaskCategory("Empty")).toEqual({cleared: 0});
    expect(await store.deleteTaskCategory("Empty")).toEqual({cleared: 0});
    expect(await store.deleteTaskCategory("Unknown")).toEqual({cleared: 0});
    const reloaded = new Store(root);
    await reloaded.init();
    expect(await reloaded.listTaskCategories()).toEqual([]);
    expect(reloaded.allTasks()).toHaveLength(1);
  });

  it.each(["", "   ", "Work\nPrivate", "x".repeat(201)])("refuses an invalid or virtual empty category %j before changing data", async name => {
    const {store} = await notebook();
    await store.createTaskCategory("Work");
    const task = await store.createTask({title: "Work", category: "Work"});
    await expect(store.deleteTaskCategory(name)).rejects.toMatchObject({name: "TaskValidationError"});
    expect(store.getTask(task.id)?.category).toBe("Work");
    expect(await store.listTaskCategories()).toEqual([{name: "Work"}]);
  });

  it("keeps the catalog and reports failure when a task write fails, then completes on retry", async () => {
    const {store, root} = await notebook();
    await store.createTaskCategory("Work", "✨");
    const first = await store.createTask({title: "First", category: "Work"});
    const second = await store.createTask({title: "Second", category: "WORK"});
    const write = taskFiles.writeTaskFile;
    const failed = vi.spyOn(taskFiles, "writeTaskFile").mockImplementation(async (root, task, body) => {
      if (task.id === second.id) throw new Error("disk failed");
      await write(root, task, body);
    });
    const events: StoreEvent[] = [];
    const listen = (event: StoreEvent) => events.push(event);
    brainEvents.on("change", listen);
    try {
      await expect(store.deleteTaskCategory("Work", "writer")).rejects.toThrow("disk failed");
      expect(store.getTask(first.id)).not.toHaveProperty("category");
      expect(store.getTask(second.id)?.category).toBe("WORK");
      expect(await readTaskCatalog(root)).toEqual([{name: "Work", icon: "✨"}]);
      expect(events.some(event => event.id === "categories")).toBe(false);
      failed.mockRestore();
      expect(await store.deleteTaskCategory("Work", "writer")).toEqual({cleared: 1});
      expect(events.at(-1)).toMatchObject({type: "task", id: "categories", src: "writer"});
      expect(await store.listTaskCategories()).toEqual([]);
    } finally {
      brainEvents.off("change", listen);
    }
  });
});
