export type SseCloseCallback = () => void;

export interface SseShutdownResult {
  started: boolean;
  closed: number;
}

/** Tracks only long-lived Brain event streams. Closing them lets Next.js drain
 * ordinary in-flight requests instead of waiting forever in server.close(). */
export class SseShutdownRegistry {
  private readonly callbacks = new Set<SseCloseCallback>();
  private shuttingDown = false;

  register(close: SseCloseCallback): () => void {
    if (this.shuttingDown) {
      this.closeSafely(close);
      return () => {};
    }

    this.callbacks.add(close);
    let registered = true;

    return () => {
      if (!registered) return;
      registered = false;
      this.callbacks.delete(close);
    };
  }

  beginShutdown(): SseShutdownResult {
    if (this.shuttingDown) return { started: false, closed: 0 };
    this.shuttingDown = true;

    const callbacks = [...this.callbacks];
    this.callbacks.clear();

    for (const close of callbacks) {
      this.closeSafely(close);
    }

    return { started: true, closed: callbacks.length };
  }

  size(): number {
    return this.callbacks.size;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  private closeSafely(close: SseCloseCallback): void {
    try {
      close();
    } catch (error) {
      console.error("Failed to close a Brain event stream during shutdown", error);
    }
  }
}

interface BrainSseShutdownState {
  registry: SseShutdownRegistry;
  signalHandlersInstalled: boolean;
}

interface BrainStartupShutdownState {
  requested: boolean;
  pendingSignal: "SIGINT" | "SIGTERM" | null;
  deliveredToNext: boolean;
  consumed: boolean;
  replayed: boolean;
  capture: (signal: "SIGINT" | "SIGTERM") => void;
  activate: (
    beginShutdown: () => void,
    installSignalHandlers: () => void,
  ) => boolean;
}

const brainGlobal = globalThis as typeof globalThis & {
  __brainSseShutdownState?: BrainSseShutdownState;
};

const STARTUP_SHUTDOWN_STATE_KEY = Symbol.for(
  "brain.startup-shutdown-state",
);

function startupShutdownState(): BrainStartupShutdownState | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[
    STARTUP_SHUTDOWN_STATE_KEY
  ] as BrainStartupShutdownState | undefined;
}

const state =
  brainGlobal.__brainSseShutdownState ??
  (brainGlobal.__brainSseShutdownState = {
    registry: new SseShutdownRegistry(),
    signalHandlersInstalled: false,
  });

function beginSseShutdown(): void {
  const result = state.registry.beginShutdown();
  if (result.started) {
    console.info(
      `Brain SSE shutdown started; closed ${result.closed} active stream(s)`,
    );
  }
}

export function installSseShutdownSignalHandlers(): void {
  if (state.signalHandlersInstalled) return;

  const installSignalHandlers = () => {
    if (state.signalHandlersInstalled) return;
    process.on("SIGTERM", beginSseShutdown);
    process.on("SIGINT", beginSseShutdown);
    state.signalHandlersInstalled = true;
  };

  const startup = startupShutdownState();
  if (startup) {
    startup.activate(beginSseShutdown, installSignalHandlers);
  } else {
    // next dev and isolated tests do not launch through the standalone wrapper.
    installSignalHandlers();
  }
}

export function registerActiveSseClose(close: SseCloseCallback): () => void {
  // The startup request latch is irreversible. A request accepted before the
  // app handlers were ready may reach this module only after Next has started
  // draining, so close it synchronously instead of briefly reopening SSE.
  if (startupShutdownState()?.requested) beginSseShutdown();
  return state.registry.register(close);
}
