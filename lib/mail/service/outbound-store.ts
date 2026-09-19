import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  fingerprintMailDraftCreate,
  fingerprintMailDraftDelete,
  fingerprintMailDraftMutation,
  MAIL_DRAFT_LIMITS,
  parseMailDraftThreading,
  serializeMailDraftThreading,
  validateMailDraftAccountId,
  validateMailDraftDeleteInput,
  validateMailDraftId,
  validateMailDraftMutationInput,
  validateMailDraftSummaryDto,
  validateStoredMailDraft,
} from "../draft-codec";
import {
  MAIL_DRAFT_API_VERSION,
  MailDraftError,
  type MailDraftCreateInput,
  type MailDraftDeleteInput,
  type MailDraftMutationInput,
  type MailDraftMutationResult,
  type MailDraftSummaryDto,
  type StoredMailDraft,
  type StoredMailDraftAttachment,
} from "../draft-types";
import {
  createQueuedSubmission,
  restoreSubmissionRecord,
  SMTP_ATTEMPTS_EXHAUSTED_ERROR_CODE,
  submissionRunnableAt as smtpSubmissionRunnableAt,
  type SubmissionPhase,
  type SubmissionRecord,
} from "../send-state";
import { MAIL_RESOURCE_LIMITS, writeMailLogRecord } from "../security";
import {
  mailSendInputFromDraft,
  type MailDraftCreateResult,
  type MailDraftDeleteResult,
  type MailDraftSendCommitResult,
  type MailDraftSendStore,
  type MailDraftStore,
} from "./drafts";
import {
  fingerprintMailSendInput,
  MailSendError,
  type MailSendEnqueueResult,
  type MailSendErrorCode,
  type MailSendRequestContext,
  type MailSendStore,
  type MailSendSubmissionIdentity,
  type StoredMailSendMessage,
  type StoredMailSendSubmission,
} from "./outbound";
import { buildOutboundRfc2822 } from "./outbound-message";
import {
  type MailSmtpSubmissionIdentity,
  type MailSmtpSubmissionStateInitializeResult,
  type MailSmtpSubmissionWorkStore,
} from "./smtp-state-store";

/* 3: the finished message moved out of `submission_json` and into the
 * `raw_rfc2822` BLOB beside it. One way — a database at 3 is refused by a
 * service that knows 2, because its reader would find no message in the row
 * and answer a send with an outage. */
const SCHEMA_VERSION = 3;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const DATABASE_FILE = "outbox.sqlite3";
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_OPERATION_ID = /^send-[0-9a-f-]{36}$/;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_FINGERPRINT = /^[a-f0-9]{64}$/;
const SAFE_MESSAGE_ID = /^<[^<>\s\u0000-\u001f\u007f]+>$/u;
const SAFE_ATTEMPT_ID = /^attempt-[0-9a-f-]{36}$/;
const SAFE_DRAFT_FINGERPRINT = /^[a-f0-9]{64}$/;
const MAX_ACCOUNT_CACHE_ENTRIES = 64;
/* What `submission_json` holds now that the message is not in it: the ids, the
 * envelope, the two digests. The envelope is the largest part of that and it is
 * bounded, `MAIL_RESOURCE_LIMITS.addressesPerMessage` of at most 254 bytes each,
 * about 51 KiB before JSON escaping and about 102 KiB after it at worst, so a
 * megabyte is the whole record several times over.
 *
 * It no longer follows the outgoing message ceiling, because the message is a
 * BLOB in its own column and `MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes` is
 * checked against those bytes directly, before the insert. What made the
 * outgoing cap unreachable once was this budget being spent on the message: a
 * 2 MiB literal here left about 1.09 MiB for files and refused everything above
 * it as a service outage that named no size. Nothing of the message is spent
 * here any more. */
const MAX_SERIALIZED_SUBMISSION_BYTES = 1024 * 1024;
/** Every read that rebuilds a submission takes both halves of the row: the
 *  record without its message, and the message. */
const SUBMISSION_COLUMNS = "submission_json, raw_rfc2822";
const MAX_SERIALIZED_SMTP_STATE_BYTES = 128 * 1024;
const MAX_LEGACY_ROWS_PER_ACCOUNT = 10_000;
/** How many rows the schema 2 migration lists at a time. Not a bound on the
 *  account: the walk pages by key until nothing is left. */
const MIGRATION_PAGE_ROWS = 500;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_TERMINAL_ROWS_PER_ACCOUNT = 500;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
const ACTIVE_STATUSES_SQL = "'queued', 'sending'";
const TERMINAL_STATUSES_SQL = "'sent', 'failed', 'delivery_unknown'";

const SMTP_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS smtp_submission_state (
    operation_id TEXT PRIMARY KEY,
    format_version INTEGER NOT NULL CHECK(format_version = 1),
    state_version INTEGER NOT NULL CHECK(state_version >= 0),
    phase TEXT NOT NULL CHECK(phase IN (
      'queued', 'submitting', 'retry_wait', 'sent_copy_pending',
      'sent_copy_unknown', 'sent_copy_failed', 'sent', 'partially_sent',
      'failed', 'delivery_unknown'
    )),
    runnable_at INTEGER CHECK(runnable_at IS NULL OR runnable_at >= 0),
    state_json TEXT NOT NULL CHECK(
      length(CAST(state_json AS BLOB)) <= ${MAX_SERIALIZED_SMTP_STATE_BYTES}
    ),
    FOREIGN KEY(operation_id) REFERENCES outbox(operation_id) ON DELETE CASCADE,
    CHECK(
      (phase IN ('queued', 'submitting', 'retry_wait', 'sent_copy_pending') AND
        runnable_at IS NOT NULL) OR
      (phase IN (
        'sent_copy_unknown', 'sent_copy_failed', 'sent', 'partially_sent',
        'failed', 'delivery_unknown'
      ) AND runnable_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS smtp_submission_state_runnable_idx
    ON smtp_submission_state(runnable_at, operation_id)
    WHERE runnable_at IS NOT NULL;
`;

const DRAFT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS drafts (
    draft_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0),
    state TEXT NOT NULL CHECK(state IN (
      'editing', 'submitting', 'failed', 'delivery_unknown', 'sent'
    )),
    intent TEXT NOT NULL CHECK(intent IN ('compose', 'reply', 'reply_all', 'forward')),
    source_message_id TEXT,
    threading_json TEXT,
    to_text TEXT NOT NULL,
    cc_text TEXT NOT NULL,
    bcc_text TEXT NOT NULL,
    subject TEXT NOT NULL,
    text_body TEXT NOT NULL,
    body_bytes INTEGER NOT NULL CHECK(
      body_bytes >= 0 AND body_bytes = length(CAST(text_body AS BLOB))
    ),
    create_fingerprint TEXT NOT NULL CHECK(
      length(create_fingerprint) = 64 AND
      create_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    send_idempotency_key TEXT,
    send_operation_id TEXT,
    send_error_code TEXT CHECK(send_error_code IS NULL OR send_error_code IN (
      'mail_send_request_invalid',
      'mail_send_account_not_found',
      'mail_send_account_reauth_required',
      'mail_send_reply_target_not_found',
      'mail_send_idempotency_conflict',
      'mail_send_operation_not_found',
      'mail_send_rate_limited',
      'mail_send_service_unavailable'
    )),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    sent_at INTEGER CHECK(sent_at IS NULL OR sent_at >= created_at),
    UNIQUE(account_id, draft_id),
    UNIQUE(account_id, send_idempotency_key),
    CHECK(
      (intent = 'compose' AND source_message_id IS NULL) OR
      (intent IN ('reply', 'reply_all', 'forward') AND source_message_id IS NOT NULL)
    ),
    CHECK(
      (state = 'editing' AND send_idempotency_key IS NULL AND
        send_operation_id IS NULL AND send_error_code IS NULL AND sent_at IS NULL) OR
      (state = 'submitting' AND send_idempotency_key IS NOT NULL AND
        send_operation_id IS NOT NULL AND send_error_code IS NULL AND sent_at IS NULL) OR
      (state IN ('failed', 'delivery_unknown') AND send_idempotency_key IS NOT NULL AND
        send_operation_id IS NOT NULL AND send_error_code IS NOT NULL AND sent_at IS NULL) OR
      (state = 'sent' AND send_idempotency_key IS NOT NULL AND
        send_operation_id IS NOT NULL AND send_error_code IS NULL AND sent_at IS NOT NULL AND
        to_text = '' AND cc_text = '' AND bcc_text = '' AND subject = '' AND
        text_body = '' AND body_bytes = 0)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS drafts_account_updated_idx
    ON drafts(account_id, updated_at DESC, draft_id DESC);
  CREATE INDEX IF NOT EXISTS drafts_sent_retention_idx
    ON drafts(sent_at, draft_id)
    WHERE state = 'sent';
  CREATE UNIQUE INDEX IF NOT EXISTS drafts_send_operation_unique_idx
    ON drafts(account_id, send_operation_id)
    WHERE send_operation_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS draft_mutations (
    draft_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('patch', 'send')),
    fingerprint TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
    applied_revision INTEGER NOT NULL CHECK(applied_revision = expected_revision + 1),
    operation_id TEXT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(draft_id, mutation_id),
    FOREIGN KEY(draft_id) REFERENCES drafts(draft_id) ON DELETE CASCADE,
    CHECK(
      (kind = 'patch' AND operation_id IS NULL) OR
      (kind = 'send' AND operation_id IS NOT NULL)
    )
  ) STRICT;

  CREATE INDEX IF NOT EXISTS draft_mutations_created_idx
    ON draft_mutations(created_at DESC, mutation_id DESC);

  CREATE TABLE IF NOT EXISTS draft_deletions (
    account_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL CHECK(
      length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    PRIMARY KEY(account_id, mutation_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS draft_deletions_created_idx
    ON draft_deletions(account_id, created_at DESC, mutation_id DESC);

  CREATE TABLE IF NOT EXISTS draft_attachments (
    attachment_id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    blob_sha256 TEXT NOT NULL,
    blob_name TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    UNIQUE(draft_id, attachment_id),
    FOREIGN KEY(draft_id, account_id)
      REFERENCES drafts(draft_id, account_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS draft_attachments_account_idx
    ON draft_attachments(account_id, draft_id, attachment_id);
`;

const DRAFT_OUTBOX_INSERT_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS drafts_outbox_insert
  AFTER INSERT ON outbox
  BEGIN
    UPDATE drafts
       SET revision = revision + CASE
             WHEN NEW.status IN ('queued', 'sending') AND
                  state = 'submitting' AND send_error_code IS NULL
               THEN 0
             ELSE 1
           END,
           state = CASE NEW.status
             WHEN 'queued' THEN 'submitting'
             WHEN 'sending' THEN 'submitting'
             WHEN 'sent' THEN 'sent'
             WHEN 'failed' THEN 'failed'
             WHEN 'delivery_unknown' THEN 'delivery_unknown'
           END,
           to_text = CASE WHEN NEW.status = 'sent' THEN '' ELSE to_text END,
           cc_text = CASE WHEN NEW.status = 'sent' THEN '' ELSE cc_text END,
           bcc_text = CASE WHEN NEW.status = 'sent' THEN '' ELSE bcc_text END,
           subject = CASE WHEN NEW.status = 'sent' THEN '' ELSE subject END,
           text_body = CASE WHEN NEW.status = 'sent' THEN '' ELSE text_body END,
           body_bytes = CASE WHEN NEW.status = 'sent' THEN 0 ELSE body_bytes END,
           send_error_code = CASE
             WHEN NEW.status = 'failed' THEN json_extract(NEW.submission_json, '$.lastErrorCode')
             WHEN NEW.status = 'delivery_unknown' THEN 'mail_send_service_unavailable'
             ELSE NULL
           END,
           updated_at = max(updated_at, NEW.updated_at),
           sent_at = CASE WHEN NEW.status = 'sent' THEN NEW.updated_at ELSE NULL END
     WHERE account_id = NEW.account_id
       AND send_operation_id = NEW.operation_id
       AND send_idempotency_key = NEW.idempotency_key;
    DELETE FROM draft_attachments
     WHERE NEW.status = 'sent' AND draft_id IN (
       SELECT draft_id FROM drafts
        WHERE account_id = NEW.account_id
          AND send_operation_id = NEW.operation_id
          AND send_idempotency_key = NEW.idempotency_key
     );
    DELETE FROM drafts
     WHERE draft_id IN (
       SELECT draft_id FROM drafts
        WHERE account_id = NEW.account_id AND state = 'sent'
        ORDER BY sent_at DESC, draft_id DESC
        LIMIT -1 OFFSET ${MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount}
     );
  END`;

const DRAFT_OUTBOX_UPDATE_TRIGGER_SQL = `CREATE TRIGGER IF NOT EXISTS drafts_outbox_status_update
  AFTER UPDATE OF status ON outbox
  BEGIN
    UPDATE drafts
       SET revision = revision + CASE
             WHEN NEW.status IN ('queued', 'sending') AND
                  state = 'submitting' AND send_error_code IS NULL
               THEN 0
             ELSE 1
           END,
           state = CASE NEW.status
             WHEN 'queued' THEN 'submitting'
             WHEN 'sending' THEN 'submitting'
             WHEN 'sent' THEN 'sent'
             WHEN 'failed' THEN 'failed'
             WHEN 'delivery_unknown' THEN 'delivery_unknown'
           END,
           to_text = CASE WHEN NEW.status = 'sent' THEN '' ELSE to_text END,
           cc_text = CASE WHEN NEW.status = 'sent' THEN '' ELSE cc_text END,
           bcc_text = CASE WHEN NEW.status = 'sent' THEN '' ELSE bcc_text END,
           subject = CASE WHEN NEW.status = 'sent' THEN '' ELSE subject END,
           text_body = CASE WHEN NEW.status = 'sent' THEN '' ELSE text_body END,
           body_bytes = CASE WHEN NEW.status = 'sent' THEN 0 ELSE body_bytes END,
           send_error_code = CASE
             WHEN NEW.status = 'failed' THEN json_extract(NEW.submission_json, '$.lastErrorCode')
             WHEN NEW.status = 'delivery_unknown' THEN 'mail_send_service_unavailable'
             ELSE NULL
           END,
           updated_at = max(updated_at, NEW.updated_at),
           sent_at = CASE WHEN NEW.status = 'sent' THEN NEW.updated_at ELSE NULL END
     WHERE account_id = NEW.account_id
       AND send_operation_id = NEW.operation_id
       AND send_idempotency_key = NEW.idempotency_key;
    DELETE FROM draft_attachments
     WHERE NEW.status = 'sent' AND draft_id IN (
       SELECT draft_id FROM drafts
        WHERE account_id = NEW.account_id
          AND send_operation_id = NEW.operation_id
          AND send_idempotency_key = NEW.idempotency_key
     );
    DELETE FROM drafts
     WHERE draft_id IN (
       SELECT draft_id FROM drafts
        WHERE account_id = NEW.account_id AND state = 'sent'
        ORDER BY sent_at DESC, draft_id DESC
        LIMIT -1 OFFSET ${MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount}
     );
  END`;

/* The `raw_rfc2822` default is empty on purpose and is never inserted: it is
 * what lets `migrateSchemaV2` add the column to a table that already holds
 * rows, with `ALTER TABLE ... ADD COLUMN`, so a migrated outbox and a freshly
 * created one are the same table down to the text of this definition. A row
 * left empty by a migration that stopped part way is refused on read like any
 * other corrupt message, and the migration only claims version 3 once no row
 * is empty. */
const OUTBOX_V3_SQL = `
  CREATE TABLE outbox (
    operation_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 0),
    status TEXT NOT NULL CHECK(status IN (
      'queued', 'sending', 'sent', 'failed', 'delivery_unknown'
    )),
    runnable_at INTEGER CHECK(runnable_at IS NULL OR runnable_at >= 0),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    submission_json TEXT NOT NULL,
    raw_rfc2822 BLOB NOT NULL DEFAULT x'',
    UNIQUE(account_id, idempotency_key),
    CHECK(
      (status IN ('queued', 'sending') AND runnable_at IS NOT NULL) OR
      (status IN ('sent', 'failed', 'delivery_unknown') AND runnable_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX outbox_runnable_idx
    ON outbox(runnable_at, created_at, operation_id)
    WHERE runnable_at IS NOT NULL;
  CREATE INDEX outbox_active_idx
    ON outbox(status)
    WHERE status IN ('queued', 'sending');
  CREATE INDEX outbox_terminal_retention_idx
    ON outbox(updated_at DESC, operation_id DESC)
    WHERE status IN ('sent', 'failed', 'delivery_unknown');
`;

const SCHEMA_SQL = `
  CREATE TABLE metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    account_id TEXT NOT NULL
  ) STRICT;

  ${OUTBOX_V3_SQL}
`;

interface RunnableMetadata {
  readonly accountId: string;
  readonly operationId: string;
  readonly runnableAt: number;
  readonly createdAt: number;
}

/** A submission as `submission_json` holds it: the record with the message's
 *  two digests where the message would be. */
type SubmissionWithoutMessage = Omit<StoredMailSendSubmission, "message"> & {
  readonly message: Omit<StoredMailSendMessage, "rawRfc2822">;
};

/**
 * Durable provider-neutral outbox. Every account gets its own private SQLite
 * file below cache/<accountId>. Account deletion already renames that complete
 * directory out of the live namespace, so messages, delivery leases, and raw
 * payloads disappear under the same fail-closed boundary as the message cache.
 *
 * The store opens SQLite only for one operation and closes it before resolving.
 * invalidateAccount() rejects new work and waits for an already-open operation,
 * giving the account-deletion hook a concrete no-open-descriptor barrier before
 * it renames cache/<accountId>.
 */
export class SqliteMailSendStore
  implements
    MailSendStore,
    MailDraftStore,
    MailDraftSendStore,
    MailSmtpSubmissionWorkStore
{
  private readonly cacheRoot: string;
  private readonly now: () => number;
  private readonly onIntegrityCheck: ((accountId: string) => void) | undefined;
  private readonly accountTails = new Map<string, Promise<void>>();
  private readonly invalidatedAccounts = new Set<string>();
  private readonly integrityVerifiedAccounts = new Set<string>();
  private readonly draftSchemaVerifiedAccounts = new Set<string>();
  private readonly smtpStateSchemaVerifiedAccounts = new Set<string>();
  private readonly nextRetentionSweepAt = new Map<string, number>();
  private mutationTail: Promise<void> = Promise.resolve();
  private invalidationEpoch = 0;
  private closed = false;

  constructor(options: {
    readonly cacheRoot: string;
    readonly now?: () => number;
    /** Test/operations observer; never receives message or credential data. */
    readonly onIntegrityCheck?: (accountId: string) => void;
  }) {
    this.cacheRoot = requireAbsolutePath(options.cacheRoot);
    if (
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.onIntegrityCheck !== undefined &&
        typeof options.onIntegrityCheck !== "function")
    ) {
      throw unavailable();
    }
    this.now = options.now ?? Date.now;
    this.onIntegrityCheck = options.onIntegrityCheck;
  }

  async initialize(): Promise<void> {
    this.assertOpen();
    await ensurePrivateDirectory(this.cacheRoot);
  }

  async enqueue(
    input: StoredMailSendSubmission,
  ): Promise<MailSendEnqueueResult> {
    const submission = validateSubmission(input);
    // Before the first database call, so a message over the ceiling is refused
    // with its size named and no row, no lock and no open file behind it.
    assertRawWithinCeiling(submission.message.rawRfc2822);
    const serialized = serializeSubmission(submission);
    return this.runGlobalMutation(async () => {
      const globalExisting = await this.readGlobalOperation(
        submission.operationId,
      );
      if (
        globalExisting !== null &&
        globalExisting.accountId !== submission.accountId
      ) {
        throw new MailSendError("mail_send_idempotency_conflict");
      }
      const existing = await this.pruneAndReadExisting(submission);
      if (existing !== null) return existing;

      if (isActiveStatus(submission.status)) {
        if (this.invalidatedAccounts.size > 0) throw unavailable();
        const invalidationEpoch = this.invalidationEpoch;
        const active = await this.countActive();
        if (
          this.invalidatedAccounts.size > 0 ||
          invalidationEpoch !== this.invalidationEpoch ||
          active >= MAIL_RESOURCE_LIMITS.maxQueuedSubmissions
        ) {
          throw unavailable();
        }
      }
      return this.insertNewSubmission(submission, serialized);
    });
  }

  async readByOperationId(
    operationId: string,
  ): Promise<StoredMailSendSubmission | null> {
    if (!SAFE_OPERATION_ID.test(operationId)) throw unavailable();
    return this.readGlobalOperation(operationId);
  }

  private async readGlobalOperation(
    operationId: string,
  ): Promise<StoredMailSendSubmission | null> {
    const accountIds = await this.listAccountIds();
    let found: StoredMailSendSubmission | null = null;
    for (const accountId of accountIds) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      const value = await this.runAccount(accountId, async () => {
        const database = await this.openAccountDatabase(accountId, false);
        if (!database) return null;
        try {
          const row = database
            .prepare(
              `SELECT ${SUBMISSION_COLUMNS} FROM outbox WHERE operation_id = ?`,
            )
            .get(operationId);
          return row === undefined ? null : submissionFromRow(row);
        } finally {
          await closeDatabase(database, this.databasePath(accountId));
        }
      });
      if (value === null) continue;
      if (found !== null) throw unavailable();
      found = value;
    }
    return found;
  }

  async compareAndSwap(
    operationId: string,
    expectedVersion: number,
    input: StoredMailSendSubmission,
  ): Promise<boolean> {
    const next = validateSubmission(input);
    if (
      operationId !== next.operationId ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      next.version !== expectedVersion + 1
    ) {
      throw unavailable();
    }
    return this.runAccount(next.accountId, async () => {
      const database = await this.openAccountDatabase(next.accountId, false);
      if (!database) return false;
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          // The JSON alone: what this decides is the version, the ownership and
          // the identity, and the message's identity is its two digests, which
          // are in the JSON. Reading the BLOB here would put a second copy of
          // the message beside the caller's on every transition of a send.
          const row = database
            .prepare(
              "SELECT submission_json FROM outbox WHERE operation_id = ?",
            )
            .get(operationId);
          if (row === undefined) {
            database.exec("ROLLBACK");
            return false;
          }
          const current = submissionJsonFromRow(row);
          if (current.version !== expectedVersion) {
            database.exec("ROLLBACK");
            return false;
          }
          // Ownership handoff: every IMAP-provider operation belongs to the
          // SMTP submission worker from the moment its outbox row is inserted.
          // The legacy outbox path can never claim or mutate it, so exactly
          // one worker owns each operation.
          if (current.providerKind === "imap") {
            database.exec("ROLLBACK");
            return false;
          }
          if (!isActiveStatus(current.status) && isActiveStatus(next.status)) {
            throw unavailable();
          }
          assertImmutableIdentity(current, next);
          const result = database
            .prepare(
              `UPDATE outbox
                  SET version = ?, status = ?, runnable_at = ?,
                      created_at = ?, updated_at = ?, submission_json = ?
                WHERE operation_id = ? AND version = ?`,
            )
            .run(
              next.version,
              next.status,
              submissionRunnableAt(next),
              next.createdAt,
              next.updatedAt,
              serializeSubmission(next),
              operationId,
              expectedVersion,
            );
          if (result.changes !== 1) {
            database.exec("ROLLBACK");
            return false;
          }
          const prunedAt = !isActiveStatus(next.status) ? this.readNow() : null;
          if (prunedAt !== null) pruneTerminalRows(database, prunedAt);
          database.exec("COMMIT");
          if (prunedAt !== null) {
            const sweptAt = prunedAt;
            afterCommit(next.accountId, () => {
              this.markRetentionSweep(next.accountId, sweptAt);
            });
          }
          return true;
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw storeError(error);
        }
      } finally {
        await closeDatabase(database, this.databasePath(next.accountId));
      }
    });
  }

  async initializeSmtpSubmissionState(
    accountIdInput: string,
    operationId: string,
  ): Promise<MailSmtpSubmissionStateInitializeResult> {
    const accountId = validateAccountId(accountIdInput);
    if (!SAFE_OPERATION_ID.test(operationId)) throw unavailable();
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) throw unavailable();
      try {
        if (!this.smtpStateSchemaVerifiedAccounts.has(accountId)) {
          initializeSmtpStateSchema(database);
          this.smtpStateSchemaVerifiedAccounts.add(accountId);
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          const outboxRow = database
            .prepare(
              `SELECT submission_json FROM outbox
                WHERE account_id = ? AND operation_id = ?`,
            )
            .get(accountId, operationId);
          if (outboxRow === undefined) throw unavailable();
          const outbox = submissionJsonFromRow(outboxRow);
          assertSmtpOutboxIdentity(accountId, operationId, outbox);

          const existingRow = database
            .prepare(
              `SELECT format_version, state_version, phase, runnable_at, state_json
                 FROM smtp_submission_state
                WHERE operation_id = ?`,
            )
            .get(operationId);
          if (existingRow !== undefined) {
            const existing = smtpStateFromRow(existingRow, outbox);
            database.exec("COMMIT");
            return Object.freeze({ created: false, state: existing });
          }

          const state = createInitialSmtpState(outbox);
          insertSmtpStateRow(database, state);
          database.exec("COMMIT");
          return Object.freeze({ created: true, state });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw storeError(error);
        }
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  async readSmtpSubmissionState(
    accountIdInput: string,
    operationId: string,
  ): Promise<SubmissionRecord | null> {
    const accountId = validateAccountId(accountIdInput);
    if (!SAFE_OPERATION_ID.test(operationId)) throw unavailable();
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return null;
      try {
        if (!this.smtpStateSchemaVerifiedAccounts.has(accountId)) {
          initializeSmtpStateSchema(database);
          this.smtpStateSchemaVerifiedAccounts.add(accountId);
        }
        const row = database
          .prepare(
            `SELECT state.format_version, state.state_version, state.phase, state.runnable_at,
                    state.state_json, outbox.submission_json AS outbox_json
               FROM smtp_submission_state AS state
               JOIN outbox ON outbox.operation_id = state.operation_id
              WHERE outbox.account_id = ? AND state.operation_id = ?`,
          )
          .get(accountId, operationId);
        if (row === undefined) return null;
        return smtpStateFromJoinedRow(row, accountId, operationId);
      } catch (error) {
        throw storeError(error);
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  async compareAndSwapSmtpSubmissionState(
    accountIdInput: string,
    operationId: string,
    expectedVersion: number,
    input: SubmissionRecord,
  ): Promise<boolean> {
    const accountId = validateAccountId(accountIdInput);
    let next: SubmissionRecord;
    try {
      next = restoreSubmissionRecord(input);
    } catch {
      throw unavailable();
    }
    if (
      !SAFE_OPERATION_ID.test(operationId) ||
      next.submission.accountId !== accountId ||
      next.submission.operationId !== operationId ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      next.version !== expectedVersion + 1
    ) {
      throw unavailable();
    }
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return false;
      try {
        if (!this.smtpStateSchemaVerifiedAccounts.has(accountId)) {
          initializeSmtpStateSchema(database);
          this.smtpStateSchemaVerifiedAccounts.add(accountId);
        }
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = database
            .prepare(
              `SELECT state.format_version, state.state_version, state.phase, state.runnable_at,
                      state.state_json, outbox.submission_json AS outbox_json
                 FROM smtp_submission_state AS state
                 JOIN outbox ON outbox.operation_id = state.operation_id
                WHERE outbox.account_id = ? AND state.operation_id = ?`,
            )
            .get(accountId, operationId);
          if (row === undefined) {
            database.exec("ROLLBACK");
            return false;
          }
          if (
            !isExactRecord(row, [
              "format_version",
              "outbox_json",
              "phase",
              "runnable_at",
              "state_json",
              "state_version",
            ]) ||
            typeof row.outbox_json !== "string"
          ) {
            throw unavailable();
          }
          const outbox = submissionJsonFromRow({
            submission_json: row.outbox_json,
          });
          const current = smtpStateFromJoinedRow(row, accountId, operationId);
          if (current.version !== expectedVersion) {
            database.exec("ROLLBACK");
            return false;
          }
          assertImmutableSmtpState(current, next);
          const result = database
            .prepare(
              `UPDATE smtp_submission_state
                  SET state_version = ?, phase = ?, runnable_at = ?, state_json = ?
                WHERE operation_id = ? AND state_version = ?`,
            )
            .run(
              next.version,
              next.phase,
              smtpSubmissionRunnableAt(next),
              serializeSmtpState(next),
              operationId,
              expectedVersion,
            );
          if (result.changes !== 1) {
            database.exec("ROLLBACK");
            return false;
          }
          // Mirror only outcome-grade transitions onto the public outbox row
          // in the same transaction, so drafts and status readers observe the
          // send exactly once. Claim/retry churn stays private to the state
          // row and never rewrites the outbox.
          const mirror = smtpOutboxMirror(outbox, next, this.readNow());
          let prunedAt: number | null = null;
          if (mirror !== null) {
            const mirrored = database
              .prepare(
                `UPDATE outbox
                    SET version = ?, status = ?, runnable_at = ?,
                        updated_at = ?, submission_json = ?
                  WHERE operation_id = ? AND version = ?`,
              )
              .run(
                mirror.version,
                mirror.status,
                submissionRunnableAt(mirror),
                mirror.updatedAt,
                serializeSubmission(mirror),
                operationId,
                outbox.version,
              );
            if (mirrored.changes !== 1) throw unavailable();
            if (!isActiveStatus(mirror.status)) {
              prunedAt = this.readNow();
              pruneTerminalRows(database, prunedAt);
            }
          }
          database.exec("COMMIT");
          if (prunedAt !== null) {
            const sweptAt = prunedAt;
            afterCommit(accountId, () => {
              this.markRetentionSweep(accountId, sweptAt);
            });
          }
          return true;
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw storeError(error);
        }
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  async listRunnableSmtpSubmissions(
    now: number,
    limit: number,
  ): Promise<readonly MailSmtpSubmissionIdentity[]> {
    if (
      !isTimestamp(now) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAIL_RESOURCE_LIMITS.maxQueuedSubmissions
    ) {
      throw unavailable();
    }
    const byAccount = new Map<string, MailSmtpSubmissionIdentity[]>();
    for (const accountId of await this.listAccountIds()) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      const rows = await this.readSmtpIdentities(
        accountId,
        `SELECT operation_id FROM smtp_submission_state
          WHERE runnable_at IS NOT NULL AND runnable_at <= ?
          ORDER BY runnable_at, operation_id
          LIMIT ?`,
        [now, limit],
      );
      if (rows.length > 0) byAccount.set(accountId, [...rows]);
    }
    return mergeAccountIdentities(byAccount, limit);
  }

  async listReconcilableSmtpSubmissions(
    limit: number,
  ): Promise<readonly MailSmtpSubmissionIdentity[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAIL_RESOURCE_LIMITS.maxQueuedSubmissions
    ) {
      throw unavailable();
    }
    const byAccount = new Map<string, MailSmtpSubmissionIdentity[]>();
    for (const accountId of await this.listAccountIds()) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      const rows = await this.readSmtpIdentities(
        accountId,
        `SELECT operation_id FROM smtp_submission_state
          WHERE phase IN ('sent_copy_unknown', 'delivery_unknown')
          ORDER BY operation_id
          LIMIT ?`,
        [limit],
      );
      if (rows.length > 0) byAccount.set(accountId, [...rows]);
    }
    return mergeAccountIdentities(byAccount, limit);
  }

  async nextRunnableSmtpAt(): Promise<number | null> {
    let next: number | null = null;
    for (const accountId of await this.listAccountIds()) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      const accountNext = await this.runAccount(accountId, async () => {
        const database = await this.openAccountDatabase(accountId, false);
        if (!database) return null;
        try {
          const row = database
            .prepare(
              `SELECT MIN(runnable_at) AS next_runnable_at
                 FROM smtp_submission_state`,
            )
            .get();
          return aggregateTimestamp(row, "next_runnable_at");
        } finally {
          await closeDatabase(database, this.databasePath(accountId));
        }
      });
      if (accountNext !== null && (next === null || accountNext < next)) {
        next = accountNext;
      }
    }
    return next;
  }

  async readSmtpSubmissionRaw(
    accountIdInput: string,
    operationId: string,
  ): Promise<Buffer | null> {
    const accountId = validateAccountId(accountIdInput);
    if (!SAFE_OPERATION_ID.test(operationId)) throw unavailable();
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return null;
      try {
        const row = database
          .prepare(
            `SELECT outbox.submission_json, outbox.raw_rfc2822
               FROM smtp_submission_state AS state
               JOIN outbox ON outbox.operation_id = state.operation_id
              WHERE outbox.account_id = ? AND state.operation_id = ?`,
          )
          .get(accountId, operationId);
        if (row === undefined) return null;
        // The BLOB reaches the transport as the bytes SQLite handed back, with
        // no base64 turn either way. `submissionFromRow` has already checked
        // them against the digests the row carries beside them.
        const outbox = submissionFromRow(row);
        assertSmtpOutboxIdentity(accountId, operationId, outbox);
        return outbox.message.rawRfc2822;
      } catch (error) {
        throw storeError(error);
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  private async readSmtpIdentities(
    accountId: string,
    sql: string,
    parameters: readonly number[],
  ): Promise<readonly MailSmtpSubmissionIdentity[]> {
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return [];
      try {
        const rows = database.prepare(sql).all(...parameters);
        return Object.freeze(
          rows.map((row) => {
            if (
              !isExactRecord(row, ["operation_id"]) ||
              typeof row.operation_id !== "string" ||
              !SAFE_OPERATION_ID.test(row.operation_id)
            ) {
              throw unavailable();
            }
            return Object.freeze({
              accountId,
              operationId: row.operation_id,
            });
          }),
        );
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  /**
   * What is runnable, as identities, never as messages.
   *
   * The worker takes a batch — twenty by default — and delivers them one at a
   * time, so a batch that carried its messages would hold all twenty for the
   * length of the pass: 219 MiB of message at the attachment cap, against
   * `MemoryMax=256M`, on exactly the backlog a provider outage produces. It
   * returns the two ids the worker uses and nothing else, and the message is
   * read at the moment it is delivered, so the pass holds one message however
   * deep the queue is.
   *
   * A row whose message is unreadable is listed here like any other and refused
   * on the read that delivers it, which is one failed operation rather than a
   * whole batch that cannot be listed.
   */
  async listRunnable(
    now: number,
    limit: number,
  ): Promise<readonly MailSendSubmissionIdentity[]> {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAIL_RESOURCE_LIMITS.maxQueuedSubmissions
    ) {
      throw unavailable();
    }
    const byAccount = new Map<string, RunnableMetadata[]>();
    for (const accountId of await this.listAccountIds()) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      await this.pruneTerminalRowsIfDue(accountId);
      const rows = await this.readRunnableMetadata(accountId, now, limit);
      if (rows.length > 0) byAccount.set(accountId, [...rows]);
    }
    const accountIds = [...byAccount.keys()].sort((left, right) => {
      const leftValue = byAccount.get(left)?.[0];
      const rightValue = byAccount.get(right)?.[0];
      if (!leftValue || !rightValue) return left.localeCompare(right);
      return compareRunnableMetadata(leftValue, rightValue);
    });
    const selected: RunnableMetadata[] = [];
    while (selected.length < limit) {
      let advanced = false;
      for (const accountId of accountIds) {
        const submission = byAccount.get(accountId)?.shift();
        if (!submission) continue;
        selected.push(submission);
        advanced = true;
        if (selected.length === limit) break;
      }
      if (!advanced) break;
    }
    const seen = new Set<string>();
    return Object.freeze(
      selected.map((metadata) => {
        if (seen.has(metadata.operationId)) throw unavailable();
        seen.add(metadata.operationId);
        return Object.freeze({
          accountId: metadata.accountId,
          operationId: metadata.operationId,
        });
      }),
    );
  }

  async nextRunnableAt(): Promise<number | null> {
    let next: number | null = null;
    for (const accountId of await this.listAccountIds()) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      const accountNext = await this.readNextRunnableAt(accountId);
      if (accountNext !== null && (next === null || accountNext < next)) {
        next = accountNext;
      }
    }
    return next;
  }

  async countActive(): Promise<number> {
    let total = 0;
    for (const accountId of await this.listAccountIds()) {
      if (this.invalidatedAccounts.has(accountId)) continue;
      total += await this.readActiveCount(accountId);
      if (!Number.isSafeInteger(total)) throw unavailable();
    }
    return total;
  }

  async createDraft(
    input: StoredMailDraft,
    requestFingerprint: string,
    request?: MailSendRequestContext,
  ): Promise<MailDraftCreateResult> {
    const draft = validateStoredMailDraft(input);
    if (
      draft.revision !== 0 ||
      draft.state !== "editing" ||
      draft.attachments.length !== 0 ||
      !SAFE_DRAFT_FINGERPRINT.test(requestFingerprint) ||
      fingerprintMailDraftCreate(createInputFromDraft(draft)) !==
        requestFingerprint
    ) {
      throw draftUnavailable();
    }
    this.assertDraftRequestActive(request);
    return this.runDraftAccount(draft.accountId, async () => {
      const database = await this.openAccountDatabase(draft.accountId, true);
      if (!database) throw draftUnavailable();
      try {
        this.assertDraftRequestActive(request);
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneSentDrafts(database, draft.accountId, this.readNow());
          const existing = readDraftById(database, draft.accountId, draft.draftId);
          if (existing !== null) {
            if (
              readDraftCreateFingerprint(
                database,
                draft.accountId,
                draft.draftId,
              ) !== requestFingerprint
            ) {
              throw new MailDraftError("mail_draft_idempotency_conflict");
            }
            this.assertDraftRequestActive(request);
            database.exec("COMMIT");
            return Object.freeze({ created: false, draft: existing });
          }
          if (
            readActiveDraftCount(database, draft.accountId) >=
            MAIL_DRAFT_LIMITS.maxDraftsPerAccount
          ) {
            throw new MailDraftError("mail_draft_quota_exceeded");
          }
          assertDraftAggregateQuota(database, draft.accountId, 0, Buffer.byteLength(draft.text));
          insertDraft(database, draft, requestFingerprint);
          this.assertDraftRequestActive(request);
          database.exec("COMMIT");
          return Object.freeze({ created: true, draft });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(draft.accountId));
      }
    });
  }

  async readDraft(
    accountId: string,
    draftId: string,
  ): Promise<StoredMailDraft | null> {
    const account = draftAccountId(accountId);
    const id = draftIdValue(draftId);
    return this.runDraftAccount(account, async () => {
      const database = await this.openAccountDatabase(account, false);
      if (!database) return null;
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneSentDrafts(database, account, this.readNow());
          const draft = readDraftById(database, account, id);
          database.exec("COMMIT");
          return draft;
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(account));
      }
    });
  }

  async listDrafts(accountId: string): Promise<readonly StoredMailDraft[]> {
    const account = draftAccountId(accountId);
    return this.runDraftAccount(account, async () => {
      const database = await this.openAccountDatabase(account, false);
      if (!database) return Object.freeze([]);
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneSentDrafts(database, account, this.readNow());
          const rows = database
            .prepare(
              `SELECT draft_id FROM drafts
                WHERE account_id = ?
                ORDER BY updated_at DESC, draft_id DESC`,
            )
            .all(account);
          if (
            readActiveDraftCount(database, account) >
              MAIL_DRAFT_LIMITS.maxDraftsPerAccount ||
            readSentDraftCount(database, account) >
              MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount
          ) {
            throw draftUnavailable();
          }
          const drafts = rows.map((row) => {
            if (!isExactRecord(row, ["draft_id"]) || typeof row.draft_id !== "string") {
              throw draftUnavailable();
            }
            const draft = readDraftById(database, account, row.draft_id);
            if (draft === null) throw draftUnavailable();
            return draft;
          });
          database.exec("COMMIT");
          return Object.freeze(drafts);
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(account));
      }
    });
  }

  async listDraftSummaries(
    accountId: string,
  ): Promise<readonly MailDraftSummaryDto[]> {
    const account = draftAccountId(accountId);
    return this.runDraftAccount(account, async () => {
      const database = await this.openAccountDatabase(account, false);
      if (!database) return Object.freeze([]);
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneSentDrafts(database, account, this.readNow());
          if (
            readActiveDraftCount(database, account) >
              MAIL_DRAFT_LIMITS.maxDraftsPerAccount ||
            readSentDraftCount(database, account) >
              MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount
          ) {
            throw draftUnavailable();
          }
          const summaries = database
            .prepare(
              `SELECT draft_id, account_id, revision, state, intent,
                      source_message_id, subject, send_operation_id,
                      send_error_code, created_at, updated_at, sent_at
                 FROM drafts
                WHERE account_id = ?
                ORDER BY updated_at DESC, draft_id DESC`,
            )
            .all(account)
            .map((row) => draftSummaryFromRow(row, account));
          database.exec("COMMIT");
          return Object.freeze(summaries);
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(account));
      }
    });
  }

  async applyDraftMutation(
    input: MailDraftMutationInput,
    requestFingerprint: string,
    updatedAt: number,
    request?: MailSendRequestContext,
  ): Promise<MailDraftMutationResult> {
    const mutation = validateMailDraftMutationInput(input);
    if (
      !SAFE_DRAFT_FINGERPRINT.test(requestFingerprint) ||
      fingerprintMailDraftMutation(mutation) !== requestFingerprint ||
      !isTimestamp(updatedAt)
    ) {
      throw draftUnavailable();
    }
    this.assertDraftRequestActive(request);
    return this.runDraftAccount(mutation.accountId, async () => {
      const database = await this.openAccountDatabase(mutation.accountId, false);
      if (!database) throw new MailDraftError("mail_draft_not_found");
      try {
        this.assertDraftRequestActive(request);
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneSentDrafts(database, mutation.accountId, this.readNow());
          const replay = readDraftMutationReceipt(database, mutation);
          if (replay !== null) {
            if (replay.fingerprint !== requestFingerprint) {
              throw new MailDraftError("mail_draft_idempotency_conflict");
            }
            this.assertDraftRequestActive(request);
            database.exec("COMMIT");
            return Object.freeze({
              replayed: true,
              appliedRevision: replay.appliedRevision,
              operationId: replay.operationId,
            });
          }
          const current = readDraftById(
            database,
            mutation.accountId,
            mutation.draftId,
          );
          if (current === null) throw new MailDraftError("mail_draft_not_found");
          if (current.revision !== mutation.expectedRevision) {
            throw new MailDraftError("mail_draft_revision_conflict");
          }
          if (
            mutation.kind === "send" &&
            hasDraftSendIdentityCollision(database, mutation)
          ) {
            throw new MailDraftError("mail_draft_idempotency_conflict");
          }
          const next = applyDraftMutation(current, mutation, updatedAt);
          assertDraftAggregateQuota(
            database,
            mutation.accountId,
            Buffer.byteLength(current.text),
            Buffer.byteLength(next.text),
          );
          const changed = updateDraft(database, current.revision, next);
          if (!changed) throw new MailDraftError("mail_draft_revision_conflict");
          pruneDraftMutationReceipts(database, mutation.accountId);
          insertDraftMutationReceipt(
            database,
            mutation,
            requestFingerprint,
            next.revision,
            updatedAt,
          );
          this.assertDraftRequestActive(request);
          database.exec("COMMIT");
          return Object.freeze({
            replayed: false,
            appliedRevision: next.revision,
            operationId:
              mutation.kind === "send" ? mutation.sendOperationId : null,
          });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(mutation.accountId));
      }
    });
  }

  async commitDraftSend(
    input: MailDraftMutationInput,
    requestFingerprint: string,
    inputSubmission: StoredMailSendSubmission,
    updatedAt: number,
    request?: MailSendRequestContext,
  ): Promise<MailDraftSendCommitResult> {
    const mutation = validateMailDraftMutationInput(input);
    let submission: StoredMailSendSubmission;
    let serialized: string;
    try {
      submission = validateSubmission(inputSubmission);
      assertRawWithinCeiling(submission.message.rawRfc2822);
      serialized = serializeSubmission(submission);
    } catch {
      throw draftUnavailable();
    }
    if (
      mutation.kind !== "send" ||
      !SAFE_DRAFT_FINGERPRINT.test(requestFingerprint) ||
      fingerprintMailDraftMutation(mutation) !== requestFingerprint ||
      !isTimestamp(updatedAt) ||
      !isInitialDraftSubmission(mutation, submission, updatedAt)
    ) {
      throw draftUnavailable();
    }
    this.assertDraftRequestActive(request);

    try {
      return await this.runGlobalMutation(async () => {
        this.assertDraftRequestActive(request);
        const globalExisting = await this.readGlobalOperation(
          submission.operationId,
        );
        if (
          globalExisting !== null &&
          globalExisting.accountId !== mutation.accountId
        ) {
          throw new MailDraftError("mail_draft_idempotency_conflict");
        }
        const invalidationEpoch = this.invalidationEpoch;
        const hadInvalidatedAccounts = this.invalidatedAccounts.size > 0;
        const active = await this.countActive();
        const hasCapacity =
          !hadInvalidatedAccounts &&
          this.invalidatedAccounts.size === 0 &&
          invalidationEpoch === this.invalidationEpoch &&
          active < MAIL_RESOURCE_LIMITS.maxQueuedSubmissions;

        return this.runDraftAccount(mutation.accountId, async () => {
          const database = await this.openAccountDatabase(
            mutation.accountId,
            false,
          );
          if (!database) throw new MailDraftError("mail_draft_not_found");
          try {
            this.assertDraftRequestActive(request);
            database.exec("BEGIN IMMEDIATE");
            try {
              const prunedAt = this.readNow();
              pruneTerminalRows(database, prunedAt);
              pruneSentDrafts(database, mutation.accountId, prunedAt);

              const replay = readDraftMutationReceipt(database, mutation);
              if (replay !== null) {
                if (replay.fingerprint !== requestFingerprint) {
                  throw new MailDraftError("mail_draft_idempotency_conflict");
                }
                const existing = this.readExistingSubmission(
                  database,
                  submission,
                );
                if (
                  existing === null ||
                  replay.operationId !== existing.operationId
                ) {
                  throw draftUnavailable();
                }
                this.assertDraftRequestActive(request);
                database.exec("COMMIT");
                this.markRetentionSweep(mutation.accountId, prunedAt);
                return Object.freeze({
                  replayed: true,
                  appliedRevision: replay.appliedRevision,
                  operationId: existing.operationId,
                  created: false,
                  submission: existing,
                });
              }

              const current = readDraftById(
                database,
                mutation.accountId,
                mutation.draftId,
              );
              if (current === null) {
                throw new MailDraftError("mail_draft_not_found");
              }
              if (current.revision !== mutation.expectedRevision) {
                throw new MailDraftError("mail_draft_revision_conflict");
              }
              if (!draftMatchesSubmission(current, mutation, submission)) {
                throw new MailDraftError("mail_draft_idempotency_conflict");
              }
              if (hasDraftSendIdentityCollision(database, mutation)) {
                throw new MailDraftError("mail_draft_idempotency_conflict");
              }
              let existing: StoredMailSendSubmission | null;
              try {
                existing = this.readExistingSubmission(database, submission);
              } catch {
                throw new MailDraftError("mail_draft_idempotency_conflict");
              }
              if (existing !== null) {
                throw new MailDraftError("mail_draft_idempotency_conflict");
              }
              if (
                !hasCapacity ||
                this.invalidatedAccounts.size > 0 ||
                invalidationEpoch !== this.invalidationEpoch
              ) {
                throw draftUnavailable();
              }

              const next = applyDraftMutation(current, mutation, updatedAt);
              assertDraftAggregateQuota(
                database,
                mutation.accountId,
                Buffer.byteLength(current.text),
                Buffer.byteLength(next.text),
              );
              if (!updateDraft(database, current.revision, next)) {
                throw new MailDraftError("mail_draft_revision_conflict");
              }
              pruneDraftMutationReceipts(database, mutation.accountId);
              insertDraftMutationReceipt(
                database,
                mutation,
                requestFingerprint,
                next.revision,
                updatedAt,
              );
              insertSubmissionRow(database, submission, serialized);
              insertSmtpOwnershipRow(database, submission);
              const committedDraft = readDraftById(
                database,
                mutation.accountId,
                mutation.draftId,
              );
              if (
                committedDraft === null ||
                committedDraft.revision !== next.revision ||
                committedDraft.state !== "submitting" ||
                committedDraft.sendOperationId !== submission.operationId ||
                committedDraft.sendIdempotencyKey !== submission.idempotencyKey
              ) {
                throw draftUnavailable();
              }
              this.assertDraftRequestActive(request);
              database.exec("COMMIT");
              this.markRetentionSweep(mutation.accountId, prunedAt);
              return Object.freeze({
                replayed: false,
                appliedRevision: next.revision,
                operationId: submission.operationId,
                created: true,
                submission,
              });
            } catch (error) {
              if (database.isTransaction) database.exec("ROLLBACK");
              throw error;
            }
          } finally {
            await closeDatabase(database, this.databasePath(mutation.accountId));
          }
        });
      });
    } catch (error) {
      throw draftStoreError(error);
    }
  }

  async deleteDraft(
    deletion: MailDraftDeleteInput,
    requestFingerprint: string,
    deletedAt: number,
    request?: MailSendRequestContext,
  ): Promise<MailDraftDeleteResult> {
    const input = validateMailDraftDeleteInput(deletion);
    if (
      !SAFE_DRAFT_FINGERPRINT.test(requestFingerprint) ||
      fingerprintMailDraftDelete(input) !== requestFingerprint
    ) {
      throw draftUnavailable();
    }
    const fingerprint = requestFingerprint;
    if (!Number.isSafeInteger(deletedAt) || deletedAt < 0) throw draftUnavailable();
    this.assertDraftRequestActive(request);
    return this.runDraftAccount(input.accountId, async () => {
      const database = await this.openAccountDatabase(input.accountId, false);
      if (!database) throw new MailDraftError("mail_draft_not_found");
      try {
        this.assertDraftRequestActive(request);
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneSentDrafts(database, input.accountId, deletedAt);
          pruneDraftDeletionReceipts(database, input.accountId, deletedAt);
          const receipt = readDraftDeletionReceipt(
            database,
            input.accountId,
            input.mutationId,
          );
          if (receipt !== null) {
            if (
              receipt.draftId !== input.draftId ||
              receipt.fingerprint !== fingerprint ||
              receipt.expectedRevision !== input.expectedRevision
            ) {
              throw new MailDraftError("mail_draft_idempotency_conflict");
            }
            database.exec("COMMIT");
            return Object.freeze({ replayed: true });
          }
          const current = readDraftById(database, input.accountId, input.draftId);
          if (current === null) {
            throw new MailDraftError("mail_draft_not_found");
          }
          if (current.revision !== input.expectedRevision) {
            throw new MailDraftError("mail_draft_revision_conflict");
          }
          if (current.state === "submitting") {
            throw new MailDraftError("mail_draft_state_invalid");
          }
          const result = database
            .prepare(
              `DELETE FROM drafts
                WHERE account_id = ? AND draft_id = ? AND revision = ?
                  AND state <> 'submitting'`,
            )
            .run(input.accountId, input.draftId, input.expectedRevision);
          if (result.changes !== 1) {
            throw new MailDraftError("mail_draft_revision_conflict");
          }
          database
            .prepare(
              `INSERT INTO draft_deletions(
                 account_id, mutation_id, draft_id, fingerprint,
                 expected_revision, created_at
               ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.accountId,
              input.mutationId,
              input.draftId,
              fingerprint,
              input.expectedRevision,
              deletedAt,
            );
          pruneDraftDeletionReceipts(database, input.accountId, deletedAt);
          this.assertDraftRequestActive(request);
          database.exec("COMMIT");
          return Object.freeze({ replayed: false });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(input.accountId));
      }
    });
  }

  /** Account-deletion barrier: call and await before renaming its cache dir. */
  async invalidateAccount(accountId: string): Promise<void> {
    const id = validateAccountId(accountId);
    this.invalidatedAccounts.add(id);
    this.integrityVerifiedAccounts.delete(id);
    this.draftSchemaVerifiedAccounts.delete(id);
    this.smtpStateSchemaVerifiedAccounts.delete(id);
    this.nextRetentionSweepAt.delete(id);
    this.invalidationEpoch += 1;
    await this.accountTails.get(id)?.catch(() => undefined);
  }

  /**
   * Account protocol edits may only proceed behind invalidateAccount(). Old
   * queued SMTP work must retain the exact SMTP and Sent-IMAP binding it was
   * created with, so fail closed while any operation can still deliver or
   * reconcile against those transports.
   */
  async assertAccountProtocolMutationSafe(
    accountIdInput: string,
    options: { readonly preservesBindings: boolean } = {
      preservesBindings: false,
    },
  ): Promise<void> {
    this.assertOpen();
    const accountId = validateAccountId(accountIdInput);
    if (!this.invalidatedAccounts.has(accountId)) throw unavailable();
    await this.accountTails.get(accountId)?.catch(() => undefined);
    if (!this.invalidatedAccounts.has(accountId)) throw unavailable();
    if (options.preservesBindings) return;
    const database = await this.openAccountDatabase(accountId, false);
    if (!database) return;
    try {
      const blocking = database
        .prepare(
          `SELECT 1 AS blocking
             FROM smtp_submission_state
            WHERE phase NOT IN ('sent', 'partially_sent', 'failed', 'sent_copy_failed')
            LIMIT 1`,
        )
        .get();
      if (blocking !== undefined) throw unavailable();
    } finally {
      await closeDatabase(database, this.databasePath(accountId));
    }
  }

  /** Rollback hook when the authoritative account delete did not commit. */
  async restoreInvalidatedAccount(accountId: string): Promise<void> {
    this.assertOpen();
    const id = validateAccountId(accountId);
    await this.accountTails.get(id)?.catch(() => undefined);
    this.invalidatedAccounts.delete(id);
    this.invalidationEpoch += 1;
  }

  /** Process-shutdown barrier. No SQLite descriptor survives its resolution. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.mutationTail.catch(() => undefined);
    const tails = [...this.accountTails.values()];
    await Promise.all(tails.map((tail) => tail.catch(() => undefined)));
    this.accountTails.clear();
    this.integrityVerifiedAccounts.clear();
    this.draftSchemaVerifiedAccounts.clear();
    this.smtpStateSchemaVerifiedAccounts.clear();
    this.nextRetentionSweepAt.clear();
  }

  private assertDraftRequestActive(
    request: MailSendRequestContext | undefined,
  ): void {
    if (request === undefined) return;
    if (
      request.signal.aborted ||
      !Number.isSafeInteger(request.deadlineAt) ||
      this.readNow() >= request.deadlineAt
    ) {
      throw draftUnavailable();
    }
  }

  private async runAccount<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    const id = validateAccountId(accountId);
    if (this.invalidatedAccounts.has(id)) throw unavailable();
    const prior = this.accountTails.get(id) ?? Promise.resolve();
    const run = prior.then(
      async () => {
        this.assertOpen();
        if (this.invalidatedAccounts.has(id)) throw unavailable();
        return operation();
      },
      async () => {
        this.assertOpen();
        if (this.invalidatedAccounts.has(id)) throw unavailable();
        return operation();
      },
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.accountTails.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.accountTails.get(id) === tail) this.accountTails.delete(id);
    }
  }

  private async listAccountIds(): Promise<readonly string[]> {
    this.assertOpen();
    await ensurePrivateDirectory(this.cacheRoot);
    const entries = await readdir(this.cacheRoot, { withFileTypes: true });
    if (entries.length > MAX_ACCOUNT_CACHE_ENTRIES) throw unavailable();
    const accountIds: string[] = [];
    for (const entry of entries) {
      if (!SAFE_ACCOUNT_ID.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw unavailable();
      accountIds.push(entry.name);
    }
    return Object.freeze(accountIds.sort());
  }

  private async pruneAndReadExisting(
    submission: StoredMailSendSubmission,
  ): Promise<MailSendEnqueueResult | null> {
    return this.runAccount(submission.accountId, async () => {
      const database = await this.openAccountDatabase(submission.accountId, true);
      if (!database) throw unavailable();
      // An answer has been earned: from here the caller is owed the result this
      // transaction reached, and a failure past that point may not be told as
      // one that happened instead of it. Not "COMMIT returned" — the raced-read
      // branch in `insertNewSubmission` earns an answer without one.
      let answered = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const prunedAt = this.readNow();
          pruneTerminalRows(database, prunedAt);
          const existing = this.readExistingSubmission(database, submission);
          database.exec("COMMIT");
          answered = true;
          afterCommit(submission.accountId, () => {
            this.markRetentionSweep(submission.accountId, prunedAt);
          });
          return existing === null
            ? null
            : Object.freeze({ created: false, submission: existing });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        try {
          await closeDatabase(database, this.databasePath(submission.accountId));
        } catch (error) {
          if (!answered) throw error;
          logAfterCommit(submission.accountId, error);
        }
      }
    });
  }

  private async insertNewSubmission(
    submission: StoredMailSendSubmission,
    serialized: string,
  ): Promise<MailSendEnqueueResult> {
    return this.runAccount(submission.accountId, async () => {
      const database = await this.openAccountDatabase(submission.accountId, true);
      if (!database) throw unavailable();
      // See `pruneAndReadExisting`: an answer has been earned, which the raced
      // read below reaches without a COMMIT of its own.
      let answered = false;
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const prunedAt = this.readNow();
          pruneTerminalRows(database, prunedAt);
          const existing = this.readExistingSubmission(database, submission);
          if (existing !== null) {
            database.exec("COMMIT");
            answered = true;
            afterCommit(submission.accountId, () => {
              this.markRetentionSweep(submission.accountId, prunedAt);
            });
            return Object.freeze({ created: false, submission: existing });
          }
          insertSubmissionRow(database, submission, serialized);
          insertSmtpOwnershipRow(database, submission);
          if (!isActiveStatus(submission.status)) {
            pruneTerminalRows(database, prunedAt);
          }
          database.exec("COMMIT");
          answered = true;
          afterCommit(submission.accountId, () => {
            this.markRetentionSweep(submission.accountId, prunedAt);
          });
          return Object.freeze({ created: true, submission });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          const raced = this.readByIdempotencyKey(
            database,
            submission.accountId,
            submission.idempotencyKey,
          );
          if (raced === null) throw error;
          if (raced.requestFingerprint !== submission.requestFingerprint) {
            throw new MailSendError("mail_send_idempotency_conflict");
          }
          // Another writer committed this row, so the message is durable and
          // this call has an answer for it. A close that fails after this is
          // the same "nothing happened" lie as one after a COMMIT of our own.
          answered = true;
          return Object.freeze({ created: false, submission: raced });
        }
      } finally {
        try {
          await closeDatabase(database, this.databasePath(submission.accountId));
        } catch (error) {
          if (!answered) throw error;
          logAfterCommit(submission.accountId, error);
        }
      }
    });
  }

  private readExistingSubmission(
    database: DatabaseSync,
    submission: StoredMailSendSubmission,
  ): StoredMailSendSubmission | null {
    const existingOperation = database
      .prepare(`SELECT ${SUBMISSION_COLUMNS} FROM outbox WHERE operation_id = ?`)
      .get(submission.operationId);
    if (existingOperation !== undefined) {
      const existing = submissionFromRow(existingOperation);
      if (
        existing.accountId === submission.accountId &&
        existing.idempotencyKey === submission.idempotencyKey &&
        existing.requestFingerprint === submission.requestFingerprint
      ) {
        return existing;
      }
      throw unavailable();
    }
    const existingKey = this.readByIdempotencyKey(
      database,
      submission.accountId,
      submission.idempotencyKey,
    );
    if (existingKey === null) return null;
    if (existingKey.requestFingerprint !== submission.requestFingerprint) {
      throw new MailSendError("mail_send_idempotency_conflict");
    }
    return existingKey;
  }

  private async pruneTerminalRowsIfDue(accountId: string): Promise<void> {
    const observedNow = this.readNow();
    if ((this.nextRetentionSweepAt.get(accountId) ?? 0) > observedNow) return;
    await this.runAccount(accountId, async () => {
      const now = this.readNow();
      if ((this.nextRetentionSweepAt.get(accountId) ?? 0) > now) return;
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) {
        this.markRetentionSweep(accountId, now);
        return;
      }
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          pruneTerminalRows(database, now);
          database.exec("COMMIT");
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
        afterCommit(accountId, () => {
          this.markRetentionSweep(accountId, now);
        });
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  private markRetentionSweep(accountId: string, now: number): void {
    this.nextRetentionSweepAt.set(
      accountId,
      safeFutureTimestamp(now, RETENTION_SWEEP_INTERVAL_MS),
    );
  }

  private async readRunnableMetadata(
    accountId: string,
    now: number,
    limit: number,
  ): Promise<readonly RunnableMetadata[]> {
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return [];
      try {
        const rows = database
          .prepare(
            `SELECT operation_id, runnable_at, created_at
               FROM outbox
              WHERE runnable_at <= ?
                AND NOT EXISTS (
                  SELECT 1 FROM smtp_submission_state AS state
                   WHERE state.operation_id = outbox.operation_id
                )
              ORDER BY runnable_at, created_at, operation_id
              LIMIT ?`,
          )
          .all(now, limit);
        return Object.freeze(
          rows.map((row) => runnableMetadataFromRow(accountId, row)),
        );
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  private async readNextRunnableAt(accountId: string): Promise<number | null> {
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return null;
      try {
        const row = database
          .prepare(
            `SELECT MIN(runnable_at) AS next_runnable_at FROM outbox
              WHERE NOT EXISTS (
                SELECT 1 FROM smtp_submission_state AS state
                 WHERE state.operation_id = outbox.operation_id
              )`,
          )
          .get();
        return aggregateTimestamp(row, "next_runnable_at");
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  private async readActiveCount(accountId: string): Promise<number> {
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) return 0;
      try {
        const row = database
          .prepare(
            `SELECT COUNT(*) AS active_count
               FROM outbox
              WHERE status IN (${ACTIVE_STATUSES_SQL})`,
          )
          .get();
        return aggregateCount(row, "active_count");
      } finally {
        await closeDatabase(database, this.databasePath(accountId));
      }
    });
  }

  private runGlobalMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runDraftAccount<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.runAccount(accountId, operation);
    } catch (error) {
      throw draftStoreError(error);
    }
  }

  private async openAccountDatabase(
    accountId: string,
    create: boolean,
  ): Promise<DatabaseSync | null> {
    const id = validateAccountId(accountId);
    await ensurePrivateDirectory(this.cacheRoot);
    const accountDirectory = path.join(this.cacheRoot, id);
    if (create) {
      await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
    } else if (!(await pathExists(accountDirectory))) {
      return null;
    }
    await assertPrivateDirectory(accountDirectory);
    await assertContainedPath(this.cacheRoot, accountDirectory);
    const databasePath = this.databasePath(id);
    if (create) {
      await ensurePrivateDatabaseFile(databasePath);
    } else if (!(await pathExists(databasePath))) {
      return null;
    } else {
      await assertPrivateDatabaseFile(databasePath);
    }

    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(databasePath, {
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
      initializeSchema(database, id, {
        verifyIntegrity: !this.integrityVerifiedAccounts.has(id),
        onIntegrityCheck: this.onIntegrityCheck,
        now: this.readNow(),
      });
      if (!this.draftSchemaVerifiedAccounts.has(id)) {
        initializeDraftSchema(database, id, this.readNow());
        this.draftSchemaVerifiedAccounts.add(id);
      }
      if (!this.smtpStateSchemaVerifiedAccounts.has(id)) {
        initializeSmtpStateSchema(database);
        this.smtpStateSchemaVerifiedAccounts.add(id);
      }
      await ensureSqliteFilesPrivate(databasePath);
      this.integrityVerifiedAccounts.add(id);
      return database;
    } catch (error) {
      database?.close();
      throw storeError(error);
    }
  }

  private readByIdempotencyKey(
    database: DatabaseSync,
    accountId: string,
    idempotencyKey: string,
  ): StoredMailSendSubmission | null {
    const row = database
      .prepare(
        `SELECT ${SUBMISSION_COLUMNS} FROM outbox
          WHERE account_id = ? AND idempotency_key = ?`,
      )
      .get(accountId, idempotencyKey);
    return row === undefined ? null : submissionFromRow(row);
  }

  private databasePath(accountId: string): string {
    return path.join(this.cacheRoot, accountId, DATABASE_FILE);
  }

  private readNow(): number {
    const now = this.now();
    if (!isTimestamp(now)) throw unavailable();
    return now;
  }

  private assertOpen(): void {
    if (this.closed) throw unavailable();
  }
}

function initializeSchema(
  database: DatabaseSync,
  accountId: string,
  options: {
    readonly verifyIntegrity: boolean;
    readonly onIntegrityCheck: ((accountId: string) => void) | undefined;
    readonly now: number;
  },
): void {
  const version = database.prepare("PRAGMA user_version").get()?.user_version;
  let integrityVerified = false;
  if (version === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(SCHEMA_SQL);
      database
        .prepare("INSERT INTO metadata(singleton, account_id) VALUES (1, ?)")
        .run(accountId);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  } else if (version === 1 || version === 2) {
    assertDatabaseIdentity(
      database,
      accountId,
      true,
      options.onIntegrityCheck,
    );
    integrityVerified = true;
    // A version 1 file predates both the drafts tables and the SMTP state
    // table, so its outbox can be rebuilt whole; version 2 has both, and one
    // of them holds a foreign key into the outbox. The two migrations stay
    // apart for that reason and a file at 1 walks through both.
    if (version === 1) migrateSchemaV1(database, options.now, accountId);
    migrateSchemaV2(database, accountId);
  } else if (version !== SCHEMA_VERSION) {
    throw unavailable();
  }
  assertDatabaseIdentity(
    database,
    accountId,
    options.verifyIntegrity && !integrityVerified,
    options.onIntegrityCheck,
  );
}

function assertDatabaseIdentity(
  database: DatabaseSync,
  accountId: string,
  verifyIntegrity: boolean,
  onIntegrityCheck: ((accountId: string) => void) | undefined,
): void {
  const metadata = database
    .prepare("SELECT account_id FROM metadata WHERE singleton = 1")
    .all();
  if (
    metadata.length !== 1 ||
    metadata[0]?.account_id !== accountId
  ) {
    throw unavailable();
  }
  if (!verifyIntegrity) return;
  onIntegrityCheck?.(accountId);
  if (database.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") {
    throw unavailable();
  }
}

/**
 * Schema 2 to 3: the message leaves `submission_json` for the `raw_rfc2822`
 * BLOB beside it.
 *
 * The column is added rather than the table rebuilt. A rebuild would mean
 * renaming and dropping `outbox`, and at version 2 two other objects point at
 * it: `smtp_submission_state` holds a foreign key with ON DELETE CASCADE, so
 * dropping the table would delete every SMTP submission's state, and the two
 * drafts triggers fire on insert, so copying rows through them would bump draft
 * revisions and delete a sent draft's attachments. `ALTER TABLE ... ADD COLUMN`
 * touches neither.
 *
 * One transaction per row, so the largest thing in memory at any moment is one
 * message rather than the account's whole outbox, and a row's decode, its BLOB
 * and its shortened JSON commit together or not at all. A file that loses power
 * part way is left at version 2 with some rows already moved, which is why the
 * work is driven off the rows that are still empty and why version 3 is claimed
 * only when none are. One way: a service that knows schema 2 reads the shortened
 * JSON, finds no message in it, and refuses the file.
 *
 * One row's message being unreadable — base64url that does not decode, digests
 * that do not match what it decodes to, a message above the outgoing ceiling —
 * costs that row and nothing else. It is marked failed with an empty message and
 * the walk carries on, because the alternative was throwing out of the open: the
 * version stayed at 2, every later open repeated the failure, and an account
 * could not send, read a status or drain what was already queued. Under schema 2
 * the same corruption cost exactly the row that carried it, and it should cost
 * the same here. A read of such a row is refused the way any corrupt message is.
 *
 * The walk is by key rather than by offset, so it advances past the rows it
 * marks, and it has no row bound: the bound it had refused to migrate an account
 * with more than ten thousand rows still to move, which was a second way to
 * leave a file unopenable for good.
 */
function migrateSchemaV2(database: DatabaseSync, accountId: string): void {
  if (!outboxHasRawColumn(database)) {
    database.exec(
      "ALTER TABLE outbox ADD COLUMN raw_rfc2822 BLOB NOT NULL DEFAULT x''",
    );
  }
  const page = database.prepare(
    `SELECT operation_id FROM outbox
      WHERE length(raw_rfc2822) = 0 AND operation_id > ?
      ORDER BY operation_id
      LIMIT ?`,
  );
  let unreadable = 0;
  let after = "";
  for (;;) {
    const rows = page.all(after, MIGRATION_PAGE_ROWS);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (
        !isExactRecord(row, ["operation_id"]) ||
        typeof row.operation_id !== "string"
      ) {
        throw unavailable();
      }
      after = row.operation_id;
      if (migrateSubmissionRowToBlob(database, row.operation_id)) continue;
      unreadable += 1;
      writeMailLogRecord({
        event: "mail_outbox_row_unreadable",
        accountId,
        operationId: row.operation_id,
      });
    }
  }
  // Every empty row was visited, and each was either filled or marked, so what
  // is left empty is exactly what was marked.
  if (
    aggregateCount(
      database
        .prepare(
          `SELECT COUNT(*) AS row_count FROM outbox
            WHERE length(raw_rfc2822) = 0`,
        )
        .get(),
      "row_count",
    ) !== unreadable
  ) {
    throw unavailable();
  }
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Whether the row's message moved. False means it could not be read and the
 *  row was marked failed instead, which the caller logs. */
function migrateSubmissionRowToBlob(
  database: DatabaseSync,
  operationId: string,
): boolean {
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database
      .prepare(
        `SELECT submission_json FROM outbox
          WHERE operation_id = ? AND length(raw_rfc2822) = 0`,
      )
      .get(operationId);
    // Another writer got there first, which is an answer and not a failure.
    if (row === undefined) {
      database.exec("COMMIT");
      return true;
    }
    let submission: StoredMailSendSubmission | null = null;
    try {
      submission = submissionFromLegacyJson(row);
      // A message the service could not put on the wire either way. Marked here
      // rather than carried forward, so the row says what happened to it instead
      // of failing at the transport with an untyped error every retry.
      if (
        submission.message.rawRfc2822Bytes >
        MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes
      ) {
        submission = null;
      }
    } catch {
      submission = null;
    }
    if (submission === null) {
      // The JSON is left as it stands. It still holds whatever the row had, which
      // is the only evidence of the message left, and a read refuses the row
      // anyway: an empty BLOB cannot match the digests beside it.
      markOutboxRowFailed(database, operationId);
      database.exec("COMMIT");
      return false;
    }
    const changed = database
      .prepare(
        `UPDATE outbox SET submission_json = ?, raw_rfc2822 = ?
          WHERE operation_id = ? AND length(raw_rfc2822) = 0`,
      )
      .run(
        serializeSubmission(submission),
        submission.message.rawRfc2822,
        operationId,
      );
    if (changed.changes !== 1) throw unavailable();
    database.exec("COMMIT");
    return true;
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/** Terminal, and not runnable: whatever the worker would have done with this
 *  row, it cannot send a message it cannot read. */
function markOutboxRowFailed(
  database: DatabaseSync,
  operationId: string,
): void {
  database
    .prepare(
      `UPDATE outbox SET status = 'failed', runnable_at = NULL
        WHERE operation_id = ?`,
    )
    .run(operationId);
}

function outboxHasRawColumn(database: DatabaseSync): boolean {
  return database
    .prepare("SELECT name FROM pragma_table_info('outbox')")
    .all()
    .some((row) => row.name === "raw_rfc2822");
}

/**
 * Schema 1 to 3, by rebuilding the table.
 *
 * Safe here and not at version 2: a version 1 file predates both the drafts
 * tables and the SMTP state table, so nothing holds a foreign key into
 * `outbox` and no trigger fires on an insert into it.
 *
 * A row whose message cannot be read, or whose message is above today's
 * outgoing ceiling, is carried across as failed with an empty message rather
 * than failing the open — the same trade `migrateSchemaV2` makes, for the same
 * reason. The row bound stays: a version 1 file is old enough that a backlog
 * above ten thousand rows is a corrupt file rather than a busy account.
 */
function migrateSchemaV1(
  database: DatabaseSync,
  now: number,
  accountId: string,
): void {
  const count = aggregateCount(
    database.prepare("SELECT COUNT(*) AS row_count FROM outbox").get(),
    "row_count",
  );
  if (count > MAX_LEGACY_ROWS_PER_ACCOUNT) throw unavailable();

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("ALTER TABLE outbox RENAME TO outbox_v1");
    database.exec(OUTBOX_V3_SQL);
    let migrated = 0;
    const rows = database
      .prepare(
        `SELECT operation_id, account_id, idempotency_key,
                request_fingerprint, version, submission_json
           FROM outbox_v1
          ORDER BY operation_id`,
      )
      .iterate();
    for (const row of rows) {
      migrated += 1;
      if (migrated > MAX_LEGACY_ROWS_PER_ACCOUNT) throw unavailable();
      let submission: StoredMailSendSubmission | null = null;
      try {
        submission = legacySubmissionFromRow(row);
        if (
          submission.message.rawRfc2822Bytes >
          MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes
        ) {
          submission = null;
        }
      } catch {
        submission = null;
      }
      if (submission === null) {
        insertUnreadableLegacyRow(database, row, now);
        writeMailLogRecord({
          event: "mail_outbox_row_unreadable",
          accountId,
          operationId:
            typeof row.operation_id === "string" ? row.operation_id : "unknown",
        });
        continue;
      }
      insertSubmissionRow(
        database,
        submission,
        serializeSubmission(submission),
      );
    }
    if (migrated !== count) throw unavailable();
    database.exec("DROP TABLE outbox_v1");
    pruneTerminalRows(database, now, false);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

/**
 * A version 1 row whose message could not be read, carried into version 3 as a
 * failed one.
 *
 * Only the five columns version 1 had are trusted here, because the JSON is what
 * could not be read: no timestamps come out of it, so the migration's own clock
 * stands in for both, which also means the row lives out the ordinary terminal
 * retention window instead of being swept by the prune at the end of the same
 * migration. The JSON is kept as it stands — it is the only evidence of the
 * message left — and the empty message is what makes a read of the row refuse it.
 */
function insertUnreadableLegacyRow(
  database: DatabaseSync,
  row: Record<string, unknown>,
  now: number,
): void {
  if (
    typeof row.operation_id !== "string" ||
    !SAFE_OPERATION_ID.test(row.operation_id) ||
    typeof row.account_id !== "string" ||
    !SAFE_ACCOUNT_ID.test(row.account_id) ||
    typeof row.idempotency_key !== "string" ||
    !SAFE_IDEMPOTENCY_KEY.test(row.idempotency_key) ||
    typeof row.request_fingerprint !== "string" ||
    !SAFE_FINGERPRINT.test(row.request_fingerprint) ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 0 ||
    typeof row.submission_json !== "string"
  ) {
    throw unavailable();
  }
  database
    .prepare(
      `INSERT INTO outbox(
         operation_id, account_id, idempotency_key, request_fingerprint,
         version, status, runnable_at, created_at, updated_at, submission_json
       ) VALUES (?, ?, ?, ?, ?, 'failed', NULL, ?, ?, ?)`,
    )
    .run(
      row.operation_id,
      row.account_id,
      row.idempotency_key,
      row.request_fingerprint,
      row.version as number,
      now,
      now,
      row.submission_json,
    );
}

function initializeDraftSchema(
  database: DatabaseSync,
  accountId: string,
  now: number,
): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(DRAFT_SCHEMA_SQL);
    database.exec("DROP TRIGGER IF EXISTS drafts_outbox_insert");
    database.exec("DROP TRIGGER IF EXISTS drafts_outbox_status_update");
    database.exec(DRAFT_OUTBOX_INSERT_TRIGGER_SQL);
    database.exec(DRAFT_OUTBOX_UPDATE_TRIGGER_SQL);
    pruneSentDrafts(database, accountId, now);
    assertDraftSchema(database, accountId);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function assertDraftSchema(database: DatabaseSync, accountId: string): void {
  const expectedColumns = new Map<string, readonly string[]>([
    [
      "drafts",
      [
        "draft_id",
        "account_id",
        "revision",
        "state",
        "intent",
        "source_message_id",
        "threading_json",
        "to_text",
        "cc_text",
        "bcc_text",
        "subject",
        "text_body",
        "body_bytes",
        "create_fingerprint",
        "send_idempotency_key",
        "send_operation_id",
        "send_error_code",
        "created_at",
        "updated_at",
        "sent_at",
      ],
    ],
    [
      "draft_mutations",
      [
        "draft_id",
        "mutation_id",
        "kind",
        "fingerprint",
        "expected_revision",
        "applied_revision",
        "operation_id",
        "created_at",
      ],
    ],
    [
      "draft_deletions",
      [
        "account_id",
        "mutation_id",
        "draft_id",
        "fingerprint",
        "expected_revision",
        "created_at",
      ],
    ],
    [
      "draft_attachments",
      [
        "attachment_id",
        "draft_id",
        "account_id",
        "filename",
        "mime_type",
        "bytes",
        "blob_sha256",
        "blob_name",
        "created_at",
      ],
    ],
  ]);
  for (const [table, expected] of expectedColumns) {
    const columns = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (
      columns.length !== expected.length ||
      columns.some((column, index) => column !== expected[index])
    ) {
      throw draftUnavailable();
    }
  }
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length !== 0) throw draftUnavailable();
  const foreignAccount = database
    .prepare("SELECT 1 FROM drafts WHERE account_id <> ? LIMIT 1")
    .get(accountId);
  if (foreignAccount !== undefined) throw draftUnavailable();
  const foreignDeletion = database
    .prepare("SELECT 1 FROM draft_deletions WHERE account_id <> ? LIMIT 1")
    .get(accountId);
  if (foreignDeletion !== undefined) throw draftUnavailable();
  if (
    readActiveDraftCount(database, accountId) >
    MAIL_DRAFT_LIMITS.maxDraftsPerAccount
  ) {
    throw draftUnavailable();
  }
  if (
    readSentDraftCount(database, accountId) >
    MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount
  ) {
    throw draftUnavailable();
  }
  if (
    readDraftMutationCount(database, accountId) >
    MAIL_DRAFT_LIMITS.maxMutationReceiptsPerAccount
  ) {
    throw draftUnavailable();
  }
  if (
    readDraftDeletionCount(database, accountId) >
    MAIL_DRAFT_LIMITS.maxDeleteReceiptsPerAccount
  ) {
    throw draftUnavailable();
  }
  const aggregate = readDraftAggregateBytes(database, accountId);
  if (aggregate > MAIL_DRAFT_LIMITS.maxAccountBytes) throw draftUnavailable();
  const rows = database
    .prepare("SELECT draft_id FROM drafts WHERE account_id = ?")
    .all(accountId);
  for (const row of rows) {
    if (!isExactRecord(row, ["draft_id"]) || typeof row.draft_id !== "string") {
      throw draftUnavailable();
    }
    readDraftCreateFingerprint(database, accountId, row.draft_id);
    if (readDraftById(database, accountId, row.draft_id) === null) {
      throw draftUnavailable();
    }
  }
}

function initializeSmtpStateSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SMTP_STATE_SCHEMA_SQL);
    assertSmtpStateSchema(database);
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}

function assertSmtpStateSchema(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(smtp_submission_state)")
    .all()
    .map((row) => row.name);
  const expected = [
    "operation_id",
    "format_version",
    "state_version",
    "phase",
    "runnable_at",
    "state_json",
  ];
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => column !== expected[index])
  ) {
    throw unavailable();
  }
  const indexes = database
    .prepare("PRAGMA index_list(smtp_submission_state)")
    .all()
    .map((row) => row.name);
  if (!indexes.includes("smtp_submission_state_runnable_idx")) {
    throw unavailable();
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw unavailable();
  }
}

function insertDraft(
  database: DatabaseSync,
  draft: StoredMailDraft,
  createFingerprint: string,
): void {
  database
    .prepare(
      `INSERT INTO drafts(
         draft_id, account_id, revision, state, intent, source_message_id,
         threading_json, to_text, cc_text, bcc_text, subject, text_body,
         body_bytes, create_fingerprint, send_idempotency_key,
         send_operation_id, send_error_code,
         created_at, updated_at, sent_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draft.draftId,
      draft.accountId,
      draft.revision,
      draft.state,
      draft.intent.kind,
      draft.intent.kind === "compose" ? null : draft.intent.sourceMessageId,
      serializeMailDraftThreading(draft.threading),
      draft.to,
      draft.cc,
      draft.bcc,
      draft.subject,
      draft.text,
      Buffer.byteLength(draft.text),
      createFingerprint,
      draft.sendIdempotencyKey,
      draft.sendOperationId,
      draft.sendErrorCode,
      draft.createdAt,
      draft.updatedAt,
      draft.sentAt,
    );
}

function updateDraft(
  database: DatabaseSync,
  expectedRevision: number,
  draft: StoredMailDraft,
): boolean {
  const result = database
    .prepare(
      `UPDATE drafts
          SET revision = ?, state = ?, intent = ?, source_message_id = ?,
              threading_json = ?, to_text = ?, cc_text = ?, bcc_text = ?,
              subject = ?, text_body = ?, body_bytes = ?,
              send_idempotency_key = ?, send_operation_id = ?,
              send_error_code = ?, created_at = ?, updated_at = ?, sent_at = ?
        WHERE account_id = ? AND draft_id = ? AND revision = ?`,
    )
    .run(
      draft.revision,
      draft.state,
      draft.intent.kind,
      draft.intent.kind === "compose" ? null : draft.intent.sourceMessageId,
      serializeMailDraftThreading(draft.threading),
      draft.to,
      draft.cc,
      draft.bcc,
      draft.subject,
      draft.text,
      Buffer.byteLength(draft.text),
      draft.sendIdempotencyKey,
      draft.sendOperationId,
      draft.sendErrorCode,
      draft.createdAt,
      draft.updatedAt,
      draft.sentAt,
      draft.accountId,
      draft.draftId,
      expectedRevision,
    );
  return result.changes === 1;
}

function readDraftById(
  database: DatabaseSync,
  accountId: string,
  draftId: string,
): StoredMailDraft | null {
  const row = database
    .prepare(
      `SELECT draft_id, account_id, revision, state, intent, source_message_id,
              threading_json, to_text, cc_text, bcc_text, subject, text_body,
              body_bytes, send_idempotency_key, send_operation_id,
              send_error_code, created_at, updated_at, sent_at
         FROM drafts
        WHERE account_id = ? AND draft_id = ?`,
    )
    .get(accountId, draftId);
  if (row === undefined) return null;
  if (
    !isExactRecord(row, [
      "account_id",
      "bcc_text",
      "body_bytes",
      "cc_text",
      "created_at",
      "draft_id",
      "intent",
      "revision",
      "send_error_code",
      "send_idempotency_key",
      "send_operation_id",
      "sent_at",
      "source_message_id",
      "state",
      "subject",
      "text_body",
      "threading_json",
      "to_text",
      "updated_at",
    ]) ||
    row.account_id !== accountId ||
    row.draft_id !== draftId ||
    typeof row.intent !== "string" ||
    typeof row.text_body !== "string" ||
    row.body_bytes !== Buffer.byteLength(row.text_body)
  ) {
    throw draftUnavailable();
  }
  const intent =
    row.intent === "compose"
      ? { kind: "compose" as const }
      : row.intent === "reply" ||
          row.intent === "reply_all" ||
          row.intent === "forward"
        ? {
            kind: row.intent,
            sourceMessageId: row.source_message_id,
          }
        : null;
  if (intent === null) throw draftUnavailable();
  const attachments = readDraftAttachments(database, accountId, draftId);
  try {
    return validateStoredMailDraft({
      apiVersion: MAIL_DRAFT_API_VERSION,
      draftId: row.draft_id,
      accountId: row.account_id,
      revision: row.revision,
      state: row.state,
      intent,
      threading: parseMailDraftThreading(row.threading_json),
      to: row.to_text,
      cc: row.cc_text,
      bcc: row.bcc_text,
      subject: row.subject,
      text: row.text_body,
      attachments,
      sendIdempotencyKey: row.send_idempotency_key,
      sendOperationId: row.send_operation_id,
      sendErrorCode: row.send_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
    });
  } catch {
    throw draftUnavailable();
  }
}

function draftSummaryFromRow(
  row: unknown,
  accountId: string,
): MailDraftSummaryDto {
  if (
    !isExactRecord(row, [
      "account_id",
      "created_at",
      "draft_id",
      "intent",
      "revision",
      "send_error_code",
      "send_operation_id",
      "sent_at",
      "source_message_id",
      "state",
      "subject",
      "updated_at",
    ]) ||
    row.account_id !== accountId ||
    typeof row.intent !== "string"
  ) {
    throw draftUnavailable();
  }
  const intent =
    row.intent === "compose" && row.source_message_id === null
      ? { kind: "compose" as const }
      : (row.intent === "reply" ||
            row.intent === "reply_all" ||
            row.intent === "forward") &&
          typeof row.source_message_id === "string"
        ? {
            kind: row.intent,
            sourceMessageId: row.source_message_id,
          }
        : null;
  if (intent === null) throw draftUnavailable();
  try {
    return validateMailDraftSummaryDto({
      apiVersion: MAIL_DRAFT_API_VERSION,
      draftId: row.draft_id,
      accountId: row.account_id,
      revision: row.revision,
      state: row.state,
      intent,
      subject: row.subject,
      sendOperationId: row.send_operation_id,
      sendErrorCode: row.send_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
    });
  } catch {
    throw draftUnavailable();
  }
}

function readDraftCreateFingerprint(
  database: DatabaseSync,
  accountId: string,
  draftId: string,
): string {
  const row = database
    .prepare(
      `SELECT create_fingerprint
         FROM drafts
        WHERE account_id = ? AND draft_id = ?`,
    )
    .get(accountId, draftId);
  if (
    !row ||
    !isExactRecord(row, ["create_fingerprint"]) ||
    typeof row.create_fingerprint !== "string" ||
    !SAFE_DRAFT_FINGERPRINT.test(row.create_fingerprint)
  ) {
    throw draftUnavailable();
  }
  return row.create_fingerprint;
}

function hasDraftSendIdentityCollision(
  database: DatabaseSync,
  mutation: Extract<MailDraftMutationInput, { readonly kind: "send" }>,
): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS collision
         FROM drafts
        WHERE account_id = ? AND draft_id <> ?
          AND (send_operation_id = ? OR send_idempotency_key = ?)
        LIMIT 1`,
    )
    .get(
      mutation.accountId,
      mutation.draftId,
      mutation.sendOperationId,
      mutation.sendIdempotencyKey,
    );
  if (row === undefined) return false;
  if (!isExactRecord(row, ["collision"]) || row.collision !== 1) {
    throw draftUnavailable();
  }
  return true;
}

function readDraftAttachments(
  database: DatabaseSync,
  accountId: string,
  draftId: string,
): readonly StoredMailDraftAttachment[] {
  const rows = database
    .prepare(
      `SELECT attachment_id, draft_id, account_id, filename, mime_type,
              bytes, blob_sha256, blob_name, created_at
         FROM draft_attachments
        WHERE account_id = ? AND draft_id = ?
        ORDER BY created_at, attachment_id`,
    )
    .all(accountId, draftId);
  return Object.freeze(
    rows.map((row) => {
      if (
        !isExactRecord(row, [
          "account_id",
          "attachment_id",
          "blob_name",
          "blob_sha256",
          "bytes",
          "created_at",
          "draft_id",
          "filename",
          "mime_type",
        ])
      ) {
        throw draftUnavailable();
      }
      return Object.freeze({
        attachmentId: row.attachment_id as string,
        draftId: row.draft_id as string,
        accountId: row.account_id as string,
        filename: row.filename as string,
        mimeType: row.mime_type as string,
        bytes: row.bytes as number,
        blobSha256: row.blob_sha256 as string,
        blobName: row.blob_name as string,
        createdAt: row.created_at as number,
      });
    }),
  );
}

function applyDraftMutation(
  current: StoredMailDraft,
  mutation: MailDraftMutationInput,
  updatedAt: number,
): StoredMailDraft {
  if (updatedAt < current.createdAt || updatedAt < current.updatedAt) {
    throw draftUnavailable();
  }
  if (
    current.state === "sent" ||
    current.state === "delivery_unknown" ||
    current.state === "submitting"
  ) {
    throw new MailDraftError("mail_draft_state_invalid");
  }
  if (mutation.kind === "patch") {
    return validateStoredMailDraft({
      ...current,
      revision: current.revision + 1,
      state: "editing",
      to: mutation.patch.to ?? current.to,
      cc: mutation.patch.cc ?? current.cc,
      bcc: mutation.patch.bcc ?? current.bcc,
      subject: mutation.patch.subject ?? current.subject,
      text: mutation.patch.text ?? current.text,
      sendIdempotencyKey: null,
      sendOperationId: null,
      sendErrorCode: null,
      updatedAt,
      sentAt: null,
    });
  }
  return validateStoredMailDraft({
    ...current,
    revision: current.revision + 1,
    state: "submitting",
    sendIdempotencyKey: mutation.sendIdempotencyKey,
    sendOperationId: mutation.sendOperationId,
    sendErrorCode: null,
    updatedAt,
    sentAt: null,
  });
}

function isInitialDraftSubmission(
  mutation: Extract<MailDraftMutationInput, { readonly kind: "send" }>,
  submission: StoredMailSendSubmission,
  updatedAt: number,
): boolean {
  return (
    submission.accountId === mutation.accountId &&
    submission.operationId === mutation.sendOperationId &&
    submission.idempotencyKey === mutation.sendIdempotencyKey &&
    submission.version === 0 &&
    submission.status === "queued" &&
    submission.attemptCount === 0 &&
    submission.lease === null &&
    submission.providerMessageId === null &&
    submission.providerThreadId === null &&
    submission.lastErrorCode === null &&
    submission.createdAt === updatedAt &&
    submission.updatedAt === updatedAt &&
    submission.nextAttemptAt === updatedAt
  );
}

function draftMatchesSubmission(
  draft: StoredMailDraft,
  mutation: Extract<MailDraftMutationInput, { readonly kind: "send" }>,
  submission: StoredMailSendSubmission,
): boolean {
  if (draft.attachments.length !== 0) return false;
  const replyMode =
    draft.intent.kind === "reply" || draft.intent.kind === "reply_all";
  const threading = draft.threading;
  if (
    (threading !== null) !== replyMode ||
    (replyMode && threading?.rfcMessageId === null)
  ) {
    return false;
  }

  let expectedRaw: Buffer | null = null;
  try {
    // Shares the service's derivation on purpose: a second recipient parser
    // here silently changed the fingerprint and rejected honest sends.
    const input = mailSendInputFromDraft(draft, mutation.sendIdempotencyKey);
    if (fingerprintMailSendInput(input) !== submission.requestFingerprint) {
      return false;
    }
    const expectedProviderThreadId = threading?.providerThreadId ?? null;
    if (submission.message.providerThreadId !== expectedProviderThreadId) {
      return false;
    }
    const built = buildOutboundRfc2822({
      from: submission.message.envelope.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      messageId: submission.message.messageId,
      createdAt: submission.createdAt,
      reply:
        threading === null
          ? null
          : {
              inReplyTo: threading.rfcMessageId!,
              references: threading.references,
            },
      attachments: [],
      origin: input.origin,
      agentLine: input.agentLine,
    });
    expectedRaw = built.rawRfc2822;
    // The bytes are compared to the bytes, in constant time neither before nor
    // now: what this decides is whether a replay rebuilt the same message, and
    // both sides are this service's own.
    return (
      equalEnvelope(built.envelope, submission.message.envelope) &&
      expectedRaw.byteLength === submission.message.rawRfc2822Bytes &&
      expectedRaw.equals(submission.message.rawRfc2822) &&
      createHash("sha256").update(expectedRaw).digest("hex") ===
        submission.message.rawRfc2822Sha256
    );
  } catch {
    return false;
  } finally {
    expectedRaw?.fill(0);
  }
}

function equalEnvelope(
  left: StoredMailSendMessage["envelope"],
  right: StoredMailSendMessage["envelope"],
): boolean {
  return (
    left.from === right.from &&
    equalStrings(left.to, right.to) &&
    equalStrings(left.cc, right.cc) &&
    equalStrings(left.bcc, right.bcc)
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function readDraftMutationReceipt(
  database: DatabaseSync,
  mutation: MailDraftMutationInput,
): {
  readonly fingerprint: string;
  readonly appliedRevision: number;
  readonly operationId: string | null;
} | null {
  const row = database
    .prepare(
      `SELECT kind, fingerprint, expected_revision, applied_revision, operation_id
         FROM draft_mutations
        WHERE draft_id = ? AND mutation_id = ?`,
    )
    .get(mutation.draftId, mutation.mutationId);
  if (row === undefined) return null;
  if (
    !isExactRecord(row, [
      "applied_revision",
      "expected_revision",
      "fingerprint",
      "kind",
      "operation_id",
    ]) ||
    row.kind !== mutation.kind ||
    row.expected_revision !== mutation.expectedRevision ||
    !Number.isSafeInteger(row.applied_revision) ||
    row.applied_revision !== mutation.expectedRevision + 1 ||
    typeof row.fingerprint !== "string" ||
    !SAFE_DRAFT_FINGERPRINT.test(row.fingerprint) ||
    (mutation.kind === "patch" && row.operation_id !== null) ||
    (mutation.kind === "send" && row.operation_id !== mutation.sendOperationId)
  ) {
    throw new MailDraftError("mail_draft_idempotency_conflict");
  }
  return Object.freeze({
    fingerprint: row.fingerprint,
    appliedRevision: row.applied_revision,
    operationId: row.operation_id as string | null,
  });
}

function insertDraftMutationReceipt(
  database: DatabaseSync,
  mutation: MailDraftMutationInput,
  fingerprint: string,
  appliedRevision: number,
  createdAt: number,
): void {
  database
    .prepare(
      `INSERT INTO draft_mutations(
         draft_id, mutation_id, kind, fingerprint, expected_revision,
         applied_revision, operation_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      mutation.draftId,
      mutation.mutationId,
      mutation.kind,
      fingerprint,
      mutation.expectedRevision,
      appliedRevision,
      mutation.kind === "send" ? mutation.sendOperationId : null,
      createdAt,
    );
}

function pruneDraftMutationReceipts(
  database: DatabaseSync,
  accountId: string,
): void {
  database
    .prepare(
      `DELETE FROM draft_mutations
        WHERE rowid IN (
          SELECT mutation.rowid
            FROM draft_mutations AS mutation
            JOIN drafts AS draft ON draft.draft_id = mutation.draft_id
           WHERE draft.account_id = ?
           ORDER BY mutation.created_at DESC, mutation.mutation_id DESC
           LIMIT -1 OFFSET ?
        )`,
    )
    .run(accountId, MAIL_DRAFT_LIMITS.maxMutationReceiptsPerAccount - 1);
}

function readDraftDeletionReceipt(
  database: DatabaseSync,
  accountId: string,
  mutationId: string,
): {
  readonly draftId: string;
  readonly fingerprint: string;
  readonly expectedRevision: number;
} | null {
  const row = database
    .prepare(
      `SELECT draft_id, fingerprint, expected_revision
         FROM draft_deletions
        WHERE account_id = ? AND mutation_id = ?`,
    )
    .get(accountId, mutationId);
  if (row === undefined) return null;
  if (
    !isExactRecord(row, ["draft_id", "expected_revision", "fingerprint"]) ||
    typeof row.draft_id !== "string" ||
    typeof row.fingerprint !== "string" ||
    !SAFE_DRAFT_FINGERPRINT.test(row.fingerprint) ||
    !Number.isSafeInteger(row.expected_revision) ||
    (row.expected_revision as number) < 0
  ) {
    throw draftUnavailable();
  }
  return Object.freeze({
    draftId: row.draft_id,
    fingerprint: row.fingerprint,
    expectedRevision: row.expected_revision as number,
  });
}

function pruneDraftDeletionReceipts(
  database: DatabaseSync,
  accountId: string,
  now: number,
): void {
  const cutoff = Math.max(0, now - MAIL_DRAFT_LIMITS.deleteReceiptMs);
  database
    .prepare(
      `DELETE FROM draft_deletions
        WHERE account_id = ? AND created_at < ?`,
    )
    .run(accountId, cutoff);
  database
    .prepare(
      `DELETE FROM draft_deletions
        WHERE rowid IN (
          SELECT rowid FROM draft_deletions
           WHERE account_id = ?
           ORDER BY created_at DESC, mutation_id DESC
           LIMIT -1 OFFSET ?
        )`,
    )
    .run(accountId, MAIL_DRAFT_LIMITS.maxDeleteReceiptsPerAccount);
}

function pruneSentDrafts(
  database: DatabaseSync,
  accountId: string,
  now: number,
): void {
  const cutoff = Math.max(0, now - MAIL_DRAFT_LIMITS.sentTombstoneMs);
  database
    .prepare(
      `DELETE FROM drafts
        WHERE account_id = ? AND state = 'sent'
          AND sent_at IS NOT NULL AND sent_at < ?`,
    )
    .run(accountId, cutoff);
  database
    .prepare(
      `DELETE FROM drafts
        WHERE draft_id IN (
          SELECT draft_id FROM drafts
           WHERE account_id = ? AND state = 'sent'
           ORDER BY sent_at DESC, draft_id DESC
           LIMIT -1 OFFSET ?
        )`,
    )
    .run(accountId, MAIL_DRAFT_LIMITS.maxSentTombstonesPerAccount);
}

function readActiveDraftCount(
  database: DatabaseSync,
  accountId: string,
): number {
  return aggregateDraftNumber(
    database
      .prepare(
        `SELECT COUNT(*) AS value FROM drafts
          WHERE account_id = ? AND state <> 'sent'`,
      )
      .get(accountId),
  );
}

function readSentDraftCount(database: DatabaseSync, accountId: string): number {
  return aggregateDraftNumber(
    database
      .prepare(
        `SELECT COUNT(*) AS value FROM drafts
          WHERE account_id = ? AND state = 'sent'`,
      )
      .get(accountId),
  );
}

function readDraftMutationCount(
  database: DatabaseSync,
  accountId: string,
): number {
  return aggregateDraftNumber(
    database
      .prepare(
        `SELECT COUNT(*) AS value
           FROM draft_mutations AS mutation
           JOIN drafts AS draft ON draft.draft_id = mutation.draft_id
          WHERE draft.account_id = ?`,
      )
      .get(accountId),
  );
}

function readDraftDeletionCount(
  database: DatabaseSync,
  accountId: string,
): number {
  return aggregateDraftNumber(
    database
      .prepare(
        `SELECT COUNT(*) AS value FROM draft_deletions
          WHERE account_id = ?`,
      )
      .get(accountId),
  );
}

function readDraftAggregateBytes(
  database: DatabaseSync,
  accountId: string,
): number {
  return aggregateDraftNumber(
    database
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(body_bytes) FROM drafts WHERE account_id = ?), 0) +
           COALESCE((SELECT SUM(bytes) FROM draft_attachments WHERE account_id = ?), 0)
           AS value`,
      )
      .get(accountId, accountId),
  );
}

function assertDraftAggregateQuota(
  database: DatabaseSync,
  accountId: string,
  previousBodyBytes: number,
  nextBodyBytes: number,
): void {
  const aggregate = readDraftAggregateBytes(database, accountId);
  const next = aggregate - previousBodyBytes + nextBodyBytes;
  if (
    !Number.isSafeInteger(next) ||
    next < 0 ||
    next > MAIL_DRAFT_LIMITS.maxAccountBytes
  ) {
    throw new MailDraftError("mail_draft_quota_exceeded");
  }
}

function aggregateDraftNumber(
  row: Record<string, unknown> | undefined,
): number {
  if (
    !row ||
    !isExactRecord(row, ["value"]) ||
    !Number.isSafeInteger(row.value) ||
    (row.value as number) < 0
  ) {
    throw draftUnavailable();
  }
  return row.value as number;
}

function createInputFromDraft(draft: StoredMailDraft): MailDraftCreateInput {
  return Object.freeze({
    draftId: draft.draftId,
    accountId: draft.accountId,
    intent: draft.intent,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    text: draft.text,
  });
}

function draftAccountId(value: string): string {
  try {
    return validateMailDraftAccountId(value);
  } catch {
    throw draftUnavailable();
  }
}

function draftIdValue(value: string): string {
  try {
    return validateMailDraftId(value);
  } catch {
    throw draftUnavailable();
  }
}

/**
 * The record the row's JSON holds: everything except the message bytes.
 *
 * Most of what the store does with a row needs this and not the message — a
 * compare-and-swap compares the digests, the SMTP state row pins its identity
 * on them, the queue listing needs neither. The BLOB is read only where the
 * bytes themselves are going somewhere: a delivery, or a replay handed back to
 * the caller that asked for the send.
 */
function submissionJsonFromRow(
  row: Record<string, unknown>,
): SubmissionWithoutMessage {
  if (
    typeof row.submission_json !== "string" ||
    Buffer.byteLength(row.submission_json) > MAX_SERIALIZED_SUBMISSION_BYTES
  ) {
    throw unavailable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.submission_json);
  } catch {
    throw unavailable();
  }
  return validateSubmissionWithoutMessage(parsed);
}

/**
 * The whole record, from the row's two halves.
 *
 * The digests in the JSON are checked against the BLOB on every read, the way
 * they were checked against the base64url string before, and the bytes are
 * wrapped rather than copied.
 */
function submissionFromRow(
  row: Record<string, unknown>,
): StoredMailSendSubmission {
  if (
    !isExactRecord(row, ["raw_rfc2822", "submission_json"]) ||
    !isBinaryRow(row.raw_rfc2822)
  ) {
    throw unavailable();
  }
  return withMessageBytes(
    submissionJsonFromRow(row),
    bufferOf(row.raw_rfc2822),
  );
}

/** The record and its message, once the digests have agreed on both. */
function withMessageBytes(
  record: SubmissionWithoutMessage,
  raw: Buffer,
): StoredMailSendSubmission {
  if (
    raw.byteLength !== record.message.rawRfc2822Bytes ||
    createHash("sha256").update(raw).digest("hex") !==
      record.message.rawRfc2822Sha256
  ) {
    throw unavailable();
  }
  return Object.freeze({
    ...record,
    message: Object.freeze({ ...record.message, rawRfc2822: raw }),
  });
}

/** A BLOB as SQLite hands it back, wrapped rather than copied. */
function bufferOf(value: Uint8Array): Buffer {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function isBinaryRow(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function smtpStateFromJoinedRow(
  row: Record<string, unknown>,
  accountId: string,
  operationId: string,
): SubmissionRecord {
  if (
    !isExactRecord(row, [
      "format_version",
      "outbox_json",
      "phase",
      "runnable_at",
      "state_json",
      "state_version",
    ]) ||
    typeof row.outbox_json !== "string" ||
    Buffer.byteLength(row.outbox_json) > MAX_SERIALIZED_SUBMISSION_BYTES
  ) {
    throw unavailable();
  }
  const outbox = submissionJsonFromRow({
    submission_json: row.outbox_json,
  });
  assertSmtpOutboxIdentity(accountId, operationId, outbox);
  return smtpStateFromRow(
    {
      state_version: row.state_version,
      format_version: row.format_version,
      phase: row.phase,
      runnable_at: row.runnable_at,
      state_json: row.state_json,
    },
    outbox,
  );
}

function smtpStateFromRow(
  row: Record<string, unknown>,
  outbox: SubmissionWithoutMessage,
): SubmissionRecord {
  if (
    !isExactRecord(row, [
      "format_version",
      "phase",
      "runnable_at",
      "state_json",
      "state_version",
    ]) ||
    row.format_version !== 1 ||
    !Number.isSafeInteger(row.state_version) ||
    (row.state_version as number) < 0 ||
    typeof row.phase !== "string" ||
    (row.runnable_at !== null && !isTimestamp(row.runnable_at)) ||
    typeof row.state_json !== "string" ||
    Buffer.byteLength(row.state_json) > MAX_SERIALIZED_SMTP_STATE_BYTES
  ) {
    throw unavailable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    throw unavailable();
  }
  const state = restoreSubmissionRecord(parsed);
  if (
    state.version !== row.state_version ||
    state.phase !== row.phase ||
    smtpSubmissionRunnableAt(state) !== row.runnable_at
  ) {
    throw unavailable();
  }
  assertSmtpStateMatchesOutbox(state, outbox);
  return state;
}

function createInitialSmtpState(
  outbox: SubmissionWithoutMessage,
): SubmissionRecord {
  if (
    outbox.providerKind !== "imap" ||
    outbox.version !== 0 ||
    outbox.status !== "queued" ||
    outbox.attemptCount !== 0 ||
    outbox.lease !== null ||
    outbox.providerMessageId !== null ||
    outbox.providerThreadId !== null ||
    outbox.lastErrorCode !== null ||
    outbox.nextAttemptAt !== outbox.createdAt ||
    outbox.updatedAt !== outbox.createdAt
  ) {
    throw unavailable();
  }
  const state = createQueuedSubmission({
    operationId: outbox.operationId,
    idempotencyKey: outbox.idempotencyKey,
    accountId: outbox.accountId,
    messageId: outbox.message.messageId,
    envelope: outbox.message.envelope,
    rawMimeSha256: outbox.message.rawRfc2822Sha256,
    rawMimeBytes: outbox.message.rawRfc2822Bytes,
    createdAt: outbox.createdAt,
  });
  assertSmtpStateMatchesOutbox(state, outbox);
  return state;
}

function serializeSmtpState(value: SubmissionRecord): string {
  const serialized = JSON.stringify(restoreSubmissionRecord(value));
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_SMTP_STATE_BYTES) {
    throw unavailable();
  }
  return serialized;
}

function insertSmtpStateRow(
  database: DatabaseSync,
  state: SubmissionRecord,
): void {
  database
    .prepare(
      `INSERT INTO smtp_submission_state(
         operation_id, format_version, state_version, phase, runnable_at, state_json
       ) VALUES (?, 1, ?, ?, ?, ?)`,
    )
    .run(
      state.submission.operationId,
      state.version,
      state.phase,
      smtpSubmissionRunnableAt(state),
      serializeSmtpState(state),
    );
}

function assertSmtpOutboxIdentity(
  accountId: string,
  operationId: string,
  outbox: SubmissionWithoutMessage,
): void {
  if (
    outbox.accountId !== accountId ||
    outbox.operationId !== operationId ||
    outbox.providerKind !== "imap"
  ) {
    throw unavailable();
  }
}

function assertSmtpStateMatchesOutbox(
  state: SubmissionRecord,
  outbox: SubmissionWithoutMessage,
): void {
  const identity = state.submission;
  if (
    outbox.providerKind !== "imap" ||
    identity.operationId !== outbox.operationId ||
    identity.idempotencyKey !== outbox.idempotencyKey ||
    identity.accountId !== outbox.accountId ||
    identity.messageId !== outbox.message.messageId ||
    identity.rawMimeSha256 !== outbox.message.rawRfc2822Sha256 ||
    identity.rawMimeBytes !== outbox.message.rawRfc2822Bytes ||
    identity.createdAt !== outbox.createdAt ||
    JSON.stringify(identity.envelope) !== JSON.stringify(outbox.message.envelope)
  ) {
    throw unavailable();
  }
}

function assertImmutableSmtpState(
  current: SubmissionRecord,
  next: SubmissionRecord,
): void {
  if (
    JSON.stringify(current.submission) !== JSON.stringify(next.submission)
  ) {
    throw unavailable();
  }
}

/**
 * Atomic ownership handoff. An IMAP-provider outbox row and its SMTP
 * submission state are born inside one SQLite transaction, so the operation is
 * SMTP-owned before any worker can observe it. Gmail rows never receive a
 * state row and stay with the legacy outbox worker.
 */
function insertSmtpOwnershipRow(
  database: DatabaseSync,
  submission: StoredMailSendSubmission,
): void {
  if (submission.providerKind !== "imap") return;
  if (submission.status === "queued") {
    insertSmtpStateRow(database, createInitialSmtpState(submission));
    return;
  }
  // An active IMAP row without SMTP ownership would be claimable by nobody and
  // mutable by nobody. Refuse it instead of persisting a stuck record.
  if (isActiveStatus(submission.status)) throw unavailable();
}

const SMTP_ACCEPTED_PHASES: readonly SubmissionPhase[] = Object.freeze([
  "sent_copy_pending",
  "sent_copy_unknown",
  "sent_copy_failed",
  "sent",
]);

function smtpOutboxStatusForState(
  state: SubmissionRecord,
): StoredMailSendSubmission["status"] | null {
  const { phase } = state;
  if (
    SMTP_ACCEPTED_PHASES.includes(phase) &&
    state.smtpAcceptance?.rejectedRecipients.length
  ) {
    return "delivery_unknown";
  }
  if (SMTP_ACCEPTED_PHASES.includes(phase)) return "sent";
  if (phase === "failed") return "failed";
  if (phase === "delivery_unknown" || phase === "partially_sent") {
    return "delivery_unknown";
  }
  return null;
}

function smtpLegacyErrorCode(code: string | null): MailSendErrorCode {
  if (code === "smtp_auth_failed") return "mail_send_account_reauth_required";
  if (code === SMTP_ATTEMPTS_EXHAUSTED_ERROR_CODE) {
    return "mail_send_service_unavailable";
  }
  return "mail_send_request_invalid";
}

/**
 * Projects one outcome-grade SMTP state transition onto the public outbox
 * row. Claim and retry churn returns null and leaves the outbox untouched.
 * Reaching SMTP acceptance mirrors as sent exactly once; a reconciled
 * delivery_unknown may later still resolve to sent.
 */
function smtpOutboxMirror(
  outbox: SubmissionWithoutMessage,
  state: SubmissionRecord,
  now: number,
): SubmissionWithoutMessage | null {
  const status = smtpOutboxStatusForState(state);
  if (status === null || outbox.status === status) return null;
  const allowed =
    outbox.status === "queued" ||
    (outbox.status === "delivery_unknown" && status === "sent");
  if (!allowed) throw unavailable();
  return validateSubmissionWithoutMessage({
    ...outbox,
    version: outbox.version + 1,
    status,
    attemptCount: Math.max(1, state.attemptCount),
    lease: null,
    providerMessageId: null,
    providerThreadId: null,
    lastErrorCode:
      status === "failed"
        ? smtpLegacyErrorCode(state.lastErrorCode)
        : status === "delivery_unknown"
          ? "mail_send_service_unavailable"
          : null,
    nextAttemptAt: null,
    updatedAt: Math.max(outbox.updatedAt, now),
  });
}

function mergeAccountIdentities(
  byAccount: ReadonlyMap<string, MailSmtpSubmissionIdentity[]>,
  limit: number,
): readonly MailSmtpSubmissionIdentity[] {
  const accountIds = [...byAccount.keys()].sort();
  const selected: MailSmtpSubmissionIdentity[] = [];
  while (selected.length < limit) {
    let advanced = false;
    for (const accountId of accountIds) {
      const identity = byAccount.get(accountId)?.shift();
      if (!identity) continue;
      selected.push(identity);
      advanced = true;
      if (selected.length === limit) break;
    }
    if (!advanced) break;
  }
  return Object.freeze(selected);
}

/**
 * The record without its message.
 *
 * `JSON.stringify` of the whole record would make a second copy of the message
 * beside the one the record already holds, which is what the row shape exists
 * to stop, and a Buffer would come out of it as an array of numbers. The
 * message goes to its own column; the digests stay here and are what a read
 * checks the column against.
 */
function serializeSubmission(value: SubmissionWithoutMessage): string {
  const serialized = JSON.stringify({
    ...value,
    // Written field by field, so the one place that decides what a row's JSON
    // holds says it plainly rather than by subtraction.
    message: {
      messageId: value.message.messageId,
      envelope: value.message.envelope,
      providerThreadId: value.message.providerThreadId,
      rawRfc2822Bytes: value.message.rawRfc2822Bytes,
      rawRfc2822Sha256: value.message.rawRfc2822Sha256,
    },
  });
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_SUBMISSION_BYTES) {
    throw unavailable();
  }
  return serialized;
}

/**
 * The bytes the row will hold, refused here rather than by the column.
 *
 * `MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes` is the ceiling on a finished
 * outgoing message, and this is the last place it can be enforced before the
 * insert. The refusal names both figures: a caller told only
 * `mail_send_request_invalid` at the end of a build cannot tell whether a
 * smaller file would go through, which is the failure the 2 MiB literal used
 * to produce.
 */
function assertRawWithinCeiling(raw: Buffer): void {
  if (raw.byteLength > MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes) {
    throw new MailSendError("mail_send_request_invalid", {
      detail:
        `finished message of ${raw.byteLength} bytes exceeds the ` +
        `${MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes} byte outgoing ceiling`,
    });
  }
}

function insertSubmissionRow(
  database: DatabaseSync,
  submission: StoredMailSendSubmission,
  serialized: string,
): void {
  assertRawWithinCeiling(submission.message.rawRfc2822);
  database
    .prepare(
      `INSERT INTO outbox(
         operation_id, account_id, idempotency_key, request_fingerprint,
         version, status, runnable_at, created_at, updated_at, submission_json,
         raw_rfc2822
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      submission.operationId,
      submission.accountId,
      submission.idempotencyKey,
      submission.requestFingerprint,
      submission.version,
      submission.status,
      submissionRunnableAt(submission),
      submission.createdAt,
      submission.updatedAt,
      serialized,
      submission.message.rawRfc2822,
    );
}

function pruneTerminalRows(
  database: DatabaseSync,
  now: number,
  preserveDraftLinks = true,
): void {
  const cutoff = Math.max(0, now - TERMINAL_RETENTION_MS);
  const retainLinkedDraft = preserveDraftLinks
    ? `AND NOT EXISTS (
         SELECT 1 FROM drafts
          WHERE drafts.account_id = outbox.account_id
            AND drafts.send_operation_id = outbox.operation_id
            AND drafts.send_idempotency_key = outbox.idempotency_key
       )
       AND NOT EXISTS (
         SELECT 1
           FROM draft_mutations AS mutation
           JOIN drafts AS draft ON draft.draft_id = mutation.draft_id
          WHERE draft.account_id = outbox.account_id
            AND mutation.kind = 'send'
            AND mutation.operation_id = outbox.operation_id
       )`
    : "";
  database
    .prepare(
      `DELETE FROM outbox
        WHERE status IN (${TERMINAL_STATUSES_SQL}) AND updated_at < ?
          ${retainLinkedDraft}`,
    )
    .run(cutoff);
  database
    .prepare(
      `DELETE FROM outbox
        WHERE operation_id IN (
          SELECT candidate.operation_id
            FROM outbox AS candidate
           WHERE candidate.status IN (${TERMINAL_STATUSES_SQL})
             ${
               preserveDraftLinks
                 ? `AND NOT EXISTS (
                      SELECT 1 FROM drafts
                       WHERE drafts.account_id = candidate.account_id
                         AND drafts.send_operation_id = candidate.operation_id
                         AND drafts.send_idempotency_key = candidate.idempotency_key
                    )
                    AND NOT EXISTS (
                      SELECT 1
                        FROM draft_mutations AS mutation
                        JOIN drafts AS draft ON draft.draft_id = mutation.draft_id
                       WHERE draft.account_id = candidate.account_id
                         AND mutation.kind = 'send'
                         AND mutation.operation_id = candidate.operation_id
                    )`
                 : ""
             }
           ORDER BY candidate.updated_at DESC, candidate.operation_id DESC
           LIMIT -1 OFFSET ?
        )`,
    )
    .run(MAX_TERMINAL_ROWS_PER_ACCOUNT);
}

function legacySubmissionFromRow(
  row: Record<string, unknown>,
): StoredMailSendSubmission {
  if (
    !isExactRecord(row, [
      "account_id",
      "idempotency_key",
      "operation_id",
      "request_fingerprint",
      "submission_json",
      "version",
    ])
  ) {
    throw unavailable();
  }
  const submission = submissionFromLegacyJson(row);
  if (
    row.operation_id !== submission.operationId ||
    row.account_id !== submission.accountId ||
    row.idempotency_key !== submission.idempotencyKey ||
    row.request_fingerprint !== submission.requestFingerprint ||
    row.version !== submission.version
  ) {
    throw unavailable();
  }
  return submission;
}

/**
 * A record out of a row whose JSON still carries the message.
 *
 * This is the only reader of `rawRfc2822Base64Url` left, and it exists for the
 * two migrations: the base64url string in the stored JSON becomes the Buffer
 * the record now carries, once, and the digests beside it are checked against
 * those bytes by `validateSubmission` exactly as before. The size bound is the
 * one the old rows were written under, four characters per three bytes of the
 * outgoing ceiling plus a megabyte for the rest of the record.
 */
function submissionFromLegacyJson(
  row: Record<string, unknown>,
): StoredMailSendSubmission {
  if (
    typeof row.submission_json !== "string" ||
    Buffer.byteLength(row.submission_json) >
      Math.ceil(MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes / 3) * 4 +
        1024 * 1024
  ) {
    throw unavailable();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.submission_json);
  } catch {
    throw unavailable();
  }
  if (
    !isExactRecord((parsed as { message?: unknown })?.message, [
      "envelope",
      "messageId",
      "providerThreadId",
      "rawRfc2822Base64Url",
      "rawRfc2822Bytes",
      "rawRfc2822Sha256",
    ])
  ) {
    throw unavailable();
  }
  const stored = parsed as { message: Record<string, unknown> };
  const encoded = stored.message.rawRfc2822Base64Url;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw unavailable();
  }
  const message = { ...stored.message };
  delete message.rawRfc2822Base64Url;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.toString("base64url") !== encoded) throw unavailable();
  return validateSubmission({
    ...stored,
    message: { ...message, rawRfc2822: raw },
  });
}

function runnableMetadataFromRow(
  accountId: string,
  row: Record<string, unknown>,
): RunnableMetadata {
  if (
    !isExactRecord(row, ["created_at", "operation_id", "runnable_at"]) ||
    typeof row.operation_id !== "string" ||
    !SAFE_OPERATION_ID.test(row.operation_id) ||
    !isTimestamp(row.runnable_at) ||
    !isTimestamp(row.created_at)
  ) {
    throw unavailable();
  }
  return Object.freeze({
    accountId,
    operationId: row.operation_id,
    runnableAt: row.runnable_at,
    createdAt: row.created_at,
  });
}

function aggregateTimestamp(
  row: Record<string, unknown> | undefined,
  field: string,
): number | null {
  if (!row || !isExactRecord(row, [field])) throw unavailable();
  const value = row[field];
  if (value === null) return null;
  if (!isTimestamp(value)) throw unavailable();
  return value;
}

function aggregateCount(
  row: Record<string, unknown> | undefined,
  field: string,
): number {
  if (!row || !isExactRecord(row, [field])) throw unavailable();
  const value = row[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw unavailable();
  }
  return value as number;
}

function safeFutureTimestamp(now: number, delayMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + delayMs);
}

/**
 * The record the row's JSON holds, validated: everything but the message bytes.
 *
 * `validateSubmission` is this plus the bytes. Split because most of what the
 * store does with a row — a compare-and-swap, the SMTP state row's identity,
 * the mirror it writes back — needs the digests and not the message, and
 * reading a BLOB to compare two strings is the second resident copy of a
 * message that the delivery turn cannot afford.
 */
function validateSubmissionWithoutMessage(
  value: unknown,
): SubmissionWithoutMessage {
  if (
    isExactRecord(value, [
      "accountId",
      "attemptCount",
      "createdAt",
      "idempotencyKey",
      "lastErrorCode",
      "lease",
      "message",
      "operationId",
      "providerKind",
      "providerMessageId",
      "providerThreadId",
      "requestFingerprint",
      "status",
      "updatedAt",
      "version",
    ])
  ) {
    value = {
      ...value,
      nextAttemptAt:
        value.status === "queued" && isTimestamp(value.updatedAt)
          ? value.updatedAt
          : null,
    };
  }
  if (
    !isExactRecord(value, [
      "accountId",
      "attemptCount",
      "createdAt",
      "idempotencyKey",
      "lastErrorCode",
      "lease",
      "message",
      "nextAttemptAt",
      "operationId",
      "providerKind",
      "providerMessageId",
      "providerThreadId",
      "requestFingerprint",
      "status",
      "updatedAt",
      "version",
    ]) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    typeof value.operationId !== "string" ||
    !SAFE_OPERATION_ID.test(value.operationId) ||
    typeof value.idempotencyKey !== "string" ||
    !SAFE_IDEMPOTENCY_KEY.test(value.idempotencyKey) ||
    typeof value.requestFingerprint !== "string" ||
    !SAFE_FINGERPRINT.test(value.requestFingerprint) ||
    typeof value.accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(value.accountId) ||
    (value.providerKind !== "gmail" && value.providerKind !== "imap") ||
    !["queued", "sending", "sent", "failed", "delivery_unknown"].includes(
      String(value.status),
    ) ||
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.updatedAt as number) < (value.createdAt as number) ||
    !isOptionalProviderId(value.providerMessageId) ||
    !isOptionalProviderId(value.providerThreadId) ||
    !isOptionalErrorCode(value.lastErrorCode) ||
    !isOptionalTimestamp(value.nextAttemptAt)
  ) {
    throw unavailable();
  }
  const lease = validateLease(value.lease);
  const message = validateMessageWithoutBytes(value.message);
  const status = value.status as StoredMailSendSubmission["status"];
  const attemptCount = value.attemptCount as number;
  if (
    (status === "sending") !== (lease !== null) ||
    (status !== "queued" && attemptCount < 1) ||
    // First-party SMTP acceptance has no provider-issued resource ids; the
    // authoritative acceptance record lives in smtp_submission_state.
    (status === "sent" &&
      (value.providerKind === "imap"
        ? value.providerMessageId !== null ||
          value.providerThreadId !== null ||
          value.lastErrorCode !== null
        : value.providerMessageId === null ||
          value.providerThreadId === null ||
          value.lastErrorCode !== null)) ||
    (status !== "sent" &&
      (value.providerMessageId !== null || value.providerThreadId !== null)) ||
    (status === "failed" && value.lastErrorCode === null) ||
    (status === "delivery_unknown" &&
      value.lastErrorCode !== "mail_send_service_unavailable") ||
    ((status === "queued") !== (value.nextAttemptAt !== null))
  ) {
    throw unavailable();
  }
  return Object.freeze({
    version: value.version as number,
    operationId: value.operationId,
    idempotencyKey: value.idempotencyKey,
    requestFingerprint: value.requestFingerprint,
    accountId: value.accountId,
    providerKind: value.providerKind,
    status,
    attemptCount,
    lease,
    message,
    providerMessageId: value.providerMessageId,
    providerThreadId: value.providerThreadId,
    lastErrorCode: value.lastErrorCode,
    nextAttemptAt: value.nextAttemptAt,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  });
}

function validateMessageWithoutBytes(
  value: unknown,
): SubmissionWithoutMessage["message"] {
  if (
    !isExactRecord(value, [
      "envelope",
      "messageId",
      "providerThreadId",
      "rawRfc2822Bytes",
      "rawRfc2822Sha256",
    ]) ||
    typeof value.messageId !== "string" ||
    Buffer.byteLength(value.messageId) > 998 ||
    !SAFE_MESSAGE_ID.test(value.messageId) ||
    !isOptionalProviderId(value.providerThreadId) ||
    !Number.isSafeInteger(value.rawRfc2822Bytes) ||
    (value.rawRfc2822Bytes as number) < 1 ||
    // The structural bound, not the outgoing one. What a send may write is
    // `outgoingRawMessageBytes` and `assertRawWithinCeiling` refuses it by
    // name before the insert; a row already on disk is read back whatever that
    // ceiling says today, so lowering the cap never strands a queued message
    // the service still owes the recipient.
    (value.rawRfc2822Bytes as number) > MAIL_RESOURCE_LIMITS.rawMessageBytes ||
    typeof value.rawRfc2822Sha256 !== "string" ||
    !SAFE_FINGERPRINT.test(value.rawRfc2822Sha256)
  ) {
    throw unavailable();
  }
  const envelope = validateEnvelope(value.envelope);
  return Object.freeze({
    messageId: value.messageId,
    envelope,
    providerThreadId: value.providerThreadId,
    rawRfc2822Bytes: value.rawRfc2822Bytes as number,
    rawRfc2822Sha256: value.rawRfc2822Sha256,
  });
}

/**
 * The whole record, bytes included.
 *
 * The bytes are pulled off before the rest is validated, so one validator
 * decides the record's shape whether it came off a row or out of a build, and
 * `withMessageBytes` is the one place that decides a message matches its
 * digests. SQLite hands a BLOB back as a Uint8Array and the record says Buffer:
 * wrapped rather than copied, so naming the type costs nothing at the cap.
 */
function validateSubmission(value: unknown): StoredMailSendSubmission {
  const message = (value as { readonly message?: unknown })?.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw unavailable();
  }
  const raw = (message as { readonly rawRfc2822?: unknown }).rawRfc2822;
  if (!isBinaryRow(raw)) throw unavailable();
  const withoutBytes = { ...(message as Record<string, unknown>) };
  delete withoutBytes.rawRfc2822;
  return withMessageBytes(
    validateSubmissionWithoutMessage({
      ...(value as Record<string, unknown>),
      message: withoutBytes,
    }),
    bufferOf(raw),
  );
}

function validateEnvelope(value: unknown): StoredMailSendMessage["envelope"] {
  if (!isExactRecord(value, ["bcc", "cc", "from", "to"])) {
    throw unavailable();
  }
  const from = validateAddress(value.from);
  const to = validateAddresses(value.to);
  const cc = validateAddresses(value.cc);
  const bcc = validateAddresses(value.bcc);
  const recipients = [...to, ...cc, ...bcc];
  if (
    recipients.length < 1 ||
    recipients.length > MAIL_RESOURCE_LIMITS.addressesPerMessage ||
    new Set(recipients.map((address) => address.toLowerCase())).size !==
      recipients.length
  ) {
    throw unavailable();
  }
  return Object.freeze({ from, to, cc, bcc });
}

function validateAddresses(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAIL_RESOURCE_LIMITS.addressesPerMessage) {
    throw unavailable();
  }
  return Object.freeze(value.map(validateAddress));
}

function validateAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) < 1 ||
    Buffer.byteLength(value) > 254 ||
    /[\r\n]/.test(value) ||
    !/^[^<>\s@]+@[^<>\s@]+$/.test(value)
  ) {
    throw unavailable();
  }
  return value;
}

function validateLease(
  value: unknown,
): StoredMailSendSubmission["lease"] {
  if (value === null) return null;
  if (
    !isExactRecord(value, ["attemptId", "deliveryRisk", "expiresAt"]) ||
    typeof value.attemptId !== "string" ||
    !SAFE_ATTEMPT_ID.test(value.attemptId) ||
    !isTimestamp(value.expiresAt) ||
    typeof value.deliveryRisk !== "boolean"
  ) {
    throw unavailable();
  }
  return Object.freeze({
    attemptId: value.attemptId,
    expiresAt: value.expiresAt as number,
    deliveryRisk: value.deliveryRisk,
  });
}

function assertImmutableIdentity(
  current: SubmissionWithoutMessage,
  next: SubmissionWithoutMessage,
): void {
  if (
    current.operationId !== next.operationId ||
    current.accountId !== next.accountId ||
    current.providerKind !== next.providerKind ||
    current.idempotencyKey !== next.idempotencyKey ||
    current.requestFingerprint !== next.requestFingerprint ||
    current.createdAt !== next.createdAt ||
    !equalMessageIdentity(current.message, next.message)
  ) {
    throw unavailable();
  }
}

/**
 * Whether two records carry the same message.
 *
 * Field by field rather than `JSON.stringify` of both, which is what this was:
 * the message is a Buffer now, and stringifying it would build an array of
 * every byte twice on every state transition. The digests are the message's
 * identity, and `validateMessage` has already checked each side's bytes
 * against its own digests.
 */
function equalMessageIdentity(
  current: SubmissionWithoutMessage["message"],
  next: SubmissionWithoutMessage["message"],
): boolean {
  return (
    current.messageId === next.messageId &&
    current.providerThreadId === next.providerThreadId &&
    current.rawRfc2822Bytes === next.rawRfc2822Bytes &&
    current.rawRfc2822Sha256 === next.rawRfc2822Sha256 &&
    equalEnvelope(current.envelope, next.envelope)
  );
}

async function closeDatabase(
  database: DatabaseSync,
  databasePath: string,
): Promise<void> {
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
    await ensureSqliteFilesPrivate(databasePath);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directory);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(directory);
  } catch (error) {
    throw storeError(error);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  if (
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0 ||
    (uid >= 0 && metadata.uid !== uid)
  ) {
    throw unavailable();
  }
}

async function assertContainedPath(root: string, child: string): Promise<void> {
  const [resolvedRoot, resolvedChild] = await Promise.all([
    realpath(root),
    realpath(child),
  ]);
  if (!resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw unavailable();
  }
}

async function ensurePrivateDatabaseFile(filePath: string): Promise<void> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw storeError(error);
  } finally {
    await handle?.close();
  }
  await assertPrivateDatabaseFile(filePath);
}

async function assertPrivateDatabaseFile(filePath: string): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (uid >= 0 && metadata.uid !== uid)
    ) {
      throw unavailable();
    }
  } catch (error) {
    throw storeError(error);
  } finally {
    await handle?.close();
  }
}

async function ensureSqliteFilesPrivate(databasePath: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    let handle;
    try {
      handle = await open(
        `${databasePath}${suffix}`,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      await handle.chmod(0o600);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw storeError(error);
    } finally {
      await handle?.close();
    }
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw storeError(error);
  }
}

function requireAbsolutePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw unavailable();
  }
  return value;
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) throw unavailable();
  return value;
}

function isOptionalProviderId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && SAFE_PROVIDER_ID.test(value));
}

function isOptionalErrorCode(value: unknown): value is MailSendErrorCode | null {
  return (
    value === null ||
    [
      "mail_send_request_invalid",
      "mail_send_account_not_found",
      "mail_send_account_reauth_required",
      "mail_send_reply_target_not_found",
      "mail_send_idempotency_conflict",
      "mail_send_operation_not_found",
      "mail_send_rate_limited",
      "mail_send_service_unavailable",
    ].includes(String(value))
  );
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function submissionRunnableAt(value: SubmissionWithoutMessage): number | null {
  if (value.status === "queued") return value.nextAttemptAt;
  if (value.status === "sending") return value.lease?.expiresAt ?? null;
  return null;
}

function compareRunnableMetadata(
  left: RunnableMetadata,
  right: RunnableMetadata,
): number {
  return (
    left.runnableAt - right.runnableAt ||
    left.createdAt - right.createdAt ||
    left.operationId.localeCompare(right.operationId)
  );
}

function isActiveStatus(
  status: StoredMailSendSubmission["status"],
): boolean {
  return status === "queued" || status === "sending";
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
}

function storeError(error: unknown): MailSendError {
  return error instanceof MailSendError ? error : unavailable();
}

/**
 * Runs one step that sits past a COMMIT and drops whatever it throws.
 *
 * The retention mark and the database close are bookkeeping: by the time they
 * run the row is on disk, and a caller told `mail_send_service_unavailable`
 * reads it as "nothing happened, send it again" and sends a second copy. The
 * failure is logged under the account it happened on and the call returns the
 * result the transaction earned.
 */
function afterCommit(accountId: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    logAfterCommit(accountId, error);
  }
}

function logAfterCommit(accountId: string, error: unknown): void {
  writeMailLogRecord({
    event: "mail_outbox_after_commit_failed",
    accountId,
    errorCode:
      error instanceof MailSendError ? error.code : "mail_send_service_unavailable",
  });
}

function draftStoreError(error: unknown): MailDraftError {
  return error instanceof MailDraftError ? error : draftUnavailable();
}

function draftUnavailable(): MailDraftError {
  return new MailDraftError("mail_draft_service_unavailable");
}

function unavailable(): MailSendError {
  return new MailSendError("mail_send_service_unavailable");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
