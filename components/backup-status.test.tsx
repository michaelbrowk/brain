// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupStatusPanel } from "./backup-status";

const failedSnapshot = {
  apiVersion: 1,
  policy: {
    cadence: "daily",
    staleAfterSeconds: 129_600,
    retainsUpTo: 7,
  },
  stale: false,
  lastAttempt: {
    outcome: "failed",
    startedAt: "2026-07-30T17:00:00Z",
    finishedAt: "2026-07-30T17:00:10Z",
    failureCode: "archive_check_failed",
  },
  lastVerifiedBackup: {
    verifiedAt: "2026-07-30T16:03:05Z",
    notesCommit: "a".repeat(40),
    extractionRehearsal: "passed",
  },
  retainedVerifiedArchives: 3,
  issues: [],
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("BackupStatusPanel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T18:00:00Z"));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows a failed attempt next to the older verified backup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(failedSnapshot), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await act(async () => root.render(<BackupStatusPanel />));
    await settle();

    expect(host.textContent).toContain("Archive extraction failed");
    expect(host.textContent).toContain("Last verified backup");
    expect(host.textContent).toContain("Extraction verified");
    // the commit reads as a middle-truncated snapshot; the full 40 chars stay
    // on the clipboard, not in the row
    expect(host.textContent).toContain("Snapshotaaaaaaaa…aaaaaaaa");
    expect(host.textContent).not.toContain("a".repeat(40));
    expect(host.textContent).toContain("Archives kept3 of 7");
    expect(host.textContent).toContain("A full service restore was not tested.");
    expect(host.textContent).not.toMatch(/Healthy|Recoverable|Restore/);
  });

  it("leads with the backed-up headline when the attempt and extraction both passed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...failedSnapshot,
            lastAttempt: {
              outcome: "success",
              startedAt: "2026-07-30T15:00:00Z",
              finishedAt: "2026-07-30T15:00:10Z",
              failureCode: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await act(async () => root.render(<BackupStatusPanel />));
    await settle();

    expect(host.textContent).toContain("Backed up 2h ago");
    expect(host.textContent).toContain("Extraction verified");
    // a passing run states itself once — no second "Last verified backup" row
    expect(host.textContent).not.toContain("Last verified backup");
    expect(host.textContent).not.toMatch(/Healthy|Recoverable|Restore/);
  });

  it("shows stale independently from the last verified backup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...failedSnapshot,
            stale: true,
            lastAttempt: null,
            issues: ["attempt_missing"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await act(async () => root.render(<BackupStatusPanel />));
    await settle();

    expect(host.textContent).toContain(
      "Stale — no backup attempt has been recorded.",
    );
    expect(host.textContent).toContain("Last verified backup");
  });

  it("names the missed window when stale but an attempt was recorded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...failedSnapshot,
            stale: true,
            lastAttempt: {
              ...failedSnapshot.lastAttempt,
              outcome: "success",
              failureCode: null,
              startedAt: "2026-07-27T17:00:00Z",
              finishedAt: "2026-07-27T17:04:10Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await act(async () => root.render(<BackupStatusPanel />));
    await settle();

    // the lead names an attempt, so the stale row must not deny there was one
    expect(host.textContent).toContain(
      "Stale — the last backup attempt is older than the 36-hour window.",
    );
    expect(host.textContent).not.toContain("no backup attempt");
  });

  it("keeps API errors distinct from a failed backup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })),
    );

    await act(async () => root.render(<BackupStatusPanel />));
    await settle();

    expect(host.textContent).toContain("Backup details are unavailable.");
    expect(host.textContent).not.toContain("Backup failed");
  });

  it("does not turn an unavailable archive inventory into a false zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...failedSnapshot,
            retainedVerifiedArchives: 0,
            issues: ["archive_inventory_unavailable"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await act(async () => root.render(<BackupStatusPanel />));
    await settle();

    expect(host.textContent).toContain("Archives keptNot available");
    expect(host.textContent).not.toContain("Archives kept0");
  });
});
