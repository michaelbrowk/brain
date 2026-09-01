import { afterEach, describe, expect, it, vi } from "vitest";

const snapshot = {
  apiVersion: 1,
  policy: {
    cadence: "daily",
    staleAfterSeconds: 129_600,
    retainsUpTo: 7,
  },
  stale: false,
  lastAttempt: null,
  lastVerifiedBackup: null,
  retainedVerifiedArchives: 0,
  issues: [],
};

describe("GET /api/settings/backup", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/backup-status");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns owner backup facts without caching", async () => {
    vi.doMock("@/lib/backup-status", () => ({
      readBackupStatus: vi.fn().mockResolvedValue(snapshot),
    }));
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(snapshot);
  });

  it("returns a generic no-store error without filesystem details", async () => {
    vi.doMock("@/lib/backup-status", () => ({
      readBackupStatus: vi.fn().mockRejectedValue(
        new Error("/opt/brain/backups is unavailable"),
      ),
    }));
    const { GET } = await import("./route");

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "backup details unavailable",
    });
  });
});
