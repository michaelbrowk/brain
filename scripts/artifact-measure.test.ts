import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { PRUNED_NATIVE_NAMES, isPrunedNativeEntry, pruneNativeModules } from "./build-release.mjs";
import { inspectArtifact } from "./artifact-size.mjs";

/** The size ceiling is about what a person downloads. The release stage drops
 *  sharp, so a measurement that counts it fails a build whose release is fine:
 *  on macOS its arm64 libvips alone is 15 MB against a 120 MiB ceiling. These
 *  pin that the measurement and the prune agree about what ships. */
const roots: string[] = [];

async function plant(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "artifact-"));
  roots.push(root);
  const modules = path.join(root, "node_modules");
  await mkdir(path.join(modules, ".pnpm", "sharp@0.34.5", "node_modules", "sharp"), { recursive: true });
  await mkdir(path.join(modules, ".pnpm", "@img+sharp-libvips-linux-x64@1.2.4"), { recursive: true });
  await mkdir(path.join(modules, "sharp"), { recursive: true });
  await mkdir(path.join(modules, "@img"), { recursive: true });
  await mkdir(path.join(modules, "bcryptjs"), { recursive: true });
  await writeFile(path.join(modules, ".pnpm", "sharp@0.34.5", "node_modules", "sharp", "big.node"), "x".repeat(4096));
  await writeFile(path.join(modules, ".pnpm", "@img+sharp-libvips-linux-x64@1.2.4", "libvips"), "x".repeat(8192));
  await writeFile(path.join(modules, "sharp", "index.js"), "x".repeat(512));
  await writeFile(path.join(modules, "@img", "index.js"), "x".repeat(512));
  await writeFile(path.join(modules, "bcryptjs", "index.js"), "keep me");
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the artifact measurement", () => {
  it("counts only what the release ships", async () => {
    const root = await plant();
    const { bytes } = await inspectArtifact(root);
    expect(bytes).toBe("keep me".length);
  });

  it("measures the same tree the prune leaves behind", async () => {
    const before = await plant();
    const measured = (await inspectArtifact(before)).bytes;
    const after = await plant();
    await pruneNativeModules(after);
    expect((await inspectArtifact(after)).bytes).toBe(measured);
  });

  it("names every prefix the prune removes, so the two cannot drift", () => {
    expect(PRUNED_NATIVE_NAMES).toEqual(["sharp", "@img"]);
    expect(isPrunedNativeEntry("sharp@0.34.5")).toBe(true);
    expect(isPrunedNativeEntry("@img+sharp-libvips-linux-x64@1.2.4")).toBe(true);
    expect(isPrunedNativeEntry("sharpen@1.0.0")).toBe(false);
    expect(isPrunedNativeEntry("bcryptjs@3.0.3")).toBe(false);
  });
});
