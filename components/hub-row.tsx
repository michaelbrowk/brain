"use client";

// ONE ROW SHAPE FOR THE WHOLE OF HOME.
//
// A page that changed, a letter that is waiting, a digest of the rest: three
// kinds of thing, one line each, and the only difference between them is the
// glyph in the 20px slot and what the tail says. 40 tall on a phone and 36 on
// the desktop, `--r-block`, 14px, the capsule pulled 8px past the column on
// both sides so the content starts on the column's own edge.
//
// It lives in its own module because two blocks draw it and neither may own
// it: a row shape that belonged to one of them would be copied into the other
// the first time the two needed to differ by a pixel.

import type { ReactNode } from "react";

export function HubRow({
  onClick,
  glyph,
  trailing,
  children,
  ...rest
}: {
  onClick: () => void;
  /** The 20px slot: a page emoji, a sender's letter, a checkbox. */
  glyph: ReactNode;
  /** Caption 12 at the row's end, in `--ink-3`. */
  trailing?: ReactNode;
  children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className" | "onClick">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 flex h-10 w-[calc(100%+16px)] items-center gap-2.5 rounded-[var(--r-block)] px-2 text-left transition-colors hover:bg-blue-tint md:h-9"
      {...rest}
    >
      <span className="grid size-5 shrink-0 place-items-center text-[15px] leading-none">
        {glyph}
      </span>
      {children}
      {trailing !== undefined && (
        <span className="shrink-0 text-[12px] text-ink-3">{trailing}</span>
      )}
    </button>
  );
}
