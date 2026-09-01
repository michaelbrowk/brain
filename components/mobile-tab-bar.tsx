"use client";

import type { RefObject } from "react";
import { Icon } from "./ui/icon";

interface MobileTabBarProps {
  homeActive: boolean;
  searchActive: boolean;
  pagesActive: boolean;
  mailActive: boolean;
  hidden?: boolean;
  contained?: boolean;
  searchRef?: RefObject<HTMLButtonElement | null>;
  pagesRef?: RefObject<HTMLButtonElement | null>;
  onHome: () => void;
  onSearch: (invoker: HTMLElement) => void;
  onNew: () => void;
  onPages: (invoker: HTMLElement) => void;
  onMail: () => void;
}

/** Linear at rest, bold when current (the SF Symbols regular/fill pair);
 *  names without a bold pair fall back to linear. New is not a tab — it is
 *  the surface's one ink-filled primary, the accent circle carrying the same
 *  glyph as the desktop "New page" button — a bare plus, the mark this
 *  system uses for making a page (the template menu, the tree row menu), with
 *  nothing drawn around it: the button is already the shape (DESIGN.md §10 ban
 *  13). It was the composing pen, and on a phone with mail open that pen
 *  also sits on the account row above: two wordless controls, one drawing,
 *  two different things. Pages, in the very next slot, keeps `document-text`,
 *  the page itself, and carries its word underneath; this one is wordless, so
 *  it has to say the act in the drawing. Names here are bare — the variant is
 *  the second argument, and a name that carries its own suffix reads as a
 *  different kind of entry. */
const items = [
  { key: "home", label: "Home", icon: "home" },
  { key: "search", label: "Search", icon: "magnifer" },
  { key: "new", label: "New", icon: "add" },
  { key: "pages", label: "Pages", icon: "document-text" },
  { key: "mail", label: "Mail", icon: "letter" },
] as const;

/** Mobile-first primary navigation: a floating thick capsule centred over the
 *  safe area, sized by its five slots rather than by the window and never
 *  nearer to it than the 8px inset (DESIGN.md v2 → Geometry: nothing floating
 *  touches the window edge). The canvas passes under it and the material
 *  blurs on its own — no hairline, no edge band. Pages can contain this bar
 *  inside its modal focus scope; desktop keeps its sidebar. */
export function MobileTabBar({
  homeActive,
  searchActive,
  pagesActive,
  mailActive,
  hidden = false,
  contained = false,
  searchRef,
  pagesRef,
  onHome,
  onSearch,
  onNew,
  onPages,
  onMail,
}: MobileTabBarProps) {
  return (
    <nav
      aria-label="Primary"
      aria-hidden={hidden || undefined}
      data-contained={contained ? "" : undefined}
      data-hidden={hidden ? "" : undefined}
      // contained inside the Pages sheet or the search view the bar is a
      // plain row of that surface — a second material inside a material is
      // glass on glass (ban #1)
      className={contained ? "brain-mobile-tabbar" : "brain-mobile-tabbar mat-thick"}
    >
      <div className="brain-mobile-tabbar-items">
        {items.map((item) => {
          const active =
            (item.key === "home" && homeActive) ||
            (item.key === "search" && searchActive) ||
            (item.key === "pages" && pagesActive) ||
            (item.key === "mail" && mailActive);
          return (
            <button
              key={item.key}
              data-mobile-tab={item.key}
              ref={
                item.key === "search"
                  ? searchRef
                  : item.key === "pages"
                    ? pagesRef
                    : undefined
              }
              type="button"
              tabIndex={hidden ? -1 : undefined}
              aria-current={active ? "page" : undefined}
              aria-label={item.key === "new" ? item.label : undefined}
              onClick={(event) => {
                if (item.key === "home") onHome();
                else if (item.key === "search") onSearch(event.currentTarget);
                else if (item.key === "new") onNew();
                else if (item.key === "pages") onPages(event.currentTarget);
                else onMail();
              }}
              className="brain-mobile-tab brain-touch-min focus-inset"
            >
              {item.key === "new" ? (
                <span className="brain-mobile-tab-new" aria-hidden>
                  <Icon name={item.icon} size={17} />
                </span>
              ) : (
                <>
                  <Icon
                    name={item.icon}
                    size={18}
                    variant={active ? "bold" : "linear"}
                  />
                  <span>{item.label}</span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
