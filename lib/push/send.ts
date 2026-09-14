import webpush from "web-push";
import { PROJECT_URL } from "@/lib/project";
import {
  PUSH_TTL_SECONDS,
  subscriptionIsGone,
  type PushKind,
  type PushPayload,
  type PushSubscriptionRecord,
} from "./model";
import {
  listPushSubscriptions,
  pushStateDirectory,
  readPushKinds,
  readVapidKeys,
  removePushSubscription,
} from "./store";

/** SENDING.
 *
 *  One message per registered device, the payload the spec fixes (title, body,
 *  href, nothing else), a one-hour TTL, and a 404 or a 410 removing the
 *  subscription that produced it.
 *
 *  The endpoint never reaches a log line: it is a capability, and a journal
 *  is not the place for one. A failure names the device's id.
 */

export interface SendPort {
  dir: string;
  deliver(
    record: PushSubscriptionRecord,
    payload: string,
    options: { TTL: number },
  ): Promise<void>;
}

/** RFC 8292 §2 wants a contact URI for whoever runs this server, so a push
 *  service has somewhere to complain. The instance's own origin when it has
 *  one, the project otherwise. */
function vapidSubject(): string {
  const configured = process.env.BRAIN_PUBLIC_ORIGIN?.trim();
  if (configured && configured.startsWith("https://")) return configured;
  return PROJECT_URL;
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === "number" ? status : null;
}

export async function sendPush(
  kind: PushKind,
  payload: PushPayload,
  overrides: Partial<SendPort> = {},
): Promise<{ sent: number; removed: number; skipped: "kind-off" | "no-devices" | null }> {
  const dir = overrides.dir ?? pushStateDirectory();
  const kinds = await readPushKinds(dir);
  // THE CENTRE STILL LISTS IT. A kind switched off stops the buzz and nothing
  // else (spec §7), which is why this check is here and not at the producer.
  if (!kinds[kind]) return { sent: 0, removed: 0, skipped: "kind-off" };

  const records = await listPushSubscriptions(dir);
  if (records.length === 0) return { sent: 0, removed: 0, skipped: "no-devices" };

  const deliver =
    overrides.deliver ??
    (async (record: PushSubscriptionRecord, body: string, options: { TTL: number }) => {
      const keys = await readVapidKeys(dir);
      await webpush.sendNotification({ endpoint: record.endpoint, keys: record.keys }, body, {
        TTL: options.TTL,
        urgency: "normal",
        vapidDetails: {
          subject: vapidSubject(),
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      });
    });

  const body = JSON.stringify({
    title: payload.title,
    ...(payload.body !== undefined ? { body: payload.body } : {}),
    href: payload.href,
  });

  let sent = 0;
  let removed = 0;
  for (const record of records) {
    try {
      await deliver(record, body, { TTL: PUSH_TTL_SECONDS });
      sent += 1;
    } catch (cause: unknown) {
      const status = statusOf(cause);
      if (status !== null && subscriptionIsGone(status)) {
        await removePushSubscription(record.id, dir);
        removed += 1;
        continue;
      }
      console.warn(
        `[brain/push] device ${record.id} did not take the message: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return { sent, removed, skipped: null };
}
