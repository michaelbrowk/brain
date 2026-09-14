"use client";

/** ONE SEAM FOR "THIS THREAD IS READ" (spec §7, D6), AND ONE MODULE BEHIND IT.
 *
 *  The batching, the id derivation and the POST live in
 *  `components/notifications-client.ts`, beside the rows the bell draws,
 *  because the skip that makes this cheap needs the centre's own live unread
 *  set: a thread read in Mail with no notification behind it costs nothing,
 *  and a set kept in a second module would be a copy that goes stale.
 *
 *  The path stays because `components/mail-surface-client.ts` imports it, and
 *  a reader following that import lands on this sentence rather than on a
 *  rename. The client module carries no zod, which
 *  `components/notifications-read.test.ts` walks the import graph to prove.
 */
export {
  flushMailNotificationReads,
  markMailNotificationRead,
} from "./notifications-client";
