#!/usr/bin/env node
// scripts/release.mjs — pnpm release <version>
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compareSemver, parseSemver } from "./release-version.mjs";

const execFileAsync = promisify(execFile);

async function git(args, { cwd, env }) {
  const { stdout } = await execFileAsync("git", args, { cwd, env });
  return stdout.trim();
}

export async function assertReleasable({
  cwd,
  version,
  remote = "origin",
  branch = "main",
  env = process.env,
}) {
  parseSemver(version);
  const tag = `v${version}`;
  if (await git(["status", "--porcelain", "--untracked-files=normal"], { cwd, env })) {
    throw new Error("refusing to release a dirty working tree");
  }
  const current = await git(["branch", "--show-current"], { cwd, env });
  if (current !== branch) {
    throw new Error(`refusing to release from ${current || "a detached HEAD"}; check out ${branch}`);
  }
  await git(["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], {
    cwd,
    env,
  });
  const head = await git(["rev-parse", "--verify", "HEAD"], { cwd, env });
  const remoteHead = await git(["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`], {
    cwd,
    env,
  });
  try {
    await git(["merge-base", "--is-ancestor", remoteHead, head], { cwd, env });
  } catch {
    throw new Error(`refusing to release: ${branch} is behind ${remote}/${branch}`);
  }
  if (await git(["ls-remote", "--tags", remote, `refs/tags/${tag}`], { cwd, env })) {
    throw new Error(`refusing to release: ${tag} already exists on ${remote}`);
  }
  if (await git(["tag", "--list", tag], { cwd, env })) {
    throw new Error(`refusing to release: ${tag} already exists locally`);
  }
  const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  if (compareSemver(version, pkg.version) <= 0) {
    throw new Error(`refusing to release ${version}: package.json is already at ${pkg.version}`);
  }
  return { head, tag, previousVersion: pkg.version };
}

export async function cutRelease({
  cwd,
  version,
  remote = "origin",
  branch = "main",
  env = process.env,
}) {
  const { tag } = await assertReleasable({ cwd, version, remote, branch, env });
  const packagePath = path.join(cwd, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  pkg.version = version;
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  await git(["add", "package.json"], { cwd, env });
  await git(["commit", "--quiet", "-m", `release: ${tag}`], { cwd, env });
  await git(["tag", "-a", tag, "-m", `release: ${tag}`], { cwd, env });
  try {
    await git(["push", "--quiet", "--atomic", remote, `refs/heads/${branch}`, `refs/tags/${tag}`], {
      cwd,
      env,
    });
  } catch (error) {
    process.stderr.write(
      `the atomic push failed; the release commit and ${tag} exist only locally\n` +
        `clean up with: git tag -d ${tag} && git reset --hard ${remote}/${branch}\n`,
    );
    throw error;
  }
  return { tag, commit: await git(["rev-parse", "--verify", "HEAD"], { cwd, env }) };
}

async function main() {
  const [version, extra] = process.argv.slice(2);
  if (!version || extra) throw new Error("usage: pnpm release <version>");
  const { tag, commit } = await cutRelease({ cwd: process.cwd(), version });
  process.stdout.write(`${tag} -> ${commit}\nwatch: gh run list --workflow release.yml --limit 1\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
