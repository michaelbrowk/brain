/** THE MAIL NOTIFICATION ID, ON BOTH SIDES OF THE WIRE.
 *
 *  Its own module because the Mail client imports it. `model.ts` builds
 *  `notificationSchema` at module scope, so a value import of it from a
 *  component is a zod instance in that route's bundle, and `package.json`
 *  declares no `sideEffects` for the bundler to prune it with. Everything here
 *  is string work: no zod, no node, no clock.
 *
 *  `model.ts` re-exports both functions, so a server caller still has one
 *  import and nothing moved for a reader following the old path.
 */

/** A provider's thread id may hold anything, and the id has to stay inside
 *  NOTIFICATION_ID_RE so Mail can compute it on the client and mark the row
 *  read without a lookup. Hex of the UTF-8 bytes is the one encoding that
 *  needs neither Buffer nor btoa, so the same function runs on both sides. */
const MAX_THREAD_ID_BYTES = 150;

/** What `decodeMailNotificationId` can read back, and so what the encoder
 *  accepts. Wider than today's `account-a<32 hex>` and narrower than the id
 *  charset, which has to hold the two separators as well. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function mailNotificationId(accountId: string, threadId: string): string {
  // The decoder reads the account back out of the id, so an account id it
  // cannot parse must never be encoded into one. Every mail module already
  // gates on `account-a<32 hex>`; this is the same gate at the other end.
  if (!ACCOUNT_ID_RE.test(accountId)) {
    throw new Error(`account id is not one a notification id can carry: ${accountId}`);
  }
  const bytes = new TextEncoder().encode(threadId);
  if (bytes.length > MAX_THREAD_ID_BYTES) {
    throw new Error(`thread id is too long for a notification id: ${bytes.length} bytes`);
  }
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `mail-new:${accountId}:${hex}`;
}

/** A task id, `TASK_ID_RE` in `lib/tasks/model.ts`. Written out rather than
 *  imported for the reason at the head of this file: that module is the tasks
 *  schema, and the browser reads this one. */
const TASK_ID = /^task-(?:reminder|missed):([A-Za-z0-9_-]{1,128}):/;

/** THE TASK A ROW CAME FROM, out of the row's own id.
 *
 *  A task row's stored href is "/tasks", which opens the column and names no
 *  row in it. The task is in the id the reminder was minted with
 *  (`task-reminder:<task id>:<day>T<time>`), so the browser reads it back here
 *  and opens `/tasks?task=<id>` instead, including the rows already in the
 *  centre, which no producer can go back and rewrite.
 *
 *  `null` for anything that is not one of the two task ids, which is the
 *  answer that leaves the href as it stands. */
export function decodeTaskNotificationId(id: string): string | null {
  return TASK_ID.exec(id)?.[1] ?? null;
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
