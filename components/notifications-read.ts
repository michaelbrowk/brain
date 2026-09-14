"use client";

import { mailNotificationId } from "@/lib/notifications/model";

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
 *  `{ read: 0 }` rather than a refusal.
 *
 *  It never throws at its caller. A mail mutation that worked must not be
 *  reported as failed because the bell could not be updated.
 */
export function markMailNotificationRead(accountId: string, threadId: string): void {
  let id: string;
  try {
    id = mailNotificationId(accountId, threadId);
  } catch {
    return;
  }
  void fetch("/api/notifications/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id] }),
  }).catch(() => undefined);
}
