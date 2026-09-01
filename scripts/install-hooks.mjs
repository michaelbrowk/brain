#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Runs from `prepare`, which also runs wherever the tree arrives without its
// history — a source tarball, a container build context. A missing checkout is
// not an error.
try {
  await execFileAsync("git", ["rev-parse", "--git-dir"]);
} catch {
  process.exit(0);
}
await execFileAsync("git", ["config", "core.hooksPath", "hooks"]);
