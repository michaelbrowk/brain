"use client";

import { useEffect, useRef } from "react";

/** A PANEL THAT SAYS WHEN IT IS STANDING.
 *
 *  ESCAPE PEELS ONE LAYER AT A TIME. The key closes the panel on top, and what
 *  is underneath it belongs to the next key: one dismissal per press is how a
 *  press outside has always been spent, and the key says the same sentence. So
 *  whatever is underneath has to know a panel is up.
 *
 *  It cannot find that out by looking. Every panel a chip opens is portalled
 *  to the end of the document, and one layer — a row's title editor — is an
 *  `input` the row swapped its own words for, with no flag on anything. The
 *  panel says so itself, to the host that asked.
 *
 *  The callback is held in a ref, so a host that hands over a fresh function
 *  every render is not told the same panel opened twice; and the closing word
 *  is the effect's own cleanup, so a panel taken away with its host still
 *  says it has gone.
 */
/** A LAYER STANDING IN THE DOCUMENT, for the two questions the register above
 *  cannot answer: a panel nobody reports (the palette, a shell dialog), and a
 *  panel reported a commit later than the press or the focus that has to be
 *  decided now.
 *
 *  THE INVARIANT IT RESTS ON. Every shape named here is a TRANSIENT layer
 *  whose own dismissal takes it out of the document: a popper wrapper exists
 *  only while its content is mounted, and a dialog or a menu carries
 *  `data-state="open"` only while it is open. Anything that keeps that
 *  attribute on a PERSISTENT element would hold an expanded row open
 *  underneath it for as long as it stood — a Radix `Collapsible` or
 *  `Accordion` in the sidebar, or a piece of chrome with `data-state="open"`
 *  written on it by hand, which `components/mail-composer.tsx` does on a
 *  canvas that cannot be mounted beside Tasks. That is why this names the
 *  three shapes a portalled layer has, rather than asking for
 *  `[data-state='open']` at large. */
export const LAYER_IN_DOCUMENT =
  "[data-radix-popper-content-wrapper], " +
  "[role='dialog'][data-state='open'], " +
  "[role='menu'][data-state='open']";

export function useLayerSignal(
  open: boolean,
  report: ((open: boolean) => void) | undefined,
): void {
  const held = useRef(report);
  useEffect(() => {
    held.current = report;
  });
  useEffect(() => {
    if (!open) return;
    held.current?.(true);
    return () => held.current?.(false);
  }, [open]);
}
