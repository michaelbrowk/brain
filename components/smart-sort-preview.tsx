"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { sectionPageIds } from "@/lib/dated-sections";
import type { TreeNode } from "@/lib/store/types";
import { Button } from "./ui/button";
import { DialogBody, DialogHeader } from "./ui/dialog-header";

/** Preview of the AI grouping before it's applied. Shows the "N of N placed"
 *  invariant so a lost page is visibly impossible. */
export function SmartSortPreview({
  preview,
  pages,
  onApply,
  onCancel,
}: {
  preview: {
    sections: string[];
    assignments: Record<string, string>;
    order?: string[];
    count: number;
  } | null;
  pages: TreeNode[];
  onApply: () => void;
  onCancel: () => void;
}) {
  const open = !!preview;
  const byId = new Map(pages.map((c) => [c.id, c]));
  const placed = preview ? Object.keys(preview.assignments).length : 0;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[80dvh] w-[min(calc(100vw-2rem),560px)] flex-col overflow-hidden outline-none"
        >
          <DialogHeader
            title="Smart sort"
            subtitle={
              <>
                {preview ? (
                  <>
                    <span className="font-medium text-ink">
                      {placed} of {preview.count} placed
                    </span>
                    <span className="text-ink-3"> · {preview.sections.length} sections</span>
                  </>
                ) : (
                  ""
                )}
              </>
            }
            closeLabel="Close smart sort"
          />

          <DialogBody className="space-y-4 px-5 py-4">
            {preview?.sections.map((label) => {
              const ids = sectionPageIds(preview, label);
              return (
                <div key={label}>
                  <p className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">
                    {label} · {ids.length}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {ids.map((id) => {
                      const c = byId.get(id);
                      return (
                        <span
                          key={id}
                          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-[12px]"
                        >
                          <span className="text-[13px] leading-none">
                            {c?.icon ?? DEFAULT_PAGE_ICON}
                          </span>
                          <span className="max-w-[220px] truncate text-ink">{c?.title ?? id}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {preview &&
              (() => {
                const unplaced = pages.filter((c) => !preview.assignments[c.id]);
                if (!unplaced.length) return null;
                return (
                  <div>
                    <p className="pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">
                      Unplaced · {unplaced.length}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {unplaced.map((c) => (
                        <span
                          key={c.id}
                          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-ink"
                        >
                          <span className="text-[13px] leading-none">
                            {c.icon ?? DEFAULT_PAGE_ICON}
                          </span>
                          <span className="max-w-[220px] truncate">{c.title}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })()}
          </DialogBody>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={onApply}>Apply</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
