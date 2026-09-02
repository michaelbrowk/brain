export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { waitForStandaloneStartupBarrier } = await import(
    "./lib/store/standalone-startup-barrier"
  );
  await waitForStandaloneStartupBarrier();
  const { installSseShutdownSignalHandlers } = await import(
    "./lib/store/sse-shutdown"
  );
  installSseShutdownSignalHandlers();

  // The store is created by the first request, so a notes root this process
  // cannot write would leave `docker compose logs web` showing a clean boot
  // and surface only when someone saves. Probe it once here and put the cure
  // in the boot log. The store still refuses every request, and deep health
  // reports notes_store_init, until the folder is fixed.
  const [{ NOTES_ROOT }, { ensureWritableNotesRoot }] = await Promise.all([
    import("./lib/store"),
    import("./lib/store/notes-root"),
  ]);
  await ensureWritableNotesRoot(NOTES_ROOT).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[brain/store] ${message}`);
  });

  // The daily release check. Off under NODE_ENV=test and BRAIN_UPDATE_CHECK=off;
  // otherwise one request thirty seconds after boot, then once a day.
  const { scheduleUpdateChecks } = await import("./lib/update-check");
  scheduleUpdateChecks();
}
