import { readFileSync } from "node:fs";
import path from "node:path";
import { SAMPLE_TREE, type StandPage } from "./sample-fixtures";

export { SAMPLE_TREE };
export type { StandPage };

/** Reads the filesystem, so it belongs to the server half of the route: only
 *  app/dev/glass/page.tsx may call it, and it hands the result to the client
 *  stand as a prop. BRAIN_PRIVATE_DIR points at a directory of local fixtures
 *  and the stand draws the tree it finds there; unset — as in every CI run —
 *  it draws the sample. A broken fixture file is not worth a crashed dev
 *  route. */
export function loadStandTree(): StandPage[] {
  const directory = process.env.BRAIN_PRIVATE_DIR;
  if (!directory) return SAMPLE_TREE;
  try {
    const body = readFileSync(path.join(directory, "glass-fixtures.json"), "utf8");
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed) || parsed.length === 0) return SAMPLE_TREE;
    return parsed as StandPage[];
  } catch {
    return SAMPLE_TREE;
  }
}
