import type {
  FetchMessageObject,
  MailboxObject,
  MessageAddressObject,
  MessageStructureObject,
} from "imapflow";

import type {
  MailAddress,
  MailThreadCategory,
  MailThreadListItem,
} from "../../message-types";
import type { MailIncomingBlobStorePort } from "../../ports";
import { MAIL_RESOURCE_LIMITS } from "../../security";
import {
  MailContentSourceError,
  type MailContentSourceFetchInput,
  type MailContentSourceFetchResult,
  type MailContentSourcePort,
} from "../../service/content-source";
import type {
  CachedProviderMessage,
  CachedProviderThread,
  MailCacheHydratableMailbox,
} from "../../service/message-cache";
import {
  MailProviderSyncError,
  type MailProviderIncrementalPage,
  type MailProviderInitialPage,
  type MailProviderSyncPort,
} from "../../service/message-service";
import {
  MailAccountError,
  type StoredImapMailAccount,
} from "../../service/account-types";
import {
  MAX_IMAP_READ_LITERAL_BYTES,
  type ImapSessionClient,
} from "../../service/imapflow-adapter";

const MAX_PAGE_ITEMS = 20;
const MAX_INITIAL_MESSAGES = 200;
const MAX_LIST_HEADER_BYTES = 32 * 1024;
const FULL_REBUILD_AFTER_CYCLES = 10;
const MAX_UID_COMPONENT = 0xffff_ffff;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const COMPONENT_BITS = BigInt(32);
const CYCLE_BITS = BigInt(4);
const COMPONENT_MASK = (BIGINT_ONE << COMPONENT_BITS) - BIGINT_ONE;
const CYCLE_MASK = (BIGINT_ONE << CYCLE_BITS) - BIGINT_ONE;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_MESSAGE_ID = /^i([1-9][0-9]{0,9})u([1-9][0-9]{0,9})$/;
const MAX_ABORT_TIMEOUT_MS = 0x7fff_ffff;
// One BODY.PEEK[]<start.length> literal per round trip. The read session
// rejects any literal above its cap, so a raw message is streamed in bounded
// slices instead of one provider-sized buffer.
const RAW_SOURCE_CHUNK_BYTES = MAX_IMAP_READ_LITERAL_BYTES;
const INBOX_PATH = "INBOX";
/**
 * How many relocated threads one adapter instance remembers. A relocation is
 * only needed until the next full Inbox rebuild drops the moved thread, so this
 * bound covers an undo of one section Done and then some.
 */
const MAX_TRACKED_RELOCATIONS = 256;
/**
 * RFC 6851. The one command that relocates a message without a chance of
 * losing it, and the only one this adapter will use — see `assertMoveSupported`
 * for why ImapFlow's emulation of it is refused rather than accepted.
 */
const MOVE_CAPABILITY = "MOVE";

export interface ImapReadSessions {
  withSession<T>(
    expected: StoredImapMailAccount,
    signal: AbortSignal,
    operation: (client: ImapSessionClient) => Promise<T>,
  ): Promise<T>;
}

/**
 * Where one Brain thread's message currently lives. Absent from the relocation
 * map means the Inbox at the UID its thread id encodes, which is true for every
 * thread this adapter has not moved.
 */
interface ThreadLocation {
  readonly path: string;
  readonly uidValidity: bigint;
  readonly uid: number;
}

interface ImapAnchor {
  readonly uidValidity: bigint;
  readonly uidNext: number;
  readonly exists: number;
  readonly cycle: number;
}

interface InitialPageToken {
  readonly uidValidity: bigint;
  readonly snapshotUidNext: number;
  readonly snapshotExists: number;
  readonly nextEndSequence: number;
  readonly minimumSequence: number;
  readonly exclusiveUpperUid: number;
}

interface ChangePageToken {
  readonly uidValidity: bigint;
  readonly startUidNext: number;
  readonly startExists: number;
  readonly targetUidNext: number;
  readonly targetExists: number;
  readonly nextUid: number;
  readonly nextCycle: number;
}

/**
 * Custom-domain receive and thread mutation. It publishes a bounded Inbox
 * metadata window and deliberately models each IMAP message as its own Brain
 * thread, so a thread mutation is a mutation of exactly one message. Raw
 * message bodies are fetched separately by ImapContentSourceAdapter below.
 * Conversation grouping and non-Inbox listing are separate follow-up slices.
 *
 * `\Seen` and `\Flagged` are set in place. Archive, trash and junk are a MOVE
 * to a discovered mailbox, which changes the message's UID, so this adapter
 * remembers where it put a thread for as long as it lives.
 *
 * The Inbox listing repairs itself without that memory — a MOVE shrinks the
 * Inbox, the next incremental sync sees a lower EXISTS, rejects its cursor, and
 * the full rebuild that follows does not list the moved message any more. Undo
 * does not. It needs the handle, so a runtime restart between the archive and
 * the press leaves the message in a folder Brain does not yet list, with no way
 * back from here. The window the surface offers is seconds long and this map is
 * the only record of where the message went, so the hole is narrow and real: a
 * durable relocation record is what closes it.
 */
export class ImapMailSyncAdapter implements MailProviderSyncPort {
  private readonly account: StoredImapMailAccount;
  private readonly sessions: ImapReadSessions;
  private readonly pending = new Map<string, CachedProviderThread>();
  private readonly relocations = new Map<string, ThreadLocation>();
  private mailboxRoles: ReadonlyMap<ImapMailboxRole, string | null> | null = null;

  constructor(
    account: StoredImapMailAccount,
    sessions: ImapReadSessions,
  ) {
    if (
      account.providerKind !== "imap" ||
      !SAFE_ACCOUNT_ID.test(account.account.accountId)
    ) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    this.account = account;
    this.sessions = sessions;
  }

  async getSyncAnchor(signal: AbortSignal): Promise<string> {
    return this.run(signal, (client) =>
      withInbox(client, async (mailbox) => encodeAnchor(mailbox, 0)),
    );
  }

  async listInitialThreads(
    input: { readonly pageToken: string | null; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailProviderInitialPage> {
    const maxItems = validatePageSize(input.maxItems);
    const parsedToken =
      input.pageToken === null ? null : parseInitialPageToken(input.pageToken);
    return this.run(signal, (client) =>
      withInbox(client, async (mailbox) => {
        const uidValidity = validateUidValidity(mailbox.uidValidity);
        const currentUidNext = validateUid(mailbox.uidNext);
        const currentExists = validateExists(mailbox.exists);
        if (
          parsedToken !== null &&
          (parsedToken.uidValidity !== uidValidity ||
            currentUidNext < parsedToken.snapshotUidNext ||
            currentExists < parsedToken.nextEndSequence)
        ) {
          throw new MailProviderSyncError("mail_provider_cursor_invalid");
        }
        const token: InitialPageToken =
          parsedToken ??
          Object.freeze({
            uidValidity,
            snapshotUidNext: currentUidNext,
            snapshotExists: currentExists,
            nextEndSequence: currentExists,
            minimumSequence: Math.max(
              1,
              currentExists - MAX_INITIAL_MESSAGES + 1,
            ),
            exclusiveUpperUid: currentUidNext,
          });
        if (token.nextEndSequence === 0) {
          return Object.freeze({ threads: Object.freeze([]), nextPageToken: null });
        }
        const startSequence = Math.max(
          token.minimumSequence,
          token.nextEndSequence - maxItems + 1,
        );
        const messages = await client.fetchAll(
          `${startSequence}:${token.nextEndSequence}`,
          metadataFetchQuery(),
        );
        assertInitialPageSnapshot(messages, {
          startSequence,
          endSequence: token.nextEndSequence,
          exclusiveUpperUid: token.exclusiveUpperUid,
        });
        const threads = messages.map((message) =>
          imapMessageToCached(this.account.account.accountId, uidValidity, message),
        );
        assertUniqueThreads(threads);
        const nextEndSequence = startSequence - 1;
        const exclusiveUpperUid = validateUid(messages[0]!.uid);
        const nextPageToken =
          nextEndSequence >= token.minimumSequence
            ? encodeInitialPageToken({
                ...token,
                nextEndSequence,
                exclusiveUpperUid,
              })
            : null;
        return Object.freeze({
          threads: Object.freeze(threads),
          nextPageToken,
        });
      }),
    );
  }

  async listMailboxThreads(
    input: {
      readonly mailboxId: MailCacheHydratableMailbox;
      readonly pageToken: string | null;
      readonly maxItems: number;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly threads: readonly CachedProviderThread[];
    readonly nextPageToken: string | null;
    readonly listedCount: number;
  }> {
    void input;
    void signal;
    throw new MailProviderSyncError("mail_provider_unavailable");
  }

  async listChanges(
    input: {
      readonly startHistoryId: string;
      readonly pageToken: string | null;
      readonly maxItems: number;
    },
    signal: AbortSignal,
  ): Promise<MailProviderIncrementalPage> {
    const maxItems = validatePageSize(input.maxItems);
    const start = parseAnchor(input.startHistoryId);
    const continuation =
      input.pageToken === null ? null : parseChangePageToken(input.pageToken);
    return this.run(signal, (client) =>
      withInbox(client, async (mailbox) => {
        const current: Omit<ImapAnchor, "cycle"> = Object.freeze({
          uidValidity: validateUidValidity(mailbox.uidValidity),
          uidNext: validateUid(mailbox.uidNext),
          exists: validateExists(mailbox.exists),
        });
        if (
          current.uidValidity !== start.uidValidity ||
          current.uidNext < start.uidNext ||
          current.exists < start.exists ||
          start.cycle >= FULL_REBUILD_AFTER_CYCLES - 1
        ) {
          throw new MailProviderSyncError("mail_provider_cursor_invalid");
        }
        const token: ChangePageToken =
          continuation ??
          Object.freeze({
            uidValidity: start.uidValidity,
            startUidNext: start.uidNext,
            startExists: start.exists,
            targetUidNext: current.uidNext,
            targetExists: current.exists,
            nextUid: start.uidNext,
            nextCycle: start.cycle + 1,
          });
        assertChangeTokenMatches(token, start, current);
        const endUid = Math.min(
          token.targetUidNext - 1,
          token.nextUid + maxItems - 1,
        );
        const messages =
          token.nextUid >= token.targetUidNext
            ? []
            : await client.fetchAll(
                `${token.nextUid}:${endUid}`,
                metadataFetchQuery(),
                { uid: true },
              );
        if (messages.length > maxItems) {
          throw new MailProviderSyncError("mail_provider_response_invalid");
        }
        assertIncrementalUidRange(messages, token.nextUid, endUid);
        const threads = messages.map((message) =>
          imapMessageToCached(
            this.account.account.accountId,
            token.uidValidity,
            message,
          ),
        );
        assertUniqueThreads(threads);
        this.pending.clear();
        for (const thread of threads) {
          this.pending.set(thread.thread.threadId, thread);
        }
        const nextUid = endUid + 1;
        const hasMore = nextUid < token.targetUidNext;
        return Object.freeze({
          changedThreadIds: Object.freeze(
            threads.map((thread) => thread.thread.threadId),
          ),
          nextPageToken: hasMore
            ? encodeChangePageToken({ ...token, nextUid })
            : null,
          resultingHistoryId: encodeAnchorParts({
            uidValidity: token.uidValidity,
            uidNext: token.targetUidNext,
            exists: token.targetExists,
            cycle: token.nextCycle,
          }),
        });
      }),
    );
  }

  async getThread(
    threadId: string,
    signal: AbortSignal,
  ): Promise<CachedProviderThread | null> {
    const pending = this.pending.get(threadId);
    if (pending) {
      this.pending.delete(threadId);
      return pending;
    }
    const location = this.locate(threadId);
    return this.run(signal, (client) =>
      withMailbox(client, location.path, true, async (mailbox) => {
        if (validateUidValidity(mailbox.uidValidity) !== location.uidValidity) {
          return null;
        }
        const message = await fetchOne(client, location.uid);
        if (message === null) return null;
        return this.project(threadId, location, message);
      }),
    );
  }

  async setThreadRead(
    threadId: string,
    read: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    await this.storeFlag(threadId, "\\Seen", read, signal);
  }

  async setThreadStarred(
    threadId: string,
    starred: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    await this.storeFlag(threadId, "\\Flagged", starred, signal);
  }

  async archiveThread(threadId: string, signal: AbortSignal): Promise<void> {
    await this.moveThread(threadId, "archive", signal);
  }

  async unarchiveThread(threadId: string, signal: AbortSignal): Promise<void> {
    await this.moveThread(threadId, "inbox", signal);
  }

  async trashThread(threadId: string, signal: AbortSignal): Promise<void> {
    await this.moveThread(threadId, "trash", signal);
  }

  async restoreThread(threadId: string, signal: AbortSignal): Promise<void> {
    await this.moveThread(threadId, "inbox", signal);
  }

  async setThreadSpam(
    threadId: string,
    spam: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    await this.moveThread(threadId, spam ? "junk" : "inbox", signal);
  }

  /** `\Seen` and `\Flagged` are set where the message already is. */
  private async storeFlag(
    threadId: string,
    flag: string,
    present: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const location = this.locate(threadId);
    await this.run(signal, (client) =>
      withMailbox(client, location.path, false, async (mailbox) => {
        this.assertUidValidity(mailbox, location);
        assertFlagStorable(mailbox, flag, present);
        const stored = present
          ? await client.messageFlagsAdd([location.uid], [flag], { uid: true })
          : await client.messageFlagsRemove([location.uid], [flag], { uid: true });
        if (stored !== true) {
          throw new MailProviderSyncError("mail_provider_unavailable");
        }
        const message = await fetchOne(client, location.uid);
        if (message === null) throw staleThread();
        this.pending.set(threadId, this.project(threadId, location, message));
      }),
    );
  }

  /**
   * One MOVE between the Inbox and a discovered mailbox. The message metadata
   * is read before the move, both because the projection needs it and because
   * a server without UIDPLUS reports no destination UID — its Message-ID is
   * then the only handle left for finding the message again.
   */
  private async moveThread(
    threadId: string,
    destination: ImapMailboxRole | "inbox",
    signal: AbortSignal,
  ): Promise<void> {
    const location = this.locate(threadId);
    if (destination !== "inbox" && this.roleRefusedFromCache(destination)) {
      // LIST has already answered for this account and the answer was no. A
      // session spent to repeat it is a TCP connect, a TLS handshake and an
      // AUTH for a refusal that is already known, and a section Done is that
      // once per thread.
      throw new MailProviderSyncError("mail_provider_mutation_unsupported");
    }
    await this.run(signal, async (client) => {
      const target =
        destination === "inbox"
          ? INBOX_PATH
          : await this.rolePath(client, destination);
      if (samePath(target, location.path)) {
        // Already where the caller asked for. Re-read so the refreshed thread
        // still reports the truth, and touch nothing on the server.
        await withMailbox(client, location.path, true, async (mailbox) => {
          this.assertUidValidity(mailbox, location);
          const message = await fetchOne(client, location.uid);
          if (message === null) throw staleThread();
          this.pending.set(threadId, this.project(threadId, location, message));
        });
        return;
      }
      // Everything below this line relocates a message, so the server has to
      // be able to relocate one. Nothing above it touched the mailbox.
      assertMoveSupported(client);
      const moved = await withMailbox(
        client,
        location.path,
        false,
        async (mailbox) => {
          this.assertUidValidity(mailbox, location);
          const message = await fetchOne(client, location.uid);
          if (message === null) throw staleThread();
          let result: Awaited<ReturnType<ImapSessionClient["messageMove"]>>;
          try {
            result = await client.messageMove([location.uid], target, {
              uid: true,
            });
          } catch (error) {
            this.mailboxRoles = null;
            throw mapImapProviderError(error);
          }
          if (result === false || result === null || result === undefined) {
            // The server answered the MOVE with NO, which ImapFlow reports as
            // false. LIST named the folder and the server still would not put
            // a message in it — its layout or its ACLs, as true on the next
            // press as on this one — so it is the same refusal as having no
            // folder at all, not an outage. Nothing moved: the account stays
            // exactly as the caller found it, and LIST is asked again next
            // time in case the layout is what changed.
            this.mailboxRoles = null;
            throw new MailProviderSyncError("mail_provider_mutation_unsupported");
          }
          return Object.freeze({ message, result });
        },
      );
      const landed = await this.locateMoved(client, target, location, moved.result, moved.message);
      if (landed === null) {
        // The move happened and the destination UID is unknowable on this
        // server. Report the new home without a handle, and forget the old
        // one so no later mutation writes to a UID that is no longer there.
        this.relocations.delete(threadId);
        this.pending.set(
          threadId,
          this.projectAt(threadId, target, moved.message, null),
        );
        return;
      }
      this.remember(threadId, landed);
      this.pending.set(threadId, this.project(threadId, landed, moved.message));
    });
  }

  /**
   * The destination UID, from UIDPLUS when the server offers it and from a
   * Message-ID search when it does not. Null means the move is done but the
   * message can no longer be addressed.
   */
  private async locateMoved(
    client: ImapSessionClient,
    target: string,
    source: ThreadLocation,
    result: { readonly uidValidity?: bigint; readonly uidMap?: Map<number, number> },
    message: FetchMessageObject,
  ): Promise<ThreadLocation | null> {
    const mappedUid = result.uidMap?.get(source.uid);
    if (
      result.uidValidity !== undefined &&
      mappedUid !== undefined &&
      Number.isSafeInteger(mappedUid)
    ) {
      return Object.freeze({
        path: target,
        uidValidity: validateUidValidity(result.uidValidity),
        uid: validateUid(mappedUid),
      });
    }
    const messageId = boundedMessageId(message.envelope?.messageId);
    if (messageId === null) return null;
    return withMailbox(client, target, true, async (mailbox) => {
      const uids = await client.search(
        { header: { "message-id": messageId } },
        { uid: true },
      );
      // Exactly one hit, or no handle at all. A Message-ID is not unique
      // inside a mailbox — the same letter filed twice, a list copy beside the
      // direct one, a resend — and picking one of several means the next undo
      // returns a different message to the Inbox than the one that left it.
      // On a server without UIDPLUS this search is the only path there is, so
      // the ambiguity is the ordinary case rather than a corner of one.
      if (uids === false || !Array.isArray(uids) || uids.length !== 1) return null;
      return Object.freeze({
        path: target,
        uidValidity: validateUidValidity(mailbox.uidValidity),
        uid: validateUid(uids[0]!),
      });
    });
  }

  /**
   * Which server mailbox plays a role. LIST is issued once per session-backed
   * adapter and the answer is cached until a move fails, because a failing move
   * is the one signal that the folder layout is not what LIST said it was.
   */
  private async rolePath(
    client: ImapSessionClient,
    role: ImapMailboxRole,
  ): Promise<string> {
    if (this.mailboxRoles === null) {
      let listed: unknown;
      try {
        listed = await client.list();
      } catch (error) {
        throw mapImapProviderError(error);
      }
      if (!isSupportedMailboxList(listed)) {
        throw new MailProviderSyncError("mail_provider_response_invalid");
      }
      this.mailboxRoles = new Map<ImapMailboxRole, string | null>([
        ["archive", selectImapMailboxPath("archive", listed)],
        ["trash", selectImapMailboxPath("trash", listed)],
        ["junk", selectImapMailboxPath("junk", listed)],
      ]);
    }
    const path = this.mailboxRoles.get(role) ?? null;
    if (path === null) {
      // The server offers no mailbox for this role. Refusing is the honest
      // answer; inventing a destination would move the owner's mail somewhere
      // no mail client will look for it.
      throw new MailProviderSyncError("mail_provider_mutation_unsupported");
    }
    return path;
  }

  /**
   * Whether LIST has already run on this adapter and named no mailbox for the
   * role. The cache is dropped whenever a move fails, so a refusal read from
   * it is never older than the last thing the server actually did.
   */
  private roleRefusedFromCache(role: ImapMailboxRole): boolean {
    return (
      this.mailboxRoles !== null && (this.mailboxRoles.get(role) ?? null) === null
    );
  }

  private locate(threadId: string): ThreadLocation {
    const relocated = this.relocations.get(threadId);
    if (relocated) return relocated;
    const identity = parseMessageId(threadId);
    return Object.freeze({ path: INBOX_PATH, ...identity });
  }

  private remember(threadId: string, location: ThreadLocation): void {
    this.relocations.delete(threadId);
    this.relocations.set(threadId, location);
    while (this.relocations.size > MAX_TRACKED_RELOCATIONS) {
      const oldest = this.relocations.keys().next();
      if (oldest.done === true) break;
      this.relocations.delete(oldest.value);
    }
  }

  private assertUidValidity(
    mailbox: MailboxObject,
    location: ThreadLocation,
  ): void {
    if (validateUidValidity(mailbox.uidValidity) !== location.uidValidity) {
      throw staleThread();
    }
  }

  private project(
    threadId: string,
    location: ThreadLocation,
    message: FetchMessageObject,
  ): CachedProviderThread {
    return this.projectAt(threadId, location.path, message, location.uid);
  }

  private projectAt(
    threadId: string,
    path: string,
    message: FetchMessageObject,
    uid: number | null,
  ): CachedProviderThread {
    return imapMessageToCached(
      this.account.account.accountId,
      parseMessageId(threadId).uidValidity,
      uid === null ? message : { ...message, uid },
      Object.freeze({ threadId, inInbox: isInboxPath(path) }),
    );
  }

  private async run<T>(
    signal: AbortSignal,
    operation: (client: ImapSessionClient) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sessions.withSession(this.account, signal, operation);
    } catch (error) {
      throw mapImapProviderError(error);
    }
  }
}

type AccountBlobStore = MailIncomingBlobStorePort & {
  readonly accountId: string;
};

/**
 * Provider-neutral raw MIME source for one custom-domain IMAP account. Each
 * fetch opens one bounded read-only session, verifies the cached UIDVALIDITY,
 * streams BODY.PEEK[] slices straight into the staged incoming blob, and closes
 * the session before the caller hands the blob to the isolated parser. The
 * password never leaves the session factory and no message byte is logged.
 */
export class ImapContentSourceAdapter implements MailContentSourcePort {
  private readonly account: StoredImapMailAccount;
  private readonly sessions: ImapReadSessions;
  private readonly blobStore: AccountBlobStore;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(options: {
    readonly account: StoredImapMailAccount;
    readonly sessions: ImapReadSessions;
    readonly blobStore: AccountBlobStore;
    readonly maxBytes?: number;
    readonly now?: () => number;
  }) {
    const accountId = options.account.account.accountId;
    const maxBytes = options.maxBytes ?? MAIL_RESOURCE_LIMITS.rawMessageBytes;
    if (
      options.account.providerKind !== "imap" ||
      !SAFE_ACCOUNT_ID.test(accountId) ||
      options.blobStore.accountId !== accountId ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAIL_RESOURCE_LIMITS.rawMessageBytes
    ) {
      throw permanentContentError();
    }
    this.account = options.account;
    this.sessions = options.sessions;
    this.blobStore = options.blobStore;
    this.maxBytes = maxBytes;
    this.now = options.now ?? Date.now;
  }

  async fetchRaw(
    input: MailContentSourceFetchInput,
  ): Promise<MailContentSourceFetchResult> {
    if (
      input.accountId !== this.account.account.accountId ||
      typeof input.providerMessageId !== "string" ||
      !SAFE_MESSAGE_ID.test(input.providerMessageId) ||
      !Number.isSafeInteger(input.deadlineAt) ||
      input.deadlineAt < 0 ||
      !(input.signal instanceof AbortSignal)
    ) {
      throw permanentContentError();
    }
    let identity: ReturnType<typeof parseMessageId>;
    try {
      identity = parseMessageId(input.providerMessageId);
    } catch {
      throw permanentContentError();
    }
    if (input.signal.aborted) {
      throw transientContentError();
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw transientContentError();
    }
    const remainingMs = input.deadlineAt - now;
    if (remainingMs <= 0) {
      throw transientContentError();
    }
    const deadlineSignal = AbortSignal.timeout(
      Math.min(remainingMs, MAX_ABORT_TIMEOUT_MS),
    );
    const signal = AbortSignal.any([input.signal, deadlineSignal]);
    try {
      const descriptor = await this.sessions.withSession(
        this.account,
        signal,
        (client) =>
          withInbox(client, async (mailbox) => {
            if (
              validateUidValidity(mailbox.uidValidity) !== identity.uidValidity
            ) {
              throw permanentContentError();
            }
            return this.blobStore.putIncoming(
              rawSourceChunks(client, identity.uid, this.maxBytes, signal),
              this.maxBytes,
            );
          }),
      );
      return Object.freeze({ descriptor });
    } catch (error) {
      throw mapImapContentError(error);
    }
  }
}

/**
 * Streams one message as bounded BODY.PEEK[] slices. The advertised
 * RFC822.SIZE is checked before the first slice is retained and every slice is
 * checked against the remaining budget before it is yielded, so an oversized or
 * lying server never grows the staged blob past the raw-message cap.
 */
async function* rawSourceChunks(
  client: ImapSessionClient,
  uid: number,
  maxBytes: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (;;) {
    if (signal.aborted) throw transientContentError();
    const messages = await client.fetchAll(
      [uid],
      {
        uid: true,
        ...(offset === 0 ? { size: true } : {}),
        source: { start: offset, maxLength: RAW_SOURCE_CHUNK_BYTES },
      },
      { uid: true },
    );
    if (messages.length === 0) throw permanentContentError();
    const message = messages[0];
    if (messages.length !== 1 || message === undefined || message.uid !== uid) {
      throw invalidContentResponse();
    }
    if (offset === 0) {
      const advertised = message.size;
      if (advertised !== undefined) {
        if (!Number.isSafeInteger(advertised) || advertised < 0) {
          throw invalidContentResponse();
        }
        if (advertised > maxBytes) throw invalidContentResponse();
      }
    }
    const chunk = message.source;
    if (chunk === undefined || chunk === null) {
      if (offset === 0) throw invalidContentResponse();
      return;
    }
    if (!(chunk instanceof Uint8Array)) throw invalidContentResponse();
    if (chunk.byteLength > maxBytes - offset) throw invalidContentResponse();
    if (chunk.byteLength === 0) {
      if (offset === 0) throw invalidContentResponse();
      return;
    }
    offset += chunk.byteLength;
    yield chunk;
    if (chunk.byteLength < RAW_SOURCE_CHUNK_BYTES) return;
  }
}

function mapImapContentError(error: unknown): MailContentSourceError {
  if (error instanceof MailContentSourceError) return error;
  if (error instanceof MailAccountError) {
    switch (error.code) {
      case "imap_authentication_failed":
      case "account_state_invalid":
      case "account_not_found":
        return new MailContentSourceError(
          "mail_content_source_reauth_required",
        );
      default:
        return transientContentError();
    }
  }
  if (error instanceof MailProviderSyncError) {
    switch (error.code) {
      case "mail_provider_reauth_required":
        return new MailContentSourceError(
          "mail_content_source_reauth_required",
        );
      case "mail_provider_response_invalid":
        return invalidContentResponse();
      default:
        return transientContentError();
    }
  }
  return transientContentError();
}

function transientContentError(): MailContentSourceError {
  return new MailContentSourceError("mail_content_source_transient");
}

function permanentContentError(): MailContentSourceError {
  return new MailContentSourceError("mail_content_source_permanent");
}

function invalidContentResponse(): MailContentSourceError {
  return new MailContentSourceError("mail_content_source_invalid_response");
}

async function withInbox<T>(
  client: ImapSessionClient,
  operation: (mailbox: MailboxObject) => Promise<T>,
): Promise<T> {
  return withMailbox(client, INBOX_PATH, true, operation);
}

/**
 * One selected mailbox for the length of one operation. A read takes the lock
 * read-only so the server cannot clear `\Recent` behind our back, and a
 * mutation takes a writable selection and says so.
 */
async function withMailbox<T>(
  client: ImapSessionClient,
  path: string,
  readOnly: boolean,
  operation: (mailbox: MailboxObject) => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path, {
    readOnly,
    acquireTimeout: 9_000,
    maxLockHoldTime: 9_000,
  });
  try {
    if (client.mailbox === false || !samePath(client.mailbox.path, path)) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    return await operation(client.mailbox);
  } finally {
    lock.release();
  }
}

/**
 * A relocation runs on `UID MOVE` or it does not run.
 *
 * ImapFlow emulates a missing MOVE with COPY, then `\Deleted`, then EXPUNGE,
 * and `move.js` returns the COPY's result whatever the delete did — so on such
 * a server a failed delete is reported to us as a successful archive with the
 * message still sitting in the Inbox. The EXPUNGE is worse: `expunge.js` picks
 * `UID EXPUNGE` only where UIDPLUS is advertised, and a server with neither
 * MOVE nor UIDPLUS is the same generation of server, so the emulation sends a
 * bare EXPUNGE — which removes every `\Deleted` message in the whole Inbox,
 * not the one being moved. Mail another client flagged and never expunged
 * would go with it. Refusing costs an archive button on an old server. Not
 * refusing costs the owner letters he never touched.
 */
function assertMoveSupported(client: ImapSessionClient): void {
  if (client.capabilities.has(MOVE_CAPABILITY)) return;
  throw new MailProviderSyncError("mail_provider_mutation_unsupported");
}

/** INBOX is the one case-insensitive mailbox name in IMAP (RFC 3501 5.1). */
function samePath(left: string, right: string): boolean {
  if (isInboxPath(left) || isInboxPath(right)) {
    return isInboxPath(left) && isInboxPath(right);
  }
  return left === right;
}

async function fetchOne(
  client: ImapSessionClient,
  uid: number,
): Promise<FetchMessageObject | null> {
  const messages = await client.fetchAll(uid, metadataFetchQuery(), { uid: true });
  if (messages.length === 0) return null;
  if (messages.length !== 1 || messages[0]?.uid !== uid) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return messages[0];
}

/**
 * The thread the caller named is not where the account says it is — another
 * client moved or expunged it, or this adapter moved it and a restart took
 * the handle with it. No retry brings the handle back. The next sync rebuilds
 * the list from the server's own truth, and until then the surface has to
 * say the thread moved on rather than offer a "Try again" that cannot work.
 */
function staleThread(): MailProviderSyncError {
  return new MailProviderSyncError("mail_provider_thread_stale");
}

/**
 * Whether a STORE of this flag can stick, read off the SELECT response before
 * one is sent. A mailbox the server opened READ-ONLY answers every STORE with
 * NO, and a flag missing from PERMANENTFLAGS — with no `\*` to admit new
 * ones — is one ImapFlow will not even send: `store.js` returns false with
 * nothing on the wire. Both used to surface as "unavailable", a retry that
 * could never succeed. Removing a flag is always sent, as ImapFlow sends it:
 * clearing what the server never kept is harmless.
 */
function assertFlagStorable(
  mailbox: MailboxObject,
  flag: string,
  present: boolean,
): void {
  if (mailbox.readOnly === true) {
    throw new MailProviderSyncError("mail_provider_mutation_unsupported");
  }
  if (!present) return;
  const permanent = mailbox.permanentFlags;
  if (
    permanent instanceof Set &&
    !permanent.has("\\*") &&
    !permanent.has(flag)
  ) {
    throw new MailProviderSyncError("mail_provider_mutation_unsupported");
  }
}

function metadataFetchQuery() {
  return Object.freeze({
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    bodyStructure: true,
    size: true,
    // imapflow fetches named headers with BODY.PEEK[HEADER.FIELDS (…)], so
    // the read-only session stays flag-neutral.
    headers: ["list-id", "list-unsubscribe", "precedence", "auto-submitted"],
  });
}

/**
 * `overrides` keeps a moved thread addressable under the id the cache already
 * knows. A MOVE gives the message a new UID in a new mailbox, so the id it
 * would encode is not the id the UI is holding.
 */
export function imapMessageToCached(
  accountId: string,
  uidValidity: bigint,
  source: FetchMessageObject,
  overrides?: { readonly threadId: string; readonly inInbox: boolean },
): CachedProviderThread {
  if (!SAFE_ACCOUNT_ID.test(accountId)) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  const uid = validateUid(source.uid);
  const identity =
    overrides === undefined
      ? encodeMessageId(uidValidity, uid)
      : validatedThreadId(overrides.threadId);
  const inInbox = overrides?.inInbox ?? true;
  const from = firstAddress(source.envelope?.from);
  const replyTo = addresses(source.envelope?.replyTo);
  const to = addresses(source.envelope?.to);
  const cc = addresses(source.envelope?.cc);
  const subject = boundedText(source.envelope?.subject, 998);
  const sentAt = parseDate(source.internalDate ?? source.envelope?.date);
  const unread = source.flags instanceof Set ? !source.flags.has("\\Seen") : false;
  const starred = source.flags instanceof Set && source.flags.has("\\Flagged");
  const hasAttachments = structureHasAttachment(source.bodyStructure);
  const rfcMessageId = boundedMessageId(source.envelope?.messageId);
  const inReplyTo = boundedMessageId(source.envelope?.inReplyTo);
  const listHeaders = parseListHeaders(source.headers);
  const category = classifyMessageCategory({
    ...listHeaders,
    fromAddress: from?.address ?? null,
  });
  const listMessage = category !== "people";
  const sizeEstimate =
    Number.isSafeInteger(source.size) && (source.size as number) >= 0
      ? (source.size as number)
      : null;
  const message: CachedProviderMessage = Object.freeze({
    accountId,
    messageId: identity,
    threadId: identity,
    from,
    replyTo,
    to,
    cc,
    subject,
    sentAt,
    unread,
    inInbox,
    snippet: null,
    textBody: null,
    htmlBody: null,
    hasAttachments,
    rfcMessageId,
    references: Object.freeze(inReplyTo === null ? [] : [inReplyTo]),
    listMessage,
    category,
    sizeEstimate,
  });
  const participants = Object.freeze(from === null ? [] : [from]);
  const thread: MailThreadListItem = Object.freeze({
    accountId,
    threadId: identity,
    subject,
    participants,
    snippet: null,
    lastMessageAt: sentAt,
    messageCount: 1,
    unread,
    starred,
    hasAttachments,
    listMessage,
    sizeBytes: sizeEstimate ?? 0,
    category,
  });
  return Object.freeze({
    thread,
    messages: Object.freeze([message]),
    inInbox,
    mailboxes: Object.freeze([
      "all" as const,
      ...(inInbox ? (["inbox" as const] as const) : []),
      ...(starred ? (["starred" as const] as const) : []),
    ]),
  });
}

function validatedThreadId(value: string): string {
  parseMessageId(value);
  return value;
}

function encodeAnchor(mailbox: MailboxObject, cycle: number): string {
  return encodeAnchorParts({
    uidValidity: validateUidValidity(mailbox.uidValidity),
    uidNext: validateUid(mailbox.uidNext),
    exists: validateExists(mailbox.exists),
    cycle,
  });
}

function encodeAnchorParts(anchor: ImapAnchor): string {
  validateUidValidity(anchor.uidValidity);
  validateUid(anchor.uidNext);
  validateExists(anchor.exists);
  if (!Number.isSafeInteger(anchor.cycle) || anchor.cycle < 0 || anchor.cycle > 15) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  const packed =
    (((anchor.uidValidity << COMPONENT_BITS) | BigInt(anchor.uidNext)) <<
      COMPONENT_BITS |
      BigInt(anchor.exists)) <<
      CYCLE_BITS |
    BigInt(anchor.cycle);
  const encoded = packed.toString(10);
  if (!/^\d{1,32}$/.test(encoded)) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return encoded;
}

function parseAnchor(value: string): ImapAnchor {
  if (!/^\d{1,32}$/.test(value)) {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
  let packed: bigint;
  try {
    packed = BigInt(value);
  } catch {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
  const cycle = Number(packed & CYCLE_MASK);
  packed >>= CYCLE_BITS;
  const exists = Number(packed & COMPONENT_MASK);
  packed >>= COMPONENT_BITS;
  const uidNext = Number(packed & COMPONENT_MASK);
  packed >>= COMPONENT_BITS;
  const uidValidity = packed & COMPONENT_MASK;
  packed >>= COMPONENT_BITS;
  if (packed !== BIGINT_ZERO) {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
  validateUidValidity(uidValidity);
  validateUid(uidNext);
  validateExists(exists);
  return Object.freeze({ uidValidity, uidNext, exists, cycle });
}

function encodeInitialPageToken(token: InitialPageToken): string {
  return [
    "i2",
    token.uidValidity,
    token.snapshotUidNext,
    token.snapshotExists,
    token.nextEndSequence,
    token.minimumSequence,
    token.exclusiveUpperUid,
  ].join("_");
}

function parseInitialPageToken(value: string): InitialPageToken {
  const match = /^i2_([1-9]\d{0,9})_([1-9]\d{0,9})_(\d{1,10})_([1-9]\d{0,9})_([1-9]\d{0,9})_([1-9]\d{0,9})$/.exec(
    value,
  );
  if (!match) throw new MailProviderSyncError("mail_provider_cursor_invalid");
  const token = Object.freeze({
    uidValidity: BigInt(match[1]!),
    snapshotUidNext: Number(match[2]),
    snapshotExists: Number(match[3]),
    nextEndSequence: Number(match[4]),
    minimumSequence: Number(match[5]),
    exclusiveUpperUid: Number(match[6]),
  });
  validateUidValidity(token.uidValidity);
  validateUid(token.snapshotUidNext);
  validateExists(token.snapshotExists);
  validateExists(token.nextEndSequence);
  validateExists(token.minimumSequence);
  validateUid(token.exclusiveUpperUid);
  if (
    token.snapshotExists < token.nextEndSequence ||
    token.minimumSequence > token.nextEndSequence ||
    token.snapshotExists - token.minimumSequence + 1 > MAX_INITIAL_MESSAGES ||
    token.exclusiveUpperUid > token.snapshotUidNext
  ) {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
  return token;
}

function assertInitialPageSnapshot(
  messages: readonly FetchMessageObject[],
  expected: {
    readonly startSequence: number;
    readonly endSequence: number;
    readonly exclusiveUpperUid: number;
  },
): void {
  const expectedCount = expected.endSequence - expected.startSequence + 1;
  if (messages.length !== expectedCount) {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
  let previousUid = 0;
  for (const [index, message] of messages.entries()) {
    const sequence = message.seq;
    const uid = message.uid;
    if (
      sequence !== expected.startSequence + index ||
      !Number.isSafeInteger(uid) ||
      uid < 1 ||
      uid >= expected.exclusiveUpperUid ||
      uid <= previousUid
    ) {
      throw new MailProviderSyncError("mail_provider_cursor_invalid");
    }
    previousUid = uid;
  }
}

function assertIncrementalUidRange(
  messages: readonly FetchMessageObject[],
  startUid: number,
  endUid: number,
): void {
  let previousUid = startUid - 1;
  for (const message of messages) {
    const uid = message.uid;
    if (
      !Number.isSafeInteger(uid) ||
      uid < startUid ||
      uid > endUid ||
      uid <= previousUid
    ) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    previousUid = uid;
  }
}

function encodeChangePageToken(token: ChangePageToken): string {
  return [
    "c1",
    token.uidValidity,
    token.startUidNext,
    token.startExists,
    token.targetUidNext,
    token.targetExists,
    token.nextUid,
    token.nextCycle,
  ].join("_");
}

function parseChangePageToken(value: string): ChangePageToken {
  const match = /^c1_([1-9]\d{0,9})_([1-9]\d{0,9})_(\d{1,10})_([1-9]\d{0,9})_(\d{1,10})_([1-9]\d{0,9})_(\d{1,2})$/.exec(
    value,
  );
  if (!match) throw new MailProviderSyncError("mail_provider_cursor_invalid");
  const token = Object.freeze({
    uidValidity: BigInt(match[1]!),
    startUidNext: Number(match[2]),
    startExists: Number(match[3]),
    targetUidNext: Number(match[4]),
    targetExists: Number(match[5]),
    nextUid: Number(match[6]),
    nextCycle: Number(match[7]),
  });
  validateUidValidity(token.uidValidity);
  validateUid(token.startUidNext);
  validateExists(token.startExists);
  validateUid(token.targetUidNext);
  validateExists(token.targetExists);
  validateUid(token.nextUid);
  if (
    !Number.isSafeInteger(token.nextCycle) ||
    token.nextCycle < 1 ||
    token.nextCycle >= FULL_REBUILD_AFTER_CYCLES ||
    token.startUidNext > token.nextUid ||
    token.nextUid > token.targetUidNext
  ) {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
  return token;
}

function assertChangeTokenMatches(
  token: ChangePageToken,
  start: ImapAnchor,
  current: Omit<ImapAnchor, "cycle">,
): void {
  if (
    token.uidValidity !== start.uidValidity ||
    token.startUidNext !== start.uidNext ||
    token.startExists !== start.exists ||
    token.nextCycle !== start.cycle + 1 ||
    token.targetUidNext < token.nextUid ||
    current.uidValidity !== token.uidValidity ||
    current.uidNext < token.targetUidNext ||
    current.exists < token.targetExists
  ) {
    throw new MailProviderSyncError("mail_provider_cursor_invalid");
  }
}

function encodeMessageId(uidValidity: bigint, uid: number): string {
  validateUidValidity(uidValidity);
  validateUid(uid);
  return `i${uidValidity}u${uid}`;
}

function parseMessageId(value: string): {
  readonly uidValidity: bigint;
  readonly uid: number;
} {
  const match = SAFE_MESSAGE_ID.exec(value);
  if (!match) throw new MailProviderSyncError("mail_provider_response_invalid");
  const uidValidity = BigInt(match[1]!);
  const uid = Number(match[2]);
  validateUidValidity(uidValidity);
  validateUid(uid);
  return Object.freeze({ uidValidity, uid });
}

function firstAddress(
  values: readonly MessageAddressObject[] | undefined,
): MailAddress | null {
  return addresses(values)[0] ?? null;
}

function addresses(
  values: readonly MessageAddressObject[] | undefined,
): readonly MailAddress[] {
  if (!Array.isArray(values)) return Object.freeze([]);
  const result: MailAddress[] = [];
  const seen = new Set<string>();
  for (const value of values.slice(0, 100)) {
    if (typeof value.address !== "string") continue;
    const address = value.address.trim().toLowerCase();
    if (
      Buffer.byteLength(address) > 320 ||
      /[\u0000-\u0020\u007f]/.test(address) ||
      !/^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(address) ||
      seen.has(address)
    ) {
      continue;
    }
    seen.add(address);
    result.push(
      Object.freeze({
        address,
        name: boundedText(value.name, 256),
      }),
    );
  }
  return Object.freeze(result);
}

function boundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("\u0000", "�").trim();
  if (normalized.length === 0) return null;
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized;
  let result = "";
  let bytes = 0;
  for (const character of normalized) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result.length === 0 ? null : result;
}

interface ParsedListHeaders {
  readonly hasListId: boolean;
  readonly hasListUnsubscribe: boolean;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
}

/**
 * Reads only the four list-classification headers out of the fetched header
 * block: presence for List-Id and List-Unsubscribe, the trimmed first value
 * for Precedence and Auto-Submitted. Folded continuation lines are unfolded,
 * names match case-insensitively, and the block is bounded before parsing.
 */
export function parseListHeaders(
  headers: Buffer | undefined,
): ParsedListHeaders {
  let hasListId = false;
  let hasListUnsubscribe = false;
  let precedence: string | null = null;
  let autoSubmitted: string | null = null;
  if (headers !== undefined && headers.byteLength > 0) {
    const text = headers
      .subarray(0, MAX_LIST_HEADER_BYTES)
      .toString("latin1")
      .replace(/\r?\n[ \t]+/g, " ");
    for (const line of text.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      if (name === "list-id") {
        hasListId = true;
      } else if (name === "list-unsubscribe") {
        hasListUnsubscribe = true;
      } else if (name === "precedence" && precedence === null) {
        precedence = line.slice(separator + 1).trim();
      } else if (name === "auto-submitted" && autoSubmitted === null) {
        autoSubmitted = line.slice(separator + 1).trim();
      }
    }
  }
  return Object.freeze({
    hasListId,
    hasListUnsubscribe,
    precedence,
    autoSubmitted,
  });
}

/**
 * Service local parts, matched against the whole local part after case-fold
 * and separator normalization: "-", ".", and "_" are stripped before the
 * test, so no-reply / no_reply / no.reply and customer-care / customer_service
 * fold to one token. The noreply and donotreply families match as prefixes
 * (noreply2, noreply-sales); every other name is an exact match. hi, contact,
 * and developer are deliberately excluded — those local parts are often real
 * humans. Same predicate as the Gmail adapter.
 */
const NOTIFICATION_SENDER_LOCAL_PART =
  /^(?:noreply|donotreply)|^(?:notifications?|notify|alerts?|mailerdaemon|postmaster|bounces?|support|help|helpdesk|team|info|news|newsletters?|updates?|digest|marketing|promo|promotions?|offers?|sales|billing|accounts?|security|admin|administrator|feedback|community|service|welcome|invoices?|receipts?|orders?|customercare|customerservice|hello|jobs|careers)$/i;
/**
 * Mailing-infrastructure subdomains: when the from domain has three or more
 * labels (i.e. it is a subdomain) and its first label matches, the sender is
 * automated (email.apple.com, news.anthropic.com, m1.example.com). Two-label
 * domains (apple.com, clay.com) never match. Same predicate as the Gmail
 * adapter.
 */
const NOTIFICATION_SENDER_SUBDOMAIN =
  /^(e?mail(er)?s?|e\d+|m\d+|em|mta\d*|news(letter)?s?|notification?s?|notify|marketing|updates?|info|bounces?|campaigns?|broadcasts?|digests?)$/i;

/**
 * A message is a newsletter when it carries a list header; else a notification
 * when it carries a bulk or list Precedence, any Auto-Submitted value other
 * than "no", or an automated sender (service local part or mailing
 * subdomain); else people mail. listMessage derives from this: any
 * non-"people" category is list mail. Same predicate as the Gmail adapter.
 */
function classifyMessageCategory(
  input: ParsedListHeaders & { readonly fromAddress: string | null },
): MailThreadCategory {
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
 * byte-equivalently in the Gmail adapter and the cache category pre-seed.
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

function boundedMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^<[^<>\s\u0000-\u001f\u007f]+>$/.test(normalized) &&
    Buffer.byteLength(normalized) <= 998
    ? normalized
    : null;
}

function parseDate(value: unknown): number | null {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function structureHasAttachment(root: MessageStructureObject | undefined): boolean {
  if (!root) return false;
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    if (visited > 1_000) {
      throw new MailProviderSyncError("mail_provider_response_invalid");
    }
    const disposition = node.disposition?.toLowerCase();
    const filename =
      node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
    if (disposition === "attachment" || (typeof filename === "string" && filename.length > 0)) {
      return true;
    }
    if (Array.isArray(node.childNodes)) queue.push(...node.childNodes);
  }
  return false;
}

function assertUniqueThreads(threads: readonly CachedProviderThread[]): void {
  if (
    threads.length > MAX_PAGE_ITEMS ||
    new Set(threads.map((thread) => thread.thread.threadId)).size !== threads.length
  ) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
}

function validateUidValidity(value: bigint): bigint {
  if (
    typeof value !== "bigint" ||
    value < BIGINT_ONE ||
    value > BigInt(MAX_UID_COMPONENT)
  ) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return value;
}

function validateUid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_UID_COMPONENT) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return value;
}

function validateExists(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UID_COMPONENT) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return value;
}

function validatePageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_ITEMS) {
    throw new MailProviderSyncError("mail_provider_response_invalid");
  }
  return value;
}

function mapImapProviderError(error: unknown): MailProviderSyncError {
  if (error instanceof MailProviderSyncError) return error;
  if (error instanceof MailAccountError) {
    if (
      error.code === "imap_authentication_failed" ||
      error.code === "account_state_invalid" ||
      error.code === "account_not_found"
    ) {
      return new MailProviderSyncError("mail_provider_reauth_required");
    }
    return new MailProviderSyncError("mail_provider_unavailable");
  }
  return new MailProviderSyncError("mail_provider_unavailable");
}

/* ------------------------------------------------------------------------- *
 * Mailbox roles
 *
 * Which server folder plays a role — outside Gmail there is no INBOX label to
 * drop, so archive, trash and junk are ordinary mailboxes that first have to be
 * found. A server states the answer through SPECIAL-USE (RFC 6154) or the older
 * XLIST attribute, and ImapFlow surfaces both as `specialUse`. A server that
 * states nothing is matched against a short list of well-known names, at the
 * account root or directly under the Inbox and only when exactly one folder
 * answers, and a server that matches neither has no mailbox for that role:
 * the mutation is refused rather than moved into a guessed destination.
 *
 * This lives in the adapter file rather than beside it because the isolated
 * mail runtime projects an exact allowlist of compiled files, and a new module
 * there is a release-shape change, not a code change.
 * ------------------------------------------------------------------------- */

export type ImapMailboxRole = "archive" | "trash" | "junk";

export interface ImapMailboxDescriptor {
  readonly path: string;
  /** Leaf name as listed. Derived from `path` and `delimiter` when absent. */
  readonly name?: string;
  readonly delimiter?: string;
  /** One SPECIAL-USE or XLIST attribute, e.g. `\Archive`. */
  readonly specialUse?: string;
  readonly flags?: Iterable<string>;
}

/** One account may not list more mailboxes than the documented budget. */
export const MAX_LISTED_MAILBOXES = 256;

const MAX_MAILBOX_PATH_BYTES = 1024;
const INBOX = "INBOX";

/**
 * Ordered tiers per role. A tier is either a stated special-use attribute or a
 * set of well-known leaf names. An explicitly named Archive outranks a server's
 * all-mail view, because a virtual all-mail mailbox is not always a valid MOVE
 * destination.
 */
type RoleTier =
  | { readonly kind: "special_use"; readonly attribute: string }
  | { readonly kind: "name"; readonly names: readonly string[] };

const ROLE_TIERS: Readonly<Record<ImapMailboxRole, readonly RoleTier[]>> =
  Object.freeze({
    archive: Object.freeze<readonly RoleTier[]>([
      Object.freeze({ kind: "special_use", attribute: "\\Archive" }),
      Object.freeze({ kind: "name", names: Object.freeze(["archive", "archives"]) }),
      Object.freeze({ kind: "special_use", attribute: "\\All" }),
      Object.freeze({ kind: "name", names: Object.freeze(["all mail"]) }),
    ]),
    trash: Object.freeze<readonly RoleTier[]>([
      Object.freeze({ kind: "special_use", attribute: "\\Trash" }),
      Object.freeze({
        kind: "name",
        names: Object.freeze(["trash", "deleted items", "deleted messages"]),
      }),
    ]),
    junk: Object.freeze<readonly RoleTier[]>([
      Object.freeze({ kind: "special_use", attribute: "\\Junk" }),
      Object.freeze({
        kind: "name",
        names: Object.freeze(["junk", "spam", "junk e-mail", "junk email"]),
      }),
    ]),
  });

/** Attributes that make a listed mailbox impossible to select or move into. */
const UNSELECTABLE_FLAGS = Object.freeze([
  "\\noselect",
  "\\nonexistent",
]);

export function isInboxPath(path: string): boolean {
  return path.toUpperCase() === INBOX;
}

/**
 * Returns the mailbox path for one role, or null when the server offers none.
 * A name tier answers only with a folder that sits where a mail client would
 * create one, and only when exactly one folder answers to the name: two is a
 * choice about which of the owner's folders receives mail, and the server
 * made neither, so the role is refused rather than picked — a lower tier
 * would be a guess as well. The answer therefore does not depend on LIST
 * order.
 */
export function selectImapMailboxPath(
  role: ImapMailboxRole,
  mailboxes: readonly ImapMailboxDescriptor[],
): string | null {
  const candidates = mailboxes.filter(isSelectableMailbox);
  for (const tier of ROLE_TIERS[role]) {
    if (tier.kind === "special_use") {
      const match = candidates.find(
        (entry) => normalizedAttribute(entry.specialUse) === tier.attribute.toLowerCase(),
      );
      if (match) return match.path;
      continue;
    }
    const named = candidates.filter(
      (entry) =>
        isRoleMountPoint(entry) &&
        tier.names.includes(leafName(entry).toLowerCase()),
    );
    if (named.length === 1) return named[0]!.path;
    if (named.length > 1) return null;
  }
  return null;
}

/**
 * Whether a listed mailbox sits where a mail client creates a role folder: at
 * the account root, or directly under the Inbox on a server that files
 * everything beneath it. A leaf called Archive three levels down a project
 * tree is a folder about something else, and it used to win the name tier
 * and become the destination for the owner's incoming mail. A server that
 * lists no delimiter has no hierarchy, so every path there is a root path.
 */
function isRoleMountPoint(entry: ImapMailboxDescriptor): boolean {
  const delimiter = entry.delimiter;
  if (typeof delimiter !== "string" || delimiter.length !== 1) return true;
  const first = entry.path.indexOf(delimiter);
  if (first === -1) return true;
  return (
    isInboxPath(entry.path.slice(0, first)) &&
    entry.path.indexOf(delimiter, first + 1) === -1
  );
}

export function isSupportedMailboxList(value: unknown): value is readonly ImapMailboxDescriptor[] {
  return Array.isArray(value) && value.length <= MAX_LISTED_MAILBOXES;
}

function isSelectableMailbox(entry: ImapMailboxDescriptor): boolean {
  if (
    entry === null ||
    typeof entry !== "object" ||
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    Buffer.byteLength(entry.path) > MAX_MAILBOX_PATH_BYTES ||
    /[\u0000\r\n]/.test(entry.path) ||
    isInboxPath(entry.path)
  ) {
    return false;
  }
  const flags = entry.flags === undefined ? [] : [...entry.flags];
  return !flags.some(
    (flag) =>
      typeof flag === "string" &&
      UNSELECTABLE_FLAGS.includes(flag.toLowerCase()),
  );
}

function normalizedAttribute(value: string | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

function leafName(entry: ImapMailboxDescriptor): string {
  if (typeof entry.name === "string" && entry.name.length > 0) return entry.name;
  const delimiter = entry.delimiter;
  if (typeof delimiter !== "string" || delimiter.length !== 1) return entry.path;
  const index = entry.path.lastIndexOf(delimiter);
  return index === -1 ? entry.path : entry.path.slice(index + delimiter.length);
}
