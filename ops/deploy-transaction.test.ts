import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  beginTransaction,
  clearPendingRelease,
  clearTransaction,
  ensureTransaction,
  inspectRecoveryState,
  readPendingRelease,
  readTransaction,
  syncDeploymentDirectory,
  syncReleaseDirectory,
  syncReleaseTree,
  validatePendingRelease,
  validateTransaction,
  writeBootstrapMarker,
  writePendingRelease,
} from "./deploy-transaction.mjs";

const roots: string[] = [];
const commit = "a".repeat(40);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "brain-transaction-")),
  );
  roots.push(base);
  await fs.mkdir(path.join(base, "releases"));
  await fs.mkdir(path.join(base, "releases", "previous"));
  return {
    base,
    previous: path.join(base, "releases", "previous"),
    release: path.join(base, "releases", "candidate"),
  };
}

async function preparePending(values: Awaited<ReturnType<typeof fixture>>) {
  const pending = await writePendingRelease({
    base: values.base,
    release: values.release,
    commit,
  });
  await fs.mkdir(values.release);
  return pending;
}

describe("durable deploy transaction", () => {
  it("begins, reads, and clears a mode-0600 journal", async () => {
    const values = await fixture();
    await preparePending(values);
    const created = await beginTransaction({
      ...values,
      commit,
      bootstrap: false,
    });
    expect(await readTransaction(values.base)).toEqual(created);
    const metadata = await fs.stat(
      path.join(values.base, ".deploy-transaction.json"),
    );
    expect(metadata.mode & 0o777).toBe(0o600);
    await expect(
      beginTransaction({ ...values, commit, bootstrap: false }),
    ).rejects.toThrow("already exists");
    await expect(clearTransaction(values.base)).resolves.toBe(true);
    await expect(clearTransaction(values.base)).resolves.toBe(false);
  });

  it("recreates only the exact rollback transaction after uncertain unlink", async () => {
    const values = await fixture();
    await preparePending(values);
    await beginTransaction({ ...values, commit, bootstrap: true });
    await clearPendingRelease(values.base, values.release, commit);
    await clearTransaction(values.base);

    const recreated = await ensureTransaction({
      ...values,
      commit,
      bootstrap: true,
    });
    await expect(readTransaction(values.base)).resolves.toEqual(recreated);
    await expect(
      ensureTransaction({
        ...values,
        commit: "b".repeat(40),
        bootstrap: true,
      }),
    ).rejects.toThrow("does not match rollback authority");
    await expect(readTransaction(values.base)).resolves.toEqual(recreated);
  });

  it("does not mutate current when rollback authority recreation fails", async () => {
    const values = await fixture();
    await preparePending(values);
    await beginTransaction({ ...values, commit, bootstrap: true });
    const current = path.join(values.base, "current");
    await fs.symlink(values.release, current);
    await clearPendingRelease(values.base, values.release, commit);
    await clearTransaction(values.base);

    await expect(
      ensureTransaction(
        { ...values, commit, bootstrap: true },
        async () => {
          throw new Error("injected authority publication failure");
        },
      ),
    ).rejects.toThrow("injected authority publication failure");
    expect(await fs.realpath(current)).toBe(values.release);
    await expect(readTransaction(values.base)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retries a post-unlink directory barrier and reports two failures", async () => {
    const recovered = await fixture();
    await preparePending(recovered);
    await beginTransaction({ ...recovered, commit, bootstrap: false });
    let attempts = 0;
    await expect(
      clearTransaction(recovered.base, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first fsync failed");
      }),
    ).resolves.toBe(true);
    expect(attempts).toBe(2);

    const failed = await fixture();
    await preparePending(failed);
    await beginTransaction({ ...failed, commit, bootstrap: false });
    await expect(
      clearTransaction(failed.base, async () => {
        throw new Error("fsync failed");
      }),
    ).rejects.toThrow("could not be made durable");
    await expect(readTransaction(failed.base)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects release paths outside the configured base", async () => {
    const values = await fixture();
    expect(() =>
      validateTransaction(
        {
          schema: 1,
          previous: "/tmp/previous",
          release: values.release,
          commit,
          bootstrap: false,
          createdAt: "2026-07-12T10:00:00Z",
        },
        values.base,
      ),
    ).toThrow("outside the release directory");
  });

  it("durably writes, validates, and clears one exact pending release", async () => {
    const values = await fixture();
    const pending = await writePendingRelease({
      base: values.base,
      release: values.release,
      commit,
    });
    expect(await readPendingRelease(values.base)).toEqual(pending);
    expect(
      (await fs.stat(path.join(values.base, ".deploy-pending.json"))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      writePendingRelease({ base: values.base, release: values.release, commit }),
    ).rejects.toThrow("already exists");
    await expect(
      clearPendingRelease(values.base, values.release, "b".repeat(40)),
    ).rejects.toThrow("does not match");
    await expect(readPendingRelease(values.base)).resolves.toEqual(pending);
    await expect(
      clearPendingRelease(values.base, values.release, commit),
    ).resolves.toBe(true);
    await expect(readPendingRelease(values.base)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects malformed pending state and unsafe pending paths", async () => {
    const values = await fixture();
    expect(() =>
      validatePendingRelease(
        {
          schema: 1,
          release: "/tmp/candidate",
          commit,
          createdAt: "2026-07-12T10:00:00Z",
        },
        values.base,
      ),
    ).toThrow("outside the release directory");
    expect(() =>
      validatePendingRelease(
        {
          schema: 1,
          release: values.release,
          commit: "not-a-commit",
          createdAt: "2026-07-12T10:00:00Z",
        },
        values.base,
      ),
    ).toThrow("commit is invalid");

    const marker = path.join(values.base, ".deploy-pending.json");
    await fs.writeFile(marker, "{}\n", { mode: 0o644 });
    await expect(readPendingRelease(values.base)).rejects.toThrow(
      "ownership or mode is invalid",
    );
    await fs.rm(marker);
    await fs.writeFile(marker, "not-json\n", { mode: 0o600 });
    await expect(readPendingRelease(values.base)).rejects.toBeInstanceOf(
      SyntaxError,
    );
    await fs.rm(marker);
    await fs.writeFile(marker, "x".repeat(4097), { mode: 0o600 });
    await expect(readPendingRelease(values.base)).rejects.toThrow(
      "size is invalid",
    );
    await fs.rm(marker);
    await fs.symlink(values.release, marker);
    await expect(readPendingRelease(values.base)).rejects.toThrow(
      "not a regular file",
    );
  });

  it("never marks an already existing release as pending", async () => {
    const values = await fixture();
    await fs.mkdir(values.release);
    await expect(
      writePendingRelease({ base: values.base, release: values.release, commit }),
    ).rejects.toThrow("target already exists");
    await expect(readPendingRelease(values.base)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires a matching pending marker and real candidate before begin", async () => {
    const values = await fixture();
    await expect(
      beginTransaction({ ...values, commit, bootstrap: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await writePendingRelease({
      base: values.base,
      release: values.release,
      commit,
    });
    await expect(
      beginTransaction({ ...values, commit, bootstrap: false }),
    ).rejects.toThrow("candidate release is not a real directory");
    await fs.mkdir(values.release);
    await expect(
      beginTransaction({
        ...values,
        commit: "b".repeat(40),
        bootstrap: false,
      }),
    ).rejects.toThrow("does not match");
  });

  it("syncs a promoted tree before the durable journal is allowed to begin", async () => {
    const values = await fixture();
    await fs.mkdir(values.release);
    await fs.mkdir(path.join(values.release, "nested"));
    await fs.writeFile(path.join(values.release, "server.js"), "server");
    await fs.writeFile(path.join(values.release, "nested", "asset.txt"), "asset");
    await fs.symlink("asset.txt", path.join(values.release, "nested", "asset-link"));
    await expect(syncReleaseTree(values.base, values.release)).resolves.toBeUndefined();
    await expect(
      syncReleaseTree(values.base, path.join(os.tmpdir(), "outside-release")),
    ).rejects.toThrow("outside a deployment data directory");
  });

  it("syncs only a real release directory", async () => {
    const values = await fixture();
    await expect(syncReleaseDirectory(values.base)).resolves.toBeUndefined();
    const unsafeBase = await fs.mkdtemp(path.join(os.tmpdir(), "brain-transaction-"));
    roots.push(unsafeBase);
    await fs.symlink(values.base, path.join(unsafeBase, "releases"));
    await expect(syncReleaseDirectory(unsafeBase)).rejects.toThrow(
      "release directory is not a real directory",
    );
  });

  it("durably creates a mode-0600 bootstrap marker exactly once", async () => {
    const values = await fixture();
    const marker = await writeBootstrapMarker(values.base, commit);
    expect(await fs.readFile(marker, "utf8")).toBe(`${commit}\n`);
    expect((await fs.stat(marker)).mode & 0o777).toBe(0o600);
    await expect(writeBootstrapMarker(values.base, commit)).rejects.toThrow(
      "already exists",
    );
    await expect(
      writeBootstrapMarker(values.base, "not-a-commit"),
    ).rejects.toThrow("commit is invalid");
  });

  it("publishes bootstrap, pending, and journal authorities without replacement", async () => {
    const bootstrapValues = await fixture();
    const bootstrapAttempts = await Promise.allSettled([
      writeBootstrapMarker(bootstrapValues.base, "a".repeat(40)),
      writeBootstrapMarker(bootstrapValues.base, "b".repeat(40)),
    ]);
    expect(
      bootstrapAttempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      bootstrapAttempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      ["a".repeat(40) + "\n", "b".repeat(40) + "\n"],
    ).toContain(
      await fs.readFile(
        path.join(bootstrapValues.base, ".bootstrap-deploy-once"),
        "utf8",
      ),
    );

    const pendingValues = await fixture();
    const pendingAttempts = await Promise.allSettled([
      writePendingRelease({ ...pendingValues, commit }),
      writePendingRelease({ ...pendingValues, commit }),
    ]);
    expect(
      pendingAttempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      pendingAttempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    await fs.mkdir(pendingValues.release);

    const journalAttempts = await Promise.allSettled([
      beginTransaction({ ...pendingValues, commit, bootstrap: false }),
      beginTransaction({ ...pendingValues, commit, bootstrap: false }),
    ]);
    expect(
      journalAttempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      journalAttempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    await expect(readTransaction(pendingValues.base)).resolves.toMatchObject({
      previous: pendingValues.previous,
      release: pendingValues.release,
      commit,
    });
  });

  it("fails closed on inconsistent pending and journal recovery authorities", async () => {
    const activePending = await fixture();
    await writePendingRelease({ ...activePending, commit });
    await fs.mkdir(activePending.release);
    await expect(
      inspectRecoveryState(activePending.base, activePending.release),
    ).rejects.toThrow("without a transaction journal");

    const mismatch = await fixture();
    await preparePending(mismatch);
    await beginTransaction({ ...mismatch, commit, bootstrap: false });
    await clearPendingRelease(mismatch.base, mismatch.release, commit);
    await fs.writeFile(
      path.join(mismatch.base, ".deploy-pending.json"),
      JSON.stringify({
        schema: 1,
        release: mismatch.release,
        commit: "b".repeat(40),
        createdAt: "2026-07-12T10:00:00Z",
      }) + "\n",
      { mode: 0o600 },
    );
    await expect(
      inspectRecoveryState(mismatch.base, mismatch.previous),
    ).rejects.toThrow("disagrees with transaction journal");

    const outside = await fixture();
    await preparePending(outside);
    await beginTransaction({ ...outside, commit, bootstrap: false });
    const other = path.join(outside.base, "releases", "other");
    await fs.mkdir(other);
    await expect(inspectRecoveryState(outside.base, other)).rejects.toThrow(
      "outside the recorded deployment transaction",
    );
  });

  it("fault-injects every durable promotion boundary and recovers idempotently", async () => {
    const windows = [
      "stage_fsync",
      "pending_fsync",
      "release_move",
      "release_fsync",
      "final_recheck",
      "journal_fsync",
      "symlink_switch",
      "service_restart",
      "deep_health",
      "pending_unlink",
      "journal_unlink",
    ] as const;

    for (const [stopIndex, window] of windows.entries()) {
      const values = await fixture();
      const incoming = path.join(values.base, "incoming");
      const stage = path.join(incoming, "stage");
      const current = path.join(values.base, "current");
      await fs.mkdir(stage, { recursive: true });
      await fs.writeFile(path.join(stage, "server.js"), "server");
      await fs.symlink(values.previous, current);

      const switchCurrent = async (target: string) => {
        const temporary = path.join(values.base, `.current-test-${stopIndex}`);
        await fs.symlink(target, temporary);
        await fs.rename(temporary, current);
        await syncDeploymentDirectory(values.base);
      };
      const steps = [
        () => syncReleaseTree(values.base, stage),
        () =>
          writePendingRelease({
            base: values.base,
            release: values.release,
            commit,
          }).then(() => undefined),
        () => fs.rename(stage, values.release),
        () => syncReleaseTree(values.base, values.release),
        async () => undefined,
        () =>
          beginTransaction({
            ...values,
            commit,
            bootstrap: false,
          }).then(() => undefined),
        () => switchCurrent(values.release),
        async () => undefined,
        async () => undefined,
        () => clearPendingRelease(values.base, values.release, commit).then(() => undefined),
        () => clearTransaction(values.base).then(() => undefined),
      ];
      for (let index = 0; index <= stopIndex; index += 1) {
        await steps[index]();
      }

      const before = await inspectRecoveryState(
        values.base,
        await fs.realpath(current),
      );
      let restarts = 0;
      let healthChecks = 0;
      if (before.kind === "transaction") {
        await switchCurrent(before.previous);
        restarts += 1;
        healthChecks += 1;
        await fs.rm(before.release, { recursive: true, force: true });
        await syncReleaseDirectory(values.base);
        if (before.pendingPresent) {
          await clearPendingRelease(values.base, before.release, before.commit);
        }
        await clearTransaction(values.base);
      } else if (before.kind === "pending") {
        await fs.rm(before.release, { recursive: true, force: true });
        await syncReleaseDirectory(values.base);
        await clearPendingRelease(values.base, before.release, before.commit);
      }

      const committed = window === "journal_unlink";
      expect(await fs.realpath(current), window).toBe(
        committed ? values.release : values.previous,
      );
      expect(
        await fs
          .lstat(values.release)
          .then(() => true)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          }),
        window,
      ).toBe(committed);
      expect(restarts, window).toBe(before.kind === "transaction" ? 1 : 0);
      expect(healthChecks, window).toBe(
        before.kind === "transaction" ? 1 : 0,
      );
      await expect(
        inspectRecoveryState(values.base, await fs.realpath(current)),
        window,
      ).resolves.toEqual({ kind: "none" });
      await expect(
        inspectRecoveryState(values.base, await fs.realpath(current)),
        `${window} repeated recovery`,
      ).resolves.toEqual({ kind: "none" });
    }
  });

  it("reconciles a manual journal-unlink fsync fault with in-process authority", async () => {
    const values = await fixture();
    await preparePending(values);
    await beginTransaction({ ...values, commit, bootstrap: true });
    const current = path.join(values.base, "current");
    await fs.symlink(values.release, current);
    await clearPendingRelease(values.base, values.release, commit);

    // Model clearTransaction after unlink succeeded but before its directory
    // fsync reported success. The manual shell command has failed, but its trap
    // still owns the exact previous/release transaction values in memory.
    await fs.unlink(path.join(values.base, ".deploy-transaction.json"));
    expect(await fs.realpath(current)).toBe(values.release);
    await fs.unlink(current);
    await fs.symlink(values.previous, current);
    await syncDeploymentDirectory(values.base);
    await writeBootstrapMarker(values.base, commit);
    await fs.rm(values.release, { recursive: true, force: true });
    await syncReleaseDirectory(values.base);

    expect(await fs.realpath(current)).toBe(values.previous);
    expect(
      await fs.readFile(
        path.join(values.base, ".bootstrap-deploy-once"),
        "utf8",
      ),
    ).toBe(`${commit}\n`);
    await expect(
      inspectRecoveryState(values.base, await fs.realpath(current)),
    ).resolves.toEqual({ kind: "none" });
  });

  it("keeps every rollback prefix recoverable after exact authority recreation", async () => {
    const boundaries = [
      "authority",
      "switch",
      "restart",
      "bootstrap",
      "health",
      "candidate_remove",
      "pending_clear",
      "journal_clear",
    ] as const;

    for (const uncertainClear of [false, true]) {
      for (const [stopIndex, boundary] of boundaries.entries()) {
        const values = await fixture();
        await preparePending(values);
        if (!uncertainClear) {
          await writeBootstrapMarker(values.base, commit);
        }
        await beginTransaction({ ...values, commit, bootstrap: true });
        const current = path.join(values.base, "current");
        await fs.symlink(values.release, current);
        await syncDeploymentDirectory(values.base);
        if (uncertainClear) {
          await clearPendingRelease(values.base, values.release, commit);
          await clearTransaction(values.base);
        }

        const switchCurrent = async (target: string) => {
          const temporary = path.join(
            values.base,
            `.current-rollback-${uncertainClear ? "uncertain" : "normal"}-${stopIndex}`,
          );
          await fs.symlink(target, temporary);
          await fs.rename(temporary, current);
          await syncDeploymentDirectory(values.base);
        };
        const marker = path.join(values.base, ".bootstrap-deploy-once");
        const present = async (target: string) =>
          fs
            .lstat(target)
            .then(() => true)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            });
        let restarts = 0;
        let healthChecks = 0;
        const steps = [
          () =>
            ensureTransaction({ ...values, commit, bootstrap: true }).then(
              () => undefined,
            ),
          () => switchCurrent(values.previous),
          async () => {
            restarts += 1;
          },
          async () => {
            if (!(await present(marker))) {
              await writeBootstrapMarker(values.base, commit);
            }
          },
          async () => {
            healthChecks += 1;
          },
          async () => {
            await fs.rm(values.release, { recursive: true, force: true });
            await syncReleaseDirectory(values.base);
          },
          async () => {
            if (await present(path.join(values.base, ".deploy-pending.json"))) {
              await clearPendingRelease(values.base, values.release, commit);
            }
          },
          () => clearTransaction(values.base).then(() => undefined),
        ];
        for (let index = 0; index <= stopIndex; index += 1) {
          await steps[index]();
        }

        const state = await inspectRecoveryState(
          values.base,
          await fs.realpath(current),
        );
        if (state.kind === "transaction") {
          expect(state.previous, boundary).toBe(values.previous);
          expect(state.release, boundary).toBe(values.release);
          expect(state.commit, boundary).toBe(commit);
          await switchCurrent(state.previous);
          restarts += 1;
          if (!(await present(marker))) {
            await writeBootstrapMarker(values.base, commit);
          }
          healthChecks += 1;
          await fs.rm(state.release, { recursive: true, force: true });
          await syncReleaseDirectory(values.base);
          if (state.pendingPresent) {
            await clearPendingRelease(values.base, state.release, state.commit);
          }
          await clearTransaction(values.base);
        } else {
          expect(state, boundary).toEqual({ kind: "none" });
        }

        expect(await fs.realpath(current), boundary).toBe(values.previous);
        expect(await fs.readFile(marker, "utf8"), boundary).toBe(`${commit}\n`);
        expect(await present(values.release), boundary).toBe(false);
        expect(
          await inspectRecoveryState(values.base, await fs.realpath(current)),
          `${boundary} repeated recovery`,
        ).toEqual({ kind: "none" });
        expect(restarts, boundary).toBeGreaterThanOrEqual(1);
        expect(healthChecks, boundary).toBeGreaterThanOrEqual(1);
      }
    }
  }, 15_000);
});
