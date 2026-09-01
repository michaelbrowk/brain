#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// An optional list of words a push must not carry, read from outside the
// repository so it is never published with it. No list is the ordinary case:
// with nothing to read the scan has no opinion and the push goes through.
export const DEFAULT_WORD_LIST = "../brain-word-list.txt";

// Resolved beside the MAIN checkout rather than beside whichever worktree the
// push comes from, so every worktree of a clone reads the same list instead of
// one of them finding it and the rest silently finding nothing. The shared git
// directory is the same from all of them, and its parent is the main tree. A
// tree without history has no common directory, and there the current tree is
// the only answer available.
export async function mainWorkTree(root) {
  const common = await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root },
  ).catch(() => null);
  const directory = common?.stdout.trim();
  if (!directory) return root;
  return path.dirname(directory);
}

// An explicit path answers to the caller and resolves against the tree it was
// given. Only the default reaches for the main checkout.
export async function resolveWordListPath(root, wordListPath) {
  if (wordListPath) return path.resolve(root, wordListPath);
  return path.resolve(await mainWorkTree(root), DEFAULT_WORD_LIST);
}

// The tree this repository is exported FROM carries a role marker; the trees it
// is exported TO do not. That is the whole difference between "no list, no
// opinion" and "the list is missing and somebody should know".
export async function publicationRole(root) {
  return readFile(path.resolve(root, ".publication-role"), "utf8")
    .then((body) => body.trim())
    .catch(() => "");
}

export async function loadWordList(file) {
  const body = await readFile(file, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (body === null) return null;
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function escape(word) {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanText(text, words) {
  const lines = text.split("\n");
  const hits = [];
  for (const word of words) {
    const pattern = new RegExp(`\\b${escape(word)}\\b`, "i");
    lines.forEach((line, index) => {
      if (pattern.test(line)) hits.push({ word, line: index + 1 });
    });
  }
  return hits;
}

export async function scanRange(root, { from, to, wordListPath }) {
  const words = await loadWordList(await resolveWordListPath(root, wordListPath));
  if (words === null) return null;
  const { stdout } = await execFileAsync("git", ["diff", "--unified=0", `${from}..${to}`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  return scanText(stdout, words).map((hit) => ({ ...hit, file: "the pushed range" }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [from, to] = process.argv.slice(2);
  const hits = await scanRange(process.cwd(), {
    from: from || "origin/main",
    to: to || "HEAD",
    wordListPath: process.env.BRAIN_WORD_LIST,
  });
  if (hits === null) {
    // Silence is right for a clone that never had a list. It is wrong for a
    // checkout marked by .publication-role as the one exported from: there a
    // missing list means the guard was turned off rather than deliberately
    // absent, and a guard that is silent by design and absent by accident is
    // no guard.
    if ((await publicationRole(process.cwd())) === "archive") {
      const expected = await resolveWordListPath(process.cwd(), process.env.BRAIN_WORD_LIST);
      console.error(`no word list at ${expected}, and this checkout is the one that should have one.`);
      console.error("restore it, point BRAIN_WORD_LIST at it, or push with --no-verify if you meant to.");
      process.exit(1);
    }
    process.exit(0);
  }
  if (hits.length > 0) {
    console.error("the push carries words the word list forbids:");
    for (const hit of hits) console.error(`  ${hit.word} (diff line ${hit.line})`);
    console.error("remove them, or push with --no-verify if this is a false positive.");
    process.exit(1);
  }
}
