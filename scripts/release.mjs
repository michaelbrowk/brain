#!/usr/bin/env node
// scripts/release.mjs — pnpm release <version>
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compareSemver, isPrerelease, parseSemver } from "./release-version.mjs";

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
  // A stable release is read by strangers on the releases page and by the
  // landing, which renders the body as-is. The generated commit list is not
  // that text, so the notes are written before the tag exists, not after.
  if (!isPrerelease(version)) {
    const notes = path.join(cwd, "docs", "release-notes", `${version}.md`);
    const text = await readFile(notes, "utf8").catch(() => null);
    if (text === null || text.trim().length === 0) {
      throw new Error(
        `refusing to release ${version}: write docs/release-notes/${version}.md first, ` +
          "in plain language, saying what changed for the person using Brain",
      );
    }
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
  // The quickstart on the site downloads this compose file and installs
  // whatever tag it names. Left to a human it drifts: it sat on 0.9.0 while
  // three releases shipped, so every new install got the bugs those releases
  // fixed. A prerelease is not what a stranger should land on, so it does not
  // move the tag.
  if (!isPrerelease(version)) {
    const composePath = path.join(cwd, "ops", "docker", "docker-compose.yml");
    const compose = await readFile(composePath, "utf8");
    const pinned = compose.replace(
      /image: ghcr\.io\/michaelbrowk\/brain:[^\s]+/g,
      `image: ghcr.io/michaelbrowk/brain:${version}`,
    );
    if (pinned !== compose) {
      await writeFile(composePath, pinned);
      await git(["add", "ops/docker/docker-compose.yml"], { cwd, env });
    }
  }
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
