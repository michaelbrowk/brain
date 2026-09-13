"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import type { ListName } from "@/lib/tasks/lists";

import type { TasksListState } from "./shell/helpers";
import { dayLabel, type TasksView } from "./tasks-lists";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { ScrollEdge } from "./ui/scroll-edge";
import { ToolbarPill } from "./ui/toolbar-pill";

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

export function listLabel(list: ListName): string {
  return LISTS.find((entry) => entry.list === list)?.label ?? "Today";
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
  const value =
    view.kind === "list" ? view.list : `${CATEGORY_PREFIX}${view.category}`;
  const label = view.kind === "list" ? listLabel(view.list) : view.category || "No category";
  // The tail is the day the word means. Only Today has one: "Upcoming 13 Sep"
  // would be naming a day the list is explicitly not about.
  const tail = view.kind === "list" && view.list === "today" ? dayLabel(today) : null;

  const goTo = (next: string) => {
    if (next.startsWith(CATEGORY_PREFIX)) {
      onSelect({ category: next.slice(CATEGORY_PREFIX.length) });
      return;
    }
    onSelect(next as ListName);
  };

  return (
    <Dropdown.Root>
      <ToolbarPill className="min-w-0 max-w-full">
        <Dropdown.Trigger asChild>
          <Button
            type="button"
            variant="quiet"
            aria-label={`List: ${label}`}
            title={label}
            className="brain-touch-hit brain-tasks-nav"
          >
            <span className="min-w-0 truncate">{label}</span>
            {tail && <span className="shrink-0 tabular-nums text-ink-3">{tail}</span>}
            {/* the chevron does not turn: the feedback is the menu
                materializing, and a second one says the same thing twice */}
            <Icon name="alt-arrow-down-linear" size={16} className="shrink-0 text-ink-3" />
          </Button>
        </Dropdown.Trigger>
      </ToolbarPill>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[264px]"
        >
          {/* THE LIST SCROLLS, NOT THE MATERIAL, for the reason `MailNav` gives
              at its own menu: a reader with many categories on a short window
              would otherwise have rows below the fold with nothing to move. */}
          <ScrollEdge
            variant="fade"
            className="max-h-[calc(var(--radix-dropdown-menu-content-available-height,100vh)-12px)] overscroll-contain"
            scrollerProps={{ role: "none" }}
          >
            <Dropdown.RadioGroup value={value} onValueChange={goTo}>
              {LISTS.map((entry) => (
                <Dropdown.RadioItem
                  key={entry.list}
                  value={entry.list}
                  className="brain-menu-item"
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
                        className="brain-menu-item"
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
    </Dropdown.Root>
  );
}
