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
}
