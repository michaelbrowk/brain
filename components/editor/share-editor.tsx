"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MilkdownEditor, type EditorCapabilities } from "./milkdown-editor";
import { retryFailedAttachmentImages, setAttachmentSrcResolver } from "./attachment-src";
import {
  createKeyedQueue,
  decodeDraft,
  encodeSaveRequest,
  isDraftOperation,
  persistDraft,
  saveMarkdown,
  SaveRequestError,
} from "@/lib/autosave";
import { localAttachmentName } from "@/lib/attachments";
import { canonicalPageMarkdown } from "@/lib/page-markdown";
import { Button } from "../ui/button";

/** Longer than the owner's 700 ms (components/shell.tsx). Every visitor save
 *  is a round trip plus a scheduled git commit, and the visitor write bucket
 *  is 60 per 60 seconds: at 2000 ms continuous typing spends at most half of
 *  it and leaves room for the conflict GET. */
export const SHARE_AUTOSAVE_DEBOUNCE_MS = 2000;

/** The double submit `lib/share-write.ts` checks against the edit cookie.
 *  Named here rather than imported: that module is server-only. */
const VID_HEADER = "x-brain-share-vid";

/** Browsers cap what a keepalive request may carry, 64 KiB in flight per
 *  page. Above it the base body is left off the PUT, as the owner does. */
const KEEPALIVE_BODY_BYTES = 60 * 1024;

export const SHARE_CONFLICT_COPY =
  "Someone else saved this page while you were writing. Your text is still here. Reload to see their version.";
export const SHARE_UNSAVED_COPY =
  "Your last change was not saved. Your text is still here. The next edit will try again.";
export const SHARE_GONE_COPY =
  "This page can no longer be edited through this link. Your text is still here, but it will not be saved.";

export function shareDraftKey(rootId: string, pageId: string): string {
  return `brain-share-draft:${rootId}:${pageId}`;
}

type SaveState = "ok" | "unsaved" | "gone" | "conflict";
type Pending = { markdown: string; operationId: string };

function draftStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What the editor opens with, decided before it mounts because it reads its
 *  value once. A draft left by an earlier visit is one of three things:
 *  already what the server holds (drop it), ours to save because nobody else
 *  wrote meanwhile (save it now), or behind someone else's newer version
 *  (show it behind the conflict banner with its stale rev, so a later edit
 *  cannot overwrite theirs by accident). */
type Opening = {
  markdown: string;
  revision: string;
  base: string;
  pending: Pending | null;
  saveState: SaveState;
  action: "none" | "discard" | "save";
};

function readOpening(draftKey: string, initialMarkdown: string, initialRev: string): Opening {
  const plain: Opening = {
    markdown: initialMarkdown,
    revision: initialRev,
    base: initialMarkdown,
    pending: null,
    saveState: "ok",
    action: "none",
  };
  let raw: string | null = null;
  try {
    raw = draftStorage()?.getItem(draftKey) ?? null;
  } catch {
    return plain;
  }
  if (raw === null) return plain;
  const draft = decodeDraft(raw);
  if (canonicalPageMarkdown(draft.markdown) === canonicalPageMarkdown(initialMarkdown)) {
    return { ...plain, action: "discard" };
  }
  const pending: Pending = {
    markdown: draft.markdown,
    operationId: draft.operationId ?? "restored",
  };
  if (draft.revision === initialRev) {
    return { ...plain, markdown: draft.markdown, pending, action: "save" };
  }
  return {
    markdown: draft.markdown,
    revision: draft.revision ?? "",
    base: draft.baseMarkdown ?? "",
    pending,
    saveState: "conflict",
    action: "none",
  };
}

export default function ShareEditor({
  rootId,
  pageId,
  shareVersion,
  vid,
  initialMarkdown,
  initialRev,
  onReload = () => location.reload(),
}: {
  rootId: string;
  pageId: string;
  shareVersion: number;
  vid: string;
  initialMarkdown: string;
  initialRev: string;
  onReload?: () => void;
}) {
  const draftKey = shareDraftKey(rootId, pageId);
  const [opening] = useState(() => readOpening(draftKey, initialMarkdown, initialRev));
  const [markdown, setMarkdown] = useState(opening.markdown);
  const [saveState, setSaveState] = useState<SaveState>(opening.saveState);
  const revision = useRef(opening.revision);
  const base = useRef(opening.base);
  // The body the server does not have yet, and the edit that produced it.
  const pending = useRef<Pending | null>(opening.pending);
  const operations = useRef(0);
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

  const removeDraft = useCallback(() => {
    try {
      draftStorage()?.removeItem(draftKey);
    } catch {
      // Storage that cannot be cleared held nothing that matters now.
    }
  }, [draftKey]);

  const save = useCallback(
    async ({ markdown: next, operationId }: Pending) => {
      try {
        await saveMarkdown({
          fetcher,
          id: pageId,
          markdown: next,
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
        if (pending.current?.operationId === operationId) pending.current = null;
        // The draft goes only when it still holds this exact edit; a newer
        // keystroke may have replaced it while the request was out.
        try {
          const storage = draftStorage();
          const raw = storage?.getItem(draftKey);
          if (typeof raw === "string" && isDraftOperation(raw, operationId)) {
            storage?.removeItem(draftKey);
          }
        } catch {
          // Same as above.
        }
        setSaveState("ok");
        // An image uploaded moments ago was refused by the media route until
        // this page referenced it. Now it does.
        retryFailedAttachmentImages();
      } catch (error) {
        const status = error instanceof SaveRequestError ? error.status : undefined;
        if (status === 409) {
          // Two strangers, not one person with two tabs: the text stays, and
          // Reload is a press, never something that happens to them.
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
    [draftKey, fetcher, pageEndpoint, pageId],
  );

  const runPending = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    if (!next) return;
    void queue.run(pageId, () => save(next));
  }, [pageId, queue, save]);

  const onChange = useCallback(
    (next: string) => {
      setMarkdown(next);
      operations.current += 1;
      const entry: Pending = { markdown: next, operationId: String(operations.current) };
      pending.current = entry;
      // Every change is a draft first. The 2000 ms below is exactly the
      // window a closed tab would otherwise lose.
      const storage = draftStorage();
      if (storage) {
        persistDraft(
          storage,
          draftKey,
          next,
          revision.current,
          entry.operationId,
          Date.now(),
          base.current,
        );
      }
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
    [draftKey, runPending],
  );

  // The one write `readOpening` decided on. `opening` never changes.
  useEffect(() => {
    if (opening.action === "discard") removeDraft();
    else if (opening.action === "save") runPending();
  }, [opening, removeDraft, runPending]);

  // Save as soon as the tab backgrounds; pagehide adds a keepalive request
  // that survives the unload. The draft remains until a confirmed response.
  const flushPending = useCallback(() => {
    editorFlush.current();
    runPending();
  }, [runPending]);
  const flushKeepalive = useCallback(() => {
    editorFlush.current();
    const next = pending.current;
    if (!next || queue.has(pageId)) return;
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

  const notice =
    saveState === "conflict"
      ? SHARE_CONFLICT_COPY
      : saveState === "gone"
        ? SHARE_GONE_COPY
        : saveState === "unsaved"
          ? SHARE_UNSAVED_COPY
          : null;

  return (
    <div data-share-editor>
      {notice && (
        <div
          data-share-save-state={saveState}
          role="status"
          className={`mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-[var(--fill-tint)] py-2 pl-4 text-table text-ink ${
            saveState === "conflict" ? "pr-2" : "pr-4"
          }`}
        >
          <span className="min-w-0 flex-1">{notice}</span>
          {saveState === "conflict" && (
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                // "Show me their version": the draft would otherwise come
                // back on the reload and put this same banner straight up.
                removeDraft();
                onReload();
              }}
            >
              Reload
            </Button>
          )}
        </div>
      )}
      <MilkdownEditor
        value={markdown}
        onChange={onChange}
        registerFlush={registerFlush}
        capabilities={capabilities}
      />
    </div>
  );
}
