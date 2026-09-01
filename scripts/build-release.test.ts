import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  MAIL_OPS_FILES,
  MAIL_RUNTIME_LISTING,
  RELEASE_OPS_EXCLUDED,
  RELEASE_OPS_FILES,
  buildLegacyArtifact,
  buildReleaseArtifact,
  stageFileSet,
  stageStandalone,
  tarballName,
  verifyStage,
} from "./build-release.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const commit = "a".repeat(40);
const builtAt = "2026-08-30T10:00:00Z";
const python3 = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A repo root whose .next/standalone carries exactly the packaged Mail listing. */
async function syntheticRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-build-release-"));
  roots.push(root);
  const standalone = path.join(root, ".next", "standalone");
  await mkdir(path.join(standalone, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(standalone, "server.js"), "next server\n");
  await writeFile(path.join(standalone, "package.json"), "{}\n");
  await symlink("pkg", path.join(standalone, "node_modules", "alias"));
  for (const [relative, entries] of Object.entries(MAIL_RUNTIME_LISTING)) {
    const directory = path.join(standalone, "mail-service", relative);
    await mkdir(directory, { recursive: true });
    for (const entry of entries) {
      const [name, kind] = entry.split("|");
      if (kind === "f") await writeFile(path.join(directory, name), `${name}\n`);
      else await mkdir(path.join(directory, name), { recursive: true });
    }
  }
  await mkdir(path.join(root, ".next", "static", "chunks"), { recursive: true });
  await writeFile(path.join(root, ".next", "static", "chunks", "app.js"), "chunk\n");
  await mkdir(path.join(root, "public"), { recursive: true });
  await writeFile(path.join(root, "public", "icon.svg"), "<svg/>\n");
  await mkdir(path.join(root, "ops", "brain.service.d"), { recursive: true });
  await mkdir(path.join(root, "ops", "brain-mail.service.d"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "ops", "brain-server.cjs"), 'require("./brain-shutdown-preload.mjs");\nrequire("./brain-next-server.js");\n');
  await writeFile(path.join(root, "ops", "brain-shutdown-preload.mjs"), "// preload\n");
  for (const [source] of MAIL_OPS_FILES) {
    await writeFile(path.join(root, source), `${source}\n`);
  }
  await execFileAsync("cp", [
    path.join(process.cwd(), "scripts", "write-artifact-manifest.mjs"),
    path.join(root, "scripts", "write-artifact-manifest.mjs"),
  ]);
  return root;
}

describe("release packaging", () => {
  it("stages the standalone tree exactly as the workflow did", async () => {
    const root = await syntheticRoot();
    const stage = path.join(root, "stage");
    await stageStandalone({ root, stage });
    await verifyStage(stage);
    expect(await readFile(path.join(stage, "server.js"), "utf8")).toContain("brain-next-server.js");
    expect(await readFile(path.join(stage, "brain-next-server.js"), "utf8")).toBe("next server\n");
    expect(await readFile(path.join(stage, ".next", "static", "chunks", "app.js"), "utf8")).toBe("chunk\n");
    expect(await readFile(path.join(stage, "public", "icon.svg"), "utf8")).toBe("<svg/>\n");
    const { stdout } = await execFileAsync("readlink", [path.join(stage, "node_modules", "alias")]);
    expect(stdout.trim()).toBe("pkg");
    const manifest = await readFile(path.join(stage, "brain-mail-ops", "MANIFEST.sha256"), "utf8");
    expect(manifest.trimEnd().split("\n")).toHaveLength(MAIL_OPS_FILES.length);
    expect(manifest).toMatch(/^[0-9a-f]{64}  brain-mail\.service$/m);
    expect(manifest).toMatch(/  brain\.service\.d\/90-brain-mail-client\.conf$/m);
  });

  it("refuses a stage whose Mail runtime listing drifted", async () => {
    const root = await syntheticRoot();
    const stage = path.join(root, "stage");
    await stageStandalone({ root, stage });
    await rm(path.join(stage, "mail-service", "service", "main.js"));
    await expect(verifyStage(stage)).rejects.toThrow("mail-service/service listing differs");
  });

  it("refuses a tampered brain-mail-ops payload", async () => {
    const root = await syntheticRoot();
    const stage = path.join(root, "stage");
    await stageStandalone({ root, stage });
    await writeFile(path.join(stage, "brain-mail-ops", "install-brain-mail.sh"), "tampered\n");
    await expect(verifyStage(stage)).rejects.toThrow("manifest mismatch for install-brain-mail.sh");
  });

  it("packs the legacy artifact that verify-release-artifact.mjs accepts", async () => {
    const root = await syntheticRoot();
    const out = path.join(root, "artifacts");
    const { archive, manifest } = await buildLegacyArtifact({
      root, stage: path.join(root, "stage"), out, commit, builtAt,
    });
    expect(path.basename(archive)).toBe("brain-standalone-linux-x64.tar.gz");
    const verified = await execFileAsync(process.execPath, [
      path.join(process.cwd(), "scripts", "verify-release-artifact.mjs"), archive, manifest, commit,
    ]);
    expect(verified.stdout).toBe(builtAt);
    const listing = await execFileAsync("tar", ["-tzf", archive]);
    expect(listing.stdout).toContain("./brain-mail-ops/MANIFEST.sha256");
    expect(listing.stdout).toContain("./brain-next-server.js");
  });
});

describe("release layout", () => {
  it("ships every tracked ops file either in ops/ or in the explicit exclusion list", async () => {
    const { stdout } = await execFileAsync("git", ["ls-files", "ops"], { cwd: process.cwd() });
    const tracked = stdout.trim().split("\n").filter((file) => !/\.test\.ts$|_test\.py$/.test(file));
    const shipped = new Set(RELEASE_OPS_FILES.map(([source]) => source));
    const missing = tracked.filter(
      (file) => !shipped.has(file) && !RELEASE_OPS_EXCLUDED.some((excluded) => file === excluded || file.startsWith(excluded)),
    );
    expect(missing).toEqual([]);
  });

  it("packs the versioned tarball with ops/, release.json, and SHA256SUMS", async () => {
    const root = await syntheticRoot();
    for (const [source] of RELEASE_OPS_FILES) {
      await mkdir(path.dirname(path.join(root, source)), { recursive: true });
      await writeFile(path.join(root, source), `${source}\n`);
    }
    const out = path.join(root, "artifacts");
    const { archive, checksums } = await buildReleaseArtifact({
      root, stage: path.join(root, "stage"), out, version: "0.9.0-rc.1", commit, builtAt, fixtureVersions: ["0.9.0"],
    });
    expect(path.basename(archive)).toBe(tarballName("0.9.0-rc.1"));
    const sums = await readFile(checksums, "utf8");
    expect(sums).toMatch(/^[0-9a-f]{64}  brain-0\.9\.0-rc\.1-linux-x64\.tar\.gz\n$/);
    const listing = (await execFileAsync("tar", ["-tzf", archive])).stdout;
    expect(listing).toContain("./release.json");
    expect(listing).toContain("./ops/MANIFEST.sha256");
    expect(listing).toContain("./ops/bin/deploy-puller.sh");
    expect(listing).toContain("./ops/systemd/brain.service");
    expect(listing).toContain("./ops/sysusers.d/brain-mail.conf");
    expect(listing).toContain("./ops/tmpfiles.d/brain-mail-mime.conf");
    expect(listing).toContain("./ops/nginx/brain.conf.example");
    expect(listing).toContain("./brain-mail-ops/MANIFEST.sha256");
    const release = JSON.parse(await readFile(path.join(root, "stage", "release.json"), "utf8"));
    expect(release).toEqual({ schema: 1, version: "0.9.0-rc.1", commit, buildTime: builtAt, minUpgradeFrom: "0.9.0-rc.1" });
  });

  it.skipIf(!python3)("packs a tarball the droplet extractor accepts as published", async () => {
    const root = await syntheticRoot();
    await writeFile(
      path.join(root, ".next", "standalone", "mail-service", "build.json"),
      `${JSON.stringify({ commit, builtAt })}\n`,
    );
    for (const [source] of RELEASE_OPS_FILES) {
      await mkdir(path.dirname(path.join(root, source)), { recursive: true });
      await writeFile(path.join(root, source), `${source}\n`);
    }
    const out = path.join(root, "artifacts");
    const { archive, checksums } = await buildReleaseArtifact({
      root, stage: path.join(root, "stage"), out, version: "0.9.0-rc.1", commit, builtAt, fixtureVersions: ["0.9.0"],
    });
    const digest = (await readFile(checksums, "utf8")).split("  ")[0];
    await writeFile(`${archive}.sha256`, `${digest}\n`);
    const work = path.join(root, "work");
    const extracted = await execFileAsync("python3", [
      path.join(process.cwd(), "ops", "extract_release.py"),
      "extract", archive, work, commit,
    ]);
    expect(extracted.stdout).toBe(`${builtAt}\n`);
    expect(JSON.parse(await readFile(path.join(work, "release", "release.json"), "utf8"))).toEqual(
      JSON.parse(await readFile(path.join(root, "stage", "release.json"), "utf8")),
    );
  }, 30_000);
});

describe("native modules in the release stage", () => {
  async function plantReleaseOps(root: string): Promise<void> {
    for (const [source] of RELEASE_OPS_FILES) {
      await mkdir(path.dirname(path.join(root, source)), { recursive: true });
      await writeFile(path.join(root, source), `${source}\n`);
    }
  }

  async function plantSharp(root: string): Promise<void> {
    const modules = path.join(root, ".next", "standalone", "node_modules");
    const store = path.join(modules, ".pnpm", "@img+sharp-linux-x64@0.0.0", "node_modules", "@img", "sharp-linux-x64", "lib");
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, "sharp-linux-x64.node"), "elf\n");
    await mkdir(path.join(modules, "@img"), { recursive: true });
    await writeFile(path.join(modules, "@img", "package.json"), "{}\n");
    await mkdir(path.join(modules, "sharp"), { recursive: true });
    await writeFile(path.join(modules, "sharp", "package.json"), "{}\n");
    // a consumer's private store link, the shape next/miniflare really have
    const consumer = path.join(modules, ".pnpm", "next@0.0.0", "node_modules");
    await mkdir(consumer, { recursive: true });
    await symlink("../../@img+sharp-linux-x64@0.0.0/node_modules/@img", path.join(consumer, "@img"));
    // the hidden store scope pnpm keeps for its own resolution
    const hidden = path.join(modules, ".pnpm", "node_modules", "@img");
    await mkdir(hidden, { recursive: true });
    await symlink(
      "../../@img+sharp-linux-x64@0.0.0/node_modules/@img/sharp-linux-x64",
      path.join(hidden, "sharp-linux-x64"),
    );
  }

  it("prunes the traced sharp stack from the release stage and keeps it in the legacy one", async () => {
    const root = await syntheticRoot();
    await plantReleaseOps(root);
    await plantSharp(root);
    const legacy = path.join(root, "legacy-stage");
    await stageStandalone({ root, stage: legacy });
    const kept = await execFileAsync("find", [legacy, "-name", "*.node"]);
    expect(kept.stdout.trim()).not.toBe("");

    const out = path.join(root, "artifacts");
    const stage = path.join(root, "release-stage");
    await buildReleaseArtifact({ root, stage, out, version: "0.9.0", commit, builtAt, fixtureVersions: [] });
    const left = await execFileAsync("find", [stage, "-name", "*.node"]);
    expect(left.stdout.trim()).toBe("");
    await expect(stat(path.join(stage, "node_modules", "sharp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(stage, "node_modules", "@img"))).rejects.toMatchObject({ code: "ENOENT" });
    const links = await execFileAsync("find", [path.join(stage, "node_modules"), "-type", "l"]);
    const dangling: string[] = [];
    for (const link of links.stdout.trim().split("\n").filter(Boolean)) {
      await stat(link).catch(() => dangling.push(link));
    }
    expect(dangling).toEqual([]);
  });

  it("refuses a release stage carrying a dangling symlink", async () => {
    const root = await syntheticRoot();
    await plantReleaseOps(root);
    const stage = path.join(root, "stage");
    await stageStandalone({ root, stage });
    await stageFileSet({ root, destination: path.join(stage, "ops"), files: RELEASE_OPS_FILES });
    const releaseJson = { schema: 1, version: "0.9.0", commit, buildTime: builtAt, minUpgradeFrom: "0.9.0" };
    await writeFile(path.join(stage, "release.json"), `${JSON.stringify(releaseJson, null, 2)}\n`);
    await symlink("./nowhere-real", path.join(stage, "node_modules", "ghost"));
    await expect(verifyStage(stage, { layout: "release" })).rejects.toThrow(
      "release stage carries dangling symlinks",
    );
  });

  it("refuses a release stage carrying a native module it did not prune", async () => {
    const root = await syntheticRoot();
    await plantReleaseOps(root);
    const stage = path.join(root, "stage");
    await stageStandalone({ root, stage });
    await stageFileSet({ root, destination: path.join(stage, "ops"), files: RELEASE_OPS_FILES });
    const foreign = path.join(stage, "node_modules", "pkg");
    await writeFile(path.join(foreign, "grinder.node"), "elf\n");
    const releaseJson = { schema: 1, version: "0.9.0", commit, buildTime: builtAt, minUpgradeFrom: "0.9.0" };
    await writeFile(path.join(stage, "release.json"), `${JSON.stringify(releaseJson, null, 2)}\n`);
    await expect(verifyStage(stage, { layout: "release" })).rejects.toThrow("release stage carries native modules");
  });
});
