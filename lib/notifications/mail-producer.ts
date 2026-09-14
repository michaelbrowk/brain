import type { MailAddress, MailThreadListItem } from "@/lib/mail/message-types";
import { mailNotificationId, type BrainNotification } from "./model";

/** WHAT COUNTS AS NEW MAIL WORTH SAYING (spec §7, D6).
 *
 *  A person wrote to an Inbox and the thread is newer than the last one this
 *  account reported. That is the whole rule, and it is pure: the poll around
 *  it hands in the page and the watermark, and gets back the rows and the
 *  next watermark.
 *
 *  The classifier already decided what a person is. `category` is the mail
 *  service's own rollup (newsletter > notification > people, message-types.ts:39-45)
 *  and `listMessage` is its consistent companion; both are checked, because a
 *  row cached before the category column existed decodes as "people" by
 *  default and would otherwise make every old newsletter a notification.
 *
 *  The owner's own sent mail is out by construction: the poll reads the INBOX
 *  mailbox, and nothing the owner sends lands there.
 */

/** One page is enough at a one-minute cadence: a mailbox that took more than
 *  twenty-five new threads in a minute has a bigger problem than the bell. */
export const MAIL_SCAN_PAGE = 25;

export function senderName(participants: readonly MailAddress[]): string {
  const first = participants[0];
  if (!first) return "Someone";
  const name = first.name?.trim();
  return name && name.length > 0 ? name : first.address;
}

export function newMailNotifications(
  items: readonly MailThreadListItem[],
  watermark: number | null,
  at: string,
): { notifications: BrainNotification[]; watermark: number | null } {
  let next = watermark;
  for (const item of items) {
    if (item.lastMessageAt !== null && (next === null || item.lastMessageAt > next)) {
      next = item.lastMessageAt;
    }
  }
  // THE FIRST PASS SAYS NOTHING. With no watermark every unread thread in the
  // inbox is "new", and an upgrade would open the bell on fifty rows about
  // mail the person has already seen.
  if (watermark === null) return { notifications: [], watermark: next };

  // The scan's own instant, and the ceiling on a row's. A Date header is
  // whatever the sender's clock said, so a letter stamped next year would sit
  // at the head of the bell until next year: the centre sorts on `at` and
  // never re-reads it. Clamping costs a correct row nothing.
  const scanned = Date.parse(at);
  const ceiling = Number.isFinite(scanned) ? scanned : null;

  const notifications: BrainNotification[] = [];
  for (const item of items) {
    if (item.category !== "people") continue;
    if (item.listMessage) continue;
    if (item.lastMessageAt === null) continue;
    if (item.lastMessageAt <= watermark) continue;
    let id: string;
    try {
      id = mailNotificationId(item.accountId, item.threadId);
    } catch {
      // A provider id longer than the bounded notification id. One thread goes
      // unannounced; the rest of the page still reports.
      continue;
    }
    const subject = item.subject?.trim();
    notifications.push({
      id,
      kind: "mail-new",
      at: new Date(
        ceiling !== null ? Math.min(item.lastMessageAt, ceiling) : item.lastMessageAt,
      ).toISOString(),
      title: senderName(item.participants),
      body: subject && subject.length > 0 ? subject.slice(0, 400) : "(no subject)",
      // Mail has no per-thread route (app/mail/page.tsx takes no parameters),
      // so the row opens the surface. Opening it marks the thread read too,
      // which is the half of D6 the href cannot carry.
      href: "/mail",
    });
  }
  return { notifications, watermark: next };
}
