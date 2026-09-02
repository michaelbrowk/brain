import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMMIT_DELAY_MS, headCommit } from "./git";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-git-head-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd: root, encoding: "utf8" },
  ).trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("headCommit", () => {
  it("is null for a folder that is not a repository", async () => {
    const root = await tempRoot();
    expect(await headCommit(root)).toBeNull();
  });

  it("is null for a repository without a commit", async () => {
    const root = await tempRoot();
    git(root, "init", "-q");
    expect(await headCommit(root)).toBeNull();
  });

  it("returns the hash and author time of HEAD", async () => {
    const root = await tempRoot();
    git(root, "init", "-q");
    await fs.writeFile(path.join(root, "index.md"), "# hello\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "first");
    const head = await headCommit(root);
    expect(head?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head?.hash).toBe(git(root, "rev-parse", "HEAD"));
    expect(Number.isNaN(Date.parse(head?.at ?? ""))).toBe(false);
  });
});

describe("COMMIT_DELAY_MS", () => {
  it("is the four seconds the README promises", () => {
    expect(COMMIT_DELAY_MS).toBe(4_000);
  });
});
