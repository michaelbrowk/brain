"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { sectionPageIds } from "@/lib/dated-sections";
import { DUR, SPRING_MATERIALIZE } from "@/lib/motion";
import type { TreeNode } from "@/lib/store/types";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
import { DialogBody, DialogHeader } from "./ui/dialog-header";

export interface SmartSortResult {
  sections: string[];
  assignments: Record<string, string>;
  /** Reading order across all sections. Advisory: `assignments` decides
   *  membership, and `sectionPageIds` is the only reader of both. */
  order?: string[];
  count: number;
}

/** The proposal, from the press to the answer.
 *
 *  The dialog opens in the same tick as the click, because the client already
 *  holds everything the answer rearranges: the titles and icons are in the
 *  tree, and the server adds only where each page goes. So the wait is not a
 *  skeleton standing in for content nobody has — it is the content, in the
 *  order it is stacked today, with one band reading down it. When the answer
 *  lands the same pages come back grouped. Nothing is written until Apply,
 *  and the dialog stays up through that write so a refused save can answer
 *  where the reader pressed. */
export function SmartSortPreview({
  session,
  applying = false,
  applyError = null,
  onApply,
  onCancel,
}: {
  session: { pages: TreeNode[]; result: SmartSortResult | null } | null;
  /** The Apply write is in flight: the dialog holds, and both ways out close. */
  applying?: boolean;
  /** What the failed write left the reader with, said where they pressed. */
  applyError?: string | null;
  onApply: () => void;
  onCancel: () => void;
}) {
  const open = !!session;
  const pages = useMemo(() => session?.pages ?? [], [session]);
  const result = session?.result ?? null;
  const reduce = useReducedMotion();
  const compact = useCompactViewport();
  /* The deal is a desktop gesture. Below 768 this dialog is `.brain-sheet`,
     where the sections stack and a heap-to-sections reshuffle happens mostly
     off screen, so the phone takes the crossfade the reduced-motion reader
     takes. One flag, so stage 2's shared-layout pass has one branch to skip. */
  const still = !!reduce || compact;

  /* Sections in the order Apply will write them, each chip carrying its index
     in the final reading order rather than in its own section, so the deal
     reads as one section filling and then the next. A page that has gone
     since the dialog opened is dropped: Apply drops it from the markdown for
     the same reason, and its uuid is not a thing to show a reader. */
  const dealt = useMemo(() => {
    if (!result) return null;
    const byId = new Map(pages.map((page) => [page.id, page]));
    let arrival = 0;
    return result.sections
      .map((label) => ({
        label,
        chips: sectionPageIds(result, label)
          .map((id) => byId.get(id))
          .filter((page): page is TreeNode => !!page)
          .map((page) => ({ page, arrival: arrival++ })),
      }))
      .filter((section) => section.chips.length > 0);
  }, [pages, result]);

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
              dealt ? (
                <>
                  <span className="font-medium text-ink">
                    {dealt.length === 1 ? "1 section" : `${dealt.length} sections`}
                  </span>
                  <span className="text-ink-3"> · Nothing saved yet</span>
                </>
              ) : (
                <>Reading {pages.length === 1 ? "1 page" : `${pages.length} pages`}</>
              )
            }
            closeLabel="Close smart sort"
            closeDisabled={applying}
          />

          {/* `data-edge="chips"`: a wrapped tile flow ends in a partial row,
              so the bottom fade carries a whole chip and its gap. Twenty
              pixels under a 28px chip read as one chip dimming, which is how
              a cut section came to look like the end of the list. */}
          <DialogBody className="px-5 py-4" data-edge="chips">
            {dealt ? (
              <div className="space-y-4">
                {dealt.map((section) => (
                  <div key={section.label}>
                    <p className="text-label pb-1.5 text-ink-3">
                      {section.label} · {section.chips.length}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {section.chips.map(({ page, arrival }) => (
                        <SortChip
                          key={page.id}
                          page={page}
                          index={arrival}
                          still={still}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="smart-heap flex flex-wrap gap-1.5"
                style={
                  { "--smart-sweep": `${pages.length * 24 + 600}ms` } as CSSProperties
                }
              >
                {!reduce && <span className="smart-heap-band" aria-hidden />}
                {pages.map((page, index) => (
                  <SortChip
                    key={page.id}
                    page={page}
                    index={index}
                    still={still}
                  />
                ))}
              </div>
            )}
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
                /* An answer with nothing in it (a page whose children went
                   between the press and the response) would write an empty
                   body, so there is nothing to press. */
                disabled={applying || !dealt?.length}
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

/** One page as a tile. The entrance is `materialize`'s own spring with no
 *  `y`: a vertical offset inside a wrapped flow reads as jitter rather than
 *  as a row falling in, and scale from a tile's own centre is what a tile
 *  arrives on. The stagger is capped in time, not at an index — sixty-one
 *  chips with the mail list's `index >= 8 ? 0` would deal eight and dump the
 *  rest in one frame. */
function SortChip({
  page,
  index,
  still,
}: {
  page: TreeNode;
  index: number;
  still: boolean;
}) {
  return (
    <motion.div
      className="min-w-0"
      initial={still ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
      animate={still ? { opacity: 1 } : { opacity: 1, scale: 1 }}
      transition={
        still
          ? { duration: DUR.fast }
          : { ...SPRING_MATERIALIZE, delay: Math.min(index * 0.012, 0.42) }
      }
    >
      <Chip emoji={page.icon ?? DEFAULT_PAGE_ICON} className="max-w-[220px]">
        {page.title || "Untitled page"}
      </Chip>
    </motion.div>
  );
}

/** True on the sheet form of this dialog (the `.brain-sheet` breakpoint). */
function useCompactViewport() {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const phone = window.matchMedia("(max-width: 767px)");
    const read = () => setCompact(phone.matches);
    read();
    phone.addEventListener("change", read);
    return () => phone.removeEventListener("change", read);
  }, []);
  return compact;
}
