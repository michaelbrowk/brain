import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBackupStatus } from "./backup-status";

const roots: string[] = [];
const NOW = Date.parse("2026-07-30T18:00:00Z");
const COMMIT = "a".repeat(40);
const ARCHIVE = `brain-notes-20260730T160253Z-${COMMIT.slice(0, 12)}.tar.gz`;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-backup-status-"));
  roots.push(root);
  await fs.writeFile(path.join(root, ARCHIVE), "data", { mode: 0o600 });
  await fs.writeFile(
    path.join(root, "last-success.json"),
    `${JSON.stringify({
      status: "ok",
      archive: ARCHIVE,
      commit: COMMIT,
      archiveBytes: 4,
      verifiedAt: "2026-07-30T16:03:05Z",
    })}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(root, "last-attempt.json"),
    `${JSON.stringify({
      version: 1,
      status: "success",
      startedAt: "2026-07-30T16:02:53Z",
      finishedAt: "2026-07-30T16:03:05Z",
    })}\n`,
    { mode: 0o600 },
  );
  return root;
}

describe("readBackupStatus", () => {
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("returns separate attempt and last verified archive facts", async () => {
    const root = await fixture();

    await expect(readBackupStatus({ root, now: NOW })).resolves.toEqual({
      apiVersion: 1,
      policy: {
        cadence: "daily",
        staleAfterSeconds: 129_600,
        retainsUpTo: 7,
      },
      stale: false,
      lastAttempt: {
        outcome: "success",
        startedAt: "2026-07-30T16:02:53Z",
        finishedAt: "2026-07-30T16:03:05Z",
        failureCode: null,
      },
      lastVerifiedBackup: {
        verifiedAt: "2026-07-30T16:03:05Z",
        notesCommit: COMMIT,
        extractionRehearsal: "passed",
      },
      retainedVerifiedArchives: 1,
      issues: [],
    });
  });

  it("keeps an older verified archive visible after the latest failure", async () => {
    const root = await fixture();
    await fs.writeFile(
      path.join(root, "last-attempt.json"),
      `${JSON.stringify({
        version: 1,
        status: "failed",
        startedAt: "2026-07-30T17:00:00Z",
        finishedAt: "2026-07-30T17:00:10Z",
        failureCode: "archive_check_failed",
      })}\n`,
    );

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.lastAttempt).toEqual({
      outcome: "failed",
      startedAt: "2026-07-30T17:00:00Z",
      finishedAt: "2026-07-30T17:00:10Z",
      failureCode: "archive_check_failed",
    });
    expect(result.lastVerifiedBackup?.notesCommit).toBe(COMMIT);
    expect(result.stale).toBe(false);
  });

  it("normalizes an abandoned running attempt to interrupted", async () => {
    const root = await fixture();
    await fs.writeFile(
      path.join(root, "last-attempt.json"),
      `${JSON.stringify({
        version: 1,
        status: "running",
        startedAt: "2026-07-30T17:30:00Z",
      })}\n`,
    );

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.lastAttempt).toEqual({
      outcome: "failed",
      startedAt: "2026-07-30T17:30:00Z",
      finishedAt: null,
      failureCode: "interrupted",
    });
  });

  it("supports the legacy state without last-attempt and marks it stale", async () => {
    const root = await fixture();
    await fs.rm(path.join(root, "last-attempt.json"));

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.lastAttempt).toBeNull();
    expect(result.lastVerifiedBackup?.notesCommit).toBe(COMMIT);
    expect(result.stale).toBe(true);
    expect(result.issues).toContain("attempt_missing");
  });

  it("rejects malformed, oversized, symlinked, and future status files", async () => {
    const root = await fixture();
    const external = path.join(root, "external.json");
    await fs.writeFile(external, "{}");
    await fs.rm(path.join(root, "last-attempt.json"));
    await fs.symlink(external, path.join(root, "last-attempt.json"));
    await fs.writeFile(path.join(root, "last-success.json"), "x".repeat(4_097));

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.lastAttempt).toBeNull();
    expect(result.lastVerifiedBackup).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining(["attempt_invalid", "verified_backup_invalid"]),
    );

    await fs.rm(path.join(root, "last-attempt.json"));
    await fs.writeFile(
      path.join(root, "last-attempt.json"),
      `${JSON.stringify({
        version: 1,
        status: "running",
        startedAt: "2026-07-31T18:00:00Z",
      })}\n`,
    );
    const future = await readBackupStatus({ root, now: NOW });
    expect(future.lastAttempt).toBeNull();
    expect(future.issues).toContain("attempt_invalid");
  });

  it("rejects FIFO status files without blocking the owner API reader", async () => {
    const root = await fixture();
    await fs.rm(path.join(root, "last-attempt.json"));
    await fs.rm(path.join(root, "last-success.json"));
    execFileSync("mkfifo", [path.join(root, "last-attempt.json")]);
    execFileSync("mkfifo", [path.join(root, "last-success.json")]);

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.lastAttempt).toBeNull();
    expect(result.lastVerifiedBackup).toBeNull();
    expect(result.issues).toEqual(
      expect.arrayContaining(["attempt_invalid", "verified_backup_invalid"]),
    );
  });

  it("does not expose a success whose archive is missing or unusual", async () => {
    const root = await fixture();
    await fs.rm(path.join(root, ARCHIVE));

    const missing = await readBackupStatus({ root, now: NOW });
    expect(missing.lastVerifiedBackup).toBeNull();
    expect(missing.issues).toContain("verified_backup_invalid");

    await fs.symlink(path.join(root, "last-attempt.json"), path.join(root, ARCHIVE));
    const symlink = await readBackupStatus({ root, now: NOW });
    expect(symlink.lastVerifiedBackup).toBeNull();
    expect(symlink.retainedVerifiedArchives).toBe(0);
  });

  it("marks attempts older than 36 hours stale and counts only exact archives", async () => {
    const root = await fixture();
    await fs.writeFile(
      path.join(root, "last-attempt.json"),
      `${JSON.stringify({
        version: 1,
        status: "failed",
        startedAt: "2026-07-28T00:00:00Z",
        finishedAt: "2026-07-28T00:00:10Z",
        failureCode: "offsite_copy_failed",
      })}\n`,
    );
    await fs.writeFile(
      path.join(root, "brain-notes-invalid.tar.gz"),
      "not counted",
    );

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.stale).toBe(true);
    expect(result.retainedVerifiedArchives).toBe(1);
  });

  it("stops archive inventory after the bounded directory entry limit", async () => {
    const root = await fixture();
    for (let start = 0; start < 4_097; start += 256) {
      await Promise.all(
        Array.from(
          { length: Math.min(256, 4_097 - start) },
          (_, offset) =>
            fs.mkdir(path.join(root, `inventory-${start + offset}`)),
        ),
      );
    }

    const result = await readBackupStatus({ root, now: NOW });

    expect(result.retainedVerifiedArchives).toBe(0);
    expect(result.issues).toContain("archive_inventory_unavailable");
  });
});
