import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_STATE_FILE,
  compareVersions,
  readUpdateState,
  runUpdateCheck,
  scheduleUpdateChecks,
  updateCheckEnabled,
  updateStateDirectory,
} from "./update-check";

const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "brain-update-check-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// Fake timers stop the clock but not the state file's I/O, so the scheduler
// tests wait on the real clock for that I/O to land.
const realSetTimeout = globalThis.setTimeout;
const realTick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 5));
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await realTick();
  }
  throw new Error("condition not met in time");
}

const NOW = () => new Date("2026-09-02T09:00:00Z");
const release = (tag: string, extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      tag_name: tag,
      html_url: `https://github.com/x/y/releases/tag/${tag}`,
      published_at: "2026-09-01T18:00:00Z",
      draft: false,
      prerelease: false,
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

describe("updateCheckEnabled", () => {
  it("is on by default and off with BRAIN_UPDATE_CHECK=off", () => {
    expect(updateCheckEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(updateCheckEnabled({ NODE_ENV: "production", BRAIN_UPDATE_CHECK: "off" })).toBe(false);
    expect(updateCheckEnabled({ NODE_ENV: "production", BRAIN_UPDATE_CHECK: " OFF " })).toBe(false);
    expect(updateCheckEnabled({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("compareVersions", () => {
  it("orders numerically and puts prereleases below their base", () => {
    expect(compareVersions("0.9.1", "0.9.0")).toBe(1);
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
    expect(compareVersions("0.9.1-rc.1", "0.9.1")).toBe(-1);
    expect(compareVersions("0.9.1-rc.1", "0.9.0")).toBe(1);
  });
});

describe("updateStateDirectory", () => {
  it("prefers the env override, then /var/lib/brain in production, then tmpdir", () => {
    expect(updateStateDirectory({ BRAIN_UPDATE_STATE_DIR: "/x" })).toBe("/x");
    expect(updateStateDirectory({ NODE_ENV: "production" })).toBe("/var/lib/brain/update");
    expect(updateStateDirectory({ NODE_ENV: "development" }).startsWith(os.tmpdir())).toBe(true);
  });
});

describe("runUpdateCheck", () => {
  it("records the latest release and writes the state file with mode 0600", async () => {
    const d = await dir();
    const fetchMock = vi.fn(async () => release("v0.9.1"));
    const state = await runUpdateCheck({
      dir: d,
      fetch: fetchMock as unknown as typeof fetch,
      now: NOW,
    });
    expect(state).toEqual({
      schema: 1,
      checkedAt: "2026-09-02T09:00:00.000Z",
      latest: {
        version: "0.9.1",
        url: "https://github.com/x/y/releases/tag/v0.9.1",
        publishedAt: "2026-09-01T18:00:00Z",
      },
      error: null,
    });
    const file = path.join(d, UPDATE_STATE_FILE);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await readUpdateState(d)).toEqual(state);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/michaelbrowk/brain/releases/latest");
    expect((init.headers as Record<string, string>)["user-agent"]).toMatch(/^brain\//);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the previous latest and records an error code when GitHub fails", async () => {
    const d = await dir();
    await runUpdateCheck({
      dir: d,
      fetch: (async () => release("v0.9.1")) as unknown as typeof fetch,
      now: NOW,
    });
    const failed = await runUpdateCheck({
      dir: d,
      fetch: (async () => new Response("", { status: 503 })) as unknown as typeof fetch,
      now: NOW,
    });
    expect(failed.latest?.version).toBe("0.9.1");
    expect(failed.error).toBe("http_503");
    const thrown = await runUpdateCheck({
      dir: d,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
      now: NOW,
    });
    expect(thrown.latest?.version).toBe("0.9.1");
    expect(thrown.error).toBe("network");
  });

  it("rejects a malformed or prerelease answer", async () => {
    const d = await dir();
    const bad = await runUpdateCheck({
      dir: d,
      fetch: (async () => release("nonsense")) as unknown as typeof fetch,
      now: NOW,
    });
    expect(bad.latest).toBeNull();
    expect(bad.error).toBe("invalid");
    const pre = await runUpdateCheck({
      dir: d,
      fetch: (async () => release("v0.9.2-rc.1", { prerelease: true })) as unknown as typeof fetch,
      now: NOW,
    });
    expect(pre.latest).toBeNull();
    expect(pre.error).toBe("invalid");
  });

  it("readUpdateState is null for a missing or corrupt file", async () => {
    const d = await dir();
    expect(await readUpdateState(d)).toBeNull();
    await fs.writeFile(path.join(d, UPDATE_STATE_FILE), "{nope");
    expect(await readUpdateState(d)).toBeNull();
  });
});

describe("scheduleUpdateChecks", () => {
  it("does nothing when the check is off", () => {
    vi.stubEnv("BRAIN_UPDATE_CHECK", "off");
    vi.useFakeTimers();
    const dispose = scheduleUpdateChecks({ initialDelayMs: 10, intervalMs: 20 });
    expect(vi.getTimerCount()).toBe(0);
    dispose();
  });

  /** Boots the scheduler as the app would: nothing injected, the state dir
   *  and NODE_ENV come from the environment, fetch is the global. */
  async function boot(checkedAt: string) {
    const d = await dir();
    await fs.writeFile(
      path.join(d, UPDATE_STATE_FILE),
      JSON.stringify({ schema: 1, checkedAt, latest: null, error: null }),
    );
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BRAIN_UPDATE_CHECK", undefined);
    vi.stubEnv("BRAIN_UPDATE_STATE_DIR", d);
    const fetchMock = vi.fn(async () => release("v0.9.1"));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const dispose = scheduleUpdateChecks({ initialDelayMs: 10, intervalMs: 1_000_000 });
    await vi.advanceTimersByTimeAsync(10);
    // the daily interval is armed once the state file has been read
    await eventually(() => vi.getTimerCount() >= 1);
    return { fetchMock, dispose };
  }

  it("skips the boot check while the cached answer is fresh and still runs daily", async () => {
    const { fetchMock, dispose } = await boot(new Date().toISOString());
    // a boot check that had started would have reached fetch by now
    for (let i = 0; i < 20; i += 1) await realTick();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000_000);
    await eventually(() => fetchMock.mock.calls.length === 1);
    dispose();
  });

  it("runs the boot check when the cached answer is stale", async () => {
    const { fetchMock, dispose } = await boot(new Date(Date.now() - 2 * 86_400_000).toISOString());
    await eventually(() => fetchMock.mock.calls.length === 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    dispose();
  });
});
