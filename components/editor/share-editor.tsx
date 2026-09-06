"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MilkdownEditor, type EditorCapabilities } from "./milkdown-editor";
import { retryFailedAttachmentImages, setAttachmentSrcResolver } from "./attachment-src";
import { setPageRefHrefResolver } from "./page-ref";
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
import { formatAgo } from "@/lib/format-ago";
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

/** How many parked bodies a page keeps, across every tab's slot. The newest
 *  is the one the visitor is most likely to want back; beyond this the
 *  oldest go. Five is a conflict a day for a working week, and well under
 *  what a full quota could refuse. */
export const SHARE_PARKED_MAX = 5;

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
  "Your last change was not saved. Your text is still here. Keep typing and it will try again.";
export const SHARE_GONE_COPY =
  "This page can no longer be edited through this link. Nothing more will be saved. Copy your text somewhere before you close this tab.";
/** The offer of one parked body. It names when the text was written and how
 *  many are queued behind it, because up to SHARE_PARKED_MAX are offered one
 *  at a time with the same sentence and a visitor cannot otherwise tell one
 *  from another. The count is left off when this is the only one. */
export function shareRecoveryCopy(updatedAt: number, remaining: number): string {
  const when = formatAgo(new Date(updatedAt).toISOString());
  const count = remaining > 1 ? ` (1 of ${remaining})` : "";
  return `Your text from ${when} is kept${count}. Put it back in place of what is here, or discard it for good.`;
}
/** The second press. Discarding removes the only copy: the draft went when
 *  the conflicted reload parked this body, so nothing else holds it. */
export const SHARE_DISCARD_CONFIRM_COPY =
  "This is the only copy of that text. Discard it for good?";
export const SHARE_STORAGE_FULL_COPY =
  "This browser's storage is full, so your text cannot be kept through a reload. Copy it somewhere first. Reloading now would lose it.";

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

/** `storage` is not a save outcome: it is the one press that could not be
 *  honoured, a Reload with nowhere to keep the text. */
type SaveState = "ok" | "unsaved" | "gone" | "conflict" | "storage";
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

function parkedSlotsUnder(store: Storage, prefix: string): Array<[string, Parked[]]> {
  const slots: Array<[string, Parked[]]> = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith(prefix)) slots.push([key, readParkedSlot(store.getItem(key))]);
  }
  return slots;
}

/** The page-wide cap: across every slot under the prefix the newest
 *  SHARE_PARKED_MAX stay and the oldest go, `keep` always among the stayers.
 *  Only shrinking writes, each on its own so one refusal does not stop the
 *  rest. Returns the entries the slot at `own` should now hold. */
function trimParked(
  store: Storage,
  prefix: string,
  own: [string, Parked[]] | null,
  keep: Parked | null,
): Parked[] {
  const slots = parkedSlotsUnder(store, prefix).filter(([key]) => key !== own?.[0]);
  if (own) slots.push(own);
  const all = slots.flatMap(([key, entries]) => entries.map((entry) => ({ key, entry })));
  all.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
  const dropped = new Set(all.slice(SHARE_PARKED_MAX).map((item) => item.entry));
  if (keep) dropped.delete(keep);
  let ownKept: Parked[] = [];
  for (const [key, entries] of slots) {
    const kept = entries.filter((entry) => !dropped.has(entry));
    if (key === own?.[0]) {
      ownKept = kept;
      continue;
    }
    if (kept.length === entries.length) continue;
    try {
      writeParkedSlot(store, key, kept);
    } catch {
      // A slot that cannot shrink keeps what it had; the sweep tries again.
    }
  }
  return ownKept;
}

/** Read and merge, never a blind write: a body already parked under this
 *  slot stays beside the new one, the same text twice is one entry, and the
 *  page's cap drops the oldest first. When storage refuses the write, the
 *  slot is retried smaller, oldest out first, down to the body being parked
 *  alone. Returns whether that body is on disk. */
function parkBody(
  store: Storage,
  prefix: string,
  key: string,
  markdown: string,
  now: number,
): boolean {
  const entries = readParkedSlot(store.getItem(key));
  const same = entries.find((entry) => entry.markdown === markdown);
  const fresh: Parked = same ?? { markdown, updatedAt: now };
  fresh.updatedAt = now;
  if (!same) entries.push(fresh);
  let own = trimParked(store, prefix, [key, entries], fresh);
  for (;;) {
    try {
      writeParkedSlot(store, key, own);
      return true;
    } catch {
      if (own.length <= 1) return false;
      const oldest = own.reduce((a, b) => (a.updatedAt <= b.updatedAt && a !== fresh ? a : b));
      own = own.filter((entry) => entry !== oldest);
    }
  }
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

/** A beat is alive inside the staleness window and no more than one
 *  interval ahead of now. Further ahead is a clock glitch or a restored
 *  snapshot, and a beat that reads as fresh forever would lock its slot
 *  away from every future tab; it is stale, and swept. */
function tabLooksAlive(store: Storage, aliveKey: string, now: number): boolean {
  const beat = Number(store.getItem(aliveKey));
  if (!Number.isFinite(beat) || beat <= 0) return false;
  const age = now - beat;
  return age >= -SHARE_HEARTBEAT_MS && age < SHARE_HEARTBEAT_STALE_MS;
}

/** The draft slot holds this exact body, canonically. */
function draftHolds(store: Storage, key: string, markdown: string): boolean {
  const raw = store.getItem(key);
  return (
    typeof raw === "string" &&
    canonicalPageMarkdown(decodeDraft(raw).markdown) === canonicalPageMarkdown(markdown)
  );
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
  // The cap, per page: an older client may have parked past it.
  const prefixes = new Set<string>();
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key?.startsWith(RECOVERY_NAMESPACE)) prefixes.add(key.slice(0, key.lastIndexOf(":") + 1));
  }
  for (const prefix of prefixes) trimParked(store, prefix, null, null);
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

const NO_PAGES: readonly string[] = [];
const assignLocation = (href: string) => location.assign(href);

export interface ShareEditorProps {
  rootId: string;
  pageId: string;
  shareVersion: number;
  vid: string;
  initialMarkdown: string;
  initialRev: string;
  /** The pages this body links that the share reaches, decided by the server
   *  at render. A ref to any of them is a link into the share; a ref to any
   *  other page is unavailable, which is what the read-only page does with
   *  the same links. */
  linkablePageIds?: readonly string[];
  onReload?: () => void;
  /** Where a page ref inside the share takes the visitor. */
  onNavigate?: (href: string) => void;
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
  linkablePageIds = NO_PAGES,
  onReload = () => location.reload(),
  onNavigate = assignLocation,
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
  // Discarding is the one press here that destroys text, so it asks first.
  const [discardConfirming, setDiscardConfirming] = useState(false);
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

  // The same statement for page refs: a ref the share reaches links into the
  // share, every other ref is unavailable, and the owner's /p/ address never
  // shows through. The editor gets no page directory, so a ref keeps the
  // label the owner baked into it, as on the read-only page.
  const linkable = useMemo(() => new Set(linkablePageIds), [linkablePageIds]);
  const hrefFor = useCallback(
    (id: string): string | null => {
      if (!linkable.has(id)) return null;
      const rootHref = `/share/${encodeURIComponent(rootId)}`;
      return id === rootId ? rootHref : `${rootHref}?page=${encodeURIComponent(id)}`;
    },
    [linkable, rootId],
  );
  useEffect(() => {
    setPageRefHrefResolver(hrefFor);
    return () => setPageRefHrefResolver(null);
  }, [hrefFor]);
  const navigateToPage = useCallback(
    (id: string) => {
      const href = hrefFor(id);
      if (href) onNavigate(href);
    },
    [hrefFor, onNavigate],
  );

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
    (entry: Pending): boolean => {
      const store = storage();
      if (!store) return false;
      return persistDraft(
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
   *  already parked, so the sentence in the banner stays true; then the
   *  draft goes, or the reload would bring this same banner straight back.
   *  Parking can fail: storage is full, or missing. Then the draft is the
   *  other place the text can live, and the reload brings it back behind
   *  this banner. When neither holds it, the reload is what would destroy
   *  it, so it does not happen: the visitor is told, and a deliberate
   *  second press is theirs to make. */
  const reloadIntoTheirs = () => {
    const text = latest.current;
    const store = storage();
    let parked = false;
    try {
      if (store) parked = parkBody(store, keys.recoveryPrefix, recoveryKey, text, Date.now());
    } catch {
      parked = false;
    }
    if (parked) {
      try {
        store?.removeItem(draftKey);
      } catch {
        // A draft that stays comes back as this banner; nothing is lost.
      }
      dropSource();
      onReload();
      return;
    }
    let drafted = false;
    try {
      drafted =
        !!store &&
        (draftHolds(store, draftKey, text) ||
          persist({ markdown: text, operationId: newOperationId(tabId) }));
    } catch {
      drafted = false;
    }
    if (drafted) {
      onReload();
      return;
    }
    setSaveState("storage");
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
    setDiscardConfirming(false);
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
      : saveState === "storage"
        ? SHARE_STORAGE_FULL_COPY
        : saveState === "gone"
          ? SHARE_GONE_COPY
          : saveState === "unsaved"
            ? SHARE_UNSAVED_COPY
            : null;
  const bannerClass =
    "brain-share-notice mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg py-2 pl-4 text-table text-ink";

  /** One banner at a time. A parked body needs a decision before any other
   *  state makes sense, so it comes first. */
  const banner = offered ? (
    <div data-share-recovery className={`${bannerClass} pr-2`}>
      <span className="min-w-0 flex-1">
        {discardConfirming
          ? SHARE_DISCARD_CONFIRM_COPY
          : shareRecoveryCopy(offered.updatedAt, recoveries.length)}
      </span>
      <span className="flex items-center gap-1">
        {discardConfirming ? (
          <>
            <Button
              type="button"
              variant="quiet"
              onClick={() => setDiscardConfirming(false)}
            >
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void settleOffered()}
            >
              Discard for good
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="quiet" onClick={putParkedBack}>
              Put it back
            </Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => setDiscardConfirming(true)}
            >
              Discard
            </Button>
          </>
        )}
      </span>
    </div>
  ) : notice ? (
    <div
      data-share-save-state={saveState}
      className={`${bannerClass} ${
        saveState === "conflict" || saveState === "storage" ? "pr-2" : "pr-4"
      }`}
    >
      <span className="min-w-0 flex-1">{notice}</span>
      {saveState === "conflict" && (
        <Button type="button" variant="quiet" onClick={reloadIntoTheirs}>
          Reload
        </Button>
      )}
      {saveState === "storage" && (
        <Button type="button" variant="quiet" onClick={onReload}>
          Reload anyway
        </Button>
      )}
    </div>
  ) : null;

  /** Which region the banner is written into. `conflict`, `gone` and
   *  `storage` are the states where the visitor's text has stopped going
   *  anywhere, so they interrupt; `unsaved` retries on the next keystroke
   *  and waits its turn. The owner's head decides the same way
   *  (components/shell/save-indicator.tsx): conflict asserts, an ordinary
   *  failure is polite. A parked body is an offer, not a failure. */
  const interrupts =
    !offered &&
    (saveState === "conflict" || saveState === "gone" || saveState === "storage");

  return (
    <div data-share-editor>
      {/* Both regions are in the DOM from mount and empty. A live region a
          screen reader first meets together with its content is not reliably
          announced, and the visitor has no other save feedback to fall back
          on. Exactly one of them ever holds the banner. */}
      <div data-share-live="assertive" role="alert" aria-live="assertive">
        {interrupts ? banner : null}
      </div>
      <div data-share-live="polite" role="status" aria-live="polite">
        {interrupts ? null : banner}
      </div>
      <MilkdownEditor
        key={editorEpoch}
        value={markdown}
        onChange={onChange}
        onNavigate={navigateToPage}
        registerFlush={registerFlush}
        capabilities={capabilities}
      />
    </div>
  );
}
