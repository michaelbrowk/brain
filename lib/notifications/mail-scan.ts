import type { MailThreadListItem } from "@/lib/mail/message-types";
import { MAIL_SCAN_PAGE, newMailNotifications } from "./mail-producer";
import type { BrainNotification } from "./model";
import { notificationStateDirectory } from "./state-dir";
import { appendNotification } from "./store";
import { readMailWatermarks, writeMailWatermark } from "./watermarks";

/** THE NEW-MAIL POLL.
 *
 *  The mail service is a separate process (ops/brain-mail.service) and emits
 *  nothing into this one: app/api/events/route.ts streams the store's own
 *  events and no mail event exists. So the producer polls, on the reminder
 *  timer's every-second tick, one Inbox page per account, against a per
 *  account high-water mark.
 *
 *  Nothing here logs an address or an endpoint. A poll that cannot reach the
 *  service raises no alarm of its own: the Mail surface already says so where
 *  a reader can act on it.
 */

/** HOW MANY ROWS ONE SCAN MAY APPEND, the same number and the same reason as
 *  the reminder scan's cap: every append takes a slot in the 256-entry SSE
 *  replay journal, and a scan that emptied it would leave every reconnecting
 *  tab with nothing to replay. One page is 25, so the cap can only bite from
 *  the third busy account onwards. */
export const MAX_MAIL_APPENDS_PER_SCAN = 50;

/** ONE PAGE MUST FIT INSIDE ONE SCAN'S BUDGET, AND `tsc` SAYS SO.
 *
 *  The whole-account rule below carries an account whose page does not fit the
 *  remaining budget, so a page larger than the cap would be carried on every
 *  tick for ever and that account's bell would never speak again. Prose next
 *  to two numbers is not a guard: this is, and it costs nothing at runtime.
 */
type Slots<N extends number, T extends 0[] = []> = T["length"] extends N ? T : Slots<N, [...T, 0]>;
type Under<A extends number, B extends number> =
  Slots<B> extends [...Slots<A>, 0, ...0[]] ? true : false;
type Assert<T extends true> = T;
export type MailScanPageFitsInOneScan = Assert<
  Under<typeof MAIL_SCAN_PAGE, typeof MAX_MAIL_APPENDS_PER_SCAN>
>;

export interface MailScanPort {
  dir: string;
  accounts(): Promise<readonly { readonly accountId: string }[]>;
  inbox(accountId: string): Promise<readonly MailThreadListItem[]>;
  /** `false` when the centre did not keep the row: it already held the id, it
   *  refused the shape, or a full centre evicted it. */
  notify(notification: BrainNotification): Promise<boolean>;
  push(payload: { title: string; body?: string; href: string; tag?: string }): Promise<void>;
}

const PORT_MEMBERS = ["dir", "accounts", "inbox", "notify", "push"] as const;

async function defaultPort(): Promise<MailScanPort> {
  const [{ createBrainMailClient }, { sendPush }] = await Promise.all([
    import("@/lib/mail/brain-mail-client"),
    import("@/lib/push/send"),
  ]);
  const client = createBrainMailClient();
  return {
    dir: notificationStateDirectory(),
    accounts: async () => (await client.listAccounts()).accounts,
    inbox: async (accountId) =>
      (await client.listMailboxThreads(accountId, "inbox", { limit: MAIL_SCAN_PAGE })).items,
    notify: (notification) => appendNotification(notification),
    push: async (payload) => {
      await sendPush("mail-new", payload);
    },
  };
}

/** The real port is built only for the members the caller did not bring, the
 *  way the reminder scan resolves its own. A test that supplies all five gets
 *  exactly those five, and neither the mail socket nor the push keys is
 *  reached to run an arithmetic test. */
async function resolvePort(overrides: Partial<MailScanPort>): Promise<MailScanPort> {
  if (PORT_MEMBERS.every((member) => overrides[member] !== undefined)) {
    return overrides as MailScanPort;
  }
  return { ...(await defaultPort()), ...overrides };
}

/** SAID ONCE, NOT EVERY MINUTE. A mail service that is down stays down for
 *  hours, and a poll on a one-minute cadence would print the same line 60
 *  times an hour. Both flags clear on the next success, so a second outage is
 *  announced again. */
let outageAnnounced = false;
const unreachable = new Set<string>();

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export async function runMailScan(
  overrides: Partial<MailScanPort> = {},
): Promise<{ produced: number }> {
  const port = await resolvePort(overrides);

  let accounts: readonly { readonly accountId: string }[];
  try {
    accounts = await port.accounts();
  } catch (cause: unknown) {
    if (!outageAnnounced) {
      outageAnnounced = true;
      console.warn(
        `[brain/notifications] the mail service did not answer, so no new mail is reported: ${reason(cause)}`,
      );
    }
    return { produced: 0 };
  }
  outageAnnounced = false;
  if (accounts.length === 0) return { produced: 0 };

  const watermarks = await readMailWatermarks(port.dir);
  const at = new Date().toISOString();
  let produced = 0;
  let budget = MAX_MAIL_APPENDS_PER_SCAN;
  let refused = 0;
  let carried = 0;

  for (const account of accounts) {
    try {
      const items = await port.inbox(account.accountId);
      unreachable.delete(account.accountId);
      const result = newMailNotifications(items, watermarks[account.accountId] ?? null, at);

      // AN ACCOUNT IS REPORTED WHOLE OR NOT AT ALL. Reporting half a page and
      // moving the mark past the rest would lose the letters that did not fit,
      // because the mark is the only record of what was said. Leaving the mark
      // where it is costs one more tick and nothing else.
      if (result.notifications.length > budget) {
        carried += result.notifications.length;
        continue;
      }
      budget -= result.notifications.length;

      for (const notification of result.notifications) {
        const appended = await port.notify(notification);
        if (!appended) {
          refused += 1;
          continue;
        }
        produced += 1;
        await port
          .push({
            title: notification.title,
            ...(notification.body !== undefined ? { body: notification.body } : {}),
            href: notification.href,
            // The row's own id. Every mail row carries href "/mail", so a tag
            // built from the destination let the second letter of a poll
            // replace the first on the device.
            tag: notification.id,
          })
          .catch((cause: unknown) => {
            console.warn(`[brain/notifications] mail push failed: ${reason(cause)}`);
          });
      }

      // THE MARK GOES ON WHATEVER THE CENTRE ANSWERED. A row the centre would
      // not keep is a row it will not keep on the next tick either, and an
      // unmoved mark would offer it again every minute for as long as the
      // inbox held it.
      if (result.watermark !== null) {
        await writeMailWatermark(account.accountId, result.watermark, port.dir);
      }
    } catch (cause: unknown) {
      // One account's outage is not the poll's. The id is safe to name; the
      // address is not, and neither is the endpoint.
      if (!unreachable.has(account.accountId)) {
        unreachable.add(account.accountId);
        console.warn(
          `[brain/notifications] inbox poll failed for ${account.accountId}: ${reason(cause)}`,
        );
      }
    }
  }

  if (refused > 0) {
    console.warn(`[brain/notifications] the centre did not store ${refused} new-mail rows`);
  }
  if (carried > 0) {
    console.warn(
      `[brain/notifications] ${carried} new letters did not fit this scan; the next one takes them`,
    );
  }
  return { produced };
}
