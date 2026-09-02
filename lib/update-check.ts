// Once a day the server asks GitHub for the latest release and remembers the
// answer in a small state file. Nothing about the instance travels except a
// user agent naming Brain and its version. Off with BRAIN_UPDATE_CHECK=off;
// never on under NODE_ENV=test. The cache file mirrors lib/auth.ts's
// session-epoch file: env override → /var/lib/brain/update → tmpdir in dev,
// dir 0700, file 0600, temp-then-rename.

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_URL, RELEASES_LATEST_API } from "./project";
import { readReleaseInfo } from "./release-info";

export interface LatestRelease {
  version: string;
  url: string;
  publishedAt: string;
}

export interface UpdateState {
  schema: 1;
  checkedAt: string;
  latest: LatestRelease | null;
  error: string | null;
}

/** The slice of the environment this module reads. `process.env` fits it;
 *  tests pass a literal. A narrower type than NodeJS.ProcessEnv because Next
 *  declares NODE_ENV there as required, which a literal without it fails. */
export interface UpdateCheckEnv {
  NODE_ENV?: string;
  BRAIN_UPDATE_CHECK?: string;
  BRAIN_UPDATE_STATE_DIR?: string;
}

export const UPDATE_STATE_FILE = "update-check.json";
export const UPDATE_CACHE_TTL_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 5_000;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

// scripts/check-env-docs.mjs counts a read only when it is spelled
// `process.env.NAME`, so the default environment names every variable this
// module looks at. Tests inject a substitute instead.
function processEnv(): UpdateCheckEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    BRAIN_UPDATE_CHECK: process.env.BRAIN_UPDATE_CHECK,
    BRAIN_UPDATE_STATE_DIR: process.env.BRAIN_UPDATE_STATE_DIR,
  };
}

export function updateCheckEnabled(env: UpdateCheckEnv = processEnv()): boolean {
  if (env.NODE_ENV === "test") return false;
  return (env.BRAIN_UPDATE_CHECK ?? "").trim().toLowerCase() !== "off";
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(pa[i]);
    const y = Number(pb[i]);
    if (x !== y) return x > y ? 1 : -1;
  }
  const preA = pa[4] !== undefined;
  const preB = pb[4] !== undefined;
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

export function updateStateDirectory(env: UpdateCheckEnv = processEnv()): string {
  if (env.BRAIN_UPDATE_STATE_DIR) return env.BRAIN_UPDATE_STATE_DIR;
  if (env.NODE_ENV === "production") return "/var/lib/brain/update";
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-update-${process.getuid?.() ?? "dev"}`,
  );
}

function isState(value: unknown): value is UpdateState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1 || typeof v.checkedAt !== "string") return false;
  if (v.error !== null && typeof v.error !== "string") return false;
  if (v.latest === null) return true;
  if (typeof v.latest !== "object" || v.latest === null) return false;
  const l = v.latest as Record<string, unknown>;
  return typeof l.version === "string" && typeof l.url === "string" && typeof l.publishedAt === "string";
}

export async function readUpdateState(dir = updateStateDirectory()): Promise<UpdateState | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, UPDATE_STATE_FILE), "utf8"));
    return isState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeUpdateState(dir: string, state: UpdateState): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, UPDATE_STATE_FILE);
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await fs.writeFile(temp, JSON.stringify(state) + "\n", { mode: 0o600 });
  await fs.rename(temp, file);
}

function parseLatest(value: unknown): LatestRelease | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true) return null;
  if (typeof r.tag_name !== "string" || typeof r.html_url !== "string" || typeof r.published_at !== "string") return null;
  const version = r.tag_name.replace(/^v/, "");
  if (!SEMVER.test(version) || SEMVER.exec(version)?.[4] !== undefined) return null;
  if (!r.html_url.startsWith("https://github.com/")) return null;
  if (Number.isNaN(Date.parse(r.published_at))) return null;
  return { version, url: r.html_url, publishedAt: r.published_at };
}

export async function runUpdateCheck(options: {
  dir?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  userAgent?: string;
} = {}): Promise<UpdateState> {
  const dir = options.dir ?? updateStateDirectory();
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const previous = await readUpdateState(dir);
  const userAgent = options.userAgent ?? `brain/${(await readReleaseInfo()).version ?? "dev"} (+${PROJECT_URL})`;

  let latest: LatestRelease | null = previous?.latest ?? null;
  let error: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(RELEASES_LATEST_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": userAgent },
      signal: controller.signal,
    });
    if (!response.ok) {
      error = `http_${response.status}`;
    } else {
      const parsed = parseLatest((await response.json()) as unknown);
      if (parsed) latest = parsed;
      else error = "invalid";
    }
  } catch {
    error = "network";
  } finally {
    clearTimeout(timer);
  }

  const state: UpdateState = { schema: 1, checkedAt: now().toISOString(), latest, error };
  await writeUpdateState(dir, state);
  return state;
}

/** An answer younger than the cache TTL. A checkedAt in the future, or one
 *  that does not parse, counts as stale so the next check settles it. */
function isFresh(state: UpdateState | null, nowMs: number): boolean {
  if (!state) return false;
  const age = nowMs - Date.parse(state.checkedAt);
  return age >= 0 && age < UPDATE_CACHE_TTL_MS;
}

/** Boot-time scheduler: one check shortly after start, then daily. The boot
 *  check is skipped while the answer on disk is fresh, so a restart inside
 *  the cache window does not ask GitHub again. Timers are unref'd so they
 *  never hold the process open. Returns a disposer. */
export function scheduleUpdateChecks(options: { initialDelayMs?: number; intervalMs?: number } = {}): () => void {
  if (!updateCheckEnabled()) return () => {};
  const initialDelayMs = options.initialDelayMs ?? 30_000;
  const intervalMs = options.intervalMs ?? UPDATE_CACHE_TTL_MS;
  const run = () => {
    runUpdateCheck().catch((cause: unknown) => {
      console.warn(`[brain/update] check failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  };
  let disposed = false;
  let interval: NodeJS.Timeout | null = null;
  const first = setTimeout(() => {
    // readUpdateState never rejects: a missing or corrupt file reads as null
    void readUpdateState().then((previous) => {
      if (disposed) return;
      if (!isFresh(previous, Date.now())) run();
      interval = setInterval(run, intervalMs);
      interval.unref();
    });
  }, initialDelayMs);
  first.unref();
  return () => {
    disposed = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
