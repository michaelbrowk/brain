// scripts/release.test.ts
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReleasable, cutRelease } from "./release.mjs";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Brain Test",
  GIT_AUTHOR_EMAIL: "brain-test@example.invalid",
  GIT_COMMITTER_NAME: "Brain Test",
  GIT_COMMITTER_EMAIL: "brain-test@example.invalid",
};
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", args, { cwd, env })).stdout.trim();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<{ origin: string; clone: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-release-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const clone = path.join(root, "clone");
  await execFileAsync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  await execFileAsync("git", ["clone", "-q", origin, clone], { env });
  await writeFile(
    path.join(clone, "package.json"),
    `${JSON.stringify({ name: "brain", version: "0.1.0" }, null, 2)}\n`,
  );
  await git(clone, "add", "package.json");
  await git(clone, "commit", "-q", "-m", "seed");
  await git(clone, "push", "-q", "origin", "main");
  return { origin, clone };
}

describe("pnpm release", () => {
  it("refuses a dirty tree, another branch, a stale main, an existing tag, and a non-increasing version", async () => {
    const { origin, clone } = await repository();
    await writeFile(path.join(clone, "dirty.txt"), "x\n");
    await expect(assertReleasable({ cwd: clone, version: "0.9.0", env })).rejects.toThrow(
      "dirty working tree",
    );
    await rm(path.join(clone, "dirty.txt"));

    await git(clone, "checkout", "-q", "-b", "feature");
    await expect(assertReleasable({ cwd: clone, version: "0.9.0", env })).rejects.toThrow(
      "check out main",
    );
    await git(clone, "checkout", "-q", "main");

    const other = path.join(path.dirname(clone), "other");
    await execFileAsync("git", ["clone", "-q", origin, other], { env });
    await writeFile(path.join(other, "later.txt"), "later\n");
    await git(other, "add", "later.txt");
    await git(other, "commit", "-q", "-m", "later");
    await git(other, "push", "-q", "origin", "main");
    await expect(assertReleasable({ cwd: clone, version: "0.9.0", env })).rejects.toThrow(
      "main is behind origin/main",
    );
    await git(clone, "pull", "-q", "--ff-only", "origin", "main");

    await git(other, "tag", "-a", "v0.9.0", "-m", "taken");
    await git(other, "push", "-q", "origin", "v0.9.0");
    await expect(assertReleasable({ cwd: clone, version: "0.9.0", env })).rejects.toThrow(
      "v0.9.0 already exists on origin",
    );

    await expect(assertReleasable({ cwd: clone, version: "0.1.0", env })).rejects.toThrow(
      "package.json is already at 0.1.0",
    );
    await expect(assertReleasable({ cwd: clone, version: "0.9", env })).rejects.toThrow(
      "invalid release version",
    );
  });

  it("writes the version, commits, tags, and pushes commit and tag atomically", async () => {
    const { origin, clone } = await repository();
    const result = await cutRelease({ cwd: clone, version: "0.9.0-rc.1", env });
    expect(result.tag).toBe("v0.9.0-rc.1");
    expect(JSON.parse(await readFile(path.join(clone, "package.json"), "utf8")).version).toBe(
      "0.9.0-rc.1",
    );
    expect(await git(clone, "log", "-1", "--format=%s")).toBe("release: v0.9.0-rc.1");
    expect(await git(clone, "status", "--porcelain")).toBe("");
    expect(await git(origin, "rev-parse", "refs/heads/main")).toBe(result.commit);
    expect(await git(origin, "rev-list", "-n", "1", "refs/tags/v0.9.0-rc.1")).toBe(result.commit);
    expect(await git(origin, "cat-file", "-t", "refs/tags/v0.9.0-rc.1")).toBe("tag");
  });

  it("names the local cleanup when the atomic push is rejected", async () => {
    const { origin, clone } = await repository();
    await writeFile(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(cutRelease({ cwd: clone, version: "0.9.0", env })).rejects.toThrow();
      const hint = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(hint).toContain("git tag -d v0.9.0");
      expect(hint).toContain("git reset --hard origin/main");
    } finally {
      stderr.mockRestore();
    }
    expect(await git(clone, "tag", "--list", "v0.9.0")).toBe("v0.9.0");
  });
});
