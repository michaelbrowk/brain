"use client";

import { Fragment, type ReactNode } from "react";

export interface Crumb {
  label: ReactNode;
  emoji?: string;
  /** A parent is a link (`href`) or a button (`onClick`); the last crumb is
   *  the current page and renders as text. */
  href?: string;
  onClick?: () => void;
  /** Tooltip for a folded segment ("…" → the grandparent's title). */
  title?: string;
  /** Static states for the stand and screenshots. */
  hover?: boolean;
  pressed?: boolean;
  focus?: boolean;
  disabled?: boolean;
}

/** Breadcrumb pill — regular material 36 (DESIGN.md v2 → Materials: text in
 *  the pill is ink only). Emoji + parent (500, chevron) › current (600).
 *  Parents hover with the ink tint and an underline, press .97. The page
 *  meta ("Edited 2h ago") is NOT in here — it lives on paper. */
export function BreadcrumbPill({
  items,
  className = "",
  ...nav
}: Omit<React.HTMLAttributes<HTMLElement>, "className"> & {
  items: Crumb[];
  className?: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className={`crumb ${className}`} {...nav}>
      {items.map((item, i) => {
        const current = i === items.length - 1;
        const body = (
          <>
            {item.emoji && (
              <span className="crumb-glyph" aria-hidden>
                {item.emoji}
              </span>
            )}
            <span className="crumb-label truncate">{item.label}</span>
          </>
        );
        const state = {
          title: item.title,
          "data-hover": item.hover ? "" : undefined,
          "data-active": item.pressed ? "" : undefined,
          "data-focus": item.focus ? "" : undefined,
          "aria-disabled": item.disabled ? true : undefined,
        };
        return (
          <Fragment key={i}>
            {i > 0 && (
              <span className="crumb-sep" aria-hidden>
                ›
              </span>
            )}
            {current ? (
              <span className="crumb-seg" aria-current="page">
                {body}
              </span>
            ) : item.href ? (
              <a href={item.href} className="crumb-seg focus-inset" {...state}>
                {body}
              </a>
            ) : (
              <button type="button" onClick={item.onClick} className="crumb-seg focus-inset" {...state}>
                {body}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
