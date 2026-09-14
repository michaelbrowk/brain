import fs from "node:fs/promises";
import path from "node:path";
import webpush from "web-push";
import { atomicWrite } from "@/lib/store/atomic";
import {
  DEFAULT_PUSH_KINDS,
  MAX_PUSH_SUBSCRIPTIONS,
  type PushKindPreferences,
  type PushSubscriptionRecord,
} from "./model";
import { pushStateDirectory } from "./state-dir";

/** PUSH STATE, UNDER THE STATE DIRECTORY.
 *
 *  Three files: the VAPID pair, the subscriptions, the per-kind toggles. All
 *  0600 inside a 0700 directory, on the pattern lib/oauth/state.ts and
 *  lib/update-check.ts set.
 *
 *  THE PRIVATE KEY IS RUNTIME STATE AND IS NEVER IN THE REPOSITORY. It is
 *  generated here on first use rather than read from the environment, so
 *  there is no secret for a self-hoster to paste, no secret in a compose file,
 *  and nothing for gitleaks to catch because nothing was ever written down.
 *  Rotating it invalidates every existing subscription (RFC 8292: the public
 *  key is baked into each PushSubscription), so it is generated once and kept.
 */

export type { PushEnv } from "./state-dir";
export { pushStateDirectory } from "./state-dir";

export const VAPID_FILE = "vapid.json";
export const SUBSCRIPTIONS_FILE = "subscriptions.json";
export const PREFERENCES_FILE = "preferences.json";

/** One writer at a time inside this process. The scan timer and a route
 *  handler both reach this module, and a read-modify-write on a whole file
 *  loses one of two interleaved saves. Same reason `Store.mutate` exists. */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writePrivate(dir: string, name: string, value: unknown): Promise<void> {
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  // `mkdir` sets a mode only when it creates the directory, so a push
  // directory laid down by hand at 0755 would keep the private key where any
  // shell account on the box can read it. Narrow it every time, the way the
  // file below is narrowed.
  await fs.chmod(/* turbopackIgnore: true */ dir, 0o700);
  const file = path.join(dir, name);
  await atomicWrite(file, JSON.stringify(value) + "\n");
  // atomicWrite opens the temp file with the process umask, which on a
  // developer machine is 0022. The systemd unit sets UMask=0077 so production
  // already lands at 0600; this makes the mode the same everywhere.
  await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function readPrivate(dir: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  } catch {
    return null;
  }
}

export async function readVapidKeys(
  dir = pushStateDirectory(),
): Promise<{ publicKey: string; privateKey: string }> {
  return serialise(async () => {
    const held = await readPrivate(dir, VAPID_FILE);
    if (
      typeof held === "object" &&
      held !== null &&
      typeof (held as Record<string, unknown>).publicKey === "string" &&
      typeof (held as Record<string, unknown>).privateKey === "string"
    ) {
      return held as { publicKey: string; privateKey: string };
    }
    // A missing file is an ordinary first boot. A file that is there and
    // cannot be read is the loudest failure this subsystem has: the new pair
    // silently invalidates every subscription, because a browser baked the old
    // public key into the one it created. Nothing else marks that moment.
    if (await fileExists(path.join(dir, VAPID_FILE))) {
      console.warn(
        "[brain/push] the VAPID pair on disk could not be read. A new pair was generated, " +
          "so every device must register again before it receives anything.",
      );
    }
    const made = webpush.generateVAPIDKeys();
    await writePrivate(dir, VAPID_FILE, made);
    return made;
  });
}

function isRecord(value: unknown): value is PushSubscriptionRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.endpoint === "string" &&
    typeof row.deviceLabel === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.lastSeenAt === "string" &&
    typeof row.keys === "object" &&
    row.keys !== null &&
    typeof (row.keys as Record<string, unknown>).p256dh === "string" &&
    typeof (row.keys as Record<string, unknown>).auth === "string"
  );
}

async function readSubscriptions(dir: string): Promise<PushSubscriptionRecord[]> {
  const held = await readPrivate(dir, SUBSCRIPTIONS_FILE);
  return Array.isArray(held) ? held.filter(isRecord) : [];
}

export async function listPushSubscriptions(
  dir = pushStateDirectory(),
): Promise<PushSubscriptionRecord[]> {
  return readSubscriptions(dir);
}

/** The worker's own placeholder on the `pushsubscriptionchange` path
 *  (public/sw.js): there is no user agent in a service worker to build a real
 *  label from, so it posts this and leaves the naming to the row it replaces.
 *  A caller that sends anything else is naming the device itself, the way
 *  Settings' own rotated-key re-subscribe does (components/push-client.ts). */
const WORKER_DEVICE_LABEL = "This device";

/** `previousId` is the row this registration REPLACES, from the endpoint a
 *  `pushsubscriptionchange` names. A push service may retire an endpoint
 *  without asking, and the worker that hears it has no user agent to build a
 *  label from, so it posts "This device". Without the endpoint it replaced,
 *  one phone became two rows in Settings: the name the owner recognises on a
 *  row that can never ring again, and "This device" beside it.
 *
 *  The first day always moves across. The name moves across only when the
 *  incoming one is the worker's placeholder: a rotated-key re-subscribe from
 *  Settings carries the device's own real label (`deviceLabel(navigator.userAgent, …)`),
 *  and that must win over the row it replaces or a Mac renames itself "iPhone"
 *  forever. A same-id save is not a replacement: a device registering on its
 *  own endpoint from Settings is naming itself, and its new label wins there
 *  too. */
export async function savePushSubscription(
  record: PushSubscriptionRecord,
  dir = pushStateDirectory(),
  previousId: string | null = null,
): Promise<PushSubscriptionRecord> {
  return serialise(async () => {
    const rows = await readSubscriptions(dir);
    const held = rows.find((row) => row.id === record.id);
    const replaced =
      previousId !== null && previousId !== record.id
        ? rows.find((row) => row.id === previousId)
        : undefined;
    // A device that re-subscribes on the same endpoint is the same device,
    // and the day it first allowed notifications is a fact about it.
    const carried = held ?? replaced;
    const landed: PushSubscriptionRecord = carried
      ? {
          ...record,
          createdAt: carried.createdAt,
          deviceLabel:
            held || record.deviceLabel !== WORKER_DEVICE_LABEL
              ? record.deviceLabel
              : carried.deviceLabel,
        }
      : record;
    const next = [
      ...rows.filter((row) => row.id !== record.id && row.id !== previousId),
      landed,
    ].slice(-MAX_PUSH_SUBSCRIPTIONS);
    await writePrivate(dir, SUBSCRIPTIONS_FILE, next);
    return landed;
  });
}

export async function removePushSubscription(
  id: string,
  dir = pushStateDirectory(),
): Promise<boolean> {
  return serialise(async () => {
    const rows = await readSubscriptions(dir);
    const next = rows.filter((row) => row.id !== id);
    if (next.length === rows.length) return false;
    await writePrivate(dir, SUBSCRIPTIONS_FILE, next);
    return true;
  });
}

export async function readPushKinds(dir = pushStateDirectory()): Promise<PushKindPreferences> {
  const held = await readPrivate(dir, PREFERENCES_FILE);
  if (typeof held !== "object" || held === null) return { ...DEFAULT_PUSH_KINDS };
  const row = held as Record<string, unknown>;
  // A file this process cannot read means both kinds on: the safe default for
  // a notification setting is the one the owner chose when they turned push on.
  if (typeof row["task-reminder"] !== "boolean" || typeof row["mail-new"] !== "boolean") {
    return { ...DEFAULT_PUSH_KINDS };
  }
  return { "task-reminder": row["task-reminder"], "mail-new": row["mail-new"] };
}

export async function writePushKinds(
  patch: Partial<PushKindPreferences>,
  dir = pushStateDirectory(),
): Promise<PushKindPreferences> {
  return serialise(async () => {
    const held = await readPushKinds(dir);
    const next: PushKindPreferences = { ...held, ...patch };
    await writePrivate(dir, PREFERENCES_FILE, next);
    return next;
  });
}
