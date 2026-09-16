"use client";

import { useEffect } from "react";

/** Value #1 — chrome that repeats what the page already says gets out of the
 *  way. A breadcrumb with one segment IS the title, a few centimetres above
 *  it, so it waits: while the title is on screen the shell carries nothing
 *  and the lone crumb stays hidden; when the title leaves the shell takes
 *  `data-title-out` and the crumb materialises (globals.css →
 *  `.brain-crumb-lone`). A crumb carrying an ancestor says something the
 *  title does not, and is gated by none of this.
 *
 *  The line is the scroller's own top, not the bottom of the pill band. The
 *  pills cover a strip at the left of the canvas, not the whole width — the
 *  document column runs to the right of them — so a title level with the
 *  pills is still on screen and still naming the page, and handing over
 *  there would put the same word in two places at once. Leaving at the top
 *  edge makes the handover exact: the crumb takes the name in the frame the
 *  title gives it up.
 *
 *  An IntersectionObserver on the title, the scroll-edge atom's pattern
 *  (DESIGN.md v2 → §7): off the scroll event path, and the flag lands on the
 *  DOM rather than in state, so crossing the line never re-renders the
 *  shell. Hidden is the rest state, so the crumb cannot flash before the
 *  first callback — an engine without the observer is handed the crumb it
 *  has always had.
 *
 *  TWO SURFACES ASK FOR THIS, so it takes the two selectors rather than
 *  naming the page's. A note hands the flag to `.brain-main` off
 *  `.brain-page-scroll`; the Tasks column hands it to `.brain-tasks` off
 *  `.brain-tasks-scroll`, where what waits is the head's own list pill.
 *  Copying it would have been two observers to keep in step. */
export function useTitleReveal(
  ref: React.RefObject<HTMLElement | null>,
  { scroller: scrollerSelector, host: hostSelector }: {
    /** The scroller whose top edge is the line. */
    scroller: string;
    /** The element that carries `data-title-out` for the waiting pill. */
    host: string;
  },
) {
  useEffect(() => {
    const title = ref.current;
    const scroller = title?.closest<HTMLElement>(scrollerSelector);
    const host = title?.closest<HTMLElement>(hostSelector);
    if (!title || !scroller || !host) return;
    // The flag lives on the host, which outlives any one title: during a
    // canvas change two titles are mounted at once, so the leaving one must
    // not clear a flag the arriving one has just set. Each observer clears
    // only what it set itself. Harmless today — navigation always opens a
    // page at the top — and not harmless the day scroll restoration lands.
    let owns = false;
    const set = () => {
      owns = true;
      host.dataset.titleOut = "";
    };
    const clear = () => {
      if (!owns) return;
      owns = false;
      delete host.dataset.titleOut;
    };
    if (typeof IntersectionObserver === "undefined") {
      set();
      return clear;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) clear();
        else set();
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(title);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [hostSelector, ref, scrollerSelector]);
}
