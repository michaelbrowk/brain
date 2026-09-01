"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  onConfirm,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  /**
   * Where focus goes when the dialog closes. Radix restores whatever was
   * focused when it opened, which is right on every platform that focuses a
   * button on click — Safari does not, so a caller opening this from a
   * pointer press hands over the control it came from. Returns null when that
   * control is gone (the row it lived on was the thing removed).
   */
  returnFocus?: () => HTMLElement | null;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        {/* thick material r20 via .brain-dialog; cancel is quiet, the
            confirmation destructive (red text — never a red fill) */}
        <AlertDialog.Content
          onCloseAutoFocus={(event) => {
            const target = returnFocus?.();
            if (!target?.isConnected) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
          className="brain-dialog fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[min(calc(100vw-2rem),380px)] p-5 outline-none"
        >
          <AlertDialog.Title className="text-subheading text-ink">{title}</AlertDialog.Title>
          {description && (
            <AlertDialog.Description className="text-table mt-1.5 font-medium text-ink-2">
              {description}
            </AlertDialog.Description>
          )}
          {/* r20 = control r10 + padding 10: the action row sits 10px from
              the dialog edge so the radii stay concentric */}
          <div className="-mx-2.5 -mb-2.5 mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="btn btn-quiet">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action onClick={onConfirm} className="btn btn-destructive">
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
