import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import { atomicWrite } from "./atomic";
import { assertInRoot } from "./paths";
import { assertRealDirectory, ensureRealDirectory } from "./real-directory";
import { TASK_ID_RE } from "../tasks/model";

const rank = z.string().max(128).refine(value => {
  try { generateKeyBetween(value, null); return true; } catch { return false; }
}, "invalid order key");
export type TaskOrder = Record<string, Record<string, string>>;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// z.record strips __proto__ keys. These are legitimate category names/task ids,
// so validate own entries without rewriting their keys or prototype.
const categories = z.custom<TaskOrder>(value => object(value) && Object.entries(value).every(([category, tasks]) =>
  category.length <= 200 && object(tasks) && Object.entries(tasks).every(([id, key]) => TASK_ID_RE.test(id) && rank.safeParse(key).success),
), "invalid task order");
const schema = z.object({schema: z.literal(1), categories}).strict();
const directory = (root: string) => assertInRoot(root, path.join(root, "_tasks", "_order"));

/** Nested under _tasks so older task readers ignore it, not the task files. */
export async function readTaskOrder(root: string): Promise<TaskOrder> {
  try {
    await assertRealDirectory(path.join(root, "_tasks"));
    await assertRealDirectory(directory(root));
    const file = path.join(directory(root), "index.md");
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("task order must not be a symbolic link");
    return schema.parse(matter(await fs.readFile(file, "utf8")).data).categories;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
export async function writeTaskOrder(root: string, categories: TaskOrder): Promise<void> {
  const parsed = schema.parse({schema: 1, categories});
  await ensureRealDirectory(path.join(root, "_tasks"));
  await ensureRealDirectory(directory(root));
  const file = path.join(directory(root), "index.md");
  let body = "";
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("task order must not be a symbolic link");
    body = matter(await fs.readFile(file, "utf8")).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(file, matter.stringify("", parsed).replace(/\n+$/, "\n") + body);
}
