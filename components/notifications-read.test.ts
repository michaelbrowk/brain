import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Walk the import graph the bundler would walk, over this tree's own modules
 *  only. A `zod` import anywhere in it is a schema construction in Mail's
 *  chunk: `notificationSchema` is built at module scope and `package.json`
 *  declares no `sideEffects`, so the bundler cannot prune it. */
async function localImportGraph(entry: string): Promise<Map<string, string>> {
  const root = process.cwd();
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const source = await readFile(path.join(root, file), "utf8");
    seen.set(file, source);
    for (const match of source.matchAll(/^\s*(?:import|export)[^"']*["']([^"']+)["']/gm)) {
      const specifier = match[1];
      let resolved: string | null = null;
      if (specifier.startsWith("@/")) resolved = specifier.slice(2);
      else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        resolved = path.normalize(path.join(path.dirname(file), specifier));
      }
      if (resolved === null) continue;
      queue.push(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
    }
  }
  return seen;
}

describe("what the seam drags into Mail's bundle", () => {
  it("reaches no zod-carrying module", async () => {
    const graph = await localImportGraph("components/notifications-read.ts");
    // The guard is only worth anything if it walked past the entry file.
    expect(graph.has("components/notifications-client.ts")).toBe(true);
    const carriers = [...graph]
      .filter(([, source]) => /from\s+["']zod["']/.test(source))
      .map(([file]) => file);
    expect(carriers).toEqual([]);
  });

  it("would notice a zod-carrying module, which is what makes the row above mean something", async () => {
    const graph = await localImportGraph("lib/notifications/store.ts");
    const carriers = [...graph]
      .filter(([, source]) => /from\s+["']zod["']/.test(source))
      .map(([file]) => file);
    expect(carriers).toContain("lib/notifications/model.ts");
  });
});
