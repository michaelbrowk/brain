import { canonicalPageMarkdown } from "./page-markdown";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class SaveRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SaveRequestError";
  }
}

export interface DraftSource {
  key: string;
  operationId: string;
}

export interface StoredDraft {
  markdown: string;
  /** Revision the draft was based on. Null marks the legacy plain-text format,
   *  which must conflict rather than overwrite an unknown server version. */
  revision: string | null;
  /** Per-edit identity prevents an older same-body (ABA) save response from
   *  deleting a newer draft that happens to contain identical markdown. */
  operationId: string | null;
  /** Used only to choose a recovery candidate when several tab-scoped drafts
   * exist. Missing on older schema-v2 entries. */
  updatedAt: number | null;
  /** Last server-authoritative body paired with `revision`. Older drafts do
   * not have it and must keep failing closed on an ambiguous 409. */
  baseMarkdown: string | null;
  /** A genuine body conflict must not be auto-flushed again. The editor keeps
   * persisting newer local bodies, but recovery requires an explicit action. */
  conflicted: boolean;
  /** Older tab-scoped drafts adopted into this one. A successful save removes
   * each source only when that source still has the captured operation id. */
  sources: DraftSource[];
}

/** A conflict latch may outlive the transient condition that created it. On a
 * later page load it is safe to resume autosave only when the current server
 * body still matches either the draft's trusted base or the draft itself.
 * Anything else is a real content conflict and must stay fail-closed. */
export function canResumeConflictedDraft(
  draft: Pick<StoredDraft, "markdown" | "baseMarkdown">,
  serverMarkdown: string,
): boolean {
  const server = canonicalPageMarkdown(serverMarkdown);
  if (server === canonicalPageMarkdown(draft.markdown)) return true;
  return (
    draft.baseMarkdown !== null &&
    server === canonicalPageMarkdown(draft.baseMarkdown)
  );
}

const DRAFT_VERSION = 3;

function normalizeDraftSources(value: unknown): DraftSource[] {
  if (!Array.isArray(value)) return [];
  const sources: DraftSource[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as { key?: unknown }).key !== "string" ||
      typeof (item as { operationId?: unknown }).operationId !== "string"
    )
      continue;
    const source = item as DraftSource;
    if (!source.key || !source.operationId || seen.has(source.key)) continue;
    seen.add(source.key);
    sources.push({ key: source.key, operationId: source.operationId });
  }
  return sources;
}

/** Serialize the body-write contract. pagehide keepalive requests have a
 * browser-enforced 64 KiB body cap, so callers may ask to drop the optional
 * baseline before it turns an otherwise sendable draft into a rejected fetch. */
export function encodeSaveRequest(
  markdown: string,
  revision: string,
  baseMarkdown?: string,
  maxBytes = Number.POSITIVE_INFINITY,
): string {
  const withoutBase = { markdown, rev: revision };
  if (baseMarkdown === undefined) return JSON.stringify(withoutBase);
  const withBase = JSON.stringify({ ...withoutBase, baseMarkdown });
  return new TextEncoder().encode(withBase).byteLength <= maxBytes
    ? withBase
    : JSON.stringify(withoutBase);
}

export function encodeDraft(
  markdown: string,
  revision: string,
  operationId: string,
  updatedAt = Date.now(),
  baseMarkdown: string | null = null,
  conflicted = false,
  sources: DraftSource[] = [],
): string {
  return JSON.stringify({
    version: DRAFT_VERSION,
    markdown,
    revision,
    operationId,
    updatedAt,
    baseMarkdown,
    ...(conflicted ? { conflicted: true } : {}),
    ...(sources.length ? { sources: normalizeDraftSources(sources) } : {}),
  });
}

/** Keep the draft body even when duplicating a large server baseline would
 * exceed localStorage quota. Losing automatic metadata-conflict recovery is
 * safer than losing the edit itself. */
export function persistDraft(
  storage: Pick<Storage, "setItem">,
  key: string,
  markdown: string,
  revision: string,
  operationId: string,
  updatedAt = Date.now(),
  baseMarkdown: string | null = null,
  conflicted = false,
  sources: DraftSource[] = [],
): boolean {
  try {
    storage.setItem(
      key,
      encodeDraft(
        markdown,
        revision,
        operationId,
        updatedAt,
        baseMarkdown,
        conflicted,
        sources,
      ),
    );
    return true;
  } catch {
    if (baseMarkdown === null) return false;
    try {
      storage.setItem(
        key,
        encodeDraft(
          markdown,
          revision,
          operationId,
          updatedAt,
          null,
          conflicted,
          sources,
        ),
      );
      return true;
    } catch {
      return false;
    }
  }
}

interface ConflictDraft {
  markdown: string;
  revision: string;
  operationId: string;
  updatedAt?: number;
  baseMarkdown: string | null;
  sources?: DraftSource[];
}

export interface ConflictLatchResult {
  draft: StoredDraft;
  /** False means the exact draft exists only in the caller's live memory. */
  persisted: boolean;
}

/** Mark a draft as conflicted without letting a late response replace a newer
 * operation already stored for the same page. localStorage is synchronous, so
 * the read and guarded write form a client-side compare-and-swap. */
export function latchDraftConflict(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  fallback: ConflictDraft,
): ConflictLatchResult {
  let draft: ConflictDraft = fallback;
  try {
    const raw = storage.getItem(key);
    if (raw !== null) {
      const current = decodeDraft(raw);
      if (
        current.operationId !== null &&
        current.operationId !== fallback.operationId &&
        current.revision !== null
      ) {
        draft = {
          markdown: current.markdown,
          revision: current.revision,
          operationId: current.operationId,
          updatedAt: current.updatedAt ?? Date.now(),
          baseMarkdown: current.baseMarkdown,
          sources: current.sources,
        };
      } else if (current.operationId === fallback.operationId) {
        draft = {
          ...fallback,
          sources: normalizeDraftSources([
            ...current.sources,
            ...(fallback.sources ?? []),
          ]),
        };
      }
    }
  } catch {}

  const updatedAt = draft.updatedAt ?? Date.now();
  const persisted = persistDraft(
    storage,
    key,
    draft.markdown,
    draft.revision,
    draft.operationId,
    updatedAt,
    draft.baseMarkdown,
    true,
    draft.sources,
  );
  return {
    persisted,
    draft: {
      markdown: draft.markdown,
      revision: draft.revision,
      operationId: draft.operationId,
      updatedAt,
      baseMarkdown: draft.baseMarkdown,
      conflicted: true,
      sources: normalizeDraftSources(draft.sources),
    },
  };
}

export function decodeDraft(raw: string): StoredDraft {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      markdown?: unknown;
      revision?: unknown;
      operationId?: unknown;
      updatedAt?: unknown;
      baseMarkdown?: unknown;
      conflicted?: unknown;
      sources?: unknown;
    };
    if (
      parsed.version === DRAFT_VERSION &&
      typeof parsed.markdown === "string" &&
      typeof parsed.revision === "string" &&
      typeof parsed.operationId === "string" &&
      (typeof parsed.baseMarkdown === "string" || parsed.baseMarkdown === null)
    ) {
      return {
        markdown: parsed.markdown,
        revision: parsed.revision,
        operationId: parsed.operationId,
        updatedAt:
          typeof parsed.updatedAt === "number" &&
          Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : null,
        baseMarkdown: parsed.baseMarkdown,
        conflicted: parsed.conflicted === true,
        sources: normalizeDraftSources(parsed.sources),
      };
    }
    // Schema v2 added operation identities and timestamps, but did not retain
    // the server body needed to distinguish metadata-only revision changes.
    if (
      parsed.version === 2 &&
      typeof parsed.markdown === "string" &&
      typeof parsed.revision === "string" &&
      typeof parsed.operationId === "string"
    ) {
      return {
        markdown: parsed.markdown,
        revision: parsed.revision,
        operationId: parsed.operationId,
        updatedAt:
          typeof parsed.updatedAt === "number" &&
          Number.isFinite(parsed.updatedAt)
            ? parsed.updatedAt
            : null,
        baseMarkdown: null,
        conflicted: false,
        sources: [],
      };
    }
    // Short-lived v1 drafts from the reliability migration already contain a
    // base revision but predate operation identities.
    if (
      parsed.version === 1 &&
      typeof parsed.markdown === "string" &&
      typeof parsed.revision === "string"
    ) {
      return {
        markdown: parsed.markdown,
        revision: parsed.revision,
        operationId: null,
        updatedAt: null,
        baseMarkdown: null,
        conflicted: false,
        sources: [],
      };
    }
  } catch {
    // Existing drafts were stored as the raw markdown body.
  }
  return {
    markdown: raw,
    revision: null,
    operationId: null,
    updatedAt: null,
    baseMarkdown: null,
    conflicted: false,
    sources: [],
  };
}

/** Draft cleanup must be tied to the edit that created it, not its body.
 * Identical markdown can occur twice around an intervening edit (A-B-A). */
export function isDraftOperation(raw: string, operationId: string): boolean {
  return decodeDraft(raw).operationId === operationId;
}

interface SaveMarkdownOptions {
  fetcher: FetchLike;
  id: string;
  markdown: string;
  getRevision: () => string;
  setRevision: (revision: string) => void;
  getBaseMarkdown?: () => string | undefined;
  setBaseMarkdown?: (markdown: string) => void;
  wait?: (attempt: number) => Promise<void>;
  maxAttempts?: number;
}

/** Persist one markdown body, refreshing the optimistic-concurrency revision on
 * a 409 before retrying. Callers serialize this per page so consecutive saves
 * always observe the revision produced by the previous save. */
export async function saveMarkdown({
  fetcher,
  id,
  markdown,
  getRevision,
  setRevision,
  getBaseMarkdown,
  setBaseMarkdown,
  wait = () => new Promise((resolve) => setTimeout(resolve, 1500)),
  maxAttempts = 3,
}: SaveMarkdownOptions): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    let attemptBaseMarkdown: string | undefined;
    try {
      attemptBaseMarkdown = getBaseMarkdown?.();
      response = await fetcher(`/api/page/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: encodeSaveRequest(markdown, getRevision(), attemptBaseMarkdown),
      });
    } catch {
      if (attempt + 1 < maxAttempts) {
        await wait(attempt + 1);
        continue;
      }
      throw new SaveRequestError("Save request failed");
    }

    if (response.ok) {
      const payload = (await response.json()) as { rev?: unknown };
      if (typeof payload.rev !== "string" || !payload.rev) {
        throw new SaveRequestError("Save response did not include a revision", response.status);
      }
      setRevision(payload.rev);
      setBaseMarkdown?.(canonicalPageMarkdown(markdown));
      return payload.rev;
    }

    if (response.status === 409) {
      // Only legacy/schema-v2 drafts lack a locally trusted body baseline. The
      // server may recover that exact old revision from this page's Git history.
      // Never let a returned historical body replace a newer local baseline.
      let historicalBase: string | undefined;
      if (attemptBaseMarkdown === undefined) {
        try {
          const conflict = (await response.json()) as {
            baseMarkdown?: unknown;
          };
          if (typeof conflict.baseMarkdown === "string") {
            historicalBase = conflict.baseMarkdown;
          }
        } catch {
          // A malformed/missing conflict body simply keeps the safe 409 path.
        }
      }
      const latest = await fetcher(`/api/page/${id}`);
      if (!latest.ok) {
        throw new SaveRequestError("Could not refresh the page revision", latest.status);
      }
      const payload = (await latest.json()) as {
        markdown?: unknown;
        rev?: unknown;
      };
      if (
        typeof payload.markdown !== "string" ||
        typeof payload.rev !== "string" ||
        !payload.rev
      ) {
        throw new SaveRequestError("Revision response was invalid", latest.status);
      }
      const liveBase = getBaseMarkdown?.();
      const baselineStillCurrent =
        attemptBaseMarkdown === undefined
          ? liveBase === undefined
          : typeof liveBase === "string" &&
            canonicalPageMarkdown(liveBase) ===
              canonicalPageMarkdown(attemptBaseMarkdown);
      if (!baselineStillCurrent) {
        throw new SaveRequestError("Page changed elsewhere", 409);
      }
      // Body equality is not an acknowledgement: an older cross-tab PUT can
      // still land after this GET. Refresh the revision, but keep the draft and
      // require an explicit successful PUT before cleanup.
      // Compare only against the baseline that accompanied this rejected PUT.
      // An SSE/reload can update the caller's live ref while the conflict GET
      // is in flight; trusting that newer value would authorize overwriting it.
      const trustedBase = attemptBaseMarkdown ?? historicalBase;
      const sameAsLocal =
        payload.markdown === canonicalPageMarkdown(markdown);
      const sameAsBase =
        typeof trustedBase === "string" &&
        payload.markdown === canonicalPageMarkdown(trustedBase);
      if (sameAsLocal || sameAsBase) {
        setRevision(payload.rev);
        setBaseMarkdown?.(payload.markdown);
        if (attempt + 1 < maxAttempts) {
          await wait(attempt + 1);
          continue;
        }
      }
      throw new SaveRequestError("Page changed elsewhere", 409);
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt + 1 < maxAttempts) {
      await wait(attempt + 1);
      continue;
    }
    throw new SaveRequestError(`Save request returned ${response.status}`, response.status);
  }

  throw new SaveRequestError("Save attempts exhausted");
}

/** A tiny keyed promise queue. Failure in one task never poisons later work for
 * the same page, and different pages can save independently. */
export function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.catch(() => undefined).then(task);
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      const tail = settled.finally(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      tails.set(key, tail);
      return result;
    },
    has(key: string): boolean {
      return tails.has(key);
    },
    /** Wait for whatever is already running under this key, and for the queue's
     * own bookkeeping to catch up. A caller that has to decide "is this page
     * busy?" needs this first: for one microtask turn after a save resolves the
     * tail is still registered, and a page that finished saving a moment ago is
     * not an unsaved page. Never rejects — failure is the caller's to read from
     * its own task result. */
    settled(key: string): Promise<void> {
      const tail = tails.get(key);
      return tail
        ? tail.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
    },
  };
}
