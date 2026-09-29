import type { MailSystemMailbox } from "./message-types";

/** THE MAIL EVENT, FROM THE SERVICE'S CHANGE FEED TO AN OPEN TAB.
 *
 *  Brain's loop (`change-feed.ts`) reads the mail service's feed and emits one
 *  of these per account and kind in each answer; `app/api/events/route.ts`
 *  streams it as an SSE `mail` event; the shell hands it to the Mail surface
 *  and the reader as a window event. This module is the seam all three share,
 *  so it has no runtime dependency and is safe in either bundle.
 *
 *  `reset` names no account: something was lost (the service restarted, the
 *  loop fell behind its ring, or the tab's own stream reconnected), and the
 *  answer to a loss is to read everything on screen again once.
 *
 *  Mail events are not in the store's replay journal. A tab that reconnects
 *  cannot be replayed what it missed, so it treats the reconnect as a reset.
 */
export type BrainMailChangeKind = "sync" | "mutation" | "content_ready";

export type BrainMailEvent =
  | {
      readonly kind: "mail";
      readonly changeKind: BrainMailChangeKind;
      readonly accountId: string;
      readonly mailboxIds: readonly MailSystemMailbox[];
      /** Only on `content_ready`: the messages whose bodies are ready now. */
      readonly messageIds?: readonly string[];
    }
  | { readonly kind: "mail"; readonly changeKind: "reset" };

/** The window event the shell dispatches for each SSE `mail` event, and for
 *  a reconnect of the stream itself, which it sends as a `reset`. */
export const MAIL_CHANGED_EVENT = "brain:mail-changed";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const MAILBOXES: ReadonlySet<string> = new Set<MailSystemMailbox>([
  "inbox",
  "all",
  "sent",
  "starred",
  "spam",
  "trash",
]);
const MAX_MESSAGE_IDS = 256;

/** What an SSE `mail` event's data says, or `null` for anything else. The
 *  stream is Brain's own, but a malformed event must cost a tab one refresh
 *  it did not need, never a thrown handler. */
export function parseBrainMailEvent(value: unknown): BrainMailEvent | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "mail") return null;
  if (record.changeKind === "reset") return { kind: "mail", changeKind: "reset" };
  if (
    (record.changeKind !== "sync" &&
      record.changeKind !== "mutation" &&
      record.changeKind !== "content_ready") ||
    typeof record.accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(record.accountId) ||
    !Array.isArray(record.mailboxIds) ||
    !record.mailboxIds.every(
      (mailboxId): mailboxId is MailSystemMailbox =>
        typeof mailboxId === "string" && MAILBOXES.has(mailboxId),
    )
  ) {
    return null;
  }
  if (record.changeKind !== "content_ready") {
    return {
      kind: "mail",
      changeKind: record.changeKind,
      accountId: record.accountId,
      mailboxIds: record.mailboxIds,
    };
  }
  if (
    !Array.isArray(record.messageIds) ||
    record.messageIds.length > MAX_MESSAGE_IDS ||
    !record.messageIds.every(
      (messageId): messageId is string =>
        typeof messageId === "string" && SAFE_MESSAGE_ID.test(messageId),
    )
  ) {
    return null;
  }
  return {
    kind: "mail",
    changeKind: "content_ready",
    accountId: record.accountId,
    mailboxIds: record.mailboxIds,
    messageIds: record.messageIds,
  };
}
