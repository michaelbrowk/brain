import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const STATUS_FILE_LIMIT = 4 * 1024;
const INVENTORY_LIMIT = 4_096;
const INTERRUPTED_AFTER_MS = 20 * 60 * 1_000;
const STALE_AFTER_MS = 36 * 60 * 60 * 1_000;
const ARCHIVE_PATTERN =
  /^brain-notes-\d{8}T\d{6}Z-([0-9a-f]{12,64})\.tar\.gz$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const BACKUP_FAILURE_CODES = [
  "setup_failed",
  "source_check_failed",
  "offsite_copy_failed",
  "capacity_check_failed",
  "archive_create_failed",
  "archive_check_failed",
  "publish_failed",
  "retention_failed",
  "completion_report_failed",
  "interrupted",
] as const;

export type BackupFailureCode = (typeof BACKUP_FAILURE_CODES)[number];
export type BackupIssue =
  | "attempt_missing"
  | "attempt_invalid"
  | "verified_backup_missing"
  | "verified_backup_invalid"
  | "archive_inventory_unavailable";

export type BackupStatusSnapshot = {
  apiVersion: 1;
  policy: {
    cadence: "daily";
    staleAfterSeconds: 129_600;
    retainsUpTo: 7;
  };
  stale: boolean;
  lastAttempt: null | {
    outcome: "running" | "success" | "failed";
    startedAt: string;
    finishedAt: string | null;
    failureCode: BackupFailureCode | null;
  };
  lastVerifiedBackup: null | {
    verifiedAt: string;
    notesCommit: string;
    extractionRehearsal: "passed";
  };
  retainedVerifiedArchives: number;
  issues: BackupIssue[];
};

type AttemptFile =
  | { version: 1; status: "running"; startedAt: string }
  | {
      version: 1;
      status: "success";
      startedAt: string;
      finishedAt: string;
    }
  | {
      version: 1;
      status: "failed";
      startedAt: string;
      finishedAt: string;
      failureCode: BackupFailureCode;
    };

type SuccessFile = {
  status: "ok";
  archive: string;
  commit: string;
  archiveBytes: number;
  verifiedAt: string;
};

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown, now: number): value is string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= now + 5 * 60 * 1_000;
}

function parseAttempt(value: unknown, now: number): AttemptFile | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (value.status === "running") {
    if (
      !exactKeys(value, ["version", "status", "startedAt"]) ||
      !validTimestamp(value.startedAt, now)
    ) {
      return null;
    }
    return value as AttemptFile;
  }
  if (value.status === "success") {
    if (
      !exactKeys(value, ["version", "status", "startedAt", "finishedAt"]) ||
      !validTimestamp(value.startedAt, now) ||
      !validTimestamp(value.finishedAt, now) ||
      Date.parse(value.finishedAt as string) < Date.parse(value.startedAt as string)
    ) {
      return null;
    }
    return value as AttemptFile;
  }
  if (value.status === "failed") {
    if (
      !exactKeys(value, [
        "version",
        "status",
        "startedAt",
        "finishedAt",
        "failureCode",
      ]) ||
      !validTimestamp(value.startedAt, now) ||
      !validTimestamp(value.finishedAt, now) ||
      Date.parse(value.finishedAt as string) < Date.parse(value.startedAt as string) ||
      !BACKUP_FAILURE_CODES.includes(value.failureCode as BackupFailureCode)
    ) {
      return null;
    }
    return value as AttemptFile;
  }
  return null;
}

function parseSuccess(value: unknown, now: number): SuccessFile | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "status",
      "archive",
      "commit",
      "archiveBytes",
      "verifiedAt",
    ]) ||
    value.status !== "ok" ||
    typeof value.archive !== "string" ||
    !ARCHIVE_PATTERN.test(value.archive) ||
    typeof value.commit !== "string" ||
    !COMMIT_PATTERN.test(value.commit) ||
    !Number.isSafeInteger(value.archiveBytes) ||
    (value.archiveBytes as number) <= 0 ||
    !validTimestamp(value.verifiedAt, now) ||
    !value.archive.endsWith(`${value.commit.slice(0, 12)}.tar.gz`)
  ) {
    return null;
  }
  return value as SuccessFile;
}

async function readBoundedJson(file: string): Promise<unknown> {
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > STATUS_FILE_LIMIT) {
      throw new Error("invalid status file");
    }
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

async function regularArchive(
  root: string,
  archive: string,
  expectedBytes?: number,
): Promise<boolean> {
  try {
    const stat = await fs.lstat(path.join(root, archive));
    return (
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      (expectedBytes === undefined || stat.size === expectedBytes)
    );
  } catch {
    return false;
  }
}

async function countArchives(root: string): Promise<number> {
  const directory = await fs.opendir(root);
  let count = 0;
  let visited = 0;
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      visited += 1;
      if (visited > INVENTORY_LIMIT) {
        throw new Error("backup inventory is too large");
      }
      if (
        ARCHIVE_PATTERN.test(entry.name) &&
        (await regularArchive(root, entry.name))
      ) {
        count += 1;
      }
    }
  } finally {
    await directory.close().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ERR_DIR_CLOSED") throw error;
    });
  }
  return count;
}

export async function readBackupStatus(options?: {
  root?: string;
  now?: number;
}): Promise<BackupStatusSnapshot> {
  const root = options?.root ?? process.env.BRAIN_BACKUP_ROOT ?? "/opt/brain/backups";
  const now = options?.now ?? Date.now();
  const issues: BackupIssue[] = [];
  let attempt: AttemptFile | null = null;
  let success: SuccessFile | null = null;
  let retainedVerifiedArchives = 0;

  try {
    attempt = parseAttempt(
      await readBoundedJson(path.join(root, "last-attempt.json")),
      now,
    );
    if (!attempt) issues.push("attempt_invalid");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    issues.push(code === "ENOENT" ? "attempt_missing" : "attempt_invalid");
  }

  try {
    const candidate = parseSuccess(
      await readBoundedJson(path.join(root, "last-success.json")),
      now,
    );
    if (
      candidate &&
      (await regularArchive(root, candidate.archive, candidate.archiveBytes))
    ) {
      success = candidate;
    } else {
      issues.push("verified_backup_invalid");
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    issues.push(
      code === "ENOENT"
        ? "verified_backup_missing"
        : "verified_backup_invalid",
    );
  }

  try {
    retainedVerifiedArchives = await countArchives(root);
  } catch {
    issues.push("archive_inventory_unavailable");
  }

  let normalizedAttempt: BackupStatusSnapshot["lastAttempt"] = null;
  if (attempt) {
    const interrupted =
      attempt.status === "running" &&
      now - Date.parse(attempt.startedAt) > INTERRUPTED_AFTER_MS;
    normalizedAttempt = {
      outcome: interrupted ? "failed" : attempt.status,
      startedAt: attempt.startedAt,
      finishedAt: attempt.status === "running" ? null : attempt.finishedAt,
      failureCode: interrupted
        ? "interrupted"
        : attempt.status === "failed"
          ? attempt.failureCode
          : null,
    };
  }

  const attemptAge = attempt ? now - Date.parse(attempt.startedAt) : Infinity;
  return {
    apiVersion: 1,
    policy: {
      cadence: "daily",
      staleAfterSeconds: 129_600,
      retainsUpTo: 7,
    },
    stale: !attempt || attemptAge > STALE_AFTER_MS,
    lastAttempt: normalizedAttempt,
    lastVerifiedBackup: success
      ? {
          verifiedAt: success.verifiedAt,
          notesCommit: success.commit,
          extractionRehearsal: "passed",
        }
      : null,
    retainedVerifiedArchives,
    issues,
  };
}
