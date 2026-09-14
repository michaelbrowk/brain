"use client";

// THE CENTRE, ON HOME, ON A PHONE.
//
// The six tab slots are full and stay full (spec §10), so a phone has no bell
// to press: the sidebar that holds one is `display: none` below 768. This is
// the way in instead: up to three unread rows at the top of Home, each one
// opening the place it came from, and nothing at all when nothing is waiting.
//
// `md:hidden`, because from 768 up the bell is two hundred pixels away in the
// sidebar head and a second copy of the same three rows is the same
// information twice.
//
// It carries no heading. A heading would take Home's opening line away from
// the capture field for a block that is absent most days, and the rows say
// what they are: a glyph, a sentence and how long ago.

import { motion, useReducedMotion } from "framer-motion";

import { formatAgo } from "@/lib/format-ago";
import { DUR, EASE_OUT } from "@/lib/motion";

import { HubRow } from "./hub-row";
import { KIND_GLYPH, openNotificationRow } from "./notifications-bell";
import { useNotifications, type NotificationRow } from "./notifications-client";
import { Icon } from "./ui/icon";

/** Three, the number Home's mail block previews a section with. */
const ROWS = 3;

export function HubNotifications({
  onNavigate,
  refreshToken = 0,
}: {
  onNavigate: (href: string) => void;
  refreshToken?: number;
}) {
  const reduce = useReducedMotion() ?? false;
  const { notifications, unread } = useNotifications(refreshToken);
  if (unread === 0) return null;

  const rows: readonly NotificationRow[] = notifications
    .filter((row) => row.readAt === undefined)
    .slice(0, ROWS);

  const enter = (index: number) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6 },
    animate: reduce ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: reduce
      ? { duration: DUR.base }
      : { duration: DUR.base, ease: EASE_OUT, delay: 0.03 * index },
  });

  return (
    <section className="mb-5 md:hidden" data-hub-notifications>
      {rows.map((row, index) => (
        <motion.div key={row.id} {...enter(index)}>
          <HubRow
            data-hub-notification-row
            glyph={<Icon name={KIND_GLYPH[row.kind]} size={16} className="text-ink-3" />}
            trailing={formatAgo(row.at, { compact: true })}
            onClick={() => openNotificationRow(row, onNavigate)}
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
              {row.title}
              {row.body !== undefined && <span className="text-ink-3"> {row.body}</span>}
            </span>
          </HubRow>
        </motion.div>
      ))}
    </section>
  );
}
