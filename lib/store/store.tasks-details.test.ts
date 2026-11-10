import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "./store";
import { hashTaskText, normalizeTaskText } from "../tasks/task-lines";
import { buildPortableArchive, validatePortableArchive, applyPortableBundle } from "../portable/model";

const roots: string[] = [];
async function temporary() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-task-details-"));
  roots.push(root);
  const store = new Store(root);
  await store.init();
  return {root, store};
}
afterEach(async () => {vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, {recursive: true, force: true})));});

describe("task dialog persistence", () => {
  it("keeps notes and context pages on reload and refuses stale note edits atomically", async () => {
    const {store, root} = await temporary();
    const page = await store.createPage(null, "Release notes");
    const body = "---\nuser frontmatter\n---\nSome notes without trailing newline";
    const task = await store.createTask({title: "Review", body, relatedPageIds: [page.id]});
    const details = await store.readTaskDetails(task.id);
    expect(details.body).toBe(body);
    await store.updateTask(task.id, {category: "Work"});
    expect((await store.readTaskDetails(task.id)).body).toBe(body);
    await store.updateTask(task.id, {body: "Changed", bodyRev: details.bodyRev, relatedPageIds: []});
    await expect(store.updateTask(task.id, {title: "Must not land", body: "Stale", bodyRev: details.bodyRev})).rejects.toMatchObject({name: "TaskBodyConflictError"});
    expect(store.getTask(task.id)?.title).toBe("Review");
    const reloaded = new Store(root);
    await reloaded.init();
    expect(await reloaded.readTaskDetails(task.id)).toMatchObject({body: "Changed", task: {category: "Work"}});
    expect(reloaded.getTask(task.id)).not.toHaveProperty("relatedPageIds");
    await expect(store.updateTask(task.id, {body: "No revision"})).rejects.toThrow(/bodyRev/);
    await expect(store.createTask({title: "Invalid", relatedPageIds: ["missing"]})).rejects.toThrow(/page not found/);
  });

  it("keeps source checkbox identity and completion separate from related pages and notes", async () => {
    const {store} = await temporary();
    const source = await store.createPage(null, "Source");
    const related = await store.createPage(null, "Context");
    const markdown = "- [ ] Review\n";
    await store.writePage(source.id, markdown);
    const text = normalizeTaskText("Review");
    const task = await store.createTask({title: "Review", page: source.id, anchor: {text, hash: hashTaskText(text), ordinal: 0, line: 0}});
    const detail = await store.readTaskDetails(task.id);
    await store.updateTask(task.id, {body: "Context notes", bodyRev: detail.bodyRev, relatedPageIds: [related.id]});
    expect((await store.readPage(source.id)).markdown).toContain("- [ ] Review");
    await expect(store.updateTask(task.id, {done: true, relatedPageIds: []})).rejects.toThrow(/same call/);
    expect(store.getTask(task.id)?.done).toBe(false);
    await store.updateTask(task.id, {done: true});
    expect((await store.readPage(source.id)).markdown).toContain("- [x] Review");
    expect(await store.readTaskDetails(task.id)).toMatchObject({body: "Context notes", task: {page: source.id, relatedPageIds: [related.id], done: true}});
    await store.writePage(source.id, "The checkbox was removed.");
    expect(store.getTask(task.id)).toMatchObject({relatedPageIds: [related.id], page: source.id});
  });

  it("persists an empty category, deduplicates concurrent creation and preserves emoji clear", async () => {
    const {store, root} = await temporary();
    const [first, second] = await Promise.all([store.createTaskCategory("  Design   reviews  ", "✨"), store.createTaskCategory("design reviews", "🎨")]);
    expect(first.name).toBe("Design reviews");
    expect(second).toEqual(first);
    expect(await store.listTaskCategories()).toEqual([first]);
    await store.updateTaskCategory(first.name, "🎨");
    const reloaded = new Store(root); await reloaded.init();
    expect(await reloaded.listTaskCategories()).toEqual([{name: first.name, icon: "🎨"}]);
    await reloaded.updateTaskCategory(first.name, null);
    expect(await reloaded.listTaskCategories()).toEqual([{name: first.name}]);
    const legacy = await reloaded.createTask({title: "Old", category: "Legacy"});
    await reloaded.updateTask(legacy.id, {done: true});
    expect(await reloaded.listTaskCategories()).toContainEqual({name: "Legacy"});
  });

  it("does not manufacture a category when catalog persistence fails", async () => {
    const {store, root} = await temporary();
    await fs.mkdir(path.join(root, "_tasks"), {recursive: true});
    await fs.writeFile(path.join(root, "_tasks", "_catalog"), "not a directory");
    await expect(store.createTaskCategory("No phantom")).rejects.toThrow();
    expect(await fs.readFile(path.join(root, "_tasks", "_catalog"), "utf8")).toBe("not a directory");
  });

  it("round-trips empty categories, notes and remapped links through portable export", async () => {
    const {store} = await temporary();
    const page = await store.createPage(null, "Context");
    await store.createTaskCategory("Empty", "✨");
    await store.createTask({title: "Review", body: "Notes", relatedPageIds: [page.id], category: "Work"});
    const archive = await buildPortableArchive(store);
    expect(archive.manifest.version).toBe(4);
    const {store: destination} = await temporary();
    await destination.createTaskCategory("Empty", "📌");
    const result = await applyPortableBundle(destination, validatePortableArchive(archive.bytes, destination).bundle);
    const task = destination.allTasks()[0];
    expect(task.relatedPageIds).toEqual([result.rootIds[0]]);
    expect(task.relatedPageIds).not.toContain(page.id);
    expect(await destination.readTaskBody(task.id)).toBe("Notes");
    expect(await destination.listTaskCategories()).toContainEqual({name: "Empty", icon: "📌"});
  });
  it("drops out-of-scope context ids instead of importing references to another notebook", async () => {
    const {store} = await temporary();
    const source = await store.createPage(null, "Source");
    const outside = await store.createPage(null, "Outside");
    await store.writePage(source.id, "- [ ] Review");
    const text = normalizeTaskText("Review");
    await store.createTask({title: "Review", page: source.id, anchor: {text, hash: hashTaskText(text), ordinal: 0, line: 0}, relatedPageIds: [outside.id]});
    const archive = await buildPortableArchive(store, {rootId: source.id});
    const {store: destination} = await temporary();
    const result = await applyPortableBundle(destination, validatePortableArchive(archive.bytes, destination).bundle);
    expect(destination.allTasks()[0]).toMatchObject({page: result.rootIds[0]});
    expect(destination.allTasks()[0]).not.toHaveProperty("relatedPageIds");
  });

  it("does not reorder existing categories when adding one or changing its icon", async () => {
    const {store} = await temporary();
    await store.createTask({title: "Legacy task", category: "Legacy"});
    await store.createTaskCategory("New", "✨");
    await store.updateTaskCategory("Legacy", "📌");
    expect((await store.listTaskCategories()).map(category => category.name)).toEqual(["Legacy", "New"]);
  });

  it("omits empty context on create and after removing the last link", async () => {
    const {store, root} = await temporary();
    const page = await store.createPage(null, "Context");
    const task = await store.createTask({title: "Ordinary task", relatedPageIds: []});
    const file = path.join(root, "_tasks", `${task.id}.md`);
    expect(task).not.toHaveProperty("relatedPageIds");
    expect(await fs.readFile(file, "utf8")).not.toContain("relatedPageIds:");
    await store.updateTask(task.id, {relatedPageIds: [page.id]});
    expect(await fs.readFile(file, "utf8")).toContain("relatedPageIds:");
    const cleared = await store.updateTask(task.id, {relatedPageIds: []});
    expect(cleared).not.toHaveProperty("relatedPageIds");
    expect(await fs.readFile(file, "utf8")).not.toContain("relatedPageIds:");
    const reloaded = new Store(root); await reloaded.init();
    expect(reloaded.getTask(task.id)).not.toHaveProperty("relatedPageIds");
  });

});
