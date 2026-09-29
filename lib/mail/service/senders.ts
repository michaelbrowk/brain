import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { domainToASCII } from "node:url";

import type {
  MailBlockedSenders,
  MailMailboxThreadPage,
  MailSearchThreadPage,
  MailSenderDecisionInput,
  MailSenderDecisionKind,
  MailSenderDecisionResult,
  MailSenderDecisionScope,
  MailSenderScreenState,
  MailSenderThreadRef,
  MailSenderUndoResult,
  MailSyncResult,
  MailSystemMailbox,
  MailThreadCategory,
  MailThreadDetail,
  MailThreadListItem,
  MailThreadMutationInput,
  MailThreadMutationResult,
  MailThreadPage,
  MailThreadSort,
  MailThreadView,
} from "../message-types";
import { MailAccountError } from "./account-types";
import {
  MailProviderSyncError,
  type MailBackgroundSyncHealth,
  type MailMessageService,
} from "./message-service";

/*
  The new-senders screen: who is known, what the owner decided about whom, and
  the one flag every thread item carries because of the two.

  Everything here is keyed by a normalized address or a domain and nothing
  else. No name, subject or body is stored, and nothing is ever deleted from a
  mailbox: a block only archives, and its undo moves exactly those threads
  back. The message cache stays the provider's truth; the flag is computed
  when a list is read.
*/

const SCHEMA_VERSION = 1;
const DATABASE_FILE = "senders.sqlite3";
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_DECISION_ID = /^decision-a[0-9a-f]{32}$/;
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_RAW_ADDRESS_LENGTH = 998;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A block archives this many threads inside the owner's request; the rest
 *  wait for the scheduler, and the answer says `pending`. */
export const MAIL_SENDER_BLOCK_REQUEST_LIMIT = 200;
/** Undo moves back as many, on the same terms. */
const RESTORE_REQUEST_LIMIT = 200;
/** One scheduler step touches the provider at most this many times. */
const BACKGROUND_MUTATIONS_PER_STEP = 25;
/** Stop starting provider mutations this long before the request deadline,
 *  so the answer still reaches Brain inside its own timeout. */
const REQUEST_DEADLINE_MARGIN_MS = 1_500;
/** Messages read per backfill step: one window of cache rows. */
const DEFAULT_BACKFILL_WINDOW = 1_000;
/** A thread the archiver could not move is left alone this long. */
const ARCHIVE_FAILURE_BACKOFF_MS = 60 * 60 * 1_000;
/** A restore that keeps failing is given up after this many tries. */
const MAX_RESTORE_ATTEMPTS = 5;
const MAX_BLOCKED_LIST = 1_000;

export type MailSenderErrorCode =
  | "mail_request_invalid"
  | "mail_sender_decision_not_found"
  | "mail_senders_unavailable";

export class MailSenderError extends Error {
  constructor(readonly code: MailSenderErrorCode) {
    super(code);
    this.name = "MailSenderError";
  }
}

/**
 * The one reading of a sender's identity: the bare address, lowercased, with
 * an international domain written in punycode. A display name, angle
 * brackets and RFC 5322 comments are dropped. Null when what is left is not
 * an address, so a malformed From is never known, never decided and never
 * gated.
 */
export function normalizeSenderAddress(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_ADDRESS_LENGTH) {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  let value = raw;
  // Comments may nest, so the innermost pair goes first until none is left.
  for (let pass = 0; pass < 8 && /\([^()]*\)/.test(value); pass += 1) {
    value = value.replace(/\([^()]*\)/g, " ");
  }
  if (/[()]/.test(value)) return null;
  const bracketed = /<([^<>]*)>\s*$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  value = value.trim();
  if (/[\s<>]/.test(value)) return null;
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at).toLowerCase();
  let domain = value.slice(at + 1).toLowerCase();
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (local.length > MAX_LOCAL_PART_LENGTH) return null;
  const ascii = domainToASCII(domain);
  if (
    ascii.length === 0 ||
    ascii.length > 253 ||
    !ascii.split(".").every((label) => DOMAIN_LABEL.test(label))
  ) {
    return null;
  }
  const address = `${local}@${ascii}`;
  return address.length > MAX_ADDRESS_LENGTH ? null : address;
}

/** The domain of an address `normalizeSenderAddress` produced. */
export function senderDomainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1);
}

export interface MailSenderGateInput {
  readonly screenEnabled: boolean;
  readonly backfillComplete: boolean;
  readonly enabledAt: number | null;
  readonly category: MailThreadCategory;
  readonly firstMessageAt: number | null;
  /** The normalized address of the thread's first message's From. */
  readonly sender: string | null;
  readonly known: boolean;
  readonly addressDecision: MailSenderDecisionKind | null;
  readonly domainDecision: MailSenderDecisionKind | null;
}

/**
 * Whether a thread waits for the owner's first decision. Every clause is a
 * way for it not to: the switch, the backfill, the category, the moment, and
 * anything the screen already knows about the sender.
 */
export function isMailSenderGated(input: MailSenderGateInput): boolean {
  return (
    input.screenEnabled &&
    input.backfillComplete &&
    input.enabledAt !== null &&
    input.category === "people" &&
    input.firstMessageAt !== null &&
    input.firstMessageAt > input.enabledAt &&
    input.sender !== null &&
    !input.known &&
    input.addressDecision === null &&
    input.domainDecision === null
  );
}

const SCHEMA_SQL = `
  CREATE TABLE screen_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    enabled_at INTEGER CHECK(enabled_at IS NULL OR enabled_at >= 0),
    CHECK((enabled = 1) = (enabled_at IS NOT NULL))
  ) STRICT;

  CREATE TABLE known_senders (
    address TEXT PRIMARY KEY CHECK(length(address) BETWEEN 3 AND 254),
    source TEXT NOT NULL CHECK(source IN ('backfill', 'sent', 'accept')),
    added_at INTEGER NOT NULL CHECK(added_at >= 0)
  ) STRICT;

  CREATE TABLE sender_decisions (
    decision_id TEXT PRIMARY KEY CHECK(length(decision_id) = 42),
    key TEXT NOT NULL CHECK(length(key) BETWEEN 1 AND 254),
    kind TEXT NOT NULL CHECK(kind IN ('address', 'domain')),
    decision TEXT NOT NULL CHECK(decision IN ('accept', 'block')),
    decided_at INTEGER NOT NULL CHECK(decided_at >= 0),
    UNIQUE(kind, key)
  ) STRICT;

  CREATE INDEX sender_decisions_by_decision
    ON sender_decisions(decision, decided_at DESC);

  CREATE TABLE decision_effects (
    decision_id TEXT NOT NULL
      REFERENCES sender_decisions(decision_id) ON DELETE CASCADE,
    effect TEXT NOT NULL CHECK(effect IN ('known', 'archived')),
    account_id TEXT NOT NULL,
    target TEXT NOT NULL CHECK(length(target) BETWEEN 1 AND 255),
    added_at INTEGER NOT NULL CHECK(added_at >= 0),
    PRIMARY KEY(decision_id, effect, account_id, target),
    CHECK((effect = 'known') = (account_id = ''))
  ) STRICT;

  CREATE TABLE backfill_progress (
    account_id TEXT PRIMARY KEY,
    from_cursor INTEGER NOT NULL CHECK(from_cursor >= 0),
    sent_cursor INTEGER NOT NULL CHECK(sent_cursor >= 0),
    complete INTEGER NOT NULL CHECK(complete IN (0, 1))
  ) STRICT;

  CREATE TABLE pending_restores (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    queued_at INTEGER NOT NULL CHECK(queued_at >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    PRIMARY KEY(account_id, thread_id)
  ) STRICT;
`;

export interface MailSenderFacts {
  readonly known: boolean;
  readonly addressDecision: MailSenderDecisionKind | null;
  readonly domainDecision: MailSenderDecisionKind | null;
}

export interface MailSenderGoverningDecision {
  readonly decisionId: string;
  readonly decision: MailSenderDecisionKind;
}

interface RemovedDecision {
  readonly decision: MailSenderDecisionKind;
  readonly restoreRefs: readonly MailSenderThreadRef[];
}

/**
 * The global store beside `local.sqlite3`: one file for every account,
 * because a person who writes to two of the owner's accounts is one decision.
 * It is durable owner state, not a rebuildable cache: the decisions are the
 * owner's own words.
 */
export class SqliteMailSenderStore {
  private readonly stateDirectory: string;
  private readonly databasePath: string;
  private readonly now: () => number;
  private database: DatabaseSync | null = null;

  constructor(options: { readonly stateDirectory: string; readonly now?: () => number }) {
    if (
      typeof options.stateDirectory !== "string" ||
      options.stateDirectory.includes("\u0000") ||
      !path.isAbsolute(options.stateDirectory) ||
      path.resolve(options.stateDirectory) !== options.stateDirectory
    ) {
      throw new MailSenderError("mail_senders_unavailable");
    }
    this.stateDirectory = options.stateDirectory;
    this.databasePath = path.join(options.stateDirectory, DATABASE_FILE);
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    let database: DatabaseSync | null = null;
    try {
      await assertPrivateDirectory(this.stateDirectory);
      await ensurePrivateDatabaseFile(this.databasePath);
      database = new DatabaseSync(this.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
      database.exec(`
        PRAGMA trusted_schema = OFF;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
      `);
      initializeSchema(database, validTimestamp(this.now()));
      await ensureSqliteFilesPrivate(this.databasePath);
      this.database = database;
      database = null;
    } catch {
      database?.close();
      throw new MailSenderError("mail_senders_unavailable");
    }
  }

  close(): void {
    const database = this.database;
    if (!database) return;
    this.database = null;
    try {
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      database.close();
    }
  }

  readState(): { readonly enabled: boolean; readonly enabledAt: number | null } {
    return this.read((database) => readScreenState(database));
  }

  /**
   * Turning the screen on is the moment "known" is computed, so it starts
   * every account's backfill again from the first cached row. Turning it off
   * forgets the moment; the known list and the decisions stay.
   */
  setEnabled(
    enabled: boolean,
    now: number,
  ): { readonly enabled: boolean; readonly enabledAt: number | null } {
    const timestamp = validTimestamp(now);
    return this.transaction((database) => {
      const current = readScreenState(database);
      if (current.enabled === enabled) return current;
      database
        .prepare("UPDATE screen_state SET enabled = ?, enabled_at = ? WHERE singleton = 1")
        .run(enabled ? 1 : 0, enabled ? timestamp : null);
      if (enabled) database.exec("DELETE FROM backfill_progress");
      return readScreenState(database);
    });
  }

  isBackfillComplete(accountIds: readonly string[]): boolean {
    return this.read((database) => {
      const statement = database.prepare(
        "SELECT complete FROM backfill_progress WHERE account_id = ?",
      );
      return accountIds.every((accountId) => statement.get(accountId)?.complete === 1);
    });
  }

  readBackfillProgress(accountId: string): {
    readonly fromCursor: number;
    readonly sentCursor: number;
    readonly complete: boolean;
  } | null {
    return this.read((database) => {
      const row = database
        .prepare(
          `SELECT from_cursor, sent_cursor, complete
             FROM backfill_progress WHERE account_id = ?`,
        )
        .get(validAccountId(accountId));
      if (row === undefined) return null;
      if (
        !Number.isSafeInteger(row.from_cursor) ||
        !Number.isSafeInteger(row.sent_cursor) ||
        (row.complete !== 0 && row.complete !== 1)
      ) {
        throw new MailSenderError("mail_senders_unavailable");
      }
      return Object.freeze({
        fromCursor: row.from_cursor as number,
        sentCursor: row.sent_cursor as number,
        complete: row.complete === 1,
      });
    });
  }

  /**
   * One backfill step, written only if the screen is still on at the moment
   * the step read from. A switch flipped while the step was reading the cache
   * restarts the backfill, and the stale step must not move its cursors.
   */
  recordBackfillStep(
    accountId: string,
    input: {
      readonly enabledAt: number;
      readonly addresses: readonly string[];
      readonly fromCursor: number;
      readonly sentCursor: number;
      readonly complete: boolean;
    },
  ): void {
    const id = validAccountId(accountId);
    const now = validTimestamp(this.now());
    this.transaction((database) => {
      if (readScreenState(database).enabledAt !== input.enabledAt) return;
      learnKnownIn(database, input.addresses, "backfill", now);
      database
        .prepare(
          `INSERT INTO backfill_progress(account_id, from_cursor, sent_cursor, complete)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE
             SET from_cursor = excluded.from_cursor,
                 sent_cursor = excluded.sent_cursor,
                 complete = excluded.complete`,
        )
        .run(
          id,
          validCursor(input.fromCursor),
          validCursor(input.sentCursor),
          input.complete ? 1 : 0,
        );
    });
  }

  learnKnown(
    addresses: readonly string[],
    source: "backfill" | "sent",
  ): void {
    const now = validTimestamp(this.now());
    this.transaction((database) => learnKnownIn(database, addresses, source, now));
  }

  readSenderFacts(address: string): MailSenderFacts {
    return this.read((database) => {
      const known =
        database.prepare("SELECT 1 AS present FROM known_senders WHERE address = ?").get(
          address,
        ) !== undefined;
      const decision = database.prepare(
        "SELECT decision FROM sender_decisions WHERE kind = ? AND key = ?",
      );
      return Object.freeze({
        known,
        addressDecision: decisionKind(decision.get("address", address)?.decision),
        domainDecision: decisionKind(
          decision.get("domain", senderDomainOf(address))?.decision,
        ),
      });
    });
  }

  /**
   * Every decision, read once, as the rule for which one speaks for an
   * address: its own, or its domain's when it has none, so an address
   * accepted on its own is spared a domain block. A block walks thousands of
   * Inbox threads, and one read beats a query for each of them.
   */
  readDecisionIndex(): (address: string) => MailSenderGoverningDecision | null {
    const byKind = this.read((database) => {
      const addresses = new Map<string, MailSenderGoverningDecision>();
      const domains = new Map<string, MailSenderGoverningDecision>();
      for (const row of database
        .prepare("SELECT decision_id, key, kind, decision FROM sender_decisions")
        .all()) {
        const decision = decisionKind(row.decision);
        if (
          decision === null ||
          typeof row.decision_id !== "string" ||
          typeof row.key !== "string" ||
          (row.kind !== "address" && row.kind !== "domain")
        ) {
          throw new MailSenderError("mail_senders_unavailable");
        }
        (row.kind === "address" ? addresses : domains).set(
          row.key,
          Object.freeze({ decisionId: row.decision_id, decision }),
        );
      }
      return { addresses, domains };
    });
    return (address) =>
      byKind.addresses.get(address) ??
      byKind.domains.get(senderDomainOf(address)) ??
      null;
  }

  hasBlockDecisions(): boolean {
    return this.read(
      (database) =>
        database
          .prepare("SELECT 1 AS present FROM sender_decisions WHERE decision = 'block' LIMIT 1")
          .get() !== undefined,
    );
  }

  /**
   * One decision per address or domain: a new one replaces what was decided
   * before about the same key. An accept also makes the address known and
   * remembers that it did, so its undo takes back exactly that.
   */
  recordDecision(input: {
    readonly decisionId: string;
    readonly key: string;
    readonly kind: MailSenderDecisionScope;
    readonly decision: MailSenderDecisionKind;
    readonly knownAddress: string | null;
  }): void {
    const now = validTimestamp(this.now());
    this.transaction((database) => {
      database
        .prepare("DELETE FROM sender_decisions WHERE kind = ? AND key = ?")
        .run(input.kind, input.key);
      database
        .prepare(
          `INSERT INTO sender_decisions(decision_id, key, kind, decision, decided_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.decisionId, input.key, input.kind, input.decision, now);
      if (input.knownAddress === null) return;
      const added = database
        .prepare(
          `INSERT OR IGNORE INTO known_senders(address, source, added_at)
           VALUES (?, 'accept', ?)`,
        )
        .run(input.knownAddress, now);
      if (added.changes === 1) {
        database
          .prepare(
            `INSERT INTO decision_effects(decision_id, effect, account_id, target, added_at)
             VALUES (?, 'known', '', ?, ?)`,
          )
          .run(input.decisionId, input.knownAddress, now);
      }
    });
  }

  /** Written only while the decision stands, so an undo that won the race
   *  is not followed by an effect nobody will ever restore. */
  recordArchiveEffect(decisionId: string, accountId: string, threadId: string): void {
    const now = validTimestamp(this.now());
    this.transaction((database) => {
      database
        .prepare(
          `INSERT OR IGNORE INTO decision_effects(decision_id, effect, account_id, target, added_at)
           SELECT decision_id, 'archived', ?, ?, ?
             FROM sender_decisions WHERE decision_id = ?`,
        )
        .run(validAccountId(accountId), validThreadId(threadId), now, decisionId);
    });
  }

  /**
   * Removes a decision. An accept takes its known entry with it. A block
   * with `restore` queues every thread it archived for the move back, in the
   * same transaction, so a restore interrupted halfway is finished by the
   * scheduler rather than forgotten.
   */
  removeDecision(
    decisionId: string,
    options: { readonly restore: boolean },
  ): RemovedDecision | null {
    const now = validTimestamp(this.now());
    return this.transaction((database) => {
      const row = database
        .prepare("SELECT decision FROM sender_decisions WHERE decision_id = ?")
        .get(decisionId);
      if (row === undefined) return null;
      const decision = decisionKind(row.decision);
      if (decision === null) throw new MailSenderError("mail_senders_unavailable");
      if (decision === "accept") {
        database
          .prepare(
            `DELETE FROM known_senders
              WHERE source = 'accept' AND address IN (
                SELECT target FROM decision_effects
                 WHERE decision_id = ? AND effect = 'known')`,
          )
          .run(decisionId);
      }
      const restoreRefs: MailSenderThreadRef[] = [];
      if (decision === "block" && options.restore) {
        const rows = database
          .prepare(
            `SELECT account_id, target FROM decision_effects
              WHERE decision_id = ? AND effect = 'archived'
              ORDER BY added_at ASC, account_id ASC, target ASC`,
          )
          .all(decisionId);
        const queue = database.prepare(
          `INSERT OR IGNORE INTO pending_restores(account_id, thread_id, queued_at)
           VALUES (?, ?, ?)`,
        );
        for (const effect of rows) {
          const ref = threadRef(effect.account_id, effect.target);
          queue.run(ref.accountId, ref.threadId, now);
          restoreRefs.push(ref);
        }
      }
      database.prepare("DELETE FROM sender_decisions WHERE decision_id = ?").run(decisionId);
      return Object.freeze({ decision, restoreRefs: Object.freeze(restoreRefs) });
    });
  }

  listPendingRestores(accountId: string, limit: number): readonly MailSenderThreadRef[] {
    return this.read((database) =>
      database
        .prepare(
          `SELECT account_id, thread_id FROM pending_restores
            WHERE account_id = ? ORDER BY queued_at ASC, thread_id ASC LIMIT ?`,
        )
        .all(validAccountId(accountId), limit)
        .map((row) => threadRef(row.account_id, row.thread_id)),
    );
  }

  hasPendingRestore(ref: MailSenderThreadRef): boolean {
    return this.read(
      (database) =>
        database
          .prepare(
            "SELECT 1 AS present FROM pending_restores WHERE account_id = ? AND thread_id = ?",
          )
          .get(ref.accountId, ref.threadId) !== undefined,
    );
  }

  /** Settles one queued restore: done, given up, or tried once more later. */
  settlePendingRestore(ref: MailSenderThreadRef, outcome: "done" | "failed"): void {
    this.transaction((database) => {
      if (outcome === "done") {
        database
          .prepare("DELETE FROM pending_restores WHERE account_id = ? AND thread_id = ?")
          .run(ref.accountId, ref.threadId);
        return;
      }
      database
        .prepare(
          `UPDATE pending_restores SET attempt_count = attempt_count + 1
            WHERE account_id = ? AND thread_id = ?`,
        )
        .run(ref.accountId, ref.threadId);
      database
        .prepare(
          `DELETE FROM pending_restores
            WHERE account_id = ? AND thread_id = ? AND attempt_count >= ?`,
        )
        .run(ref.accountId, ref.threadId, MAX_RESTORE_ATTEMPTS);
    });
  }

  listBlocked(limit: number): MailBlockedSenders["blocked"] {
    return this.read((database) =>
      Object.freeze(
        database
          .prepare(
            `SELECT decision.decision_id, decision.key, decision.kind, decision.decided_at,
                    (SELECT COUNT(*) FROM decision_effects AS effect
                      WHERE effect.decision_id = decision.decision_id
                        AND effect.effect = 'archived') AS archived_count
               FROM sender_decisions AS decision
              WHERE decision.decision = 'block'
              ORDER BY decision.decided_at DESC, decision.decision_id DESC
              LIMIT ?`,
          )
          .all(limit)
          .map((row) => {
            if (
              typeof row.decision_id !== "string" ||
              typeof row.key !== "string" ||
              (row.kind !== "address" && row.kind !== "domain") ||
              !Number.isSafeInteger(row.decided_at) ||
              !Number.isSafeInteger(row.archived_count)
            ) {
              throw new MailSenderError("mail_senders_unavailable");
            }
            return Object.freeze({
              decisionId: row.decision_id,
              key: row.key,
              scope: row.kind,
              decidedAt: row.decided_at as number,
              archivedCount: row.archived_count as number,
            });
          }),
      ),
    );
  }

  private read<T>(operation: (database: DatabaseSync) => T): T {
    try {
      return operation(this.requireDatabase());
    } catch (error) {
      throw storeError(error);
    }
  }

  private transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.requireDatabase();
    try {
      database.exec("BEGIN IMMEDIATE");
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw storeError(error);
    }
  }

  private requireDatabase(): DatabaseSync {
    if (!this.database) throw new MailSenderError("mail_senders_unavailable");
    return this.database;
  }
}

/** A cached thread's first message, as the cache holds it. */
export interface MailThreadFirstSender {
  /** The From address exactly as cached; the screen normalizes it. */
  readonly address: string | null;
  readonly firstMessageAt: number | null;
}

export interface MailInboxThreadSender {
  readonly threadId: string;
  readonly address: string | null;
}

export interface MailSenderBackfillBatch {
  /** Raw addresses, not yet normalized. */
  readonly addresses: readonly string[];
  readonly fromCursor: number;
  readonly sentCursor: number;
  readonly done: boolean;
}

/** What the screen needs from the accounts and their caches. */
export interface MailSenderMailPort {
  listAccountIds(): Promise<readonly string[]>;
  readAccountAddress(accountId: string): Promise<string | null>;
  readThreadFirstSenders(
    accountId: string,
    threadIds: readonly string[],
  ): Promise<ReadonlyMap<string, MailThreadFirstSender>>;
  readSenderBackfillBatch(
    accountId: string,
    input: {
      readonly fromCursor: number;
      readonly sentCursor: number;
      readonly enabledAt: number;
      readonly window: number;
    },
  ): Promise<MailSenderBackfillBatch>;
  listInboxThreadFirstSenders(accountId: string): Promise<readonly MailInboxThreadSender[]>;
  updateThread(
    input: MailThreadMutationInput & { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<MailThreadMutationResult>;
}

export interface MailSenderRequestContext {
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

/** The screen as the HTTP router sees it. */
export interface MailSenderScreenService {
  readState(): Promise<MailSenderScreenState>;
  setEnabled(enabled: boolean): Promise<MailSenderScreenState>;
  decide(
    input: MailSenderDecisionInput,
    context: MailSenderRequestContext,
  ): Promise<MailSenderDecisionResult>;
  undo(
    decisionId: string,
    options: { readonly restore: boolean },
    context: MailSenderRequestContext,
  ): Promise<MailSenderUndoResult>;
  listBlocked(): Promise<MailBlockedSenders>;
}

export class MailSenderScreen implements MailSenderScreenService {
  private readonly store: SqliteMailSenderStore;
  private readonly mail: MailSenderMailPort;
  private readonly now: () => number;
  private readonly onEvent: (value: unknown) => void;
  private readonly backfillWindow: number;
  private readonly archiveBackoff = new Map<string, number>();

  constructor(options: {
    readonly store: SqliteMailSenderStore;
    readonly mail: MailSenderMailPort;
    readonly now?: () => number;
    readonly onEvent?: (value: unknown) => void;
    readonly backfillWindow?: number;
  }) {
    this.store = options.store;
    this.mail = options.mail;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.backfillWindow = options.backfillWindow ?? DEFAULT_BACKFILL_WINDOW;
    if (
      !Number.isSafeInteger(this.backfillWindow) ||
      this.backfillWindow < 1 ||
      this.backfillWindow > 10_000
    ) {
      throw new MailSenderError("mail_senders_unavailable");
    }
  }

  async readState(): Promise<MailSenderScreenState> {
    const state = this.store.readState();
    const backfillComplete = state.enabled
      ? this.store.isBackfillComplete(await this.mail.listAccountIds())
      : false;
    return Object.freeze({
      apiVersion: 1,
      enabled: state.enabled,
      enabledAt: state.enabledAt,
      backfillComplete,
    });
  }

  async setEnabled(enabled: boolean): Promise<MailSenderScreenState> {
    this.store.setEnabled(enabled, this.now());
    return this.readState();
  }

  /**
   * Sets `newSender` on each item. A failure reading the screen answers false
   * for the page rather than failing it: mail stays readable when the screen
   * is not, and a thread that should have waited only arrives ungrouped.
   */
  async annotateItems(
    accountId: string,
    items: readonly MailThreadListItem[],
  ): Promise<readonly MailThreadListItem[]> {
    if (items.length === 0) return items;
    try {
      const enabledAt = await this.readGateMoment();
      if (enabledAt === null) return Object.freeze(items.map((item) => withNewSender(item, false)));
      const senders = await this.mail.readThreadFirstSenders(
        accountId,
        items.map((item) => item.threadId),
      );
      return Object.freeze(
        items.map((item) => {
          const first = senders.get(item.threadId) ?? null;
          const sender =
            first === null || first.address === null
              ? null
              : normalizeSenderAddress(first.address);
          const facts = sender === null ? null : this.store.readSenderFacts(sender);
          return withNewSender(
            item,
            isMailSenderGated({
              screenEnabled: true,
              backfillComplete: true,
              enabledAt,
              category: item.category,
              firstMessageAt: first?.firstMessageAt ?? null,
              sender,
              known: facts?.known ?? false,
              addressDecision: facts?.addressDecision ?? null,
              domainDecision: facts?.domainDecision ?? null,
            }),
          );
        }),
      );
    } catch {
      this.onEvent({
        event: "mail_sender_screen_failed",
        accountId,
        errorCode: "mail_senders_unavailable",
      });
      return Object.freeze(items.map((item) => withNewSender(item, false)));
    }
  }

  async decide(
    input: MailSenderDecisionInput,
    context: MailSenderRequestContext,
  ): Promise<MailSenderDecisionResult> {
    const address = normalizeSenderAddress(input.address);
    if (address === null) throw new MailSenderError("mail_request_invalid");
    const decisionId = `decision-a${randomBytes(16).toString("hex")}`;
    this.store.recordDecision({
      decisionId,
      key: input.scope === "domain" ? senderDomainOf(address) : address,
      kind: input.scope,
      decision: input.decision,
      knownAddress: input.decision === "accept" ? address : null,
    });
    if (input.decision === "accept") {
      return Object.freeze({
        apiVersion: 1,
        decisionId,
        archived: Object.freeze([]),
        pending: false,
      });
    }
    const targets: MailSenderThreadRef[] = [];
    let pending = false;
    const governing = this.store.readDecisionIndex();
    for (const accountId of await this.mail.listAccountIds()) {
      let threads: readonly MailInboxThreadSender[];
      try {
        threads = await this.mail.listInboxThreadFirstSenders(accountId);
      } catch {
        // The account's next sync finds what this one could not read.
        pending = true;
        continue;
      }
      for (const thread of threads) {
        if (governedBy(governing, thread.address)?.decisionId === decisionId) {
          targets.push(Object.freeze({ accountId, threadId: thread.threadId }));
        }
      }
    }
    const archived: MailSenderThreadRef[] = [];
    for (const target of targets) {
      if (
        archived.length >= MAIL_SENDER_BLOCK_REQUEST_LIMIT ||
        context.signal.aborted ||
        Date.now() >= context.deadlineAt - REQUEST_DEADLINE_MARGIN_MS
      ) {
        pending = true;
        break;
      }
      if (await this.archive(decisionId, target, context.signal)) {
        archived.push(target);
      } else {
        pending = true;
      }
    }
    this.logArchived("decision", archived);
    return Object.freeze({
      apiVersion: 1,
      decisionId,
      archived: Object.freeze(archived),
      pending,
    });
  }

  async undo(
    decisionId: string,
    options: { readonly restore: boolean },
    context: MailSenderRequestContext,
  ): Promise<MailSenderUndoResult> {
    if (!SAFE_DECISION_ID.test(decisionId)) {
      throw new MailSenderError("mail_request_invalid");
    }
    const removed = this.store.removeDecision(decisionId, { restore: options.restore });
    if (removed === null) throw new MailSenderError("mail_sender_decision_not_found");
    const restored: MailSenderThreadRef[] = [];
    let pending = false;
    for (const ref of removed.restoreRefs) {
      if (
        restored.length >= RESTORE_REQUEST_LIMIT ||
        context.signal.aborted ||
        Date.now() >= context.deadlineAt - REQUEST_DEADLINE_MARGIN_MS
      ) {
        pending = true;
        break;
      }
      if (await this.restore(ref, context.signal)) restored.push(ref);
      else if (this.store.hasPendingRestore(ref)) pending = true;
    }
    return Object.freeze({
      apiVersion: 1,
      restored: Object.freeze(restored),
      pending,
    });
  }

  async listBlocked(): Promise<MailBlockedSenders> {
    return Object.freeze({
      apiVersion: 1,
      blocked: this.store.listBlocked(MAX_BLOCKED_LIST),
    });
  }

  /** Recipients of a message that reached `sent` are people the owner wrote
   *  to, whichever transport carried it. */
  recordSentRecipients(recipients: {
    readonly to: readonly string[];
    readonly cc: readonly string[];
  }): void {
    this.store.learnKnown(
      [...recipients.to, ...recipients.cc].flatMap((raw) => {
        const address = normalizeSenderAddress(raw);
        return address === null ? [] : [address];
      }),
      "sent",
    );
  }

  /**
   * The scheduler's step for one account, beside its sync. Restores an undo
   * left behind and archives newly arrived letters from blocked senders, both
   * only after a sync that reached the provider, and advances the backfill by
   * one window of cache rows while the screen is on. Every part is bounded.
   */
  async runBackgroundSenderStep(
    accountId: string,
    input: { readonly syncSucceeded: boolean },
    signal: AbortSignal,
  ): Promise<{ readonly hasMore: boolean }> {
    let hasMore = false;
    if (input.syncSucceeded) {
      hasMore = (await this.restorePending(accountId, signal)) || hasMore;
    }
    signal.throwIfAborted();
    const state = this.store.readState();
    if (!state.enabled || state.enabledAt === null) {
      return Object.freeze({ hasMore });
    }
    hasMore = (await this.backfillStep(accountId, state.enabledAt)) || hasMore;
    signal.throwIfAborted();
    if (input.syncSucceeded) {
      hasMore = (await this.archiveBlocked(accountId, signal)) || hasMore;
    }
    return Object.freeze({ hasMore });
  }

  /** The switch's moment when gating is live everywhere, otherwise null. */
  private async readGateMoment(): Promise<number | null> {
    const state = this.store.readState();
    if (!state.enabled || state.enabledAt === null) return null;
    if (!this.store.isBackfillComplete(await this.mail.listAccountIds())) return null;
    return state.enabledAt;
  }

  private async backfillStep(accountId: string, enabledAt: number): Promise<boolean> {
    const progress = this.store.readBackfillProgress(accountId);
    if (progress?.complete) return false;
    const learned: string[] = [];
    if (progress === null) {
      // The owner's own address is known from the first step, so a thread
      // the owner started is never waiting on the owner.
      const own = await this.mail.readAccountAddress(accountId);
      const address = own === null ? null : normalizeSenderAddress(own);
      if (address !== null) learned.push(address);
    }
    const batch = await this.mail.readSenderBackfillBatch(accountId, {
      fromCursor: progress?.fromCursor ?? 0,
      sentCursor: progress?.sentCursor ?? 0,
      enabledAt,
      window: this.backfillWindow,
    });
    for (const raw of batch.addresses) {
      const address = normalizeSenderAddress(raw);
      if (address !== null) learned.push(address);
    }
    this.store.recordBackfillStep(accountId, {
      enabledAt,
      addresses: learned,
      fromCursor: batch.fromCursor,
      sentCursor: batch.sentCursor,
      complete: batch.done,
    });
    return !batch.done;
  }

  private async archiveBlocked(accountId: string, signal: AbortSignal): Promise<boolean> {
    if (!this.store.hasBlockDecisions()) return false;
    const now = Date.now();
    for (const [key, retryAt] of this.archiveBackoff) {
      if (retryAt <= now) this.archiveBackoff.delete(key);
    }
    const targets: Array<{ readonly ref: MailSenderThreadRef; readonly decisionId: string }> = [];
    const index = this.store.readDecisionIndex();
    for (const thread of await this.mail.listInboxThreadFirstSenders(accountId)) {
      const governing = governedBy(index, thread.address);
      if (
        governing?.decision === "block" &&
        !this.archiveBackoff.has(`${accountId}/${thread.threadId}`)
      ) {
        targets.push({
          ref: Object.freeze({ accountId, threadId: thread.threadId }),
          decisionId: governing.decisionId,
        });
      }
    }
    const archived: MailSenderThreadRef[] = [];
    let attempted = 0;
    for (const target of targets) {
      if (attempted >= BACKGROUND_MUTATIONS_PER_STEP) break;
      signal.throwIfAborted();
      attempted += 1;
      if (await this.archive(target.decisionId, target.ref, signal)) {
        archived.push(target.ref);
      } else {
        this.archiveBackoff.set(
          `${accountId}/${target.ref.threadId}`,
          Date.now() + ARCHIVE_FAILURE_BACKOFF_MS,
        );
      }
    }
    this.logArchived("sync", archived);
    return targets.length > attempted;
  }

  private async restorePending(accountId: string, signal: AbortSignal): Promise<boolean> {
    const pending = this.store.listPendingRestores(accountId, BACKGROUND_MUTATIONS_PER_STEP + 1);
    for (const ref of pending.slice(0, BACKGROUND_MUTATIONS_PER_STEP)) {
      signal.throwIfAborted();
      await this.restore(ref, signal);
    }
    return pending.length > BACKGROUND_MUTATIONS_PER_STEP;
  }

  private async archive(
    decisionId: string,
    ref: MailSenderThreadRef,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.mail.updateThread(
        { accountId: ref.accountId, threadId: ref.threadId, archive: true },
        signal,
      );
    } catch {
      return false;
    }
    this.store.recordArchiveEffect(decisionId, ref.accountId, ref.threadId);
    return true;
  }

  private async restore(ref: MailSenderThreadRef, signal: AbortSignal): Promise<boolean> {
    try {
      await this.mail.updateThread(
        { accountId: ref.accountId, threadId: ref.threadId, archive: false },
        signal,
      );
    } catch (error) {
      if (signal.aborted) return false;
      if (isPermanentMutationFailure(error)) {
        this.store.settlePendingRestore(ref, "done");
      } else {
        this.store.settlePendingRestore(ref, "failed");
      }
      return false;
    }
    this.store.settlePendingRestore(ref, "done");
    return true;
  }

  /** Counts per account and nothing else: no address, no thread id. */
  private logArchived(phase: "decision" | "sync", archived: readonly MailSenderThreadRef[]): void {
    const counts = new Map<string, number>();
    for (const ref of archived) counts.set(ref.accountId, (counts.get(ref.accountId) ?? 0) + 1);
    for (const [accountId, threadCount] of counts) {
      this.onEvent({ event: "mail_sender_blocked_archived", phase, accountId, threadCount });
    }
  }
}

/**
 * The message service the router serves, with every thread item it answers
 * carrying `newSender`. Sync and everything else pass straight through.
 */
export class MailSenderScreenedMessageService implements MailMessageService {
  private readonly inner: MailMessageService & {
    readBackgroundSyncHealth(): Promise<MailBackgroundSyncHealth>;
  };
  private readonly screen: Pick<MailSenderScreen, "annotateItems">;

  constructor(
    inner: MailMessageService & {
      readBackgroundSyncHealth(): Promise<MailBackgroundSyncHealth>;
    },
    screen: Pick<MailSenderScreen, "annotateItems">,
  ) {
    this.inner = inner;
    this.screen = screen;
  }

  readBackgroundSyncHealth(): Promise<MailBackgroundSyncHealth> {
    return this.inner.readBackgroundSyncHealth();
  }

  async listThreads(input: {
    readonly accountId: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): Promise<MailThreadPage> {
    const page = await this.inner.listThreads(input);
    return Object.freeze({
      ...page,
      items: await this.screen.annotateItems(input.accountId, page.items),
    });
  }

  async listMailboxThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly cursor?: string;
    readonly limit: number;
    readonly view?: MailThreadView | null;
    readonly sort?: MailThreadSort;
  }): Promise<MailMailboxThreadPage> {
    const page = await this.inner.listMailboxThreads(input);
    return Object.freeze({
      ...page,
      items: await this.screen.annotateItems(input.accountId, page.items),
    });
  }

  async searchThreads(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly query: string;
    readonly cursor?: string | null;
    readonly limit: number;
  }): Promise<MailSearchThreadPage> {
    const page = await this.inner.searchThreads(input);
    return Object.freeze({
      ...page,
      items: await this.screen.annotateItems(input.accountId, page.items),
    });
  }

  async getThread(input: {
    readonly accountId: string;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null> {
    return this.annotateDetail(input.accountId, await this.inner.getThread(input));
  }

  async getMailboxThread(input: {
    readonly accountId: string;
    readonly mailboxId: MailSystemMailbox;
    readonly threadId: string;
  }): Promise<MailThreadDetail | null> {
    return this.annotateDetail(input.accountId, await this.inner.getMailboxThread(input));
  }

  sync(
    input: { readonly accountId: string; readonly maxItems: number },
    signal: AbortSignal,
  ): Promise<MailSyncResult> {
    return this.inner.sync(input, signal);
  }

  syncAccount(
    accountId: string,
    options: { readonly maxItems: number },
    signal?: AbortSignal,
  ): Promise<MailSyncResult> {
    return this.inner.syncAccount(accountId, options, signal);
  }

  async updateThread(
    input: MailThreadMutationInput & { readonly threadId: string },
    signal: AbortSignal,
  ): Promise<MailThreadMutationResult> {
    const result = await this.inner.updateThread(input, signal);
    const [thread] = await this.screen.annotateItems(input.accountId, [result.thread]);
    return Object.freeze({ ...result, thread: thread! });
  }

  private async annotateDetail(
    accountId: string,
    detail: MailThreadDetail | null,
  ): Promise<MailThreadDetail | null> {
    if (detail === null) return null;
    const [thread] = await this.screen.annotateItems(accountId, [detail.thread]);
    return Object.freeze({ ...detail, thread: thread! });
  }
}

function governedBy(
  index: (address: string) => MailSenderGoverningDecision | null,
  raw: string | null,
): MailSenderGoverningDecision | null {
  if (raw === null) return null;
  const address = normalizeSenderAddress(raw);
  return address === null ? null : index(address);
}

function withNewSender(item: MailThreadListItem, newSender: boolean): MailThreadListItem {
  return item.newSender === newSender ? item : Object.freeze({ ...item, newSender });
}

function isPermanentMutationFailure(error: unknown): boolean {
  return (
    (error instanceof MailProviderSyncError &&
      (error.code === "mail_provider_thread_stale" ||
        error.code === "mail_provider_mutation_unsupported")) ||
    (error instanceof MailAccountError && error.code === "account_not_found")
  );
}

function initializeSchema(database: DatabaseSync, now: number): void {
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  if (version === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(SCHEMA_SQL);
      // Switched on by default: the owner asked for the screen, and a first
      // run is the moment "known" is computed from the mail already cached.
      database
        .prepare("INSERT INTO screen_state(singleton, enabled, enabled_at) VALUES (1, 1, ?)")
        .run(now);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
    return;
  }
  if (version !== SCHEMA_VERSION) throw new MailSenderError("mail_senders_unavailable");
  readScreenState(database);
}

function readScreenState(database: DatabaseSync): {
  readonly enabled: boolean;
  readonly enabledAt: number | null;
} {
  const row = database
    .prepare("SELECT enabled, enabled_at FROM screen_state WHERE singleton = 1")
    .get();
  if (
    row === undefined ||
    (row.enabled !== 0 && row.enabled !== 1) ||
    (row.enabled_at !== null && !Number.isSafeInteger(row.enabled_at))
  ) {
    throw new MailSenderError("mail_senders_unavailable");
  }
  return Object.freeze({
    enabled: row.enabled === 1,
    enabledAt: row.enabled_at as number | null,
  });
}

function learnKnownIn(
  database: DatabaseSync,
  addresses: readonly string[],
  source: "backfill" | "sent",
  now: number,
): void {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO known_senders(address, source, added_at) VALUES (?, ?, ?)",
  );
  for (const address of new Set(addresses)) {
    if (address.length >= 3 && address.length <= MAX_ADDRESS_LENGTH) {
      insert.run(address, source, now);
    }
  }
}

function decisionKind(value: unknown): MailSenderDecisionKind | null {
  return value === "accept" || value === "block" ? value : null;
}

function threadRef(accountId: unknown, threadId: unknown): MailSenderThreadRef {
  if (
    typeof accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(accountId) ||
    typeof threadId !== "string" ||
    !SAFE_PROVIDER_ID.test(threadId)
  ) {
    throw new MailSenderError("mail_senders_unavailable");
  }
  return Object.freeze({ accountId, threadId });
}

function validAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) throw new MailSenderError("mail_senders_unavailable");
  return value;
}

function validThreadId(value: string): string {
  if (!SAFE_PROVIDER_ID.test(value)) throw new MailSenderError("mail_senders_unavailable");
  return value;
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailSenderError("mail_senders_unavailable");
  }
  return value;
}

function validCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailSenderError("mail_senders_unavailable");
  }
  return value;
}

function storeError(error: unknown): MailSenderError {
  return error instanceof MailSenderError
    ? error
    : new MailSenderError("mail_senders_unavailable");
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    (uid >= 0 && metadata.uid !== uid)
  ) {
    throw new MailSenderError("mail_senders_unavailable");
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
    throw new MailSenderError("mail_senders_unavailable");
  }
}

async function ensureSqliteFilesPrivate(databasePath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const handle = await open(
        `${databasePath}${suffix}`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
