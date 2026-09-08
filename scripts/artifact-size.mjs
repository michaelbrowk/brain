import { readdir, lstat } from "node:fs/promises";
import path from "node:path";
import { PRUNED_NATIVE_NAMES, isPrunedNativeEntry } from "./build-release.mjs";

/** The size ceiling is about what a person downloads, and what ships is the
 * release stage, which drops sharp: it is a per-architecture native module and
 * nothing in Brain imports it at runtime. Counting it measured a tree that
 * never leaves the builder, and on macOS its 15 MB of arm64 libvips put the
 * number over the ceiling on a machine whose release was perfectly fine. The
 * rule comes from build-release.mjs so the two cannot drift apart.
 *
 * This lives in its own module because smoke-standalone.mjs runs its whole
 * smoke on import, so a test cannot borrow a function from it. */
export function isPrunedFromRelease(rootPath, entryPath) {
  const relative = path.relative(rootPath, entryPath).split(path.sep);
  const at = relative.indexOf("node_modules");
  if (at === -1) return false;
  const next = relative[at + 1];
  if (next === undefined) return false;
  if (PRUNED_NATIVE_NAMES.includes(next)) return true;
  return next === ".pnpm" && isPrunedNativeEntry(relative[at + 2] ?? "");
}

/** Total bytes of the artifact as the release ships it, plus every jsdom
 * runtime found, which the smoke asserts there is exactly one of. */
export async function inspectArtifact(rootPath) {
  let bytes = 0;
  const jsdomApis = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (isPrunedFromRelease(rootPath, entryPath)) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        bytes += (await lstat(entryPath)).size;
        if (entryPath.endsWith(`${path.sep}jsdom${path.sep}lib${path.sep}api.js`)) {
          jsdomApis.push(entryPath);
        }
      }
    }
  }
  return { bytes, jsdomApis };
}
