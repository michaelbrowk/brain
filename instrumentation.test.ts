import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  barrier: vi.fn<() => Promise<void>>(),
  installSse: vi.fn(),
  ensure: vi.fn<(root: string) => Promise<void>>(),
  scheduleUpdateChecks: vi.fn(),
  scheduleReminderScans: vi.fn(),
  tellMail: vi.fn<() => Promise<boolean>>(),
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
// The two schedulers are off under NODE_ENV=test on their own, but one case
// below has to run as production to reach the mail call beside them, and a
// real timer left behind by that case would outlive the suite.
vi.mock("./lib/update-check", () => ({
  scheduleUpdateChecks: mocks.scheduleUpdateChecks,
}));
vi.mock("./lib/reminders/scheduler", () => ({
  scheduleReminderScans: mocks.scheduleReminderScans,
}));
vi.mock("./lib/mail/module-sync", () => ({
  tellMailServiceAboutModules: mocks.tellMail,
}));

import { register } from "./instrumentation";

describe("register", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    mocks.barrier.mockReset().mockResolvedValue(undefined);
    mocks.installSse.mockReset();
    mocks.ensure.mockReset().mockResolvedValue(undefined);
    mocks.scheduleUpdateChecks.mockReset();
    mocks.scheduleReminderScans.mockReset();
    mocks.tellMail.mockReset().mockResolvedValue(true);
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

  /** THE MODULE SWITCH, REPEATED TO THE OTHER PROCESS. The mail service
   *  restarts on its own and a restore can land a settings file beside a
   *  service that never heard about it, so boot says the switch once as a
   *  repair. It is not awaited: a socket that does not answer must not hold
   *  the web process at the door. */
  it("tells the mail service the switch without making boot wait on it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    let settle: (told: boolean) => void = () => {};
    mocks.tellMail.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();

    // `register()` is done while the call is still open, which is the claim.
    expect(mocks.tellMail).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();

    settle(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]!.join(" ")).toContain(
      "did not answer the module switch",
    );
  });

  /** A rejection here has no other handler. `tellMailServiceAboutModules`
   *  answers `false` rather than throwing, so this arm exists for the day
   *  that stops being true: without it Node's default would take the web
   *  process down over one wrong environment variable. */
  it("warns rather than crashing boot when the call rejects", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mocks.tellMail.mockRejectedValueOnce(new Error("mail_service_unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await register();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]!.join(" ")).toContain(
      "did not answer the module switch",
    );
  });

  it("says nothing when the service took the switch", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await register();
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.tellMail).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not reach the mail socket under NODE_ENV=test", async () => {
    vi.stubEnv("NODE_ENV", "test");
    await register();
    expect(mocks.tellMail).not.toHaveBeenCalled();
  });
});
