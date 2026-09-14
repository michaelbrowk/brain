import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@/lib/store/atomic";
import { emitStore } from "@/lib/store/events";
import { NOTIFICATION_CAP, notificationSchema, type BrainNotification } from "./model";
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
  return rows;
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

/** `false` when the id is already there: two scans that compute the same
 *  reminder, or two polls that see the same thread, are one row.
 *
 *  A row the centre took is announced on the store's event bus, so an open tab
 *  lights its bell without polling. The announcement is here rather than in
 *  each producer, so a kind added later cannot forget it. */
export async function appendNotification(
  notification: BrainNotification,
  dir = notificationStateDirectory(),
): Promise<boolean> {
  const appended = await serialise(async () => {
    const items = await readAll(dir);
    if (items.some((row) => row.id === notification.id)) return false;
    const next = sorted([...items, notification]).slice(0, NOTIFICATION_CAP);
    await writeAll(dir, next);
    return true;
  });
  if (appended) emitStore({ type: "notification", id: notification.id });
  return appended;
}

/** A read is not announced. The tab that pressed the row already knows, and a
 *  second tab showing one stale unread until its next fetch is cheaper than a
 *  broadcast on every press. */
export async function markNotificationsRead(
  ids: readonly string[],
  at: string,
  dir = notificationStateDirectory(),
): Promise<number> {
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
