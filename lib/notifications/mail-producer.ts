import type { MailAddress, MailThreadListItem } from "@/lib/mail/message-types";
import { mailPushTag } from "./ids";

/** WHAT COUNTS AS NEW MAIL WORTH SAYING (spec §7, D6).
 *
 *  A person wrote to an Inbox and the thread is newer than the last one this
 *  account reported. That is the whole rule, and it is pure: the poll around
 *  it hands in the page and the watermark, and gets back the letters and the
 *  next watermark.
 *
 *  LETTERS, NOT ROWS. The centre holds one mail row and counts into it
 *  (`mail-rows.ts`), so what this answers is the letters themselves: one push
 *  payload each, and their number and their newest instant are what the row
 *  is made of. The scan puts the two together.
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

/** What the push shows, and what the centre never sees. `MAX_PUSH_TITLE` and
 *  `MAX_PUSH_BODY` (`lib/push/model.ts`), restated rather than imported: that
 *  module reaches for node:crypto and this one is arithmetic over a page. */
const MAX_PUSH_TITLE = 200;
const MAX_PUSH_BODY = 400;

/** ONE LETTER, AS THE PHONE WILL SEE IT.
 *
 *  `at` is the scan's business: the newest of them dates the row. The other
 *  three are the push payload, which is the one place a sender's name and a
 *  subject still travel. */
export interface NewMailLetter {
  readonly at: string;
  readonly title: string;
  readonly body: string;
  readonly tag?: string;
}

export function senderName(participants: readonly MailAddress[]): string {
  const first = participants[0];
  if (!first) return "Someone";
  const name = first.name?.trim();
  if (name && name.length > 0) return name;
  // A push with no title is a push the service refuses. A blank address is
  // worth a word, not a lost letter.
  return first.address.trim().length > 0 ? first.address : "Someone";
}

export function newMailLetters(
  items: readonly MailThreadListItem[],
  watermark: number | null,
  at: string,
): { letters: NewMailLetter[]; watermark: number | null } {
  // The scan's own instant, and the ceiling on everything this function
  // answers. A Date header is whatever the sender's clock said, and IMAP falls
  // back to that header when INTERNALDATE is missing, so a letter stamped next
  // year is a page away at any time.
  //
  // It is the ceiling on a LETTER's `at` because the newest of them dates the
  // row, the centre sorts on that string and never re-reads it, so such a
  // letter would sit at the head of the bell until next year. It is the
  // ceiling on the MARK because a mark in 2027 makes every real letter after
  // it read as older than the mark, and that account's bell goes quiet for a
  // year, on disk, past a restart. The cost of clamping the mark is that the
  // future-stamped thread is offered again on every poll.
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
  if (watermark === null) return { letters: [], watermark: next };

  const letters: NewMailLetter[] = [];
  for (const item of items) {
    if (item.category !== "people") continue;
    if (item.listMessage) continue;
    // Read already, so either the owner wrote the newest message in it or the
    // reader has seen it. See the header.
    if (!item.unread) continue;
    if (item.lastMessageAt === null) continue;
    if (item.lastMessageAt <= watermark) continue;
    const subject = item.subject?.trim();
    // A pair too long for a tag costs the push its tag and nothing more. It
    // used to cost the letter its row.
    const tag = mailPushTag(item.accountId, item.threadId);
    letters.push({
      at: new Date(held(item.lastMessageAt)).toISOString(),
      // Cut to what the push service takes. Over it the payload is refused
      // outright, so an over-long display name would cost the letter itself.
      title: senderName(item.participants).slice(0, MAX_PUSH_TITLE),
      body: subject && subject.length > 0 ? subject.slice(0, MAX_PUSH_BODY) : "(no subject)",
      ...(tag !== null ? { tag } : {}),
    });
  }
  return { letters, watermark: next };
}
