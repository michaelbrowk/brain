"use client";

import type { MutableRefObject } from "react";

export interface DialogFocusLease {
  owner: number;
  target: HTMLElement | null;
  fallback: () => HTMLElement | null;
}

export type DialogFocusLeaseRef = MutableRefObject<DialogFocusLease | null>;

export function claimDialogFocus(
  ref: DialogFocusLeaseRef,
  owner: number,
  target: HTMLElement | null,
  fallback: () => HTMLElement | null,
) {
  ref.current = { owner, target, fallback };
}

function focusTarget(target: HTMLElement | null): boolean {
  if (!target?.isConnected) return false;
  const style = getComputedStyle(target);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (target instanceof HTMLButtonElement && target.disabled) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** Restore only the focus lease owned by this exact dialog opening. */
export function restoreDialogFocus(
  event: Event,
  ref: DialogFocusLeaseRef,
  owner: number,
): boolean {
  const lease = ref.current;
  if (!lease) return false;
  if (lease.owner !== owner) {
    event.preventDefault();
    return false;
  }

  event.preventDefault();
  try {
    if (!focusTarget(lease.target)) focusTarget(lease.fallback());
  } finally {
    if (ref.current?.owner === owner) ref.current = null;
  }
  return true;
}
