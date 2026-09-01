"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "./icon";

/** Pinned tile on glass (28, r14): white .50 fill, 600 ink. `active` flips a
 *  Solar icon to its bold pair (an emoji stays as it is). Styled by `.chip`
 *  in globals.css; the matte fallback remaps the fill to an ink tint. */
export function Chip({
  emoji,
  icon,
  children,
  active = false,
  hover,
  pressed,
  className = "",
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  emoji?: string;
  icon?: string;
  children: ReactNode;
  active?: boolean;
  /** Static states for the stand and screenshots. */
  hover?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`chip tint-hover focus-inset ${className}`}
      data-active-state={active ? "" : undefined}
      data-hover={hover ? "" : undefined}
      data-active={pressed ? "" : undefined}
      aria-pressed={active || undefined}
      {...button}
    >
      {(emoji || icon) && (
        <span className="chip-glyph" aria-hidden>
          {emoji ?? <Icon name={icon!} size={16} variant={active ? "bold" : "linear"} />}
        </span>
      )}
      <span className="truncate">{children}</span>
    </button>
  );
}
