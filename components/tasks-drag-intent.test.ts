import { describe, expect, it } from "vitest";
import type { TaskView } from "@/lib/tasks/model";
import { compareTaskOrder, planTaskMove } from "@/lib/tasks/order";
import { resolveTaskDrop, restoreTaskPlacement, taskPositionChanged } from "./tasks-drag-intent";

const today = "2026-11-11";
const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({ id, title: id, done: false, created: "2026-11-01T10:00:00Z", updated: "2026-11-01T10:00:00Z", category: "Work", ...extra });
const rect = { top: 100, height: 60 };
const row = (taskId: string) => ({ kind: "task" as const, taskId, category: "Work" });
const ids = (tasks: readonly TaskView[]) => [...tasks].sort((a, b) => compareTaskOrder(a, b, today)).map((task) => task.id);

describe("task drop intent", () => {
  it("uses row midpoints and skips the dragged row when finding the next visible anchor", () => {
    const visible = [task("a"), task("b"), task("c")];
    expect(resolveTaskDrop("b", "row:a", row("a"), visible, 110, rect)).toMatchObject({ beforeId: "a", edge: "before" });
    expect(resolveTaskDrop("b", "row:a", row("a"), visible, 145, rect)).toMatchObject({ beforeId: "c", edge: "after" });
    expect(resolveTaskDrop("b", "row:c", row("c"), visible, 145, rect)).toMatchObject({ beforeId: null, edge: "after" });
    expect(resolveTaskDrop("b", "row:b", row("b"), visible, 145, rect)).toBeNull();
  });
  it("appends into empty and uncategorized destinations without inventing a row anchor", () => {
    expect(resolveTaskDrop("a", "empty", { kind: "category", category: "Empty", surface: "rail" }, [task("a")], 0, rect)).toEqual({ category: "Empty", beforeId: null, targetId: "empty" });
    expect(resolveTaskDrop("a", "none", { kind: "category", category: null, surface: "group" }, [task("a")], 0, rect)).toEqual({ category: null, beforeId: null, targetId: "none" });
  });
  it("refuses unavailable or completed row targets", () => {
    expect(resolveTaskDrop("a", "b", row("b"), [task("a")], 120, rect)).toBeNull();
    expect(resolveTaskDrop("a", "b", row("b"), [task("a"), task("b", { done: true })], 120, rect)).toBeNull();
  });
  it("uses visible anchors but preserves the relative order of hidden tasks", () => {
    const all = [task("a", { order: "a0" }), task("hidden", { order: "a1" }), task("b", { order: "a2" }), task("c", { order: "a3" })];
    const target = resolveTaskDrop("c", "a", row("a"), all.filter((task) => task.id !== "hidden"), 145, rect)!;
    expect(target.beforeId).toBe("b");
    expect(ids(planTaskMove(all, "c", { category: target.category, beforeId: target.beforeId, today }).tasks)).toEqual(["a", "hidden", "c", "b"]);
  });
});

describe("optimistic task placement", () => {
  it("does not turn a stationary placement into a write just because ranks were seeded", () => {
    const before = [task("a"), task("b")];
    const unchanged = planTaskMove(before, "a", { category: "Work", beforeId: "b", today });
    expect(taskPositionChanged(before, unchanged.tasks, "a", today)).toBe(false);
    const changed = planTaskMove(before, "b", { category: "Work", beforeId: "a", today });
    expect(taskPositionChanged(before, changed.tasks, "b", today)).toBe(true);
  });
  it("detects a move across a completed sibling even when the open-task order is unchanged", () => {
    const before = [task("a", { order: "a0" }), task("done", { order: "a1", done: true }), task("b", { order: "a2" })];
    const moved = planTaskMove(before, "a", { category: "Work", beforeId: "b", today });
    expect(ids(moved.tasks)).toEqual(["done", "a", "b"]);
    expect(taskPositionChanged(before, moved.tasks, "a", today)).toBe(true);
    const unchanged = planTaskMove(before, "a", { category: "Work", beforeId: "done", today });
    expect(ids(unchanged.tasks)).toEqual(["a", "done", "b"]);
    expect(taskPositionChanged(before, unchanged.tasks, "a", today)).toBe(false);
  });
  it("restores failed placement without discarding concurrent text, dates, or completion", () => {
    const before = [task("a", { category: "Personal" }), task("b")];
    const optimistic = planTaskMove(before, "a", { category: "Work", beforeId: "b", today }).tasks;
    const live = [...optimistic.map((task) => task.id === "a" ? { ...task, title: "Edited elsewhere", when: "2026-11-15", done: true } : task), task("new")];
    const restored = restoreTaskPlacement(live, before, optimistic, "a");
    expect(restored.find((task) => task.id === "a")).toMatchObject({ title: "Edited elsewhere", category: "Personal", when: "2026-11-15", done: true });
    expect(restored.find((task) => task.id === "a")?.order).toBeUndefined();
    expect(restored.find((task) => task.id === "new")).toEqual(task("new"));
  });
  it("leaves a subsequent move alone when rolling back an older request", () => {
    const before = [task("a", { category: "Personal" }), task("b")];
    const optimistic = planTaskMove(before, "a", { category: "Work", beforeId: "b", today }).tasks;
    const live = optimistic.map((task) => task.id === "a" ? { ...task, category: "Other", order: "z0" } : task);
    expect(restoreTaskPlacement(live, before, optimistic, "a").find((task) => task.id === "a")).toMatchObject({ category: "Other", order: "z0" });
  });
});
