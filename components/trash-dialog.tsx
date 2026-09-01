"use client";

import { apiFetch } from "@/lib/client";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { Icon } from "./ui/icon";
import { Button, IconButton } from "./ui/button";
import { DialogBody, DialogHeader } from "./ui/dialog-header";
import { Empty } from "./ui/empty";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { formatAgo } from "@/lib/format-ago";

interface TrashItem {
  id: string;
  title: string;
  icon?: string;
  deleted: string;
}

/** Trash — soft-deleted pages, restore or purge. */
export function TrashDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the only irreversible actions in the app — gated behind a confirm
  const [confirm, setConfirm] = useState<
    { kind: "purge"; id: string; title: string } | { kind: "empty" } | null
  >(null);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const response = await apiFetch("/api/trash");
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { trash?: TrashItem[] };
      setItems(payload.trash ?? []);
      setError(null);
      return true;
    } catch {
      setError("Couldn't load trash. Try again.");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      setItems(null);
      setError(null);
      void load();
    });
    return () => {
      live = false;
    };
  }, [open, load]);

  const restore = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/trash/${id}`, { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
      setItems((current) => current?.filter((item) => item.id !== id) ?? current);
      onChanged();
      await load();
    } catch {
      setError("Couldn't restore this page. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const purge = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/trash/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      setItems((current) => current?.filter((item) => item.id !== id) ?? current);
      await load();
    } catch {
      setError("Couldn't delete this page. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const empty = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/trash", { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      setItems([]);
      await load();
    } catch {
      setError("Couldn't empty trash. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[80dvh] w-[min(calc(100vw-2rem),520px)] flex-col overflow-hidden outline-none">
          <DialogHeader
            title="Trash"
            subtitle={
              error && items === null
                ? "Couldn't load"
                : items === null
                ? "Loading…"
                : items.length
                  ? `${items.length} deleted ${items.length === 1 ? "page" : "pages"}`
                  : "No deleted pages"
            }
            action={
              !!items?.length ? (
                <Button variant="destructive" onClick={() => setConfirm({ kind: "empty" })} disabled={busy}>
                  Empty trash
                </Button>
              ) : null
            }
            closeLabel="Close trash"
            closeDisabled={busy}
          />

          <DialogBody className="p-2">
            {error && (
              <div
                role="alert"
                className="flex items-center justify-between gap-3 rounded-sm px-3 py-2 text-[12px] text-ink-2"
              >
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={busy}
                  className="brain-touch-min shrink-0 rounded-full px-2 py-0.5 text-ink transition-colors hover:bg-fill-hover disabled:opacity-50"
                >
                  Reload
                </button>
              </div>
            )}
            {items?.length === 0 && (
              <Empty
                icon="trash-bin-trash-linear"
                title="Trash is empty"
                hint="Deleted pages land here"
                className="px-3 py-10"
              />
            )}
            {items?.map((it) => (
              <div
                key={it.id}
                className="group flex items-center gap-2.5 rounded-sm px-3 py-2 transition-colors hover:bg-fill-hover"
              >
                <span className="text-[15px] leading-none">{it.icon ?? DEFAULT_PAGE_ICON}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{it.title}</span>
                  <span className="text-[12px] text-ink-3">deleted {formatAgo(it.deleted)}</span>
                </span>
                <button
                  onClick={() => restore(it.id)}
                  disabled={busy}
                  className="brain-touch-min rounded-full px-2 py-0.5 text-[12px] text-ink-2 transition-colors hover:bg-fill-active hover:text-ink disabled:opacity-50"
                >
                  Restore
                </button>
                <IconButton
                  size="sm"
                  aria-label="Delete forever"
                  onClick={() => setConfirm({ kind: "purge", id: it.id, title: it.title })}
                  disabled={busy}
                >
                  <Icon name="trash-bin-trash-linear" size={15} />
                </IconButton>
              </div>
            ))}
          </DialogBody>
        </Dialog.Content>
      </Dialog.Portal>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === "empty" ? "Empty trash?" : "Delete forever?"}
        description={
          confirm?.kind === "empty"
            ? "Every page in the trash will be permanently removed. This can't be undone."
            : confirm?.kind === "purge"
              ? `"${confirm.title}" and its subpages will be permanently removed. This can't be undone.`
              : undefined
        }
        confirmLabel={confirm?.kind === "empty" ? "Empty trash" : "Delete forever"}
        onConfirm={() => {
          if (confirm?.kind === "empty") empty();
          else if (confirm?.kind === "purge") purge(confirm.id);
          setConfirm(null);
        }}
      />
    </Dialog.Root>
  );
}
