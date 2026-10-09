import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** The band ProseMirror keeps the caret out of when it scrolls a typed line
 *  into view. At the top it is the toolbar pills floating over the canvas
 *  (36 + inset 12): scrolling starts inside the band and lands below it. At
 *  the bottom it is the resting 24 / 32, plus whatever is docked over the
 *  window's bottom edge on a phone: the keyboard, which the layout viewport
 *  does not shrink for, the writing bar standing on it, and the selection
 *  toolbar stacked on that while words are selected.
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

/** What each docked thing takes of the window's bottom edge, by owner (the
 *  writing bar with the keyboard under it, the selection toolbar stacked on
 *  that), so the two add up and each can leave without knowing about the
 *  other. One keyboard per window, so one band. 0 takes the owner out. */
const docked = new Map<string, number>();

export function setDockedInset(owner: string, px: number) {
  if (px > 0) docked.set(owner, px);
  else docked.delete(owner);
  let total = 0;
  for (const height of docked.values()) total += height;
  band.scrollThreshold.bottom = REST_THRESHOLD + total;
  band.scrollMargin.bottom = REST_MARGIN + total;
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
