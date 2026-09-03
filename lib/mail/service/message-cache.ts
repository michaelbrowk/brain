import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  MailAddress,
  MailMailboxAvailability,
  MailMessageDto,
  MailSyncStatus,
  MailSearchThreadPage,
  MailThreadCategory,
  MailThreadDetail,
  MailThreadListItem,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "../message-types";
import { normalizeMailSearchQuery } from "../message-codec";

const CACHE_SCHEMA_VERSION = 1;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/**
 * Same automated-sender predicate as classifyMessageCategory in both provider
 * adapters; used only by the bounded category pre-seed on open. Service local
 * parts are matched against the whole local part after case-fold and
 * separator normalization: "-", ".", and "_" are stripped before the test, so
 * no-reply / no_reply / no.reply and customer-care / customer_service fold to
 * one token. The noreply and donotreply families match as prefixes (noreply2,
 * noreply-sales); every other name is an exact match. hi, contact, and
 * developer are deliberately excluded — those local parts are often real
 * humans.
 */
const NOTIFICATION_SENDER_LOCAL_PART =
  /^(?:noreply|donotreply)|^(?:notifications?|notify|alerts?|mailerdaemon|postmaster|bounces?|support|help|helpdesk|team|info|news|newsletters?|updates?|digest|marketing|promo|promotions?|offers?|sales|billing|accounts?|security|admin|administrator|feedback|community|service|welcome|invoices?|receipts?|orders?|customercare|customerservice|hello|jobs|careers)$/i;
/**
 * Mailing-infrastructure subdomains: when the from domain has three or more
 * labels (i.e. it is a subdomain) and its first label matches, the sender is
 * automated (email.apple.com, news.anthropic.com, m1.example.com). Two-label
 * domains (apple.com, clay.com) never match. Same predicate as both provider
 * adapters.
 */
const NOTIFICATION_SENDER_SUBDOMAIN =
  /^(e?mail(er)?s?|e\d+|m\d+|em|mta\d*|news(letter)?s?|notification?s?|notify|marketing|updates?|info|bounces?|campaigns?|broadcasts?|digests?)$/i;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const MAX_CURSOR_BYTES = 2 * 1024;
const MAX_THREADS_PER_PAGE = 100;
const MAX_MESSAGES_PER_THREAD = 200;
const MAX_ACCOUNT_CACHE_BYTES = 512 * 1024 * 1024;
const CACHE_WRITE_OVERHEAD_MULTIPLIER = 2;
const INCREMENTAL_VACUUM_PAGES_PER_STEP = 256;
const INCREMENTAL_VACUUM_MAX_STEPS = 64;
const MAX_MAILBOX_HYDRATION_PAGE_THREADS = 20;
const MAX_MAILBOX_HYDRATION_PAGES = 1_000;
const MAX_MAILBOX_HYDRATION_THREADS = 200;
const MAX_ALL_MAIL_HYDRATION_THREADS = 200;
const MAX_PENDING_THREAD_REFRESHES = 1_000;
const MAX_PENDING_THREAD_REFRESH_PAGE = 20;
const BACKGROUND_SYNC_BASE_BACKOFF_MS = 30_000;
const BACKGROUND_SYNC_MAX_BACKOFF_MS = 30 * 60_000;
const MAX_BACKGROUND_SYNC_FAILURES = 31;
const MAX_SEARCH_BACKFILL_THREADS = 500;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_CURSOR_OFFSET = MAX_SEARCH_RESULTS - 1;

export type MailCacheMailbox =
  | "all"
  | "inbox"
  | "sent"
  | "spam"
  | "starred"
  | "trash";

export type MailCacheHydratableMailbox = Exclude<MailCacheMailbox, "inbox">;

export type MailCacheReauthErrorCode =
  | "gmail_reauth_required"
  | "mail_provider_reauth_required";

export const MAIL_CACHE_HYDRATION_ORDER = Object.freeze<
  readonly MailCacheHydratableMailbox[]
>(["sent", "starred", "spam", "trash", "all"]);

const MAIL_CACHE_MAILBOXES = Object.freeze<readonly MailCacheMailbox[]>([
  "all",
  "inbox",
  "sent",
  "spam",
  "starred",
  "trash",
]);

const THREAD_VIEWS = Object.freeze<readonly MailThreadView[]>([
  "unread",
  "attachments",
  "lists",
  "people",
]);

const THREAD_SORTS = Object.freeze<readonly MailThreadSort[]>([
  "date",
  "unread",
  "sender",
  "size",
]);

/**
 * Enum-keyed constant SQL fragments. Request strings never reach SQL: view and
 * sort are validated to these enum keys first, and only the constant fragment
 * looked up here is assembled into a query. The prefix is a compile-time
 * constant selecting the inbox or the joined-mailbox column spelling.
 */
function threadViewSql(
  prefix: "" | "thread.",
): Readonly<Record<MailThreadView, string>> {
  return Object.freeze({
    unread: `AND ${prefix}unread = 1`,
    attachments: `AND ${prefix}has_attachments = 1`,
    lists: `AND ${prefix}list_message = 1`,
    people: `AND ${prefix}list_message = 0`,
  });
}

interface ThreadSortSql {
  readonly orderBy: string;
  readonly keyset: string;
}

function threadSortSql(
  prefix: "" | "thread.",
): Readonly<Record<MailThreadSort, ThreadSortSql>> {
  const t = `COALESCE(${prefix}last_message_at, -1)`;
  const i = `${prefix}thread_id`;
  const dateKeyset = `(${t} < ? OR (${t} = ? AND ${i} < ?))`;
  return Object.freeze({
    date: Object.freeze({
      orderBy: `${t} DESC, ${i} DESC`,
      keyset: `AND ${dateKeyset}`,
    }),
    unread: Object.freeze({
      orderBy: `${prefix}unread DESC, ${t} DESC, ${i} DESC`,
      keyset: `AND (${prefix}unread < ? OR (${prefix}unread = ? AND ${dateKeyset}))`,
    }),
    sender: Object.freeze({
      orderBy: `${prefix}sort_sender ASC, ${t} DESC, ${i} DESC`,
      keyset: `AND (${prefix}sort_sender > ? OR (${prefix}sort_sender = ? AND ${dateKeyset}))`,
    }),
    size: Object.freeze({
      orderBy: `${prefix}size_bytes DESC, ${t} DESC, ${i} DESC`,
      keyset: `AND (${prefix}size_bytes < ? OR (${prefix}size_bytes = ? AND ${dateKeyset}))`,
    }),
  });
}

const THREAD_VIEW_SQL = threadViewSql("");
const MAILBOX_THREAD_VIEW_SQL = threadViewSql("thread.");
const THREAD_SORT_SQL = threadSortSql("");
const MAILBOX_THREAD_SORT_SQL = threadSortSql("thread.");

/** Disambiguates the cursor key type inside the v3 fingerprint. */
const THREAD_SORT_KEY_TAGS = Object.freeze({
  date: "n",
  unread: "b",
  sender: "s",
  size: "z",
} as const satisfies Record<MailThreadSort, string>);

const SCHEMA_SQL = `
  CREATE TABLE sync_state (
    account_id TEXT PRIMARY KEY,
    active_generation INTEGER NOT NULL CHECK(active_generation >= 0),
    staged_generation INTEGER,
    history_id TEXT,
    initial_anchor_history_id TEXT,
    page_token TEXT,
    status TEXT NOT NULL CHECK(status IN ('idle', 'syncing', 'backoff', 'reauth_required')),
    last_successful_at INTEGER,
    last_error_code TEXT,
    CHECK(staged_generation IS NULL OR staged_generation > active_generation)
  ) STRICT;

  CREATE TABLE threads (
    account_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    thread_id TEXT NOT NULL,
    subject TEXT,
    participants_json TEXT NOT NULL,
    snippet TEXT,
    last_message_at INTEGER,
    message_count INTEGER NOT NULL CHECK(message_count >= 1 AND message_count <= 200),
    unread INTEGER NOT NULL CHECK(unread IN (0, 1)),
    starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0, 1)),
    has_attachments INTEGER NOT NULL CHECK(has_attachments IN (0, 1)),
    in_inbox INTEGER NOT NULL CHECK(in_inbox IN (0, 1)),
    list_message INTEGER NOT NULL DEFAULT 0 CHECK(list_message IN (0, 1)),
    size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
    sort_sender TEXT NOT NULL DEFAULT '' CHECK(length(sort_sender) <= 128),
    category TEXT NOT NULL DEFAULT 'people' CHECK(category IN ('people', 'notification', 'newsletter')),
    PRIMARY KEY(account_id, generation, thread_id)
  ) STRICT;

  CREATE INDEX threads_list_idx
    ON threads(account_id, generation, in_inbox, last_message_at DESC, thread_id DESC);

  CREATE TABLE messages (
    account_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    from_json TEXT,
    reply_to_json TEXT NOT NULL DEFAULT '[]',
    reply_to_complete INTEGER NOT NULL DEFAULT 0 CHECK(reply_to_complete IN (0, 1)),
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    subject TEXT,
    sent_at INTEGER,
    unread INTEGER NOT NULL CHECK(unread IN (0, 1)),
    in_inbox INTEGER NOT NULL CHECK(in_inbox IN (0, 1)),
    snippet TEXT,
    text_body TEXT,
    html_body TEXT,
    rfc_message_id TEXT,
    references_json TEXT NOT NULL,
    has_attachments INTEGER NOT NULL CHECK(has_attachments IN (0, 1)),
    PRIMARY KEY(account_id, generation, message_id),
    FOREIGN KEY(account_id, generation, thread_id)
      REFERENCES threads(account_id, generation, thread_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX messages_thread_idx
    ON messages(account_id, generation, thread_id, sent_at ASC, message_id ASC);
`;

/**
 * Additive extension to schema v1. Keeping PRAGMA user_version unchanged is
 * deliberate: the previous runtime ignores these tables and can still open the
 * cache after a rollback. Mailbox generations always reference an existing
 * threads.generation allocated by the account-wide sync; mailbox hydration must
 * never allocate an independent generation.
 */
const MAILBOX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS mailbox_sync_state (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL
      CHECK(mailbox_id IN ('all', 'inbox', 'sent', 'spam', 'starred', 'trash')),
    active_thread_generation INTEGER NOT NULL
      CHECK(active_thread_generation >= 0),
    staged_thread_generation INTEGER,
    observed_history_id TEXT CHECK(
      observed_history_id IS NULL OR (
        length(observed_history_id) BETWEEN 1 AND 32 AND
        observed_history_id NOT GLOB '*[^0-9]*'
      )
    ),
    initial_anchor_history_id TEXT CHECK(
      initial_anchor_history_id IS NULL OR (
        length(initial_anchor_history_id) BETWEEN 1 AND 32 AND
        initial_anchor_history_id NOT GLOB '*[^0-9]*'
      )
    ),
    page_token TEXT CHECK(
      page_token IS NULL OR length(CAST(page_token AS BLOB)) BETWEEN 1 AND 2048
    ),
    status TEXT NOT NULL
      CHECK(status IN (
        'uninitialized', 'syncing', 'idle', 'backoff', 'reauth_required'
      )),
    last_successful_at INTEGER CHECK(
      last_successful_at IS NULL OR last_successful_at >= 0
    ),
    last_error_code TEXT CHECK(
      last_error_code IS NULL OR
      length(CAST(last_error_code AS BLOB)) BETWEEN 1 AND 64
    ),
    PRIMARY KEY(account_id, mailbox_id),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE,
    CHECK(
      staged_thread_generation IS NULL OR
      staged_thread_generation > active_thread_generation
    ),
    CHECK(
      status <> 'uninitialized' OR (
        observed_history_id IS NULL AND initial_anchor_history_id IS NULL AND
        page_token IS NULL AND last_successful_at IS NULL
      )
    ),
    CHECK(
      status <> 'idle' OR (
        active_thread_generation > 0 AND staged_thread_generation IS NULL AND
        observed_history_id IS NOT NULL AND initial_anchor_history_id IS NULL AND
        page_token IS NULL AND last_successful_at IS NOT NULL
      )
    ),
    CHECK(
      status <> 'syncing' OR (
        staged_thread_generation IS NOT NULL AND
        initial_anchor_history_id IS NOT NULL
      )
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS thread_mailboxes (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL
      CHECK(mailbox_id IN ('all', 'inbox', 'sent', 'spam', 'starred', 'trash')),
    generation INTEGER NOT NULL CHECK(generation > 0),
    thread_id TEXT NOT NULL,
    PRIMARY KEY(account_id, mailbox_id, generation, thread_id),
    FOREIGN KEY(account_id, generation, thread_id)
      REFERENCES threads(account_id, generation, thread_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS thread_mailboxes_thread_idx
    ON thread_mailboxes(account_id, generation, thread_id);

  CREATE TABLE IF NOT EXISTS pending_thread_refresh (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
    PRIMARY KEY(account_id, thread_id),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS pending_thread_refresh_due_idx
    ON pending_thread_refresh(account_id, queued_at, thread_id);

  CREATE TABLE IF NOT EXISTS mailbox_history_cycle (
    account_id TEXT PRIMARY KEY,
    start_history_id TEXT NOT NULL CHECK(
      length(start_history_id) BETWEEN 1 AND 32 AND
      start_history_id NOT GLOB '*[^0-9]*'
    ),
    next_page_token TEXT NOT NULL CHECK(
      length(CAST(next_page_token AS BLOB)) BETWEEN 1 AND 2048
    ),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS mailbox_hydration_progress (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL
      CHECK(mailbox_id IN ('all', 'sent', 'spam', 'starred', 'trash')),
    thread_generation INTEGER NOT NULL CHECK(thread_generation > 0),
    observed_history_id TEXT NOT NULL CHECK(
      length(observed_history_id) BETWEEN 1 AND 32 AND
      observed_history_id NOT GLOB '*[^0-9]*'
    ),
    pages_completed INTEGER NOT NULL
      CHECK(pages_completed BETWEEN 0 AND 1000),
    listed_thread_count INTEGER NOT NULL
      CHECK(listed_thread_count BETWEEN 0 AND 1000000),
    crawl_complete INTEGER NOT NULL CHECK(crawl_complete IN (0, 1)),
    window_truncated INTEGER NOT NULL CHECK(window_truncated IN (0, 1)),
    post_crawl_history_id TEXT CHECK(
      post_crawl_history_id IS NULL OR (
        length(post_crawl_history_id) BETWEEN 1 AND 32 AND
        post_crawl_history_id NOT GLOB '*[^0-9]*'
      )
    ),
    PRIMARY KEY(account_id, mailbox_id),
    UNIQUE(account_id),
    FOREIGN KEY(account_id, mailbox_id)
      REFERENCES mailbox_sync_state(account_id, mailbox_id)
      ON DELETE CASCADE,
    CHECK(window_truncated = 0 OR crawl_complete = 1),
    CHECK(crawl_complete = 1 OR post_crawl_history_id IS NULL)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS mailbox_snapshot_metadata (
    account_id TEXT NOT NULL,
    mailbox_id TEXT NOT NULL
      CHECK(mailbox_id IN ('all', 'sent', 'spam', 'starred', 'trash')),
    thread_generation INTEGER NOT NULL CHECK(thread_generation > 0),
    listed_thread_count INTEGER NOT NULL
      CHECK(listed_thread_count BETWEEN 0 AND 1000000),
    window_truncated INTEGER NOT NULL CHECK(window_truncated IN (0, 1)),
    PRIMARY KEY(account_id, mailbox_id),
    FOREIGN KEY(account_id, mailbox_id)
      REFERENCES mailbox_sync_state(account_id, mailbox_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS mailbox_retry_cursor (
    account_id TEXT PRIMARY KEY,
    next_mailbox_index INTEGER NOT NULL
      CHECK(next_mailbox_index BETWEEN 0 AND ${MAIL_CACHE_HYDRATION_ORDER.length - 1}),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE
  ) STRICT;
`;

/**
 * Rollback-safe local header/preview index. Older runtimes ignore both tables.
 * FTS rows are rebuilt after every service start, so a rollback that changed
 * cached headers cannot leave stale search results behind.
 */
const SEARCH_SCHEMA_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS mail_search_fts USING fts5(
    account_id UNINDEXED,
    generation UNINDEXED,
    thread_id UNINDEXED,
    subject,
    participants,
    snippet,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS mail_search_state (
    account_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL CHECK(generation >= 0),
    indexed_through_rowid INTEGER NOT NULL CHECK(indexed_through_rowid >= 0),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    status TEXT NOT NULL CHECK(status IN ('building', 'ready')),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE,
    CHECK(generation > 0 OR status = 'ready')
  ) STRICT;
`;

/**
 * Rollback-safe scheduler state. The schema version intentionally stays at v1:
 * an older runtime can ignore this table and still open the message cache.
 */
const BACKGROUND_SYNC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS background_sync_control (
    account_id TEXT PRIMARY KEY,
    credential_version INTEGER
      CHECK(
        credential_version IS NULL OR
        credential_version BETWEEN 1 AND 9007199254740991
      ),
    failure_count INTEGER NOT NULL DEFAULT 0
      CHECK(failure_count BETWEEN 0 AND ${MAX_BACKGROUND_SYNC_FAILURES}),
    retry_at INTEGER CHECK(retry_at IS NULL OR retry_at >= 0),
    last_attempt_at INTEGER CHECK(last_attempt_at IS NULL OR last_attempt_at >= 0),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE,
    CHECK(
      (failure_count = 0 AND retry_at IS NULL) OR
      (failure_count > 0 AND retry_at IS NOT NULL)
    )
  ) STRICT;
`;

/**
 * Provider identity is separate from credentials: rotating a Gmail token must
 * not erase a valid snapshot, while changing an IMAP transport binding must
 * never reuse rows from the previous mailbox. The persisted credential-rebind
 * trigger makes an older rollback runtime fail closed if it edits an IMAP
 * account without understanding this additive table.
 */
const PROVIDER_CACHE_BINDING_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS provider_cache_binding (
    account_id TEXT PRIMARY KEY,
    provider_kind TEXT NOT NULL CHECK(provider_kind IN ('gmail', 'imap')),
    transport_binding_version INTEGER CHECK(
      transport_binding_version IS NULL OR
      transport_binding_version BETWEEN 1 AND 9007199254740991
    ),
    FOREIGN KEY(account_id) REFERENCES sync_state(account_id) ON DELETE CASCADE,
    CHECK(
      (provider_kind = 'gmail' AND transport_binding_version IS NULL) OR
      (provider_kind = 'imap' AND transport_binding_version IS NOT NULL)
    )
  ) STRICT;

  CREATE TRIGGER IF NOT EXISTS reset_imap_snapshot_on_legacy_credential_rebind
  AFTER UPDATE OF credential_version ON background_sync_control
  WHEN OLD.credential_version IS NOT NULL
    AND NEW.credential_version IS NOT NULL
    AND OLD.credential_version <> NEW.credential_version
    AND EXISTS(
      SELECT 1
        FROM provider_cache_binding
       WHERE account_id = OLD.account_id
         AND provider_kind = 'imap'
    )
  BEGIN
    DELETE FROM threads WHERE account_id = OLD.account_id;
    UPDATE sync_state
       SET active_generation = 0, staged_generation = NULL, history_id = NULL,
           initial_anchor_history_id = NULL, page_token = NULL,
           status = 'idle', last_successful_at = NULL, last_error_code = NULL
     WHERE account_id = OLD.account_id;
    DELETE FROM provider_cache_binding WHERE account_id = OLD.account_id;
    UPDATE background_sync_control
       SET failure_count = 0, retry_at = NULL, last_attempt_at = NULL
     WHERE account_id = OLD.account_id;
  END;
`;

export interface CachedProviderThread {
  readonly thread: MailThreadListItem;
  readonly messages: readonly CachedProviderMessage[];
  readonly inInbox: boolean;
  readonly mailboxes: readonly MailCacheMailbox[];
}

export interface CachedProviderMessage extends MailMessageDto {
  readonly rfcMessageId: string | null;
  readonly references: readonly string[];
  /** True when the message carries list or automated-mail headers. */
  readonly listMessage: boolean;
  /** Sender category computed at ingest; listMessage means not "people". */
  readonly category: MailThreadCategory;
  /** Provider size estimate in bytes; null when the provider omits one. */
  readonly sizeEstimate: number | null;
}

export interface MailReplyContext {
  readonly providerThreadId: string;
  readonly rfcMessageId: string | null;
  readonly references: readonly string[];
}

export interface MailCacheSyncState {
  readonly activeGeneration: number;
  readonly stagedGeneration: number | null;
  readonly historyId: string | null;
  readonly initialAnchorHistoryId: string | null;
  readonly pageToken: string | null;
  readonly status: MailSyncStatus;
  readonly lastSuccessfulAt: number | null;
}

export interface MailCacheBackgroundSyncState {
  readonly accountId: string;
  readonly credentialVersion: number | null;
  readonly syncStatus: MailSyncStatus;
  readonly failureCount: number;
  readonly retryAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastSuccessfulAt: number | null;
  readonly lastErrorCode: string | null;
}

export interface MailCacheBackgroundSyncHealth {
  readonly lastSuccessfulAt: number | null;
  readonly lastErrorCode: string | null;
}

export type MailCacheSyncAttempt =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly status: "backoff" | "reauth_required";
      readonly retryAt: number | null;
    };

interface MailboxHistoryCycle {
  readonly startHistoryId: string;
  readonly nextPageToken: string;
}

export interface MailboxHydrationState {
  readonly mailboxId: MailCacheHydratableMailbox;
  readonly activeGeneration: number;
  readonly stagedGeneration: number | null;
  readonly activeObservedHistoryId: string | null;
  readonly hydrationObservedHistoryId: string | null;
  readonly initialAnchorHistoryId: string | null;
  readonly pageToken: string | null;
  readonly status:
    | "uninitialized"
    | "syncing"
    | "idle"
    | "backoff"
    | "reauth_required";
  readonly lastSuccessfulAt: number | null;
  readonly pagesCompleted: number;
  readonly listedThreadCount: number;
  readonly crawlComplete: boolean;
  readonly windowTruncated: boolean;
  readonly postCrawlHistoryId: string | null;
  readonly activeListedThreadCount: number | null;
  readonly activeWindowTruncated: boolean;
}

export type MailCacheMailboxUnavailableReason =
  | "global_syncing"
  | "mailbox_uninitialized"
  | "mailbox_syncing"
  | "mailbox_backoff"
  | "mailbox_cache_capacity"
  | "mailbox_reauth_required"
  | "history_mismatch";

export type MailCacheMailboxAvailability =
  | {
      readonly status: "available";
      readonly activeGeneration: number;
      readonly observedHistoryId: string;
      readonly lastSuccessfulAt: number;
      readonly windowTruncated: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: MailCacheMailboxUnavailableReason;
      readonly lastSuccessfulAt: number | null;
      readonly windowTruncated: null;
    };

export interface MailCacheMailboxThreadPage {
  readonly apiVersion: 1;
  readonly mailboxId: MailCacheMailbox;
  readonly items: readonly MailThreadListItem[];
  readonly nextCursor: string | null;
  readonly availability: MailCacheMailboxAvailability;
}

interface MailCacheSearchState {
  readonly generation: number;
  readonly indexedThroughRowid: number;
  readonly revision: number;
  readonly status: "building" | "ready";
}

export interface MailCachePendingThreadRefresh {
  readonly threadId: string;
  readonly queuedAt: number;
}

export type MailCacheIncrementalChange =
  | { readonly kind: "upsert"; readonly value: CachedProviderThread }
  | { readonly kind: "delete"; readonly threadId: string };

export type MailCachePendingRefreshChange =
  | {
      readonly kind: "upsert";
      readonly queuedAt: number;
      readonly value: CachedProviderThread;
    }
  | {
      readonly kind: "delete";
      readonly queuedAt: number;
      readonly threadId: string;
    };

/**
 * Rebuildable cache for one account. It intentionally lives below
 * cache/<accountId>, so the existing account disconnect rename makes every
 * cached row unreachable before slow physical deletion begins.
 */
export class SqliteMailMessageCache {
  private readonly accountId: string;
  private readonly cacheRoot: string;
  private readonly accountDirectory: string;
  private readonly databasePath: string;
  private database: DatabaseSync | null = null;
  private autoVacuumIncremental = false;

  constructor(options: { readonly cacheRoot: string; readonly accountId: string }) {
    this.accountId = validateAccountId(options.accountId);
    this.cacheRoot = requireAbsolutePath(options.cacheRoot);
    this.accountDirectory = path.join(this.cacheRoot, this.accountId);
    this.databasePath = path.join(this.accountDirectory, "messages.sqlite3");
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    await ensurePrivateDirectory(this.cacheRoot);
    await mkdir(this.accountDirectory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(this.accountDirectory);
    await assertContainedPath(this.cacheRoot, this.accountDirectory);
    await ensurePrivateDatabaseFile(this.databasePath);
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(this.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
      // auto_vacuum must be decided before journal_mode = WAL initializes the
      // database header, or the setting silently stays NONE.
      this.configureAutoVacuum(database);
      database.exec(`
        PRAGMA trusted_schema = OFF;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
      `);
      this.initializeSchema(database);
      await ensureSqliteFilesPrivate(this.databasePath);
      this.database = database;
      database = null;
    } catch (error) {
      database?.close();
      this.database = null;
      throw cacheError(error);
    }
  }

  close(): void {
    const database = this.database;
    if (!database) return;
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
      this.database = null;
    }
  }

  /**
   * auto_vacuum can only move off NONE before the first table exists, so it is
   * enabled here for new databases only. An existing database that predates
   * this pragma keeps auto_vacuum = NONE until its file is rebuilt; for those,
   * releaseFreePages() stays a no-op and admission still subtracts freelist
   * pages, so a stale high-water mark cannot wedge writes.
   */
  private configureAutoVacuum(database: DatabaseSync): void {
    const schemaObjects = database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_schema")
      .get()?.count;
    if (!Number.isSafeInteger(schemaObjects)) {
      throw new MailCacheError("mail_cache_invalid");
    }
    if ((schemaObjects as number) === 0) {
      database.exec("PRAGMA auto_vacuum = INCREMENTAL");
    }
    const mode = database.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum;
    this.autoVacuumIncremental = mode === 2;
  }

  readSyncState(): MailCacheSyncState {
    const row = this.requireDatabase()
      .prepare(
        `SELECT active_generation, staged_generation, history_id,
                initial_anchor_history_id, page_token, status, last_successful_at
           FROM sync_state WHERE account_id = ?`,
      )
      .get(this.accountId);
    return validateSyncStateRow(row);
  }

  bindBackgroundSyncCredential(
    credentialVersion: number,
    now: number,
  ): void {
    const version = validateCredentialVersion(credentialVersion);
    const timestamp = validateTimestamp(now);
    this.transaction(() => {
      const database = this.requireDatabase();
      const current = readBackgroundSyncRow(database, this.accountId);
      if (current.credentialVersion === null) {
        database
          .prepare(
            `UPDATE background_sync_control
                SET credential_version = ?
              WHERE account_id = ?`,
          )
          .run(version, this.accountId);
        return;
      }
      if (current.credentialVersion === version) return;
      database
        .prepare(
          `UPDATE background_sync_control
              SET credential_version = ?, failure_count = 0, retry_at = NULL,
                  last_attempt_at = NULL
            WHERE account_id = ?`,
        )
        .run(version, this.accountId);
      this.restoreSyncStatuses(database);
      // Validate the supplied timestamp even though a credential reset should
      // be immediately eligible and therefore has no persisted attempt time.
      void timestamp;
    });
  }

  /**
   * Binds rebuildable rows to the provider mailbox that produced them. The
   * first Gmail binding preserves an existing pre-migration cache; the first
   * IMAP binding preserves only a genuinely empty cache because IMAP receive
   * was unavailable before this table existed.
   */
  bindProviderCacheIdentity(input: {
    readonly providerKind: "gmail" | "imap";
    readonly transportBindingVersion: number | null;
  }): { readonly reset: boolean } {
    const providerKind = input.providerKind;
    const transportBindingVersion =
      input.transportBindingVersion === null
        ? null
        : validateCredentialVersion(input.transportBindingVersion);
    if (
      (providerKind === "gmail" && transportBindingVersion !== null) ||
      (providerKind === "imap" && transportBindingVersion === null)
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return this.transaction(() => {
      const database = this.requireDatabase();
      const rows = database
        .prepare(
          `SELECT provider_kind, transport_binding_version
             FROM provider_cache_binding
            WHERE account_id = ?`,
        )
        .all(this.accountId);
      if (rows.length > 1) throw new MailCacheError("mail_cache_invalid");
      const current = rows[0];
      const incompleteReplyTo =
        providerKind === "gmail" &&
        database
          .prepare(
            `SELECT 1 AS incomplete
               FROM messages
              WHERE account_id = ? AND reply_to_complete = 0
              LIMIT 1`,
          )
          .get(this.accountId) !== undefined;
      if (
        current &&
        current.provider_kind === providerKind &&
        current.transport_binding_version === transportBindingVersion &&
        !incompleteReplyTo
      ) {
        return Object.freeze({ reset: false });
      }
      let reset = current !== undefined || incompleteReplyTo;
      if (!current && providerKind === "imap") {
        const state = this.readSyncState();
        reset =
          state.activeGeneration > 0 ||
          state.stagedGeneration !== null ||
          state.historyId !== null ||
          state.initialAnchorHistoryId !== null ||
          state.pageToken !== null ||
          state.status !== "idle" ||
          state.lastSuccessfulAt !== null;
      }
      if (reset) this.resetProviderSnapshot(database);
      database
        .prepare(
          `INSERT INTO provider_cache_binding(
             account_id, provider_kind, transport_binding_version
           ) VALUES (?, ?, ?)`,
        )
        .run(this.accountId, providerKind, transportBindingVersion);
      return Object.freeze({ reset });
    });
  }

  readBackgroundSyncState(): MailCacheBackgroundSyncState {
    return readBackgroundSyncRow(this.requireDatabase(), this.accountId);
  }

  readBackgroundSyncHealth(): MailCacheBackgroundSyncHealth {
    const database = this.requireDatabase();
    const global = readBackgroundSyncRow(database, this.accountId);
    const rows = database
      .prepare(
        `SELECT mailbox_id, last_successful_at, last_error_code
           FROM mailbox_sync_state
          WHERE account_id = ?
          ORDER BY mailbox_id ASC`,
      )
      .all(this.accountId);
    if (rows.length !== MAIL_CACHE_MAILBOXES.length) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const seen = new Set<MailCacheMailbox>();
    const successful = [global.lastSuccessfulAt];
    const errors: Array<string | null> = [global.lastErrorCode];
    for (const row of rows) {
      if (
        typeof row.mailbox_id !== "string" ||
        !MAIL_CACHE_MAILBOXES.includes(row.mailbox_id as MailCacheMailbox) ||
        seen.has(row.mailbox_id as MailCacheMailbox) ||
        (row.last_successful_at !== null &&
          (!Number.isSafeInteger(row.last_successful_at) ||
            (row.last_successful_at as number) < 0)) ||
        (row.last_error_code !== null &&
          (typeof row.last_error_code !== "string" ||
            !/^[a-z][a-z0-9_]{0,63}$/.test(row.last_error_code)))
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      seen.add(row.mailbox_id as MailCacheMailbox);
      successful.push(row.last_successful_at as number | null);
      errors.push(row.last_error_code as string | null);
    }
    const completed = successful.filter(
      (value): value is number => value !== null,
    );
    return Object.freeze({
      lastSuccessfulAt:
        global.lastSuccessfulAt === null
          ? null
          : Math.min(...completed),
      lastErrorCode: selectWorstMailSyncError(errors),
    });
  }

  beginSyncAttempt(now: number): MailCacheSyncAttempt {
    const timestamp = validateTimestamp(now);
    return this.transaction(() => {
      const database = this.requireDatabase();
      const state = readBackgroundSyncRow(database, this.accountId);
      if (state.syncStatus === "reauth_required") {
        return Object.freeze({
          allowed: false as const,
          status: "reauth_required" as const,
          retryAt: null,
        });
      }
      if (
        state.failureCount > 0 &&
        state.retryAt !== null &&
        state.retryAt > timestamp
      ) {
        return Object.freeze({
          allowed: false as const,
          status: "backoff" as const,
          retryAt: state.retryAt,
        });
      }
      if (state.syncStatus === "backoff" || state.failureCount > 0) {
        this.restoreSyncStatuses(database);
      }
      database
        .prepare(
          `UPDATE background_sync_control
              SET last_attempt_at = ?
            WHERE account_id = ?`,
        )
        .run(timestamp, this.accountId);
      return Object.freeze({ allowed: true as const });
    });
  }

  recordSyncFailure(input: {
    readonly now: number;
    readonly errorCode: string;
    readonly retryAfterMs: number | null;
  }): void {
    const now = validateTimestamp(input.now);
    const code = validateErrorCode(input.errorCode);
    const retryAfterMs = validateOptionalBackoffDelay(input.retryAfterMs);
    this.transaction(() => {
      const database = this.requireDatabase();
      const current = readBackgroundSyncRow(database, this.accountId);
      const failureCount = Math.min(
        current.failureCount + 1,
        MAX_BACKGROUND_SYNC_FAILURES,
      );
      const exponentialMs = Math.min(
        BACKGROUND_SYNC_BASE_BACKOFF_MS *
          2 ** Math.min(failureCount - 1, 6),
        BACKGROUND_SYNC_MAX_BACKOFF_MS,
      );
      const delayMs = Math.min(
        BACKGROUND_SYNC_MAX_BACKOFF_MS,
        Math.max(exponentialMs, retryAfterMs ?? 0),
      );
      const retryAt = now + delayMs;
      validateTimestamp(retryAt);
      database
        .prepare(
          `UPDATE sync_state
              SET status = 'backoff', last_error_code = ?
            WHERE account_id = ?`,
        )
        .run(code, this.accountId);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET status = 'backoff', last_error_code = ?
            WHERE account_id = ?
              AND (mailbox_id = 'inbox' OR active_thread_generation > 0)`,
        )
        .run(code, this.accountId);
      database
        .prepare(
          `UPDATE background_sync_control
              SET failure_count = ?, retry_at = ?
            WHERE account_id = ?`,
        )
        .run(failureCount, retryAt, this.accountId);
    });
  }

  recordSyncSuccess(): void {
    this.transaction(() => {
      this.requireDatabase()
        .prepare(
          `UPDATE background_sync_control
              SET failure_count = 0, retry_at = NULL
            WHERE account_id = ?`,
        )
        .run(this.accountId);
    });
  }

  beginInitial(anchorHistoryId: string): number {
    const anchor = validateHistoryId(anchorHistoryId);
    const database = this.requireDatabase();
    const staged = this.transaction(() => {
      const state = this.readSyncState();
      this.clearMailboxHistoryCycle(this.requireDatabase());
      this.resetAllMailboxHydrationsInDatabase(this.requireDatabase());
      if (
        state.stagedGeneration !== null &&
        state.initialAnchorHistoryId === anchor
      ) {
        this.prepareMailboxInitialGeneration(
          state.activeGeneration,
          state.stagedGeneration,
          anchor,
          state.historyId,
          state.lastSuccessfulAt,
          state.pageToken,
        );
        return state.stagedGeneration;
      }
      const generation = state.activeGeneration + 1;
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new MailCacheError("mail_cache_unavailable");
      }
      database
        .prepare(
          "DELETE FROM threads WHERE account_id = ? AND generation = ?",
        )
        .run(this.accountId, generation);
      this.deleteUnreferencedThreadGenerations(database, [state.activeGeneration]);
      database
        .prepare(
          `UPDATE sync_state
              SET staged_generation = ?, initial_anchor_history_id = ?,
                  page_token = NULL, status = 'syncing', last_error_code = NULL
            WHERE account_id = ?`,
        )
        .run(generation, anchor, this.accountId);
      this.prepareMailboxInitialGeneration(
        state.activeGeneration,
        generation,
        anchor,
        state.historyId,
        state.lastSuccessfulAt,
        null,
      );
      return generation;
    });
    this.releaseFreePages();
    return staged;
  }

  resumeInitial(): number {
    return this.transaction(() => {
      const state = this.readSyncState();
      if (
        state.stagedGeneration === null ||
        state.initialAnchorHistoryId === null
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      this.clearMailboxHistoryCycle(this.requireDatabase());
      this.requireDatabase()
        .prepare(
          "UPDATE sync_state SET status = 'syncing', last_error_code = NULL WHERE account_id = ?",
        )
        .run(this.accountId);
      this.prepareMailboxInitialGeneration(
        state.activeGeneration,
        state.stagedGeneration,
        state.initialAnchorHistoryId,
        state.historyId,
        state.lastSuccessfulAt,
        state.pageToken,
      );
      return state.stagedGeneration;
    });
  }

  putInitialPage(
    generation: number,
    threads: readonly CachedProviderThread[],
    expectedPageToken: string | null,
    nextPageToken: string | null,
  ): void {
    const expectedToken = validateOptionalPageToken(expectedPageToken);
    const token = validateOptionalPageToken(nextPageToken);
    this.assertCacheAdmission(threads);
    this.transaction(() => {
      const state = this.readSyncState();
      if (
        state.status !== "syncing" ||
        state.stagedGeneration !== generation ||
        state.initialAnchorHistoryId === null ||
        state.pageToken !== expectedToken
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      this.clearMailboxHistoryCycle(this.requireDatabase());
      for (const thread of threads) this.upsertThread(generation, thread);
      this.requireDatabase()
        .prepare("UPDATE sync_state SET page_token = ? WHERE account_id = ?")
        .run(token, this.accountId);
      this.requireDatabase()
        .prepare(
          `UPDATE mailbox_sync_state
              SET page_token = ?, last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = 'inbox'`,
        )
        .run(token, this.accountId);
    });
  }

  completeInitial(generation: number, now: number): void {
    const timestamp = validateTimestamp(now);
    const database = this.requireDatabase();
    this.transaction(() => {
      const state = this.readSyncState();
      if (
        state.stagedGeneration !== generation ||
        state.initialAnchorHistoryId === null ||
        state.pageToken !== null
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      this.clearMailboxHistoryCycle(database);
      database
        .prepare(
          `UPDATE sync_state
              SET active_generation = ?, staged_generation = NULL,
                  history_id = initial_anchor_history_id,
                  initial_anchor_history_id = NULL, page_token = NULL,
                  status = 'idle', last_successful_at = ?, last_error_code = NULL
            WHERE account_id = ?`,
        )
        .run(generation, timestamp, this.accountId);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = ?, initial_anchor_history_id = NULL,
                  page_token = NULL, status = 'idle', last_successful_at = ?,
                  last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = 'inbox'`,
        )
        .run(
          generation,
          state.initialAnchorHistoryId,
          timestamp,
          this.accountId,
        );
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET staged_thread_generation = ?, observed_history_id = NULL,
                  initial_anchor_history_id = NULL, page_token = NULL,
                  status = 'uninitialized', last_successful_at = NULL,
                  last_error_code = NULL
            WHERE account_id = ? AND mailbox_id <> 'inbox'
              AND active_thread_generation = 0`,
        )
        .run(generation, this.accountId);
      this.deleteUnreferencedMailboxMemberships(database);
      this.deleteUnreferencedThreadGenerations(database, [generation]);
      this.resetSearchIndex(database, generation);
    });
    this.releaseFreePages();
  }

  applyIncrementalPage(input: {
    readonly expectedHistoryId: string;
    readonly expectedPageToken: string | null;
    readonly changes: readonly MailCacheIncrementalChange[];
    readonly nextPageToken: string | null;
    readonly resultingHistoryId: string;
    readonly now: number;
  }): void {
    const expected = validateHistoryId(input.expectedHistoryId);
    const expectedToken = validateOptionalPageToken(input.expectedPageToken);
    const resulting = validateHistoryId(input.resultingHistoryId);
    const token = validateOptionalPageToken(input.nextPageToken);
    const now = validateTimestamp(input.now);
    this.assertCacheAdmission(
      input.changes.flatMap((change) =>
        change.kind === "upsert" ? [change.value] : [],
      ),
    );
    this.transaction(() => {
      const state = this.readSyncState();
      const database = this.requireDatabase();
      if (
        state.activeGeneration < 1 ||
        state.historyId !== expected ||
        state.stagedGeneration !== null ||
        state.pageToken !== expectedToken
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      const historyCycle = this.readMailboxHistoryCycle(database);
      const matchingHistoryCycle =
        expectedToken !== null &&
        historyCycle?.startHistoryId === expected &&
        historyCycle.nextPageToken === expectedToken;
      this.queueHydrationRefreshes(database, input.changes, now);
      for (const change of input.changes) {
        if (change.kind === "upsert") {
          this.upsertThread(state.activeGeneration, change.value);
        } else {
          const threadId = validateProviderId(change.threadId);
          this.deleteSearchThread(
            database,
            state.activeGeneration,
            threadId,
          );
          database
            .prepare(
              "DELETE FROM threads WHERE account_id = ? AND generation = ? AND thread_id = ?",
            )
            .run(this.accountId, state.activeGeneration, threadId);
        }
      }
      database
        .prepare(
          `UPDATE sync_state
              SET page_token = ?, history_id = ?, status = ?,
                  last_successful_at = CASE WHEN ? IS NULL THEN ? ELSE last_successful_at END,
                  last_error_code = NULL
            WHERE account_id = ?`,
        )
        .run(
          token,
          token === null ? resulting : expected,
          token === null ? "idle" : "syncing",
          token,
          now,
          this.accountId,
        );
      if (token === null) {
        if (expectedToken === null || matchingHistoryCycle) {
          database
            .prepare(
              `UPDATE mailbox_sync_state
                  SET observed_history_id = ?, status = 'idle',
                      last_successful_at = ?, last_error_code = NULL
                WHERE account_id = ? AND mailbox_id <> 'inbox'
                  AND active_thread_generation = ?
                  AND staged_thread_generation IS NULL
                  AND status <> 'uninitialized'
                  AND observed_history_id = ?`,
            )
            .run(
              resulting,
              now,
              this.accountId,
              state.activeGeneration,
              expected,
            );
          database
            .prepare(
              `UPDATE mailbox_hydration_progress
                  SET observed_history_id = ?, post_crawl_history_id = NULL
                WHERE account_id = ? AND observed_history_id = ?
                  AND thread_generation = ?`,
            )
            .run(
              resulting,
              this.accountId,
              expected,
              state.activeGeneration,
            );
        }
        database
          .prepare(
            `UPDATE mailbox_sync_state
                SET active_thread_generation = ?, staged_thread_generation = NULL,
                    observed_history_id = ?, initial_anchor_history_id = NULL,
                    page_token = NULL, status = 'idle', last_successful_at = ?,
                    last_error_code = NULL
              WHERE account_id = ? AND mailbox_id = 'inbox'
                AND active_thread_generation = ?
                AND observed_history_id = ?`,
          )
          .run(
            state.activeGeneration,
            resulting,
            now,
            this.accountId,
            state.activeGeneration,
            expected,
          );
        this.clearMailboxHistoryCycle(database);
      } else if (expectedToken === null) {
        this.startMailboxHistoryCycle(database, expected, token);
      } else if (matchingHistoryCycle) {
        if (
          !this.continueMailboxHistoryCycle(
            database,
            expected,
            expectedToken,
            token,
          )
        ) {
          this.clearMailboxHistoryCycle(database);
        }
      } else {
        // An older runtime may have processed an earlier page. Never create a
        // proof marker in the middle of a History cycle.
        this.clearMailboxHistoryCycle(database);
      }
    });
  }

  readMailboxHydrationStates(): readonly MailboxHydrationState[] {
    return Object.freeze(
      MAIL_CACHE_HYDRATION_ORDER.map((mailbox) =>
        this.readMailboxHydrationState(this.requireDatabase(), mailbox),
      ),
    );
  }

  selectFailedMailboxForRetry(
    candidates: readonly MailCacheHydratableMailbox[],
  ): MailCacheHydratableMailbox | null {
    const failed = validateMailboxRetryCandidates(candidates);
    if (failed.length === 0) return null;
    return this.transaction(() => {
      const database = this.requireDatabase();
      for (const mailbox of failed) {
        const state = this.readMailboxHydrationState(database, mailbox);
        if (
          state.stagedGeneration !== null ||
          (state.status !== "backoff" && state.status !== "reauth_required")
        ) {
          throw new MailCacheError("mail_sync_stale");
        }
      }
      const row = database
        .prepare(
          `SELECT next_mailbox_index
             FROM mailbox_retry_cursor
            WHERE account_id = ?`,
        )
        .get(this.accountId);
      const startIndex = row
        ? validateMailboxRetryIndex(row.next_mailbox_index)
        : 0;
      const failedSet = new Set(failed);
      let selectedIndex = -1;
      for (let offset = 0; offset < MAIL_CACHE_HYDRATION_ORDER.length; offset += 1) {
        const index = (startIndex + offset) % MAIL_CACHE_HYDRATION_ORDER.length;
        const candidate = MAIL_CACHE_HYDRATION_ORDER[index];
        if (candidate !== undefined && failedSet.has(candidate)) {
          selectedIndex = index;
          break;
        }
      }
      if (selectedIndex < 0) throw new MailCacheError("mail_cache_invalid");
      const selected = MAIL_CACHE_HYDRATION_ORDER[selectedIndex];
      if (selected === undefined) throw new MailCacheError("mail_cache_invalid");
      database
        .prepare(
          `INSERT INTO mailbox_retry_cursor(account_id, next_mailbox_index)
           VALUES (?, ?)
           ON CONFLICT(account_id) DO UPDATE SET
             next_mailbox_index = excluded.next_mailbox_index`,
        )
        .run(
          this.accountId,
          (selectedIndex + 1) % MAIL_CACHE_HYDRATION_ORDER.length,
        );
      return selected;
    });
  }

  beginOrResumeMailboxHydration(
    mailbox: MailCacheHydratableMailbox,
  ): MailboxHydrationState | null {
    const target = validateHydratableMailboxId(mailbox);
    return this.transaction(() => {
      const database = this.requireDatabase();
      const global = this.readSyncState();
      if (
        global.activeGeneration < 1 ||
        global.stagedGeneration !== null ||
        global.historyId === null ||
        global.initialAnchorHistoryId !== null ||
        global.pageToken !== null ||
        global.status !== "idle"
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      const progressRows = database
        .prepare(
          `SELECT mailbox_id
             FROM mailbox_hydration_progress
            WHERE account_id = ?`,
        )
        .all(this.accountId);
      if (
        progressRows.length > 1 ||
        (progressRows.length === 1 && progressRows[0]?.mailbox_id !== target)
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      let current = this.readMailboxHydrationState(database, target);
      if (progressRows.length === 1) {
        if (
          current.stagedGeneration !== global.activeGeneration ||
          current.hydrationObservedHistoryId !== global.historyId ||
          current.initialAnchorHistoryId === null
        ) {
          this.resetMailboxHydrationInDatabase(database, target);
        } else {
          database
            .prepare(
              `UPDATE mailbox_sync_state
                  SET status = 'syncing', last_error_code = NULL
                WHERE account_id = ? AND mailbox_id = ?`,
            )
            .run(this.accountId, target);
          return this.readMailboxHydrationState(database, target);
        }
      }
      current = this.readMailboxHydrationState(database, target);
      if (
        current.stagedGeneration === null &&
        (current.status === "backoff" || current.status === "reauth_required")
      ) {
        return null;
      }
      if (
        current.activeGeneration === global.activeGeneration &&
        current.stagedGeneration === null &&
        current.activeObservedHistoryId === global.historyId &&
        current.status === "idle"
      ) {
        return null;
      }
      if (current.activeGeneration === global.activeGeneration) {
        database
          .prepare(
            `DELETE FROM thread_mailboxes
              WHERE account_id = ? AND mailbox_id = ?
                AND generation = ?`,
          )
          .run(this.accountId, target, global.activeGeneration);
        database
          .prepare(
            `DELETE FROM mailbox_snapshot_metadata
              WHERE account_id = ? AND mailbox_id = ?`,
          )
          .run(this.accountId, target);
        database
          .prepare(
            `UPDATE mailbox_sync_state
                SET active_thread_generation = 0,
                    staged_thread_generation = NULL,
                    observed_history_id = NULL,
                    initial_anchor_history_id = NULL,
                    page_token = NULL, status = 'uninitialized',
                    last_successful_at = NULL, last_error_code = NULL
              WHERE account_id = ? AND mailbox_id = ?`,
          )
          .run(this.accountId, target);
        current = this.readMailboxHydrationState(database, target);
      }
      if (
        current.activeGeneration > global.activeGeneration ||
        (current.stagedGeneration !== null &&
          current.stagedGeneration !== global.activeGeneration)
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      database
        .prepare(
          `DELETE FROM thread_mailboxes
            WHERE account_id = ? AND mailbox_id = ? AND generation = ?`,
        )
        .run(this.accountId, target, global.activeGeneration);
      database
        .prepare("DELETE FROM pending_thread_refresh WHERE account_id = ?")
        .run(this.accountId);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET staged_thread_generation = ?, initial_anchor_history_id = ?,
                  page_token = NULL, status = 'syncing',
                  last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(global.activeGeneration, global.historyId, this.accountId, target);
      database
        .prepare(
          `INSERT INTO mailbox_hydration_progress(
             account_id, mailbox_id, thread_generation, observed_history_id,
             pages_completed, listed_thread_count, crawl_complete,
             window_truncated, post_crawl_history_id
           ) VALUES (?, ?, ?, ?, 0, 0, 0, 0, NULL)`,
        )
        .run(this.accountId, target, global.activeGeneration, global.historyId);
      return this.readMailboxHydrationState(database, target);
    });
  }

  putMailboxHydrationPage(input: {
    readonly mailboxId: MailCacheHydratableMailbox;
    readonly generation: number;
    readonly expectedPageToken: string | null;
    readonly threads: readonly CachedProviderThread[];
    readonly listedCount: number;
    readonly nextPageToken: string | null;
  }): MailboxHydrationState {
    const mailbox = validateHydratableMailboxId(input.mailboxId);
    validateGeneration(input.generation);
    const generation = input.generation;
    const expectedToken = validateOptionalPageToken(input.expectedPageToken);
    const nextToken = validateOptionalPageToken(input.nextPageToken);
    const listedCount = validateMailboxHydrationPageCount(input.listedCount);
    if (
      input.threads.length > listedCount ||
      new Set(input.threads.map((thread) => thread.thread.threadId)).size !==
        input.threads.length ||
      (nextToken !== null && nextToken === expectedToken)
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    this.assertCacheAdmission(input.threads);
    return this.transaction(() => {
      const database = this.requireDatabase();
      const global = this.readSyncState();
      const state = this.readMailboxHydrationState(database, mailbox);
      if (
        global.activeGeneration !== generation ||
        global.stagedGeneration !== null ||
        global.historyId === null ||
        state.stagedGeneration !== generation ||
        state.initialAnchorHistoryId === null ||
        state.pageToken !== expectedToken ||
        state.status !== "syncing" ||
        state.crawlComplete
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      const pagesCompleted = state.pagesCompleted + 1;
      const listedThreadCount = state.listedThreadCount + listedCount;
      const threadWindow =
        mailbox === "all"
          ? MAX_ALL_MAIL_HYDRATION_THREADS
          : MAX_MAILBOX_HYDRATION_THREADS;
      if (
        pagesCompleted > MAX_MAILBOX_HYDRATION_PAGES ||
        listedThreadCount > threadWindow
      ) {
        throw new MailCacheError("mail_cache_capacity");
      }
      for (const thread of input.threads) {
        this.upsertThread(generation, thread, mailbox);
      }
      const reachedWindow =
        nextToken !== null &&
        (pagesCompleted === MAX_MAILBOX_HYDRATION_PAGES ||
          listedThreadCount === threadWindow);
      const crawlComplete = nextToken === null || reachedWindow;
      const persistedToken = crawlComplete ? null : nextToken;
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET page_token = ?, status = 'syncing', last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(persistedToken, this.accountId, mailbox);
      database
        .prepare(
          `UPDATE mailbox_hydration_progress
              SET pages_completed = ?, listed_thread_count = ?,
                  crawl_complete = ?, window_truncated = ?,
                  post_crawl_history_id = NULL
            WHERE account_id = ? AND mailbox_id = ?
              AND thread_generation = ?`,
        )
        .run(
          pagesCompleted,
          listedThreadCount,
          crawlComplete ? 1 : 0,
          reachedWindow ? 1 : 0,
          this.accountId,
          mailbox,
          generation,
        );
      return this.readMailboxHydrationState(database, mailbox);
    });
  }

  markPostCrawlHistoryObserved(
    mailboxId: MailCacheHydratableMailbox,
  ): boolean {
    const mailbox = validateHydratableMailboxId(mailboxId);
    return this.transaction(() => {
      const database = this.requireDatabase();
      const global = this.readSyncState();
      const state = this.readMailboxHydrationState(database, mailbox);
      if (
        global.activeGeneration < 1 ||
        global.stagedGeneration !== null ||
        global.historyId === null ||
        global.pageToken !== null ||
        global.status !== "idle" ||
        state.stagedGeneration !== global.activeGeneration ||
        !state.crawlComplete ||
        state.hydrationObservedHistoryId !== global.historyId
      ) {
        return false;
      }
      const result = database
        .prepare(
          `UPDATE mailbox_hydration_progress
              SET post_crawl_history_id = ?
            WHERE account_id = ? AND mailbox_id = ?
              AND thread_generation = ? AND crawl_complete = 1
              AND observed_history_id = ?`,
        )
        .run(
          global.historyId,
          this.accountId,
          mailbox,
          global.activeGeneration,
          global.historyId,
        );
      return result.changes === 1;
    });
  }

  readPendingThreadRefreshes(
    limit: number,
  ): readonly MailCachePendingThreadRefresh[] {
    const safeLimit = validatePendingRefreshLimit(limit);
    const rows = this.requireDatabase()
      .prepare(
        `SELECT thread_id, queued_at
           FROM pending_thread_refresh
          WHERE account_id = ?
          ORDER BY queued_at ASC, thread_id ASC
          LIMIT ?`,
      )
      .all(this.accountId, safeLimit);
    return Object.freeze(
      rows.map((row) => {
        if (
          typeof row.thread_id !== "string" ||
          !Number.isSafeInteger(row.queued_at)
        ) {
          throw new MailCacheError("mail_cache_invalid");
        }
        return Object.freeze({
          threadId: validateProviderId(row.thread_id),
          queuedAt: validateTimestamp(row.queued_at as number),
        });
      }),
    );
  }

  applyPendingThreadRefreshes(input: {
    readonly mailboxId: MailCacheHydratableMailbox;
    readonly generation: number;
    readonly expectedHistoryId: string;
    readonly changes: readonly MailCachePendingRefreshChange[];
  }): number {
    const mailbox = validateHydratableMailboxId(input.mailboxId);
    validateGeneration(input.generation);
    const generation = input.generation;
    const expectedHistoryId = validateHistoryId(input.expectedHistoryId);
    if (
      input.changes.length > MAX_PENDING_THREAD_REFRESH_PAGE ||
      new Set(
        input.changes.map((change) =>
          change.kind === "upsert"
            ? change.value.thread.threadId
            : change.threadId,
        ),
      ).size !== input.changes.length
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    this.assertCacheAdmission(
      input.changes.flatMap((change) =>
        change.kind === "upsert" ? [change.value] : [],
      ),
    );
    return this.transaction(() => {
      const database = this.requireDatabase();
      const global = this.readSyncState();
      const state = this.readMailboxHydrationState(database, mailbox);
      if (
        global.activeGeneration !== generation ||
        global.stagedGeneration !== null ||
        global.historyId !== expectedHistoryId ||
        global.pageToken !== null ||
        global.status !== "idle" ||
        state.stagedGeneration !== generation ||
        !state.crawlComplete ||
        state.hydrationObservedHistoryId !== expectedHistoryId ||
        state.postCrawlHistoryId !== expectedHistoryId
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      const deletePending = database.prepare(
        `DELETE FROM pending_thread_refresh
          WHERE account_id = ? AND thread_id = ? AND queued_at = ?`,
      );
      for (const change of input.changes) {
        const queuedAt = validateTimestamp(change.queuedAt);
        const threadId =
          change.kind === "upsert"
            ? validateProviderId(change.value.thread.threadId)
            : validateProviderId(change.threadId);
        const queued = database
          .prepare(
            `SELECT queued_at
               FROM pending_thread_refresh
              WHERE account_id = ? AND thread_id = ?`,
          )
          .get(this.accountId, threadId);
        if (queued?.queued_at !== queuedAt) {
          throw new MailCacheError("mail_sync_stale");
        }
        if (change.kind === "upsert") {
          this.upsertThread(generation, change.value, mailbox);
        } else {
          this.removeHydrationMailboxMembership(
            generation,
            mailbox,
            threadId,
          );
        }
        if (deletePending.run(this.accountId, threadId, queuedAt).changes !== 1) {
          throw new MailCacheError("mail_sync_stale");
        }
      }
      const remaining = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM pending_thread_refresh
            WHERE account_id = ?`,
        )
        .get(this.accountId)?.count;
      if (!Number.isSafeInteger(remaining)) {
        throw new MailCacheError("mail_cache_invalid");
      }
      return remaining as number;
    });
  }

  completeMailboxHydration(input: {
    readonly mailboxId: MailCacheHydratableMailbox;
    readonly generation: number;
    readonly expectedHistoryId: string;
    readonly now: number;
  }): void {
    const mailbox = validateHydratableMailboxId(input.mailboxId);
    validateGeneration(input.generation);
    const generation = input.generation;
    const expectedHistoryId = validateHistoryId(input.expectedHistoryId);
    const now = validateTimestamp(input.now);
    this.transaction(() => {
      const database = this.requireDatabase();
      const global = this.readSyncState();
      const state = this.readMailboxHydrationState(database, mailbox);
      const pendingCount = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM pending_thread_refresh
            WHERE account_id = ?`,
        )
        .get(this.accountId)?.count;
      if (
        !Number.isSafeInteger(pendingCount) ||
        pendingCount !== 0 ||
        global.activeGeneration !== generation ||
        global.stagedGeneration !== null ||
        global.historyId !== expectedHistoryId ||
        global.pageToken !== null ||
        global.status !== "idle" ||
        state.stagedGeneration !== generation ||
        state.initialAnchorHistoryId === null ||
        state.pageToken !== null ||
        state.status !== "syncing" ||
        !state.crawlComplete ||
        state.hydrationObservedHistoryId !== expectedHistoryId ||
        state.postCrawlHistoryId !== expectedHistoryId
      ) {
        throw new MailCacheError("mail_sync_stale");
      }
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = ?, staged_thread_generation = NULL,
                  observed_history_id = ?, initial_anchor_history_id = NULL,
                  page_token = NULL, status = 'idle', last_successful_at = ?,
                  last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(generation, expectedHistoryId, now, this.accountId, mailbox);
      database
        .prepare(
          `DELETE FROM thread_mailboxes
            WHERE account_id = ? AND mailbox_id = ? AND generation <> ?`,
        )
        .run(this.accountId, mailbox, generation);
      database
        .prepare(
          `INSERT INTO mailbox_snapshot_metadata(
             account_id, mailbox_id, thread_generation,
             listed_thread_count, window_truncated
           ) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account_id, mailbox_id) DO UPDATE SET
             thread_generation = excluded.thread_generation,
             listed_thread_count = excluded.listed_thread_count,
             window_truncated = excluded.window_truncated`,
        )
        .run(
          this.accountId,
          mailbox,
          generation,
          state.listedThreadCount,
          state.windowTruncated ? 1 : 0,
        );
      database
        .prepare(
          `DELETE FROM mailbox_hydration_progress
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
      this.deleteUnreferencedMailboxMemberships(database);
      this.deleteUnreferencedThreadGenerations(database, [generation]);
    });
    this.releaseFreePages();
  }

  markMailboxHydrationFailure(
    mailboxId: MailCacheHydratableMailbox,
    errorCode: string,
    reauth = false,
  ): void {
    const mailbox = validateHydratableMailboxId(mailboxId);
    const code = validateErrorCode(errorCode);
    this.transaction(() => {
      const database = this.requireDatabase();
      const progress = database
        .prepare(
          `SELECT 1 AS present
             FROM mailbox_hydration_progress
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .get(this.accountId, mailbox);
      if (!progress) return;
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET status = ?, last_error_code = ?
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(reauth ? "reauth_required" : "backoff", code, this.accountId, mailbox);
    });
  }

  abandonFailedMailboxHydration(
    mailboxId: MailCacheHydratableMailbox,
  ): void {
    const mailbox = validateHydratableMailboxId(mailboxId);
    this.transaction(() => {
      const database = this.requireDatabase();
      const state = this.readMailboxHydrationState(database, mailbox);
      if (state.status !== "backoff" && state.status !== "reauth_required") {
        throw new MailCacheError("mail_sync_stale");
      }
      if (state.stagedGeneration === null) {
        if (
          state.hydrationObservedHistoryId !== null ||
          state.initialAnchorHistoryId !== null ||
          state.pageToken !== null
        ) {
          throw new MailCacheError("mail_cache_invalid");
        }
        return;
      }
      if (
        state.hydrationObservedHistoryId === null ||
        state.initialAnchorHistoryId === null
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }

      database
        .prepare(
          `DELETE FROM thread_mailboxes
            WHERE account_id = ? AND mailbox_id = ? AND generation = ?`,
        )
        .run(this.accountId, mailbox, state.stagedGeneration);
      database
        .prepare(
          `DELETE FROM mailbox_hydration_progress
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
      database
        .prepare("DELETE FROM pending_thread_refresh WHERE account_id = ?")
        .run(this.accountId);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET staged_thread_generation = NULL,
                  initial_anchor_history_id = NULL, page_token = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
      this.deleteUnreferencedMailboxMemberships(database);
    });
  }

  rearmFailedMailboxHydration(
    mailboxId: MailCacheHydratableMailbox,
  ): void {
    const mailbox = validateHydratableMailboxId(mailboxId);
    this.transaction(() => {
      const database = this.requireDatabase();
      const state = this.readMailboxHydrationState(database, mailbox);
      if (state.stagedGeneration !== null) {
        throw new MailCacheError("mail_sync_stale");
      }
      if (state.status === "idle" || state.status === "uninitialized") return;
      if (state.status !== "backoff" && state.status !== "reauth_required") {
        throw new MailCacheError("mail_sync_stale");
      }
      if (
        state.hydrationObservedHistoryId !== null ||
        state.initialAnchorHistoryId !== null ||
        state.pageToken !== null
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }

      if (
        state.activeGeneration > 0 &&
        state.activeObservedHistoryId !== null &&
        state.lastSuccessfulAt !== null
      ) {
        database
          .prepare(
            `UPDATE mailbox_sync_state
                SET status = 'idle', last_error_code = NULL
              WHERE account_id = ? AND mailbox_id = ?`,
          )
          .run(this.accountId, mailbox);
        return;
      }
      if (
        state.activeGeneration !== 0 ||
        state.activeObservedHistoryId !== null ||
        state.lastSuccessfulAt !== null
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET status = 'uninitialized', last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
    });
  }

  restartStaleMailboxHydration(
    mailboxId: MailCacheHydratableMailbox,
  ): void {
    const mailbox = validateHydratableMailboxId(mailboxId);
    this.transaction(() => {
      this.resetMailboxHydrationInDatabase(this.requireDatabase(), mailbox);
    });
  }

  replaceActiveThread(value: CachedProviderThread): void {
    this.assertCacheAdmission([value]);
    this.transaction(() => {
      const state = this.readSyncState();
      const generation = readableGeneration(state);
      if (generation < 1) {
        throw new MailCacheError("mail_sync_stale");
      }
      this.upsertThread(generation, value);
    });
  }

  markBackoff(errorCode: string): void {
    this.recordSyncFailure({
      now: Date.now(),
      errorCode,
      retryAfterMs: null,
    });
  }

  markReauthRequired(errorCode: MailCacheReauthErrorCode): void {
    this.transaction(() => {
      const database = this.requireDatabase();
      database
        .prepare(
          "UPDATE sync_state SET status = 'reauth_required', last_error_code = ? WHERE account_id = ?",
        )
        .run(errorCode, this.accountId);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET status = 'reauth_required',
                  last_error_code = ?
            WHERE account_id = ?
              AND (mailbox_id = 'inbox' OR active_thread_generation > 0)`,
        )
        .run(errorCode, this.accountId);
      database
        .prepare(
          `UPDATE background_sync_control
              SET failure_count = 0, retry_at = NULL
            WHERE account_id = ?`,
        )
        .run(this.accountId);
    });
  }

  listThreads(input: {
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): MailThreadPage {
    const limit = validateListLimit(input.limit);
    const view = validateThreadView(input.view ?? null);
    const sort = validateThreadSort(input.sort ?? "date");
    if (view === null && sort === "date") {
      return this.listThreadsDefault(input.cursor, limit);
    }
    const cursor =
      input.cursor === undefined
        ? null
        : decodeThreadViewCursor(input.cursor, { pathKind: "inbox", sort });
    const state = this.readSyncState();
    const generation = readableGeneration(state);
    if (
      cursor !== null &&
      cursor.snapshotFingerprint !==
        threadViewCursorFingerprint({
          pathKind: "inbox",
          accountId: this.accountId,
          mailboxId: null,
          generation,
          observedHistoryId: null,
          view,
          sort,
          key: cursor.key,
          lastMessageAt: cursor.lastMessageAt,
          threadId: cursor.threadId,
        })
    ) {
      throw new MailCacheError("mail_sync_stale");
    }
    const sortSql = THREAD_SORT_SQL[sort];
    const rows = this.requireDatabase()
      .prepare(
        `SELECT thread_id, subject, participants_json, snippet, last_message_at,
                message_count, unread, starred, has_attachments,
                list_message, size_bytes, sort_sender, category
           FROM threads
          WHERE account_id = ? AND generation = ? AND in_inbox = 1
            ${view === null ? "" : THREAD_VIEW_SQL[view]}
            ${cursor === null ? "" : sortSql.keyset}
          ORDER BY ${sortSql.orderBy}
          LIMIT ?`,
      )
      .all(
        this.accountId,
        generation,
        ...(cursor === null ? [] : threadSortKeysetBindings(sort, cursor)),
        limit + 1,
      );
    const parsed = rows.map((row) => this.threadFromRow(row));
    const hasMore = parsed.length > limit;
    const items = parsed.slice(0, limit);
    const tail = items.at(-1);
    // The sender key must come from the raw tail row: threadFromRow does not
    // expose the cache-internal sort_sender value.
    const tailRow = rows[items.length - 1];
    return Object.freeze({
      apiVersion: 1,
      items: Object.freeze(items),
      nextCursor:
        hasMore && tail && tailRow
          ? encodeThreadViewCursor({
              pathKind: "inbox",
              accountId: this.accountId,
              mailboxId: null,
              generation,
              observedHistoryId: null,
              view,
              sort,
              key: threadSortKeyFromRow(sort, tailRow),
              lastMessageAt: tail.lastMessageAt ?? -1,
              threadId: tail.threadId,
            })
          : null,
      sync: Object.freeze({
        status: this.publicSyncStatus(state.status),
        lastSuccessfulAt: state.lastSuccessfulAt,
      }),
    });
  }

  /**
   * The default view and sort keep their exact pre-view behavior, SQL shape,
   * and v1 cursor bytes, so in-flight cursors from older clients keep working.
   */
  private listThreadsDefault(
    inputCursor: string | undefined,
    limit: number,
  ): MailThreadPage {
    const cursor = inputCursor === undefined ? null : decodeCursor(inputCursor);
    const state = this.readSyncState();
    const generation = readableGeneration(state);
    if (cursor !== null && cursor.generation !== generation) {
      throw new MailCacheError("mail_sync_stale");
    }
    const rows = this.requireDatabase()
      .prepare(
        `SELECT thread_id, subject, participants_json, snippet, last_message_at,
                message_count, unread, starred, has_attachments,
                list_message, size_bytes, category
           FROM threads
          WHERE account_id = ? AND generation = ? AND in_inbox = 1
            AND (? IS NULL OR COALESCE(last_message_at, -1) < ?
                 OR (COALESCE(last_message_at, -1) = ? AND thread_id < ?))
          ORDER BY COALESCE(last_message_at, -1) DESC, thread_id DESC
          LIMIT ?`,
      )
      .all(
        this.accountId,
        generation,
        cursor?.threadId ?? null,
        cursor?.lastMessageAt ?? -1,
        cursor?.lastMessageAt ?? -1,
        cursor?.threadId ?? "",
        limit + 1,
      );
    const parsed = rows.map((row) => this.threadFromRow(row));
    const hasMore = parsed.length > limit;
    const items = parsed.slice(0, limit);
    const tail = items.at(-1);
    return Object.freeze({
      apiVersion: 1,
      items: Object.freeze(items),
      nextCursor:
        hasMore && tail
          ? encodeCursor({
              generation,
              lastMessageAt: tail.lastMessageAt ?? -1,
              threadId: tail.threadId,
            })
          : null,
      sync: Object.freeze({
        status: this.publicSyncStatus(state.status),
        lastSuccessfulAt: state.lastSuccessfulAt,
      }),
    });
  }

  /**
   * Backoff caused by a full local cache is surfaced as its own status. It is
   * the one stall a provider retry cannot clear, and the UI must say so.
   */
  private publicSyncStatus(status: MailSyncStatus): MailSyncStatus {
    if (status !== "backoff") return status;
    const row = this.requireDatabase()
      .prepare("SELECT last_error_code FROM sync_state WHERE account_id = ?")
      .get(this.accountId);
    if (
      row === undefined ||
      (row.last_error_code !== null && typeof row.last_error_code !== "string")
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return row.last_error_code === "mail_cache_capacity"
      ? "cache_full"
      : status;
  }

  listMailboxThreads(input: {
    readonly mailboxId: MailCacheMailbox;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): MailCacheMailboxThreadPage {
    const mailbox = validateMailboxId(input.mailboxId);
    const limit = validateListLimit(input.limit);
    const view = validateThreadView(input.view ?? null);
    const sort = validateThreadSort(input.sort ?? "date");
    if (view === null && sort === "date") {
      return this.listMailboxThreadsDefault(mailbox, input.cursor, limit);
    }
    const cursor =
      input.cursor === undefined
        ? null
        : decodeThreadViewCursor(input.cursor, { pathKind: "mailbox", sort });
    const database = this.requireDatabase();
    const snapshot = this.readMailboxSnapshot(mailbox);
    if (snapshot.availability.status === "unavailable") {
      return Object.freeze({
        apiVersion: 1,
        mailboxId: mailbox,
        items: Object.freeze([]),
        nextCursor: null,
        availability: snapshot.availability,
      });
    }
    const generation = snapshot.availability.activeGeneration;
    const observedHistoryId = snapshot.availability.observedHistoryId;
    if (
      cursor !== null &&
      (cursor.mailboxId !== mailbox ||
        cursor.snapshotFingerprint !==
          threadViewCursorFingerprint({
            pathKind: "mailbox",
            accountId: this.accountId,
            mailboxId: mailbox,
            generation,
            observedHistoryId,
            view,
            sort,
            key: cursor.key,
            lastMessageAt: cursor.lastMessageAt,
            threadId: cursor.threadId,
          }))
    ) {
      throw new MailCacheError("mail_sync_stale");
    }

    const sortSql = MAILBOX_THREAD_SORT_SQL[sort];
    const rows = database
      .prepare(
        `SELECT thread.thread_id, thread.subject,
                thread.participants_json, thread.snippet,
                thread.last_message_at, thread.message_count,
                thread.unread, thread.starred, thread.has_attachments,
                thread.list_message, thread.size_bytes, thread.sort_sender,
                thread.category
           FROM thread_mailboxes AS membership
           JOIN threads AS thread
             ON thread.account_id = membership.account_id
            AND thread.generation = membership.generation
            AND thread.thread_id = membership.thread_id
          WHERE membership.account_id = ?
            AND membership.mailbox_id = ?
            AND membership.generation = ?
            ${view === null ? "" : MAILBOX_THREAD_VIEW_SQL[view]}
            ${cursor === null ? "" : sortSql.keyset}
          ORDER BY ${sortSql.orderBy}
          LIMIT ?`,
      )
      .all(
        this.accountId,
        mailbox,
        generation,
        ...(cursor === null ? [] : threadSortKeysetBindings(sort, cursor)),
        limit + 1,
      );
    const parsed = rows.map((entry) => this.threadFromRow(entry));
    const hasMore = parsed.length > limit;
    const items = parsed.slice(0, limit);
    const tail = items.at(-1);
    // The sender key must come from the raw tail row: threadFromRow does not
    // expose the cache-internal sort_sender value.
    const tailRow = rows[items.length - 1];
    return Object.freeze({
      apiVersion: 1,
      mailboxId: mailbox,
      items: Object.freeze(items),
      nextCursor:
        hasMore && tail && tailRow
          ? encodeThreadViewCursor({
              pathKind: "mailbox",
              accountId: this.accountId,
              mailboxId: mailbox,
              generation,
              observedHistoryId,
              view,
              sort,
              key: threadSortKeyFromRow(sort, tailRow),
              lastMessageAt: tail.lastMessageAt ?? -1,
              threadId: tail.threadId,
            })
          : null,
      availability: Object.freeze({
        ...snapshot.availability,
      }),
    });
  }

  /**
   * The default view and sort keep their exact pre-view behavior, SQL shape,
   * and v2 cursor bytes, so in-flight cursors from older clients keep working.
   */
  private listMailboxThreadsDefault(
    mailbox: MailCacheMailbox,
    inputCursor: string | undefined,
    limit: number,
  ): MailCacheMailboxThreadPage {
    const cursor =
      inputCursor === undefined ? null : decodeMailboxCursor(inputCursor);
    const database = this.requireDatabase();
    const snapshot = this.readMailboxSnapshot(mailbox);
    if (snapshot.availability.status === "unavailable") {
      return Object.freeze({
        apiVersion: 1,
        mailboxId: mailbox,
        items: Object.freeze([]),
        nextCursor: null,
        availability: snapshot.availability,
      });
    }
    const generation = snapshot.availability.activeGeneration;
    const observedHistoryId = snapshot.availability.observedHistoryId;
    if (
      cursor !== null &&
      (cursor.mailboxId !== mailbox ||
        cursor.snapshotFingerprint !==
          mailboxCursorFingerprint({
            accountId: this.accountId,
            mailboxId: mailbox,
            generation,
            observedHistoryId,
            lastMessageAt: cursor.lastMessageAt,
            threadId: cursor.threadId,
          }))
    ) {
      throw new MailCacheError("mail_sync_stale");
    }

    const rows = database
      .prepare(
        `SELECT thread.thread_id, thread.subject,
                thread.participants_json, thread.snippet,
                thread.last_message_at, thread.message_count,
                thread.unread, thread.starred, thread.has_attachments,
                thread.list_message, thread.size_bytes, thread.category
           FROM thread_mailboxes AS membership
           JOIN threads AS thread
             ON thread.account_id = membership.account_id
            AND thread.generation = membership.generation
            AND thread.thread_id = membership.thread_id
          WHERE membership.account_id = ?
            AND membership.mailbox_id = ?
            AND membership.generation = ?
            AND (? IS NULL OR COALESCE(thread.last_message_at, -1) < ?
                 OR (COALESCE(thread.last_message_at, -1) = ?
                     AND thread.thread_id < ?))
          ORDER BY COALESCE(thread.last_message_at, -1) DESC,
                   thread.thread_id DESC
          LIMIT ?`,
      )
      .all(
        this.accountId,
        mailbox,
        generation,
        cursor?.threadId ?? null,
        cursor?.lastMessageAt ?? -1,
        cursor?.lastMessageAt ?? -1,
        cursor?.threadId ?? "",
        limit + 1,
      );
    const parsed = rows.map((entry) => this.threadFromRow(entry));
    const hasMore = parsed.length > limit;
    const items = parsed.slice(0, limit);
    const tail = items.at(-1);
    return Object.freeze({
      apiVersion: 1,
      mailboxId: mailbox,
      items: Object.freeze(items),
      nextCursor:
        hasMore && tail
          ? encodeMailboxCursor({
              accountId: this.accountId,
              mailboxId: mailbox,
              generation,
              observedHistoryId,
              lastMessageAt: tail.lastMessageAt ?? -1,
              threadId: tail.threadId,
            })
          : null,
      availability: Object.freeze({
        ...snapshot.availability,
      }),
    });
  }

  searchThreads(input: {
    readonly mailboxId: MailCacheMailbox;
    readonly query: string;
    readonly cursor?: string | null;
    readonly limit: number;
  }): MailSearchThreadPage {
    const mailbox = validateMailboxId(input.mailboxId);
    const query = normalizeMailSearchQuery(input.query);
    const limit = validateListLimit(input.limit);
    const database = this.requireDatabase();
    const generation = readableGeneration(this.readSyncState());
    let searchState = this.readSearchState(database);
    if (searchState.generation !== generation) {
      this.transaction(() => this.resetSearchIndex(database, generation));
      searchState = this.readSearchState(database);
    }
    if (searchState.status === "building") {
      this.transaction(() => this.advanceSearchIndex(database));
      searchState = this.readSearchState(database);
    }

    const snapshot = this.readMailboxSnapshot(mailbox);
    if (snapshot.availability.status === "unavailable") {
      return Object.freeze({
        apiVersion: 1,
        mailboxId: mailbox,
        scope: "headers_and_previews",
        items: Object.freeze([]),
        nextCursor: null,
        availability: publicMailboxAvailability(snapshot.availability),
        indexStatus: searchState.status,
        resultsTruncated: true,
      });
    }
    if (snapshot.availability.activeGeneration !== searchState.generation) {
      throw new MailCacheError("mail_sync_stale");
    }

    const cursor =
      input.cursor === undefined || input.cursor === null
        ? null
        : decodeSearchCursor(input.cursor);
    const fingerprint = searchCursorFingerprint({
      accountId: this.accountId,
      mailboxId: mailbox,
      generation: searchState.generation,
      observedHistoryId: snapshot.availability.observedHistoryId,
      revision: searchState.revision,
      query,
    });
    if (
      cursor !== null &&
      (searchState.status !== "ready" || cursor.fingerprint !== fingerprint)
    ) {
      throw new MailCacheError("mail_sync_stale");
    }
    const offset = cursor?.offset ?? 0;
    const pageLimit = Math.min(limit, MAX_SEARCH_RESULTS - offset);
    if (pageLimit < 1) throw new MailCacheError("mail_cache_invalid");
    const ftsQuery = compileSearchFtsQuery(query);
    const rows = database
      .prepare(
        `WITH ranked AS (
           SELECT thread_id,
                  bm25(mail_search_fts, 0.0, 0.0, 0.0, 8.0, 4.0, 2.0)
                    AS score
             FROM mail_search_fts
            WHERE mail_search_fts MATCH ?
              AND account_id = ? AND generation = ?
         )
         SELECT thread.thread_id, thread.subject,
                thread.participants_json, thread.snippet,
                thread.last_message_at, thread.message_count,
                thread.unread, thread.starred, thread.has_attachments,
                thread.list_message, thread.size_bytes, thread.category,
                ranked.score
           FROM ranked
           JOIN thread_mailboxes AS membership
             ON membership.account_id = ?
            AND membership.mailbox_id = ?
            AND membership.generation = ?
            AND membership.thread_id = ranked.thread_id
           JOIN threads AS thread
             ON thread.account_id = membership.account_id
            AND thread.generation = membership.generation
            AND thread.thread_id = membership.thread_id
          ORDER BY ranked.score ASC,
                   COALESCE(thread.last_message_at, -1) DESC,
                   thread.thread_id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(
        ftsQuery,
        this.accountId,
        searchState.generation,
        this.accountId,
        mailbox,
        searchState.generation,
        pageLimit + 1,
        offset,
      );
    const parsed = rows.map((row) => this.threadFromRow(row));
    const hasMoreWithinCap = parsed.length > pageLimit;
    const items = parsed.slice(0, pageLimit);
    const nextOffset = offset + items.length;
    const hasBeyondCap =
      searchState.status === "ready" &&
      database
        .prepare(
          `SELECT 1 AS present
             FROM mail_search_fts
             JOIN thread_mailboxes AS membership
               ON membership.account_id = ?
              AND membership.mailbox_id = ?
              AND membership.generation = ?
              AND membership.thread_id = mail_search_fts.thread_id
            WHERE mail_search_fts MATCH ?
              AND mail_search_fts.account_id = ?
              AND mail_search_fts.generation = ?
            LIMIT 1 OFFSET ?`,
        )
        .get(
          this.accountId,
          mailbox,
          searchState.generation,
          ftsQuery,
          this.accountId,
          searchState.generation,
          MAX_SEARCH_RESULTS,
        ) !== undefined;
    return Object.freeze({
      apiVersion: 1,
      mailboxId: mailbox,
      scope: "headers_and_previews",
      items: Object.freeze(items),
      nextCursor:
        searchState.status === "ready" &&
        hasMoreWithinCap &&
        nextOffset < MAX_SEARCH_RESULTS
          ? encodeSearchCursor({ fingerprint, offset: nextOffset })
          : null,
      availability: publicMailboxAvailability(snapshot.availability),
      indexStatus: searchState.status,
      resultsTruncated:
        searchState.status === "building" ||
        snapshot.availability.windowTruncated ||
        hasBeyondCap,
    });
  }

  getMailboxThread(input: {
    readonly mailboxId: MailCacheMailbox;
    readonly threadId: string;
  }): MailThreadDetail | null {
    const mailbox = validateMailboxId(input.mailboxId);
    const threadId = validateProviderId(input.threadId);
    const snapshot = this.readMailboxSnapshot(mailbox);
    if (snapshot.availability.status === "unavailable") {
      throw new MailCacheError("mail_sync_stale");
    }

    const database = this.requireDatabase();
    const generation = snapshot.availability.activeGeneration;
    const threadRow = database
      .prepare(
        `SELECT thread.thread_id, thread.subject,
                thread.participants_json, thread.snippet,
                thread.last_message_at, thread.message_count,
                thread.unread, thread.starred, thread.has_attachments,
                thread.list_message, thread.size_bytes, thread.category
           FROM thread_mailboxes AS membership
           JOIN threads AS thread
             ON thread.account_id = membership.account_id
            AND thread.generation = membership.generation
            AND thread.thread_id = membership.thread_id
          WHERE membership.account_id = ?
            AND membership.mailbox_id = ?
            AND membership.generation = ?
            AND membership.thread_id = ?`,
      )
      .get(this.accountId, mailbox, generation, threadId);
    if (!threadRow) return null;
    const rows = database
      .prepare(
        `SELECT message_id, thread_id, from_json, reply_to_json, to_json, cc_json, subject,
                sent_at, unread, in_inbox, snippet, text_body, html_body,
                rfc_message_id, references_json, has_attachments
           FROM messages
          WHERE account_id = ? AND generation = ? AND thread_id = ?
          ORDER BY COALESCE(sent_at, -1) ASC, message_id ASC
          LIMIT ?`,
      )
      .all(this.accountId, generation, threadId, MAX_MESSAGES_PER_THREAD + 1);
    if (rows.length > MAX_MESSAGES_PER_THREAD) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return Object.freeze({
      apiVersion: 1,
      thread: this.threadFromRow(threadRow),
      messages: Object.freeze(rows.map((row) => this.messageFromRow(row))),
    });
  }

  private readMailboxSnapshot(mailbox: MailCacheMailbox): {
    readonly availability: MailCacheMailboxAvailability;
  } {
    const database = this.requireDatabase();
    const global = this.readSyncState();
    const row = database
      .prepare(
        `SELECT mailbox_id, active_thread_generation,
                staged_thread_generation, observed_history_id,
                initial_anchor_history_id, page_token, status,
                last_successful_at, last_error_code
           FROM mailbox_sync_state
          WHERE account_id = ? AND mailbox_id = ?`,
      )
      .get(this.accountId, mailbox);
    if (!row) throw new MailCacheError("mail_cache_invalid");
    validateMailboxStateRow(row);
    const lastSuccessfulAt = row.last_successful_at as number | null;
    const unavailable = (
      reason: MailCacheMailboxUnavailableReason,
    ): { readonly availability: MailCacheMailboxAvailability } =>
      Object.freeze({
        availability: Object.freeze({
          status: "unavailable",
          reason,
          lastSuccessfulAt,
          windowTruncated: null,
        }),
      });

    if (
      global.stagedGeneration !== null ||
      global.initialAnchorHistoryId !== null ||
      global.pageToken !== null ||
      global.status === "syncing"
    ) {
      return unavailable("global_syncing");
    }
    if (row.status === "uninitialized") {
      return unavailable("mailbox_uninitialized");
    }
    if (row.status === "syncing" || row.staged_thread_generation !== null) {
      return unavailable("mailbox_syncing");
    }
    if (row.status === "backoff") {
      return unavailable(
        row.last_error_code === "mail_cache_capacity"
          ? "mailbox_cache_capacity"
          : "mailbox_backoff",
      );
    }
    if (row.status === "reauth_required") {
      return unavailable("mailbox_reauth_required");
    }
    const generation = row.active_thread_generation as number;
    const observedHistoryId = row.observed_history_id as string | null;
    if (
      global.activeGeneration < 1 ||
      global.historyId === null ||
      generation !== global.activeGeneration ||
      observedHistoryId !== global.historyId
    ) {
      return unavailable("history_mismatch");
    }
    if (lastSuccessfulAt === null || observedHistoryId === null) {
      throw new MailCacheError("mail_cache_invalid");
    }

    let windowTruncated = false;
    if (mailbox !== "inbox") {
      const metadata = database
        .prepare(
          `SELECT thread_generation, window_truncated
             FROM mailbox_snapshot_metadata
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .get(this.accountId, mailbox);
      if (
        !metadata ||
        metadata.thread_generation !== generation ||
        (metadata.window_truncated !== 0 && metadata.window_truncated !== 1)
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      windowTruncated = metadata.window_truncated === 1;
    }

    return Object.freeze({
      availability: Object.freeze({
        status: "available",
        activeGeneration: generation,
        observedHistoryId,
        lastSuccessfulAt,
        windowTruncated,
      }),
    });
  }

  getThread(threadId: string): MailThreadDetail | null {
    const id = validateProviderId(threadId);
    const state = this.readSyncState();
    const generation = readableGeneration(state);
    const threadRow = this.requireDatabase()
      .prepare(
        `SELECT thread_id, subject, participants_json, snippet, last_message_at,
                message_count, unread, starred, has_attachments,
                list_message, size_bytes, category
           FROM threads
          WHERE account_id = ? AND generation = ? AND thread_id = ? AND in_inbox = 1`,
      )
      .get(this.accountId, generation, id);
    if (!threadRow) return null;
    const rows = this.requireDatabase()
      .prepare(
        `SELECT message_id, thread_id, from_json, reply_to_json, to_json, cc_json, subject,
                sent_at, unread, in_inbox, snippet, text_body, html_body,
                rfc_message_id, references_json, has_attachments
           FROM messages
          WHERE account_id = ? AND generation = ? AND thread_id = ?
          ORDER BY COALESCE(sent_at, -1) ASC, message_id ASC
          LIMIT ?`,
      )
      .all(this.accountId, generation, id, MAX_MESSAGES_PER_THREAD + 1);
    if (rows.length > MAX_MESSAGES_PER_THREAD) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return Object.freeze({
      apiVersion: 1,
      thread: this.threadFromRow(threadRow),
      messages: Object.freeze(rows.map((row) => this.messageFromRow(row))),
    });
  }

  readReplyContext(messageId: string): MailReplyContext | null {
    const id = validateProviderId(messageId);
    const state = this.readSyncState();
    const generation = readableGeneration(state);
    const row = this.requireDatabase()
      .prepare(
        `SELECT thread_id, rfc_message_id, references_json
           FROM messages
          WHERE account_id = ? AND generation = ? AND message_id = ?`,
      )
      .get(this.accountId, generation, id);
    if (!row) return null;
    if (
      typeof row.thread_id !== "string" ||
      (row.rfc_message_id !== null && typeof row.rfc_message_id !== "string") ||
      typeof row.references_json !== "string"
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return Object.freeze({
      providerThreadId: validateProviderId(row.thread_id),
      rfcMessageId:
        row.rfc_message_id === null
          ? null
          : validateRfcMessageId(row.rfc_message_id),
      references: parseReferencesJson(row.references_json),
    });
  }

  private initializeSchema(database: DatabaseSync): void {
    const versionRow = database.prepare("PRAGMA user_version").get();
    const version = versionRow?.user_version;
    if (version === 0) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(SCHEMA_SQL);
        database
          .prepare(
            `INSERT INTO sync_state(
               account_id, active_generation, staged_generation, history_id,
               initial_anchor_history_id, page_token, status, last_successful_at,
               last_error_code
             ) VALUES (?, 0, NULL, NULL, NULL, NULL, 'idle', NULL, NULL)`,
          )
          .run(this.accountId);
        this.initializeMailboxSchema(database);
        this.initializeBackgroundSyncSchema(database);
        this.initializeProviderCacheBindingSchema(database);
        this.initializeSearchSchema(database);
        database.exec(`PRAGMA user_version = ${CACHE_SCHEMA_VERSION}`);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
      return;
    }
    if (version !== CACHE_SCHEMA_VERSION) {
      throw new MailCacheError("mail_cache_schema_unsupported");
    }
    const state = database
      .prepare("SELECT account_id FROM sync_state")
      .all();
    if (
      state.length !== 1 ||
      state[0]?.account_id !== this.accountId ||
      database.prepare("PRAGMA foreign_key_check").all().length !== 0
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      this.initializeThreadStarredColumn(database);
      this.initializeThreadViewColumns(database);
      this.initializeThreadCategoryColumn(database);
      this.initializeMessageReplyToColumn(database);
      this.initializeMailboxSchema(database);
      this.reconcileThreadStarredFromActiveMailbox(database);
      this.reconcileThreadSortSender(database);
      this.reconcileThreadCategoryFromParticipants(database);
      this.reconcileThreadSnippetFromMessages(database);
      this.initializeBackgroundSyncSchema(database);
      this.initializeProviderCacheBindingSchema(database);
      this.initializeSearchSchema(database);
      if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
        throw new MailCacheError("mail_cache_invalid");
      }
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  private initializeThreadStarredColumn(database: DatabaseSync): void {
    const columns = database.prepare("PRAGMA table_info(threads)").all();
    if (columns.some((column) => column.name === "starred")) return;
    database.exec(
      "ALTER TABLE threads ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0, 1))",
    );
  }

  /**
   * Each column is added only when individually missing, so a partially
   * applied upgrade heals on the next open instead of failing forever.
   */
  private initializeThreadViewColumns(database: DatabaseSync): void {
    const columns = database.prepare("PRAGMA table_info(threads)").all();
    if (!columns.some((column) => column.name === "list_message")) {
      database.exec(
        "ALTER TABLE threads ADD COLUMN list_message INTEGER NOT NULL DEFAULT 0 CHECK(list_message IN (0, 1))",
      );
    }
    if (!columns.some((column) => column.name === "size_bytes")) {
      database.exec(
        "ALTER TABLE threads ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0)",
      );
    }
    if (!columns.some((column) => column.name === "sort_sender")) {
      database.exec(
        "ALTER TABLE threads ADD COLUMN sort_sender TEXT NOT NULL DEFAULT '' CHECK(length(sort_sender) <= 128)",
      );
    }
  }

  private initializeThreadCategoryColumn(database: DatabaseSync): void {
    const columns = database.prepare("PRAGMA table_info(threads)").all();
    if (columns.some((column) => column.name === "category")) return;
    database.exec(
      "ALTER TABLE threads ADD COLUMN category TEXT NOT NULL DEFAULT 'people' CHECK(category IN ('people', 'notification', 'newsletter'))",
    );
  }

  /**
   * sort_sender is derivable from cached participants, so pre-upgrade rows and
   * rows a rollback runtime INSERTed with the column default are repaired here.
   * The bound batch keeps startup cheap; residue heals on the next open.
   * list_message, size_bytes, and category have no local source and fill
   * progressively as provider refreshes rewrite each thread (pre-upgrade rows
   * read 'people' until refreshed, apart from the bounded pre-seed below).
   */
  private reconcileThreadSortSender(database: DatabaseSync): void {
    const rows = database
      .prepare(
        `SELECT rowid, participants_json
           FROM threads
          WHERE sort_sender = '' AND participants_json <> '[]'
          LIMIT 20000`,
      )
      .all();
    const update = database.prepare(
      "UPDATE threads SET sort_sender = ? WHERE rowid = ?",
    );
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.rowid) ||
        typeof row.participants_json !== "string"
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      const sortSender = normalizeSortSender(
        parseAddressesJson(row.participants_json),
      );
      if (sortSender === "") continue;
      update.run(sortSender, row.rowid);
    }
  }

  /**
   * Category has no local source (raw list headers are not persisted), so
   * pre-upgrade rows would all read 'people' until their next provider
   * rewrite. This bounded pre-seed flips the obvious notifications (first
   * participant with a service local part or mailing subdomain) and keeps
   * list_message consistent with the new category. It never seeds
   * 'newsletter' (list headers are unavailable locally) and is idempotent:
   * repaired rows leave
   * the 'people' scan set.
   */
  private reconcileThreadCategoryFromParticipants(database: DatabaseSync): void {
    const rows = database
      .prepare(
        `SELECT rowid, participants_json
           FROM threads
          WHERE category = 'people' AND participants_json <> '[]'
          LIMIT 20000`,
      )
      .all();
    const update = database.prepare(
      "UPDATE threads SET category = 'notification', list_message = 1 WHERE rowid = ?",
    );
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.rowid) ||
        typeof row.participants_json !== "string"
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      const first = parseAddressesJson(row.participants_json)[0];
      if (first === undefined) continue;
      if (!isNotificationSender(first.address)) continue;
      update.run(row.rowid);
    }
  }

  /**
   * Gmail thread rows written from threads.get responses carried no snippet
   * (the endpoint returns none at thread level), while every message row
   * keeps its own snippet. This bounded pass copies the newest non-empty
   * message snippet into threads whose snippet is missing. Idempotent:
   * repaired rows leave the scan set; residue heals on the next open.
   */
  private reconcileThreadSnippetFromMessages(database: DatabaseSync): void {
    const rows = database
      .prepare(
        `SELECT thread.rowid AS rowid, source.snippet AS snippet
           FROM threads AS thread
           JOIN messages AS source ON source.rowid = (
             SELECT message.rowid
               FROM messages AS message
              WHERE message.account_id = thread.account_id
                AND message.generation = thread.generation
                AND message.thread_id = thread.thread_id
                AND message.snippet IS NOT NULL AND message.snippet <> ''
              ORDER BY message.sent_at DESC, message.message_id DESC
              LIMIT 1
           )
          WHERE thread.snippet IS NULL OR thread.snippet = ''
          LIMIT 20000`,
      )
      .all();
    const update = database.prepare(
      "UPDATE threads SET snippet = ? WHERE rowid = ?",
    );
    for (const row of rows) {
      if (
        !Number.isSafeInteger(row.rowid) ||
        typeof row.snippet !== "string" ||
        row.snippet === ""
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      update.run(row.snippet, row.rowid);
    }
  }

  private initializeSearchSchema(database: DatabaseSync): void {
    database.exec(SEARCH_SCHEMA_SQL);
    const state = validateSyncStateRow(
      database
        .prepare(
          `SELECT active_generation, staged_generation, history_id,
                  initial_anchor_history_id, page_token, status,
                  last_successful_at
             FROM sync_state WHERE account_id = ?`,
        )
        .get(this.accountId),
    );
    const generation = readableGeneration(state);
    const existing = database
      .prepare(
        `SELECT generation, indexed_through_rowid, revision, status
           FROM mail_search_state WHERE account_id = ?`,
      )
      .get(this.accountId);
    const revision = existing
      ? nextSearchRevision(validateSearchStateRow(existing).revision)
      : 0;

    // The service may be starting after a rollback runtime changed the cache.
    // Rebuilding from row zero is the only honest way to avoid stale matches.
    database
      .prepare("DELETE FROM mail_search_fts WHERE account_id = ?")
      .run(this.accountId);
    database
      .prepare(
        `INSERT INTO mail_search_state(
           account_id, generation, indexed_through_rowid, revision, status
         ) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           generation = excluded.generation,
           indexed_through_rowid = 0,
           revision = excluded.revision,
           status = excluded.status`,
      )
      .run(
        this.accountId,
        generation,
        revision,
        generation > 0 ? "building" : "ready",
      );
  }

  private readSearchState(database: DatabaseSync): MailCacheSearchState {
    return validateSearchStateRow(
      database
        .prepare(
          `SELECT generation, indexed_through_rowid, revision, status
             FROM mail_search_state WHERE account_id = ?`,
        )
        .get(this.accountId),
    );
  }

  private resetSearchIndex(database: DatabaseSync, generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const current = this.readSearchState(database);
    database
      .prepare("DELETE FROM mail_search_fts WHERE account_id = ?")
      .run(this.accountId);
    database
      .prepare(
        `UPDATE mail_search_state
            SET generation = ?, indexed_through_rowid = 0,
                revision = ?, status = ?
          WHERE account_id = ?`,
      )
      .run(
        generation,
        nextSearchRevision(current.revision),
        generation > 0 ? "building" : "ready",
        this.accountId,
      );
  }

  private advanceSearchIndex(database: DatabaseSync): void {
    const state = this.readSearchState(database);
    if (state.status === "ready") return;
    if (state.generation < 1) throw new MailCacheError("mail_cache_invalid");
    const rows = database
      .prepare(
        `SELECT rowid, thread_id, subject, participants_json, snippet
           FROM threads
          WHERE account_id = ? AND generation = ? AND rowid > ?
          ORDER BY rowid ASC
          LIMIT ?`,
      )
      .all(
        this.accountId,
        state.generation,
        state.indexedThroughRowid,
        MAX_SEARCH_BACKFILL_THREADS + 1,
      );
    const batch = rows.slice(0, MAX_SEARCH_BACKFILL_THREADS);
    for (const row of batch) {
      this.indexSearchThreadRow(database, state.generation, row);
    }
    const tail = batch.at(-1);
    const indexedThroughRowid = tail
      ? validateSearchRowId(tail.rowid)
      : state.indexedThroughRowid;
    database
      .prepare(
        `UPDATE mail_search_state
            SET indexed_through_rowid = ?, revision = ?, status = ?
          WHERE account_id = ? AND generation = ?`,
      )
      .run(
        indexedThroughRowid,
        nextSearchRevision(state.revision),
        rows.length > MAX_SEARCH_BACKFILL_THREADS ? "building" : "ready",
        this.accountId,
        state.generation,
      );
  }

  private indexSearchThreadRow(
    database: DatabaseSync,
    generation: number,
    row: unknown,
  ): void {
    if (
      row === null ||
      typeof row !== "object" ||
      !Number.isSafeInteger((row as { rowid?: unknown }).rowid) ||
      typeof (row as { thread_id?: unknown }).thread_id !== "string" ||
      ((row as { subject?: unknown }).subject !== null &&
        typeof (row as { subject?: unknown }).subject !== "string") ||
      typeof (row as { participants_json?: unknown }).participants_json !==
        "string" ||
      ((row as { snippet?: unknown }).snippet !== null &&
        typeof (row as { snippet?: unknown }).snippet !== "string")
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const value = row as {
      readonly rowid: number;
      readonly thread_id: string;
      readonly subject: string | null;
      readonly participants_json: string;
      readonly snippet: string | null;
    };
    const rowid = validateSearchRowId(value.rowid);
    const threadId = validateProviderId(value.thread_id);
    const participants = parseAddressesJson(value.participants_json)
      .flatMap((address) => [address.name, address.address])
      .filter((entry): entry is string => entry !== null)
      .join(" ");
    database
      .prepare("DELETE FROM mail_search_fts WHERE rowid = ?")
      .run(rowid);
    database
      .prepare(
        `INSERT INTO mail_search_fts(
           rowid, account_id, generation, thread_id,
           subject, participants, snippet
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rowid,
        this.accountId,
        generation,
        threadId,
        value.subject ?? "",
        participants,
        value.snippet ?? "",
      );
  }

  private reindexSearchThread(
    database: DatabaseSync,
    generation: number,
    threadId: string,
  ): void {
    const row = database
      .prepare(
        `SELECT rowid, thread_id, subject, participants_json, snippet
           FROM threads
          WHERE account_id = ? AND generation = ? AND thread_id = ?`,
      )
      .get(this.accountId, generation, threadId);
    if (!row) throw new MailCacheError("mail_cache_invalid");
    this.indexSearchThreadRow(database, generation, row);
    this.bumpSearchRevision(database, generation);
  }

  private deleteSearchThread(
    database: DatabaseSync,
    generation: number,
    threadId: string,
  ): void {
    database
      .prepare(
        `DELETE FROM mail_search_fts
          WHERE account_id = ? AND generation = ? AND thread_id = ?`,
      )
      .run(this.accountId, generation, threadId);
    this.bumpSearchRevision(database, generation);
  }

  private bumpSearchRevision(database: DatabaseSync, generation: number): void {
    const state = this.readSearchState(database);
    if (state.generation !== generation || state.status !== "ready") return;
    database
      .prepare(
        `UPDATE mail_search_state SET revision = ?
          WHERE account_id = ? AND generation = ?`,
      )
      .run(nextSearchRevision(state.revision), this.accountId, generation);
  }

  private initializeMessageReplyToColumn(database: DatabaseSync): void {
    let columns = database.prepare("PRAGMA table_info(messages)").all();
    if (!columns.some((column) => column.name === "reply_to_json")) {
      database.exec(
        "ALTER TABLE messages ADD COLUMN reply_to_json TEXT NOT NULL DEFAULT '[]'",
      );
      columns = database.prepare("PRAGMA table_info(messages)").all();
    }
    if (!columns.some((column) => column.name === "reply_to_complete")) {
      database.exec(
        "ALTER TABLE messages ADD COLUMN reply_to_complete INTEGER NOT NULL DEFAULT 0 CHECK(reply_to_complete IN (0, 1))",
      );
    }
  }

  private reconcileThreadStarredFromActiveMailbox(
    database: DatabaseSync,
  ): void {
    // Active membership is positive proof even for a truncated Starred crawl.
    database
      .prepare(
        `UPDATE threads
            SET starred = 1
          WHERE account_id = ?
            AND starred = 0
            AND EXISTS (
              SELECT 1
                FROM thread_mailboxes AS membership
                JOIN mailbox_sync_state AS state
                  ON state.account_id = membership.account_id
                 AND state.mailbox_id = membership.mailbox_id
               WHERE membership.account_id = threads.account_id
                 AND membership.generation = threads.generation
                 AND membership.thread_id = threads.thread_id
                 AND membership.mailbox_id = 'starred'
                 AND state.active_thread_generation = membership.generation
            )`,
      )
      .run(this.accountId);

    // Absence is proof only when the active Starred snapshot is complete.
    // This repairs writes made by a rollback runtime without erasing provider
    // state while the newer runtime is staging or truncating a mailbox crawl.
    database
      .prepare(
        `UPDATE threads
            SET starred = 0
          WHERE account_id = ?
            AND starred = 1
            AND EXISTS (
              SELECT 1
                FROM mailbox_sync_state AS state
                JOIN mailbox_snapshot_metadata AS metadata
                  ON metadata.account_id = state.account_id
                 AND metadata.mailbox_id = state.mailbox_id
                 AND metadata.thread_generation = state.active_thread_generation
               WHERE state.account_id = threads.account_id
                 AND state.mailbox_id = 'starred'
                 AND state.active_thread_generation = threads.generation
                 AND state.staged_thread_generation IS NULL
                 AND state.status IN ('idle', 'backoff', 'reauth_required')
                 AND metadata.window_truncated = 0
            )
            AND NOT EXISTS (
              SELECT 1
                FROM thread_mailboxes AS membership
                JOIN mailbox_sync_state AS state
                  ON state.account_id = membership.account_id
                 AND state.mailbox_id = membership.mailbox_id
               WHERE membership.account_id = threads.account_id
                 AND membership.generation = threads.generation
                 AND membership.thread_id = threads.thread_id
                 AND membership.mailbox_id = 'starred'
                 AND state.active_thread_generation = membership.generation
            )`,
      )
      .run(this.accountId);
  }

  private initializeMailboxSchema(database: DatabaseSync): void {
    database.exec(MAILBOX_SCHEMA_SQL);
    const insertState = database.prepare(
      `INSERT OR IGNORE INTO mailbox_sync_state(
         account_id, mailbox_id, active_thread_generation,
         staged_thread_generation,
         observed_history_id, initial_anchor_history_id, page_token, status,
         last_successful_at, last_error_code
       ) VALUES (?, ?, 0, NULL, NULL, NULL, NULL, 'uninitialized', NULL, NULL)`,
    );
    for (const mailbox of MAIL_CACHE_MAILBOXES) {
      insertState.run(this.accountId, mailbox);
    }
    const states = database
      .prepare(
        `SELECT mailbox_id, active_thread_generation, staged_thread_generation,
                observed_history_id, initial_anchor_history_id, page_token,
                status, last_successful_at, last_error_code
           FROM mailbox_sync_state
          WHERE account_id = ?
          ORDER BY mailbox_id ASC`,
      )
      .all(this.accountId);
    if (
      states.length !== MAIL_CACHE_MAILBOXES.length ||
      states.some(
        (row, index) => {
          validateMailboxStateRow(row);
          return row.mailbox_id !== [...MAIL_CACHE_MAILBOXES].sort()[index];
        },
      )
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const retryRows = database
      .prepare(
        `SELECT next_mailbox_index
           FROM mailbox_retry_cursor
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    if (retryRows.length > 1) throw new MailCacheError("mail_cache_invalid");
    if (retryRows.length === 1) {
      validateMailboxRetryIndex(retryRows[0]?.next_mailbox_index);
    }
    this.reconcileMailboxExtension(database);
    const invalidMembership = database
      .prepare(
        `SELECT 1 AS invalid
           FROM thread_mailboxes AS membership
           LEFT JOIN mailbox_sync_state AS state
             ON state.account_id = membership.account_id
            AND state.mailbox_id = membership.mailbox_id
          WHERE membership.account_id = ?
            AND (
              state.account_id IS NULL OR
              (
                membership.generation <> state.active_thread_generation AND
                (
                  state.staged_thread_generation IS NULL OR
                  membership.generation <> state.staged_thread_generation
                )
              )
            )
          LIMIT 1`,
      )
      .get(this.accountId);
    if (invalidMembership) {
      throw new MailCacheError("mail_cache_invalid");
    }
  }

  private initializeBackgroundSyncSchema(database: DatabaseSync): void {
    database.exec(BACKGROUND_SYNC_SCHEMA_SQL);
    const current = database
      .prepare(
        `SELECT status
           FROM sync_state
          WHERE account_id = ?`,
      )
      .get(this.accountId);
    if (!current || typeof current.status !== "string") {
      throw new MailCacheError("mail_cache_invalid");
    }
    const migratingBackoff = current.status === "backoff";
    const migrationNow = Date.now();
    const migrationRetryAt = validateTimestamp(
      migrationNow + BACKGROUND_SYNC_BASE_BACKOFF_MS,
    );
    database
      .prepare(
        `INSERT OR IGNORE INTO background_sync_control(
           account_id, credential_version, failure_count, retry_at,
           last_attempt_at
         ) VALUES (?, NULL, ?, ?, NULL)`,
      )
      .run(
        this.accountId,
        migratingBackoff ? 1 : 0,
        migratingBackoff ? migrationRetryAt : null,
      );
    const control = readBackgroundSyncRow(database, this.accountId);
    if (current.status === "reauth_required" && control.failureCount > 0) {
      database
        .prepare(
          `UPDATE background_sync_control
              SET failure_count = 0, retry_at = NULL
            WHERE account_id = ?`,
        )
        .run(this.accountId);
    } else if (current.status === "backoff" && control.failureCount === 0) {
      database
        .prepare(
          `UPDATE background_sync_control
              SET failure_count = 1, retry_at = ?
            WHERE account_id = ?`,
        )
        .run(migrationRetryAt, this.accountId);
    } else if (
      current.status !== "backoff" &&
      current.status !== "reauth_required" &&
      control.failureCount > 0
    ) {
      // A rollback runtime can complete sync without knowing this additive
      // table. Its authoritative idle/syncing state wins on roll-forward.
      database
        .prepare(
          `UPDATE background_sync_control
              SET failure_count = 0, retry_at = NULL
            WHERE account_id = ?`,
        )
        .run(this.accountId);
    }
    readBackgroundSyncRow(database, this.accountId);
  }

  private initializeProviderCacheBindingSchema(database: DatabaseSync): void {
    database.exec(PROVIDER_CACHE_BINDING_SCHEMA_SQL);
    const rows = database
      .prepare(
        `SELECT provider_kind, transport_binding_version
           FROM provider_cache_binding
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    if (rows.length > 1) throw new MailCacheError("mail_cache_invalid");
    const row = rows[0];
    if (
      row &&
      !(
        (row.provider_kind === "gmail" &&
          row.transport_binding_version === null) ||
        (row.provider_kind === "imap" &&
          Number.isSafeInteger(row.transport_binding_version) &&
          (row.transport_binding_version as number) >= 1)
      )
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
  }

  private resetProviderSnapshot(database: DatabaseSync): void {
    database
      .prepare("DELETE FROM sync_state WHERE account_id = ?")
      .run(this.accountId);
    database
      .prepare("DELETE FROM threads WHERE account_id = ?")
      .run(this.accountId);
    database
      .prepare(
        `INSERT INTO sync_state(
           account_id, active_generation, staged_generation, history_id,
           initial_anchor_history_id, page_token, status, last_successful_at,
           last_error_code
         ) VALUES (?, 0, NULL, NULL, NULL, NULL, 'idle', NULL, NULL)`,
      )
      .run(this.accountId);
    this.initializeMailboxSchema(database);
    this.initializeBackgroundSyncSchema(database);
    this.initializeSearchSchema(database);
  }

  private restoreSyncStatuses(database: DatabaseSync): void {
    database
      .prepare(
        `UPDATE sync_state
            SET status = CASE
                  WHEN staged_generation IS NOT NULL OR page_token IS NOT NULL
                    THEN 'syncing'
                  ELSE 'idle'
                END,
                last_error_code = NULL
          WHERE account_id = ?`,
      )
      .run(this.accountId);
    database
      .prepare(
        `UPDATE mailbox_sync_state
            SET status = CASE
                  WHEN staged_thread_generation IS NOT NULL
                    AND initial_anchor_history_id IS NOT NULL THEN 'syncing'
                  WHEN active_thread_generation > 0
                    AND observed_history_id IS NOT NULL
                    AND page_token IS NULL
                    AND last_successful_at IS NOT NULL THEN 'idle'
                  ELSE 'uninitialized'
                END,
                last_error_code = NULL
          WHERE account_id = ?`,
      )
      .run(this.accountId);
  }

  private reconcileMailboxExtension(database: DatabaseSync): void {
    const state = validateSyncStateRow(
      database
        .prepare(
          `SELECT active_generation, staged_generation, history_id,
                  initial_anchor_history_id, page_token, status,
                  last_successful_at
             FROM sync_state WHERE account_id = ?`,
        )
        .get(this.accountId),
    );
    this.reconcileMailboxHistoryCycle(database, state);
    this.reconcileMailboxHydration(database, state);
    this.resetDanglingMailboxSnapshots(database, state);
    const generation = readableGeneration(state);
    const inboxState = database
      .prepare(
        `SELECT active_thread_generation, staged_thread_generation,
                observed_history_id
           FROM mailbox_sync_state
          WHERE account_id = ? AND mailbox_id = 'inbox'`,
      )
      .get(this.accountId);
    if (
      !inboxState ||
      !Number.isSafeInteger(inboxState.active_thread_generation) ||
      (inboxState.staged_thread_generation !== null &&
        !Number.isSafeInteger(inboxState.staged_thread_generation)) ||
      (inboxState.observed_history_id !== null &&
        typeof inboxState.observed_history_id !== "string")
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const recoverableInitialPagination =
      state.stagedGeneration !== null &&
      state.initialAnchorHistoryId !== null &&
      state.status === "syncing";
    if (recoverableInitialPagination) {
      this.prepareMailboxInitialGenerationInDatabase(
        database,
        state.activeGeneration,
        state.stagedGeneration!,
        state.initialAnchorHistoryId!,
        state.historyId,
        state.lastSuccessfulAt,
        state.pageToken,
      );
      return;
    }
    const expectedInbox = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM threads
          WHERE account_id = ? AND generation = ? AND in_inbox = 1`,
      )
      .get(this.accountId, generation)?.count;
    const actualInbox = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM thread_mailboxes
          WHERE account_id = ? AND generation = ? AND mailbox_id = 'inbox'`,
      )
      .get(this.accountId, generation)?.count;
    const matchedInbox = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM thread_mailboxes AS membership
           JOIN threads AS thread
             ON thread.account_id = membership.account_id
            AND thread.generation = membership.generation
            AND thread.thread_id = membership.thread_id
          WHERE membership.account_id = ?
            AND membership.generation = ?
            AND membership.mailbox_id = 'inbox'
            AND thread.in_inbox = 1`,
      )
      .get(this.accountId, generation)?.count;
    const allInboxMemberships = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM thread_mailboxes
          WHERE account_id = ? AND mailbox_id = 'inbox'`,
      )
      .get(this.accountId)?.count;
    if (
      !Number.isSafeInteger(expectedInbox) ||
      !Number.isSafeInteger(actualInbox) ||
      !Number.isSafeInteger(matchedInbox) ||
      !Number.isSafeInteger(allInboxMemberships)
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const trustedActiveSnapshot =
      state.activeGeneration > 0 &&
      state.stagedGeneration === null &&
      state.initialAnchorHistoryId === null &&
      state.historyId !== null &&
      state.lastSuccessfulAt !== null &&
      ((state.status === "idle" && state.pageToken === null) ||
        (state.status === "syncing" && state.pageToken !== null) ||
        state.status === "backoff" ||
        state.status === "reauth_required");
    const stale =
      !trustedActiveSnapshot ||
      inboxState.active_thread_generation !== generation ||
      inboxState.staged_thread_generation !== null ||
      inboxState.observed_history_id !== state.historyId ||
      expectedInbox !== actualInbox ||
      expectedInbox !== matchedInbox ||
      actualInbox !== allInboxMemberships;
    if (!stale) return;

    database
      .prepare(
        "DELETE FROM thread_mailboxes WHERE account_id = ? AND mailbox_id = 'inbox'",
      )
      .run(this.accountId);
    database
      .prepare(
        `UPDATE mailbox_sync_state
            SET active_thread_generation = 0, staged_thread_generation = NULL,
                observed_history_id = NULL, initial_anchor_history_id = NULL,
                page_token = NULL, status = 'uninitialized',
                last_successful_at = NULL, last_error_code = NULL
          WHERE account_id = ? AND mailbox_id = 'inbox'`,
      )
      .run(this.accountId);
    if (generation > 0) {
      database
        .prepare(
          `INSERT INTO thread_mailboxes(
             account_id, mailbox_id, generation, thread_id
           )
           SELECT account_id, 'inbox', generation, thread_id
             FROM threads
            WHERE account_id = ? AND generation = ? AND in_inbox = 1
          `,
        )
        .run(this.accountId, generation);
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET staged_thread_generation = ?
            WHERE account_id = ? AND mailbox_id = 'all'
              AND active_thread_generation = 0
              AND status = 'uninitialized'
              AND (staged_thread_generation IS NULL OR staged_thread_generation = ?)`,
        )
        .run(generation, this.accountId, generation);
      database
        .prepare(
          `INSERT OR IGNORE INTO thread_mailboxes(
             account_id, mailbox_id, generation, thread_id
           )
           SELECT thread.account_id, 'all', thread.generation, thread.thread_id
             FROM threads AS thread
             JOIN mailbox_sync_state AS state
               ON state.account_id = thread.account_id
              AND state.mailbox_id = 'all'
              AND state.staged_thread_generation = thread.generation
            WHERE thread.account_id = ? AND thread.generation = ?
              AND thread.in_inbox = 1`,
        )
        .run(this.accountId, generation);
    }
    database
      .prepare(
        `UPDATE mailbox_sync_state
            SET active_thread_generation = ?, staged_thread_generation = ?,
                observed_history_id = ?, initial_anchor_history_id = NULL,
                page_token = NULL,
                status = ?, last_successful_at = ?, last_error_code = NULL
          WHERE account_id = ? AND mailbox_id = 'inbox'`,
      )
      .run(
        trustedActiveSnapshot ? generation : 0,
        trustedActiveSnapshot || generation === 0 ? null : generation,
        trustedActiveSnapshot ? state.historyId : null,
        trustedActiveSnapshot && state.status === "backoff"
          ? "backoff"
          : trustedActiveSnapshot && state.status === "reauth_required"
            ? "reauth_required"
            : trustedActiveSnapshot
              ? "idle"
              : "uninitialized",
        trustedActiveSnapshot
          ? state.lastSuccessfulAt
          : null,
        this.accountId,
      );
  }

  private resetDanglingMailboxSnapshots(
    database: DatabaseSync,
    globalState: MailCacheSyncState,
  ): void {
    const globalGenerations = new Set(
      [globalState.activeGeneration, globalState.stagedGeneration].filter(
        (generation): generation is number => generation !== null && generation > 0,
      ),
    );
    const states = database
      .prepare(
        `SELECT mailbox_id, active_thread_generation, staged_thread_generation
           FROM mailbox_sync_state
          WHERE account_id = ? AND mailbox_id <> 'inbox'`,
      )
      .all(this.accountId);
    const hasThread = database.prepare(
      `SELECT 1 AS present
         FROM threads
        WHERE account_id = ? AND generation = ?
        LIMIT 1`,
    );
    const deleteMemberships = database.prepare(
      "DELETE FROM thread_mailboxes WHERE account_id = ? AND mailbox_id = ?",
    );
    const reset = database.prepare(
      `UPDATE mailbox_sync_state
          SET active_thread_generation = 0, staged_thread_generation = NULL,
              observed_history_id = NULL, initial_anchor_history_id = NULL,
              page_token = NULL, status = 'uninitialized',
              last_successful_at = NULL, last_error_code = NULL
        WHERE account_id = ? AND mailbox_id = ?`,
    );
    for (const row of states) {
      const mailbox = validateMailboxId(row.mailbox_id);
      if (
        !Number.isSafeInteger(row.active_thread_generation) ||
        (row.staged_thread_generation !== null &&
          !Number.isSafeInteger(row.staged_thread_generation))
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      const generations = [
        row.active_thread_generation as number,
        row.staged_thread_generation as number | null,
      ].filter(
        (generation): generation is number => generation !== null && generation > 0,
      );
      const dangling = generations.some(
        (generation) =>
          !globalGenerations.has(generation) &&
          !hasThread.get(this.accountId, generation),
      );
      if (dangling) {
        deleteMemberships.run(this.accountId, mailbox);
        reset.run(this.accountId, mailbox);
        database
          .prepare(
            `DELETE FROM mailbox_snapshot_metadata
              WHERE account_id = ? AND mailbox_id = ?`,
          )
          .run(this.accountId, mailbox);
      }
    }
  }

  private readMailboxHydrationState(
    database: DatabaseSync,
    mailbox: MailCacheHydratableMailbox,
  ): MailboxHydrationState {
    const row = database
      .prepare(
        `SELECT state.mailbox_id, state.active_thread_generation,
                state.staged_thread_generation, state.observed_history_id,
                state.initial_anchor_history_id, state.page_token,
                state.status, state.last_successful_at, state.last_error_code,
                progress.thread_generation AS progress_generation,
                progress.observed_history_id AS progress_observed_history_id,
                progress.pages_completed, progress.listed_thread_count,
                progress.crawl_complete, progress.window_truncated,
                progress.post_crawl_history_id,
                metadata.thread_generation AS metadata_generation,
                metadata.listed_thread_count AS metadata_listed_thread_count,
                metadata.window_truncated AS metadata_window_truncated
           FROM mailbox_sync_state AS state
           LEFT JOIN mailbox_hydration_progress AS progress
             ON progress.account_id = state.account_id
            AND progress.mailbox_id = state.mailbox_id
           LEFT JOIN mailbox_snapshot_metadata AS metadata
             ON metadata.account_id = state.account_id
            AND metadata.mailbox_id = state.mailbox_id
          WHERE state.account_id = ? AND state.mailbox_id = ?`,
      )
      .get(this.accountId, mailbox);
    if (!row) throw new MailCacheError("mail_cache_invalid");
    validateMailboxStateRow(row);
    const progressValues = [
      row.progress_generation,
      row.progress_observed_history_id,
      row.pages_completed,
      row.listed_thread_count,
      row.crawl_complete,
      row.window_truncated,
    ];
    const hasProgress = progressValues.some((value) => value !== null);
    if (
      hasProgress &&
      (progressValues.some((value) => value === null) ||
        !Number.isSafeInteger(row.progress_generation) ||
        !Number.isSafeInteger(row.pages_completed) ||
        !Number.isSafeInteger(row.listed_thread_count) ||
        (row.crawl_complete !== 0 && row.crawl_complete !== 1) ||
        (row.window_truncated !== 0 && row.window_truncated !== 1) ||
        typeof row.progress_observed_history_id !== "string" ||
        (row.post_crawl_history_id !== null &&
          typeof row.post_crawl_history_id !== "string"))
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    if (!hasProgress && row.post_crawl_history_id !== null) {
      throw new MailCacheError("mail_cache_invalid");
    }
    if (hasProgress) {
      validateGeneration(row.progress_generation as number);
      validateHistoryId(row.progress_observed_history_id as string);
      if (
        (row.pages_completed as number) < 0 ||
        (row.pages_completed as number) > MAX_MAILBOX_HYDRATION_PAGES ||
        (row.listed_thread_count as number) < 0 ||
        ((row.crawl_complete as number) === 0 &&
          (row.window_truncated as number) !== 0) ||
        ((row.crawl_complete as number) === 0 &&
          row.post_crawl_history_id !== null) ||
        ((row.crawl_complete as number) === 1 && row.page_token !== null)
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      if (row.post_crawl_history_id !== null) {
        validateHistoryId(row.post_crawl_history_id as string);
      }
    }
    const metadataValues = [
      row.metadata_generation,
      row.metadata_listed_thread_count,
      row.metadata_window_truncated,
    ];
    const hasMetadata = metadataValues.some((value) => value !== null);
    if (
      hasMetadata &&
      (metadataValues.some((value) => value === null) ||
        !Number.isSafeInteger(row.metadata_generation) ||
        !Number.isSafeInteger(row.metadata_listed_thread_count) ||
        (row.metadata_window_truncated !== 0 &&
          row.metadata_window_truncated !== 1))
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return Object.freeze({
      mailboxId: mailbox,
      activeGeneration: row.active_thread_generation as number,
      stagedGeneration: row.staged_thread_generation as number | null,
      activeObservedHistoryId: row.observed_history_id as string | null,
      hydrationObservedHistoryId: hasProgress
        ? (row.progress_observed_history_id as string)
        : null,
      initialAnchorHistoryId: row.initial_anchor_history_id as string | null,
      pageToken: row.page_token as string | null,
      status: row.status as MailboxHydrationState["status"],
      lastSuccessfulAt: row.last_successful_at as number | null,
      pagesCompleted: hasProgress ? (row.pages_completed as number) : 0,
      listedThreadCount: hasProgress
        ? (row.listed_thread_count as number)
        : 0,
      crawlComplete: hasProgress && row.crawl_complete === 1,
      windowTruncated: hasProgress && row.window_truncated === 1,
      postCrawlHistoryId: hasProgress
        ? (row.post_crawl_history_id as string | null)
        : null,
      activeListedThreadCount: hasMetadata
        ? (row.metadata_listed_thread_count as number)
        : null,
      activeWindowTruncated:
        hasMetadata && row.metadata_window_truncated === 1,
    });
  }

  private reconcileMailboxHydration(
    database: DatabaseSync,
    global: MailCacheSyncState,
  ): void {
    const progressRows = database
      .prepare(
        `SELECT mailbox_id
           FROM mailbox_hydration_progress
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    if (progressRows.length > 1) {
      this.resetAllMailboxHydrationsInDatabase(database);
    } else if (progressRows.length === 1) {
      const mailbox = validateHydratableMailboxId(
        progressRows[0]?.mailbox_id,
      );
      let recoverable = false;
      try {
        const state = this.readMailboxHydrationState(database, mailbox);
        const threadWindow =
          mailbox === "all"
            ? MAX_ALL_MAIL_HYDRATION_THREADS
            : MAX_MAILBOX_HYDRATION_THREADS;
        recoverable =
          global.activeGeneration > 0 &&
          global.stagedGeneration === null &&
          global.initialAnchorHistoryId === null &&
          global.historyId !== null &&
          state.stagedGeneration === global.activeGeneration &&
          state.initialAnchorHistoryId !== null &&
          state.hydrationObservedHistoryId === global.historyId &&
          state.listedThreadCount <= threadWindow &&
          (state.status === "syncing" ||
            state.status === "backoff" ||
            state.status === "reauth_required");
      } catch {
        recoverable = false;
      }
      if (!recoverable) {
        this.resetMailboxHydrationInDatabase(database, mailbox);
      }
    } else {
      database
        .prepare("DELETE FROM pending_thread_refresh WHERE account_id = ?")
        .run(this.accountId);
    }
    const metadataRows = database
      .prepare(
        `SELECT metadata.mailbox_id, metadata.thread_generation,
                state.active_thread_generation
           FROM mailbox_snapshot_metadata AS metadata
           LEFT JOIN mailbox_sync_state AS state
             ON state.account_id = metadata.account_id
            AND state.mailbox_id = metadata.mailbox_id
          WHERE metadata.account_id = ?`,
      )
      .all(this.accountId);
    for (const row of metadataRows) {
      const mailbox = validateHydratableMailboxId(row.mailbox_id);
      if (
        !Number.isSafeInteger(row.thread_generation) ||
        !Number.isSafeInteger(row.active_thread_generation)
      ) {
        throw new MailCacheError("mail_cache_invalid");
      }
      if (row.thread_generation !== row.active_thread_generation) {
        database
          .prepare(
            `DELETE FROM mailbox_snapshot_metadata
              WHERE account_id = ? AND mailbox_id = ?`,
          )
          .run(this.accountId, mailbox);
      }
    }
  }

  private resetAllMailboxHydrationsInDatabase(database: DatabaseSync): void {
    const rows = database
      .prepare(
        `SELECT mailbox_id
           FROM mailbox_hydration_progress
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    for (const row of rows) {
      this.resetMailboxHydrationInDatabase(
        database,
        validateHydratableMailboxId(row.mailbox_id),
      );
    }
    database
      .prepare("DELETE FROM pending_thread_refresh WHERE account_id = ?")
      .run(this.accountId);
  }

  private resetMailboxHydrationInDatabase(
    database: DatabaseSync,
    mailbox: MailCacheHydratableMailbox,
  ): void {
    const row = database
      .prepare(
        `SELECT active_thread_generation, staged_thread_generation,
                observed_history_id, last_successful_at
           FROM mailbox_sync_state
          WHERE account_id = ? AND mailbox_id = ?`,
      )
      .get(this.accountId, mailbox);
    if (
      !row ||
      !Number.isSafeInteger(row.active_thread_generation) ||
      (row.staged_thread_generation !== null &&
        !Number.isSafeInteger(row.staged_thread_generation))
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const progress = database
      .prepare(
        `SELECT 1 AS present
           FROM mailbox_hydration_progress
          WHERE account_id = ? AND mailbox_id = ?`,
      )
      .get(this.accountId, mailbox);
    if (!progress) return;
    const activeGeneration = row.active_thread_generation as number;
    const stagedGeneration = row.staged_thread_generation as number | null;
    if (stagedGeneration !== null && stagedGeneration !== activeGeneration) {
      database
        .prepare(
          `DELETE FROM thread_mailboxes
            WHERE account_id = ? AND mailbox_id = ? AND generation = ?`,
        )
        .run(this.accountId, mailbox, stagedGeneration);
    }
    database
      .prepare(
        `DELETE FROM mailbox_hydration_progress
          WHERE account_id = ? AND mailbox_id = ?`,
      )
      .run(this.accountId, mailbox);
    database
      .prepare("DELETE FROM pending_thread_refresh WHERE account_id = ?")
      .run(this.accountId);
    if (
      activeGeneration > 0 &&
      typeof row.observed_history_id === "string" &&
      Number.isSafeInteger(row.last_successful_at)
    ) {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET staged_thread_generation = NULL,
                  initial_anchor_history_id = NULL, page_token = NULL,
                  status = 'idle', last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
    } else {
      database
        .prepare(
          `UPDATE mailbox_sync_state
              SET active_thread_generation = 0,
                  staged_thread_generation = NULL,
                  observed_history_id = NULL, initial_anchor_history_id = NULL,
                  page_token = NULL, status = 'uninitialized',
                  last_successful_at = NULL, last_error_code = NULL
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
      database
        .prepare(
          `DELETE FROM mailbox_snapshot_metadata
            WHERE account_id = ? AND mailbox_id = ?`,
        )
        .run(this.accountId, mailbox);
    }
    this.deleteUnreferencedMailboxMemberships(database);
  }

  private queueHydrationRefreshes(
    database: DatabaseSync,
    changes: readonly MailCacheIncrementalChange[],
    now: number,
  ): void {
    const progressRows = database
      .prepare(
        `SELECT mailbox_id
           FROM mailbox_hydration_progress
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    if (progressRows.length === 0) return;
    if (progressRows.length !== 1) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const mailbox = validateHydratableMailboxId(
      progressRows[0]?.mailbox_id,
    );
    const queue = database.prepare(
      `INSERT INTO pending_thread_refresh(account_id, thread_id, queued_at)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id, thread_id) DO UPDATE SET
         queued_at = CASE
           WHEN excluded.queued_at > pending_thread_refresh.queued_at
             THEN excluded.queued_at
           ELSE pending_thread_refresh.queued_at
         END`,
    );
    const ids = new Set<string>();
    for (const change of changes) {
      ids.add(
        change.kind === "upsert"
          ? validateProviderId(change.value.thread.threadId)
          : validateProviderId(change.threadId),
      );
    }
    for (const threadId of ids) queue.run(this.accountId, threadId, now);
    const count = database
      .prepare(
        `SELECT COUNT(*) AS count
           FROM pending_thread_refresh
          WHERE account_id = ?`,
      )
      .get(this.accountId)?.count;
    if (!Number.isSafeInteger(count)) {
      throw new MailCacheError("mail_cache_invalid");
    }
    if ((count as number) > MAX_PENDING_THREAD_REFRESHES) {
      this.resetMailboxHydrationInDatabase(database, mailbox);
    }
  }

  private deleteUnreferencedThreadGenerations(
    database: DatabaseSync,
    protectedGenerations: readonly number[],
  ): void {
    const protectedSet = new Set(
      protectedGenerations.filter((generation) => generation > 0),
    );
    const rows = database
      .prepare(
        `SELECT DISTINCT generation
           FROM threads
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    const referenced = database
      .prepare(
        `SELECT active_thread_generation AS generation
           FROM mailbox_sync_state
          WHERE account_id = ? AND active_thread_generation > 0
         UNION
         SELECT staged_thread_generation AS generation
           FROM mailbox_sync_state
          WHERE account_id = ? AND staged_thread_generation IS NOT NULL`,
      )
      .all(this.accountId, this.accountId);
    for (const row of referenced) {
      if (!Number.isSafeInteger(row.generation) || (row.generation as number) < 1) {
        throw new MailCacheError("mail_cache_invalid");
      }
      protectedSet.add(row.generation as number);
    }
    const remove = database.prepare(
      "DELETE FROM threads WHERE account_id = ? AND generation = ?",
    );
    for (const row of rows) {
      if (!Number.isSafeInteger(row.generation) || (row.generation as number) < 1) {
        throw new MailCacheError("mail_cache_invalid");
      }
      const generation = row.generation as number;
      if (!protectedSet.has(generation)) {
        remove.run(this.accountId, generation);
      }
    }
    database
      .prepare(
        `DELETE FROM mail_search_fts
          WHERE account_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM threads
               WHERE threads.rowid = mail_search_fts.rowid
                 AND threads.account_id = mail_search_fts.account_id
                 AND threads.generation = mail_search_fts.generation
                 AND threads.thread_id = mail_search_fts.thread_id
            )`,
      )
      .run(this.accountId);
  }

  /**
   * Returns freed pages to the filesystem after a committed generation
   * cleanup. Bounded steps keep one call from stalling a sync tick; whatever
   * remains on the freelist is released by the next cleanup and never counts
   * against admission. Best-effort by design: the cleanup transaction has
   * already committed, so a vacuum failure must not fail the caller.
   */
  private releaseFreePages(): void {
    if (!this.autoVacuumIncremental) return;
    const database = this.requireDatabase();
    try {
      for (let step = 0; step < INCREMENTAL_VACUUM_MAX_STEPS; step += 1) {
        const freelist = database
          .prepare("PRAGMA freelist_count")
          .get()?.freelist_count;
        if (!Number.isSafeInteger(freelist) || (freelist as number) < 1) return;
        database.exec(
          `PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES_PER_STEP})`,
        );
      }
    } catch {
      // Space release is opportunistic.
    }
  }

  private deleteUnreferencedMailboxMemberships(database: DatabaseSync): void {
    database
      .prepare(
        `DELETE FROM thread_mailboxes AS membership
          WHERE membership.account_id = ?
            AND NOT EXISTS (
              SELECT 1
                FROM mailbox_sync_state AS state
               WHERE state.account_id = membership.account_id
                 AND state.mailbox_id = membership.mailbox_id
                 AND (
                   state.active_thread_generation = membership.generation OR
                   state.staged_thread_generation = membership.generation
                 )
            )`,
      )
      .run(this.accountId);
  }

  private readMailboxHistoryCycle(
    database: DatabaseSync,
  ): MailboxHistoryCycle | null {
    const rows = database
      .prepare(
        `SELECT start_history_id, next_page_token
           FROM mailbox_history_cycle
          WHERE account_id = ?`,
      )
      .all(this.accountId);
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new MailCacheError("mail_cache_invalid");
    const row = rows[0];
    if (
      typeof row?.start_history_id !== "string" ||
      typeof row.next_page_token !== "string"
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return Object.freeze({
      startHistoryId: validateHistoryId(row.start_history_id),
      nextPageToken: validateOptionalPageToken(row.next_page_token)!,
    });
  }

  private clearMailboxHistoryCycle(database: DatabaseSync): void {
    database
      .prepare("DELETE FROM mailbox_history_cycle WHERE account_id = ?")
      .run(this.accountId);
  }

  private reconcileMailboxHistoryCycle(
    database: DatabaseSync,
    state: MailCacheSyncState,
  ): void {
    const cycle = this.readMailboxHistoryCycle(database);
    if (cycle === null) return;
    const recoverableIncrementalCycle =
      state.activeGeneration > 0 &&
      state.stagedGeneration === null &&
      state.initialAnchorHistoryId === null &&
      state.historyId !== null &&
      state.lastSuccessfulAt !== null &&
      state.pageToken !== null &&
      (state.status === "syncing" ||
        state.status === "backoff" ||
        state.status === "reauth_required") &&
      cycle.startHistoryId === state.historyId &&
      cycle.nextPageToken === state.pageToken;
    if (!recoverableIncrementalCycle) {
      this.clearMailboxHistoryCycle(database);
    }
  }

  private startMailboxHistoryCycle(
    database: DatabaseSync,
    startHistoryId: string,
    nextPageToken: string,
  ): void {
    database
      .prepare(
        `INSERT INTO mailbox_history_cycle(
           account_id, start_history_id, next_page_token
         ) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           start_history_id = excluded.start_history_id,
           next_page_token = excluded.next_page_token`,
      )
      .run(this.accountId, startHistoryId, nextPageToken);
  }

  private continueMailboxHistoryCycle(
    database: DatabaseSync,
    startHistoryId: string,
    expectedPageToken: string,
    nextPageToken: string,
  ): boolean {
    const result = database
      .prepare(
        `UPDATE mailbox_history_cycle
            SET next_page_token = ?
          WHERE account_id = ? AND start_history_id = ?
            AND next_page_token = ?`,
      )
      .run(
        nextPageToken,
        this.accountId,
        startHistoryId,
        expectedPageToken,
      );
    return result.changes === 1;
  }

  /**
   * Mirrors the legacy initial-sync staging boundary without allocating a
   * second generation. The previous complete Inbox remains readable until the
   * legacy generation is published. Other mailbox rows are only lower-bound
   * staging data because the legacy sync still enumerates Inbox alone.
   */
  private prepareMailboxInitialGeneration(
    activeGeneration: number,
    stagedGeneration: number,
    anchorHistoryId: string,
    observedHistoryId: string | null,
    lastSuccessfulAt: number | null,
    pageToken: string | null,
  ): void {
    validateGeneration(stagedGeneration);
    if (
      activeGeneration < 0 ||
      !Number.isSafeInteger(activeGeneration) ||
      stagedGeneration <= activeGeneration
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    this.prepareMailboxInitialGenerationInDatabase(
      this.requireDatabase(),
      activeGeneration,
      stagedGeneration,
      anchorHistoryId,
      observedHistoryId,
      lastSuccessfulAt,
      pageToken,
    );
  }

  private prepareMailboxInitialGenerationInDatabase(
    database: DatabaseSync,
    activeGeneration: number,
    stagedGeneration: number,
    anchorHistoryId: string,
    observedHistoryId: string | null,
    lastSuccessfulAt: number | null,
    pageToken: string | null,
  ): void {
    database
      .prepare(
        `UPDATE mailbox_sync_state
            SET staged_thread_generation = ?, observed_history_id = NULL,
                initial_anchor_history_id = NULL, page_token = NULL,
                status = 'uninitialized', last_successful_at = NULL,
                last_error_code = NULL
          WHERE account_id = ? AND mailbox_id <> 'inbox'
            AND active_thread_generation = 0`,
      )
      .run(stagedGeneration, this.accountId);
    database
      .prepare(
        `UPDATE mailbox_sync_state
            SET active_thread_generation = ?, staged_thread_generation = ?,
                observed_history_id = ?, initial_anchor_history_id = ?,
                page_token = ?, status = 'syncing', last_successful_at = ?,
                last_error_code = NULL
          WHERE account_id = ? AND mailbox_id = 'inbox'`,
      )
      .run(
        activeGeneration,
        stagedGeneration,
        activeGeneration > 0 ? observedHistoryId : null,
        anchorHistoryId,
        pageToken,
        activeGeneration > 0 ? lastSuccessfulAt : null,
        this.accountId,
      );
    this.deleteUnreferencedMailboxMemberships(database);
    database
      .prepare(
        `INSERT OR IGNORE INTO thread_mailboxes(
           account_id, mailbox_id, generation, thread_id
         )
         SELECT account_id, 'inbox', generation, thread_id
           FROM threads
          WHERE account_id = ? AND generation = ? AND in_inbox = 1
         UNION ALL
         SELECT account_id, 'all', generation, thread_id
           FROM threads
          WHERE account_id = ? AND generation = ? AND in_inbox = 1
            AND EXISTS (
              SELECT 1 FROM mailbox_sync_state AS state
               WHERE state.account_id = threads.account_id
                 AND state.mailbox_id = 'all'
                 AND state.staged_thread_generation = threads.generation
            )`,
      )
      .run(
        this.accountId,
        stagedGeneration,
        this.accountId,
        stagedGeneration,
      );
  }

  private upsertThread(
    generation: number,
    value: CachedProviderThread,
    hydrationMailbox: MailCacheHydratableMailbox | null = null,
  ): void {
    validateGeneration(generation);
    const thread = validateCachedThread(value, this.accountId);
    const database = this.requireDatabase();
    const existingThread =
      hydrationMailbox === null
        ? undefined
        : database
            .prepare(
              `SELECT in_inbox
                 FROM threads
                WHERE account_id = ? AND generation = ? AND thread_id = ?`,
            )
            .get(this.accountId, generation, thread.thread.threadId);
    if (
      existingThread !== undefined &&
      existingThread.in_inbox !== 0 &&
      existingThread.in_inbox !== 1
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const preservedMessageInbox = new Map<string, boolean>();
    if (hydrationMailbox !== null) {
      const rows = database
        .prepare(
          `SELECT message_id, in_inbox
             FROM messages
            WHERE account_id = ? AND generation = ? AND thread_id = ?`,
        )
        .all(this.accountId, generation, thread.thread.threadId);
      for (const row of rows) {
        if (
          typeof row.message_id !== "string" ||
          (row.in_inbox !== 0 && row.in_inbox !== 1)
        ) {
          throw new MailCacheError("mail_cache_invalid");
        }
        preservedMessageInbox.set(row.message_id, row.in_inbox === 1);
      }
    }
    const threadInInbox =
      hydrationMailbox === null
        ? thread.inInbox
        : existingThread?.in_inbox === 1;
    database
      .prepare(
        `INSERT INTO threads(
           account_id, generation, thread_id, subject, participants_json,
           snippet, last_message_at, message_count, unread, starred,
           has_attachments, in_inbox, list_message, size_bytes, sort_sender,
           category
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, generation, thread_id) DO UPDATE SET
           subject = excluded.subject,
           participants_json = excluded.participants_json,
           snippet = excluded.snippet,
           last_message_at = excluded.last_message_at,
           message_count = excluded.message_count,
           unread = excluded.unread,
           starred = excluded.starred,
           has_attachments = excluded.has_attachments,
           in_inbox = excluded.in_inbox,
           list_message = excluded.list_message,
           size_bytes = excluded.size_bytes,
           sort_sender = excluded.sort_sender,
           category = excluded.category`,
      )
      .run(
        this.accountId,
        generation,
        thread.thread.threadId,
        thread.thread.subject,
        JSON.stringify(thread.thread.participants),
        thread.thread.snippet,
        thread.thread.lastMessageAt,
        thread.thread.messageCount,
        thread.thread.unread ? 1 : 0,
        thread.thread.starred ? 1 : 0,
        thread.thread.hasAttachments ? 1 : 0,
        threadInInbox ? 1 : 0,
        thread.thread.listMessage ? 1 : 0,
        thread.thread.sizeBytes,
        normalizeSortSender(thread.thread.participants),
        thread.thread.category,
      );
    // Refresh message rows in place. Deleting and re-inserting them cascades
    // into the owner-demand and privacy-cohort rows that keep a fetched body
    // alive, so every thread refresh evicted the body the owner had just opened.
    const insertMessage = database.prepare(
      `INSERT INTO messages(
         account_id, generation, message_id, thread_id, from_json, reply_to_json,
         reply_to_complete, to_json, cc_json, subject, sent_at, unread, in_inbox,
         snippet, text_body, html_body, rfc_message_id, references_json,
         has_attachments
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, generation, message_id) DO UPDATE SET
         thread_id = excluded.thread_id,
         from_json = excluded.from_json,
         reply_to_json = excluded.reply_to_json,
         reply_to_complete = excluded.reply_to_complete,
         to_json = excluded.to_json,
         cc_json = excluded.cc_json,
         subject = excluded.subject,
         sent_at = excluded.sent_at,
         unread = excluded.unread,
         in_inbox = excluded.in_inbox,
         snippet = excluded.snippet,
         text_body = excluded.text_body,
         html_body = excluded.html_body,
         rfc_message_id = excluded.rfc_message_id,
         references_json = excluded.references_json,
         has_attachments = excluded.has_attachments`,
    );
    for (const message of thread.messages) {
      insertMessage.run(
        this.accountId,
        generation,
        message.messageId,
        message.threadId,
        message.from === null ? null : JSON.stringify(message.from),
        JSON.stringify(message.replyTo),
        JSON.stringify(message.to),
        JSON.stringify(message.cc),
        message.subject,
        message.sentAt,
        message.unread ? 1 : 0,
        hydrationMailbox === null
          ? message.inInbox
            ? 1
            : 0
          : preservedMessageInbox.get(message.messageId)
            ? 1
            : 0,
        message.snippet,
        message.textBody,
        message.htmlBody,
        message.rfcMessageId,
        JSON.stringify(message.references),
        message.hasAttachments ? 1 : 0,
      );
    }
    const keptMessageIds = thread.messages.map((message) => message.messageId);
    database
      .prepare(
        `DELETE FROM messages
          WHERE account_id = ? AND generation = ? AND thread_id = ?
            AND message_id NOT IN (${keptMessageIds.map(() => "?").join(", ")})`,
      )
      .run(this.accountId, generation, thread.thread.threadId, ...keptMessageIds);
    if (hydrationMailbox === null) {
      this.replaceThreadMailboxMemberships(generation, thread);
    } else {
      this.replaceHydrationMailboxMembership(
        generation,
        hydrationMailbox,
        thread,
      );
    }
    this.reindexSearchThread(
      database,
      generation,
      thread.thread.threadId,
    );
  }

  /**
   * A hidden mailbox crawl may refresh shared message content, but it must not
   * publish membership changes for Inbox or another mailbox whose History
   * cursor did not move. Only the mailbox currently being hydrated is staged.
   */
  private replaceHydrationMailboxMembership(
    generation: number,
    mailbox: MailCacheHydratableMailbox,
    value: CachedProviderThread,
  ): void {
    const database = this.requireDatabase();
    const threadId = value.thread.threadId;
    database
      .prepare(
        `DELETE FROM thread_mailboxes
          WHERE account_id = ? AND mailbox_id = ?
            AND generation = ? AND thread_id = ?`,
      )
      .run(this.accountId, mailbox, generation, threadId);
    if (!normalizedThreadMailboxes(value).includes(mailbox)) return;
    database
      .prepare(
        `INSERT INTO thread_mailboxes(
           account_id, mailbox_id, generation, thread_id
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(this.accountId, mailbox, generation, threadId);
  }

  private removeHydrationMailboxMembership(
    generation: number,
    mailbox: MailCacheHydratableMailbox,
    threadId: string,
  ): void {
    const database = this.requireDatabase();
    database
      .prepare(
        `DELETE FROM thread_mailboxes
          WHERE account_id = ? AND mailbox_id = ?
            AND generation = ? AND thread_id = ?`,
      )
      .run(this.accountId, mailbox, generation, threadId);
    const referenced = database
      .prepare(
        `SELECT 1 AS present
           FROM thread_mailboxes
          WHERE account_id = ? AND generation = ? AND thread_id = ?
          LIMIT 1`,
      )
      .get(this.accountId, generation, threadId);
    if (!referenced) {
      this.deleteSearchThread(database, generation, threadId);
      database
        .prepare(
          `DELETE FROM threads
            WHERE account_id = ? AND generation = ? AND thread_id = ?`,
        )
        .run(this.accountId, generation, threadId);
    }
  }

  /**
   * Replaces memberships beside the thread write, inside the caller's legacy
   * transaction. A mailbox can only reference the same thread generation that
   * already exists in `threads`; it never owns or increments a generation.
   */
  private replaceThreadMailboxMemberships(
    generation: number,
    value: CachedProviderThread,
  ): void {
    const database = this.requireDatabase();
    const threadId = value.thread.threadId;
    const mailboxes = normalizedThreadMailboxes(value);
    database
      .prepare(
        `DELETE FROM thread_mailboxes
          WHERE account_id = ? AND generation = ? AND thread_id = ?`,
      )
      .run(this.accountId, generation, threadId);
    const insert = database.prepare(
      `INSERT INTO thread_mailboxes(account_id, mailbox_id, generation, thread_id)
       VALUES (?, ?, ?, ?)`,
    );
    for (const mailbox of mailboxes) {
      if (this.ensureMailboxMembershipGeneration(mailbox, generation)) {
        insert.run(this.accountId, mailbox, generation, threadId);
      }
    }
  }

  private ensureMailboxMembershipGeneration(
    mailbox: MailCacheMailbox,
    generation: number,
  ): boolean {
    const database = this.requireDatabase();
    const row = database
      .prepare(
        `SELECT active_thread_generation, staged_thread_generation, status
           FROM mailbox_sync_state
          WHERE account_id = ? AND mailbox_id = ?`,
      )
      .get(this.accountId, mailbox);
    if (
      !row ||
      !Number.isSafeInteger(row.active_thread_generation) ||
      (row.staged_thread_generation !== null &&
        !Number.isSafeInteger(row.staged_thread_generation)) ||
      typeof row.status !== "string"
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    if (
      row.active_thread_generation === generation ||
      row.staged_thread_generation === generation
    ) {
      return true;
    }
    const syncState = this.readSyncState();
    if (
      mailbox !== "inbox" &&
      (row.active_thread_generation as number) > 0 &&
      (row.active_thread_generation as number) < generation &&
      row.staged_thread_generation === null &&
      ((syncState.stagedGeneration === generation &&
        syncState.initialAnchorHistoryId !== null) ||
        (syncState.activeGeneration === generation &&
          syncState.stagedGeneration === null))
    ) {
      // An Inbox-only rebuild must not mix an incomplete new-generation
      // lower bound into a complete active snapshot for another mailbox.
      return false;
    }
    if (
      row.status !== "uninitialized" ||
      (row.active_thread_generation as number) >= generation
    ) {
      throw new MailCacheError("mail_sync_stale");
    }
    database
      .prepare(
        `UPDATE mailbox_sync_state
            SET staged_thread_generation = ?
          WHERE account_id = ? AND mailbox_id = ?`,
      )
      .run(generation, this.accountId, mailbox);
    return true;
  }

  private threadFromRow(row: Record<string, unknown>): MailThreadListItem {
    if (
      typeof row.thread_id !== "string" ||
      (row.subject !== null && typeof row.subject !== "string") ||
      typeof row.participants_json !== "string" ||
      (row.snippet !== null && typeof row.snippet !== "string") ||
      (row.last_message_at !== null && !Number.isSafeInteger(row.last_message_at)) ||
      !Number.isSafeInteger(row.message_count) ||
      (row.unread !== 0 && row.unread !== 1) ||
      (row.starred !== 0 && row.starred !== 1) ||
      (row.has_attachments !== 0 && row.has_attachments !== 1) ||
      (row.list_message !== 0 && row.list_message !== 1) ||
      !Number.isSafeInteger(row.size_bytes) ||
      (row.size_bytes as number) < 0 ||
      (row.category !== "people" &&
        row.category !== "notification" &&
        row.category !== "newsletter")
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    return Object.freeze({
      accountId: this.accountId,
      threadId: validateProviderId(row.thread_id),
      subject: row.subject,
      participants: parseAddressesJson(row.participants_json),
      snippet: row.snippet,
      lastMessageAt: row.last_message_at as number | null,
      messageCount: row.message_count as number,
      unread: row.unread === 1,
      starred: row.starred === 1,
      hasAttachments: row.has_attachments === 1,
      listMessage: row.list_message === 1,
      sizeBytes: row.size_bytes as number,
      category: row.category,
    });
  }

  private messageFromRow(row: Record<string, unknown>): MailMessageDto {
    if (
      typeof row.message_id !== "string" ||
      typeof row.thread_id !== "string" ||
      (row.from_json !== null && typeof row.from_json !== "string") ||
      typeof row.reply_to_json !== "string" ||
      typeof row.to_json !== "string" ||
      typeof row.cc_json !== "string" ||
      (row.subject !== null && typeof row.subject !== "string") ||
      (row.sent_at !== null && !Number.isSafeInteger(row.sent_at)) ||
      (row.unread !== 0 && row.unread !== 1) ||
      (row.in_inbox !== 0 && row.in_inbox !== 1) ||
      (row.snippet !== null && typeof row.snippet !== "string") ||
      (row.text_body !== null && typeof row.text_body !== "string") ||
      (row.html_body !== null && typeof row.html_body !== "string") ||
      (row.rfc_message_id !== null && typeof row.rfc_message_id !== "string") ||
      typeof row.references_json !== "string" ||
      (row.has_attachments !== 0 && row.has_attachments !== 1)
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const from =
      row.from_json === null ? null : parseAddressJson(row.from_json);
    return Object.freeze({
      accountId: this.accountId,
      messageId: validateProviderId(row.message_id),
      threadId: validateProviderId(row.thread_id),
      from,
      replyTo: parseAddressesJson(row.reply_to_json),
      to: parseAddressesJson(row.to_json),
      cc: parseAddressesJson(row.cc_json),
      subject: row.subject,
      sentAt: row.sent_at as number | null,
      unread: row.unread === 1,
      inInbox: row.in_inbox === 1,
      snippet: row.snippet,
      textBody: row.text_body,
      htmlBody: row.html_body,
      hasAttachments: row.has_attachments === 1,
    });
  }

  private transaction<T>(operation: () => T): T {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw cacheError(error);
    }
  }

  private assertCacheAdmission(threads: readonly CachedProviderThread[]): void {
    const database = this.requireDatabase();
    const pageCount = database.prepare("PRAGMA page_count").get()?.page_count;
    const pageSize = database.prepare("PRAGMA page_size").get()?.page_size;
    const freelistCount = database
      .prepare("PRAGMA freelist_count")
      .get()?.freelist_count;
    if (
      !Number.isSafeInteger(pageCount) ||
      !Number.isSafeInteger(pageSize) ||
      !Number.isSafeInteger(freelistCount) ||
      (pageCount as number) < 0 ||
      (pageSize as number) < 512 ||
      (freelistCount as number) < 0 ||
      (freelistCount as number) > (pageCount as number)
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    const incomingBytes = threads.reduce(
      (total, thread) => total + estimateThreadBytes(thread),
      0,
    );
    // Freelist pages are reclaimable, not live data. Charging the file's
    // high-water mark here would let one transient resync peak (staging a new
    // generation beside the old one) wedge admission permanently.
    const liveBytes =
      ((pageCount as number) - (freelistCount as number)) *
      (pageSize as number);
    if (
      liveBytes + incomingBytes * CACHE_WRITE_OVERHEAD_MULTIPLIER >
      MAX_ACCOUNT_CACHE_BYTES
    ) {
      throw new MailCacheError("mail_cache_capacity");
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new MailCacheError("mail_cache_unavailable");
    return this.database;
  }
}

export type MailCacheErrorCode =
  | "mail_cache_invalid"
  | "mail_cache_capacity"
  | "mail_cache_schema_unsupported"
  | "mail_cache_unavailable"
  | "mail_request_invalid"
  | "mail_sync_stale";

export class MailCacheError extends Error {
  constructor(readonly code: MailCacheErrorCode) {
    super(code);
    this.name = "MailCacheError";
  }
}

function validateCachedThread(
  value: CachedProviderThread,
  accountId: string,
): CachedProviderThread {
  normalizedThreadMailboxes(value);
  if (
    value.thread.accountId !== accountId ||
    typeof value.thread.starred !== "boolean" ||
    value.messages.length < 1 ||
    value.messages.length > MAX_MESSAGES_PER_THREAD ||
    value.thread.messageCount !== value.messages.length ||
    value.messages.some(
      (message) =>
        message.accountId !== accountId ||
        message.threadId !== value.thread.threadId,
    )
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  validateProviderId(value.thread.threadId);
  for (const message of value.messages) validateProviderId(message.messageId);
  validateBoundedNullableText(value.thread.subject, 998);
  validateBoundedNullableText(value.thread.snippet, 4 * 1024);
  validateAddresses(value.thread.participants);
  if (
    value.thread.lastMessageAt !== null &&
    (!Number.isSafeInteger(value.thread.lastMessageAt) || value.thread.lastMessageAt < 0)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (
    typeof value.thread.listMessage !== "boolean" ||
    value.thread.listMessage !==
      value.messages.some((message) => message.listMessage) ||
    !Number.isSafeInteger(value.thread.sizeBytes) ||
    value.thread.sizeBytes < 0 ||
    value.thread.sizeBytes !==
      value.messages.reduce(
        (total, message) => total + (message.sizeEstimate ?? 0),
        0,
      )
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  for (const message of value.messages) {
    if (
      typeof message.listMessage !== "boolean" ||
      (message.sizeEstimate !== null &&
        (!Number.isSafeInteger(message.sizeEstimate) ||
          message.sizeEstimate < 0))
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    validateBoundedNullableText(message.subject, 998);
    validateBoundedNullableText(message.snippet, 4 * 1024);
    validateBoundedNullableText(message.textBody, 1024 * 1024);
    validateBoundedNullableText(message.htmlBody, 2 * 1024 * 1024);
    if (message.rfcMessageId !== null) validateRfcMessageId(message.rfcMessageId);
    validateReferences(message.references);
    if (
      message.sentAt !== null &&
      (!Number.isSafeInteger(message.sentAt) || message.sentAt < 0)
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
    if (message.from !== null) validateAddresses([message.from]);
    validateAddresses(message.replyTo);
    validateAddresses(message.to);
    validateAddresses(message.cc);
  }
  return value;
}

function normalizedThreadMailboxes(
  value: CachedProviderThread,
): readonly MailCacheMailbox[] {
  if (!Array.isArray(value.mailboxes)) {
    throw new MailCacheError("mail_cache_invalid");
  }
  const mailboxes: MailCacheMailbox[] = [];
  const seen = new Set<MailCacheMailbox>();
  for (const mailbox of value.mailboxes) {
    if (!MAIL_CACHE_MAILBOXES.includes(mailbox) || seen.has(mailbox)) {
      throw new MailCacheError("mail_cache_invalid");
    }
    seen.add(mailbox);
    mailboxes.push(mailbox);
  }
  if (seen.has("inbox") !== value.inInbox) {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (seen.has("starred") !== value.thread.starred) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze(mailboxes);
}

function validateMailboxId(value: unknown): MailCacheMailbox {
  if (
    typeof value !== "string" ||
    !MAIL_CACHE_MAILBOXES.includes(value as MailCacheMailbox)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value as MailCacheMailbox;
}

function validateHydratableMailboxId(
  value: unknown,
): MailCacheHydratableMailbox {
  const mailbox = validateMailboxId(value);
  if (mailbox === "inbox") {
    throw new MailCacheError("mail_cache_invalid");
  }
  return mailbox;
}

function validateMailboxRetryCandidates(
  value: readonly MailCacheHydratableMailbox[],
): readonly MailCacheHydratableMailbox[] {
  if (!Array.isArray(value) || value.length > MAIL_CACHE_HYDRATION_ORDER.length) {
    throw new MailCacheError("mail_cache_invalid");
  }
  const candidates: MailCacheHydratableMailbox[] = [];
  const seen = new Set<MailCacheHydratableMailbox>();
  for (const entry of value) {
    const mailbox = validateHydratableMailboxId(entry);
    if (seen.has(mailbox)) throw new MailCacheError("mail_cache_invalid");
    seen.add(mailbox);
    candidates.push(mailbox);
  }
  return Object.freeze(candidates);
}

function validateMailboxRetryIndex(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= MAIL_CACHE_HYDRATION_ORDER.length
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value as number;
}

function validateMailboxHydrationPageCount(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_MAILBOX_HYDRATION_PAGE_THREADS
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function validatePendingRefreshLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PENDING_THREAD_REFRESH_PAGE
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function estimateThreadBytes(thread: CachedProviderThread): number {
  let total =
    Buffer.byteLength(thread.thread.threadId) +
    Buffer.byteLength(JSON.stringify(thread.thread.participants)) +
    (thread.thread.subject === null ? 0 : Buffer.byteLength(thread.thread.subject)) +
    (thread.thread.snippet === null ? 0 : Buffer.byteLength(thread.thread.snippet)) +
    1024;
  for (const message of thread.messages) {
    total +=
      Buffer.byteLength(message.messageId) +
      Buffer.byteLength(JSON.stringify(message.from)) +
      Buffer.byteLength(JSON.stringify(message.replyTo)) +
      Buffer.byteLength(JSON.stringify(message.to)) +
      Buffer.byteLength(JSON.stringify(message.cc)) +
      Buffer.byteLength(JSON.stringify(message.references)) +
      (message.subject === null ? 0 : Buffer.byteLength(message.subject)) +
      (message.snippet === null ? 0 : Buffer.byteLength(message.snippet)) +
      (message.textBody === null ? 0 : Buffer.byteLength(message.textBody)) +
      (message.htmlBody === null ? 0 : Buffer.byteLength(message.htmlBody)) +
      (message.rfcMessageId === null ? 0 : Buffer.byteLength(message.rfcMessageId)) +
      1024;
  }
  return total;
}

function validateRfcMessageId(value: string): string {
  if (
    Buffer.byteLength(value) > 998 ||
    !/^<[^<>\s\u0000-\u001f\u007f]+>$/.test(value)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function validateReferences(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 100) {
    throw new MailCacheError("mail_cache_invalid");
  }
  const unique = new Set<string>();
  for (const value of values) {
    validateRfcMessageId(value);
    if (unique.has(value)) throw new MailCacheError("mail_cache_invalid");
    unique.add(value);
  }
  return values;
}

function parseReferencesJson(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze([...validateReferences(parsed)]);
}

function validateAddresses(values: readonly MailAddress[]): void {
  if (values.length > 100) throw new MailCacheError("mail_cache_invalid");
  for (const value of values) {
    if (
      typeof value.address !== "string" ||
      value.address.length === 0 ||
      Buffer.byteLength(value.address) > 320 ||
      /[\u0000-\u001f\u007f]/.test(value.address) ||
      !/^[^@\s<>]+@[^@.\s<>]+(?:\.[^@.\s<>]+)+$/.test(value.address) ||
      (value.name !== null &&
        (typeof value.name !== "string" ||
          Buffer.byteLength(value.name) > 256 ||
          value.name.includes("\u0000")))
    ) {
      throw new MailCacheError("mail_cache_invalid");
    }
  }
}

/**
 * Cache-internal sender sort key, never exposed on the wire. It is normalized
 * in JS because node:sqlite has no ICU and SQLite lower() is ASCII-only, so
 * ORDER BY and the keyset cursor both compare this prenormalized value with
 * BINARY collation. '' means unknown sender and sorts first in ASC.
 */
/**
 * Automated-sender predicate over a full from address. Duplicated
 * byte-equivalently in the Gmail and IMAP adapters; used here only by the
 * bounded category pre-seed on open.
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

function normalizeSortSender(participants: readonly MailAddress[]): string {
  const first = participants[0];
  if (!first) return "";
  const key = (first.name === null ? "" : first.name.trim()) || first.address;
  const normalized = key
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^["'<\s]+/, "")
    .replace(/[\u0000-\u001f\u007f]/g, "");
  return [...normalized].slice(0, 128).join("");
}

function validateBoundedNullableText(value: string | null, maxBytes: number): void {
  if (
    value !== null &&
    (typeof value !== "string" ||
      Buffer.byteLength(value) > maxBytes ||
      value.includes("\u0000"))
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
}

function validateSyncStateRow(row: Record<string, unknown> | undefined): MailCacheSyncState {
  if (
    !row ||
    !Number.isSafeInteger(row.active_generation) ||
    (row.staged_generation !== null && !Number.isSafeInteger(row.staged_generation)) ||
    (row.history_id !== null && typeof row.history_id !== "string") ||
    (row.initial_anchor_history_id !== null &&
      typeof row.initial_anchor_history_id !== "string") ||
    (row.page_token !== null && typeof row.page_token !== "string") ||
    !["idle", "syncing", "backoff", "reauth_required"].includes(String(row.status)) ||
    (row.last_successful_at !== null && !Number.isSafeInteger(row.last_successful_at))
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze({
    activeGeneration: row.active_generation as number,
    stagedGeneration: row.staged_generation as number | null,
    historyId: row.history_id as string | null,
    initialAnchorHistoryId: row.initial_anchor_history_id as string | null,
    pageToken: row.page_token as string | null,
    status: row.status as MailSyncStatus,
    lastSuccessfulAt: row.last_successful_at as number | null,
  });
}

function readBackgroundSyncRow(
  database: DatabaseSync,
  accountId: string,
): MailCacheBackgroundSyncState {
  const row = database
    .prepare(
      `SELECT control.account_id, control.credential_version,
              control.failure_count, control.retry_at,
              control.last_attempt_at, state.status,
              state.last_successful_at, state.last_error_code
         FROM background_sync_control AS control
         JOIN sync_state AS state ON state.account_id = control.account_id
        WHERE control.account_id = ?`,
    )
    .get(accountId);
  if (
    !row ||
    row.account_id !== accountId ||
    (row.credential_version !== null &&
      (!Number.isSafeInteger(row.credential_version) ||
        (row.credential_version as number) < 1)) ||
    !Number.isSafeInteger(row.failure_count) ||
    (row.failure_count as number) < 0 ||
    (row.failure_count as number) > MAX_BACKGROUND_SYNC_FAILURES ||
    (row.retry_at !== null &&
      (!Number.isSafeInteger(row.retry_at) || (row.retry_at as number) < 0)) ||
    (row.last_attempt_at !== null &&
      (!Number.isSafeInteger(row.last_attempt_at) ||
        (row.last_attempt_at as number) < 0)) ||
    !["idle", "syncing", "backoff", "reauth_required"].includes(
      String(row.status),
    ) ||
    (row.last_successful_at !== null &&
      (!Number.isSafeInteger(row.last_successful_at) ||
        (row.last_successful_at as number) < 0)) ||
    (row.last_error_code !== null &&
      (typeof row.last_error_code !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(row.last_error_code))) ||
    (((row.failure_count as number) === 0) !== (row.retry_at === null))
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze({
    accountId,
    credentialVersion: row.credential_version as number | null,
    syncStatus: row.status as MailSyncStatus,
    failureCount: row.failure_count as number,
    retryAt: row.retry_at as number | null,
    lastAttemptAt: row.last_attempt_at as number | null,
    lastSuccessfulAt: row.last_successful_at as number | null,
    lastErrorCode: row.last_error_code as string | null,
  });
}

function validateMailboxStateRow(row: Record<string, unknown>): void {
  const status = String(row.status);
  if (
    typeof row.mailbox_id !== "string" ||
    !MAIL_CACHE_MAILBOXES.includes(row.mailbox_id as MailCacheMailbox) ||
    !Number.isSafeInteger(row.active_thread_generation) ||
    (row.active_thread_generation as number) < 0 ||
    (row.staged_thread_generation !== null &&
      (!Number.isSafeInteger(row.staged_thread_generation) ||
        (row.staged_thread_generation as number) <=
          (row.active_thread_generation as number))) ||
    (row.observed_history_id !== null &&
      typeof row.observed_history_id !== "string") ||
    (row.initial_anchor_history_id !== null &&
      typeof row.initial_anchor_history_id !== "string") ||
    (row.page_token !== null && typeof row.page_token !== "string") ||
    ![
      "uninitialized",
      "syncing",
      "idle",
      "backoff",
      "reauth_required",
    ].includes(status) ||
    (row.last_successful_at !== null &&
      (!Number.isSafeInteger(row.last_successful_at) ||
        (row.last_successful_at as number) < 0)) ||
    (row.last_error_code !== null && typeof row.last_error_code !== "string")
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (row.observed_history_id !== null) {
    validateHistoryId(row.observed_history_id as string);
  }
  if (row.initial_anchor_history_id !== null) {
    validateHistoryId(row.initial_anchor_history_id as string);
  }
  validateOptionalPageToken(row.page_token as string | null);
  if (row.last_error_code !== null) {
    validateErrorCode(row.last_error_code as string);
  }
  if (
    (status === "uninitialized" &&
      (row.observed_history_id !== null ||
        row.initial_anchor_history_id !== null ||
        row.page_token !== null ||
        row.last_successful_at !== null)) ||
    (status === "idle" &&
      ((row.active_thread_generation as number) < 1 ||
        row.staged_thread_generation !== null ||
        row.observed_history_id === null ||
        row.initial_anchor_history_id !== null ||
        row.page_token !== null ||
        row.last_successful_at === null)) ||
    (status === "syncing" &&
      (row.staged_thread_generation === null ||
        row.initial_anchor_history_id === null))
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
}

export function selectWorstMailSyncError(
  values: readonly (string | null)[],
): string | null {
  const priority = new Map<string, number>([
    ["gmail_reauth_required", 0],
    ["mail_provider_reauth_required", 0],
    // A full local cache is a persistent stall, so it must outrank every
    // transient provider error that a retry can clear.
    ["mail_cache_capacity", 1],
    ["mail_provider_response_invalid", 2],
    ["mail_provider_unavailable", 3],
    ["mail_provider_rate_limited", 4],
  ]);
  return values
    .filter((value): value is string => value !== null)
    .sort(
      (left, right) =>
        (priority.get(left) ?? 10) - (priority.get(right) ?? 10) ||
        left.localeCompare(right),
    )[0] ?? null;
}

function readableGeneration(state: MailCacheSyncState): number {
  if (state.activeGeneration > 0) return state.activeGeneration;
  return state.stagedGeneration ?? 0;
}

function validateSearchStateRow(
  row: Record<string, unknown> | undefined,
): MailCacheSearchState {
  if (
    !row ||
    !Number.isSafeInteger(row.generation) ||
    (row.generation as number) < 0 ||
    !Number.isSafeInteger(row.indexed_through_rowid) ||
    (row.indexed_through_rowid as number) < 0 ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    (row.status !== "building" && row.status !== "ready") ||
    ((row.generation as number) === 0 && row.status !== "ready")
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze({
    generation: row.generation as number,
    indexedThroughRowid: row.indexed_through_rowid as number,
    revision: row.revision as number,
    status: row.status,
  });
}

function publicMailboxAvailability(
  value: MailCacheMailboxAvailability,
): MailMailboxAvailability {
  return value.status === "available"
    ? Object.freeze({
        status: "available" as const,
        lastSuccessfulAt: value.lastSuccessfulAt,
        windowTruncated: value.windowTruncated,
      })
    : Object.freeze({
        status: "unavailable" as const,
        reason: value.reason,
        lastSuccessfulAt: value.lastSuccessfulAt,
        windowTruncated: null,
      });
}

function nextSearchRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value + 1;
}

function validateSearchRowId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value as number;
}

function compileSearchFtsQuery(query: string): string {
  if (!/^[\p{L}\p{N}]+(?: [\p{L}\p{N}]+)*$/u.test(query)) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return query
    .split(" ")
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

function encodeSearchCursor(value: {
  readonly fingerprint: string;
  readonly offset: number;
}): string {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(value.fingerprint) ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 1 ||
    value.offset > MAX_SEARCH_CURSOR_OFFSET
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Buffer.from(
    JSON.stringify({ v: 1, f: value.fingerprint, o: value.offset }),
    "utf8",
  ).toString("base64url");
}

function decodeSearchCursor(value: string): {
  readonly fingerprint: string;
  readonly offset: number;
} {
  if (
    value.length < 1 ||
    Buffer.byteLength(value) > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new MailCacheError("mail_request_invalid");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical");
    decoded = JSON.parse(bytes.toString("utf8"));
    bytes.fill(0);
  } catch {
    throw new MailCacheError("mail_request_invalid");
  }
  if (
    !isExactRecord(decoded, ["f", "o", "v"]) ||
    decoded.v !== 1 ||
    typeof decoded.f !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(decoded.f) ||
    !Number.isSafeInteger(decoded.o) ||
    (decoded.o as number) < 1 ||
    (decoded.o as number) > MAX_SEARCH_CURSOR_OFFSET
  ) {
    throw new MailCacheError("mail_request_invalid");
  }
  return Object.freeze({
    fingerprint: decoded.f,
    offset: decoded.o as number,
  });
}

function searchCursorFingerprint(value: {
  readonly accountId: string;
  readonly mailboxId: MailCacheMailbox;
  readonly generation: number;
  readonly observedHistoryId: string;
  readonly revision: number;
  readonly query: string;
}): string {
  return createHash("sha256")
    .update("brain-mail-search-cursor-v1\0", "utf8")
    .update(value.accountId, "utf8")
    .update("\0", "utf8")
    .update(value.mailboxId, "utf8")
    .update("\0", "utf8")
    .update(String(value.generation), "utf8")
    .update("\0", "utf8")
    .update(value.observedHistoryId, "utf8")
    .update("\0", "utf8")
    .update(String(value.revision), "utf8")
    .update("\0", "utf8")
    .update(value.query, "utf8")
    .digest("base64url");
}

function encodeCursor(value: {
  readonly generation: number;
  readonly lastMessageAt: number;
  readonly threadId: string;
}): string {
  return Buffer.from(
    JSON.stringify({ v: 1, g: value.generation, t: value.lastMessageAt, i: value.threadId }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): {
  readonly generation: number;
  readonly lastMessageAt: number;
  readonly threadId: string;
} {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical");
    decoded = JSON.parse(bytes.toString("utf8"));
    bytes.fill(0);
  } catch {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (
    !isExactRecord(decoded, ["g", "i", "t", "v"]) ||
    decoded.v !== 1 ||
    !Number.isSafeInteger(decoded.g) ||
    (decoded.g as number) < 0 ||
    !Number.isSafeInteger(decoded.t) ||
    (decoded.t as number) < -1 ||
    typeof decoded.i !== "string"
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze({
    generation: decoded.g as number,
    lastMessageAt: decoded.t as number,
    threadId: validateProviderId(decoded.i),
  });
}

function encodeMailboxCursor(value: {
  readonly accountId: string;
  readonly mailboxId: MailCacheMailbox;
  readonly generation: number;
  readonly observedHistoryId: string;
  readonly lastMessageAt: number;
  readonly threadId: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      m: value.mailboxId,
      s: mailboxCursorFingerprint(value),
      t: value.lastMessageAt,
      i: value.threadId,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeMailboxCursor(value: string): {
  readonly mailboxId: MailCacheMailbox;
  readonly snapshotFingerprint: string;
  readonly lastMessageAt: number;
  readonly threadId: string;
} {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new MailCacheError("mail_request_invalid");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical");
    decoded = JSON.parse(bytes.toString("utf8"));
    bytes.fill(0);
  } catch {
    throw new MailCacheError("mail_request_invalid");
  }
  if (
    !isExactRecord(decoded, ["i", "m", "s", "t", "v"]) ||
    decoded.v !== 2 ||
    !Number.isSafeInteger(decoded.t) ||
    (decoded.t as number) < -1 ||
    typeof decoded.i !== "string" ||
    typeof decoded.m !== "string" ||
    !MAIL_CACHE_MAILBOXES.includes(decoded.m as MailCacheMailbox) ||
    typeof decoded.s !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(decoded.s) ||
    !SAFE_PROVIDER_ID.test(decoded.i)
  ) {
    throw new MailCacheError("mail_request_invalid");
  }
  return Object.freeze({
    mailboxId: decoded.m as MailCacheMailbox,
    snapshotFingerprint: decoded.s,
    lastMessageAt: decoded.t as number,
    threadId: decoded.i,
  });
}

function mailboxCursorFingerprint(value: {
  readonly accountId: string;
  readonly mailboxId: MailCacheMailbox;
  readonly generation: number;
  readonly observedHistoryId: string;
  readonly lastMessageAt: number;
  readonly threadId: string;
}): string {
  return createHash("sha256")
    .update("brain-mailbox-cursor-v2\0", "utf8")
    .update(value.accountId, "utf8")
    .update("\0", "utf8")
    .update(value.mailboxId, "utf8")
    .update("\0", "utf8")
    .update(String(value.generation), "utf8")
    .update("\0", "utf8")
    .update(value.observedHistoryId, "utf8")
    .update("\0", "utf8")
    .update(String(value.lastMessageAt), "utf8")
    .update("\0", "utf8")
    .update(value.threadId, "utf8")
    .digest("base64url");
}

function validateThreadView(value: unknown): MailThreadView | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !THREAD_VIEWS.includes(value as MailThreadView)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value as MailThreadView;
}

function validateThreadSort(value: unknown): MailThreadSort {
  if (
    typeof value !== "string" ||
    !THREAD_SORTS.includes(value as MailThreadSort)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value as MailThreadSort;
}

/**
 * The key type is fixed by the sort: null for date, 0|1 for unread, a bounded
 * control-free string for sender, a non-negative safe integer for size.
 */
function validateThreadSortKey(
  sort: MailThreadSort,
  key: unknown,
  errorCode: "mail_cache_invalid" | "mail_request_invalid",
): null | number | string {
  switch (sort) {
    case "date":
      if (key !== null) throw new MailCacheError(errorCode);
      return null;
    case "unread":
      if (key !== 0 && key !== 1) throw new MailCacheError(errorCode);
      return key;
    case "sender":
      if (
        typeof key !== "string" ||
        [...key].length > 128 ||
        /[\u0000-\u001f\u007f]/.test(key)
      ) {
        throw new MailCacheError(errorCode);
      }
      return key;
    case "size":
      if (!Number.isSafeInteger(key) || (key as number) < 0) {
        throw new MailCacheError(errorCode);
      }
      return key as number;
  }
}

function threadSortKeyFromRow(
  sort: MailThreadSort,
  row: Record<string, unknown>,
): null | number | string {
  switch (sort) {
    case "date":
      return null;
    case "unread":
      return validateThreadSortKey(sort, row.unread, "mail_cache_invalid");
    case "sender":
      return validateThreadSortKey(sort, row.sort_sender, "mail_cache_invalid");
    case "size":
      return validateThreadSortKey(sort, row.size_bytes, "mail_cache_invalid");
  }
}

interface ThreadViewCursor {
  readonly snapshotFingerprint: string;
  readonly mailboxId: MailCacheMailbox | null;
  readonly key: null | number | string;
  readonly lastMessageAt: number;
  readonly threadId: string;
}

function threadSortKeysetBindings(
  sort: MailThreadSort,
  cursor: ThreadViewCursor,
): readonly (number | string)[] {
  const tail = Object.freeze([
    cursor.lastMessageAt,
    cursor.lastMessageAt,
    cursor.threadId,
  ] as const);
  if (sort === "date") return tail;
  if (cursor.key === null) throw new MailCacheError("mail_cache_invalid");
  return Object.freeze([cursor.key, cursor.key, ...tail]);
}

interface ThreadViewCursorIdentity {
  readonly pathKind: "inbox" | "mailbox";
  readonly accountId: string;
  readonly mailboxId: MailCacheMailbox | null;
  readonly generation: number;
  readonly observedHistoryId: string | null;
  readonly view: MailThreadView | null;
  readonly sort: MailThreadSort;
  readonly key: null | number | string;
  readonly lastMessageAt: number;
  readonly threadId: string;
}

function encodeThreadViewCursor(value: ThreadViewCursorIdentity): string {
  const key = validateThreadSortKey(value.sort, value.key, "mail_cache_invalid");
  if (
    (value.pathKind === "inbox") !== (value.mailboxId === null) ||
    !Number.isSafeInteger(value.lastMessageAt) ||
    value.lastMessageAt < -1 ||
    !SAFE_PROVIDER_ID.test(value.threadId)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Buffer.from(
    JSON.stringify({
      v: 3,
      s: threadViewCursorFingerprint(value),
      m: value.mailboxId,
      k: key,
      t: value.lastMessageAt,
      i: value.threadId,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeThreadViewCursor(
  value: string,
  expected: {
    readonly pathKind: "inbox" | "mailbox";
    readonly sort: MailThreadSort;
  },
): ThreadViewCursor {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new MailCacheError("mail_request_invalid");
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("non-canonical");
    decoded = JSON.parse(bytes.toString("utf8"));
    bytes.fill(0);
  } catch {
    throw new MailCacheError("mail_request_invalid");
  }
  if (
    !isExactRecord(decoded, ["i", "k", "m", "s", "t", "v"]) ||
    decoded.v !== 3 ||
    !Number.isSafeInteger(decoded.t) ||
    (decoded.t as number) < -1 ||
    typeof decoded.i !== "string" ||
    !SAFE_PROVIDER_ID.test(decoded.i) ||
    typeof decoded.s !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(decoded.s) ||
    (expected.pathKind === "inbox"
      ? decoded.m !== null
      : typeof decoded.m !== "string" ||
        !MAIL_CACHE_MAILBOXES.includes(decoded.m as MailCacheMailbox))
  ) {
    throw new MailCacheError("mail_request_invalid");
  }
  const key = validateThreadSortKey(
    expected.sort,
    decoded.k,
    "mail_request_invalid",
  );
  return Object.freeze({
    snapshotFingerprint: decoded.s,
    mailboxId: decoded.m as MailCacheMailbox | null,
    key,
    lastMessageAt: decoded.t as number,
    threadId: decoded.i,
  });
}

/**
 * Binds a v3 cursor to path, account, mailbox, snapshot identity, and the
 * requested view and sort. Verification recomputes this from the request's
 * parameters and the current snapshot, so a replay across a view or sort
 * switch, a generation bump, or mailbox History movement decodes cleanly but
 * fails as mail_sync_stale.
 */
function threadViewCursorFingerprint(value: ThreadViewCursorIdentity): string {
  return createHash("sha256")
    .update("brain-thread-view-cursor-v3\0", "utf8")
    .update(value.pathKind, "utf8")
    .update("\0", "utf8")
    .update(value.accountId, "utf8")
    .update("\0", "utf8")
    .update(value.mailboxId ?? "", "utf8")
    .update("\0", "utf8")
    .update(String(value.generation), "utf8")
    .update("\0", "utf8")
    .update(value.observedHistoryId ?? "", "utf8")
    .update("\0", "utf8")
    .update(value.view ?? "", "utf8")
    .update("\0", "utf8")
    .update(value.sort, "utf8")
    .update("\0", "utf8")
    .update(THREAD_SORT_KEY_TAGS[value.sort], "utf8")
    .update("\0", "utf8")
    .update(value.key === null ? "" : String(value.key), "utf8")
    .update("\0", "utf8")
    .update(String(value.lastMessageAt), "utf8")
    .update("\0", "utf8")
    .update(value.threadId, "utf8")
    .digest("base64url");
}

function parseAddressJson(value: string): MailAddress {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (
    !isExactRecord(parsed, ["address", "name"]) ||
    typeof parsed.address !== "string" ||
    (parsed.name !== null && typeof parsed.name !== "string")
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze({ address: parsed.address, name: parsed.name });
}

function parseAddressesJson(value: string): readonly MailAddress[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new MailCacheError("mail_cache_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length > 200) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Object.freeze(parsed.map((entry) => parseAddressJson(JSON.stringify(entry))));
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) throw new MailCacheError("mail_cache_invalid");
  return value;
}

function validateProviderId(value: string): string {
  if (!SAFE_PROVIDER_ID.test(value)) throw new MailCacheError("mail_cache_invalid");
  return value;
}

function validateHistoryId(value: string): string {
  if (!/^\d{1,32}$/.test(value)) throw new MailCacheError("mail_cache_invalid");
  return value;
}

function validateOptionalPageToken(value: string | null): string | null {
  if (value === null) return null;
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > 2 * 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function validateGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailCacheError("mail_cache_invalid");
  }
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function validateCredentialVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function validateOptionalBackoffDelay(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return Math.min(value, BACKGROUND_SYNC_MAX_BACKOFF_MS);
}

function validateListLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_THREADS_PER_PAGE) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function validateErrorCode(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw new MailCacheError("mail_cache_invalid");
  }
  return value;
}

function requireAbsolutePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new MailCacheError("mail_cache_unavailable");
  }
  return value;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    (uid >= 0 && metadata.uid !== uid)
  ) {
    throw new MailCacheError("mail_cache_unavailable");
  }
}

async function assertContainedPath(root: string, child: string): Promise<void> {
  const [resolvedRoot, resolvedChild] = await Promise.all([realpath(root), realpath(child)]);
  if (!resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new MailCacheError("mail_cache_unavailable");
  }
}

async function ensurePrivateDatabaseFile(filePath: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } finally {
    await handle?.close();
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
    throw new MailCacheError("mail_cache_unavailable");
  }
}

async function ensureSqliteFilesPrivate(databasePath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const handle = await open(`${databasePath}${suffix}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

function cacheError(error: unknown): MailCacheError {
  return error instanceof MailCacheError
    ? error
    : new MailCacheError("mail_cache_unavailable");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isExactRecord(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        fields.includes(key) &&
        descriptors[key] !== undefined &&
        "value" in descriptors[key],
    ) &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}
