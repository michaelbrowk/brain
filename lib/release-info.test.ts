import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readReleaseInfo } from "./release-info";

const dirs: string[] = [];
async function file(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-release-info-"));
  dirs.push(dir);
  const p = path.join(dir, "release.json");
  await fs.writeFile(p, contents);
  return p;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const COMMIT = "b".repeat(40);

describe("readReleaseInfo", () => {
  it("reads a release.json written by build-release", async () => {
    const p = await file(
      JSON.stringify({ schema: 1, version: "0.9.0", commit: COMMIT, buildTime: "2026-09-01T18:00:00Z", minUpgradeFrom: "0.9.0" }),
    );
    expect(await readReleaseInfo(p)).toEqual({ version: "0.9.0", commit: COMMIT, buildTime: "2026-09-01T18:00:00Z" });
  });

  it("accepts the deploy-time fields write-release-metadata adds", async () => {
    const p = await file(
      JSON.stringify({ schema: 1, version: "0.9.0", commit: COMMIT, buildTime: "2026-09-01T18:00:00Z", minUpgradeFrom: "0.9.0", release: "v0.9.0", builtAt: "2026-09-01T18:00:00Z", source: "release" }),
    );
    expect((await readReleaseInfo(p)).version).toBe("0.9.0");
  });

  it("falls back to the build env when the file is missing", async () => {
    vi.stubEnv("BRAIN_BUILD_SHA", COMMIT);
    vi.stubEnv("BRAIN_BUILD_TIME", "2026-09-01T18:00:00Z");
    expect(await readReleaseInfo(path.join(os.tmpdir(), "brain-release-info-missing", "release.json"))).toEqual({
      version: null,
      commit: COMMIT,
      buildTime: "2026-09-01T18:00:00Z",
    });
  });

  it("falls back when the file is malformed", async () => {
    vi.stubEnv("BRAIN_BUILD_SHA", COMMIT);
    const p = await file(JSON.stringify({ schema: 2, version: "nope", commit: "xyz" }));
    expect((await readReleaseInfo(p)).version).toBeNull();
    const q = await file("{not json");
    expect((await readReleaseInfo(q)).version).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)("retries a release.json the process could not read instead of caching the fallback", async () => {
    vi.stubEnv("BRAIN_BUILD_SHA", COMMIT);
    const p = await file(
      JSON.stringify({ schema: 1, version: "0.9.1", commit: COMMIT, buildTime: "2026-09-01T18:00:00Z", minUpgradeFrom: "0.9.0" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(path.dirname(p));
    // The shape of the v0.9.1 deploy: the file is there, but only root can read it.
    await fs.chmod(p, 0o000);
    expect((await readReleaseInfo()).version).toBeNull();
    await fs.chmod(p, 0o444);
    expect((await readReleaseInfo()).version).toBe("0.9.1");
    // A parsed release stays cached for the life of the process.
    await fs.rm(p);
    expect((await readReleaseInfo()).version).toBe("0.9.1");
  });
});
