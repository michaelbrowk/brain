import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@/lib/store/atomic";
import { emitStore } from "@/lib/store/events";
import { foldLegacyMailRows } from "./mail-rows";
import {
  NOTIFICATION_KIND_CAP,
  isNotificationInstant,
  notificationSchema,
  type BrainNotification,
} from "./model";
import { notificationStateDirectory } from "./state-dir";

/** THE CENTRE ON DISK.
 *
 *  One JSON file under the state directory, on the pattern the OAuth store and
 *  the update check (`lib/update-check.ts`) already use: env override, then
 *  /var/lib/brain/<name> in production, then a per-user temp folder; directory
 *  0700, file 0600, temp-then-rename.
 *
 *  It is NOT in the notes folder and not in the portable archive. A
 *  notification is machine state about the notes, not a note, and a person who
 *  restores an archive on a new machine wants their tasks back, not last
 *  month's alarms.
 */

export type { NotificationEnv } from "./state-dir";
export { notificationStateDirectory } from "./state-dir";

export const NOTIFICATIONS_FILE = "notifications.json";

interface StoredFile {
  version: 1;
  items: BrainNotification[];
}

/** One writer at a time inside this process. The scan timer and a route
 *  handler both reach this module, and a read-modify-write on a whole file
 *  loses one of two interleaved appends. Same reason `Store.mutate` exists. */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readAll(dir: string): Promise<BrainNotification[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, NOTIFICATIONS_FILE), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A file this process cannot read is not a file to delete. The centre
    // starts empty and the next append rewrites it whole.
    return [];
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as StoredFile).version !== 1 ||
    !Array.isArray((parsed as StoredFile).items)
  ) {
    return [];
  }
  const rows: BrainNotification[] = [];
  for (const item of (parsed as StoredFile).items) {
    const row = notificationSchema.safeParse(item);
    if (row.success) rows.push(row.data);
  }
  // The one shape this file reads differently from the way it was written: a
  // centre from before 0.12.2 holds one mail row per thread, and they are
  // folded into the single counted row on the way out. Every write below
  // starts from this answer, so the first one persists the fold.
  return [...foldLegacyMailRows(rows)];
}

async function writeAll(dir: string, items: BrainNotification[]): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, NOTIFICATIONS_FILE);
  const payload: StoredFile = { version: 1, items };
  await atomicWrite(file, JSON.stringify(payload) + "\n");
  // atomicWrite opens the temp file with the process umask, which on a
  // developer machine is 0022. The systemd unit sets UMask=0077 so production
  // already lands at 0600; this makes the mode the same everywhere.
  await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
}

/** Newest first. The order is stable so the bell never reshuffles a list a
 *  reader is looking at. */
function sorted(items: BrainNotification[]): BrainNotification[] {
  return [...items].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/** NEWEST FIRST, AND AT MOST `NOTIFICATION_KIND_CAP` OF EACH KIND.
 *
 *  The bound every write applies. Counting per kind rather than over the whole
 *  file is what keeps a burst of mail from evicting the reminders under it: the
 *  rows arrive here newest first, so what a kind keeps is its newest and what it
 *  drops is its own oldest. The file's total is bounded by the sum of the four,
 *  which is `NOTIFICATION_CAP`. */
function capped(items: BrainNotification[]): BrainNotification[] {
  const kept: BrainNotification[] = [];
  const held = new Map<BrainNotification["kind"], number>();
  for (const row of sorted(items)) {
    const already = held.get(row.kind) ?? 0;
    if (already >= NOTIFICATION_KIND_CAP) continue;
    held.set(row.kind, already + 1);
    kept.push(row);
  }
  return kept;
}

export async function listNotifications(
  dir = notificationStateDirectory(),
): Promise<BrainNotification[]> {
  return sorted(await readAll(dir));
}

export async function unreadNotificationCount(
  dir = notificationStateDirectory(),
): Promise<number> {
  return (await readAll(dir)).filter((row) => row.readAt === undefined).length;
}

/** `true` only when the row is in the file after the call, and the event fires
 *  on exactly that. Three ways to get `false`, and a caller has to be able to
 *  tell them apart from a success or it will mark work done that was not:
 *
 *  - the id is already there. Two scans that compute the same reminder, or two
 *    polls that see the same thread, are one row.
 *  - the row is not one the schema accepts. `readAll` refuses the same rows on
 *    the way back, so a row written without this check would be announced and
 *    then vanish at the next read.
 *  - the centre is full and this row is older than everything in it. The cap
 *    drops the oldest by `at`, so a backfilled row can evict itself. Nothing is
 *    written in that case, and the producer is free to retry or record the loss.
 *
 *  The announcement is here rather than in each producer, so a kind added later
 *  cannot forget it, and an open tab lights its bell without polling. */
export async function appendNotification(
  notification: BrainNotification,
  dir = notificationStateDirectory(),
): Promise<boolean> {
  const taken = await serialise(async () => {
    const parsed = notificationSchema.safeParse(notification);
    if (!parsed.success) return false;
    const row = parsed.data;
    const items = await readAll(dir);
    if (items.some((held) => held.id === row.id)) return false;
    const next = capped([...items, row]);
    if (!next.some((held) => held.id === row.id)) return false;
    await writeAll(dir, next);
    return true;
  });
  if (taken) emitStore({ type: "notification", id: notification.id });
  return taken;
}

/** WHAT AN APPEND DID, when the caller has a second row it would rather write.
 *
 *  `folded` is `row` merged into one the centre may already hold: the same
 *  action a moment later, counted rather than repeated. Both are decided before
 *  this call and only one is written, because whether there is still a row to
 *  fold into is a fact about the file, and the file may only be read and
 *  written under one lock.
 *
 *  The fold is taken only when the centre holds `folded.id` AND has not had it
 *  read. A row the reader has already seen is not rewritten under them: folding
 *  into it would either hide the new action behind a read row or drag a row
 *  they have dealt with back to unread, and a new row says the true thing.
 */
export async function appendOrFoldNotification(
  row: BrainNotification,
  folded: BrainNotification | null,
  dir = notificationStateDirectory(),
): Promise<"appended" | "folded" | "refused"> {
  const done = await serialise(async () => {
    const items = await readAll(dir);
    if (folded !== null) {
      const parsed = notificationSchema.safeParse(folded);
      const held = items.find((candidate) => candidate.id === folded.id);
      if (parsed.success && held !== undefined && held.readAt === undefined) {
        // The bound is re-applied on this branch too, though a fold is
        // count-preserving and cannot push a kind past it on its own: a file
        // that already holds more than the kind's share, from an older writer
        // or a hand edit, is then trimmed by either branch rather than by one
        // of them.
        const next = capped([
          ...items.filter((candidate) => candidate.id !== folded.id),
          parsed.data,
        ]);
        await writeAll(dir, next);
        return "folded" as const;
      }
    }
    const parsed = notificationSchema.safeParse(row);
    if (!parsed.success) return "refused" as const;
    if (items.some((held) => held.id === parsed.data.id)) return "refused" as const;
    const next = capped([...items, parsed.data]);
    if (!next.some((held) => held.id === parsed.data.id)) return "refused" as const;
    await writeAll(dir, next);
    return "appended" as const;
  });
  // A fold moves a row the bell is already drawing, so it is announced like an
  // append: an open tab has to redraw the count and the title it is showing.
  if (done === "folded") emitStore({ type: "notification", id: folded!.id });
  if (done === "appended") emitStore({ type: "notification", id: row.id });
  return done;
}

/** A read is not announced. The tab that pressed the row already knows, and a
 *  second tab showing one stale unread until its next fetch is cheaper than a
 *  broadcast on every press.
 *
 *  An `at` the schema would refuse touches nothing and answers 0. Writing one
 *  would put a `readAt` on real rows that `readAll` then refuses, so a read
 *  would delete the notifications it was marking. */
export async function markNotificationsRead(
  ids: readonly string[],
  at: string,
  dir = notificationStateDirectory(),
): Promise<number> {
  if (!isNotificationInstant(at)) return 0;
  return serialise(async () => {
    const wanted = new Set(ids);
    const items = await readAll(dir);
    let changed = 0;
    const next = items.map((row) => {
      if (!wanted.has(row.id) || row.readAt !== undefined) return row;
      changed += 1;
      return { ...row, readAt: at };
    });
    if (changed > 0) await writeAll(dir, sorted(next));
    return changed;
  });
}

export async function markAllNotificationsRead(
  at: string,
  dir = notificationStateDirectory(),
): Promise<number> {
  if (!isNotificationInstant(at)) return 0;
  return serialise(async () => {
    const items = await readAll(dir);
    let changed = 0;
    const next = items.map((row) => {
      if (row.readAt !== undefined) return row;
      changed += 1;
      return { ...row, readAt: at };
    });
    if (changed > 0) await writeAll(dir, sorted(next));
    return changed;
  });
}

/** Every row gone, and the count that were there. There is no owner surface
 *  for this and there is deliberately none: a reader who has seen a row marks
 *  it read, and a centre that forgets on request would lose the one record of
 *  a reminder nobody acted on. The caller is the harness reset
 *  (`app/api/dev/reset/route.ts`), which needs a spec file to open the bell on
 *  its own run rather than on the run of the file that sorted before it.
 *
 *  No announcement. `appendNotification` broadcasts because an open tab has to
 *  light its bell without polling; a reset happens between two spec files with
 *  no tab open, and the event vocabulary is a produced row's, not an erased
 *  one's. An empty centre is written whole rather than unlinked, so the file
 *  keeps the mode and the temp-then-rename path every other write here uses,
 *  and a centre with no file yet stays a centre with no file. */
export async function clearNotifications(
  dir = notificationStateDirectory(),
): Promise<number> {
  return serialise(async () => {
    const items = await readAll(dir);
    if (items.length === 0) return 0;
    await writeAll(dir, []);
    return items.length;
  });
}
