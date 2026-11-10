import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { atomicWrite } from "./atomic";
import { assertInRoot } from "./paths";
import { assertRealDirectory, ensureRealDirectory } from "./real-directory";
import { taskCatalogSchema, type TaskCategory } from "../tasks/details";

const catalogDirectory = (root: string) => assertInRoot(root, path.join(root, "_tasks", "_catalog"));
export async function readTaskCatalog(root: string): Promise<TaskCategory[]> {
  try {
    await assertRealDirectory(path.join(root, "_tasks"));
    await assertRealDirectory(catalogDirectory(root));
    const file = path.join(catalogDirectory(root), "index.md");
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("task catalog must not be a symbolic link");
    const raw = matter(await fs.readFile(file, "utf8"));
    return taskCatalogSchema.parse(raw.data).categories;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function writeTaskCatalog(root: string, categories: TaskCategory[]): Promise<void> {
  const catalog = taskCatalogSchema.parse({schema: 1, categories});
  await ensureRealDirectory(path.join(root, "_tasks"));
  await ensureRealDirectory(catalogDirectory(root));
  const file = path.join(catalogDirectory(root), "index.md");
  let body = "";
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("task catalog must not be a symbolic link");
    body = matter(await fs.readFile(file, "utf8")).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(file, matter.stringify("", catalog).replace(/\n+$/, "\n") + body);
}
