import { generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";
import { normalizeTaskCategoryName, taskCategoryKey, taskCategorySchema } from "./details";
import { TASK_ID_RE, taskRecordFields, type TaskView } from "./model";

export const taskMoveSchema = z.object({
  category: taskCategorySchema.shape.name.transform(normalizeTaskCategoryName).refine(Boolean, "category cannot be blank").nullable(),
  beforeId: z.string().regex(TASK_ID_RE).nullable(),
  today: z.string().refine(value => value !== "someday" && taskRecordFields.shape.when.safeParse(value).success, "today must be a calendar day"),
}).strict();
export type TaskMoveInput = z.infer<typeof taskMoveSchema>;

/** Manual category order wins; newly captured/reopened tasks follow it. */
export function compareTaskOrder(a: TaskView, b: TaskView, today: string): number {
  if (a.order !== undefined || b.order !== undefined) {
    if (a.order === undefined) return 1;
    if (b.order === undefined) return -1;
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  }
  const late = (task: TaskView) => !!(task.deadline && task.deadline < today || task.when && task.when !== "someday" && task.when < today);
  return Number(late(b)) - Number(late(a)) || a.created.localeCompare(b.created) || a.id.localeCompare(b.id);
}

/** Uses the full visible set, never a filtered list of the current screen.
 * Rebalancing one category keeps hidden-by-filter siblings in their order and
 * bounds key growth. The same projection drives optimistic UI and storage. */
export function planTaskMove(tasks: readonly TaskView[], id: string, input: TaskMoveInput): {task: TaskView; tasks: TaskView[]; order: Record<string, string>} {
  const source = tasks.find(task => task.id === id);
  if (!source || source.done) throw new Error("This task is no longer available to move. Reload and try again.");
  if (input.beforeId === id) throw new Error("A task cannot be placed before itself.");
  const category = taskCategoryKey(input.category ?? "");
  const siblings = tasks.filter(task => task.id !== id && !task.done && taskCategoryKey(task.category ?? "") === category).sort((a, b) => compareTaskOrder(a, b, input.today));
  const at = input.beforeId === null ? siblings.length : siblings.findIndex(task => task.id === input.beforeId);
  if (at < 0) throw new Error("The destination changed. Reload and try again.");
  const moved = {...source};
  if (input.category === null) delete moved.category;
  else moved.category = input.category;
  siblings.splice(at, 0, moved);
  const keys = generateNKeysBetween(null, null, siblings.length);
  const order = Object.fromEntries(siblings.map((task, index) => [task.id, keys[index]]));
  const projected = tasks.map(task => task.id === id ? {...moved, order: order[id]} : Object.hasOwn(order, task.id) ? {...task, order: order[task.id]} : task);
  return {task: projected.find(task => task.id === id)!, tasks: projected, order};
}
