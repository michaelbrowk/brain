"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatAgo } from "@/lib/format-ago";
import { SettingsGroup, SettingsRow } from "./settings/shared";
import { Button, IconButton } from "./ui/button";
import { Icon } from "./ui/icon";
import { Skeleton } from "./ui/primitives";

type FailureCode =
  | "setup_failed"
  | "source_check_failed"
  | "offsite_copy_failed"
  | "capacity_check_failed"
  | "archive_create_failed"
  | "archive_check_failed"
  | "publish_failed"
  | "retention_failed"
  | "completion_report_failed"
  | "interrupted";

type BackupStatus = {
  apiVersion: 1;
  policy: {
    cadence: "daily";
    staleAfterSeconds: number;
    retainsUpTo: number;
  };
  stale: boolean;
  lastAttempt: null | {
    outcome: "running" | "success" | "failed";
    startedAt: string;
    finishedAt: string | null;
    failureCode: FailureCode | null;
  };
  lastVerifiedBackup: null | {
    verifiedAt: string;
    notesCommit: string;
    extractionRehearsal: "passed";
  };
  retainedVerifiedArchives: number;
  issues: string[];
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; status: BackupStatus }
  | { kind: "error" };

const FAILURE_LABELS: Record<FailureCode, string> = {
  setup_failed: "Setup failed",
  source_check_failed: "Notes check failed",
  offsite_copy_failed: "Offsite copy failed",
  capacity_check_failed: "Storage check failed",
  archive_create_failed: "Archive creation failed",
  archive_check_failed: "Archive extraction failed",
  publish_failed: "Publishing failed",
  retention_failed: "Cleanup failed",
  completion_report_failed: "Completion report failed",
  interrupted: "Backup was interrupted",
};

function absoluteDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** "aaaaaaaa…aaaaaaaa" for a long commit; short values pass through. */
function middleTruncate(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function isBackupStatus(value: unknown): value is BackupStatus {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BackupStatus>;
  return (
    candidate.apiVersion === 1 &&
    typeof candidate.stale === "boolean" &&
    typeof candidate.retainedVerifiedArchives === "number" &&
    Array.isArray(candidate.issues) &&
    typeof candidate.policy === "object" &&
    candidate.policy !== null &&
    candidate.policy.cadence === "daily" &&
    Number.isSafeInteger(candidate.policy.staleAfterSeconds) &&
    Number.isSafeInteger(candidate.policy.retainsUpTo) &&
    (candidate.lastAttempt === null ||
      (typeof candidate.lastAttempt === "object" &&
        candidate.lastAttempt !== null &&
        ["running", "success", "failed"].includes(
          candidate.lastAttempt.outcome,
        ))) &&
    (candidate.lastVerifiedBackup === null ||
      (typeof candidate.lastVerifiedBackup === "object" &&
        candidate.lastVerifiedBackup !== null &&
        candidate.lastVerifiedBackup.extractionRehearsal === "passed"))
  );
}

async function fetchBackupStatus(): Promise<BackupStatus> {
  const response = await fetch("/api/settings/backup", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("backup status unavailable");
  const status = (await response.json()) as unknown;
  if (!isBackupStatus(status)) throw new Error("invalid backup status");
  return status;
}

export function BackupStatusPanel({
  onToast,
}: {
  onToast?: (title: string) => void;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef(false);

  // Refresh revalidates in place: the facts stay while the icon spins, and
  // only the answer (or its failure) replaces them.
  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      setState({ kind: "ready", status: await fetchBackupStatus() });
    } catch {
      setState({ kind: "error" });
    } finally {
      inFlightRef.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetchBackupStatus()
      .then((status) => {
        if (active) setState({ kind: "ready", status });
      })
      .catch(() => {
        if (active) setState({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-2">
      <SettingsGroup
        title="Backups"
        description="Daily archive and verification facts"
        action={
          <IconButton
            size={28}
            aria-label="Refresh backup status"
            title="Refresh"
            disabled={state.kind === "loading" || refreshing}
            onClick={() => void load()}
          >
            <Icon
              name="restart-linear"
              size={16}
              className={refreshing ? "motion-safe:animate-spin" : undefined}
            />
          </IconButton>
        }
      >
        {state.kind === "loading" && (
          <div className="brain-settings-row" data-lead="" aria-busy="true">
            <Skeleton className="size-7 rounded-block" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
            <span role="status" className="sr-only">
              Loading backup details…
            </span>
          </div>
        )}
        {state.kind === "error" && (
          <div role="alert" className="brain-settings-row">
            <p className="min-w-0 flex-1 text-table text-ink-2">
              Backup details are unavailable.
            </p>
            <Button type="button" variant="quiet" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {state.kind === "ready" && (
          <BackupFacts status={state.status} onToast={onToast} />
        )}
      </SettingsGroup>
      {/* the caveat on the verdict above, not a fact of its own — it reads
          under the ring, never as one more row inside it */}
      {state.kind === "ready" && (
        <p className="text-caption leading-relaxed text-ink-3">
          Archive extraction checks that the saved files can be unpacked. A full
          service restore was not tested.
        </p>
      )}
    </div>
  );
}

function leadFacts(status: BackupStatus): {
  icon: string;
  tone?: "ok" | "danger";
  label: string;
  caption?: string;
} {
  const attempt = status.lastAttempt;
  const verified = status.lastVerifiedBackup;
  const attemptTime = attempt?.finishedAt ?? attempt?.startedAt ?? null;
  if (!attempt) {
    return {
      icon: "danger-triangle-linear",
      label: "No backup attempt recorded",
    };
  }
  if (attempt.outcome === "running") {
    return {
      icon: "clock-circle-linear",
      label: "Backup in progress",
      caption: `Started ${absoluteDate(attempt.startedAt)}`,
    };
  }
  if (attempt.outcome === "success") {
    if (verified) {
      return {
        // a verified archive that is past the window is not a green check:
        // the row under it is about to say the panel is stale
        icon: status.stale ? "danger-triangle-linear" : "check-linear",
        tone: status.stale ? undefined : "ok",
        label: `Backed up ${formatAgo(verified.verifiedAt)}`,
        caption: `${absoluteDate(verified.verifiedAt)} · Extraction verified`,
      };
    }
    return {
      icon: "danger-triangle-linear",
      label: attemptTime ? `Backed up ${formatAgo(attemptTime)}` : "Backed up",
      caption: attemptTime
        ? `${absoluteDate(attemptTime)} · Extraction not run`
        : "Extraction not run",
    };
  }
  return {
    icon: "danger-triangle-linear",
    tone: "danger",
    label: attempt.failureCode ? FAILURE_LABELS[attempt.failureCode] : "Failed",
    caption: attemptTime
      ? `${absoluteDate(attemptTime)} · ${formatAgo(attemptTime)}`
      : undefined,
  };
}

/** `stale` covers two facts, and the panel used to state only one of them:
 *  a backup was never attempted, or the last attempt is older than the
 *  policy window. The second one sits next to a lead row that names the
 *  attempt and how long ago it ran, so it has to say which window was
 *  missed rather than deny the attempt exists. */
function staleSentence(status: BackupStatus): string {
  if (!status.lastAttempt) return "Stale — no backup attempt has been recorded.";
  const hours = Math.round(status.policy.staleAfterSeconds / 3_600);
  return `Stale — the last backup attempt is older than the ${hours}-hour window.`;
}

function BackupFacts({
  status,
  onToast,
}: {
  status: BackupStatus;
  onToast?: (title: string) => void;
}) {
  const attempt = status.lastAttempt;
  const verified = status.lastVerifiedBackup;
  const lead = leadFacts(status);
  const inventoryUnavailable = status.issues.includes(
    "archive_inventory_unavailable",
  );

  const copySnapshot = async () => {
    if (!verified) return;
    try {
      await navigator.clipboard.writeText(verified.notesCommit);
      onToast?.("Snapshot copied");
    } catch {
      onToast?.("Couldn't copy. Try again.");
    }
  };

  return (
    <>
      <div className="brain-settings-row" data-lead="">
        <span
          className="brain-settings-tile"
          data-tone={lead.tone}
          aria-hidden="true"
        >
          <Icon name={lead.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-table font-semibold text-ink">
            {lead.label}
          </p>
          {lead.caption && (
            <p className="truncate text-caption text-ink-3">{lead.caption}</p>
          )}
        </div>
      </div>
      {status.stale && (
        <p role="status" className="brain-settings-row text-table text-ink">
          {staleSentence(status)}
        </p>
      )}
      {verified && attempt?.outcome !== "success" && (
        <SettingsRow
          label="Last verified backup"
          hint={`${absoluteDate(verified.verifiedAt)} · Extraction verified`}
        >
          <span className="text-table text-ink-2">
            {formatAgo(verified.verifiedAt)}
          </span>
        </SettingsRow>
      )}
      {verified && (
        <SettingsRow label="Snapshot">
          <span className="truncate font-mono text-caption text-ink-2">
            {middleTruncate(verified.notesCommit)}
          </span>
          <IconButton
            size={28}
            aria-label="Copy snapshot commit"
            onClick={() => void copySnapshot()}
          >
            <Icon name="copy-linear" size={16} />
          </IconButton>
        </SettingsRow>
      )}
      <SettingsRow label="Archives kept">
        <span className="text-table text-ink-2 tabular-nums">
          {inventoryUnavailable
            ? "Not available"
            : `${status.retainedVerifiedArchives} of ${status.policy.retainsUpTo}`}
        </span>
      </SettingsRow>
    </>
  );
}
