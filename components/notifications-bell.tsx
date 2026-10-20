"use client";

// THE BELL, AND THE CENTRE UNDER IT.
//
// It stands in the sidebar head beside New page, on the regular menu material
// every other menu in the product uses, because a notification centre is a
// menu: a short list of things that happened, each one a way into the place it
// happened. Nothing here is a surface of its own and nothing here is a dialog.
//
// Mail and reminder rows keep the menu's single-line arrangement. Daily
// agent summaries may wrap, and disclose their target links underneath.

import { useId, useState } from "react";
import { digestTargetCount, isUnreadNotification } from "@/lib/notifications/agent-digest";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { formatAgo } from "@/lib/format-ago";
import { DUR, SPRING_SELECT } from "@/lib/motion";
import { decodeAgentMailHref, decodeTaskNotificationId } from "@/lib/notifications/ids";
import { monthName } from "@/lib/tasks/calendar";
import { requestOpenThread } from "./mail-surface-client";
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
 *  everywhere else. What an agent did wears the plug Settings, Connections
 *  wears (`components/settings/connections-section.tsx`), which is the screen
 *  the row came from and the screen a reader goes to to take the grant away.
 *  One table, read by every row the centre draws. */
export const KIND_GLYPH: Record<NotificationRow["kind"], string> = {
  "task-reminder": "alarm-linear",
  "task-missed": "clock-circle-linear",
  "mail-new": "letter-linear",
  "agent-action": "plug-circle-linear",
};

/** Past this the number is wider than the glyph it rides and says nothing a
 *  reader can act on that "a lot" does not. */
const BADGE_CAP = 99;

/** The one destination this rewrites. Everything else a row was stored with
 *  is a destination the producer chose, and is left alone. */
const TASKS_COLUMN = "/tasks";

/** Mail's own surface. It takes no thread in its route, which is why an agent
 *  row about one asks Mail to open it through a seam instead. */
const MAIL_SURFACE = "/mail";

/** The missed producer's own sentence, whole (`lib/reminders/scheduler.ts`).
 *  Anchored at both ends on purpose: the one other thing that could match is a
 *  body somebody else wrote, and rewriting one is not this row's business. */
const MISSED_BODY = /^Missed (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2})$/;

/** THE STORED BODY IS LOCALE-FREE, AND THE ROW IS NOT.
 *
 *  A body is written by a server timer into a file that also feeds a push
 *  payload, so the day in it is an ISO one: a server locale inside a stored
 *  string is how `7:20 PM` got into a column of `07:45`s. The row is where it
 *  is read out, and it reads it out through the same month table the picker's
 *  own grid uses, cut to the three letters a 320px panel has room for. A
 *  fired row's body is already a clock and passes through untouched, so the
 *  two kinds read alike down one column. */
export function notificationBody(body: string): string {
  const hit = MISSED_BODY.exec(body);
  if (hit === null) return body;
  const [, day, time] = hit;
  return `Missed ${Number(day.slice(8, 10))} ${monthName(day).slice(0, 3)}, ${time}`;
}

/** WHERE A ROW GOES, which is not always what it was stored with.
 *
 *  A task row's href is "/tasks": it opens the column and names nothing in it,
 *  and the reader who pressed a reminder is looking for one row. The task is
 *  in the row's own id, so the query is derived here rather than by rewriting
 *  every stored row, and a row the decoder cannot read a task out of
 *  keeps the href it came with. `components/tasks-surface.tsx` reads `?task=`,
 *  selects that row wherever it lives and takes the query back off.
 *
 *  KEYED ON THE DESTINATION AS WELL AS ON THE ID. Reading the id alone meant
 *  any row whose id happened to decode was sent to the Tasks column, whatever
 *  the producer had stored: a kind added later with a task id in it and a
 *  surface of its own would have been silently redirected here. The rewrite
 *  applies to the bare column and to nothing else. */
export function notificationHref(row: NotificationRow): string {
  // An agent row about a thread carries the pair in its query, because its id
  // is a digest of the log line and reads back as nothing. The pair goes to
  // Mail through the seam below; the address bar gets the surface, which is
  // where a mail row goes too.
  if (decodeAgentMailHref(row.href) !== null) return MAIL_SURFACE;
  if (row.href !== TASKS_COLUMN) return row.href;
  const taskId = decodeTaskNotificationId(row.id);
  return taskId === null ? row.href : `${TASKS_COLUMN}?task=${encodeURIComponent(taskId)}`;
}

/** WHAT A ROW DOES WHEN IT IS PRESSED. It is marked read, and the reader is
 *  taken where it points. It sits here rather than inside the menu's own JSX
 *  because an agent row about a thread does a third thing on the way.
 *
 *  A MAIL ROW DOES ONLY THE TWO. It is the count of what is waiting, not a
 *  letter, so there is no thread to ask Mail for and none to mark read: the
 *  press clears the tally and opens Mail on its main screen. */
export function openNotificationRow(
  row: NotificationRow,
  onNavigate: (href: string) => void,
): void {
  void markRead([row.id]);
  if (row.kind === "agent-action") {
    // The thread it names is opened and never marked read: the reader pressing
    // "Claude replied to a message" is going to look at the thread, and what
    // is unread in it is theirs.
    const thread = decodeAgentMailHref(row.href);
    if (thread) requestOpenThread(thread.accountId, thread.threadId);
  }
  onNavigate(notificationHref(row));
}

/** A header discloses; only a target navigates. Radix keeps the menu open
 * on disclosure and includes the revealed links in its arrow-key collection. */
function DigestRow({ row, onNavigate }: {
  row: NotificationRow;
  onNavigate: (href: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const region = useId();
  const reduce = useReducedMotion() ?? false;
  const digest = row.digest!;
  const more = Math.max(0, digestTargetCount(digest) - digest.targets.length);
  return (
    <Dropdown.Group>
      <Dropdown.Item
        className="brain-menu-item brain-digest-header"
        aria-label={row.title}
        aria-expanded={expanded}
        aria-controls={region}
        onSelect={(event) => {
          event.preventDefault();
          setExpanded((value) => !value);
        }}
      >
        <Icon name={KIND_GLYPH[row.kind]} size={16} className="brain-menu-icon" />
        <span data-notification-title="" className="min-w-0 flex-1 text-ink-2">{row.title}</span>
        <motion.span
          data-digest-chevron=""
          className="flex shrink-0 text-ink-2"
          animate={{ rotate: !reduce && expanded ? 90 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SELECT}
        >
          <Icon name={reduce && expanded ? "alt-arrow-down-linear" : "alt-arrow-right-linear"} size={14} />
        </motion.span>
      </Dropdown.Item>
      <div id={region} inert={!expanded}>
        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              key="targets" data-digest-disclosure=""
              className="overflow-hidden"
              initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={reduce ? { duration: DUR.fast } : SPRING_SELECT}
            >
              <div className="brain-digest-day text-caption text-ink-2">{digest.day}</div>
              {digest.targets.map((target) => (
                <Dropdown.Item key={`${target.kind}:${target.id}`} asChild>
                  <a
                    data-digest-target=""
                    className="brain-menu-item brain-digest-target"
                    href={notificationHref({ ...row, href: target.href })}
                    onClick={(event) => {
                      event.preventDefault();
                      openNotificationRow({ ...row, href: target.href }, onNavigate);
                    }}
                  >
                    <span className="truncate text-ink-2">{target.title}</span>
                  </a>
                </Dropdown.Item>
              ))}
              {more > 0 && <div className="brain-digest-more text-caption text-ink-2">{digest.saturated.length > 0 ? `${more}+ more` : `+${more} more`}</div>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Dropdown.Group>
  );
}

export function NotificationsBell({
  onNavigate,
  refreshToken = 0,
}: {
  onNavigate: (href: string) => void;
  refreshToken?: number;
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion() ?? false;
  const { notifications, unread } = useNotifications(refreshToken);
  const badge = unread > BADGE_CAP ? `${BADGE_CAP}+` : String(unread);
  const weight = unread > 0 ? "bold" : "linear";
  const duration = reduce ? 0 : DUR.fast;
  const openRow = (row: NotificationRow) => openNotificationRow(row, onNavigate);

  return (
    <Dropdown.Root open={open} onOpenChange={setOpen}>
      <Dropdown.Trigger asChild>
        {/* 34, WHICH IS NEW PAGE'S SIZE. It stood at 28 beside a 34 circle
            with 4px between them, so the head's two controls differed in size
            by a fifth and touched: what was drawn was one lopsided object
            rather than a pair, and the smaller half was the one a reader is
            asked to notice. Same box, same glyph size, 12px of air, and the
            count comes inside the box with them. */}
        <IconButton
          size={34}
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          {/* THE WEIGHT CROSSFADES WITH THE NUMBER. The bell goes bold while
              anything is unread, and that swap was a one-frame cut beside a
              number that dissolved, so half of one state change faded and half
              snapped. Same key-on-the-value, same duration, same collapse
              under reduced motion: one behaviour here and not two.
              `popLayout` takes the leaving glyph out of flow, so the two
              overlap for the length of the fade instead of standing side by
              side and widening the control. */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={weight}
              aria-hidden
              data-bell-glyph=""
              className="flex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration } }}
              transition={{ duration }}
            >
              <Icon name="bell" size={17} variant={weight} />
            </motion.span>
          </AnimatePresence>
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
                {notifications.map((row) => row.digest ? (
                  <DigestRow key={row.id} row={row} onNavigate={(href) => { setOpen(false); onNavigate(href); }} />
                ) : (
                  <Dropdown.Item
                    key={row.id}
                    className="brain-menu-item"
                    data-unread={isUnreadNotification(row) ? "" : undefined}
                    onSelect={() => openRow(row)}
                  >
                    <Icon
                      name={KIND_GLYPH[row.kind]}
                      size={16}
                      className="brain-menu-icon"
                    />
                    {/* THE BODY IS WHAT SAYS WHAT HAPPENED, so it is the half
                        that does not yield. Both used to sit in one truncating
                        span, and the title ate the row: every body was cut in
                        its first two characters, which left a fired reminder
                        and a missed one reading as one line, one small circle
                        and a timestamp. The title takes what is left and
                        truncates; the body never shrinks to make room for it
                        and is capped at 57%, which is the width the longest
                        body the producer writes asks for at 320px. */}
                    <span
                      data-notification-title=""
                      className={`min-w-0 flex-1 truncate ${
                        isUnreadNotification(row) ? "text-ink" : "text-ink-3"
                      }`}
                    >
                      {row.title}
                    </span>
                    {row.body !== undefined && (
                      <span
                        data-notification-body=""
                        className="max-w-[57%] shrink-0 truncate text-ink-3"
                      >
                        {notificationBody(row.body)}
                      </span>
                    )}
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
