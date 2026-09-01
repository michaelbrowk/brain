// Proves a shell.tsx refactor changed no DOM.
//
// Renders the six Shell DOM-contract states (components/shell-dom-contract.test.tsx)
// twice — once from a base ref checked out into a throwaway worktree, once
// from the current working tree — with the SAME harness file (the head copy is
// installed into the base worktree, so the instrument never differs), then
// diffs the two outputs. Exit 0 on "0 changed lines", 1 otherwise.
//
//   node scripts/shell-dom-diff.mjs              # base = origin/main
//   node scripts/shell-dom-diff.mjs <ref>        # any commit-ish
//   node scripts/shell-dom-diff.mjs <ref> --keep # leave the temp dir for inspection
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = [
  "components/shell-dom-contract.test.tsx",
  "test/framer-motion-mock.ts",
];

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const keep = process.argv.includes("--keep");
const baseRef = args[0] ?? "origin/main";

function git(cmdArgs, options = {}) {
  const r = spawnSync("git", cmdArgs, { cwd: repo, encoding: "utf8", ...options });
  if (r.status !== 0 && !options.allowFailure) {
    throw new Error(`git ${cmdArgs.join(" ")} failed:\n${r.stderr}`);
  }
  return r;
}

const baseSha = git(["rev-parse", "--verify", `${baseRef}^{commit}`]).stdout.trim();
const headSha = git(["rev-parse", "HEAD"]).stdout.trim();
const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim();

// realpath: macOS hands out /var/folders/…, a symlink Vite refuses to serve from
const tmp = mkdtempSync(path.join(realpathSync(os.tmpdir()), "shell-dom-diff-"));
const baseDir = path.join(tmp, "base");
const outBase = path.join(tmp, "out", "base");
const outHead = path.join(tmp, "out", "head");

function render(cwd, outDir, label) {
  mkdirSync(outDir, { recursive: true });
  const r = spawnSync(
    process.execPath,
    [
      path.join(repo, "node_modules", "vitest", "vitest.mjs"),
      "run",
      HARNESS[0],
      "--root",
      cwd,
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        SHELL_DOM_CONTRACT: "write",
        SHELL_DOM_CONTRACT_DIR: outDir,
      },
    },
  );
  if (r.status !== 0) {
    throw new Error(`${label}: harness failed\n${r.stdout}\n${r.stderr}`);
  }
}

try {
  git(["worktree", "add", "--detach", baseDir, baseSha]);
  symlinkSync(path.join(repo, "node_modules"), path.join(baseDir, "node_modules"));
  for (const file of HARNESS) {
    const target = path.join(baseDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repo, file), target);
  }

  console.log(`base  ${baseSha.slice(0, 7)} (${baseRef})`);
  console.log(`head  ${headSha.slice(0, 7)}${dirty ? " + uncommitted changes" : ""}`);

  render(baseDir, outBase, "base");
  render(repo, outHead, "head");

  // relative paths keep the report readable: `base/shell-hub.html`
  const diffCwd = { cwd: path.join(tmp, "out"), allowFailure: true };
  const stat = git(["diff", "--no-index", "--stat", "base", "head"], diffCwd);
  const changed = stat.status !== 0;
  if (changed) {
    const full = git(["diff", "--no-index", "base", "head"], diffCwd);
    console.log(full.stdout);
    console.log(stat.stdout.trimEnd());
    console.log("\nshell-dom-diff: DOM CHANGED");
  } else {
    const states = existsSync(outHead)
      ? spawnSync("ls", [outHead], { encoding: "utf8" }).stdout.trim().split("\n")
      : [];
    for (const state of states) console.log(`  ${state}: 0 changed lines`);
    console.log(`\nshell-dom-diff: 0 changed lines across ${states.length} states`);
  }
  process.exitCode = changed ? 1 : 0;
} finally {
  git(["worktree", "remove", "--force", baseDir], { allowFailure: true });
  if (keep) console.log(`outputs kept in ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
