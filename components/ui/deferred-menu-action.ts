"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Opens a dialog only after Radix has completely released the modal menu.
 * Opening both layers in the same event can leave `body` inert after the
 * dialog closes.
 */
export function useDeferredMenuAction() {
  const pendingRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);

  const defer = useCallback((action: () => void) => {
    pendingRef.current = action;
  }, []);

  const runAfterClose = useCallback(() => {
    const action = pendingRef.current;
    pendingRef.current = null;
    if (!action) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      action();
    }, 0);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return { defer, runAfterClose };
}
