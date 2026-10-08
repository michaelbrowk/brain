import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** The band ProseMirror keeps the caret out of when it scrolls a typed line
 *  into view. At the top it is the toolbar pills floating over the canvas
 *  (36 + inset 12): scrolling starts inside the band and lands below it. At
 *  the bottom it is the resting 24 / 32, plus whatever is docked over the
 *  window's bottom edge on a phone: the keyboard, which the layout viewport
 *  does not shrink for, and the writing bar standing on it.
 *
 *  The band is a plugin prop rather than a view option so it can change
 *  without `setProps`: ProseMirror reads `scrollThreshold` and `scrollMargin`
 *  off the plugins on every scroll, and `setProps` re-runs the view's state
 *  update, which flushes the DOM observer. Landing inside the 20ms after an
 *  Enter, that flush read Chrome's mid-split selection (the top of the
 *  page) as the caret's new place. */
const REST_THRESHOLD = 24;
const REST_MARGIN = 32;

const band = {
  scrollThreshold: { top: 64, right: 0, bottom: REST_THRESHOLD, left: 0 },
  scrollMargin: { top: 76, right: 0, bottom: REST_MARGIN, left: 0 },
};

/** Widens the bottom of the band by what stands on the window's bottom edge
 *  (0 puts the resting band back). One keyboard per window, so one band. */
export function setScrollBandInset(bottomInset: number) {
  band.scrollThreshold.bottom = REST_THRESHOLD + bottomInset;
  band.scrollMargin.bottom = REST_MARGIN + bottomInset;
}

/** The band as the view reads it now. */
export function currentScrollBand() {
  return {
    scrollThreshold: { ...band.scrollThreshold },
    scrollMargin: { ...band.scrollMargin },
  };
}

export const scrollBand = $prose(
  () =>
    new Plugin({
      key: new PluginKey("brainScrollBand"),
      props: { scrollThreshold: band.scrollThreshold, scrollMargin: band.scrollMargin },
    }),
);
