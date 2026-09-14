import {
  taskMissedNotificationId,
  taskReminderNotificationId,
  type BrainNotification,
} from "@/lib/notifications/model";
import { appendNotification } from "@/lib/notifications/store";
import type { TaskView } from "@/lib/tasks/model";
import { dueReminders } from "./due";

/** THE ONE BACKGROUND TIMER OF THIS SUBSYSTEM.
 *
 *  Shape copied from `scheduleUpdateChecks` (lib/update-check.ts): a
 *  `setTimeout` for the first run, a `setInterval` after it, both `.unref()`'d
 *  so they never hold the process open, an env kill switch, hard off under
 *  NODE_ENV=test, and a disposer returned for shutdown and for tests.
 *
 *  Thirty seconds is the scan (spec §6). A reminder set for 13:00 therefore
 *  rings between 13:00:00 and 13:00:30, which is inside the minute a person
 *  can see on their own clock.
 *
 *  It also carries the mail poll, which has no timer of its own: one interval
 *  for the whole feature is one thing to turn off and one thing to reason
 *  about at boot.
 */

export const REMINDER_SCAN_MS = 30_000;
const FIRST_SCAN_DELAY_MS = 15_000;
/** The mail service's own background sync runs once a minute, so polling it
 *  twice that often would ask the same question twice for one answer. */
const MAIL_SCAN_EVERY = 2;

export interface ReminderEnv {
  NODE_ENV?: string;
  BRAIN_REMINDERS?: string;
}

function processEnv(): ReminderEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    BRAIN_REMINDERS: process.env.BRAIN_REMINDERS,
  };
}

export function remindersEnabled(env: ReminderEnv = processEnv()): boolean {
  if (env.NODE_ENV === "test") return false;
  const raw = (env.BRAIN_REMINDERS ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "off" && raw !== "false";
}

export interface ReminderPort {
  tasks(): Promise<readonly TaskView[]>;
  markReminded(id: string, at: string): Promise<void>;
  zone(): Promise<string | null>;
  /** `false` when the centre already held this id. */
  notify(notification: BrainNotification): Promise<boolean>;
  push(payload: { title: string; body?: string; href: string }): Promise<void>;
  now(): number;
}

const PORT_MEMBERS = ["tasks", "markReminded", "zone", "notify", "push", "now"] as const;

async function defaultPort(): Promise<ReminderPort> {
  const [{ getStore }, { readTimeZone }, { sendPush }] = await Promise.all([
    import("@/lib/store"),
    import("@/lib/owner-settings"),
    import("@/lib/push/send"),
  ]);
  const store = await getStore();
  return {
    tasks: async () => store.allTaskViews(),
    markReminded: async (id, at) => {
      await store.markTaskReminded(id, at);
    },
    zone: () => readTimeZone(),
    notify: (notification) => appendNotification(notification),
    push: async (payload) => {
      await sendPush("task-reminder", payload);
    },
    now: () => Date.now(),
  };
}

/** The real port is built only for the members the caller did not bring.
 *  A test that supplies all six gets exactly those six, and `getStore()` is
 *  never reached: opening the notes root to run an arithmetic test would make
 *  the scan's own suite depend on somebody's notes folder.
 */
async function resolvePort(overrides: Partial<ReminderPort>): Promise<ReminderPort> {
  if (PORT_MEMBERS.every((member) => overrides[member] !== undefined)) {
    return overrides as ReminderPort;
  }
  return { ...(await defaultPort()), ...overrides };
}

/** NO ZONE, NO SCAN, AND SAID ONCE. A server running every thirty seconds
 *  would otherwise print the same line 2,880 times a day. Cleared as soon as a
 *  zone appears, so a zone that is removed later is announced again. */
let zoneAnnounced = false;

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function runReminderScan(
  overrides: Partial<ReminderPort> = {},
): Promise<{ fired: number; missed: number; skipped: "no-zone" | "off" | null }> {
  const port = await resolvePort(overrides);
  const zone = await port.zone();
  // Guessing UTC would ring at the wrong hour and say nothing about it.
  // Settings says so instead, and the log says it once.
  if (!zone) {
    if (!zoneAnnounced) {
      zoneAnnounced = true;
      console.warn(
        "[brain/reminders] no owner time zone is set, so no reminder can be timed. Open Settings to set one.",
      );
    }
    return { fired: 0, missed: 0, skipped: "no-zone" };
  }
  zoneAnnounced = false;

  const now = port.now();
  const rows = dueReminders(await port.tasks(), zone, now);
  const at = new Date(now).toISOString();
  let fired = 0;
  let missed = 0;

  for (const row of rows) {
    const notification: BrainNotification =
      row.kind === "fire"
        ? {
            id: taskReminderNotificationId(row.id, row.when, row.time),
            kind: "task-reminder",
            at,
            title: row.title,
            body: row.time,
            href: "/tasks",
          }
        : {
            id: taskMissedNotificationId(row.id, row.when, row.time),
            kind: "task-missed",
            at,
            title: row.title,
            body: `Was due ${row.when} at ${row.time}`,
            href: "/tasks",
          };
    try {
      const appended = await port.notify(notification);
      if (!appended) {
        // The centre did not take the row: it already held the id, it refused
        // the shape, or the row is older than the oldest of a full centre.
        // Once per record, because the mark below means the next scan does not
        // compute this reminder again.
        console.warn(
          `[brain/reminders] the centre did not store ${notification.id}; the record is marked anyway`,
        );
      }
      // THE MARK GOES ON WHATEVER THE CENTRE AND THE PUSH ANSWERED. The mark
      // means handled, not delivered. Leaving a record unmarked so a row the
      // centre would not take could be retried, or so a failed push could be,
      // would ring again in thirty seconds, and again after that, for as long
      // as the condition lasted.
      await port.markReminded(row.id, at);
      if (appended && row.kind === "fire") {
        await port
          .push({ title: row.title, body: row.time, href: "/tasks" })
          .catch((cause: unknown) => {
            console.warn(`[brain/reminders] push failed: ${reason(cause)}`);
          });
      }
      if (row.kind === "fire") fired += 1;
      else missed += 1;
    } catch (cause: unknown) {
      // One task's failed write is not the scan's. The next tick tries again.
      console.warn(`[brain/reminders] ${row.id} did not fire: ${reason(cause)}`);
    }
  }
  return { fired, missed, skipped: null };
}

/** Boot-time scheduler. Returns a disposer. */
export function scheduleReminderScans(
  options: { initialDelayMs?: number; intervalMs?: number } = {},
): () => void {
  if (!remindersEnabled()) return () => {};
  const initialDelayMs = options.initialDelayMs ?? FIRST_SCAN_DELAY_MS;
  const intervalMs = options.intervalMs ?? REMINDER_SCAN_MS;
  let disposed = false;
  let ticks = 0;
  let interval: NodeJS.Timeout | null = null;

  const run = () => {
    if (disposed) return;
    ticks += 1;
    void runReminderScan().catch((cause: unknown) => {
      console.warn(`[brain/reminders] scan failed: ${reason(cause)}`);
    });
    if (ticks % MAIL_SCAN_EVERY !== 1) return;
    void import("@/lib/notifications/mail-scan")
      .then(({ runMailScan }) => runMailScan())
      .catch((cause: unknown) => {
        // The mail service is another process with its own outage. A mail
        // poll that cannot reach it must never stop the reminders beside it.
        console.warn(`[brain/notifications] mail scan failed: ${reason(cause)}`);
      });
  };

  const first = setTimeout(() => {
    run();
    interval = setInterval(run, intervalMs);
    interval.unref();
  }, initialDelayMs);
  first.unref();

  return () => {
    disposed = true;
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
