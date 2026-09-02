/** A tab that outlived its build.
 *
 *  A deploy swaps `current` to a new release, so every `/_next/static/chunks`
 *  URL the open tab still holds 404s. The shell navigates with pushState and
 *  loads its surfaces through `next/dynamic`, so Next's own build-id check on
 *  router navigations never runs here — the first surface the tab has not
 *  loaded yet throws a chunk-load error into the nearest error boundary, and
 *  `reset()` cannot help: React.lazy keeps the rejected promise, and the URL
 *  is gone anyway. The only recovery is a document reload, which fetches the
 *  new release's HTML and chunks.
 *
 *  Pure on purpose: no DOM at module scope, every browser global injected, so
 *  the classifier and the once-only guard are unit-testable and the two error
 *  screens can import this without pulling in anything that could crash. */

const CHUNK_LOAD_MESSAGES = [
  // webpack: "Loading chunk 42 failed." and "Loading CSS chunk 42 failed."
  /Loading (?:CSS )?chunk /i,
  // Turbopack, what Next 16 builds: "Failed to load chunk <url> from module <id>"
  /Failed to load chunk /i,
  // native import() in Chrome and Edge
  /Failed to fetch dynamically imported module/i,
  // native import() in Firefox
  /error loading dynamically imported module/i,
  // native import() in Safari
  /Importing a module script failed/i,
];

/** True for the error a browser raises when a script chunk cannot be fetched,
 *  in every spelling the bundlers and the major browsers use. A failed data
 *  `fetch()` is not one of them. */
export function isChunkLoadError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { name, message } = value as { name?: unknown; message?: unknown };
  // webpack and Turbopack both name the error
  if (name === "ChunkLoadError") return true;
  return (
    typeof message === "string" &&
    CHUNK_LOAD_MESSAGES.some((pattern) => pattern.test(message))
  );
}

/** The slice of `Storage` the guard needs. `sessionStorage` satisfies it. */
export interface ReloadMarkerStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ReloadGuardInput {
  /** Path and search of the document, the unit a reload is granted to. */
  url: string;
  /** Identity of the build this tab is running. */
  build: string;
  /** Null when the browser offers no storage; the guard then refuses to reload. */
  storage: ReloadMarkerStore | null;
}

const MARKER_PREFIX = "brain:chunk-reload:";

function readMarker(input: ReloadGuardInput): string | null | undefined {
  try {
    return input.storage?.getItem(MARKER_PREFIX + input.url);
  } catch {
    return undefined;
  }
}

/** Whether a chunk failure at `url` still earns a reload. One reload per URL
 *  per build: a marker records which build asked for it, so a second failure
 *  in the same build (the deploy itself is broken, or the server is still
 *  mid-swap) is "reloaded" and stops instead of looping the tab. A marker
 *  left by another build means the earlier reload did its job and this
 *  failure is new. With no storage to remember the attempt the loop cannot
 *  be bounded, so that is "unavailable" and nothing reloads. Read-only, so a
 *  boundary can call it during render. */
export function chunkReloadState(
  input: ReloadGuardInput,
): "reload" | "reloaded" | "unavailable" {
  const marker = readMarker(input);
  if (marker === undefined) return "unavailable";
  return marker === input.build ? "reloaded" : "reload";
}

/** `chunkReloadState`, then spend the reload: the marker is written before
 *  the caller reloads. */
export function planChunkReload(input: ReloadGuardInput): "reload" | "give-up" {
  if (chunkReloadState(input) !== "reload") return "give-up";
  try {
    input.storage?.setItem(MARKER_PREFIX + input.url, input.build);
  } catch {
    return "give-up";
  }
  return "reload";
}

/** Called once the document has booted. A marker written by a different build
 *  belongs to a reload that succeeded; clearing it keeps the next deploy's
 *  reload available. A marker from this build stays, so a boot-time failure
 *  right after a reload still meets the guard. */
export function settleChunkReload(input: ReloadGuardInput): void {
  const marker = readMarker(input);
  if (!marker || marker === input.build) return;
  try {
    input.storage?.removeItem(MARKER_PREFIX + input.url);
  } catch {
    // nothing to clear then
  }
}

export interface RecoveryInput extends ReloadGuardInput {
  /** `navigator.onLine`. A dropped connection throws the same error as a
   *  swapped release, and a reload then lands on the browser's network-error
   *  page with the app gone; absent means online. */
  online?: boolean;
}

export interface RecoveryDeps extends RecoveryInput {
  reload: () => void;
}

/** Stamped into every bundle by next.config's `env`; "development" under
 *  `next dev`, where there is no atomic swap to survive. */
const BUILD_ID: string = process.env.BRAIN_BUILD_SHA ?? "development";

function browserDeps(): RecoveryDeps {
  let storage: ReloadMarkerStore | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Safari with storage disabled throws on the accessor itself
  }
  return {
    url: window.location.pathname + window.location.search,
    build: BUILD_ID,
    storage,
    online: typeof navigator === "undefined" || navigator.onLine !== false,
    reload: () => window.location.reload(),
  };
}

/** What a boundary paints for `error`, read during render without touching
 *  the marker: "none" for an ordinary error, "offline" when a reload would
 *  only strand the tab, "reload" when the effect is about to reload the
 *  document, "reloaded" when this build already spent its reload here,
 *  "unavailable" when nothing can guard one. */
export function chunkRecoveryState(
  error: unknown,
  deps?: RecoveryInput,
): "none" | "offline" | "reload" | "reloaded" | "unavailable" {
  if (!isChunkLoadError(error)) return "none";
  // a boundary rendered on the server has no document to reload
  if (!deps && typeof window === "undefined") return "unavailable";
  const input = deps ?? browserDeps();
  if (input.online === false) return "offline";
  return chunkReloadState(input);
}

/** The one entry point the boundaries and the window listener call. Reloads
 *  the document when `error` is a chunk failure the guard still allows, and
 *  reports what it did. Offline spends no marker: the failure was not the
 *  deploy's, and the reload is owed once the connection is back. */
export function recoverFromStaleChunk(
  error: unknown,
  deps: RecoveryDeps = browserDeps(),
): "reload" | "give-up" | "offline" | "not-chunk" {
  if (!isChunkLoadError(error)) return "not-chunk";
  if (deps.online === false) return "offline";
  const plan = planChunkReload(deps);
  if (plan === "reload") deps.reload();
  return plan;
}

/** Boot-time hook for the layout host. */
export function settleStaleChunkRecovery(deps: ReloadGuardInput = browserDeps()): void {
  settleChunkReload(deps);
}

/** The slice of `window` the listener needs, so a test can hand it a bare
 *  EventTarget. */
export interface ListenerTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** A chunk that fails inside an event handler, an `import()` in a drop or a
 *  click, never reaches a React boundary: it surfaces as an unhandled
 *  rejection, or as a window error when the handler threw synchronously.
 *  Returns the teardown. */
export function listenForStaleChunks(
  target: ListenerTarget,
  recover: (error: unknown) => unknown = recoverFromStaleChunk,
): () => void {
  const onError = (event: Event) => {
    recover((event as { error?: unknown }).error);
  };
  const onRejection = (event: Event) => {
    recover((event as { reason?: unknown }).reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
