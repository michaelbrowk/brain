"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR } from "@/lib/motion";
import type { ListName } from "@/lib/tasks/lists";

import type { TasksListState } from "./shell/helpers";
import { dayLabel, type TasksView } from "./tasks-lists";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { useMenuKeyRing } from "./ui/menu-key-ring";
import { ScrollEdge } from "./ui/scroll-edge";
import { ToolbarPill } from "./ui/toolbar-pill";
import { TasksContextMenu, type TasksContextAction } from "./tasks-context-menu";

/**
 * ONE CONTROL OWNS THE COLUMN'S ADDRESS, the way `MailNav` owns Mail's.
 *
 * The trigger names the list and the menu holds every destination: the five
 * lists in one radio block, the categories in another. A category in Brain is
 * a word and not an object, so those rows carry no glyph, only the word and
 * how many of its tasks are open.
 *
 * THE TRIGGER CARRIES NO COUNT. Mail's rule is that a count stands on a row
 * naming ONE destination, inside the menu, and the head says where you are
 * rather than how much is there. Today's tail is the date, because that is
 * what the word "Today" means today.
 */

const LISTS: readonly { list: ListName; label: string; icon: string }[] = [
  { list: "inbox", label: "Inbox", icon: "inbox-linear" },
  { list: "today", label: "Today", icon: "calendar-date-linear" },
  { list: "upcoming", label: "Upcoming", icon: "calendar-linear" },
  { list: "someday", label: "Someday", icon: "box-minimalistic-linear" },
  { list: "logbook", label: "Logbook", icon: "check-read-linear" },
];

const CATEGORY_PREFIX = "category:";

export function listLabel(list: ListName | "all"): string {
  if (list === "all") return "All tasks";
  return LISTS.find((entry) => entry.list === list)?.label ?? "Today";
}

/** THE ONE WORD THE COLUMN IS CALLED. The title on paper and the pill in the
 *  band say it together, so they read it off one function: the word drifting
 *  between the two would be the head disagreeing with itself. */
export function viewLabel(view: TasksView): string {
  return view.kind === "list"
    ? listLabel(view.list)
    : view.category || "No category";
}

export function TasksListMenu({
  view,
  today,
  categories,
  onSelect,
}: {
  view: TasksView;
  today: string;
  categories: readonly { category: string; open: number }[];
  onSelect: (next: TasksListState | null) => void;
}) {
  const label = viewLabel(view);
  // The tail is the day the word means. Only Today has one: "Upcoming 13 Sep"
  // would be naming a day the list is explicitly not about.
  const tail = view.kind === "list" && view.list === "today" ? dayLabel(today) : null;

  return (
    <Dropdown.Root>
      <ToolbarPill className="min-w-0 max-w-full">
        <Dropdown.Trigger asChild>
          <Button
            type="button"
            variant="quiet"
            /* The name, not the category of thing it is: Mail's nav pill
               names its folder the same way, and a screen reader here heard
               the word "List" before every switch. */
            aria-label={label}
            title={label}
            className="brain-touch-hit brain-tasks-nav"
          >
            <span className="min-w-0 truncate">{label}</span>
            {/* Spec 2.3, row 1: the date changed, so the tail crossfades
                rather than swapping in one frame. Keyed on the date, so it
                moves only when the day does. Opacity at `DUR.fast` is what
                §6 asks of a reduced-motion transition too, so there is one
                behaviour here and not two. */}
            {tail && (
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={tail}
                  className="shrink-0 tabular-nums text-ink-3"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                  transition={{ duration: DUR.fast }}
                >
                  {tail}
                </motion.span>
              </AnimatePresence>
            )}
            {/* the chevron does not turn: the feedback is the menu
                materializing, and a second one says the same thing twice */}
            <Icon name="alt-arrow-down-linear" size={16} className="shrink-0 text-ink-3" />
          </Button>
        </Dropdown.Trigger>
      </ToolbarPill>
      <TasksListMenuBody view={view} categories={categories} onSelect={onSelect} />
    </Dropdown.Root>
  );
}

/**
 * THE TITLE IS THE SWITCHER.
 *
 * The column's head is a note's head now, and on a note the loudest word on
 * paper is the page's own name. Here that name is also the one thing a reader
 * changes on this surface, so the word IS the control — the same menu, the
 * same rows, the same `onSelect` the band's pill opens, in the page-title
 * register with a chevron the size of the pill's own after it. A second
 * control beside the title would have been a button repeating the word next
 * to it, which is the thing the waiting pill above exists not to do.
 *
 * TWO ROOTS, ONE BODY. The pill and the title are triggers for one menu, and
 * a single `Dropdown.Root` has exactly one `Trigger`: whichever of the two
 * hosted it would be the one Radix returns focus to on close, including while
 * it is `visibility: hidden` and out of the tab order, which is a focus
 * landing on nothing. So each carries a Root of its own and they share the
 * body below. Only one of the two is reachable at a time — the title while it
 * is on screen, the pill once the title has scrolled out — so there is never
 * a beat where both could be open.
 */
export function TasksListTitle({
  view,
  categories,
  titleRef,
  onSelect,
}: {
  view: TasksView;
  categories: readonly { category: string; open: number }[];
  /** The observed element: the line it crosses is what brings the pill up. */
  titleRef: React.RefObject<HTMLButtonElement | null>;
  onSelect: (next: TasksListState | null) => void;
}) {
  const label = viewLabel(view);
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          ref={titleRef}
          type="button"
          /* The name, the way the pill says it: a reader hears the list and
             not the category of thing the control is, and a long category
             word truncates here as it does there, so the same `title` answers
             a hover on both. No `focus-inset`: that is for a ring inside a
             capsule, and this word stands on open paper with the whole canvas
             around it — drawn at −3 the ring ran through its own descenders,
             so it takes the global one at +2. */
          aria-label={label}
          title={label}
          className="brain-tasks-title text-title"
        >
          <span className="min-w-0 truncate">{label}</span>
          {/* the breadcrumb's own weight — a marker in ink-4, not a pill, and
              it does not turn: the menu materialising is the feedback */}
          <Icon
            name="alt-arrow-down-linear"
            size={16}
            className="brain-tasks-title-chevron"
          />
        </button>
      </Dropdown.Trigger>
      <TasksListMenuBody view={view} categories={categories} onSelect={onSelect} />
    </Dropdown.Root>
  );
}

/** The rows, once. Both triggers portal this same body, so a destination
 *  added here appears under both without either knowing about the other. */
function TasksListMenuBody({
  view,
  categories,
  onSelect,
}: {
  view: TasksView;
  categories: readonly { category: string; open: number }[];
  onSelect: (next: TasksListState | null) => void;
}) {
  const value =
    view.kind === "list" ? view.list : `${CATEGORY_PREFIX}${view.category}`;

  const goTo = (next: string) => {
    if (next.startsWith(CATEGORY_PREFIX)) {
      onSelect({ category: next.slice(CATEGORY_PREFIX.length) });
      return;
    }
    onSelect(next as ListName);
  };
  const keyRing = useMenuKeyRing();

  return (
    <Dropdown.Portal>
      <Dropdown.Content
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="brain-menu z-[var(--z-modal)] w-[264px]"
        {...keyRing}
      >
        {/* THE LIST SCROLLS, NOT THE MATERIAL, for the reason `MailNav` gives
            at its own menu: a reader with many categories on a short window
            would otherwise have rows below the fold with nothing to move.
            And the three things a scroller needs for a keyboard come with it,
            for the reasons given there too: scroll padding of the fade's two
            sizes so a row the arrow keys bring in stops clear of the mask,
            `focus-inset` on the rows because the scroller clips a ring that
            stands outside them, and the ring drawn for the keys only
            (`useMenuKeyRing`). */}
        <ScrollEdge
          variant="fade"
          className="max-h-[calc(var(--radix-dropdown-menu-content-available-height,100vh)-12px)] scroll-pt-3 scroll-pb-5 overscroll-contain"
          scrollerProps={{ role: "none" }}
        >
          <Dropdown.RadioGroup value={value} onValueChange={goTo}>
            {LISTS.map((entry) => (
              <Dropdown.RadioItem
                key={entry.list}
                value={entry.list}
                className="brain-menu-item focus-inset"
              >
                <Icon name={entry.icon} size={16} className="brain-menu-icon" />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {value === entry.list && (
                  <Icon name="check-linear" size={14} className="shrink-0 text-ink-2" />
                )}
              </Dropdown.RadioItem>
            ))}
            {categories.length > 0 && (
              <>
                <Dropdown.Separator className="brain-menu-sep" />
                <Dropdown.Label className="brain-menu-label">Categories</Dropdown.Label>
                {categories.map((entry) => {
                  const key = `${CATEGORY_PREFIX}${entry.category}`;
                  return (
                    <Dropdown.RadioItem
                      key={key}
                      value={key}
                      className="brain-menu-item focus-inset"
                    >
                      <span className="min-w-0 flex-1 truncate">{entry.category}</span>
                      <span className="tree-row-count">{entry.open}</span>
                      {value === key && (
                        <Icon name="check-linear" size={14} className="shrink-0 text-ink-2" />
                      )}
                    </Dropdown.RadioItem>
                  );
                })}
              </>
            )}
          </Dropdown.RadioGroup>
        </ScrollEdge>
      </Dropdown.Content>
    </Dropdown.Portal>
  );
}

/** The Tasks rail and the narrow Mail-style menu share one set of addresses.
 * Someday remains a scheduling choice; the complete history lives below the list. */
export const TASKS_DESTINATIONS = [
  { list: "inbox", label: "Inbox", icon: "inbox" },
  { list: "today", label: "Today", icon: "calendar-date" },
  { list: "upcoming", label: "Upcoming", icon: "calendar" },
  { list: "all", label: "All tasks", icon: "checklist" },
] as const;

type TaskNavigationCategory = { name: string; icon?: string };
interface TaskNavigationProps {
  view: TasksView;
  categories: readonly TaskNavigationCategory[];
  onSelect: (next: TasksListState | null) => void;
  categoryActions?: (name: string) => readonly TasksContextAction[];
}
function navigationGlyph(icon?: string) { return <span className="tree-row-glyph" aria-hidden>{icon || <Icon name="document-text" size={16} />}</span>; }

export function TasksNavigation({ view, categories, onSelect, categoryActions }: TaskNavigationProps) {
  const [open, setOpen] = useState(false);
  const keyRing = useMenuKeyRing();
  const value = view.kind === "category" ? `category:${view.category}` : view.list;
  const category = view.kind === "category" ? categories.find((entry) => entry.name === view.category) : undefined;
  const label = viewLabel(view);
  return <Dropdown.Root open={open} onOpenChange={setOpen}><ToolbarPill className="min-w-0 max-w-full"><TasksContextMenu category onOpenChange={(next) => { if (next) setOpen(false); }} actions={view.kind === "category" ? categoryActions?.(view.category) || [] : []}><Dropdown.Trigger asChild><Button type="button" variant="quiet" className="brain-touch-hit brain-mail-nav" aria-label={`Tasks view: ${label}`} title={label}>{view.kind === "category" && navigationGlyph(category?.icon)}<span className="min-w-0 truncate">{label}</span><Icon name="alt-arrow-down" size={16} className="shrink-0 text-ink-3" /></Button></Dropdown.Trigger></TasksContextMenu></ToolbarPill>
    <Dropdown.Portal><Dropdown.Content side="bottom" align="start" sideOffset={6} collisionPadding={8} className="brain-menu z-[var(--z-modal)] w-[264px]" {...keyRing}><ScrollEdge variant="fade" className="max-h-[calc(var(--radix-dropdown-menu-content-available-height,100vh)-12px)] scroll-pt-3 scroll-pb-5 overscroll-contain" scrollerProps={{ role: "none" }}><Dropdown.RadioGroup value={value} onValueChange={(next) => onSelect(next.startsWith("category:") ? { category: next.slice(9) } : next as TasksListState)}>
      <Dropdown.Label className="brain-menu-label">Lists</Dropdown.Label>{TASKS_DESTINATIONS.map((entry) => <Dropdown.RadioItem key={entry.list} value={entry.list} className="brain-menu-item focus-inset"><Icon name={entry.icon} size={16} variant={value === entry.list ? "bold" : "linear"} className="brain-menu-icon" /><span className="min-w-0 flex-1 truncate">{entry.label}</span>{value === entry.list && <Icon name="check" size={14} />}</Dropdown.RadioItem>)}
      {categories.length > 0 && <><Dropdown.Separator className="brain-menu-sep" /><Dropdown.Label className="brain-menu-label">Categories</Dropdown.Label>{categories.map((entry) => <Dropdown.RadioItem key={entry.name} value={`category:${entry.name}`} className="brain-menu-item focus-inset">{navigationGlyph(entry.icon)}<span className="min-w-0 flex-1 truncate">{entry.name || "No category"}</span>{value === `category:${entry.name}` && <Icon name="check" size={14} />}</Dropdown.RadioItem>)}</>}
    </Dropdown.RadioGroup></ScrollEdge></Dropdown.Content></Dropdown.Portal>
  </Dropdown.Root>;
}

export function TasksRail({ view, categories, onSelect, onNew, categoryActions }: TaskNavigationProps & { onNew: () => void }) {
  const value = view.kind === "category" ? `category:${view.category}` : view.list;
  return <aside className="tasks-rail" aria-label="Tasks navigation"><div className="tasks-rail-spacer" aria-hidden /><nav className="tasks-rail-views" aria-label="Tasks views">{TASKS_DESTINATIONS.map((entry) => <button type="button" key={entry.list} className="tree-row focus-inset" data-selected={value === entry.list ? "" : undefined} aria-current={value === entry.list ? "page" : undefined} onClick={() => onSelect(entry.list)}>{value === entry.list && <span className="tree-row-capsule" aria-hidden />}<span className="tree-row-glyph" aria-hidden><Icon name={entry.icon} size={16} variant={value === entry.list ? "bold" : "linear"} /></span><span className="tree-row-title">{entry.label}</span></button>)}</nav>
    {categories.length > 0 && <><div className="tasks-rail-label text-label">Categories</div><nav aria-label="Task categories">{categories.map((entry) => <TasksContextMenu key={entry.name} category actions={categoryActions?.(entry.name) || []}><button type="button" className="tree-row focus-inset" data-selected={value === `category:${entry.name}` ? "" : undefined} aria-current={value === `category:${entry.name}` ? "page" : undefined} onClick={() => onSelect({ category: entry.name })}>{value === `category:${entry.name}` && <span className="tree-row-capsule" aria-hidden />}{navigationGlyph(entry.icon)}<span className="tree-row-title">{entry.name || "No category"}</span></button></TasksContextMenu>)}</nav></>}
    <Button type="button" variant="quiet" className="tasks-rail-add" onClick={onNew}><Icon name="add" size={16} />Add task</Button>
  </aside>;
}
