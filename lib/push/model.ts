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

/** Title, body and href, and nothing else (spec §8, Privacy). A payload is
 *  encrypted to the device, and the wording in Settings still says what
 *  leaves the server, because "encrypted" is not the same as "not sent". */
export interface PushPayload {
  title: string;
  body?: string;
  href: string;
}

/** An hour. `web-push` defaults to four weeks, which for a 13:00 reminder
 *  means a phone that was off all week ringing about Tuesday on Friday. A
 *  reminder that missed its hour is the centre's business now. */
export const PUSH_TTL_SECONDS = 3600;

/** One owner, one pocket. Twenty is far past a person's device count and far
 *  short of a file worth worrying about. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;

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
  return {
    id: pushSubscriptionId(endpoint),
    endpoint,
    keys: { p256dh, auth },
    deviceLabel,
    createdAt: at,
    lastSeenAt: at,
  };
}
