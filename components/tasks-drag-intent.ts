import { taskCategoryKey } from "@/lib/tasks/details";
import { compareTaskOrder } from "@/lib/tasks/order";
import type { TaskView } from "@/lib/tasks/model";

export type TaskDragTarget =
  | { kind: "task"; taskId: string; category: string | null }
  | { kind: "category"; category: string | null; surface: "rail" | "group" };
export interface TaskDropIntent {
  category: string | null;
  beforeId: string | null;
  targetId: string;
  edge?: "before" | "after";
}

/** Resolve only the actual target under the pointer. There is deliberately
 * no nearest-category fallback outside the Tasks drop regions. */
export function resolveTaskDrop(
  activeId: string,
  targetId: string,
  target: TaskDragTarget,
  visible: readonly TaskView[],
  pointerY: number,
  rect: { top: number; height: number },
): TaskDropIntent | null {
  if (target.kind === "category") return { category: target.category, beforeId: null, targetId };
  if (target.taskId === activeId) return null;
  const row = visible.find((task) => task.id === target.taskId && !task.done);
  if (!row) return null;
  const edge = pointerY < rect.top + rect.height / 2 ? "before" : "after";
  const siblings = visible.filter((task) => !task.done && task.id !== activeId && taskCategoryKey(task.category || "") === taskCategoryKey(row.category || ""));
  const index = siblings.findIndex((task) => task.id === row.id);
  return {
    category: row.category || null,
    beforeId: edge === "before" ? row.id : siblings[index + 1]?.id || null,
    targetId,
    edge,
  };
}

export function taskPositionChanged(before: readonly TaskView[], after: readonly TaskView[], id: string, today: string): boolean {
  const previous = before.find((task) => task.id === id);
  const next = after.find((task) => task.id === id);
  if (!previous || !next) return false;
  const category = taskCategoryKey(previous.category || "");
  if (category !== taskCategoryKey(next.category || "")) return true;
  const ids = (tasks: readonly TaskView[]) => tasks.filter((task) => !task.done && taskCategoryKey(task.category || "") === category).sort((a, b) => compareTaskOrder(a, b, today)).map((task) => task.id).join("|");
  return ids(before) !== ids(after);
}

/** Roll back only placement fields still equal to our optimistic write.
 * Concurrent text, dates, completion and newly loaded tasks remain intact. */
export function restoreTaskPlacement(live: readonly TaskView[], before: readonly TaskView[], optimistic: readonly TaskView[], movedId: string): TaskView[] {
  return live.map((task) => {
    const previous = before.find((entry) => entry.id === task.id);
    const planned = optimistic.find((entry) => entry.id === task.id);
    if (!previous || !planned || task.order !== planned.order || taskCategoryKey(task.category || "") !== taskCategoryKey(planned.category || "")) return task;
    const next = { ...task };
    if (previous.order === undefined) delete next.order; else next.order = previous.order;
    if (task.id === movedId) { if (previous.category) next.category = previous.category; else delete next.category; }
    return next;
  });
}
