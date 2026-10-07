import { bodyHash, diffBodyPatch, type BodyPatch } from "./body-patch";
import { canonicalPageMarkdown } from "./page-markdown";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** A refusal a route wrote for the person to read: a reason code and a
 *  sentence to show as it stands. Only a 422 carries one. */
export interface SaveRefusal {
  error: string;
  message: string;
}

export class SaveRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly refusal?: SaveRefusal,
  ) {
    super(message);
    this.name = "SaveRequestError";
  }
}

/** The server holds a newer body this same tab sent (a closing-tab save that
 *  got there first). The older save stops: sending it again would put older
 *  text over newer, and reading it as a conflict would latch a page whose
 *  only other writer is the person themselves. */
export class SaveSupersededError extends SaveRequestError {
  constructor() {
    super("Superseded by a newer save from this tab");
    this.name = "SaveSupersededError";
  }
}

/** The body of a 422. A refusal with no readable body is still a refusal, so
 *  the caller keeps a sentence of its own for that case. */
async function readRefusal(response: Response): Promise<SaveRefusal | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && typeof body.message === "string") {
      return { error: body.error, message: body.message };
    }
  } catch {
    // Fall through: the status is what the caller acts on.
  }
  return undefined;
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

/** The save a tab sends as it goes away, sized for a keepalive request.
 *
 * It carries no full body. For each body the server may hold as far as this
 * tab knows (its confirmed base, and the bodies of its own saves still on the
 * wire) it carries the one span that turns that body into the newest one,
 * keyed by the body's hash; the server applies whichever span matches what it
 * holds, and refuses anything else as a conflict. Spans are added smallest
 * first while the request stays under `maxBytes`, so a long page with a few
 * typed words fits, and a huge paste the request cannot carry is null: its
 * draft stays in localStorage for the next load. */
export function encodeUnloadSaveRequest(
  markdown: string,
  revision: string,
  knownBodies: readonly string[],
  maxBytes: number,
): string | null {
  const newest = canonicalPageMarkdown(markdown);
  const seen = new Set<string>();
  const candidates: { patch: BodyPatch; size: number }[] = [];
  for (const known of knownBodies) {
    const body = canonicalPageMarkdown(known);
    if (seen.has(body)) continue;
    seen.add(body);
    const patch = { base: bodyHash(body), ...diffBodyPatch(body, newest) };
    candidates.push({ patch, size: JSON.stringify(patch).length });
  }
  candidates.sort((a, b) => a.size - b.size);
  const encoder = new TextEncoder();
  const patches: BodyPatch[] = [];
  let encoded: string | null = null;
  for (const { patch } of candidates.slice(0, 8)) {
    const next = JSON.stringify({ rev: revision, patches: [...patches, patch] });
    if (encoder.encode(next).byteLength > maxBytes) continue;
    patches.push(patch);
    encoded = next;
  }
  return encoded;
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
  /** Where this save goes. The owner writes to `/api/page/<id>`; a link
   *  visitor writes to `/api/share-edit/page/<id>?root=…&v=…`. The conflict
   *  GET uses the same URL, so both halves of the 409 dance stay on one route. */
  endpoint?: (id: string) => string;
  /** The closing-tab saves this tab sent for the page (canonical bodies),
   *  read afresh at each use because one can leave while this save is in
   *  flight. `newer` is the newest one sent after this edit: while it is
   *  outstanding this save is stale, goes without a base so the server cannot
   *  merge it over the newer body, and stops on a 409. `older` is the newest
   *  one sent at or before this edit, which the server may hold under
   *  somebody's tick. `bodies` is all of them. */
  ownSaves?: () => OwnSaves;
}

export interface OwnSaves {
  newer: string | undefined;
  older: string | undefined;
  bodies: readonly string[];
}

/** A closing-tab save as the tab remembers it. */
export interface SentUnloadSave {
  operationId: string;
  /** The order of the edit it carried; see `saveOperationSeq`. */
  seq: number;
  /** Canonical body. */
  markdown: string;
  /** True only once the tab lived to read a 2xx for it. */
  landed: boolean;
}

/** An edit id this tab minted reads `<client>:<seq>.<random>`, so the order
 *  of two edits is a number comparison. What came before this document's
 *  lifetime (a recovered draft, another tab's id, an older format) is 0:
 *  older than every edit made here, which is what it is. */
export function saveOperationSeq(operationId: string, clientId: string): number {
  const prefix = `${clientId}:`;
  if (!operationId.startsWith(prefix)) return 0;
  const seq = Number.parseInt(operationId.slice(prefix.length), 10);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
}

/** What the closing-tab saves sent for a page mean to one save, by order:
 *  the newest sent after its edit, and the newest sent at or before it. An
 *  edit made later is never stale behind a body that left before it existed,
 *  however it was queued. */
export function ownSavesAround(
  sent: readonly SentUnloadSave[],
  seq: number,
): OwnSaves {
  let newer: SentUnloadSave | undefined;
  let older: SentUnloadSave | undefined;
  for (const entry of sent) {
    if (entry.seq > seq) {
      if (!newer || entry.seq > newer.seq) newer = entry;
    } else if (!older || entry.seq > older.seq) {
      older = entry;
    }
  }
  return {
    newer: newer?.markdown,
    older: older?.markdown,
    bodies: sent.map((entry) => entry.markdown),
  };
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
  endpoint = (pageId: string) => `/api/page/${pageId}`,
  ownSaves,
}: SaveMarkdownOptions): Promise<string> {
  // Set once, for one retry: the body of this tab's own closing-tab save,
  // standing in for the base when the server holds it under a later tick.
  let ownBase: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response: Response;
    let attemptBaseMarkdown: string | undefined;
    try {
      attemptBaseMarkdown =
        ownSaves?.().newer !== undefined
          ? undefined
          : (ownBase ?? getBaseMarkdown?.());
      response = await fetcher(endpoint(id), {
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
      const payload = (await response.json()) as { rev?: unknown; markdown?: unknown };
      if (typeof payload.rev !== "string" || !payload.rev) {
        throw new SaveRequestError("Save response did not include a revision", response.status);
      }
      // The server merged somebody's tick into this body. The editor still
      // shows this body without it, so the next save must be merged too:
      // keep the rev this request carried, which tells the server the tab
      // has not seen the merged version, and keep this body as the base.
      // Taking the new rev would let the next save write the tick away.
      const merged =
        typeof payload.markdown === "string" &&
        canonicalPageMarkdown(payload.markdown) !== canonicalPageMarkdown(markdown);
      if (!merged) setRevision(payload.rev);
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
      const latest = await fetcher(endpoint(id));
      if (!latest.ok) {
        // The PUT was refused as a conflict. Failing to read the other
        // version does not make it something else, so the conflict is what
        // the caller is told about; a page that has gone keeps its own
        // status, which callers answer differently.
        throw new SaveRequestError(
          "Could not refresh the page revision",
          latest.status === 404 ? 404 : 409,
        );
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
        throw new SaveRequestError("Revision response was invalid", 409);
      }
      const sameAsLocal =
        payload.markdown === canonicalPageMarkdown(markdown);
      const own = ownSaves?.();
      // Behind a newer closing-tab save of this tab's own, this body is stale
      // whatever the server holds: the newer edit carries all of it and saves
      // next. Stopping here is not a conflict, and writing would put older
      // text over newer. The server's body becomes the base only when it is
      // exactly that newer body.
      if (!sameAsLocal && own?.newer !== undefined) {
        if (payload.markdown === own.newer) {
          setRevision(payload.rev);
          setBaseMarkdown?.(payload.markdown);
        }
        throw new SaveSupersededError();
      }
      const liveBase = getBaseMarkdown?.();
      // The live base moves under an in-flight save when SSE or a reload
      // adopts a server body, and then it must not authorize this write. It
      // also moves when a closing-tab save of this tab's own is seen to land,
      // and that body is no one else's.
      const baselineStillCurrent =
        (attemptBaseMarkdown === undefined
          ? liveBase === undefined
          : typeof liveBase === "string" &&
            canonicalPageMarkdown(liveBase) ===
              canonicalPageMarkdown(attemptBaseMarkdown)) ||
        (ownBase === undefined &&
          typeof liveBase === "string" &&
          own !== undefined &&
          own.bodies.includes(canonicalPageMarkdown(liveBase)));
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
      const sameAsBase =
        typeof trustedBase === "string" &&
        payload.markdown === canonicalPageMarkdown(trustedBase);
      // An older closing-tab save of this tab's own is no one else's edit:
      // over it this save goes ahead as over its base.
      const sameAsOwn = own?.older !== undefined && payload.markdown === own.older;
      if (sameAsLocal || sameAsBase || sameAsOwn) {
        setRevision(payload.rev);
        setBaseMarkdown?.(payload.markdown);
        if (attempt + 1 < maxAttempts) {
          await wait(attempt + 1);
          continue;
        }
      } else if (own?.older !== undefined && ownBase === undefined) {
        // The server holds something else: maybe that own save under a tick
        // from Tasks or a phone. Ask once more with its body as the base and
        // the ORIGINAL rev, so the server's tick merge decides. The rev is
        // never refreshed here: that would claim this tab saw the new body.
        ownBase = own.older;
        if (attempt + 1 < maxAttempts) continue;
      }
      throw new SaveRequestError("Page changed elsewhere", 409);
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt + 1 < maxAttempts) {
      await wait(attempt + 1);
      continue;
    }
    throw new SaveRequestError(
      `Save request returned ${response.status}`,
      response.status,
      response.status === 422 ? await readRefusal(response) : undefined,
    );
  }

  throw new SaveRequestError("Save attempts exhausted");
}

/** Whether a later attempt could succeed where this save failed: the network
 *  was down, or the server was busy or broken. A conflict, a refusal (422), a
 *  page that is gone and a superseded save are answers, and asking again gets
 *  the same one. */
export function isRetryableSaveFailure(error: unknown): boolean {
  if (!(error instanceof SaveRequestError) || error instanceof SaveSupersededError) {
    return false;
  }
  const { status } = error;
  return status === undefined || status === 429 || status >= 500;
}

/** How long a failed save waits before its next round, after `failures`
 *  failed rounds: 5 s, doubling, never more than a minute. A round is itself
 *  `saveMarkdown`'s three quick attempts. */
export function saveRetryDelay(failures: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, failures - 1));
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
