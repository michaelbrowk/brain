import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  barrier: vi.fn<() => Promise<void>>(),
  installSse: vi.fn(),
  ensure: vi.fn<(root: string) => Promise<void>>(),
}));

vi.mock("./lib/store/standalone-startup-barrier", () => ({
  waitForStandaloneStartupBarrier: mocks.barrier,
}));
vi.mock("./lib/store/sse-shutdown", () => ({
  installSseShutdownSignalHandlers: mocks.installSse,
}));
vi.mock("./lib/store/notes-root", () => ({
  ensureWritableNotesRoot: mocks.ensure,
}));
vi.mock("./lib/store", () => ({ NOTES_ROOT: "/opt/brain/notes" }));

import { register } from "./instrumentation";

describe("register", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.barrier.mockReset().mockResolvedValue(undefined);
    mocks.installSse.mockReset();
    mocks.ensure.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("names an unwritable notes root in the boot log and still starts", async () => {
    // The store is created lazily by the first request, so without this the
    // operator's `docker compose logs web` shows a clean boot and the refusal
    // only appears once someone tries to save.
    mocks.ensure.mockRejectedValueOnce(
      new Error(
        "Brain cannot write to NOTES_ROOT /opt/brain/notes (EACCES from mkdir). " +
          "chown 1000:1000 <host folder> on the host",
      ),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await register();

    expect(mocks.ensure).toHaveBeenCalledWith("/opt/brain/notes");
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0].join(" ")).toContain("chown 1000:1000");
    expect(mocks.installSse).toHaveBeenCalledOnce();
  });

  it("logs nothing about a notes root it can write", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await register();

    expect(mocks.ensure).toHaveBeenCalledWith("/opt/brain/notes");
    expect(log).not.toHaveBeenCalled();
  });
});
