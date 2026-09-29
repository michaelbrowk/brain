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
  The new-senders screen: who is known, who is the owner, what the owner
  decided about whom, and the one flag every thread item carries because of
  the three.

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
/** One scheduler step touches the provider at most this many times, for the
 *  restores an undo left behind and for the archiver, each. */
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

/**
 * Domains where "Everyone at <domain>" would speak for millions of unrelated
 * people. A decision there takes the address scope only; the state route
 * hands this list to the UI so it never offers the other. A provider missing
 * here can still be decided whole, and one block of it would archive mail
 * from every stranger who uses it, so a regional provider belongs here as
 * soon as someone meets one.
 */
export const MAIL_SENDER_DOMAIN_SCOPE_REFUSED: ReadonlySet<string> = new Set([
  "126.com",
  "163.com",
  "aol.com",
  "bk.ru",
  "comcast.net",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "hotmail.de",
  "hotmail.es",
  "hotmail.fr",
  "hotmail.it",
  "icloud.com",
  "inbox.ru",
  "libero.it",
  "list.ru",
  "live.co.uk",
  "live.com",
  "live.fr",
  "mac.com",
  "mail.com",
  "mail.ru",
  "me.com",
  "msn.com",
  "naver.com",
  "orange.fr",
  "outlook.com",
  "outlook.de",
  "outlook.fr",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "rambler.ru",
  "rocketmail.com",
  "seznam.cz",
  "t-online.de",
  "tutanota.com",
  "web.de",
  "wp.pl",
  "yahoo.co.jp",
  "yahoo.co.uk",
  "yahoo.com",
  "yahoo.de",
  "yahoo.fr",
  "ymail.com",
  "zoho.com",
]);

export type MailSenderErrorCode =
  | "mail_request_invalid"
  | "mail_sender_own_address"
  | "mail_sender_domain_scope_refused"
  | "mail_sender_decision_not_found"
  | "mail_sender_decision_changed"
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
 * brackets and RFC 5322 comments are dropped; a plus tag and Gmail's dots are
 * kept, because they are part of the address the person gave out. Null when
 * what is left is not an address, so a malformed From is never known, never
 * decided and never gated.
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
  /**
   * When this account starts gating: the later of the moment the switch was
   * turned on and the moment this account's backfill finished. Null while the
   * switch is off or the backfill has not finished.
   */
  readonly gateMoment: number | null;
  readonly category: MailThreadCategory;
  readonly inInbox: boolean;
  readonly firstMessageAt: number | null;
  /** The first message carries neither In-Reply-To nor References. */
  readonly startsConversation: boolean;
  /**
   * The first message answers something, but what it answers is the same
   * sender's own letter, or the sender already has a letter waiting: a
   * stranger's follow-up in a cold sequence, which waits like the first.
   */
  readonly followsStranger: boolean;
  /** The normalized address of the thread's first message's From. */
  readonly sender: string | null;
  /** The first message is the owner's: an account address, an alias the
   *  owner sends from, or a message the provider marks as sent. */
  readonly own: boolean;
  readonly known: boolean;
  readonly addressDecision: MailSenderDecisionKind | null;
  readonly domainDecision: MailSenderDecisionKind | null;
}

/**
 * Whether a thread waits for the owner's first decision. Every clause is a
 * way for it not to: the switch and the backfill, the category, the Inbox,
 * the moment, a letter that answers someone other than its own sender, and
 * anything the screen knows about the sender.
 */
export function isMailSenderGated(input: MailSenderGateInput): boolean {
  return (
    input.gateMoment !== null &&
    input.category === "people" &&
    input.inInbox &&
    input.firstMessageAt !== null &&
    input.firstMessageAt > input.gateMoment &&
    (input.startsConversation || input.followsStranger) &&
    input.sender !== null &&
    !input.own &&
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

  CREATE TABLE own_senders (
    address TEXT PRIMARY KEY CHECK(length(address) BETWEEN 3 AND 254),
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
      REFERENCES sender_decisions(decision_id) ON DELETE CASCADE ON UPDATE CASCADE,
    effect TEXT NOT NULL CHECK(effect IN ('known', 'archived')),
    account_id TEXT NOT NULL,
    target TEXT NOT NULL CHECK(length(target) BETWEEN 1 AND 255),
    state TEXT NOT NULL CHECK(state IN ('pending', 'done')),
    thread_last_at INTEGER CHECK(thread_last_at IS NULL OR thread_last_at >= 0),
    message_key TEXT CHECK(message_key IS NULL OR length(message_key) BETWEEN 3 AND 998),
    added_at INTEGER NOT NULL CHECK(added_at >= 0),
    PRIMARY KEY(decision_id, effect, account_id, target),
    CHECK((effect = 'known') = (account_id = '')),
    CHECK(effect = 'archived' OR (state = 'done' AND thread_last_at IS NULL))
  ) STRICT;

  CREATE INDEX decision_effects_by_thread
    ON decision_effects(account_id, effect, target);

  CREATE TABLE replaced_decisions (
    old_id TEXT PRIMARY KEY CHECK(length(old_id) = 42),
    new_id TEXT NOT NULL CHECK(length(new_id) = 42),
    replaced_at INTEGER NOT NULL CHECK(replaced_at >= 0)
  ) STRICT;

  CREATE TABLE backfill_progress (
    account_id TEXT PRIMARY KEY,
    from_cursor INTEGER NOT NULL CHECK(from_cursor >= 0),
    sent_cursor INTEGER NOT NULL CHECK(sent_cursor >= 0),
    completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0)
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

export interface MailSenderStandingDecision {
  readonly decisionId: string;
  readonly decision: MailSenderDecisionKind;
}

/** Every decision, read once, keyed by what it speaks for. */
export interface MailSenderDecisionIndex {
  readonly addresses: ReadonlyMap<string, MailSenderStandingDecision>;
  readonly domains: ReadonlyMap<string, MailSenderStandingDecision>;
}

export interface MailSenderArchiveEffect {
  readonly state: "pending" | "done";
  readonly threadLastAt: number | null;
  /** The Message-ID of the thread's first message when it was archived. An
   *  IMAP message moved back to the Inbox comes back under a new UID and so a
   *  new thread id; this is how the screen still recognises it. */
  readonly messageKey: string | null;
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
   * forgets the moment; the known list, the owner's aliases and the decisions
   * stay.
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
        "SELECT completed_at FROM backfill_progress WHERE account_id = ?",
      );
      return accountIds.every(
        (accountId) => Number.isSafeInteger(statement.get(accountId)?.completed_at),
      );
    });
  }

  readBackfillProgress(accountId: string): {
    readonly fromCursor: number;
    readonly sentCursor: number;
    readonly completedAt: number | null;
  } | null {
    return this.read((database) => {
      const row = database
        .prepare(
          `SELECT from_cursor, sent_cursor, completed_at
             FROM backfill_progress WHERE account_id = ?`,
        )
        .get(validAccountId(accountId));
      if (row === undefined) return null;
      if (
        !Number.isSafeInteger(row.from_cursor) ||
        !Number.isSafeInteger(row.sent_cursor) ||
        (row.completed_at !== null && !Number.isSafeInteger(row.completed_at))
      ) {
        throw new MailSenderError("mail_senders_unavailable");
      }
      return Object.freeze({
        fromCursor: row.from_cursor as number,
        sentCursor: row.sent_cursor as number,
        completedAt: row.completed_at as number | null,
      });
    });
  }

  /**
   * One backfill step, written only if the screen is still on at the moment
   * the step read from. A switch flipped while the step was reading the cache
   * restarts the backfill, and the stale step must not move its cursors. The
   * first step that finds the account complete stamps when it finished, and
   * that stamp is when the account starts gating.
   */
  recordBackfillStep(
    accountId: string,
    input: {
      readonly enabledAt: number;
      readonly known: readonly string[];
      readonly own: readonly string[];
      readonly fromCursor: number;
      readonly sentCursor: number;
      readonly complete: boolean;
    },
  ): void {
    const id = validAccountId(accountId);
    const now = validTimestamp(this.now());
    this.transaction((database) => {
      if (readScreenState(database).enabledAt !== input.enabledAt) return;
      learnKnownIn(database, input.known, "backfill", now);
      learnOwnIn(database, input.own, now);
      database
        .prepare(
          `INSERT INTO backfill_progress(account_id, from_cursor, sent_cursor, completed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id) DO UPDATE
             SET from_cursor = excluded.from_cursor,
                 sent_cursor = excluded.sent_cursor,
                 completed_at = COALESCE(backfill_progress.completed_at, excluded.completed_at)`,
        )
        .run(
          id,
          validCursor(input.fromCursor),
          validCursor(input.sentCursor),
          input.complete ? now : null,
        );
    });
  }

  learnKnown(addresses: readonly string[], source: "backfill" | "sent"): void {
    const now = validTimestamp(this.now());
    this.transaction((database) => learnKnownIn(database, addresses, source, now));
  }

  isKnown(address: string): boolean {
    return this.read(
      (database) =>
        database.prepare("SELECT 1 AS present FROM known_senders WHERE address = ?").get(
          address,
        ) !== undefined,
    );
  }

  /** The addresses the owner has been seen sending from, beyond the account
   *  addresses themselves. */
  listOwnAliases(): readonly string[] {
    return this.read((database) =>
      Object.freeze(
        database
          .prepare("SELECT address FROM own_senders ORDER BY address")
          .all()
          .map((row) => {
            if (typeof row.address !== "string") {
              throw new MailSenderError("mail_senders_unavailable");
            }
            return row.address;
          }),
      ),
    );
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

  /** Every decision in one read. A block walks thousands of Inbox threads,
   *  and one read beats a query for each of them. */
  readDecisionIndex(): MailSenderDecisionIndex {
    return this.read((database) => {
      const addresses = new Map<string, MailSenderStandingDecision>();
      const domains = new Map<string, MailSenderStandingDecision>();
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
      return Object.freeze({ addresses, domains });
    });
  }

  /**
   * The block that archives mail from an address right now, read in one
   * transaction: the address's own decision if it has one, otherwise its
   * domain's block unless the address is known. A known address is archived
   * only by a block of the address itself.
   */
  readBlockingDecision(address: string): MailSenderStandingDecision | null {
    return this.read((database) => {
      const statement = database.prepare(
        "SELECT decision_id, decision FROM sender_decisions WHERE kind = ? AND key = ?",
      );
      const own = standingDecision(statement.get("address", address));
      if (own !== null) return own.decision === "block" ? own : null;
      const domain = standingDecision(statement.get("domain", senderDomainOf(address)));
      if (domain?.decision !== "block") return null;
      const known =
        database.prepare("SELECT 1 AS present FROM known_senders WHERE address = ?").get(
          address,
        ) !== undefined;
      return known ? null : domain;
    });
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
   * One decision per address or domain. The same verdict again answers the
   * decision that stands; a changed verdict replaces it under a new id and
   * the key's effects follow it, so nothing an earlier verdict archived is
   * left without a decision that can undo it. An accept also makes the
   * address known and remembers that it did.
   */
  recordDecision(input: {
    readonly decisionId: string;
    readonly key: string;
    readonly kind: MailSenderDecisionScope;
    readonly decision: MailSenderDecisionKind;
    readonly knownAddress: string | null;
  }): { readonly decisionId: string; readonly created: boolean } {
    const now = validTimestamp(this.now());
    return this.transaction((database) => {
      const existing = database
        .prepare("SELECT decision_id, decision FROM sender_decisions WHERE kind = ? AND key = ?")
        .get(input.kind, input.key);
      if (existing !== undefined && typeof existing.decision_id !== "string") {
        throw new MailSenderError("mail_senders_unavailable");
      }
      if (existing?.decision === input.decision) {
        return Object.freeze({ decisionId: existing.decision_id as string, created: false });
      }
      if (existing === undefined) {
        database
          .prepare(
            `INSERT INTO sender_decisions(decision_id, key, kind, decision, decided_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.decisionId, input.key, input.kind, input.decision, now);
      } else {
        // The effects carry forward through the foreign key's ON UPDATE, and
        // the old id is remembered so the toast that holds it can be told the
        // verdict changed rather than that nothing is there.
        database
          .prepare(
            `UPDATE sender_decisions
                SET decision_id = ?, decision = ?, decided_at = ?
              WHERE decision_id = ?`,
          )
          .run(input.decisionId, input.decision, now, existing.decision_id as string);
        database
          .prepare(
            `INSERT OR REPLACE INTO replaced_decisions(old_id, new_id, replaced_at)
             VALUES (?, ?, ?)`,
          )
          .run(existing.decision_id as string, input.decisionId, now);
      }
      if (input.knownAddress !== null) {
        const added = database
          .prepare(
            `INSERT OR IGNORE INTO known_senders(address, source, added_at)
             VALUES (?, 'accept', ?)`,
          )
          .run(input.knownAddress, now);
        if (added.changes === 1) {
          database
            .prepare(
              `INSERT OR IGNORE INTO decision_effects(
                 decision_id, effect, account_id, target, state, thread_last_at, added_at
               ) VALUES (?, 'known', '', ?, 'done', NULL, ?)`,
            )
            .run(input.decisionId, input.knownAddress, now);
        }
      }
      return Object.freeze({ decisionId: input.decisionId, created: true });
    });
  }

  /**
   * Writes the intent before the provider is asked: a `pending` archive
   * effect under the decision, only while the decision stands. Should the
   * process stop between the provider's archive and `finishArchiveEffect`,
   * the pending row is what lets an undo still find the thread.
   */
  beginArchiveEffect(
    decisionId: string,
    ref: MailSenderThreadRef,
    threadLastAt: number | null,
    messageKey: string | null,
  ): boolean {
    const now = validTimestamp(this.now());
    return this.transaction(
      (database) =>
        database
          .prepare(
            `INSERT INTO decision_effects(
               decision_id, effect, account_id, target, state, thread_last_at,
               message_key, added_at
             )
             SELECT decision_id, 'archived', ?, ?, 'pending', ?, ?, ?
               FROM sender_decisions WHERE decision_id = ?
             ON CONFLICT(decision_id, effect, account_id, target) DO UPDATE
               SET state = 'pending', thread_last_at = excluded.thread_last_at,
                   message_key = excluded.message_key`,
          )
          .run(
            validAccountId(ref.accountId),
            validThreadId(ref.threadId),
            threadLastAt === null ? null : validTimestamp(threadLastAt),
            validMessageKey(messageKey),
            now,
            decisionId,
          ).changes === 1,
    );
  }

  /** The provider refused the archive outright, so there is nothing an undo
   *  should move back. */
  dropArchiveEffect(decisionId: string, ref: MailSenderThreadRef): void {
    this.transaction((database) => {
      database
        .prepare(
          `DELETE FROM decision_effects
            WHERE decision_id = ? AND effect = 'archived' AND account_id = ? AND target = ?
              AND state = 'pending'`,
        )
        .run(decisionId, ref.accountId, ref.threadId);
    });
  }

  finishArchiveEffect(decisionId: string, ref: MailSenderThreadRef): boolean {
    return this.transaction(
      (database) =>
        database
          .prepare(
            `UPDATE decision_effects SET state = 'done'
              WHERE decision_id = ? AND effect = 'archived'
                AND account_id = ? AND target = ?`,
          )
          .run(decisionId, ref.accountId, ref.threadId).changes === 1,
    );
  }

  /** Every archive effect in one account, keyed by decision and thread. */
  readArchiveEffects(accountId: string): ReadonlyMap<string, MailSenderArchiveEffect> {
    return this.read((database) => {
      const effects = new Map<string, MailSenderArchiveEffect>();
      for (const row of database
        .prepare(
          `SELECT decision_id, target, state, thread_last_at, message_key FROM decision_effects
            WHERE account_id = ? AND effect = 'archived'`,
        )
        .all(validAccountId(accountId))) {
        if (
          typeof row.decision_id !== "string" ||
          typeof row.target !== "string" ||
          (row.state !== "pending" && row.state !== "done") ||
          (row.thread_last_at !== null && !Number.isSafeInteger(row.thread_last_at)) ||
          (row.message_key !== null && typeof row.message_key !== "string")
        ) {
          throw new MailSenderError("mail_senders_unavailable");
        }
        const effect = Object.freeze({
          state: row.state,
          threadLastAt: row.thread_last_at as number | null,
          messageKey: row.message_key as string | null,
        });
        effects.set(archiveEffectKey(row.decision_id, row.target), effect);
        if (effect.messageKey !== null) {
          const byMessage = archiveMessageKey(row.decision_id, effect.messageKey);
          // A finished archive speaks for the message over a pending one.
          if (effects.get(byMessage)?.state !== "done") effects.set(byMessage, effect);
        }
      }
      return effects;
    });
  }

  /**
   * The archive this decision recorded for a thread, found by its thread id
   * or by its first message's Message-ID, a finished one before a pending
   * one. Null when there is none.
   */
  readArchiveEffect(
    decisionId: string,
    ref: MailSenderThreadRef,
    messageKey: string | null,
  ): MailSenderArchiveEffect | null {
    return this.read((database) => {
      const rows = database
        .prepare(
          `SELECT state, thread_last_at, message_key FROM decision_effects
            WHERE decision_id = ? AND effect = 'archived' AND account_id = ?
              AND (target = ? OR (? IS NOT NULL AND message_key = ?))
            ORDER BY state = 'done' DESC`,
        )
        .all(decisionId, validAccountId(ref.accountId), ref.threadId, messageKey, messageKey);
      const row = rows[0];
      if (row === undefined) return null;
      if (
        (row.state !== "pending" && row.state !== "done") ||
        (row.thread_last_at !== null && !Number.isSafeInteger(row.thread_last_at)) ||
        (row.message_key !== null && typeof row.message_key !== "string")
      ) {
        throw new MailSenderError("mail_senders_unavailable");
      }
      return Object.freeze({
        state: row.state,
        threadLastAt: row.thread_last_at as number | null,
        messageKey: row.message_key as string | null,
      });
    });
  }

  decisionExists(decisionId: string): boolean {
    return this.read(
      (database) =>
        database
          .prepare("SELECT 1 AS present FROM sender_decisions WHERE decision_id = ?")
          .get(decisionId) !== undefined,
    );
  }

  /**
   * Removes a decision. The known entry an accept added goes with it; an id
   * a changed verdict replaced answers `mail_sender_decision_changed`. With
   * `restore`, every thread archived under it, finished or still pending, is
   * queued for the move back in the same transaction, so a restore cut short
   * is finished by the scheduler rather than forgotten.
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
      if (row === undefined) {
        const replaced = database
          .prepare("SELECT 1 AS present FROM replaced_decisions WHERE old_id = ?")
          .get(decisionId);
        if (replaced !== undefined) {
          throw new MailSenderError("mail_sender_decision_changed");
        }
        return null;
      }
      const decision = decisionKind(row.decision);
      if (decision === null) throw new MailSenderError("mail_senders_unavailable");
      // Only an accept takes its known entry back. A block that replaced an
      // accept carries that entry too, and undoing the block returns to the
      // accept's world, where the address was known.
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
      if (options.restore) {
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

  /**
   * Settles one queued restore. `done` and `given_up` remove it; `failed`
   * counts a try and removes it once it has failed too often. The answer
   * says whether it is still queued.
   */
  settlePendingRestore(
    ref: MailSenderThreadRef,
    outcome: "done" | "given_up" | "failed",
  ): "kept" | "removed" {
    return this.transaction((database) => {
      if (outcome !== "failed") {
        database
          .prepare("DELETE FROM pending_restores WHERE account_id = ? AND thread_id = ?")
          .run(ref.accountId, ref.threadId);
        return "removed";
      }
      database
        .prepare(
          `UPDATE pending_restores SET attempt_count = attempt_count + 1
            WHERE account_id = ? AND thread_id = ?`,
        )
        .run(ref.accountId, ref.threadId);
      const dropped = database
        .prepare(
          `DELETE FROM pending_restores
            WHERE account_id = ? AND thread_id = ? AND attempt_count >= ?`,
        )
        .run(ref.accountId, ref.threadId, MAX_RESTORE_ATTEMPTS);
      return dropped.changes === 1 ? "removed" : "kept";
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
                        AND effect.effect = 'archived'
                        AND effect.state = 'done') AS archived_count
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
  /** The first message carries neither In-Reply-To nor References. */
  readonly startsConversation: boolean;
  /** The provider marks the first message as sent by the account. */
  readonly fromOwner: boolean;
  readonly inInbox: boolean;
  /** The Message-IDs the first message names as its parents, as cached. */
  readonly references: readonly string[];
}

export interface MailInboxThreadSender {
  readonly threadId: string;
  readonly address: string | null;
  readonly fromOwner: boolean;
  readonly lastMessageAt: number | null;
  /** The first message's Message-ID, when it has one. */
  readonly firstMessageId: string | null;
}

export interface MailSenderBackfillBatch {
  /** Raw addresses to make known, not yet normalized. */
  readonly known: readonly string[];
  /** Raw addresses the owner sent from. */
  readonly own: readonly string[];
  readonly fromCursor: number;
  readonly sentCursor: number;
  /** Every row the step was asked to read has been read. */
  readonly done: boolean;
  /** The account's initial sync has finished, so its cache holds its history. */
  readonly cacheReady: boolean;
}

export interface MailSenderAccount {
  readonly accountId: string;
  readonly address: string;
  readonly connected: boolean;
  readonly providerKind: "gmail" | "imap";
}

/** What the screen needs from the accounts and their caches. */
export interface MailSenderMailPort {
  listAccounts(): Promise<readonly MailSenderAccount[]>;
  readThreadFirstSenders(
    accountId: string,
    threadIds: readonly string[],
  ): Promise<ReadonlyMap<string, MailThreadFirstSender>>;
  /** The From of every cached message with one of these Message-IDs. */
  readReferencedSenders(
    accountId: string,
    messageIds: readonly string[],
  ): Promise<readonly string[]>;
  /** Whether an Inbox people thread whose first message starts a conversation
   *  came from this address after this moment. */
  hasConversationStart(
    accountId: string,
    input: { readonly address: string; readonly after: number },
  ): Promise<boolean>;
  readSenderBackfillBatch(
    accountId: string,
    input: {
      readonly fromCursor: number;
      readonly sentCursor: number;
      readonly window: number;
      readonly learnFrom: boolean;
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

interface OwnSenders {
  readonly connectedAccountIds: readonly string[];
  /** Gmail accounts, where only the provider's sent mark proves a letter is
   *  the owner's: a From claiming an own address is common spam there. */
  readonly gmailAccountIds: ReadonlySet<string>;
  readonly addresses: ReadonlySet<string>;
  readonly domains: ReadonlySet<string>;
}

interface ArchiveTarget {
  readonly ref: MailSenderThreadRef;
  readonly thread: MailInboxThreadSender;
}

interface QueuedWork {
  readonly signal: AbortSignal;
  /** Set for work inside a request: nothing starts this close to its end. */
  readonly deadlineAt?: number;
}

type ArchiveOutcome = "archived" | "skipped" | "failed" | "deferred" | "gone";
type RestoreOutcome = "restored" | "kept" | "dropped";

export class MailSenderScreen implements MailSenderScreenService {
  private readonly store: SqliteMailSenderStore;
  private readonly mail: MailSenderMailPort;
  private readonly now: () => number;
  private readonly onEvent: (value: unknown) => void;
  private readonly backfillWindow: number;
  private readonly archiveBackoff = new Map<string, number>();
  /**
   * One queue for every change a decision makes: recording or removing it,
   * and each single archive or restore. Everything a queued archive depends
   * on is read again once its turn comes, so an undo that lands between two
   * archives stops the rest and one that lands during an archive waits for
   * it and then moves it back. Work whose caller gave up while it waited is
   * dropped without writing anything.
   */
  private tail: Promise<void> = Promise.resolve();

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
    const own = await this.readOwn();
    const backfillComplete = state.enabled
      ? this.store.isBackfillComplete(own.connectedAccountIds)
      : false;
    return Object.freeze({
      apiVersion: 1,
      enabled: state.enabled,
      enabledAt: state.enabledAt,
      backfillComplete,
      domainScopeRefused: Object.freeze(
        [...new Set([...MAIL_SENDER_DOMAIN_SCOPE_REFUSED, ...own.domains])].sort(),
      ),
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
      const gateMoment = this.readGateMoment(accountId);
      if (gateMoment === null) {
        return Object.freeze(items.map((item) => withNewSender(item, false)));
      }
      const own = await this.readOwn();
      const trustsOwnAddress = !own.gmailAccountIds.has(accountId);
      const senders = await this.mail.readThreadFirstSenders(
        accountId,
        items.map((item) => item.threadId),
      );
      const annotated: MailThreadListItem[] = [];
      for (const item of items) {
        const first = senders.get(item.threadId) ?? null;
        const sender =
          first === null || first.address === null
            ? null
            : normalizeSenderAddress(first.address);
        const claimsOwner = sender !== null && own.addresses.has(sender);
        const isOwn = first?.fromOwner === true || (claimsOwner && trustsOwnAddress);
        // On Gmail a letter that only claims an own address is not the
        // owner's, and it is not a correspondent either: it waits.
        const facts =
          sender === null || isOwn || claimsOwner ? null : this.store.readSenderFacts(sender);
        const input: MailSenderGateInput = {
          gateMoment,
          category: item.category,
          inInbox: first?.inInbox ?? false,
          firstMessageAt: first?.firstMessageAt ?? null,
          startsConversation: first?.startsConversation ?? false,
          followsStranger: false,
          sender,
          own: isOwn,
          known: facts?.known ?? false,
          addressDecision: facts?.addressDecision ?? null,
          domainDecision: facts?.domainDecision ?? null,
        };
        let gated = isMailSenderGated(input);
        if (
          !gated &&
          first !== null &&
          sender !== null &&
          !input.startsConversation &&
          isMailSenderGated({ ...input, followsStranger: true })
        ) {
          gated = await this.followsStranger(accountId, sender, first.references, gateMoment);
        }
        annotated.push(withNewSender(item, gated));
      }
      return Object.freeze(annotated);
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
    const domain = senderDomainOf(address);
    if (input.scope === "domain" && MAIL_SENDER_DOMAIN_SCOPE_REFUSED.has(domain)) {
      throw new MailSenderError("mail_sender_domain_scope_refused");
    }
    const own = await this.readOwn();
    if (
      (input.scope === "address" && own.addresses.has(address)) ||
      (input.scope === "domain" && own.domains.has(domain))
    ) {
      throw new MailSenderError("mail_sender_own_address");
    }
    const { decisionId } = await this.exclusive(
      () =>
        this.store.recordDecision({
          decisionId: `decision-a${randomBytes(16).toString("hex")}`,
          key: input.scope === "domain" ? domain : address,
          kind: input.scope,
          decision: input.decision,
          knownAddress: input.decision === "accept" ? address : null,
        }),
      context.signal,
    );
    if (input.decision === "accept") {
      return Object.freeze({
        apiVersion: 1,
        decisionId,
        archived: Object.freeze([]),
        pending: false,
      });
    }
    const targets: ArchiveTarget[] = [];
    let pending = false;
    const index = this.store.readDecisionIndex();
    for (const accountId of own.connectedAccountIds) {
      let threads: readonly MailInboxThreadSender[];
      try {
        threads = await this.mail.listInboxThreadFirstSenders(accountId);
      } catch {
        // The account's next sync finds what this one could not read.
        pending = true;
        continue;
      }
      // A thread this decision already archived, and the owner put back, is
      // recognised inside the queue, where a second walk of the same block
      // cannot race the first.
      for (const thread of threads) {
        const blocking = this.blockingDecision(index, own, thread);
        if (blocking?.decisionId !== decisionId) continue;
        targets.push({ ref: Object.freeze({ accountId, threadId: thread.threadId }), thread });
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
      let outcome: ArchiveOutcome;
      try {
        outcome = await this.archive(decisionId, target, own, context);
      } catch (error) {
        if (!context.signal.aborted) throw error;
        pending = true;
        break;
      }
      if (outcome === "gone") break;
      if (outcome === "archived") archived.push(target.ref);
      else if (outcome === "deferred") {
        pending = true;
        break;
      } else if (outcome === "failed") pending = true;
    }
    this.logCounts("mail_sender_blocked_archived", "decision", archived);
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
    const removed = await this.exclusive(() => {
      if (Date.now() >= context.deadlineAt) {
        throw new MailSenderError("mail_senders_unavailable");
      }
      return this.store.removeDecision(decisionId, { restore: options.restore });
    }, context.signal);
    if (removed === null) throw new MailSenderError("mail_sender_decision_not_found");
    const restored: MailSenderThreadRef[] = [];
    const dropped: MailSenderThreadRef[] = [];
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
      let outcome: RestoreOutcome;
      try {
        outcome = await this.restore(ref, context);
      } catch (error) {
        if (!context.signal.aborted) throw error;
        pending = true;
        break;
      }
      if (outcome === "restored") restored.push(ref);
      else if (outcome === "kept") pending = true;
      else dropped.push(ref);
    }
    this.logCounts("mail_sender_restore_failed", "undo", dropped);
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
   *  to, whichever transport carried it and whoever wrote it, the owner or an
   *  agent sending in the owner's name. */
  recordSentRecipients(recipients: {
    readonly to: readonly string[];
    readonly cc: readonly string[];
  }): void {
    this.store.learnKnown(normalizeAll([...recipients.to, ...recipients.cc]), "sent");
  }

  /**
   * The scheduler's step for one account, beside its sync. Restores an undo
   * left behind and archives newly arrived letters from blocked senders, both
   * only after a sync that reached the provider, and reads one window of
   * cache rows for the backfill while the screen is on. Every part is bounded.
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

  /**
   * Runs `operation` after everything queued before it. A caller that gives
   * up while its work waits is answered at once with
   * `mail_senders_unavailable`, and its work is dropped unstarted, the way
   * the message service's own mutation queue treats an aborted request.
   */
  private exclusive<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    let started = false;
    const execute = async () => {
      started = true;
      if (signal?.aborted) throw new MailSenderError("mail_senders_unavailable");
      return operation();
    };
    const run = this.tail.then(execute);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    if (signal === undefined) return run;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        if (!started) finish(() => reject(new MailSenderError("mail_senders_unavailable")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  }

  /** When this account starts gating, or null while it gates nothing. */
  private readGateMoment(accountId: string): number | null {
    const state = this.store.readState();
    if (!state.enabled || state.enabledAt === null) return null;
    const completedAt = this.store.readBackfillProgress(accountId)?.completedAt ?? null;
    return completedAt === null ? null : Math.max(state.enabledAt, completedAt);
  }

  /** Every account address, connected or not, and every alias the owner
   *  has been seen sending from. */
  private async readOwn(): Promise<OwnSenders> {
    const accounts = await this.mail.listAccounts();
    const addresses = new Set(normalizeAll(accounts.map((account) => account.address)));
    for (const alias of this.store.listOwnAliases()) addresses.add(alias);
    return Object.freeze({
      connectedAccountIds: Object.freeze(
        accounts.filter((account) => account.connected).map((account) => account.accountId),
      ),
      gmailAccountIds: new Set(
        accounts
          .filter((account) => account.providerKind === "gmail")
          .map((account) => account.accountId),
      ),
      addresses,
      domains: new Set([...addresses].map(senderDomainOf)),
    });
  }

  /**
   * Whether a reply-shaped first letter is a stranger's follow-up: what it
   * answers is the same sender's own letter, or the sender already has a
   * letter waiting in this account. A fresh stranger who forges In-Reply-To
   * passes; nothing the cache holds says otherwise.
   */
  private async followsStranger(
    accountId: string,
    sender: string,
    references: readonly string[],
    gateMoment: number,
  ): Promise<boolean> {
    if (references.length > 0) {
      const answered = normalizeAll(await this.mail.readReferencedSenders(accountId, references));
      if (answered.includes(sender)) return true;
    }
    return this.mail.hasConversationStart(accountId, { address: sender, after: gateMoment });
  }

  /**
   * The block that archives a thread, if any, from an index read once for a
   * whole walk. The owner's threads never have one, whatever the provider:
   * archiving the owner's own letter is worse than letting a forgery stay.
   * An address's own decision speaks first; a domain's block only reaches an
   * address the owner has never decided about and does not know.
   */
  private blockingDecision(
    index: MailSenderDecisionIndex,
    own: OwnSenders,
    thread: { readonly address: string | null; readonly fromOwner: boolean },
  ): MailSenderStandingDecision | null {
    const address = this.nonOwnSender(own, thread);
    if (address === null) return null;
    const addressDecision = index.addresses.get(address);
    if (addressDecision !== undefined) {
      return addressDecision.decision === "block" ? addressDecision : null;
    }
    const domainDecision = index.domains.get(senderDomainOf(address));
    if (domainDecision?.decision !== "block") return null;
    return this.store.isKnown(address) ? null : domainDecision;
  }

  private nonOwnSender(
    own: OwnSenders,
    thread: { readonly address: string | null; readonly fromOwner: boolean },
  ): string | null {
    if (thread.fromOwner || thread.address === null) return null;
    const address = normalizeSenderAddress(thread.address);
    return address === null || own.addresses.has(address) ? null : address;
  }

  private async backfillStep(accountId: string, enabledAt: number): Promise<boolean> {
    const progress = this.store.readBackfillProgress(accountId);
    const complete = progress !== null && progress.completedAt !== null;
    // Once the account gates, its From phase is over: a stranger who writes
    // after that must stay a stranger. The Sent phase goes on reading new
    // rows, so people the owner writes to from any client become known.
    const batch = await this.mail.readSenderBackfillBatch(accountId, {
      fromCursor: progress?.fromCursor ?? 0,
      sentCursor: progress?.sentCursor ?? 0,
      window: this.backfillWindow,
      learnFrom: !complete,
    });
    this.store.recordBackfillStep(accountId, {
      enabledAt,
      known: normalizeAll(batch.known),
      own: normalizeAll(batch.own),
      fromCursor: batch.fromCursor,
      sentCursor: batch.sentCursor,
      complete: complete || (batch.done && batch.cacheReady),
    });
    return !batch.done;
  }

  private async archiveBlocked(accountId: string, signal: AbortSignal): Promise<boolean> {
    if (!this.store.hasBlockDecisions()) return false;
    const now = Date.now();
    for (const [key, retryAt] of this.archiveBackoff) {
      if (retryAt <= now) this.archiveBackoff.delete(key);
    }
    const own = await this.readOwn();
    const index = this.store.readDecisionIndex();
    const effects = this.store.readArchiveEffects(accountId);
    const targets: Array<ArchiveTarget & { readonly decisionId: string }> = [];
    for (const thread of await this.mail.listInboxThreadFirstSenders(accountId)) {
      const blocking = this.blockingDecision(index, own, thread);
      if (
        blocking === null ||
        this.archiveBackoff.has(`${accountId}/${thread.threadId}`) ||
        ownerMovedBack(effects, blocking.decisionId, thread)
      ) {
        continue;
      }
      targets.push({
        ref: Object.freeze({ accountId, threadId: thread.threadId }),
        thread,
        decisionId: blocking.decisionId,
      });
    }
    const archived: MailSenderThreadRef[] = [];
    let attempted = 0;
    for (const target of targets) {
      if (attempted >= BACKGROUND_MUTATIONS_PER_STEP) break;
      signal.throwIfAborted();
      attempted += 1;
      const outcome = await this.archive(target.decisionId, target, own, { signal });
      if (outcome === "archived") {
        archived.push(target.ref);
      } else if (outcome === "failed") {
        this.archiveBackoff.set(
          `${accountId}/${target.ref.threadId}`,
          Date.now() + ARCHIVE_FAILURE_BACKOFF_MS,
        );
      }
    }
    this.logCounts("mail_sender_blocked_archived", "sync", archived);
    return targets.length > attempted;
  }

  private async restorePending(accountId: string, signal: AbortSignal): Promise<boolean> {
    const pending = this.store.listPendingRestores(accountId, BACKGROUND_MUTATIONS_PER_STEP + 1);
    const dropped: MailSenderThreadRef[] = [];
    for (const ref of pending.slice(0, BACKGROUND_MUTATIONS_PER_STEP)) {
      signal.throwIfAborted();
      if ((await this.restore(ref, { signal })) === "dropped") dropped.push(ref);
    }
    this.logCounts("mail_sender_restore_failed", "sync", dropped);
    return pending.length > BACKGROUND_MUTATIONS_PER_STEP;
  }

  /**
   * One archive, in the queue. When its turn comes it checks, before writing
   * anything, that its caller still has time, that this decision still
   * speaks for the thread (a domain block may have met a newly known
   * address), and that the thread is not already archived by it. Then the
   * intent is written, the provider is asked, and the record is finished. A
   * provider that refuses outright leaves nothing behind; any other failure
   * leaves the intent pending, which an undo still moves back.
   */
  private archive(
    decisionId: string,
    target: ArchiveTarget,
    own: OwnSenders,
    work: QueuedWork,
  ): Promise<ArchiveOutcome> {
    const { ref, thread } = target;
    return this.exclusive(async (): Promise<ArchiveOutcome> => {
      if (work.deadlineAt !== undefined && Date.now() >= work.deadlineAt - REQUEST_DEADLINE_MARGIN_MS) {
        return "deferred";
      }
      const address = this.nonOwnSender(own, thread);
      const current = address === null ? null : this.store.readBlockingDecision(address);
      if (current?.decisionId !== decisionId) {
        return this.store.decisionExists(decisionId) ? "skipped" : "gone";
      }
      const effect = this.store.readArchiveEffect(decisionId, ref, thread.firstMessageId);
      if (effect !== null && finishedAndNotNewer(effect, thread)) return "skipped";
      if (!this.store.beginArchiveEffect(decisionId, ref, thread.lastMessageAt, thread.firstMessageId)) {
        return "gone";
      }
      try {
        await this.mail.updateThread(
          { accountId: ref.accountId, threadId: ref.threadId, archive: true },
          work.signal,
        );
      } catch (error) {
        if (isPermanentMutationFailure(error)) this.store.dropArchiveEffect(decisionId, ref);
        return "failed";
      }
      return this.store.finishArchiveEffect(decisionId, ref) ? "archived" : "gone";
    }, work.signal);
  }

  private restore(ref: MailSenderThreadRef, work: QueuedWork): Promise<RestoreOutcome> {
    return this.exclusive(async (): Promise<RestoreOutcome> => {
      if (work.deadlineAt !== undefined && Date.now() >= work.deadlineAt - REQUEST_DEADLINE_MARGIN_MS) {
        return "kept";
      }
      try {
        await this.mail.updateThread(
          { accountId: ref.accountId, threadId: ref.threadId, archive: false },
          work.signal,
        );
      } catch (error) {
        if (work.signal.aborted) return "kept";
        const settled = this.store.settlePendingRestore(
          ref,
          isPermanentMutationFailure(error) ? "given_up" : "failed",
        );
        return settled === "kept" ? "kept" : "dropped";
      }
      this.store.settlePendingRestore(ref, "done");
      return "restored";
    }, work.signal);
  }

  /** Counts per account and nothing else: no address, no thread id. */
  private logCounts(
    event: "mail_sender_blocked_archived" | "mail_sender_restore_failed",
    phase: "decision" | "sync" | "undo",
    refs: readonly MailSenderThreadRef[],
  ): void {
    const counts = new Map<string, number>();
    for (const ref of refs) counts.set(ref.accountId, (counts.get(ref.accountId) ?? 0) + 1);
    for (const [accountId, threadCount] of counts) {
      this.onEvent({ event, phase, accountId, threadCount });
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

/**
 * Whether the owner put a thread back in the Inbox after this decision
 * archived it: the archive is on record, found by thread id or, for an IMAP
 * message that came back under a new UID, by its Message-ID, and nothing
 * newer has arrived since. Such a thread stays; a new letter in it goes the
 * way the first one went.
 */
function ownerMovedBack(
  effects: ReadonlyMap<string, MailSenderArchiveEffect>,
  decisionId: string,
  thread: MailInboxThreadSender,
): boolean {
  const byThread = effects.get(archiveEffectKey(decisionId, thread.threadId));
  const byMessage =
    thread.firstMessageId === null
      ? undefined
      : effects.get(archiveMessageKey(decisionId, thread.firstMessageId));
  return [byThread, byMessage].some(
    (effect) => effect !== undefined && finishedAndNotNewer(effect, thread),
  );
}

function finishedAndNotNewer(
  effect: MailSenderArchiveEffect,
  thread: { readonly lastMessageAt: number | null },
): boolean {
  return (
    effect.state === "done" &&
    (thread.lastMessageAt === null ||
      effect.threadLastAt === null ||
      thread.lastMessageAt <= effect.threadLastAt)
  );
}

function archiveEffectKey(decisionId: string, threadId: string): string {
  return `${decisionId}/${threadId}`;
}

function archiveMessageKey(decisionId: string, messageKey: string): string {
  return `${decisionId}/message/${messageKey}`;
}

function standingDecision(row: Record<string, unknown> | undefined): MailSenderStandingDecision | null {
  if (row === undefined) return null;
  const decision = decisionKind(row.decision);
  if (decision === null || typeof row.decision_id !== "string") {
    throw new MailSenderError("mail_senders_unavailable");
  }
  return Object.freeze({ decisionId: row.decision_id, decision });
}

function validMessageKey(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 3 || value.length > 998) {
    throw new MailSenderError("mail_senders_unavailable");
  }
  return value;
}

function normalizeAll(raw: readonly string[]): string[] {
  return raw.flatMap((value) => {
    const address = normalizeSenderAddress(value);
    return address === null ? [] : [address];
  });
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

function learnOwnIn(database: DatabaseSync, addresses: readonly string[], now: number): void {
  const insert = database.prepare(
    "INSERT OR IGNORE INTO own_senders(address, added_at) VALUES (?, ?)",
  );
  for (const address of new Set(addresses)) {
    if (address.length >= 3 && address.length <= MAX_ADDRESS_LENGTH) {
      insert.run(address, now);
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
