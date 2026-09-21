"use client";

/** ONE SEAM FOR "MAIL IS OPEN" (spec §7, D6), AND ONE MODULE BEHIND IT.
 *
 *  The row to mark and the POST live in `components/notifications-client.ts`,
 *  beside the rows the bell draws, because the row Mail answers is the one the
 *  centre is holding unread at this instant: a set kept in a second module
 *  would be a copy that goes stale.
 *
 *  The path stays because `components/mail-surface.tsx` imports it, and a
 *  reader following that import lands on this sentence rather than on a
 *  rename. The client module carries no zod, which
 *  `components/notifications-read.test.ts` walks the import graph to prove.
 */
export { markMailCentreRead } from "./notifications-client";
