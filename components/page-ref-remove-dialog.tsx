"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import { Button } from "./ui/button";
import {
  restoreDialogFocus,
  type DialogFocusLeaseRef,
} from "./ui/dialog-focus-return";
import { DialogHeader } from "./ui/dialog-header";

export function PageRefRemoveDialog({
  open,
  onOpenChange,
  targetTitle,
  sourceTitle,
  targetMissing = false,
  onRemove,
  returnFocusRef,
  focusOwner,
  onFocusReturned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetTitle: string;
  sourceTitle: string;
  targetMissing?: boolean;
  onRemove: () => Promise<void>;
  returnFocusRef: DialogFocusLeaseRef;
  focusOwner: number;
  onFocusReturned: (owner: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove();
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : "Couldn't remove this reference. Try again.",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          aria-describedby="page-ref-remove-description"
          onCloseAutoFocus={(event) => {
            restoreDialogFocus(event, returnFocusRef, focusOwner);
            onFocusReturned(focusOwner);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[min(calc(100vw-2rem),420px)] overflow-hidden outline-none"
        >
          <DialogHeader
            title={`Remove reference to “${targetTitle}”?`}
            closeLabel="Close remove reference dialog"
            closeDisabled={busy}
          />
          <div className="px-5 py-4">
            <p
              id="page-ref-remove-description"
              className="text-[13px] leading-relaxed text-ink-2"
            >
              {targetMissing ? (
                <>
                  This removes only this link from “{sourceTitle}”. The
                  referenced page may no longer exist; no page will be changed.
                </>
              ) : (
                <>
                  This removes only this reference from “{sourceTitle}”. The
                  page itself will stay where it is.
                </>
              )}
            </p>
            {error && (
              <p role="alert" className="mt-3 text-[12px] text-ink-2">
                {error}
              </p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                ref={cancelRef}
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="button" disabled={busy} onClick={() => void remove()}>
                {busy ? "Removing…" : error ? "Retry" : "Remove reference"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
