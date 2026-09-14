import crypto from "node:crypto";

/** THE PUSH SHAPES.
 *
 *  Two kinds are pushed and `task-missed` is deliberately not one of them: a
 *  buzz about yesterday afternoon is noise, and the centre already holds the
 *  row (spec §6).
 */

export const PUSH_KINDS = ["task-reminder", "mail-new"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];

export interface PushKindPreferences {
  "task-reminder": boolean;
  "mail-new": boolean;
}

export const DEFAULT_PUSH_KINDS: PushKindPreferences = {
  "task-reminder": true,
  "mail-new": true,
};

/** Title, body, href and the notification's own id (spec §8, Privacy). A
 *  payload is encrypted to the device, and the wording in Settings still says
 *  what leaves the server, because "encrypted" is not the same as "not sent".
 *
 *  `tag` is that id and not content: `task-reminder:<task id>:<when>` or
 *  `mail-new:<account>:<hex thread id>`, which the server already made for the
 *  centre. The worker tags the notification with it so two reminders due in
 *  one scan are two notifications rather than one replacing the other: every
 *  reminder's href is "/tasks" and every mail row's is "/mail", so a tag built
 *  from the destination collapsed them. */
export interface PushPayload {
  title: string;
  body?: string;
  href: string;
  tag?: string;
}

/** An hour. `web-push` defaults to four weeks, which for a 13:00 reminder
 *  means a phone that was off all week ringing about Tuesday on Friday. A
 *  reminder that missed its hour is the centre's business now. */
export const PUSH_TTL_SECONDS = 3600;

/** One owner, one pocket. Twenty is far past a person's device count and far
 *  short of a file worth worrying about. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;

/** What the service worker will show of either field
 *  (`lib/push/worker-handlers.ts` slices to the same two numbers), and the
 *  reason the wire payload is cut to them before it is sent: the encrypted
 *  body has a ceiling near 4 KB, and a push service answers 413 for a longer
 *  one. A subject line that arrives cut is better than a reminder that never
 *  arrives. */
export const MAX_PUSH_TITLE = 200;
export const MAX_PUSH_BODY = 400;
/** A notification id is bounded at 400 characters by the centre's own id rule
 *  (lib/notifications/model.ts). The cap is restated rather than imported: the
 *  push side reads nothing else from the notification centre. */
export const MAX_PUSH_TAG = 400;

export interface PushSubscriptionRecord {
  id: string;
  /** Never logged and never sent to the browser. It is a capability: anyone
   *  holding it can deliver a notification to that device. */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PushDeviceView {
  id: string;
  deviceLabel: string;
  createdAt: string;
  lastSeenAt: string;
}

/** 404 means the endpoint URL itself is not a thing; 410 Gone means it was and
 *  is not. Both mean delete the row. 400, 413 and 429 are this server's
 *  problem and the subscription stays. */
export function subscriptionIsGone(status: number): boolean {
  return status === 404 || status === 410;
}

/** The id a device is named by in Settings and in a log line. A hash, so the
 *  endpoint never has to travel to say which device is meant. */
export function pushSubscriptionId(endpoint: string): string {
  return crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

export function deviceView(record: PushSubscriptionRecord): PushDeviceView {
  return {
    id: record.id,
    deviceLabel: record.deviceLabel,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
  };
}

/** Decode a base64url field and say how many bytes it held. `Buffer.from`
 *  drops characters outside the alphabet without complaining, so the shape of
 *  the string is checked before its length is trusted. */
function base64UrlByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  return Buffer.from(value, "base64url").length;
}

/** THE KEYS ARE CHECKED FOR SHAPE, NOT ONLY FOR LENGTH.
 *
 *  A `p256dh` that is not an uncompressed P-256 point makes `web-push` throw
 *  from the encryption step with a plain Error and no `statusCode`, so the
 *  send path cannot tell it from a network problem: the row is kept, and every
 *  reminder from then on warns about a device that can never receive one. The
 *  door is the only place that failure can be stopped.
 */
function keysAreWellFormed(p256dh: string, auth: string): boolean {
  if (base64UrlByteLength(p256dh) !== 65) return false;
  if (Buffer.from(p256dh, "base64url")[0] !== 0x04) return false;
  return base64UrlByteLength(auth) === 16;
}

export function parsePushSubscription(raw: unknown): PushSubscriptionRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const at = body.at;
  const deviceLabel = body.deviceLabel;
  const subscription = body.subscription;
  if (typeof at !== "string" || typeof deviceLabel !== "string") return null;
  if (deviceLabel.length < 1 || deviceLabel.length > 60) return null;
  if (typeof subscription !== "object" || subscription === null) return null;
  const { endpoint, keys } = subscription as Record<string, unknown>;
  if (typeof endpoint !== "string" || endpoint.length > 2_048) return null;
  if (!endpoint.startsWith("https://")) return null;
  if (typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (p256dh.length < 1 || p256dh.length > 200 || auth.length < 1 || auth.length > 100) return null;
  if (!keysAreWellFormed(p256dh, auth)) return null;
  return {
    id: pushSubscriptionId(endpoint),
    endpoint,
    keys: { p256dh, auth },
    deviceLabel,
    createdAt: at,
    lastSeenAt: at,
  };
}
