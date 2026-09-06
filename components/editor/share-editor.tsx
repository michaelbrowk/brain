"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MilkdownEditor, type EditorCapabilities } from "./milkdown-editor";
import { retryFailedAttachmentImages, setAttachmentSrcResolver } from "./attachment-src";
import {
  canResumeConflictedDraft,
  createKeyedQueue,
  decodeDraft,
  encodeSaveRequest,
  isDraftOperation,
  persistDraft,
  saveMarkdown,
  SaveRequestError,
  type DraftSource,
} from "@/lib/autosave";
import { localAttachmentName } from "@/lib/attachments";
import { CLIENT_ID } from "@/lib/client";
import { canonicalPageMarkdown } from "@/lib/page-markdown";
import { Button } from "../ui/button";

/** Longer than the owner's 700 ms (components/shell.tsx). Every visitor save
 *  is a round trip plus a scheduled git commit, and the visitor write bucket
 *  is 60 per 60 seconds: at 2000 ms continuous typing spends at most half of
 *  it and leaves room for the conflict GET. */
export const SHARE_AUTOSAVE_DEBOUNCE_MS = 2000;

/** A draft or a parked body older than this is not offered back and is
 *  removed. Long enough for a laptop closed over a weekend; short enough that
 *  text from a link someone stopped using does not resurface a month later.
 *  The rev check still gates every write; this bounds the surprise. */
export const SHARE_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How often a mounted island says it is alive, and how long a silence
 *  means it is not. Three missed beats: a foreground tab beats on time and
 *  on every keystroke, and a tab that went hidden has already flushed its
 *  pending save, so a slot that is both silent for 30 s and still holding a
 *  draft belongs to a tab that is gone or whose save never landed. */
export const SHARE_HEARTBEAT_MS = 10_000;
export const SHARE_HEARTBEAT_STALE_MS = 30_000;

/** The double submit `lib/share-write.ts` checks against the edit cookie.
 *  Named here rather than imported: that module is server-only. */
const VID_HEADER = "x-brain-share-vid";

/** Browsers cap what a keepalive request may carry, 64 KiB in flight per
 *  page. Above it the base body is left off the PUT, as the owner does. */
const KEEPALIVE_BODY_BYTES = 60 * 1024;

const DRAFT_NAMESPACE = "brain-share-draft:";
const RECOVERY_NAMESPACE = "brain-share-recovery:";
const ALIVE_NAMESPACE = "brain-share-alive:";

export const SHARE_CONFLICT_COPY =
  "Someone else saved this page while you were writing. Your text is still here. Reload to see their version.";
export const SHARE_UNSAVED_COPY =
  "Your last change was not saved. Your text is still here. The next edit will try again.";
export const SHARE_GONE_COPY =
  "This page can no longer be edited through this link. Your text is still here, but it will not be saved.";
export const SHARE_RECOVERY_COPY =
  "Your text from before the reload is kept. Put it back in place of what is here, or dismiss it.";

/** Every visitor slot has the same shape: namespace, root, share version,
 *  page, tab. The version is there because every rotation bumps it (unshare
 *  and re-share, a password, an expiry, toggling edit): nothing written under
 *  a revoked link is offered under the re-issued one. The tab is there so
 *  two tabs never share a slot; a later visit scans the prefix instead. */
function slotPrefix(namespace: string, rootId: string, shareVersion: number, pageId: string) {
  return `${namespace}${rootId}:${shareVersion}:${pageId}:`;
}

export function shareDraftPrefix(rootId: string, shareVersion: number, pageId: string): string {
  return slotPrefix(DRAFT_NAMESPACE, rootId, shareVersion, pageId);
}

export function shareDraftKey(
  rootId: string,
  shareVersion: number,
  pageId: string,
  tabId: string = CLIENT_ID,
): string {
  return `${shareDraftPrefix(rootId, shareVersion, pageId)}${tabId}`;
}

/** Where the text goes when the visitor presses Reload on a conflict: the one
 *  state where it has nowhere else to live, because every later save 409s.
 *  A slot holds a list, appended to and never overwritten, and the next mount
 *  offers every parked body under the page's prefix back, newest first. */
export function shareRecoveryPrefix(rootId: string, shareVersion: number, pageId: string): string {
  return slotPrefix(RECOVERY_NAMESPACE, rootId, shareVersion, pageId);
}

export function shareRecoveryKey(
  rootId: string,
  shareVersion: number,
  pageId: string,
  tabId: string = CLIENT_ID,
): string {
  return `${shareRecoveryPrefix(rootId, shareVersion, pageId)}${tabId}`;
}

/** The heartbeat a mounted island keeps for its own draft slot, so a sibling
 *  tab can tell in-flight keystrokes from an abandoned draft. */
export function shareAlivePrefix(rootId: string, shareVersion: number, pageId: string): string {
  return slotPrefix(ALIVE_NAMESPACE, rootId, shareVersion, pageId);
}

export function shareAliveKey(
  rootId: string,
  shareVersion: number,
  pageId: string,
  tabId: string = CLIENT_ID,
): string {
  return `${shareAlivePrefix(rootId, shareVersion, pageId)}${tabId}`;
}

type SaveState = "ok" | "unsaved" | "gone" | "conflict";
type Pending = { markdown: string; operationId: string };
type Parked = { markdown: string; updatedAt: number };
type Recovered = Parked & { key: string };

/** The per-edit identity `StoredDraft.operationId` documents: what stops an
 *  older same-body save response from deleting a newer draft. Unique across
 *  mounts and tabs, never a counter. */
function newOperationId(tabId: string): string {
  const unique =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `${tabId}:${unique}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readParkedSlot(raw: string | null | undefined): Parked[] {
  if (typeof raw !== "string") return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const parked = entry as Partial<Parked> | null;
      return parked &&
        typeof parked.markdown === "string" &&
        typeof parked.updatedAt === "number"
        ? [{ markdown: parked.markdown, updatedAt: parked.updatedAt }]
        : [];
    });
  } catch {
    return [];
  }
}

function writeParkedSlot(store: Storage, key: string, entries: Parked[]): void {
  if (entries.length === 0) store.removeItem(key);
  else store.setItem(key, JSON.stringify(entries));
}

/** Read and merge, never a blind write: a body already parked under this
 *  slot stays beside the new one. The same text twice is one entry. */
function parkBody(store: Storage, key: string, markdown: string, now: number): void {
  const entries = readParkedSlot(store.getItem(key));
  const same = entries.find((entry) => entry.markdown === markdown);
  if (same) same.updatedAt = now;
  else entries.push({ markdown, updatedAt: now });
  writeParkedSlot(store, key, entries);
}

function dropParked(store: Storage, recovered: Recovered): void {
  const entries = readParkedSlot(store.getItem(recovered.key)).filter(
    (entry) =>
      entry.markdown !== recovered.markdown || entry.updatedAt !== recovered.updatedAt,
  );
  writeParkedSlot(store, recovered.key, entries);
}

function expired(updatedAt: number | null, now: number): boolean {
  return updatedAt === null || now - updatedAt > SHARE_DRAFT_MAX_AGE_MS;
}

function tabLooksAlive(store: Storage, aliveKey: string, now: number): boolean {
  const beat = Number(store.getItem(aliveKey));
  return Number.isFinite(beat) && beat > 0 && now - beat < SHARE_HEARTBEAT_STALE_MS;
}

/** Everything in the visitor namespaces past its bound, whatever page or
 *  version it belongs to. A slot orphaned by a rotation would otherwise stay
 *  in the browser for good. */
function sweepExpired(store: Storage, now: number): void {
  const gone: string[] = [];
  const rewrite: Array<[string, Parked[]]> = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (!key) continue;
    if (key.startsWith(DRAFT_NAMESPACE)) {
      const raw = store.getItem(key);
      if (raw === null || expired(decodeDraft(raw).updatedAt, now)) gone.push(key);
    } else if (key.startsWith(RECOVERY_NAMESPACE)) {
      const entries = readParkedSlot(store.getItem(key));
      const kept = entries.filter((entry) => !expired(entry.updatedAt, now));
      if (kept.length === 0) gone.push(key);
      else if (kept.length !== entries.length) rewrite.push([key, kept]);
    } else if (key.startsWith(ALIVE_NAMESPACE)) {
      if (!tabLooksAlive(store, key, now)) gone.push(key);
    }
  }
  for (const key of gone) store.removeItem(key);
  for (const [key, entries] of rewrite) writeParkedSlot(store, key, entries);
}

type SlotKeys = {
  tabId: string;
  draftPrefix: string;
  recoveryPrefix: string;
  alivePrefix: string;
};

/** What the editor opens with, decided before it mounts because it reads its
 *  value once. The newest draft under this page's prefix whose tab is not
 *  alive is one of three things: already what the server holds (drop it),
 *  ours to save because the body did not move meanwhile (save it now, on the
 *  current rev), or behind someone else's newer body (show it behind the
 *  conflict banner with its stale rev, so a later edit cannot overwrite
 *  theirs by accident). Every parked body under the page's prefix is offered
 *  back beside any of the three, and before them. */
type Opening = {
  markdown: string;
  revision: string;
  base: string;
  pending: Pending | null;
  /** The draft slot the body came from, removed once the server confirms it
   *  and it still holds that edit. */
  source: DraftSource | null;
  saveState: SaveState;
  action: "none" | "discard" | "save";
  recoveries: Recovered[];
};

function readOpening(keys: SlotKeys, initialMarkdown: string, initialRev: string): Opening {
  const plain: Opening = {
    markdown: initialMarkdown,
    revision: initialRev,
    base: initialMarkdown,
    pending: null,
    source: null,
    saveState: "ok",
    action: "none",
    recoveries: [],
  };
  const store = storage();
  if (!store) return plain;
  try {
    const now = Date.now();
    sweepExpired(store, now);
    const recoveries: Recovered[] = [];
    const candidates: Array<{ key: string; draft: ReturnType<typeof decodeDraft> }> = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key) continue;
      if (key.startsWith(keys.recoveryPrefix)) {
        for (const parked of readParkedSlot(store.getItem(key))) {
          recoveries.push({ ...parked, key });
        }
      } else if (key.startsWith(keys.draftPrefix)) {
        const tab = key.slice(keys.draftPrefix.length);
        // A sibling tab that is still alive is mid-edit, not abandoned. Its
        // text is its own to save; taking it would hand it a conflict with
        // itself.
        if (tab !== keys.tabId && tabLooksAlive(store, `${keys.alivePrefix}${tab}`, now)) {
          continue;
        }
        const raw = store.getItem(key);
        if (raw !== null) candidates.push({ key, draft: decodeDraft(raw) });
      }
    }
    recoveries.sort((a, b) => b.updatedAt - a.updatedAt);
    candidates.sort((a, b) => (b.draft.updatedAt ?? 0) - (a.draft.updatedAt ?? 0));
    const newest = candidates[0];
    if (!newest) return { ...plain, recoveries };
    const { key, draft } = newest;
    if (canonicalPageMarkdown(draft.markdown) === canonicalPageMarkdown(initialMarkdown)) {
      return {
        ...plain,
        recoveries,
        source: { key, operationId: draft.operationId ?? "" },
        action: "discard",
      };
    }
    const pending: Pending = {
      markdown: draft.markdown,
      operationId: draft.operationId ?? newOperationId(keys.tabId),
    };
    const source: DraftSource = { key, operationId: pending.operationId };
    // The rev alone is not the test: a rename or an icon bumps it with the
    // body untouched, and that is not a stranger's edit.
    if (draft.revision === initialRev || canResumeConflictedDraft(draft, initialMarkdown)) {
      return { ...plain, recoveries, markdown: draft.markdown, pending, source, action: "save" };
    }
    return {
      markdown: draft.markdown,
      revision: draft.revision ?? "",
      base: draft.baseMarkdown ?? "",
      pending,
      source,
      saveState: "conflict",
      action: "none",
      recoveries,
    };
  } catch {
    return plain;
  }
}

interface ShareEditorProps {
  rootId: string;
  pageId: string;
  shareVersion: number;
  vid: string;
  initialMarkdown: string;
  initialRev: string;
  onReload?: () => void;
}

/** Everything the island captures (the opening, the rev, the base, the
 *  pending edit) belongs to one page of one link. A different page is a
 *  different island, whatever the caller does with keys. */
export default function ShareEditor(props: ShareEditorProps) {
  return (
    <ShareEditorForPage
      key={`${props.rootId}:${props.shareVersion}:${props.pageId}`}
      {...props}
    />
  );
}

function ShareEditorForPage({
  rootId,
  pageId,
  shareVersion,
  vid,
  initialMarkdown,
  initialRev,
  onReload = () => location.reload(),
}: ShareEditorProps) {
  // This island's identity for the life of the mount: the slots it writes
  // and the beat it keeps are its own, whatever the module says later.
  const [tabId] = useState(() => CLIENT_ID);
  const keys = useMemo<SlotKeys>(
    () => ({
      tabId,
      draftPrefix: shareDraftPrefix(rootId, shareVersion, pageId),
      recoveryPrefix: shareRecoveryPrefix(rootId, shareVersion, pageId),
      alivePrefix: shareAlivePrefix(rootId, shareVersion, pageId),
    }),
    [pageId, rootId, shareVersion, tabId],
  );
  const draftKey = `${keys.draftPrefix}${tabId}`;
  const recoveryKey = `${keys.recoveryPrefix}${tabId}`;
  const aliveKey = `${keys.alivePrefix}${tabId}`;
  const [opening] = useState(() => readOpening(keys, initialMarkdown, initialRev));
  const [markdown, setMarkdown] = useState(opening.markdown);
  // The editor reads its value once; putting a parked body back remounts it.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>(opening.saveState);
  const [recoveries, setRecoveries] = useState<Recovered[]>(opening.recoveries);
  const revision = useRef(opening.revision);
  const base = useRef(opening.base);
  const latest = useRef(opening.markdown);
  // The body the server does not have yet, and the edit that produced it.
  const pending = useRef<Pending | null>(opening.pending);
  const source = useRef<DraftSource | null>(opening.source);
  const conflicted = useRef(opening.saveState === "conflict");
  const flushOnNextChange = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorFlush = useRef<() => void>(() => {});
  // One save in flight per page, so a second PUT always carries the rev the
  // first one produced instead of racing it into a spurious 409.
  const [queue] = useState(createKeyedQueue);

  const query = `root=${encodeURIComponent(rootId)}&v=${shareVersion}`;
  const pageEndpoint = `/api/share-edit/page/${pageId}?${query}`;
  const vidHeaders = useMemo(() => ({ [VID_HEADER]: vid }), [vid]);

  const fetcher = useCallback<typeof fetch>(
    (input, init = {}) =>
      fetch(input, {
        ...init,
        headers: {
          ...((init.headers as Record<string, string>) ?? {}),
          ...vidHeaders,
        },
      }),
    [vidHeaders],
  );

  useEffect(() => {
    setAttachmentSrcResolver((url) => {
      const name = localAttachmentName(url);
      if (!name) return url;
      return `/api/media/${name}?root=${encodeURIComponent(rootId)}&page=${encodeURIComponent(pageId)}&v=${shareVersion}`;
    });
    return () => setAttachmentSrcResolver(null);
  }, [pageId, rootId, shareVersion]);

  const beat = useCallback(() => {
    try {
      storage()?.setItem(aliveKey, String(Date.now()));
    } catch {
      // Without storage there is no draft to guard either.
    }
  }, [aliveKey]);

  // Alive while mounted: on mount, every SHARE_HEARTBEAT_MS, on every change
  // (below), on coming back into view or out of the back-forward cache. The
  // beat is taken down on pagehide and on unmount, so a closed tab reads as
  // gone at once and a crashed one after the staleness window.
  useEffect(() => {
    const stop = () => {
      try {
        storage()?.removeItem(aliveKey);
      } catch {
        // Same as above.
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") beat();
    };
    beat();
    const interval = setInterval(beat, SHARE_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", beat);
    window.addEventListener("pagehide", stop);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", beat);
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, [aliveKey, beat]);

  /** The slot a restored body came from goes only while it still holds that
   *  edit; another tab may have written a newer body there since. */
  const dropSource = useCallback(() => {
    const from = source.current;
    if (!from) return;
    try {
      const store = storage();
      const raw = store?.getItem(from.key);
      if (typeof raw === "string" && isDraftOperation(raw, from.operationId)) {
        store?.removeItem(from.key);
      }
    } catch {
      // Storage that cannot be cleared held nothing that matters now.
    }
    source.current = null;
  }, []);

  const persist = useCallback(
    (entry: Pending) => {
      const store = storage();
      if (!store) return;
      persistDraft(
        store,
        draftKey,
        entry.markdown,
        revision.current,
        entry.operationId,
        Date.now(),
        base.current,
        conflicted.current,
        source.current ? [source.current] : [],
      );
    },
    [draftKey],
  );

  const save = useCallback(
    async (entry: Pending) => {
      try {
        await saveMarkdown({
          fetcher,
          id: pageId,
          markdown: entry.markdown,
          getRevision: () => revision.current,
          setRevision: (value) => {
            revision.current = value;
          },
          getBaseMarkdown: () => base.current,
          setBaseMarkdown: (value) => {
            base.current = value;
          },
          endpoint: () => pageEndpoint,
        });
        // The draft goes only when it still holds this exact edit; a newer
        // keystroke may have replaced it while the request was out.
        try {
          const store = storage();
          const raw = store?.getItem(draftKey);
          if (typeof raw === "string" && isDraftOperation(raw, entry.operationId)) {
            store?.removeItem(draftKey);
          }
        } catch {
          // Same as above.
        }
        dropSource();
        conflicted.current = false;
        setSaveState("ok");
        // An image uploaded moments ago was refused by the media route until
        // this page referenced it. Now it does.
        retryFailedAttachmentImages();
      } catch (error) {
        // Still unsaved: a later flush must find it, unless a newer edit has
        // already taken its place.
        if (!pending.current) pending.current = entry;
        const status = error instanceof SaveRequestError ? error.status : undefined;
        if (status === 409) {
          // Two strangers, not one person with two tabs: the text stays, and
          // Reload is a press, never something that happens to them.
          conflicted.current = true;
          setSaveState("conflict");
        } else if (status === 404) {
          // The guard's one answer for a link that no longer grants a write:
          // revoked, expired, rotated, or the page is gone. Nothing the
          // visitor types will land, and they should know that now.
          setSaveState("gone");
        } else {
          // A rate limit, an outage, a dropped connection. The draft keeps
          // the text; the next edit is another attempt.
          setSaveState("unsaved");
        }
      }
    },
    [draftKey, dropSource, fetcher, pageEndpoint, pageId],
  );

  /** Takes the pending edit out before dispatching it, so a flush that lands
   *  during the request finds nothing to send again. In a conflict nothing is
   *  sent: every later save would 409, and the visitor decides with Reload. */
  const runPending = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    if (!next || conflicted.current) return;
    pending.current = null;
    void queue.run(pageId, () => save(next));
  }, [pageId, queue, save]);

  const onChange = useCallback(
    (next: string) => {
      setMarkdown(next);
      latest.current = next;
      beat();
      const entry: Pending = { markdown: next, operationId: newOperationId(tabId) };
      pending.current = entry;
      // Every change is a draft first. The 2000 ms below is exactly the
      // window a closed tab would otherwise lose.
      persist(entry);
      if (conflicted.current) return;
      if (flushOnNextChange.current) {
        flushOnNextChange.current = false;
        runPending();
        return;
      }
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        runPending();
      }, SHARE_AUTOSAVE_DEBOUNCE_MS);
    },
    [beat, persist, runPending, tabId],
  );

  // The one write `readOpening` decided on. `opening` never changes.
  useEffect(() => {
    if (opening.action === "discard") {
      try {
        if (opening.source) storage()?.removeItem(opening.source.key);
      } catch {
        // Nothing to keep.
      }
      source.current = null;
    } else if (opening.action === "save") {
      runPending();
    }
  }, [opening, runPending]);

  // Save as soon as the tab backgrounds; pagehide adds a keepalive request
  // that survives the unload. The draft remains until a confirmed response.
  const flushPending = useCallback(() => {
    editorFlush.current();
    runPending();
  }, [runPending]);
  const flushKeepalive = useCallback(() => {
    editorFlush.current();
    const next = pending.current;
    if (!next || conflicted.current || queue.has(pageId)) return;
    void fetch(pageEndpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...vidHeaders },
      body: encodeSaveRequest(
        next.markdown,
        revision.current,
        base.current,
        KEEPALIVE_BODY_BYTES,
      ),
      keepalive: true,
    }).catch(() => {});
  }, [pageEndpoint, pageId, queue, vidHeaders]);
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPending();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", flushPending);
    window.addEventListener("pagehide", flushKeepalive);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", flushPending);
      window.removeEventListener("pagehide", flushKeepalive);
    };
  }, [flushKeepalive, flushPending]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const registerFlush = useCallback((flush: () => void) => {
    editorFlush.current = flush;
    return () => {
      if (editorFlush.current === flush) editorFlush.current = () => {};
    };
  }, []);

  const capabilities = useMemo<EditorCapabilities>(
    () => ({
      upload: {
        endpoint: `/api/share-edit/upload?${query}&page=${encodeURIComponent(pageId)}`,
        fetcher,
        headers: vidHeaders,
        onUploaded: () => {
          flushOnNextChange.current = true;
        },
      },
    }),
    [fetcher, pageId, query, vidHeaders],
  );

  /** "Show me their version." The text is parked first, beside anything
   *  already parked, so the sentence in the banner stays true; the draft
   *  goes, or the reload would bring this same banner straight back. */
  const reloadIntoTheirs = () => {
    try {
      const store = storage();
      if (store) {
        parkBody(store, recoveryKey, latest.current, Date.now());
        store.removeItem(draftKey);
      }
    } catch {
      // The reload still happens; the text is at least in the editor now.
    }
    dropSource();
    onReload();
  };

  const offered = recoveries[0] ?? null;

  const settleOffered = () => {
    if (!offered) return null;
    try {
      const store = storage();
      if (store) dropParked(store, offered);
    } catch {
      // Nothing to keep.
    }
    setRecoveries((rest) => rest.filter((entry) => entry !== offered));
    return offered;
  };

  const putParkedBack = () => {
    const taken = settleOffered();
    if (!taken) return;
    setMarkdown(taken.markdown);
    latest.current = taken.markdown;
    setEditorEpoch((epoch) => epoch + 1);
    const entry: Pending = { markdown: taken.markdown, operationId: newOperationId(tabId) };
    pending.current = entry;
    persist(entry);
    runPending();
  };

  const notice =
    saveState === "conflict"
      ? SHARE_CONFLICT_COPY
      : saveState === "gone"
        ? SHARE_GONE_COPY
        : saveState === "unsaved"
          ? SHARE_UNSAVED_COPY
          : null;
  const bannerClass =
    "mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-[var(--fill-tint)] py-2 pl-4 text-table text-ink";

  return (
    <div data-share-editor>
      {/* One banner at a time. A parked body needs a decision before any
          other state makes sense, so it comes first. */}
      {offered ? (
        <div data-share-recovery role="status" className={`${bannerClass} pr-2`}>
          <span className="min-w-0 flex-1">{SHARE_RECOVERY_COPY}</span>
          <span className="flex items-center gap-1">
            <Button type="button" variant="quiet" onClick={putParkedBack}>
              Put it back
            </Button>
            <Button type="button" variant="quiet" onClick={() => void settleOffered()}>
              Dismiss
            </Button>
          </span>
        </div>
      ) : (
        notice && (
          <div
            data-share-save-state={saveState}
            role="status"
            className={`${bannerClass} ${saveState === "conflict" ? "pr-2" : "pr-4"}`}
          >
            <span className="min-w-0 flex-1">{notice}</span>
            {saveState === "conflict" && (
              <Button type="button" variant="quiet" onClick={reloadIntoTheirs}>
                Reload
              </Button>
            )}
          </div>
        )
      )}
      <MilkdownEditor
        key={editorEpoch}
        value={markdown}
        onChange={onChange}
        registerFlush={registerFlush}
        capabilities={capabilities}
      />
    </div>
  );
}
