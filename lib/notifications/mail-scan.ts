import type { MailThreadListItem } from "@/lib/mail/message-types";
import { MAIL_SCAN_PAGE, newMailLetters, type NewMailLetter } from "./mail-producer";
import { countedMailRow, mailRow, openMailRow, type OpenMailRow } from "./mail-rows";
import type { BrainNotification } from "./model";
import { notificationStateDirectory } from "./state-dir";
import { appendOrFoldNotification, listNotifications } from "./store";
import { readMailWatermarks, writeMailWatermark } from "./watermarks";

/** THE NEW-MAIL POLL.
 *
 *  The mail service is a separate process (ops/brain-mail.service) and emits
 *  nothing into this one: app/api/events/route.ts streams the store's own
 *  events and no mail event exists. So the producer polls one Inbox page per
 *  account against a per-account high-water mark, on every second tick of the
 *  reminder timer, which is once a minute.
 *
 *  Nothing here logs an address or an endpoint. A poll that cannot reach the
 *  service raises no alarm of its own: the Mail surface already says so where
 *  a reader can act on it.
 */

/** ONE WRITE PER SCAN, WHATEVER THE MORNING BROUGHT. The centre took one row
 *  per thread until 0.12.2 and one scan's appends were capped at fifty, because
 *  every append takes a slot in the 256-entry SSE replay journal. A scan writes
 *  one row now — it opens one or counts into the open one — so there is nothing
 *  left to cap and nothing to carry to the next tick. What a busy account costs
 *  is its pushes, which are one per letter and bounded by the page. */

export interface MailScanPort {
  dir: string;
  accounts(): Promise<readonly { readonly accountId: string }[]>;
  inbox(accountId: string): Promise<readonly MailThreadListItem[]>;
  /** The row this scan counts into, or `null` when the next letter opens one.
   *  Read before the write and re-checked under the store's own lock, so a row
   *  read in between is not written back under the reader. */
  openMailRow(): Promise<OpenMailRow | null>;
  notify(
    row: BrainNotification,
    folded: BrainNotification | null,
  ): Promise<"appended" | "folded" | "refused">;
  push(payload: { title: string; body?: string; href: string; tag?: string }): Promise<void>;
}

const PORT_MEMBERS = ["dir", "accounts", "inbox", "openMailRow", "notify", "push"] as const;

function defaultPort(dir: string): Promise<MailScanPort> {
  return Promise.all([
    import("@/lib/mail/brain-mail-client"),
    import("@/lib/push/send"),
  ]).then(([{ createBrainMailClient }, { sendPush }]) => {
    const client = createBrainMailClient();
    return {
      dir,
      accounts: async () => (await client.listAccounts()).accounts,
      inbox: async (accountId) =>
        (await client.listMailboxThreads(accountId, "inbox", { limit: MAIL_SCAN_PAGE })).items,
      openMailRow: async () => openMailRow(await listNotifications(dir)),
      notify: (row, folded) => appendOrFoldNotification(row, folded, dir),
      push: async (payload) => {
        await sendPush("mail-new", payload);
      },
    };
  });
}

/** The real port is built only for the members the caller did not bring, the
 *  way the reminder scan resolves its own. A test that supplies all six gets
 *  exactly those six, and neither the mail socket nor the push keys is
 *  reached to run an arithmetic test. A test that brings only `dir` gets the
 *  real centre at that directory, which is where the fold is decided. */
async function resolvePort(overrides: Partial<MailScanPort>): Promise<MailScanPort> {
  if (PORT_MEMBERS.every((member) => overrides[member] !== undefined)) {
    return overrides as MailScanPort;
  }
  const dir = overrides.dir ?? notificationStateDirectory();
  return { ...(await defaultPort(dir)), ...overrides };
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
  const letters: NewMailLetter[] = [];

  for (const account of accounts) {
    try {
      const items = await port.inbox(account.accountId);
      unreachable.delete(account.accountId);
      const result = newMailLetters(items, watermarks[account.accountId] ?? null, at);
      // EVERY ACCOUNT INTO ONE COUNT. The row is not about an account and the
      // reader does not sort their morning by mailbox: three letters in two
      // inboxes is "3 new messages".
      letters.push(...result.letters);

      // THE MARK GOES ON WHATEVER THE CENTRE ANSWERED. A row the centre would
      // not keep is a row it will not keep on the next tick either, and an
      // unmoved mark would offer the same letters again every minute for as
      // long as the inbox held them.
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

  if (letters.length === 0) return { produced: 0 };

  // The newest letter dates the row, so the bell rises to the head on the
  // letter that arrived rather than on the poll that found it.
  let newest = letters[0].at;
  for (const letter of letters) if (letter.at > newest) newest = letter.at;

  // A row already open takes the count; a row the reader has read does not,
  // and the letters open a new one under the newest instant. The store decides
  // which under its own lock: `held` may have been read in the meantime.
  const held = await port.openMailRow();
  const done = await port.notify(
    mailRow(newest, letters.length, newest),
    held === null
      ? null
      : countedMailRow(held.id, held.count + letters.length, held.at > newest ? held.at : newest),
  );
  if (done === "refused") {
    console.warn(`[brain/notifications] the centre did not count ${letters.length} new letters`);
  }

  // THE PUSH GOES WHATEVER THE CENTRE DID. It is one per letter, it carries
  // the sender and the subject, and it is the phone's whole signal: a tally
  // the store could not write is not a reason to leave a person unaware that
  // their mail arrived.
  for (const letter of letters) {
    await port
      .push({
        title: letter.title,
        body: letter.body,
        href: "/mail",
        ...(letter.tag !== undefined ? { tag: letter.tag } : {}),
      })
      .catch((cause: unknown) => {
        console.warn(`[brain/notifications] mail push failed: ${reason(cause)}`);
      });
  }

  return { produced: done === "refused" ? 0 : letters.length };
}
