import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readReleaseInfo: vi.fn(),
  readUpdateState: vi.fn(),
  runUpdateCheck: vi.fn(),
  updateCheckEnabled: vi.fn(),
}));
vi.mock("@/lib/release-info", () => ({ readReleaseInfo: mocks.readReleaseInfo }));
vi.mock("@/lib/update-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/update-check")>()),
  readUpdateState: mocks.readUpdateState,
  runUpdateCheck: mocks.runUpdateCheck,
  updateCheckEnabled: mocks.updateCheckEnabled,
}));

import { GET, POST } from "./route";

const running = { version: "0.9.0", commit: "a".repeat(40), buildTime: "2026-09-01T18:00:00Z" };
const newer = { schema: 1, checkedAt: "2026-09-02T09:00:00.000Z", latest: { version: "0.9.1", url: "https://github.com/michaelbrowk/brain/releases/tag/v0.9.1", publishedAt: "2026-09-02T08:00:00Z" }, error: null };

afterEach(() => vi.resetAllMocks());

describe("/api/settings/update", () => {
  it("GET reports an available update from the cache without calling GitHub", async () => {
    mocks.readReleaseInfo.mockResolvedValue(running);
    mocks.readUpdateState.mockResolvedValue(newer);
    mocks.updateCheckEnabled.mockReturnValue(true);
    const response = await GET();
    const body = await response.json();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({
      apiVersion: 1,
      ...running,
      updateCheck: "on",
      checkedAt: newer.checkedAt,
      latest: newer.latest,
      updateAvailable: true,
      error: null,
    });
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled();
  });

  it("GET is honest when nothing has been checked yet or the check is off", async () => {
    mocks.readReleaseInfo.mockResolvedValue(running);
    mocks.readUpdateState.mockResolvedValue(null);
    mocks.updateCheckEnabled.mockReturnValue(false);
    const body = await (await GET()).json();
    expect(body.updateCheck).toBe("off");
    expect(body.checkedAt).toBeNull();
    expect(body.updateAvailable).toBe(false);
  });

  it("does not call a dev build an update candidate", async () => {
    mocks.readReleaseInfo.mockResolvedValue({ ...running, version: null });
    mocks.readUpdateState.mockResolvedValue(newer);
    mocks.updateCheckEnabled.mockReturnValue(true);
    expect((await (await GET()).json()).updateAvailable).toBe(false);
  });

  it("POST runs a check now", async () => {
    mocks.readReleaseInfo.mockResolvedValue(running);
    mocks.updateCheckEnabled.mockReturnValue(true);
    mocks.runUpdateCheck.mockResolvedValue(newer);
    const body = await (await POST()).json();
    expect(mocks.runUpdateCheck).toHaveBeenCalledTimes(1);
    expect(body.updateAvailable).toBe(true);
  });

  it("POST refuses when the check is off", async () => {
    mocks.readReleaseInfo.mockResolvedValue(running);
    mocks.updateCheckEnabled.mockReturnValue(false);
    const response = await POST();
    expect(response.status).toBe(409);
    expect(mocks.runUpdateCheck).not.toHaveBeenCalled();
  });
});
