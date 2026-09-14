/** PLACEHOLDER. Task 4 of the reminders-and-notifications plan replaces this
 *  file whole with the Web Push sender: VAPID keys, the subscription list, the
 *  per-kind preference and the 410 sweep.
 *
 *  It carries Task 4's final signature rather than a shorter one, so the two
 *  callers (`lib/reminders/scheduler.ts` here, `lib/notifications/mail-scan.ts`
 *  in Task 3) compile against the real shape and do not have to be edited when
 *  the real sender lands. Until then nothing leaves the machine, which is what
 *  `skipped: "no-push"` says out loud.
 */

export type PushKind = "task-reminder" | "mail-new";

export interface PushPayload {
  title: string;
  body?: string;
  href: string;
}

/* eslint-disable @typescript-eslint/no-unused-vars -- the parameters are the
   contract the callers compile against; Task 4 writes the body that reads them. */
export async function sendPush(
  kind: PushKind,
  payload: PushPayload,
  /** Task 4 narrows this to `Partial<SendPort>`. Nothing passes it yet. */
  overrides?: Record<string, unknown>,
): Promise<{ sent: number; removed: number; skipped: "no-push" }> {
  return { sent: 0, removed: 0, skipped: "no-push" };
}
/* eslint-enable @typescript-eslint/no-unused-vars */
