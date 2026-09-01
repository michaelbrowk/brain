import { Server as HttpServer } from "node:http";

const STATE_KEY = Symbol.for("brain.startup-shutdown-state");
const FALLBACK_EXIT_MS = 5_000;
const SIGNALS = Object.freeze(["SIGINT", "SIGTERM"]);
const EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

if (Object.hasOwn(globalThis, STATE_KEY)) {
  throw new Error("Brain startup shutdown state is already installed");
}

let fallbackTimer;

const notify = (type, details = {}) => {
  if (typeof process.send !== "function") return;
  process.send({ type, ...details }, () => {});
};

const state = {
  requested: false,
  pendingSignal: null,
  deliveredToNext: false,
  consumed: false,
  replayed: false,
  capture: null,
  activate: null,
};

const capture = (signal) => {
  if (!SIGNALS.includes(signal) || state.consumed) return;

  // EventEmitter snapshots the listeners before calling the first one. Any
  // listener already beside this prepended capture receives this same signal.
  // During standalone startup that listener is Next's cleanup handler.
  const deliveredToNext = process
    .rawListeners(signal)
    .some((listener) => listener !== capture);

  if (!state.requested) {
    state.requested = true;
    state.pendingSignal = signal;
    fallbackTimer = setTimeout(() => {
      process.exit(EXIT_CODES[state.pendingSignal]);
    }, FALLBACK_EXIT_MS);
    fallbackTimer.unref?.();
  }

  // A repeated signal may arrive after Next installs its listener. Never lose
  // that fact: replaying again would deliver a second signal unnecessarily.
  if (deliveredToNext) state.deliveredToNext = true;
  notify("brain-startup-signal-captured", {
    signal,
    deliveredToNext: state.deliveredToNext,
  });
};
state.capture = capture;

for (const signal of SIGNALS) process.prependListener(signal, capture);

state.activate = (beginShutdown, installSignalHandlers) => {
  if (state.consumed) return false;
  if (
    typeof beginShutdown !== "function" ||
    typeof installSignalHandlers !== "function"
  ) {
    throw new TypeError("Brain startup shutdown activation needs two callbacks");
  }

  // Next installs both cleanup listeners before it loads instrumentation. If
  // that ordering changes, keep the startup watchdog armed and fail closed.
  for (const signal of SIGNALS) {
    const nextListenerInstalled = process
      .rawListeners(signal)
      .some((listener) => listener !== capture);
    if (!nextListenerInstalled) {
      throw new Error(`Next ${signal} shutdown listener is not installed`);
    }
  }

  // Latch shutdown before installing the ordinary app listeners. Late event
  // streams then close synchronously even if their request was accepted while
  // Next was still building its handlers.
  if (state.requested) beginShutdown();
  installSignalHandlers();

  state.consumed = true;
  for (const signal of SIGNALS) process.removeListener(signal, capture);
  if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);

  if (
    state.requested &&
    state.pendingSignal !== null &&
    !state.deliveredToNext &&
    !state.replayed
  ) {
    state.replayed = true;
    const signal = state.pendingSignal;
    setImmediate(() => {
      notify("brain-startup-signal-replayed", { signal });
      process.kill(process.pid, signal);
    });
  }

  return state.requested;
};

Object.seal(state);
Object.defineProperty(globalThis, STATE_KEY, {
  configurable: false,
  enumerable: false,
  writable: false,
  value: state,
});

// Standalone smoke only: report the exact moment Next accepts its authenticated
// queued request while instrumentation is paused. Production has neither this
// token nor an IPC channel, so the HTTP prototype remains untouched there.
const requestProbeToken =
  process.env.BRAIN_STANDALONE_STARTUP_BARRIER_TOKEN ?? "";
if (requestProbeToken && typeof process.send === "function") {
  const originalEmit = HttpServer.prototype.emit;
  let reported = false;
  HttpServer.prototype.emit = function emit(event, ...args) {
    if (
      !reported &&
      event === "request" &&
      args[0]?.headers?.["x-brain-standalone-startup-barrier"] ===
        requestProbeToken
    ) {
      reported = true;
      notify("brain-startup-request-accepted", { token: requestProbeToken });
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
}
