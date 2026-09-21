import type { BrainNotification } from "./model";

/** ONE MAIL ROW, WHICH SAYS HOW MANY LETTERS AND NOTHING ELSE.
 *
 *  The centre held one row per thread until 0.12.2, so a morning's mail made
 *  the bell a second inbox: thirty rows, each with a sender and a subject,
 *  read one press at a time. Michael's ruling is one live row, "10 new
 *  messages", counting up while it is unread.
 *
 *  So the row is not about a letter, and nothing in it comes from one. No
 *  sender, no subject, no account: the phone's push still carries those,
 *  because a push is the letter arriving, and the centre is the tally of what
 *  is waiting.
 *
 *  THE COUNT LIVES IN THE TITLE, which is the only field the shape has for it
 *  (`notificationSchema` is strict, and a field added for this would be a
 *  field every other kind carries empty). It is written and read back through
 *  this module alone, so the sentence and the number cannot drift apart.
 *
 *  Pure: no clock, no file, no zod.
 */

/** Mail's own surface, which opens on its main screen. The row names no
 *  thread, so there is nothing for the href to carry. */
export const MAIL_ROW_HREF = "/mail";

/** `mail-new:<the instant the row opened>`. The instant is what makes a new
 *  row new: a read row is never counted into again, and the next scan opens
 *  one under a later instant. The old shape was `mail-new:<account>:<hex
 *  thread id>`, which this pattern cannot match — an account id carries no
 *  `-` in the right places and no `T` — and that is what `foldLegacyMailRows`
 *  separates them by. */
const MAIL_ROW_ID = /^mail-new:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

/** The sentence, read back. Bounded so a title from anywhere else cannot turn
 *  into a count of nine hundred million. */
const MAIL_ROW_TITLE = /^(\d{1,9}) new messages?$/;

export function mailRowId(openedAt: string): string {
  return `mail-new:${openedAt}`;
}

export function mailRowTitle(count: number): string {
  return count === 1 ? "1 new message" : `${count} new messages`;
}

/** The row under an id that already exists, which is what a fold writes: the
 *  id is the row's for its whole life and only the count and the instant
 *  move. */
export function countedMailRow(id: string, count: number, at: string): BrainNotification {
  return { id, kind: "mail-new", at, title: mailRowTitle(count), href: MAIL_ROW_HREF };
}

export function mailRow(openedAt: string, count: number, at: string): BrainNotification {
  return countedMailRow(mailRowId(openedAt), count, at);
}

/** THE ROW A SCAN COUNTS INTO, or `null` when the next letter opens a new one.
 *
 *  Unread, of this shape, and the newest when a file somehow holds two. The
 *  count comes back out of the title, because that is where it was put. */
export interface OpenMailRow {
  readonly id: string;
  readonly at: string;
  readonly count: number;
}

export function openMailRow(rows: readonly BrainNotification[]): OpenMailRow | null {
  let open: OpenMailRow | null = null;
  for (const row of rows) {
    if (row.kind !== "mail-new" || row.readAt !== undefined) continue;
    if (!MAIL_ROW_ID.test(row.id)) continue;
    const count = Number(MAIL_ROW_TITLE.exec(row.title)?.[1] ?? "");
    if (!Number.isFinite(count) || count <= 0) continue;
    if (open === null || row.at > open.at) open = { id: row.id, at: row.at, count };
  }
  return open;
}

function isLegacyMailRow(row: BrainNotification): boolean {
  return row.kind === "mail-new" && !MAIL_ROW_ID.test(row.id);
}

/** ROWS OF THE OLD SHAPE, FOLDED ON THE WAY OUT OF THE FILE.
 *
 *  A person upgrading with thirty per-thread rows in their centre would
 *  otherwise keep the second inbox until every one of them had been pressed.
 *  The fold happens on the read rather than in a migration pass, so it costs
 *  nothing on a file that has none and needs no version bump: the next write
 *  of the file persists it.
 *
 *  Their number is the count, the newest is the instant, and one unread among
 *  them keeps the fold unread. All read and they are dropped: a tally of
 *  letters already dealt with is not something to carry forward.
 */
export function foldLegacyMailRows(
  rows: readonly BrainNotification[],
): readonly BrainNotification[] {
  // The common path answers here and allocates nothing. This runs on every
  // read of the file — every request to the centre, every append, every read
  // mark — and after the first fold there is at most one mail row to test.
  if (!rows.some(isLegacyMailRow)) return rows;
  const old = rows.filter(isLegacyMailRow);
  const rest = rows.filter((row) => !isLegacyMailRow(row));
  if (old.every((row) => row.readAt !== undefined)) return rest;

  let newest = old[0].at;
  for (const row of old) if (row.at > newest) newest = row.at;

  // An upgrade that landed between a scan and a read leaves both shapes in the
  // file. The letters join the row that is already open rather than standing
  // beside it, which would be the second inbox again in miniature.
  const open = openMailRow(rest);
  if (open !== null) {
    const at = open.at > newest ? open.at : newest;
    return rest.map((row) =>
      row.id === open.id ? countedMailRow(open.id, open.count + old.length, at) : row,
    );
  }
  return [...rest, mailRow(newest, old.length, newest)];
}
