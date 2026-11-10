import { z } from "zod";

export const taskBodySchema = z.string().max(100_000);
export const taskCategorySchema = z.object({
  name: z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/),
  icon: z.string().max(64).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
}).strict();
export type TaskCategory = z.infer<typeof taskCategorySchema>;
export const taskCatalogSchema = z.object({
  schema: z.literal(1),
  categories: z.array(taskCategorySchema).max(2_000),
}).strict();
export function normalizeTaskCategoryName(name: string): string {
  return typeof name === "string" ? name.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
}
export function taskCategoryKey(name: string): string {
  return normalizeTaskCategoryName(name).toLocaleLowerCase("en");
}
