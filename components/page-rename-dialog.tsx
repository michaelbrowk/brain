"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import {
  restoreDialogFocus,
  type DialogFocusLeaseRef,
} from "./ui/dialog-focus-return";
import { DialogHeader } from "./ui/dialog-header";

export interface PageRenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pageId: string;
  title: string;
  onRename: (id: string, title: string) => Promise<void>;
  returnFocusRef: DialogFocusLeaseRef;
  focusOwner: number;
  onFocusReturned: (owner: number) => void;
}

export function PageRenameDialog(props: PageRenameDialogProps) {
  return <OpenPageRenameDialog {...props} />;
}

function OpenPageRenameDialog({
  open,
  onOpenChange,
  pageId,
  title,
  onRename,
  returnFocusRef,
  focusOwner,
  onFocusReturned,
}: PageRenameDialogProps) {
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = async (event?: FormEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (!next) {
      setError("Page title can't be empty.");
      return;
    }
    if (busy) return;
    if (next === title) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(pageId, next);
      onOpenChange(false);
    } catch {
      setError("Couldn't rename this page. Try again.");
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
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            restoreDialogFocus(event, returnFocusRef, focusOwner);
            onFocusReturned(focusOwner);
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[min(calc(100vw-2rem),420px)] overflow-hidden outline-none"
        >
          <DialogHeader
            title="Rename page"
            closeLabel="Close rename dialog"
            closeDisabled={busy}
          />

          <form onSubmit={commit} className="px-5 py-4">
            <label className="block text-[12px] text-ink-3" htmlFor="page-rename-title">
              Page title
            </label>
            <input
              ref={inputRef}
              id="page-rename-title"
              value={draft}
              disabled={busy}
              onChange={(event) => {
                setDraft(event.target.value.replace(/[\r\n]+/g, " "));
                if (error) setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  onOpenChange(false);
                }
              }}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "page-rename-error" : undefined}
              className="mt-1 h-9 w-full rounded-md border border-line bg-paper px-3 text-[13px] text-ink outline-none transition-colors focus:border-ink-3 disabled:opacity-40 max-md:text-[16px]"
            />
            {error && (
              <p id="page-rename-error" role="alert" className="mt-2 text-[12px] text-ink-2">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                variant="quiet"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="ink" disabled={!draft.trim() || busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
