"use client";

// THE BELL, AND THE CENTRE UNDER IT.
//
// It stands in the sidebar head beside New page, on the regular menu material
// every other menu in the product uses, because a notification centre is a
// menu: a short list of things that happened, each one a way into the place it
// happened. Nothing here is a surface of its own and nothing here is a dialog.
//
// THE ROWS ARE ONE LINE EACH. `.brain-menu-item` is 32 tall across the whole
// product and the body sits after the title in quiet ink rather than under it,
// which is the arrangement Home's mail rows already use for a sender and a
// subject. A second line here would be a second row height in a menu system
// that has exactly one.

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { formatAgo } from "@/lib/format-ago";
import { DUR } from "@/lib/motion";
import { decodeMailNotificationId } from "@/lib/notifications/ids";
import { defaultMailSurfaceClient } from "./mail-surface-client";
import {
  markAllRead,
  markRead,
  useNotifications,
  type NotificationRow,
} from "./notifications-client";
import { Empty } from "./ui/empty";
import { Icon } from "./ui/icon";
import { IconButton } from "./ui/button";
import { ScrollEdge } from "./ui/scroll-edge";

/** One glyph per kind. A reminder that fired wears the alarm, one that was
 *  missed wears the clock, and new mail wears the letter Mail wears
 *  everywhere else. Exported because Home's first row on a phone draws the
 *  same three kinds and a second table of them would drift. */
export const KIND_GLYPH: Record<NotificationRow["kind"], string> = {
  "task-reminder": "alarm-linear",
  "task-missed": "clock-circle-linear",
  "mail-new": "letter-linear",
};

/** Past this the number is wider than the glyph it rides and says nothing a
 *  reader can act on that "a lot" does not. */
const BADGE_CAP = 99;

/** WHAT A ROW DOES WHEN IT IS PRESSED, wherever it is drawn. The menu here and
 *  `components/hub-notifications.tsx` on a phone are two drawings of one list,
 *  and a second copy of this would be the place the two stopped agreeing. */
export function openNotificationRow(
  row: NotificationRow,
  onNavigate: (href: string) => void,
): void {
  // THE ROW IS MARKED READ FIRST, and that is what keeps one press from
  // posting twice. `defaultMailSurfaceClient.updateThread` already calls the
  // centre's mail seam on its way through, and the seam skips an id the centre
  // holds no unread row for, so this commit has already taken the id out of
  // the unread set by the time the seam's window closes, and the second POST
  // never happens.
  void markRead([row.id]);
  if (row.kind === "mail-new") {
    // A mail row's thread is read the moment its notification is (spec §7,
    // D6). It is not awaited: the mail service is another process with its own
    // latency, and a bell that waited on it would feel like a broken menu.
    const thread = decodeMailNotificationId(row.id);
    if (thread) {
      void defaultMailSurfaceClient
        .updateThread({ accountId: thread.accountId, threadId: thread.threadId, read: true })
        .catch(() => undefined);
    }
  }
  onNavigate(row.href);
}

export function NotificationsBell({
  onNavigate,
  refreshToken = 0,
}: {
  onNavigate: (href: string) => void;
  refreshToken?: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const { notifications, unread } = useNotifications(refreshToken);
  const badge = unread > BADGE_CAP ? `${BADGE_CAP}+` : String(unread);
  const duration = reduce ? 0 : DUR.fast;
  const openRow = (row: NotificationRow) => openNotificationRow(row, onNavigate);

  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <IconButton
          size={28}
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Icon name="bell" size={17} variant={unread > 0 ? "bold" : "linear"} />
          {/* THE NUMBER CROSSFADES, the identical construction the sidebar's
              Tasks count uses one panel down, for the identical reason: it
              changes while the reader is looking somewhere else, and a number
              that swaps in one frame reads as a glitch beside a number that
              dissolves. Keyed on the count, so a re-render carrying the same
              one does not blink. */}
          <AnimatePresence mode="popLayout" initial={false}>
            {unread > 0 && (
              <motion.span
                key={badge}
                aria-hidden
                className="brain-bell-badge text-label"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration } }}
                transition={{ duration }}
              >
                {badge}
              </motion.span>
            )}
          </AnimatePresence>
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[320px]"
        >
          {/* THE LIST SCROLLS, NOT THE MATERIAL. Five hundred rows is the
              centre's cap and a short window would otherwise put rows below
              the fold with nothing to move. */}
          <ScrollEdge
            variant="fade"
            className="max-h-[calc(var(--radix-dropdown-menu-content-available-height,100vh)-12px)] overscroll-contain"
            scrollerProps={{ role: "none" }}
          >
            {notifications.length === 0 ? (
              <div className="px-2 py-5">
                <Empty icon="bell-linear" title="Nothing waiting" />
              </div>
            ) : (
              <>
                {notifications.map((row) => (
                  <Dropdown.Item
                    key={row.id}
                    className="brain-menu-item"
                    data-unread={row.readAt === undefined ? "" : undefined}
                    onSelect={() => openRow(row)}
                  >
                    <Icon
                      name={KIND_GLYPH[row.kind]}
                      size={16}
                      className="brain-menu-icon"
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className={row.readAt === undefined ? "text-ink" : "text-ink-3"}>
                        {row.title}
                      </span>
                      {row.body !== undefined && (
                        <span className="text-ink-3"> {row.body}</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-ink-3">
                      {formatAgo(row.at, { compact: true })}
                    </span>
                  </Dropdown.Item>
                ))}
                {unread > 0 && (
                  <>
                    <Dropdown.Separator className="brain-menu-sep" />
                    {/* Drawn only while something is unread: a control that
                        would do nothing is worse than an absent one. It clears
                        the CENTRE alone, and the route's own comment says why
                        a press here moves no mailbox. */}
                    <Dropdown.Item
                      className="brain-menu-item"
                      onSelect={() => void markAllRead()}
                    >
                      <span className="min-w-0 flex-1 truncate text-ink-2">Mark all read</span>
                    </Dropdown.Item>
                  </>
                )}
              </>
            )}
          </ScrollEdge>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
