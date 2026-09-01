"use client";

import { apiFetch } from "@/lib/client";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderReadOnly } from "@/lib/render-md";
import { Button } from "./ui/button";
import { DialogBody, DialogHeader } from "./ui/dialog-header";
import {
  restoreDialogFocus,
  type DialogFocusLeaseRef,
} from "./ui/dialog-focus-return";

interface Version {
  sha: string;
  date: string;
  msg: string;
}

type HistorySession = symbol;

interface ActiveVersion {
  pageId: string;
  sha: string;
  baseRevision: string;
  markdown: string;
  session: HistorySession;
}

interface LoadedHistory {
  pageId: string;
  baseRevision: string;
  versions: Version[];
  session: HistorySession;
}

interface HistoryError {
  pageId: string;
  baseRevision: string;
  message: string;
  session: HistorySession;
}

function when(iso: string): string {
  const d = new Date(iso);
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Version history — a page's git timeline, preview a version, roll back. */
export function HistoryDialog({
  pageId,
  baseRevision,
  open,
  onOpenChange,
  onRestored,
  returnFocusRef,
  focusOwner,
  onFocusReturned,
}: {
  pageId: string | null;
  baseRevision: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRestored: () => void;
  returnFocusRef: DialogFocusLeaseRef;
  focusOwner: number;
  onFocusReturned: (owner: number) => void;
}) {
  const [history, setHistory] = useState<LoadedHistory | null>(null);
  const [selectedVersion, setSelectedVersion] =
    useState<ActiveVersion | null>(null);
  const [restoring, setRestoring] = useState<ActiveVersion | null>(null);
  const [historyError, setHistoryError] = useState<HistoryError | null>(null);
  const renderSession = useMemo(
    () => Symbol(`history session:${open}:${pageId ?? "none"}:${baseRevision}`),
    [open, pageId, baseRevision],
  );
  const sessionRef = useRef<HistorySession | null>(null);
  const historyLoadRequestRef = useRef(0);
  const previewRequestRef = useRef(0);

  const versions =
    open &&
    history?.pageId === pageId &&
    history.baseRevision === baseRevision &&
    history.session === renderSession
      ? history.versions
      : null;
  const active =
    open &&
    selectedVersion?.pageId === pageId &&
    selectedVersion.baseRevision === baseRevision &&
    selectedVersion.session === renderSession
      ? selectedVersion
      : null;
  const preview = active?.markdown ?? "";
  const busy =
    restoring?.pageId === pageId &&
    restoring.baseRevision === baseRevision &&
    restoring.session === renderSession;
  const error =
    open &&
    historyError?.pageId === pageId &&
    historyError.baseRevision === baseRevision &&
    historyError.session === renderSession
      ? historyError.message
      : null;

  const select = useCallback(
    async (
      targetPageId: string,
      sha: string,
      capturedRevision: string,
      session: HistorySession,
    ): Promise<boolean> => {
      const request = ++previewRequestRef.current;
      try {
        const response = await apiFetch(
          `/api/page/${targetPageId}/history/${sha}`,
        );
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { markdown?: string };
        if (
          sessionRef.current !== session ||
          previewRequestRef.current !== request
        )
          return false;
        setSelectedVersion({
          pageId: targetPageId,
          sha,
          baseRevision: capturedRevision,
          markdown: payload.markdown ?? "",
          session,
        });
        setHistoryError(null);
        return true;
      } catch {
        if (
          sessionRef.current !== session ||
          previewRequestRef.current !== request
        )
          return false;
        setHistoryError({
          pageId: targetPageId,
          baseRevision: capturedRevision,
          message: "Couldn't load this version. Try again.",
          session,
        });
        return false;
      }
    },
    [],
  );

  const load = useCallback(
    async (
      targetPageId: string,
      capturedRevision: string,
      session: HistorySession,
    ) => {
      const request = ++historyLoadRequestRef.current;
      try {
        const response = await apiFetch(`/api/page/${targetPageId}/history`);
        if (!response.ok) throw new Error(String(response.status));
        const payload = (await response.json()) as { history?: Version[] };
        if (
          sessionRef.current !== session ||
          historyLoadRequestRef.current !== request
        )
          return;
        const next = payload.history ?? [];
        setHistory({
          pageId: targetPageId,
          baseRevision: capturedRevision,
          versions: next,
          session,
        });
        setHistoryError(null);
        if (next[0]) {
          await select(
            targetPageId,
            next[0].sha,
            capturedRevision,
            session,
          );
        }
      } catch {
        if (
          sessionRef.current !== session ||
          historyLoadRequestRef.current !== request
        )
          return;
        setHistory({
          pageId: targetPageId,
          baseRevision: capturedRevision,
          versions: [],
          session,
        });
        setHistoryError({
          pageId: targetPageId,
          baseRevision: capturedRevision,
          message: "Couldn't load history. Try again.",
          session,
        });
      }
    },
    [select],
  );

  useEffect(() => {
    const session = renderSession;
    sessionRef.current = session;
    previewRequestRef.current += 1;
    if (open && pageId && baseRevision) {
      queueMicrotask(() => {
        if (sessionRef.current === session) {
          void load(pageId, baseRevision, session);
        }
      });
    }
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [open, pageId, baseRevision, load, renderSession]);

  const restore = async () => {
    if (!pageId || !active || active.pageId !== pageId) return;
    const target = active;
    const session = target.session;
    setRestoring(target);
    setHistoryError(null);
    try {
      const response = await apiFetch(
        `/api/page/${target.pageId}/history/${target.sha}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rev: target.baseRevision }),
        },
      );
      if (response.status === 409) {
        if (sessionRef.current === session) {
          setHistoryError({
            pageId: target.pageId,
            baseRevision: target.baseRevision,
            message:
              "Page changed elsewhere. Close History and review the current page.",
            session,
          });
        }
        return;
      }
      if (!response.ok) throw new Error(String(response.status));
      if (sessionRef.current !== session) return;
      onOpenChange(false);
      onRestored();
    } catch {
      if (sessionRef.current === session) {
        setHistoryError({
          pageId: target.pageId,
          baseRevision: target.baseRevision,
          message: "Couldn't restore this version. Try again.",
          session,
        });
      }
    } finally {
      if (sessionRef.current === session) setRestoring(null);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            restoreDialogFocus(event, returnFocusRef, focusOwner);
            onFocusReturned(focusOwner);
          }}
          className="brain-dialog brain-sheet brain-sheet-two-pane fixed left-1/2 top-1/2 z-[var(--z-modal)] flex h-[min(78dvh,560px)] w-[min(calc(100vw-2rem),780px)] overflow-hidden outline-none"
        >
          {/* timeline — on the material: a Label 11 in sentence case over
              dialog rows (`.brain-dialog-row`: r10 at the sheet's 10px
              inset, the chosen version a white capsule). ink-3 stays off the
              glass (§1), so the date line is Caption in ink-2. */}
          <nav className="brain-sheet-two-pane-nav w-[220px] shrink-0 overflow-y-auto border-r border-line p-2.5">
            <p className="text-label px-2.5 pb-0.5 pt-2 text-ink-2">History</p>
            {versions === null && (
              <p className="text-caption px-2.5 py-3 text-ink-2">Loading…</p>
            )}
            {versions?.length === 0 && !error && (
              <p className="text-caption px-2.5 py-3 text-ink-2">
                No saved versions yet
              </p>
            )}
            {versions?.map((v, i) => (
              <button
                key={v.sha}
                aria-pressed={active?.sha === v.sha}
                aria-current={i === 0 ? "true" : undefined}
                onClick={() =>
                  pageId &&
                  void select(
                    pageId,
                    v.sha,
                    baseRevision,
                    renderSession,
                  )
                }
                className="brain-dialog-row focus-inset w-full px-2.5 py-1.5"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate">
                    {i === 0 ? "Current" : when(v.date)}
                  </span>
                  <span className="text-caption font-normal text-ink-2 tabular-nums">
                    {new Date(v.date).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </span>
              </button>
            ))}
          </nav>

          {/* preview */}
          <div className="brain-sheet-two-pane-main flex min-w-0 flex-1 flex-col">
            <DialogHeader
              title={
                active && versions?.[0]?.sha === active.sha
                  ? "Current version"
                  : "Preview"
              }
              action={
                active && versions?.[0]?.sha !== active.sha ? (
                  <Button onClick={restore} disabled={busy}>
                    Restore this version
                  </Button>
                ) : null
              }
              closeLabel="Close version history"
              closeDisabled={busy}
            />
            <DialogBody className="px-5 py-4">
              {error && (
                <div
                  role="alert"
                  className="mb-3 flex items-center justify-between gap-3 text-[12px] text-ink-2"
                >
                  <span>{error}</span>
                  {!error.startsWith("Page changed elsewhere") && (
                    <button
                      type="button"
                      onClick={() =>
                        void (error === "Couldn't restore this version. Try again."
                          ? restore()
                          : pageId && baseRevision
                            ? load(
                                pageId,
                                baseRevision,
                                renderSession,
                              )
                            : Promise.resolve())
                      }
                      disabled={busy}
                      className="brain-touch-min shrink-0 rounded-full px-2 py-0.5 text-ink transition-colors hover:bg-fill-hover disabled:opacity-50"
                    >
                      Try again
                    </button>
                  )}
                </div>
              )}
              {preview ? (
                <div
                  className="brain-history-preview text-[13px] leading-relaxed text-ink-2"
                  dangerouslySetInnerHTML={{ __html: renderReadOnly(preview) }}
                />
              ) : (
                <p className="pt-10 text-center text-[13px] text-ink-3">
                  Select a version
                </p>
              )}
            </DialogBody>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
