"use client";

import { useEffect, useState } from "react";
import { Button } from "./ui/button";

/** How long the interstitial waits before it goes back for the page. Long
 *  enough to read the sentence and reach the button that stops it, short
 *  enough that a store busy for a moment feels automatic. */
export const SHARE_BUSY_SECONDS = 5;

/** The retry the busy page used to do with `<meta http-equiv="refresh"
 *  content="1">`: a reload every second, for as long as the store stayed
 *  busy, that nobody could stop and that restarted a screen reader before it
 *  had finished the one sentence on the page. This counts down where the
 *  reader can see it and stops on a press, which is what WCAG 2.2.1 asks for.
 *  The page keeps its own link, so a browser running no scripts still has a
 *  way back. */
export function ShareBusyRetry({
  href,
  seconds = SHARE_BUSY_SECONDS,
  onRetry = (to: string) => location.assign(to),
}: {
  href: string;
  seconds?: number;
  onRetry?: (href: string) => void;
}) {
  const [left, setLeft] = useState(seconds);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    if (stopped) return;
    if (left <= 0) {
      onRetry(href);
      return;
    }
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [href, left, onRetry, stopped]);

  if (stopped) return null;
  return (
    // No live region: the count changes every second and announcing each one
    // would talk over the page. A reader meets the sentence and the button
    // once, in order.
    <p
      data-share-busy-countdown
      className="flex items-center gap-1 text-caption text-ink-3"
    >
      Trying again in {left}s.
      <Button type="button" variant="quiet" onClick={() => setStopped(true)}>
        Stop
      </Button>
    </p>
  );
}
