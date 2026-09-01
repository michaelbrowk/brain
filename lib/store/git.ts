import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parsePage } from "./frontmatter";

/** Debounced git snapshot of the notes dir — every save becomes a commit, so
 *  the folder carries its own history/undo/backup. Saves remain independent
 *  from git, but failures are always written to the process error log. */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const pending = new Set<string>();
const deferred = new Set<string>();
const barriers = new Map<string, number>();
const running = new Map<string, Promise<void>>();
const failures = new Map<string, Error>();
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    const detail = stderr.trim().slice(0, 1_000);
    super(
      `git ${args[0] ?? "command"} failed${code === null ? "" : ` (${code})`}` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "GitCommandError";
  }
}

/** Run git with captured output and explicit exit-code handling. */
function runGit(
  root: string,
  args: string[],
  allowedCodes: readonly number[] = [0],
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "git",
      [
        "-c",
        `safe.directory=${root}`,
        "-c",
        "user.name=Brain",
        "-c",
        "user.email=brain@local",
        ...args,
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;

    p.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        overflow = true;
        p.kill();
        return;
      }
      stdout += chunk.toString();
    });
    p.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr += chunk.toString();
    });
    p.on("error", (error) => {
      reject(
        new GitCommandError(
          args,
          null,
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
    p.on("close", (code) => {
      if (overflow) {
        reject(
          new GitCommandError(
            args,
            code,
            `stdout exceeded ${MAX_STDOUT_BYTES} bytes`,
          ),
        );
        return;
      }
      const normalizedCode = code ?? -1;
      if (!allowedCodes.includes(normalizedCode)) {
        reject(new GitCommandError(args, code, stderr));
        return;
      }
      resolve({ code: normalizedCode, stdout, stderr });
    });
  });
}

function report(root: string, operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[brain/git] ${operation} failed in ${root}: ${message}`);
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.promises.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Fail readiness unless the notes root is a usable, writable Git repository
 *  with a committed HEAD. The common-dir probe matters for linked worktrees and
 *  for the PM2 -> dedicated-user migration: note files can be writable while a
 *  root-owned .git still makes every snapshot fail. */
export async function assertGitReady(root: string): Promise<void> {
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.stdout.trim() !== "true") {
    throw new Error("notes root is not a Git worktree");
  }
  await runGit(root, ["rev-parse", "--verify", "HEAD"]);

  const result = await runGit(root, ["rev-parse", "--git-common-dir"]);
  const rawCommonDir = result.stdout.trim();
  if (!rawCommonDir || rawCommonDir.includes("\0")) {
    throw new Error("Git common directory is invalid");
  }
  const commonDir = await fs.promises.realpath(
    path.resolve(/* turbopackIgnore: true */ root, rawCommonDir),
  );
  const probe = path.join(
    commonDir,
    `.brain-readiness-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
  const expected = `brain-git-readiness ${new Date().toISOString()}\n`;
  let created = false;
  try {
    const handle = await fs.promises.open(probe, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(expected, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await fs.promises.readFile(probe, "utf8")) !== expected) {
      throw new Error("Git common directory readiness probe mismatch");
    }
    await fs.promises.unlink(probe);
    created = false;
    await syncDirectory(commonDir);
  } finally {
    if (created) {
      await fs.promises.unlink(probe).catch(() => undefined);
      await syncDirectory(commonDir).catch(() => undefined);
    }
  }
}

/** On startup, finish any snapshot whose 4-second timer was interrupted by a
 * process restart. This attempt is awaited rather than debounced: deep health
 * must never turn green before the first post-restart snapshot has either
 * succeeded or recorded a sticky failure. */
export async function scheduleDirtyCommit(root: string): Promise<boolean> {
  if (!fs.existsSync(path.join(root, ".git"))) return false;
  const status = await runGit(root, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (!status.stdout.trim()) return false;
  const timer = timers.get(root);
  if (timer) {
    clearTimeout(timer);
    timers.delete(root);
  }
  const active = running.get(root);
  if (active) await active;
  try {
    await commit(root);
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    failures.set(root, normalized);
    report(root, "startup commit", normalized);
  }
  return true;
}

async function commit(root: string): Promise<void> {
  if (!fs.existsSync(path.join(root, ".git"))) {
    await runGit(root, ["init", "-q"]);
  }
  await runGit(root, ["add", "-A"]);
  const staged = await runGit(root, ["diff", "--cached", "--quiet"], [0, 1]);
  if (staged.code === 1) {
    await runGit(root, [
      "commit",
      "-q",
      "-m",
      `auto ${new Date().toISOString()}`,
    ]);
  }
  failures.delete(root);
}

function startCommit(root: string): void {
  if ((barriers.get(root) ?? 0) > 0) {
    deferred.add(root);
    return;
  }
  if (running.has(root)) {
    pending.add(root);
    return;
  }
  const task = commit(root)
    .catch((error) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      failures.set(root, normalized);
      report(root, "commit", normalized);
    })
    .finally(() => {
      running.delete(root);
      const wasPending = pending.delete(root);
      const wasDeferred = deferred.delete(root);
      if (wasPending || wasDeferred) scheduleCommit(root);
    });
  running.set(root, task);
}

/** Surface a background snapshot failure to deep readiness. A later successful
 * snapshot clears the sticky failure, so the service can heal without restart. */
export async function assertGitSnapshotHealthy(root: string): Promise<void> {
  const active = running.get(root);
  if (active) await active;
  const failure = failures.get(root);
  if (failure) {
    throw new Error("Git history snapshot is unhealthy", { cause: failure });
  }
}

/** Pause Git snapshots around a multi-file filesystem transaction. The barrier
 * is installed synchronously, cancels a pending debounce timer, then waits for
 * any already-running `git add/commit` to finish. Calls to scheduleCommit while
 * held are remembered and replayed only after the final holder releases. */
export async function beginGitSnapshotBarrier(
  root: string,
): Promise<() => void> {
  barriers.set(root, (barriers.get(root) ?? 0) + 1);
  const timer = timers.get(root);
  if (timer) {
    clearTimeout(timer);
    timers.delete(root);
    deferred.add(root);
  }
  const active = running.get(root);
  if (active) await active;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (barriers.get(root) ?? 1) - 1;
    if (remaining > 0) {
      barriers.set(root, remaining);
      return;
    }
    barriers.delete(root);
    if (deferred.delete(root) || pending.delete(root)) scheduleCommit(root);
  };
}

/** A successfully reconciled startup is equivalent to a process restart for an
 * abort barrier intentionally held by a poisoned Store instance. */
export function resumeGitSnapshotsAfterRecovery(root: string): void {
  barriers.delete(root);
  const wasDeferred = deferred.delete(root);
  const wasPending = pending.delete(root);
  if (wasDeferred || wasPending) scheduleCommit(root);
}

export interface Version {
  sha: string;
  date: string;
  msg: string;
}

/** Commits that touched a file, newest first (capped). --follow keeps history
 *  visible after a page folder is moved in the hierarchy. */
export async function logForPath(root: string, rel: string): Promise<Version[]> {
  if (!fs.existsSync(path.join(root, ".git"))) return [];
  try {
    const { stdout } = await runGit(root, [
      "log",
      "--follow",
      "--format=%H%x00%aI%x00%s",
      "-n",
      "60",
      "--",
      rel,
    ]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, date, msg] = line.split("\0");
        return { sha, date, msg };
      });
  } catch (error) {
    report(root, "history", error);
    return [];
  }
}

async function showRevisionPath(
  root: string,
  sha: string,
  rel: string,
): Promise<string> {
  const result = await runGit(root, ["show", `${sha}:${rel}`], [0, 128]);
  return result.code === 0 ? result.stdout : "";
}

/** File contents at a given commit. First try today's path. If the page moved,
 *  locate its historical index.md by the immutable frontmatter id. */
export async function showPageAtRevision(
  root: string,
  sha: string,
  currentRel: string,
  pageId: string,
): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return "";
  if (!fs.existsSync(path.join(root, ".git"))) return "";
  try {
    const current = await showRevisionPath(root, sha, currentRel);
    if (current) {
      try {
        if (parsePage(current).meta.id === pageId) return current;
      } catch {
        // A malformed or different page at today's path must fall through to
        // immutable-id lookup rather than being restored into the wrong page.
      }
    }

    const grep = await runGit(
      root,
      [
        "grep",
        "-l",
        "-E",
        "-e",
        `^id: ['\"]?${escapeRegex(pageId)}['\"]?$`,
        sha,
        "--",
        ":(glob)**/index.md",
      ],
      [0, 1],
    );
    if (grep.code !== 0) return "";
    const prefix = `${sha}:`;
    for (const match of grep.stdout.split("\n").filter(Boolean)) {
      const historicalRel = match.startsWith(prefix)
        ? match.slice(prefix.length)
        : match;
      const candidate = await showRevisionPath(root, sha, historicalRel);
      if (!candidate) continue;
      try {
        if (parsePage(candidate).meta.id === pageId) return candidate;
      } catch {
        // Keep checking candidates. Body text can contain an `id:` line, so a
        // git-grep match alone is never an identity proof.
      }
    }
    return "";
  } catch (error) {
    report(root, "version read", error);
    return "";
  }
}

export function scheduleCommit(root: string): void {
  if ((barriers.get(root) ?? 0) > 0) {
    deferred.add(root);
    return;
  }
  const timer = timers.get(root);
  if (timer) clearTimeout(timer);
  timers.set(
    root,
    setTimeout(() => {
      timers.delete(root);
      startCommit(root);
    }, 4_000),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
