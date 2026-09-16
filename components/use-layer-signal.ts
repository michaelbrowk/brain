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
