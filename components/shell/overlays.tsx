"use client";

// Everything that floats over the shell: the shortcuts / page-ref remove /
// rename / move dialogs, the Smart Sort preview, trash, history, and
// the seven snackbars (refusal, smart-sort undo, page-ref undo, save
// conflict, save error, toast, delete undo) — one bottom column with the
// refusal at its head. Settings is not an overlay any more — it is a canvas
// surface at /settings/[section]. Presentational — every piece of
// state and every handler comes from <Shell> as a prop; the dialog session
// setters are passed through so the owner-keyed open / focus-return
// plumbing stays next to the dialogs it serves.
// Extracted verbatim from shell.tsx (S5 of the shell extraction).

import type {
  ComponentProps,
  Dispatch,
  SetStateAction,
} from "react";
import type { TreeNode } from "@/lib/store/types";
import { Snackbar, SnackbarStack } from "../ui/primitives";
import type { DialogFocusLeaseRef } from "../ui/dialog-focus-return";
import { SmartSortPreview } from "../smart-sort-preview";
import { TrashDialog } from "../trash-dialog";
import { HistoryDialog } from "../history-dialog";
import { ShortcutsDialog } from "../shortcuts-dialog";
import { PageMoveDialog } from "../page-move-dialog";
import { PageRenameDialog } from "../page-rename-dialog";
import { PageRefRemoveDialog } from "../page-ref-remove-dialog";
import {
  LOCAL_RECOVERY_UNAVAILABLE,
  type FocusDialogSession,
  type FocusPageDialogTarget,
  type PageRefRemoveTarget,
  type PageRefUndo,
  type SaveState,
  type ShellToast,
} from "./helpers";

type SmartSortPreviewProps = ComponentProps<typeof SmartSortPreview>;

export interface ShellOverlaysProps {
  tree: TreeNode[];
  selectedId: string | null;
  /** The open page: Smart Sort previews its direct children. */
  currentNode: TreeNode | null;
  save: SaveState;
  localRecoveryUnavailable: boolean;
  /** Focus lease shared by the owner-keyed dialogs (remove / rename / move
   *  / history): each returns focus to the element that opened it. */
  dialogReturnFocusRef: DialogFocusLeaseRef;
  shortcutsOpen: boolean;
  onShortcutsOpenChange: (open: boolean) => void;
  pageRefRemoveTarget: PageRefRemoveTarget | null;
  setPageRefRemoveTarget: Dispatch<SetStateAction<PageRefRemoveTarget | null>>;
  onRemoveConfirmedPageRef: () => Promise<void>;
  renameTarget: FocusPageDialogTarget | null;
  setRenameTarget: Dispatch<SetStateAction<FocusPageDialogTarget | null>>;
  onRenamePage: (id: string, title: string) => Promise<void>;
  moveTarget: FocusPageDialogTarget | null;
  setMoveTarget: Dispatch<SetStateAction<FocusPageDialogTarget | null>>;
  onMoveDialogMove: ComponentProps<typeof PageMoveDialog>["onMove"];
  smartPreview: SmartSortPreviewProps["preview"];
  onApplySmartSort: () => Promise<void>;
  onCancelSmartSort: () => void;
  smartUndoOpen: boolean;
  smartUndoPageId: string | null;
  onUndoSmartSort: () => void;
  pageRefUndo: PageRefUndo | null;
  onRestoreRemovedPageRef: () => Promise<void>;
  trashOpen: boolean;
  onTrashOpenChange: (open: boolean) => void;
  onTrashChanged: () => void;
  historyDialog: FocusDialogSession | null;
  setHistoryDialog: Dispatch<SetStateAction<FocusDialogSession | null>>;
  historyBaseRevision: string;
  onHistoryRestored: () => Promise<void>;
  pendingDelete: { id: string; title: string; error?: string } | null;
  recoveryMessage: { id: string; text: string } | null;
  recoveryCopyId: string | null;
  onSaveConflictCopy: () => Promise<void>;
  toast: ShellToast | null;
  /** The standing toast's action has begun and has not settled: the button
   *  is out of reach and wears the message's `pendingLabel` until it does. */
  toastActionPending: boolean;
  /** The refusal channel: one sentence answering a gesture, on its own pill
   *  above whatever is standing, so it never has to wait for an undo's window
   *  to close before it can be said. */
  urgentToast: string | null;
  /** Runs the toast's own action and dismisses it in the same beat, so an
   *  undo cannot be pressed twice while its restore is still running — unless
   *  the action refuses (`false`), which leaves the message standing, or
   *  answers with a promise, which holds the pill until it settles. */
  onToastAction: (action: () => boolean | void | Promise<unknown>) => void;
  /** Hover holds the message: the drain ring and its timer stop together. */
  onPauseToast: () => void;
  onResumeToast: () => void;
  countdown: number;
  onUndoDelete: () => Promise<void>;
  onPauseDelete: () => void;
  onResumeDelete: () => void;
}

export function ShellOverlays({
  tree,
  selectedId,
  currentNode,
  save,
  localRecoveryUnavailable,
  dialogReturnFocusRef,
  shortcutsOpen,
  onShortcutsOpenChange,
  pageRefRemoveTarget,
  setPageRefRemoveTarget,
  onRemoveConfirmedPageRef,
  renameTarget,
  setRenameTarget,
  onRenamePage,
  moveTarget,
  setMoveTarget,
  onMoveDialogMove,
  smartPreview,
  onApplySmartSort,
  onCancelSmartSort,
  smartUndoOpen,
  smartUndoPageId,
  onUndoSmartSort,
  pageRefUndo,
  onRestoreRemovedPageRef,
  trashOpen,
  onTrashOpenChange,
  onTrashChanged,
  historyDialog,
  setHistoryDialog,
  historyBaseRevision,
  onHistoryRestored,
  pendingDelete,
  recoveryMessage,
  recoveryCopyId,
  onSaveConflictCopy,
  toast,
  toastActionPending,
  urgentToast,
  onToastAction,
  onPauseToast,
  onResumeToast,
  countdown,
  onUndoDelete,
  onPauseDelete,
  onResumeDelete,
}: ShellOverlaysProps) {
  const toastAction = toast?.onAction;
  /* The drain ring is drawn only for a message with a window AND something to
     reach for, and hover has to hold exactly what the ring shows — so one
     value decides both. A `durationMs` of null is a message with no window at
     all: no ring, and no hover pause, because there is nothing to hold. */
  const toastRing =
    toast?.durationMs != null && toast.actionLabel
      ? toast.durationMs / 1000
      : undefined;
  /* Every other pill on this surface is mutually exclusive with the rest —
     the refusal is the one that may stand beside one, so it is the one that
     steps up out of the way. */
  return (
    <>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={onShortcutsOpenChange} />

      {pageRefRemoveTarget && (
        <PageRefRemoveDialog
          key={pageRefRemoveTarget.owner}
          open={pageRefRemoveTarget.open}
          onOpenChange={(open) =>
            setPageRefRemoveTarget((current) =>
              current?.owner === pageRefRemoveTarget.owner
                ? { ...current, open }
                : current,
            )
          }
          targetTitle={pageRefRemoveTarget.title}
          sourceTitle={pageRefRemoveTarget.sourceTitle}
          targetMissing={pageRefRemoveTarget.targetMissing}
          onRemove={onRemoveConfirmedPageRef}
          returnFocusRef={dialogReturnFocusRef}
          focusOwner={pageRefRemoveTarget.owner}
          onFocusReturned={(owner) =>
            setPageRefRemoveTarget((current) =>
              current?.owner === owner ? null : current,
            )
          }
        />
      )}

      {renameTarget && (
        <PageRenameDialog
          key={renameTarget.owner}
          open={renameTarget.open}
          onOpenChange={(open) =>
            setRenameTarget((current) =>
              current?.owner === renameTarget.owner
                ? { ...current, open }
                : current,
            )
          }
          pageId={renameTarget.id}
          title={renameTarget.title}
          onRename={onRenamePage}
          returnFocusRef={dialogReturnFocusRef}
          focusOwner={renameTarget.owner}
          onFocusReturned={(owner) =>
            setRenameTarget((current) =>
              current?.owner === owner ? null : current,
            )
          }
        />
      )}

      {moveTarget && (
        <PageMoveDialog
          key={moveTarget.owner}
          open={moveTarget.open}
          onOpenChange={(open) =>
            setMoveTarget((current) =>
              current?.owner === moveTarget.owner
                ? { ...current, open }
                : current,
            )
          }
          tree={tree}
          pageId={moveTarget.id}
          pageTitle={moveTarget.title}
          returnFocusRef={dialogReturnFocusRef}
          focusOwner={moveTarget.owner}
          onFocusReturned={(owner) =>
            setMoveTarget((current) =>
              current?.owner === owner ? null : current,
            )
          }
          onMove={onMoveDialogMove}
        />
      )}

      <SmartSortPreview
        preview={smartPreview}
        pages={currentNode?.children ?? []}
        onApply={onApplySmartSort}
        onCancel={onCancelSmartSort}
      />

      <TrashDialog
        open={trashOpen}
        onOpenChange={onTrashOpenChange}
        onChanged={onTrashChanged}
      />

      {historyDialog && (
        <HistoryDialog
          key={historyDialog.owner}
          pageId={selectedId}
          baseRevision={historyBaseRevision}
          open={historyDialog.open}
          onOpenChange={(open) =>
            setHistoryDialog((current) =>
              current?.owner === historyDialog.owner
                ? { ...current, open }
                : current,
            )
          }
          returnFocusRef={dialogReturnFocusRef}
          focusOwner={historyDialog.owner}
          onFocusReturned={(owner) =>
            setHistoryDialog((current) =>
              current?.owner === owner ? null : current,
            )
          }
          onRestored={onHistoryRestored}
        />
      )}

      {/* Every pill in one bottom column: the refusal at its head, and the
          reports below it in the order they were written. Two that are up
          at the same beat stack on the column's spacing instead of being
          placed by hand, and the column clears the mobile tab bar. */}
      <SnackbarStack>
        {/* The refusal, at the head of the column. It answers a gesture the
            reader just made, so it speaks at once — over a live undo rather
            than behind it, because ten seconds later the sentence would be
            detached from the press and by then untrue. Assertive, and no
            action: there is nothing to take back, and with no way back it
            takes no countdown ring and so no icon slot to hang one in. */}
        <Snackbar
          open={!!urgentToast}
          title={urgentToast ?? ""}
          assertive
        />
        <Snackbar
          open={
            save !== "conflict" &&
            smartUndoOpen &&
            smartUndoPageId === selectedId
          }
          icon="magic-stick-3-linear"
          title="Sorted into sections"
          subtitle="Edit the headings and links freely"
          actionLabel="Undo"
          onAction={onUndoSmartSort}
        />
        <Snackbar
          open={
            !!pageRefUndo &&
            pageRefUndo.sourcePageId === selectedId &&
            save !== "conflict"
          }
          icon="link-linear"
          title={
            pageRefUndo?.status === "restoring"
              ? "Restoring reference…"
              : pageRefUndo?.status === "error"
                ? "Couldn't restore reference"
                : "Reference removed"
          }
          subtitle={
            pageRefUndo?.error ??
            (pageRefUndo
              ? `“${pageRefUndo.targetTitle}” page was not changed.`
              : undefined)
          }
          actionLabel={
            pageRefUndo?.status === "restoring"
              ? "Restoring…"
              : pageRefUndo?.status === "error"
                ? "Retry"
                : "Undo"
          }
          actionDisabled={pageRefUndo?.status === "restoring"}
          onAction={() => void onRestoreRemovedPageRef()}
        />
        <Snackbar
          open={save === "conflict" && !pendingDelete}
          title="Page changed elsewhere"
          subtitle={
            localRecoveryUnavailable
              ? LOCAL_RECOVERY_UNAVAILABLE
              : recoveryMessage?.id === selectedId
              ? recoveryMessage.text
              : "Save your local draft as a sibling copy."
          }
          actionLabel={recoveryCopyId === selectedId ? "Saving…" : "Save a copy"}
          actionDisabled={recoveryCopyId === selectedId}
          onAction={onSaveConflictCopy}
        />
        <Snackbar
          open={
            save === "error" &&
            localRecoveryUnavailable &&
            !pendingDelete
          }
          title="Couldn't save"
          subtitle={LOCAL_RECOVERY_UNAVAILABLE}
        />
        {/* The general-purpose toast. Most of what reaches it is a sentence and
            nothing else; a caller that MOVED something passes the way back with
            it, and only then does the pill grow an action and a drain ring. */}
        <Snackbar
          open={
            !!toast &&
            !pendingDelete &&
            save !== "conflict" &&
            !(save === "error" && localRecoveryUnavailable)
          }
          icon={toast?.icon}
          title={toast?.title ?? ""}
          subtitle={toast?.subtitle}
          actionLabel={
            toastActionPending
              ? (toast?.pendingLabel ?? toast?.actionLabel)
              : toast?.actionLabel
          }
          actionDisabled={toastActionPending}
          onAction={
            toastAction ? () => onToastAction(toastAction) : undefined
          }
          durationSec={toastRing}
          onHoverStart={toastRing != null ? onPauseToast : undefined}
          onHoverEnd={toastRing != null ? onResumeToast : undefined}
        />
        <Snackbar
          open={!!pendingDelete}
          icon="trash-bin-trash-linear"
          title={pendingDelete ? `“${pendingDelete.title}” deleted` : ""}
          subtitle={pendingDelete?.error ?? `Gone in ${countdown}s`}
          actionLabel="Undo"
          onAction={onUndoDelete}
          durationSec={7}
          onHoverStart={onPauseDelete}
          onHoverEnd={onResumeDelete}
        />
      </SnackbarStack>
    </>
  );
}
