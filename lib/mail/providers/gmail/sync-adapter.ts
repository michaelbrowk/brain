import type {
  MailAddress,
  MailMessageDto,
  MailThreadCategory,
  MailThreadListItem,
} from "../../message-types";
import { mailAddressesEquivalent } from "../../address-identity";
import type {
  MailCacheMailbox,
  CachedProviderMessage,
  CachedProviderThread,
} from "../../service/message-cache";
import {
  MailProviderSyncError,
  type MailProviderBatchOutcome,
  type MailProviderBatchThread,
  type MailProviderIncrementalPage,
  type MailProviderInitialPage,
  type MailProviderSyncPort,
} from "../../service/message-service";
import { GMAIL_BATCH_MODIFY_IDS, GmailApiClient } from "./api-client";
import { GmailApiError, type GmailMessage, type GmailMessagePart, type GmailThread } from "./api-types";

const MAX_TEXT_BODY_BYTES = 1024 * 1024;
const MAX_ADDRESS_HEADER_BYTES = 64 * 1024;
const MAX_ADDRESSES = 100;
const MAX_ADDRESS_BYTES = 320;
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_SUBJECT_BYTES = 998;
const MAX_SNIPPET_BYTES = 4 * 1024;
const MAX_MAILBOX_PAGE_ITEMS = 20;
const MAX_SYNC_MESSAGES = 500;
const MAX_SYNC_TEXT_BYTES = 32 * 1024 * 1024;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const HYDRATABLE_MAILBOXES = Object.freeze<
  readonly Exclude<MailCacheMailbox, "inbox">[]
>(["all", "sent", "spam", "starred", "trash"]);

export class GmailMailSyncAdapter implements MailProviderSyncPort {
  constructor(
    private readonly accountId: string,
    private readonly client: GmailApiClient,
  ) {
    if (!/^account-a[0-9a-f]{32}$/.test(accountId)) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
  }

  async getSyncAnchor(signal: AbortSignal): Promise<string> {
    try {
      return (await this.client.getProfile(signal)).historyId;
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async listInitialThreads(
    input: { readonly pageToken: string | null; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailProviderInitialPage> {
    try {
      const listed = await this.client.listInboxThreads(
        {
          ...(input.pageToken === null ? {} : { pageToken: input.pageToken }),
          maxItems: input.maxItems,
          maxPages: Math.min(20, Math.ceil(input.maxItems / 50)),
        },
        signal,
      );
      let messageCount = 0;
      let textBytes = 0;
      const threads = await boundedMap(listed.items, 2, async (summary) => {
        signal.throwIfAborted();
        const thread = await this.client.getThread(summary.id, signal);
        const cached = gmailThreadToCached(this.accountId, thread);
        messageCount += cached.messages.length;
        textBytes += cached.messages.reduce(
          (total, message) =>
            total +
            (message.textBody === null ? 0 : Buffer.byteLength(message.textBody)),
          0,
        );
        if (messageCount > MAX_SYNC_MESSAGES || textBytes > MAX_SYNC_TEXT_BYTES) {
          throw new MailProviderSyncError("mail_provider_response_invalid");
        }
        return cached;
      });
      return Object.freeze({
        threads: Object.freeze(threads),
        nextPageToken: listed.nextPageToken,
      });
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async listMailboxThreads(
    input: {
      readonly mailboxId: Exclude<MailCacheMailbox, "inbox">;
      readonly pageToken: string | null;
      readonly maxItems: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly threads: readonly CachedProviderThread[];
    readonly nextPageToken: string | null;
    readonly listedCount: number;
  }> {
    if (
      !HYDRATABLE_MAILBOXES.includes(input.mailboxId) ||
      !Number.isSafeInteger(input.maxItems) ||
      input.maxItems < 1 ||
      input.maxItems > MAX_MAILBOX_PAGE_ITEMS
    ) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    try {
      signal.throwIfAborted();
      const listed = await this.client.listThreads(
        input.mailboxId,
        {
          ...(input.pageToken === null ? {} : { pageToken: input.pageToken }),
          maxItems: input.maxItems,
          maxPages: 1,
        },
        signal,
      );
      let messageCount = 0;
      let textBytes = 0;
      const projected = await boundedMap(
        listed.items,
        2,
        async (summary): Promise<CachedProviderThread | null> => {
          signal.throwIfAborted();
          let thread: GmailThread;
          try {
            thread = await this.client.getThread(summary.id, signal);
          } catch (error) {
            if (error instanceof GmailApiError && error.code === "gmail_not_found") {
              return null;
            }
            throw error;
          }
          const cached = gmailThreadToCached(this.accountId, thread);
          messageCount += cached.messages.length;
          textBytes += cached.messages.reduce(
            (total, message) =>
              total +
              (message.textBody === null
                ? 0
                : Buffer.byteLength(message.textBody)),
            0,
          );
          if (
            messageCount > MAX_SYNC_MESSAGES ||
            textBytes > MAX_SYNC_TEXT_BYTES
          ) {
            throw new MailProviderSyncError("mail_provider_response_invalid");
          }
          return cached;
        },
      );
      return Object.freeze({
        threads: Object.freeze(
          projected.filter(
            (thread): thread is CachedProviderThread => thread !== null,
          ),
        ),
        nextPageToken: listed.nextPageToken,
        listedCount: listed.items.length,
      });
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async listChanges(
    input: {
      readonly startHistoryId: string;
      readonly pageToken: string | null;
      readonly maxItems: number;
    },
    signal: AbortSignal,
  ): Promise<MailProviderIncrementalPage> {
    try {
      const page = await this.client.listHistory(
        {
          startHistoryId: input.startHistoryId,
          ...(input.pageToken === null ? {} : { pageToken: input.pageToken }),
          maxItems: Math.min(50, input.maxItems),
        },
        signal,
      );
      const ids = new Set<string>();
      for (const history of page.items) {
        for (const message of history.messagesAdded) ids.add(message.threadId);
        for (const message of history.messagesDeleted) ids.add(message.threadId);
        for (const change of history.labelsAdded) ids.add(change.message.threadId);
        for (const change of history.labelsRemoved) ids.add(change.message.threadId);
      }
      return Object.freeze({
        changedThreadIds: Object.freeze([...ids]),
        nextPageToken: page.nextPageToken,
        resultingHistoryId: page.historyId,
      });
    } catch (error) {
      if (error instanceof GmailApiError && error.code === "gmail_not_found") {
        throw new MailProviderSyncError("mail_provider_cursor_invalid");
      }
      throw mapGmailError(error);
    }
  }

  async getThread(
    threadId: string,
    signal: AbortSignal,
  ): Promise<CachedProviderThread | null> {
    validateProviderId(threadId);
    try {
      return gmailThreadToCached(
        this.accountId,
        await this.client.getThread(threadId, signal),
      );
    } catch (error) {
      if (error instanceof GmailApiError && error.code === "gmail_not_found") {
        return null;
      }
      throw mapGmailError(error);
    }
  }

  async setThreadRead(
    threadId: string,
    read: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.client.markThreadRead(validateProviderId(threadId), read, signal);
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async archiveThread(threadId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.archiveThread(validateProviderId(threadId), signal);
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async unarchiveThread(threadId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.unarchiveThread(validateProviderId(threadId), signal);
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async trashThread(threadId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.trashThread(validateProviderId(threadId), signal);
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async restoreThread(threadId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.client.untrashThread(validateProviderId(threadId), signal);
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async setThreadSpam(
    threadId: string,
    spam: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const safeThreadId = validateProviderId(threadId);
      if (spam) {
        await this.client.markThreadSpam(safeThreadId, signal);
      } else {
        await this.client.markThreadNotSpam(safeThreadId, signal);
      }
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async setThreadStarred(
    threadId: string,
    starred: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const safeThreadId = validateProviderId(threadId);
      if (starred) {
        await this.client.starThread(safeThreadId, signal);
      } else {
        await this.client.unstarThread(safeThreadId, signal);
      }
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  /**
   * A section's Done in a fixed number of calls, whatever its size: one
   * `messages.batchModify` takes INBOX off every message the cache names, one
   * read of the change log since the cache's cursor says which of those
   * threads got a message the cache did not name (or lost one), and only
   * those are read back. With `read`, one more batchModify takes UNREAD off
   * the unread messages of the threads that got nothing new, and one more
   * read of the log catches a letter that landed in between. Fifteen threads
   * cost four calls where the per-thread path costs sixty.
   *
   * Naming messages is what makes the order safe: a reply that arrives after
   * the cache was read is not among the ids, so it stays in the Inbox and
   * unread whatever happens to the rest of its thread.
   *
   * A thread whose messages the cache cannot name is left to the per-thread
   * path, and so is the whole batch when Gmail will not take the ids (one was
   * deleted since). A change log that is gone, or longer than a few pages,
   * is replaced by a read of each thread.
   */
  async archiveThreads(
    input: {
      readonly threads: readonly MailProviderBatchThread[];
      readonly read: boolean;
      readonly cursor: string | null;
    },
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, MailProviderBatchOutcome>> {
    const outcomes = new Map<string, MailProviderBatchOutcome>();
    if (input.cursor === null) return outcomes;
    const cursor = input.cursor;
    const named = new Map<string, readonly { readonly messageId: string; readonly unread: boolean }[]>();
    for (const thread of input.threads) {
      if (
        thread.messages !== null &&
        thread.messages.length > 0 &&
        SAFE_PROVIDER_ID.test(thread.threadId) &&
        thread.messages.every((message) => SAFE_PROVIDER_ID.test(message.messageId))
      ) {
        named.set(thread.threadId, thread.messages);
      }
    }
    if (named.size === 0) return outcomes;

    const archived = await this.batchModifyThreads(named, () => true, ["INBOX"], signal);
    if (archived === "refused") return outcomes;
    for (const [threadId, error] of archived.failed) {
      outcomes.set(threadId, { status: "failed", error });
      named.delete(threadId);
    }
    if (named.size === 0) return outcomes;

    const renewed = await this.readBack(named, cursor, false, signal);
    if (renewed === null) {
      // The archive landed and nothing more can be learned in time.
      for (const [threadId, messages] of named) outcomes.set(threadId, applied(messages, false));
      return outcomes;
    }
    for (const [threadId, outcome] of renewed) {
      outcomes.set(threadId, outcome);
      named.delete(threadId);
    }

    const toRead = new Map(
      [...named].filter(([, messages]) => input.read && messages.some((message) => message.unread)),
    );
    for (const [threadId, messages] of named) {
      if (!toRead.has(threadId)) outcomes.set(threadId, applied(messages, false));
    }
    if (toRead.size === 0) return outcomes;

    const flagged = await this.batchModifyThreads(
      toRead,
      (message) => message.unread,
      ["UNREAD"],
      signal,
    );
    if (flagged === "refused") {
      for (const [threadId, messages] of toRead) outcomes.set(threadId, applied(messages, false));
      return outcomes;
    }
    for (const threadId of flagged.failed.keys()) {
      outcomes.set(threadId, applied(toRead.get(threadId)!, false));
      toRead.delete(threadId);
    }
    if (toRead.size === 0) return outcomes;
    const renewedAgain = (await this.readBack(toRead, cursor, true, signal)) ?? new Map();
    for (const [threadId, messages] of toRead) {
      outcomes.set(threadId, renewedAgain.get(threadId) ?? applied(messages, true));
    }
    return outcomes;
  }

  /**
   * One label off the chosen messages of these threads, in as few calls as
   * Gmail's ceiling allows, never splitting a thread across two. `refused`
   * when Gmail would not take the ids at all: nothing was changed, and the
   * caller hands the threads to the per-thread path.
   */
  private async batchModifyThreads(
    threads: ReadonlyMap<string, readonly { readonly messageId: string; readonly unread: boolean }[]>,
    choose: (message: { readonly messageId: string; readonly unread: boolean }) => boolean,
    removeLabelIds: readonly string[],
    signal: AbortSignal,
  ): Promise<"refused" | { readonly failed: ReadonlyMap<string, unknown> }> {
    const chunks: { threadIds: string[]; ids: string[] }[] = [];
    for (const [threadId, messages] of threads) {
      const ids = messages.filter(choose).map((message) => message.messageId);
      const last = chunks.at(-1);
      if (last !== undefined && last.ids.length + ids.length <= GMAIL_BATCH_MODIFY_IDS) {
        last.threadIds.push(threadId);
        last.ids.push(...ids);
      } else {
        chunks.push({ threadIds: [threadId], ids: [...ids] });
      }
    }
    const failed = new Map<string, unknown>();
    for (const [index, chunk] of chunks.entries()) {
      if (chunk.ids.length === 0) continue;
      try {
        signal.throwIfAborted();
        await this.client.batchModifyMessages(chunk.ids, [], removeLabelIds, signal);
      } catch (error) {
        if (
          index === 0 &&
          error instanceof GmailApiError &&
          (error.code === "gmail_not_found" || error.code === "gmail_request_invalid")
        ) {
          return "refused";
        }
        for (const threadId of chunk.threadIds) failed.set(threadId, mapGmailError(error));
      }
    }
    return { failed };
  }

  /**
   * Which of these threads changed beyond what the cache named since its
   * cursor, each read back from Gmail: a message added that is not among the
   * named ones, or one deleted. A change log that is gone or too long to read
   * now means every thread is read back. Null when the log could not be read
   * at all: the caller knows only what it sent.
   */
  private async readBack(
    threads: ReadonlyMap<string, readonly { readonly messageId: string; readonly unread: boolean }[]>,
    cursor: string,
    markedRead: boolean,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, MailProviderBatchOutcome> | null> {
    let changed: ReadonlySet<string>;
    try {
      changed = await this.changedSince(threads, cursor, signal);
    } catch {
      return null;
    }
    const outcomes = new Map<string, MailProviderBatchOutcome>();
    for (const threadId of changed) {
      try {
        const thread = await this.getThread(threadId, signal);
        if (thread === null) {
          outcomes.set(threadId, { status: "stale" });
          continue;
        }
        const named = new Set(threads.get(threadId)!.map((message) => message.messageId));
        if (
          thread.messages.length === named.size &&
          thread.messages.every((message) => named.has(message.messageId))
        ) {
          continue;
        }
        outcomes.set(threadId, { status: "done", thread, markedRead });
      } catch {
        // The archive is in; the thread's read back is not. What was sent
        // stands as the answer.
      }
    }
    return outcomes;
  }

  private async changedSince(
    threads: ReadonlyMap<string, readonly { readonly messageId: string; readonly unread: boolean }[]>,
    cursor: string,
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    const everyThread = new Set(threads.keys());
    const changed = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; page < BATCH_HISTORY_PAGES; page += 1) {
      let history;
      try {
        history = await this.client.listHistory(
          {
            startHistoryId: cursor,
            ...(pageToken === null ? {} : { pageToken }),
            types: ["messageAdded", "messageDeleted"],
          },
          signal,
        );
      } catch (error) {
        // The cursor is older than Gmail keeps: read every thread instead.
        if (error instanceof GmailApiError && error.code === "gmail_not_found") {
          return everyThread;
        }
        throw error;
      }
      for (const record of history.items) {
        for (const message of record.messagesAdded) {
          const named = threads.get(message.threadId);
          if (named !== undefined && !named.some((entry) => entry.messageId === message.id)) {
            changed.add(message.threadId);
          }
        }
        for (const message of record.messagesDeleted) {
          if (threads.has(message.threadId)) changed.add(message.threadId);
        }
      }
      pageToken = history.nextPageToken;
      if (pageToken === null) return changed;
    }
    return everyThread;
  }
}

/** How many pages of the change log a batch reads before it reads each
 *  thread instead: two hundred records of mail added or deleted since the
 *  cache's cursor. */
const BATCH_HISTORY_PAGES = 4;

function applied(
  messages: readonly { readonly messageId: string }[],
  markedRead: boolean,
): MailProviderBatchOutcome {
  return {
    status: "applied",
    messageIds: Object.freeze(messages.map((message) => message.messageId)),
    markedRead,
  };
}

export function gmailThreadToCached(
  accountId: string,
  source: GmailThread,
): CachedProviderThread {
  if (source.messages.length === 0) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  const messages = source.messages.map((message) =>
    gmailMessageToDto(accountId, message),
  );
  const selfAddresses = uniqueAddresses(
    messages.flatMap((message, index) =>
      source.messages[index]?.labelIds.includes("SENT") &&
      message.from !== null
        ? [message.from]
        : [],
    ),
  );
  const participants = uniqueAddresses(
    messages
      .flatMap((message, index) =>
        source.messages[index]?.labelIds.includes("SENT")
          ? [...message.to, ...message.cc]
          : message.from === null
            ? []
            : [message.from],
      )
      .filter(
        (address) =>
          !selfAddresses.some((self) =>
            mailAddressesEquivalent(address.address, self.address, "gmail"),
          ),
      ),
  );
  const lastMessage = [...messages].sort(compareMessages).at(-1)!;
  const subject = [...messages]
    .reverse()
    .find((message) => message.subject !== null)?.subject ?? null;
  const mailboxes = gmailThreadMailboxes(source);
  const thread: MailThreadListItem = Object.freeze({
    accountId,
    threadId: validateProviderId(source.id),
    subject,
    participants,
    // threads.get carries no thread-level snippet; the newest message's
    // snippet is the value Gmail shows for the thread row.
    snippet: truncateUtf8(source.snippet ?? lastMessage.snippet, MAX_SNIPPET_BYTES),
    lastMessageAt: lastMessage.sentAt,
    messageCount: messages.length,
    unread: messages.some((message) => message.unread),
    starred: mailboxes.includes("starred"),
    hasAttachments: messages.some((message) => message.hasAttachments),
    listMessage: messages.some((message) => message.listMessage),
    sizeBytes: messages.reduce(
      (total, message) => total + (message.sizeEstimate ?? 0),
      0,
    ),
    category: messages.some((message) => message.category === "newsletter")
      ? "newsletter"
      : messages.some((message) => message.category === "notification")
        ? "notification"
        : "people",
    newSender: false,
  });
  return Object.freeze({
    thread,
    messages: Object.freeze(messages),
    inInbox: messages.some((message) => message.inInbox),
    mailboxes,
  });
}

function gmailThreadMailboxes(source: GmailThread): readonly MailCacheMailbox[] {
  const mailboxes: MailCacheMailbox[] = [];
  const hasLabel = (label: string) =>
    source.messages.some((message) => message.labelIds.includes(label));

  // Gmail's All Mail excludes Spam and Trash at the message level. A thread is
  // visible there when at least one of its messages remains outside both.
  if (
    source.messages.some(
      (message) =>
        !message.labelIds.includes("SPAM") &&
        !message.labelIds.includes("TRASH"),
    )
  ) {
    mailboxes.push("all");
  }
  if (hasLabel("INBOX")) mailboxes.push("inbox");
  if (hasLabel("SENT")) mailboxes.push("sent");
  if (hasLabel("SPAM")) mailboxes.push("spam");
  if (
    source.messages.some(
      (message) =>
        !message.labelIds.includes("DRAFT") &&
        message.labelIds.includes("STARRED"),
    )
  ) {
    mailboxes.push("starred");
  }
  if (hasLabel("TRASH")) mailboxes.push("trash");

  return Object.freeze(mailboxes);
}

export function gmailMessageToDto(
  accountId: string,
  source: GmailMessage,
): CachedProviderMessage {
  const headers = source.payload?.headers ?? [];
  const from = parseFirstAddress(headerValue(headers, "from"));
  const replyTo = parseOptionalReplyTo(headerValue(headers, "reply-to"));
  const to = parseAddresses(headerValue(headers, "to"));
  const cc = parseAddresses(headerValue(headers, "cc"));
  const subject = boundedNullableHeader(
    headerValue(headers, "subject"),
    MAX_SUBJECT_BYTES,
  );
  const textBody = findTextBody(source.payload);
  const category = classifyMessageCategory({
    hasListId: headerValue(headers, "list-id") !== null,
    hasListUnsubscribe: headerValue(headers, "list-unsubscribe") !== null,
    precedence: headerValue(headers, "precedence"),
    autoSubmitted: headerValue(headers, "auto-submitted"),
    fromAddress: from?.address ?? null,
  });
  return Object.freeze({
    accountId,
    messageId: validateProviderId(source.id),
    threadId: validateProviderId(source.threadId),
    from,
    replyTo,
    to,
    cc,
    subject,
    sentAt: parseInternalDate(source.internalDate),
    unread: source.labelIds.includes("UNREAD"),
    inInbox: source.labelIds.includes("INBOX"),
    snippet: truncateUtf8(source.snippet, MAX_SNIPPET_BYTES),
    textBody,
    // Gmail HTML is intentionally not persisted until the isolated sanitizer
    // boundary from mail-architecture.md exists.
    htmlBody: null,
    hasAttachments: hasAttachment(source.payload),
    rfcMessageId: parseRfcMessageId(headerValue(headers, "message-id")),
    references: parseReferences(headerValue(headers, "references")),
    listMessage: category !== "people",
    category,
    sizeEstimate: source.sizeEstimate,
    // Presence is the whole question: a letter that names a parent answers
    // someone, and only one that names none can come from a new sender.
    isReply:
      headerValue(headers, "in-reply-to") !== null ||
      headerValue(headers, "references") !== null,
    fromOwner: source.labelIds.includes("SENT"),
  });
}

/**
 * Service local parts, matched against the whole local part after case-fold
 * and separator normalization: "-", ".", and "_" are stripped before the
 * test, so no-reply / no_reply / no.reply and customer-care / customer_service
 * fold to one token. The noreply and donotreply families match as prefixes
 * (noreply2, noreply-sales); every other name is an exact match. hi, contact,
 * and developer are deliberately excluded — those local parts are often real
 * humans. Same predicate as the IMAP adapter.
 */
const NOTIFICATION_SENDER_LOCAL_PART =
  /^(?:noreply|donotreply)|^(?:notifications?|notify|alerts?|mailerdaemon|postmaster|bounces?|support|help|helpdesk|team|info|news|newsletters?|updates?|digest|marketing|promo|promotions?|offers?|sales|billing|accounts?|security|admin|administrator|feedback|community|service|welcome|invoices?|receipts?|orders?|customercare|customerservice|hello|jobs|careers)$/i;
/**
 * Mailing-infrastructure subdomains: when the from domain has three or more
 * labels (i.e. it is a subdomain) and its first label matches, the sender is
 * automated (email.apple.com, news.anthropic.com, m1.example.com). Two-label
 * domains (apple.com, clay.com) never match. Same predicate as the IMAP
 * adapter.
 */
const NOTIFICATION_SENDER_SUBDOMAIN =
  /^(e?mail(er)?s?|e\d+|m\d+|em|mta\d*|news(letter)?s?|notification?s?|notify|marketing|updates?|info|bounces?|campaigns?|broadcasts?|digests?)$/i;

/**
 * A message is a newsletter when it carries a list header; else a notification
 * when it carries a bulk or list Precedence, any Auto-Submitted value other
 * than "no", or an automated sender (service local part or mailing
 * subdomain); else people mail. listMessage derives from this: any
 * non-"people" category is list mail. Same predicate as the IMAP adapter.
 */
function classifyMessageCategory(input: {
  readonly hasListId: boolean;
  readonly hasListUnsubscribe: boolean;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
  readonly fromAddress: string | null;
}): MailThreadCategory {
  if (input.hasListUnsubscribe || input.hasListId) return "newsletter";
  if (
    (input.precedence !== null &&
      /^(bulk|list)$/i.test(input.precedence.trim())) ||
    (input.autoSubmitted !== null &&
      !/^no(\s*;.*)?$/i.test(input.autoSubmitted.trim()))
  ) {
    return "notification";
  }
  if (input.fromAddress !== null && isNotificationSender(input.fromAddress)) {
    return "notification";
  }
  return "people";
}

/**
 * Automated-sender predicate over a full from address. Duplicated
 * byte-equivalently in the IMAP adapter and the cache category pre-seed.
 */
function isNotificationSender(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  if (
    NOTIFICATION_SENDER_LOCAL_PART.test(
      address.slice(0, at).replace(/[-._]/g, ""),
    )
  ) {
    return true;
  }
  const labels = address.slice(at + 1).split(".");
  return labels.length >= 3 && NOTIFICATION_SENDER_SUBDOMAIN.test(labels[0]!);
}

function headerValue(
  headers: GmailMessagePart["headers"],
  name: string,
): string | null {
  return headers.find((header) => header.name.toLowerCase() === name)?.value ?? null;
}

function boundedNullableHeader(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (Buffer.byteLength(normalized) > maxBytes || normalized.includes("\u0000")) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return normalized;
}

function truncateUtf8(value: string | null, maxBytes: number): string | null {
  if (value === null || Buffer.byteLength(value) <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function findTextBody(root: GmailMessagePart | null): string | null {
  if (root === null) return null;
  const queue: GmailMessagePart[] = [root];
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (
      part.mimeType?.toLowerCase() === "text/plain" &&
      part.body?.data !== null &&
      part.body?.data !== undefined &&
      hasSupportedPreviewTransferEncoding(part)
    ) {
      const bytes = Buffer.from(part.body.data, "base64url");
      try {
        if (
          bytes.length > MAX_TEXT_BODY_BYTES ||
          bytes.toString("base64url") !== part.body.data
        ) {
          throw new MailProviderSyncError("mail_provider_response_invalid");
        }
        const decoded = decodeTextPart(part, bytes).replaceAll("\u0000", "�");
        if (Buffer.byteLength(decoded) > MAX_TEXT_BODY_BYTES) {
          throw new MailProviderSyncError("mail_provider_response_invalid");
        }
        return decoded;
      } catch (error) {
        if (error instanceof MailProviderSyncError) throw error;
        throw new MailProviderSyncError("mail_provider_response_invalid");
      } finally {
        bytes.fill(0);
      }
    }
    queue.push(...part.parts);
  }
  return null;
}

function hasSupportedPreviewTransferEncoding(part: GmailMessagePart): boolean {
  const transferEncoding = headerValue(
    part.headers,
    "content-transfer-encoding",
  );
  if (transferEncoding === null) return true;
  return ["7bit", "8bit", "binary"].includes(
    transferEncoding.trim().toLowerCase(),
  );
}

function decodeTextPart(part: GmailMessagePart, bytes: Buffer): string {
  const contentType = part.headers.find(
    (header) => header.name.toLowerCase() === "content-type",
  )?.value;
  const rawCharset =
    contentType === undefined
      ? null
      : /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(
          contentType,
        )?.slice(1).find((value) => value !== undefined) ?? null;
  const charset =
    rawCharset !== null && /^[A-Za-z0-9._-]{1,40}$/.test(rawCharset)
      ? rawCharset
      : "utf-8";
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function hasAttachment(root: GmailMessagePart | null): boolean {
  if (root === null) return false;
  const queue: GmailMessagePart[] = [root];
  while (queue.length > 0) {
    const part = queue.shift()!;
    if (
      (part.filename !== null && part.filename.length > 0) ||
      part.body?.attachmentId !== null && part.body?.attachmentId !== undefined
    ) {
      return true;
    }
    queue.push(...part.parts);
  }
  return false;
}

function parseInternalDate(value: string | null): number | null {
  if (value === null || !/^\d{1,20}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseFirstAddress(value: string | null): MailAddress | null {
  return parseAddresses(value)[0] ?? null;
}

/**
 * Reply-To is optional and controlled by the sender. A malformed value must
 * not make an otherwise readable message poison every mailbox sync retry.
 * Falling back to From is safer than publishing a partly parsed recipient list.
 */
function parseOptionalReplyTo(value: string | null): readonly MailAddress[] {
  if (value === null || value.trim().length === 0) return Object.freeze([]);
  try {
    if (Buffer.byteLength(value) > MAX_ADDRESS_HEADER_BYTES) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    const tokens = splitAddressHeader(value);
    if (
      tokens.length === 0 ||
      tokens.length > MAX_ADDRESSES ||
      value.trimEnd().endsWith(",")
    ) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    const addresses: MailAddress[] = [];
    for (const token of tokens) {
      const address = parseAddressToken(token);
      if (address === null) {
        throw new MailProviderSyncError("mail_provider_response_invalid");
      }
      addresses.push(address);
    }
    return Object.freeze(addresses);
  } catch (error) {
    if (
      error instanceof MailProviderSyncError &&
      error.code === "mail_provider_response_invalid"
    ) {
      return Object.freeze([]);
    }
    throw error;
  }
}

function parseAddresses(value: string | null): readonly MailAddress[] {
  if (value === null) return Object.freeze([]);
  if (Buffer.byteLength(value) > MAX_ADDRESS_HEADER_BYTES) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  const tokens = splitAddressHeader(value);
  if (tokens.length > MAX_ADDRESSES) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return Object.freeze(
    tokens.flatMap((token) => {
      const address = parseAddressToken(token);
      return address === null ? [] : [address];
    }),
  );
}

function parseAddressToken(token: string): MailAddress | null {
  const match = /^(.*?)<([^<>]+)>$/.exec(token.trim());
  const address = (match?.[2] ?? token).trim().toLowerCase();
  if (!isMailboxAddress(address)) return null;
  const rawName = match?.[1].trim().replace(/^"|"$/g, "") ?? "";
  const name = rawName.length === 0 ? null : rawName;
  if (name !== null && Buffer.byteLength(name) > MAX_DISPLAY_NAME_BYTES) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return Object.freeze({ name, address });
}

function splitAddressHeader(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angleDepth += 1;
    if (!quoted && char === ">") angleDepth -= 1;
    if (angleDepth < 0 || angleDepth > 1) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    if (char === "," && !quoted && angleDepth === 0) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted || angleDepth !== 0 || escaped) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  if (current.trim().length > 0) result.push(current);
  return result;
}

function isMailboxAddress(value: string): boolean {
  return (
    Buffer.byteLength(value) <= MAX_ADDRESS_BYTES &&
    /^[^@\s<>]+@[^@.\s<>]+(?:\.[^@.\s<>]+)+$/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function uniqueAddresses(values: readonly MailAddress[]): readonly MailAddress[] {
  const seen = new Set<string>();
  return Object.freeze(
    values.filter((value) => {
      const key = value.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

function parseRfcMessageId(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim();
  return /^<[^<>\s\u0000-\u001f\u007f]+>$/.test(normalized) &&
    Buffer.byteLength(normalized) <= 998
    ? normalized
    : null;
}

function parseReferences(value: string | null): readonly string[] {
  if (value === null || Buffer.byteLength(value) > 64 * 1024) {
    return Object.freeze([]);
  }
  const matches = value.match(/<[^<>\s\u0000-\u001f\u007f]+>/g) ?? [];
  if (matches.length > 100) return Object.freeze([]);
  const unique = [...new Set(matches.filter((entry) => Buffer.byteLength(entry) <= 998))];
  return Object.freeze(unique.length === matches.length ? unique : []);
}

function compareMessages(a: MailMessageDto, b: MailMessageDto): number {
  return (a.sentAt ?? -1) - (b.sentAt ?? -1) || a.messageId.localeCompare(b.messageId);
}

function validateProviderId(value: string): string {
  if (!SAFE_PROVIDER_ID.test(value)) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return value;
}

function mapGmailError(error: unknown): MailProviderSyncError {
  if (error instanceof MailProviderSyncError) return error;
  if (!(error instanceof GmailApiError)) {
    return new MailProviderSyncError("mail_provider_unavailable");
  }
  if (error.code === "gmail_reauth_required") {
    return new MailProviderSyncError("mail_provider_reauth_required");
  }
  if (error.code === "gmail_rate_limited") {
    return new MailProviderSyncError(
      "mail_provider_rate_limited",
      error.retryAfterMs,
    );
  }
  if (error.code === "gmail_response_invalid") {
    return new MailProviderSyncError("mail_provider_response_invalid");
  }
  return new MailProviderSyncError(
    "mail_provider_unavailable",
    error.retryAfterMs,
  );
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= values.length) return;
        result[index] = await operation(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return result;
}
