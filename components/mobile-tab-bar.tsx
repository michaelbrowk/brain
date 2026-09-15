"use client";

import type { RefObject } from "react";
import type { Template } from "@/lib/templates";
import { NewMenu } from "./new-menu";
import { Icon } from "./ui/icon";

interface MobileTabBarProps {
  homeActive: boolean;
  searchActive: boolean;
  tasksActive: boolean;
  pagesActive: boolean;
  mailActive: boolean;
  hidden?: boolean;
  searchRef?: RefObject<HTMLButtonElement | null>;
  pagesRef?: RefObject<HTMLButtonElement | null>;
  onHome: () => void;
  onSearch: (invoker: HTMLElement) => void;
  onTasks: () => void;
  /** One of the three creates the plus offers; the page one carries the
   *  template the menu's Page group picked. */
  onNew: (template: Template) => void;
  onNewTask: () => void;
  onNewMessage: () => void;
  onPages: (invoker: HTMLElement) => void;
  onMail: () => void;
}

/** Linear at rest, bold when current (the SF Symbols regular/fill pair);
 *  names without a bold pair fall back to linear. Tasks takes `checklist`,
 *  and not `sun`, which the Journal row owns: it is the one Solar candidate
 *  drawn bare in both weights, where `check-read` and `checklist-minimalistic`
 *  each fill the rounded square `document-text` and `letter` already wear
 *  once they go bold (DESIGN.md §10 ban 13). Names here are bare — the
 *  variant is the second argument, and a name that carries its own suffix
 *  reads as a different kind of entry. */
const items = [
  { key: "home", label: "Home", icon: "home" },
  { key: "search", label: "Search", icon: "magnifer" },
  { key: "tasks", label: "Tasks", icon: "checklist" },
  { key: "pages", label: "Pages", icon: "document-text" },
  { key: "mail", label: "Mail", icon: "letter" },
] as const;

/** Mobile-first primary navigation: TWO objects on one line at the bottom
 *  inset, both 54 tall. The bar stands on the left inset, sized by its five
 *  slots rather than by the window (DESIGN.md v2 → Geometry: what floats is
 *  sized by its content); New stands on the right one as an ink circle,
 *  the surface's one ink-filled control (§2 → Primary), wearing the bare plus
 *  the desktop circle wears for the same act and opening the same menu it
 *  opens: a task, a message or a page. New was a slot in the middle of
 *  the bar, which put a create between two destinations and asked a run of
 *  six identical cells to say that one of them was not navigation.
 *
 *  They are siblings with no wrapper: what holds the line together is the
 *  state they share. `hidden` writes `data-hidden` on both, one source and
 *  two consumers, so a sheet, the keyboard or the palette takes the whole
 *  line away rather than leaving a plus standing over an open sheet. The
 *  plus comes last in the document, after Mail, so Tab reads the line left
 *  to right.
 *
 *  The canvas passes under both and the material blurs on its own, with no
 *  hairline and no edge band. Search and Pages render their own copy inside
 *  their focus scope, with the same positions and the same material, so the
 *  line looks and sits identically whichever of the five tabs is up; desktop
 *  keeps its sidebar. */
export function MobileTabBar({
  homeActive,
  searchActive,
  tasksActive,
  pagesActive,
  mailActive,
  hidden = false,
  searchRef,
  pagesRef,
  onHome,
  onSearch,
  onTasks,
  onNew,
  onNewTask,
  onNewMessage,
  onPages,
  onMail,
}: MobileTabBarProps) {
  return (
    <>
      <nav
        aria-label="Primary"
        aria-hidden={hidden || undefined}
        data-hidden={hidden ? "" : undefined}
        className="brain-mobile-tabbar mat-thick"
      >
        <div className="brain-mobile-tabbar-items">
          {items.map((item) => {
            const active =
              (item.key === "home" && homeActive) ||
              (item.key === "search" && searchActive) ||
              (item.key === "tasks" && tasksActive) ||
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
                onClick={(event) => {
                  if (item.key === "home") onHome();
                  else if (item.key === "search") onSearch(event.currentTarget);
                  else if (item.key === "tasks") onTasks();
                  else if (item.key === "pages") onPages(event.currentTarget);
                  else onMail();
                }}
                className="brain-mobile-tab brain-touch-min focus-inset"
              >
                <Icon
                  name={item.icon}
                  size={18}
                  variant={active ? "bold" : "linear"}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      {/* The plus is the mark this system draws for making a thing (the New
          menu, the tree row menu, the desktop circle), with nothing
          drawn around it: the button is already the shape (DESIGN.md §10 ban
          13). It was the composing pen, and on a phone with mail open that
          pen also sits on the account row above: two wordless controls, one
          drawing, two different things. Pages, a slot away in the bar, keeps
          `document-text`, the page itself, and carries its word underneath;
          this one is wordless, so it has to say the act in the drawing, and
          it says it under the name the desktop circle answers to. */}
      {/* `fixed` is the opt-out `brain-touch-min` asks for: the touch helper
          pins anything it is on to `position: relative` unless the element
          says it is placed itself, and without it the circle drops out of the
          line and lands wherever the flow leaves it. */}
      {/* IT OPENS THE MENU THE SIDEBAR'S CIRCLE OPENS, as a sheet above the
          line. One control, one offer, two widths: a phone that made a page
          outright while the desktop asked which of three things to make would
          be two products wearing one plus. The sheet form is the menu's own
          (`new-menu.tsx`), the form the When picker and the composer already
          take below md. */}
      <NewMenu
        onPickTemplate={onNew}
        onNewTask={onNewTask}
        onNewMessage={onNewMessage}
      >
        <button
          type="button"
          aria-label="New"
          aria-hidden={hidden || undefined}
          data-hidden={hidden ? "" : undefined}
          tabIndex={hidden ? -1 : undefined}
          className="brain-mobile-new fixed brain-touch-min focus-inset"
        >
          <span className="brain-mobile-new-circle" aria-hidden>
            <Icon name="add" size={17} />
          </span>
        </button>
      </NewMenu>
    </>
  );
}
