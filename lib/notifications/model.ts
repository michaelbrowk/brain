import { z } from "zod";

/** THE CENTRE'S MODEL, GENERIC ON PURPOSE.
 *
 *  Three kinds ship in this release. The shape carries nothing about a task
 *  or a letter, so an agent notice or a backup failure joins later without a
 *  second store and without a migration.
 *
 *  Nothing here reads the clock, the filesystem or a Store.
 */

export const NOTIFICATION_KINDS = ["task-reminder", "task-missed", "mail-new"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Five hundred rows, oldest dropped first. The file is read whole on every
 *  request, so the cap is what keeps it a few hundred kilobytes. */
export const NOTIFICATION_CAP = 500;

/** An id is derived, never minted: the same reminder computed by two scans,
 *  or the same thread seen by two polls, has to be one row. The charset is
 *  what `mailNotificationId` can produce plus the two literal separators. */
export const NOTIFICATION_ID_RE = /^[A-Za-z0-9:_.@+-]{1,400}$/;

/** A path on this origin and nothing else. The service worker opens this
 *  value, so an absolute URL here would be an open redirect with a
 *  notification in front of it. A protocol-relative `//host` is a URL too. */
const hrefField = z
  .string()
  .min(1)
  .max(300)
  .regex(/^\/(?!\/)[A-Za-z0-9/_?=&:.,%+-]*$/, "href must be a path on this origin");

const instantField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "must be an ISO instant");

export const notificationSchema = z
  .object({
    id: z.string().regex(NOTIFICATION_ID_RE),
    kind: z.enum(NOTIFICATION_KINDS),
    at: instantField,
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(400).optional(),
    href: hrefField,
    readAt: instantField.optional(),
  })
  .strict();

export type BrainNotification = z.infer<typeof notificationSchema>;

export function taskReminderNotificationId(taskId: string, when: string, time: string): string {
  return `task-reminder:${taskId}:${when}T${time}`;
}

export function taskMissedNotificationId(taskId: string, when: string, time: string): string {
  return `task-missed:${taskId}:${when}T${time}`;
}

const MAX_THREAD_ID_BYTES = 150;

/** A provider's thread id may hold anything, and the id has to stay inside
 *  NOTIFICATION_ID_RE so Mail can compute it on the client and mark the row
 *  read without a lookup. Hex of the UTF-8 bytes is the one encoding that
 *  needs neither Buffer nor btoa, so the same function runs on both sides. */
export function mailNotificationId(accountId: string, threadId: string): string {
  const bytes = new TextEncoder().encode(threadId);
  if (bytes.length > MAX_THREAD_ID_BYTES) {
    throw new Error(`thread id is too long for a notification id: ${bytes.length} bytes`);
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `mail-new:${accountId}:${hex}`;
}

export function decodeMailNotificationId(
  id: string,
): { accountId: string; threadId: string } | null {
  const match = /^mail-new:([A-Za-z0-9_-]+):([0-9a-f]*)$/.exec(id);
  if (!match) return null;
  const hex = match[2];
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return { accountId: match[1], threadId: new TextDecoder().decode(bytes) };
}
