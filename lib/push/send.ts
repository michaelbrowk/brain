import webpush from "web-push";
import { PROJECT_URL } from "@/lib/project";
import {
  MAX_PUSH_BODY,
  MAX_PUSH_TAG,
  MAX_PUSH_TITLE,
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

/** `web-push` sets a socket timeout only when it is handed one, so without
 *  this an unresponsive push service holds a request open with no ceiling,
 *  and the reminder scan behind it waits for the same forever. */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

/** How many devices are in flight at once. One at a time made every later
 *  device wait out the slowest one before it; all at once would open twenty
 *  sockets for one reminder. Four keeps a stalled endpoint off the other
 *  lanes without making a burst of it. */
export const PUSH_SEND_CONCURRENCY = 4;

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

  // Read once for the whole send rather than once per device, and not once
  // per process: a pair replaced on disk has to reach the next send.
  let pair: Promise<{ publicKey: string; privateKey: string }> | null = null;
  const deliver =
    overrides.deliver ??
    (async (record: PushSubscriptionRecord, body: string, options: { TTL: number }) => {
      pair ??= readVapidKeys(dir);
      const keys = await pair;
      await webpush.sendNotification({ endpoint: record.endpoint, keys: record.keys }, body, {
        TTL: options.TTL,
        timeout: PUSH_REQUEST_TIMEOUT_MS,
        urgency: "normal",
        vapidDetails: {
          subject: vapidSubject(),
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      });
    });

  // Cut to what the worker will show. The encrypted body has a ceiling near
  // 4 KB and a push service answers 413 past it, so a long mail subject would
  // otherwise cost the whole notification rather than its tail.
  const body = JSON.stringify({
    title: payload.title.slice(0, MAX_PUSH_TITLE),
    ...(payload.body !== undefined ? { body: payload.body.slice(0, MAX_PUSH_BODY) } : {}),
    href: payload.href,
    // The notification's own id, which the worker tags the notification with.
    // Without it every reminder tags `brain:/tasks` and the second of a scan
    // replaces the first on the device.
    ...(payload.tag !== undefined ? { tag: payload.tag.slice(0, MAX_PUSH_TAG) } : {}),
  });

  let sent = 0;
  let removed = 0;
  let next = 0;
  const lanes = Math.min(PUSH_SEND_CONCURRENCY, records.length);
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        // One thread, so taking an index and moving it on is atomic.
        const record = records[next];
        next += 1;
        if (!record) return;
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
          // The status is the one thing an operator needs here: WebPushError's
          // message is a constant, so 429, 400 and 500 read the same without
          // it. The endpoint is a capability and stays out of the journal.
          console.warn(
            `[brain/push] device ${record.id} did not take the message (status ${status ?? "none"}): ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }),
  );
  return { sent, removed, skipped: null };
}
