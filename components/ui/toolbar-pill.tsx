"use client";

import type { HTMLAttributes } from "react";

/** Toolbar pill — a regular-material capsule 36 hosting `IconButton size={36}`
 *  (and `Button variant="quiet"`), with `ToolbarDivider` between groups.
 *  Each button inside carries its own five states (`.icon-btn`); the pill is
 *  self-blurring glass — the canvas under it gets no edge band. */
export function ToolbarPill({
  className = "",
  ...group
}: Omit<HTMLAttributes<HTMLDivElement>, "className"> & { className?: string }) {
  return <div role="group" className={`toolbar-pill ${className}`} {...group} />;
}

export function ToolbarDivider() {
  return <span aria-hidden className="toolbar-divider" />;
}
