"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Attributes the fade scroller forwards to its own element — including the
 *  `data-*` handle a consumer looks itself up by, which React's own
 *  `HTMLAttributes` does not model. */
type ScrollerProps = Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children"> & {
  readonly [key: `data-${string}`]: string | undefined;
};

/** Scroll-edge atom (DESIGN.md v2 → Scroll-edge).
 *
 *  Reserved for lists and panels: the sidebar tree, a mail list under its pill
 *  toolbar, settings content, palette results. The page canvas has no edge
 *  band — the toolbar pills are glass and blur what passes beneath them on
 *  their own.
 *
 *  Invisible at rest. Each edge is gated by what it stands for: the TOP edge
 *  appears while the scroller's first pixel is out of view (`data-scrolled`,
 *  scrollTop > 0); the BOTTOM edge appears while content continues below
 *  the fold (`data-scroll-more`, the end sentinel out of view) — a list that
 *  fits, or one scrolled to its end, shows no bottom edge. Both attributes
 *  are set by `useScrollEdge` from IntersectionObservers on 1px sentinels,
 *  off the scroll event path. The edge then fades in over 160ms, opacity
 *  only; under reduced motion it appears instantly. Two variants:
 *
 *  - `blur`: list content goes UNDER floating chrome (thread list under its
 *    pill toolbar, list bottom under a floating chip). Renders a sticky,
 *    pointer-transparent layer as a direct child of the scroller — first for
 *    `top`, last for `bottom`. Each edge renders its own sentinel (the top
 *    one first in the scroller, the bottom one right before itself) and owns
 *    its observer, so a scroller with blur edges needs nothing else. Two
 *    sibling backdrop layers make the progressive blur (`steps={2}`);
 *    everything else uses one (`steps={1}`). `size` = chrome height + inset +
 *    28 (toolbar 36 → 76).
 *
 *  - `fade`: inside glass panels (tree, popover lists, palette results). No
 *    backdrop-filter — a mask on the scroller itself. Renders the scroller:
 *    put the rows inside. 12px at the top once scrolled, 20px at the bottom
 *    while content continues.
 *
 *  Matte fallback (reduced transparency, no backdrop-filter support) is
 *  handled in globals.css by remapping the `--edge-*` tokens to a paper
 *  gradient; the markup does not change. */
export function ScrollEdge(
  props:
    | {
        variant?: "blur";
        position?: "top" | "bottom";
        /** Layer height in px. 76 = 36px toolbar + 12 inset + 28 bleed. */
        size?: number;
        /** 2 = progressive 12px over 2px. 1 = single 10px. */
        steps?: 1 | 2;
        className?: string;
      }
    | {
        variant: "fade";
        className?: string;
        children: ReactNode;
        /** Extra props for the scroller (role, aria-label, tabIndex…, plus
         *  the `data-*` handle a consumer looks itself up by). */
        scrollerProps?: ScrollerProps;
      },
) {
  if (props.variant === "fade") {
    return (
      <FadeScroller className={props.className} {...props.scrollerProps}>
        {props.children}
      </FadeScroller>
    );
  }
  return <BlurEdge {...props} />;
}

function BlurEdge({
  position = "top",
  size = 76,
  steps = 2,
  className = "",
}: {
  position?: "top" | "bottom";
  size?: number;
  steps?: 1 | 2;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const scroller = ref.current?.parentElement;
    const sentinel = sentinelRef.current;
    if (!scroller || !sentinel) return;
    return observeScrollEdge(scroller, sentinel, position === "top" ? "scrolled" : "scrollMore");
  }, [position]);
  return (
    <>
      <Sentinel ref={sentinelRef} />
      <div
        ref={ref}
        aria-hidden
        className={`edge ${className}`}
        data-position={position}
        data-steps={steps}
        style={size !== 76 ? ({ "--edge-size": `${size}px` } as React.CSSProperties) : undefined}
      >
        <i />
        {steps === 2 && <i />}
      </div>
    </>
  );
}

function FadeScroller({
  className = "",
  children,
  ...rest
}: ScrollerProps & { className?: string; children?: ReactNode }) {
  const { ref, sentinelRef, endRef } = useScrollEdge<HTMLDivElement>();
  return (
    <div ref={ref} className={`edge-fade overflow-y-auto ${className}`} {...rest}>
      <Sentinel ref={sentinelRef} />
      {children}
      <Sentinel ref={endRef} end />
    </div>
  );
}

/** 1px child of a scroller — first for the top edge, last for the bottom
 *  one; the negative margin keeps it out of the layout so the rows start
 *  (and end) where they would without it. */
function Sentinel({ ref, end }: { ref: React.Ref<HTMLDivElement>; end?: boolean }) {
  return (
    <div ref={ref} aria-hidden className={`${end ? "-mt-px" : "-mb-px"} h-px w-full shrink-0`} />
  );
}

/** Marks a scroller with `data-scrolled` while its first pixel is scrolled
 *  out of view (scrollTop > 0) and with `data-scroll-more` while its last
 *  pixel is (content continues below). IntersectionObservers on 1px
 *  sentinels keep this off the scroll event path. Attach `ref` to the
 *  scroller, `sentinelRef` to a 1px first child and `endRef` to a 1px last
 *  child (either may be left unattached). `<ScrollEdge variant="fade">` and
 *  the blur edges do this themselves. */
export function useScrollEdge<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const stops = [
      sentinelRef.current && observeScrollEdge(root, sentinelRef.current, "scrolled"),
      endRef.current && observeScrollEdge(root, endRef.current, "scrollMore"),
    ];
    return () => stops.forEach((stop) => stop?.());
  }, []);
  return { ref, sentinelRef, endRef };
}

function observeScrollEdge(root: HTMLElement, sentinel: Element, flag: "scrolled" | "scrollMore") {
  if (typeof IntersectionObserver === "undefined") return;
  const io = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) delete root.dataset[flag];
      else root.dataset[flag] = "";
    },
    { root, threshold: 0 },
  );
  io.observe(sentinel);
  return () => io.disconnect();
}
