import { describe, expect, it, vi } from "vitest";

import {
  chunkRecoveryState,
  isChunkLoadError,
  listenForStaleChunks,
  planChunkReload,
  recoverFromStaleChunk,
  settleChunkReload,
  type ReloadMarkerStore,
} from "./stale-chunk";

function memoryStore(): ReloadMarkerStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function throwingStore(): ReloadMarkerStore {
  const deny = () => {
    throw new Error("SecurityError: sessionStorage is disabled");
  };
  return { getItem: deny, setItem: deny, removeItem: deny };
}

describe("isChunkLoadError", () => {
  it.each([
    // webpack and Turbopack both name the error; the message is secondary
    ["ChunkLoadError", "anything at all"],
    // webpack JS and CSS chunks
    ["Error", "Loading chunk 4211 failed.\n(error: https://brain.example/_next/static/chunks/4211.js)"],
    ["Error", "Loading CSS chunk 12 failed.\n(https://brain.example/_next/static/css/12.css)"],
    // Turbopack, as built by Next 16 (the name is also set, tested by message alone here)
    [
      "Error",
      "Failed to load chunk static/chunks/components_mail-surface_tsx_0a1b2c.js from module [project]/components/shell.tsx: Error: script error",
    ],
    // native import() in Chrome / Edge
    ["TypeError", "Failed to fetch dynamically imported module: https://brain.example/_next/static/chunks/x.js"],
    // native import() in Firefox
    ["TypeError", "error loading dynamically imported module: https://brain.example/_next/static/chunks/x.js"],
    // native import() in Safari
    ["TypeError", "Importing a module script failed."],
  ])("recognises %s: %s", (name, message) => {
    const error = new Error(message);
    error.name = name;
    expect(isChunkLoadError(error)).toBe(true);
  });

  it("ignores ordinary errors and non-errors", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    // a failed data fetch is not a failed script
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(new Error("Something else broke"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError("Loading chunk 1 failed")).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });
});

describe("planChunkReload", () => {
  it("reloads on the first failure at a URL and records it", () => {
    const storage = memoryStore();
    expect(planChunkReload({ url: "/p/abc", build: "b1", storage })).toBe("reload");
    expect([...storage.data.values()]).toEqual(["b1"]);
  });

  it("does not reload a second time at the same URL in the same build", () => {
    const storage = memoryStore();
    planChunkReload({ url: "/p/abc", build: "b1", storage });
    expect(planChunkReload({ url: "/p/abc", build: "b1", storage })).toBe("give-up");
  });

  it("reloads again at a different URL", () => {
    const storage = memoryStore();
    planChunkReload({ url: "/p/abc", build: "b1", storage });
    expect(planChunkReload({ url: "/mail", build: "b1", storage })).toBe("reload");
  });

  it("reloads again when the earlier reload already moved the tab to a new build", () => {
    const storage = memoryStore();
    planChunkReload({ url: "/p/abc", build: "b1", storage });
    expect(planChunkReload({ url: "/p/abc", build: "b2", storage })).toBe("reload");
    // and that reload is the last one for b2 at this URL
    expect(planChunkReload({ url: "/p/abc", build: "b2", storage })).toBe("give-up");
  });

  it("gives up rather than loop when nothing can remember the attempt", () => {
    expect(planChunkReload({ url: "/p/abc", build: "b1", storage: null })).toBe("give-up");
    expect(planChunkReload({ url: "/p/abc", build: "b1", storage: throwingStore() })).toBe("give-up");
  });
});

describe("chunkRecoveryState", () => {
  // what a boundary reads during render, before its effect acts: pure, and
  // it must not touch the marker
  const chunkError = () => {
    const error = new Error("Loading chunk 7 failed.");
    error.name = "ChunkLoadError";
    return error;
  };

  it("is none for an error that is not a chunk failure", () => {
    const storage = memoryStore();
    expect(
      chunkRecoveryState(new Error("boom"), { url: "/p/abc", build: "b1", storage }),
    ).toBe("none");
  });

  it("plans a reload for a first failure and leaves the marker alone", () => {
    const storage = memoryStore();
    expect(chunkRecoveryState(chunkError(), { url: "/p/abc", build: "b1", storage })).toBe(
      "reload",
    );
    expect(storage.data.size).toBe(0);
  });

  it("reports the reload already spent in this build", () => {
    const storage = memoryStore();
    planChunkReload({ url: "/p/abc", build: "b1", storage });
    expect(chunkRecoveryState(chunkError(), { url: "/p/abc", build: "b1", storage })).toBe(
      "reloaded",
    );
    expect(chunkRecoveryState(chunkError(), { url: "/p/abc", build: "b2", storage })).toBe(
      "reload",
    );
  });

  it("is unavailable without a storage to guard the reload", () => {
    expect(chunkRecoveryState(chunkError(), { url: "/p/abc", build: "b1", storage: null })).toBe(
      "unavailable",
    );
    expect(
      chunkRecoveryState(chunkError(), { url: "/p/abc", build: "b1", storage: throwingStore() }),
    ).toBe("unavailable");
  });
});

describe("settleChunkReload", () => {
  it("clears the marker once the tab is on a build other than the one that failed", () => {
    const storage = memoryStore();
    planChunkReload({ url: "/p/abc", build: "b1", storage });
    settleChunkReload({ url: "/p/abc", build: "b2", storage });
    expect(storage.data.size).toBe(0);
  });

  it("keeps the marker while the tab is still on the build that failed", () => {
    const storage = memoryStore();
    planChunkReload({ url: "/p/abc", build: "b1", storage });
    settleChunkReload({ url: "/p/abc", build: "b1", storage });
    expect(storage.data.size).toBe(1);
  });

  it("survives a storage that throws", () => {
    expect(() =>
      settleChunkReload({ url: "/p/abc", build: "b1", storage: throwingStore() }),
    ).not.toThrow();
  });
});

describe("recoverFromStaleChunk", () => {
  const chunkError = () => {
    const error = new Error("Failed to load chunk static/chunks/x.js from module y");
    error.name = "ChunkLoadError";
    return error;
  };

  it("reloads once for a chunk error and reports the outcome", () => {
    const storage = memoryStore();
    const reload = vi.fn();
    const deps = { url: "/p/abc", build: "b1", storage, reload };
    expect(recoverFromStaleChunk(chunkError(), deps)).toBe("reload");
    expect(recoverFromStaleChunk(chunkError(), deps)).toBe("give-up");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves other errors alone", () => {
    const reload = vi.fn();
    expect(
      recoverFromStaleChunk(new TypeError("x is not a function"), {
        url: "/p/abc",
        build: "b1",
        storage: memoryStore(),
        reload,
      }),
    ).toBe("not-chunk");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("listenForStaleChunks", () => {
  // Node has EventTarget but no ErrorEvent / PromiseRejectionEvent; the
  // listener only reads `.error` and `.reason`, so a plain Event carrying
  // them is the same shape the browser hands over.
  const chunkError = () => {
    const error = new Error("Failed to load chunk static/chunks/x.js from module y");
    error.name = "ChunkLoadError";
    return error;
  };

  it("hands a thrown chunk error to the recovery", () => {
    const target = new EventTarget();
    const recover = vi.fn();
    listenForStaleChunks(target, recover);
    const error = chunkError();
    target.dispatchEvent(Object.assign(new Event("error"), { error }));
    expect(recover).toHaveBeenCalledWith(error);
  });

  it("hands a rejected import() to the recovery", () => {
    const target = new EventTarget();
    const recover = vi.fn();
    listenForStaleChunks(target, recover);
    const reason = chunkError();
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
    expect(recover).toHaveBeenCalledWith(reason);
  });

  it("stops listening when told to", () => {
    const target = new EventTarget();
    const recover = vi.fn();
    const stop = listenForStaleChunks(target, recover);
    stop();
    target.dispatchEvent(Object.assign(new Event("error"), { error: chunkError() }));
    target.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), { reason: chunkError() }),
    );
    expect(recover).not.toHaveBeenCalled();
  });
});
