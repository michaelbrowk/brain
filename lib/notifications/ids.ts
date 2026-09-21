/** THE IDS A ROW CARRIES, AND WHAT CAN BE READ BACK OUT OF THEM.
 *
 *  Its own module because the Mail client imports it. `model.ts` builds
 *  `notificationSchema` at module scope, so a value import of it from a
 *  component is a zod instance in that route's bundle, and `package.json`
 *  declares no `sideEffects` for the bundler to prune it with. Everything here
 *  is string work: no zod, no node, no clock.
 *
 *  `model.ts` re-exports what a server caller wants, so nothing moved for a
 *  reader following the old path.
 */

/** A provider's thread id may hold anything, and the tag has to stay inside
 *  `MAX_PUSH_TAG`. Hex of the UTF-8 bytes is the one encoding that needs
 *  neither Buffer nor btoa, so the same function runs on both sides. */
const MAX_THREAD_ID_BYTES = 150;

/** What `decodeAgentMailHref` can read back, and so what the encoders accept.
 *  Wider than today's `account-a<32 hex>` and narrower than the id charset,
 *  which has to hold the two separators as well. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** THE TAG ON ONE LETTER'S PUSH, and the last thing left of the per-thread
 *  mail notification id the centre kept until 0.12.2.
 *
 *  A push is still one per letter (`lib/notifications/mail-scan.ts`), and the
 *  service worker tags each notification so two letters in one poll are two
 *  notifications rather than one replacing the other: every mail push carries
 *  the same href "/mail", so a tag built from the destination collapsed them.
 *  The pair is the one thing about a letter that is already an id rather than
 *  content, which is why the tag is made of it and of nothing else.
 *
 *  `null` for a pair this cannot carry. The letter is still counted and still
 *  pushed; it is its tag that is lost, and an untagged notification stands on
 *  its own, which is the behaviour a tag is there to buy. */
export function mailPushTag(accountId: string, threadId: string): string | null {
  if (!ACCOUNT_ID_RE.test(accountId)) return null;
  const bytes = new TextEncoder().encode(threadId);
  if (bytes.length > MAX_THREAD_ID_BYTES) return null;
  return `mail-new:${accountId}:${hexOf(bytes)}`;
}

function hexOf(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function bytesOf(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** THE THREAD AN AGENT ROW IS ABOUT, IN THE HREF RATHER THAN IN THE ID.
 *
 *  An `agent-action` id is a digest of the line it came from
 *  (`agent:<at>:<tool>:<sha>`), so there is nothing to read back out of it,
 *  and the row's shape has no field for a pair either. The href is what is
 *  left, and it is the honest carrier: the row's destination IS that thread.
 *  It is the one kind that still opens a letter from the bell — a `mail-new`
 *  row is a count now and names no thread at all.
 *
 *  Same hex-of-the-UTF-8-bytes encoding the push tag uses, for the same
 *  reason: no Buffer and no btoa, so the browser reads what the server wrote.
 */
const AGENT_MAIL_HREF = /^\/mail\?account=([A-Za-z0-9_-]+)&thread=([0-9a-f]+)$/;

/** The centre's own bound on an href (`hrefField` in `model.ts`). Mirrored
 *  rather than imported because this module stays zod-free for the browser. */
const MAX_HREF_CHARS = 300;

/** The Mail surface, with the thread named when it can be. A pair this
 *  cannot carry falls back to the surface alone, which is where the row was
 *  going anyway: a thread the bell cannot ask for costs the selection, never
 *  the row. */
export function agentMailHref(accountId: string, threadId: string): string {
  if (!ACCOUNT_ID_RE.test(accountId)) return "/mail";
  const href = `/mail?account=${accountId}&thread=${hexOf(new TextEncoder().encode(threadId))}`;
  return href.length > MAX_HREF_CHARS ? "/mail" : href;
}

export function decodeAgentMailHref(
  href: string,
): { accountId: string; threadId: string } | null {
  const match = AGENT_MAIL_HREF.exec(href);
  if (!match) return null;
  const bytes = bytesOf(match[2]);
  if (bytes === null) return null;
  return { accountId: match[1], threadId: new TextDecoder().decode(bytes) };
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
