"use client";

import { mailNotificationId } from "@/lib/notifications/ids";

/** ONE SEAM FOR "THIS THREAD IS READ" (spec §7, D6).
 *
 *  It lives here rather than in the mail surface because every read in Mail
 *  (the header button, the keyboard, the auto-read on open, the bulk Done)
 *  reaches the service through one method, `MailSurfaceClient.updateThread`,
 *  and threading a callback down to four call sites inside a five-thousand
 *  line component is four chances to miss one.
 *
 *  The notification id is derived from the account and the thread, so no
 *  lookup is needed and a thread with no notification behind it is answered
 *  `{ read: 0 }` rather than a refusal. The id module carries no zod, so this
 *  import does not put the centre's schemas in Mail's bundle.
 *
 *  It never throws at its caller. A mail mutation that worked must not be
 *  reported as failed because the bell could not be updated.
 */

/** ONE POST PER RUN, NOT ONE PER LETTER.
 *
 *  Bulk Done marks every unread thread it archives, one at a time, and each
 *  POST reads and re-parses the whole centre file through the store's
 *  serialised queue. Forty threads was forty of those, for rows that in the
 *  common case do not exist at all. The ids collect instead and go out in one
 *  body a quarter second after the last one lands, so a run of forty is one
 *  request and a single read is one request a quarter second late, on a bell
 *  the reader is not looking at.
 */
const FLUSH_MS = 250;

/** A reader holding the down arrow auto-reads a thread per keypress, and a
 *  window that restarts on every mark would never close while they held it.
 *  The route takes up to `NOTIFICATION_CAP` ids, so this is far inside it. */
const MAX_BATCH = 100;

const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function send(ids: readonly string[]): void {
  try {
    void fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }).catch(() => undefined);
  } catch {
    // A `fetch` that throws synchronously rather than rejecting, which a test
    // double or a locked-down runtime can do. The mail mutation already
    // landed; the bell is not worth failing it for.
  }
}

/** Everything collected so far, now. Exported for a caller that knows its run
 *  is over and does not want to wait out the window. */
export function flushMailNotificationReads(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;
  const ids = [...pending];
  pending.clear();
  send(ids);
}

export function markMailNotificationRead(accountId: string, threadId: string): void {
  let id: string;
  try {
    id = mailNotificationId(accountId, threadId);
  } catch {
    return;
  }
  // A Set, so a thread marked twice inside one window costs one id and not
  // two. The centre answers `{ read: 0 }` for the second anyway, but the
  // cheapest request is the one nobody sent.
  pending.add(id);
  if (pending.size >= MAX_BATCH) {
    flushMailNotificationReads();
    return;
  }
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushMailNotificationReads, FLUSH_MS);
}
