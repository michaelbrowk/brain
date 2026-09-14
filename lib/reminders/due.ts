import type { TaskView } from "@/lib/tasks/model";

/** THE REMINDER RULE, AS ARITHMETIC.
 *
 *  No clock, no filesystem, no Store. The timer passes `now`, the owner
 *  setting passes the zone, and the store passes the records. That is what
 *  makes a DST edge a table row rather than a Tuesday in March.
 *
 *  `lib/tasks` reads no clock at all (AGENTS.md), which is why this lives
 *  under lib/reminders and not beside `listOf`.
 */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** A day either side is far enough to straddle any transition and near enough
 *  that no zone changes its standard offset in between. */
const ONE_DAY_MS = 86_400_000;

/** A reminder missed by less than a day still rings; anything older is
 *  history and reaches the centre as `task-missed` instead (spec §6). */
export const MISSED_AFTER_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const held = formatters.get(zone);
  if (held !== undefined) return held;
  let made: Intl.DateTimeFormat | null;
  try {
    made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    // An IANA name the platform does not carry. The scheduler does nothing
    // rather than guessing UTC, which would ring at the wrong hour silently.
    made = null;
  }
  formatters.set(zone, made);
  return made;
}

/** The zone's offset from UTC, in milliseconds, at one instant. */
function offsetAt(utcMs: number, formatter: Intl.DateTimeFormat): number {
  const parts = formatter.formatToParts(new Date(utcMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return asUtc - utcMs;
}

/**
 * The UTC instant a wall clock names in a zone, or null when the day, the
 * time or the zone cannot be read.
 *
 * Two candidates, one per side of a possible transition, and three outcomes.
 * Both candidates valid means the wall clock happens TWICE (the autumn
 * fall-back) and the earlier one is what a person means. Neither valid means
 * it happens NEVER (the spring-forward gap) and the later one is the instant
 * the clock jumps to, so a 01:30 reminder on that day rings at 02:30 rather
 * than an hour early. Exactly one valid is an ordinary day.
 */
export function zonedInstant(day: string, time: string, zone: string): number | null {
  const dayParts = DAY_RE.exec(day);
  const timeParts = TIME_RE.exec(time);
  if (!dayParts || !timeParts) return null;
  const formatter = formatterFor(zone);
  if (!formatter) return null;

  const naive = Date.UTC(
    Number(dayParts[1]),
    Number(dayParts[2]) - 1,
    Number(dayParts[3]),
    Number(timeParts[1]),
    Number(timeParts[2]),
  );
  const before = naive - offsetAt(naive - ONE_DAY_MS, formatter);
  const after = naive - offsetAt(naive + ONE_DAY_MS, formatter);
  const valid = [before, after].filter(
    (candidate) => offsetAt(candidate, formatter) === naive - candidate,
  );
  if (valid.length === 2) return Math.min(before, after);
  if (valid.length === 0) return Math.max(before, after);
  return valid[0];
}

export interface DueReminder {
  /** `fire` reaches the centre and the push. `missed` reaches the centre
   *  alone: a notification about yesterday afternoon is not worth a buzz. */
  readonly kind: "fire" | "missed";
  readonly id: string;
  readonly title: string;
  readonly when: string;
  readonly time: string;
  readonly at: number;
}

/** Every reminder that is owed at `nowMs`, oldest first.
 *
 *  A record whose `remindedAt` is already set is refused HERE rather than at
 *  the store leaf: `markTaskReminded` writes whatever it is handed, so this
 *  list is the one thing standing between a fired reminder and a second ring
 *  thirty seconds later.
 */
export function dueReminders(
  tasks: readonly TaskView[],
  zone: string,
  nowMs: number,
): DueReminder[] {
  const rows: DueReminder[] = [];
  for (const task of tasks) {
    if (task.done) continue;
    if (task.remindedAt !== undefined) continue;
    const when = task.when;
    const time = task.time;
    if (when === undefined || when === "someday" || time === undefined) continue;
    const at = zonedInstant(when, time, zone);
    if (at === null) continue;
    if (at > nowMs) continue;
    rows.push({
      kind: nowMs - at < MISSED_AFTER_MS ? "fire" : "missed",
      id: task.id,
      title: task.title,
      when,
      time,
      at,
    });
  }
  return rows.sort((a, b) => a.at - b.at);
}
