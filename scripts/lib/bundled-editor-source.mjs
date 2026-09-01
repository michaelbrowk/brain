import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * Load editor TypeScript in a temporary ESM harness while preserving the
 * production dependency graph. Local imports (including tsconfig aliases) are
 * bundled; npm packages stay external so Milkdown uses the repo installation.
 */
export async function createBundledEditorSourceLoader(repoRoot, prefix) {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  await symlink(join(repoRoot, "node_modules"), join(tempDir, "node_modules"), "dir");
  let importVersion = 0;

  return {
    async load(relativePath, outputName) {
      const outputPath = join(tempDir, outputName);
      await build({
        entryPoints: [join(repoRoot, relativePath)],
        outfile: outputPath,
        bundle: true,
        packages: "external",
        platform: "node",
        format: "esm",
        target: "node22",
        tsconfig: join(repoRoot, "tsconfig.json"),
        logLevel: "silent",
      });
      importVersion += 1;
      return import(
        `${pathToFileURL(outputPath).href}?v=${Date.now()}-${importVersion}`
      );
    },
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}
