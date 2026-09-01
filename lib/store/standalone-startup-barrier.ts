/** Test-only barrier for the standalone smoke. It pauses after Next has
 * installed its own signal listeners but before the app shutdown latch exists.
 * Production has neither the token nor an IPC channel. */
export async function waitForStandaloneStartupBarrier(): Promise<void> {
  const token = process.env.BRAIN_STANDALONE_STARTUP_BARRIER_TOKEN;
  const send = process.send?.bind(process);
  if (!token || !send) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      process.off("message", onMessage);
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        "token" in message &&
        message.type === "brain-startup-latch-release" &&
        message.token === token
      ) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("standalone startup shutdown barrier timed out"));
    }, 5_000);
    process.on("message", onMessage);
    send({ type: "brain-startup-latch-blocked", token });
  });
}
