"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { sectionPageIds } from "@/lib/dated-sections";
import type { TreeNode } from "@/lib/store/types";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
import { DialogBody, DialogHeader } from "./ui/dialog-header";

/** Preview of the AI grouping before it's applied. Nothing is written until
 *  Apply, and the dialog stays up through that write: a failed save answers
 *  in the footer rather than closing on a document that never changed. */
export function SmartSortPreview({
  preview,
  pages,
  applying = false,
  applyError = null,
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
  /** The Apply write is in flight: the dialog holds, and both ways out close. */
  applying?: boolean;
  /** What the failed write left the reader with, said where they pressed. */
  applyError?: string | null;
  onApply: () => void;
  onCancel: () => void;
}) {
  const open = !!preview;
  const byId = new Map(pages.map((c) => [c.id, c]));
  const placed = preview ? Object.keys(preview.assignments).length : 0;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !applying) onCancel();
      }}
    >
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
            closeDisabled={applying}
          />

          {/* `data-edge="chips"`: a wrapped tile flow ends in a partial row,
              so the bottom fade carries a whole chip and its gap. Twenty
              pixels under a 28px chip read as one chip dimming, which is how
              a cut section came to look like the end of the list. */}
          <DialogBody className="px-5 py-4" data-edge="chips">
            <div className="space-y-4">
              {preview?.sections.map((label) => {
                const ids = sectionPageIds(preview, label);
                return (
                  <div key={label}>
                    <p className="text-label pb-1.5 text-ink-3">
                      {label} · {ids.length}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {ids.map((id) => {
                        const c = byId.get(id);
                        return (
                          <Chip
                            key={id}
                            emoji={c?.icon ?? DEFAULT_PAGE_ICON}
                            className="max-w-[220px]"
                          >
                            {c?.title ?? "Untitled page"}
                          </Chip>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </DialogBody>

          {/* Footer of the twin (page-move-dialog): no hairline over the fade
              scroller, quiet beside ink, and the refusal above both. */}
          <div className="px-5 pb-4 pt-3">
            {applyError && (
              <p role="alert" className="mb-2 text-[12px] text-ink-2">
                {applyError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="quiet"
                disabled={applying}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ink"
                disabled={applying}
                onClick={onApply}
              >
                {applying ? "Applying…" : "Apply"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
