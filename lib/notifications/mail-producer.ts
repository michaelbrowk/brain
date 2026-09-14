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
 *  THE OWNER'S OWN SENT MAIL is out by `unread`, not by the mailbox. The
 *  mailbox is enough on IMAP, where every message is its own thread and the
 *  owner's reply lives in another folder. It is not enough on Gmail, where the
 *  whole conversation is one thread: `lastMessageAt` counts the SENT-labelled
 *  messages, the thread keeps INBOX because one message in it carries that
 *  label, and `participants` filters the owner out. The owner answering from
 *  their phone therefore bumped the thread and the bell said the
 *  correspondent's name about words the correspondent did not write.
 *
 *  A thread whose newest message is the owner's own has nothing unread left in
 *  it, so `unread` tells the two apart. It is the cheap gate rather than the
 *  exact one: a reply into a thread that still holds an OLDER unread message
 *  passes it. The exact gate is a "the newest message is the owner's" bit on
 *  the thread row, which is a mail-service change.
 *
 *  The same gate carries the re-sync case. A label applied to an old thread or
 *  an IMAP COPY into INBOX moves the timestamp and makes a known thread look
 *  new; if it was read, it stays quiet.
 */

/** One page is enough at a one-minute cadence: a mailbox that took more than
 *  twenty-five new threads in a minute has a bigger problem than the bell. */
export const MAIL_SCAN_PAGE = 25;

export function senderName(participants: readonly MailAddress[]): string {
  const first = participants[0];
  if (!first) return "Someone";
  const name = first.name?.trim();
  if (name && name.length > 0) return name;
  // The schema takes no empty title and refuses the whole row for one, while
  // the mark moves on regardless. A blank address is worth a word, not a lost
  // letter.
  return first.address.trim().length > 0 ? first.address : "Someone";
}

export function newMailNotifications(
  items: readonly MailThreadListItem[],
  watermark: number | null,
  at: string,
): { notifications: BrainNotification[]; watermark: number | null } {
  // The scan's own instant, and the ceiling on everything this function
  // answers. A Date header is whatever the sender's clock said, and IMAP falls
  // back to that header when INTERNALDATE is missing, so a letter stamped next
  // year is a page away at any time.
  //
  // It is the ceiling on a ROW's `at` because the centre sorts on that string
  // and never re-reads it, so such a letter would sit at the head of the bell
  // until next year. It is the ceiling on the MARK because a mark in 2027
  // makes every real letter after it read as older than the mark, and that
  // account's bell goes quiet for a year, on disk, past a restart. The cost of
  // clamping the mark is that the future-stamped row is offered again on every
  // poll; the centre refuses an id it already holds, so it rings once.
  const scanned = Date.parse(at);
  const ceiling = Number.isFinite(scanned) ? scanned : null;
  const held = (value: number) => (ceiling !== null ? Math.min(value, ceiling) : value);

  let next = watermark;
  for (const item of items) {
    if (item.lastMessageAt === null) continue;
    const seen = held(item.lastMessageAt);
    if (next === null || seen > next) next = seen;
  }
  // THE FIRST PASS SAYS NOTHING. With no watermark every unread thread in the
  // inbox is "new", and an upgrade would open the bell on fifty rows about
  // mail the person has already seen.
  if (watermark === null) return { notifications: [], watermark: next };

  const notifications: BrainNotification[] = [];
  for (const item of items) {
    if (item.category !== "people") continue;
    if (item.listMessage) continue;
    // Read already, so either the owner wrote the newest message in it or the
    // reader has seen it. See the header.
    if (!item.unread) continue;
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
      at: new Date(held(item.lastMessageAt)).toISOString(),
      // Sliced to what the schema takes, the way the body is. Above it the
      // centre refuses the whole row while the mark moves on regardless, so an
      // over-long display name would cost the letter itself.
      title: senderName(item.participants).slice(0, 200),
      body: subject && subject.length > 0 ? subject.slice(0, 400) : "(no subject)",
      // Mail has no per-thread route (app/mail/page.tsx takes no parameters),
      // so the row opens the surface. Opening it marks the thread read too,
      // which is the half of D6 the href cannot carry.
      href: "/mail",
    });
  }
  return { notifications, watermark: next };
}
