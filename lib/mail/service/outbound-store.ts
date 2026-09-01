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
import { MAIL_RESOURCE_LIMITS } from "../security";
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
  type StoredMailSendMessage,
  type StoredMailSendSubmission,
} from "./outbound";
import { buildOutboundRfc2822 } from "./outbound-message";
import {
  type MailSmtpSubmissionIdentity,
  type MailSmtpSubmissionStateInitializeResult,
  type MailSmtpSubmissionWorkStore,
} from "./smtp-state-store";

const SCHEMA_VERSION = 2;
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
const MAX_SERIALIZED_SUBMISSION_BYTES = 2 * 1024 * 1024;
const MAX_SERIALIZED_SMTP_STATE_BYTES = 128 * 1024;
const MAX_LEGACY_ROWS_PER_ACCOUNT = 10_000;
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

const OUTBOX_V2_SQL = `
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

  ${OUTBOX_V2_SQL}
`;

interface RunnableMetadata {
  readonly accountId: string;
  readonly operationId: string;
  readonly runnableAt: number;
  readonly createdAt: number;
}

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
            .prepare("SELECT submission_json FROM outbox WHERE operation_id = ?")
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
          const row = database
            .prepare("SELECT submission_json FROM outbox WHERE operation_id = ?")
            .get(operationId);
          if (row === undefined) {
            database.exec("ROLLBACK");
            return false;
          }
          const current = submissionFromRow(row);
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
            this.markRetentionSweep(next.accountId, prunedAt);
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
          const outbox = submissionFromRow(outboxRow);
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
          const outbox = submissionFromRow({
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
          if (prunedAt !== null) this.markRetentionSweep(accountId, prunedAt);
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
            `SELECT outbox.submission_json
               FROM smtp_submission_state AS state
               JOIN outbox ON outbox.operation_id = state.operation_id
              WHERE outbox.account_id = ? AND state.operation_id = ?`,
          )
          .get(accountId, operationId);
        if (row === undefined) return null;
        if (
          !isExactRecord(row, ["submission_json"]) ||
          typeof row.submission_json !== "string"
        ) {
          throw unavailable();
        }
        const outbox = submissionFromRow(row);
        assertSmtpOutboxIdentity(accountId, operationId, outbox);
        const raw = Buffer.from(
          outbox.message.rawRfc2822Base64Url,
          "base64url",
        );
        if (
          raw.byteLength !== outbox.message.rawRfc2822Bytes ||
          createHash("sha256").update(raw).digest("hex") !==
            outbox.message.rawRfc2822Sha256
        ) {
          raw.fill(0);
          throw unavailable();
        }
        return raw;
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

  async listRunnable(
    now: number,
    limit: number,
  ): Promise<readonly StoredMailSendSubmission[]> {
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
    const submissions = new Map<string, StoredMailSendSubmission>();
    for (const accountId of accountIds) {
      const accountSelection = selected.filter(
        (value) => value.accountId === accountId,
      );
      if (accountSelection.length === 0) continue;
      for (const submission of await this.readSelectedSubmissions(
        accountId,
        accountSelection,
      )) {
        if (submissions.has(submission.operationId)) throw unavailable();
        submissions.set(submission.operationId, submission);
      }
    }
    return Object.freeze(
      selected.map((metadata) => {
        const submission = submissions.get(metadata.operationId);
        if (!submission) throw unavailable();
        return submission;
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
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const prunedAt = this.readNow();
          pruneTerminalRows(database, prunedAt);
          const existing = this.readExistingSubmission(database, submission);
          database.exec("COMMIT");
          this.markRetentionSweep(submission.accountId, prunedAt);
          return existing === null
            ? null
            : Object.freeze({ created: false, submission: existing });
        } catch (error) {
          if (database.isTransaction) database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        await closeDatabase(database, this.databasePath(submission.accountId));
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
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
          const prunedAt = this.readNow();
          pruneTerminalRows(database, prunedAt);
          const existing = this.readExistingSubmission(database, submission);
          if (existing !== null) {
            database.exec("COMMIT");
            this.markRetentionSweep(submission.accountId, prunedAt);
            return Object.freeze({ created: false, submission: existing });
          }
          insertSubmissionRow(database, submission, serialized);
          insertSmtpOwnershipRow(database, submission);
          if (!isActiveStatus(submission.status)) {
            pruneTerminalRows(database, prunedAt);
          }
          database.exec("COMMIT");
          this.markRetentionSweep(submission.accountId, prunedAt);
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
          return Object.freeze({ created: false, submission: raced });
        }
      } finally {
        await closeDatabase(database, this.databasePath(submission.accountId));
      }
    });
  }

  private readExistingSubmission(
    database: DatabaseSync,
    submission: StoredMailSendSubmission,
  ): StoredMailSendSubmission | null {
    const existingOperation = database
      .prepare("SELECT submission_json FROM outbox WHERE operation_id = ?")
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
        this.markRetentionSweep(accountId, now);
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

  private async readSelectedSubmissions(
    accountId: string,
    selected: readonly RunnableMetadata[],
  ): Promise<readonly StoredMailSendSubmission[]> {
    return this.runAccount(accountId, async () => {
      const database = await this.openAccountDatabase(accountId, false);
      if (!database) throw unavailable();
      try {
        const placeholders = selected.map(() => "?").join(", ");
        const rows = database
          .prepare(
            `SELECT operation_id, runnable_at, created_at, submission_json
               FROM outbox
              WHERE operation_id IN (${placeholders})`,
          )
          .all(...selected.map((value) => value.operationId));
        if (rows.length !== selected.length) throw unavailable();
        const expected = new Map(
          selected.map((value) => [value.operationId, value]),
        );
        return Object.freeze(
          rows.map((row) => selectedSubmissionFromRow(accountId, expected, row)),
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
        `SELECT submission_json FROM outbox
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
  } else if (version === 1) {
    assertDatabaseIdentity(
      database,
      accountId,
      true,
      options.onIntegrityCheck,
    );
    integrityVerified = true;
    migrateSchemaV1(database, options.now);
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

function migrateSchemaV1(database: DatabaseSync, now: number): void {
  const count = aggregateCount(
    database.prepare("SELECT COUNT(*) AS row_count FROM outbox").get(),
    "row_count",
  );
  if (count > MAX_LEGACY_ROWS_PER_ACCOUNT) throw unavailable();

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("ALTER TABLE outbox RENAME TO outbox_v1");
    database.exec(OUTBOX_V2_SQL);
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
      const submission = legacySubmissionFromRow(row);
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
    });
    expectedRaw = built.rawRfc2822;
    return (
      equalEnvelope(built.envelope, submission.message.envelope) &&
      expectedRaw.byteLength === submission.message.rawRfc2822Bytes &&
      expectedRaw.toString("base64url") ===
        submission.message.rawRfc2822Base64Url &&
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

function submissionFromRow(
  row: Record<string, unknown>,
): StoredMailSendSubmission {
  if (
    !isExactRecord(row, ["submission_json"]) ||
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
  return validateSubmission(parsed);
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
  const outbox = submissionFromRow({ submission_json: row.outbox_json });
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
  outbox: StoredMailSendSubmission,
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
  outbox: StoredMailSendSubmission,
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
  outbox: StoredMailSendSubmission,
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
  outbox: StoredMailSendSubmission,
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
  outbox: StoredMailSendSubmission,
  state: SubmissionRecord,
  now: number,
): StoredMailSendSubmission | null {
  const status = smtpOutboxStatusForState(state);
  if (status === null || outbox.status === status) return null;
  const allowed =
    outbox.status === "queued" ||
    (outbox.status === "delivery_unknown" && status === "sent");
  if (!allowed) throw unavailable();
  return validateSubmission({
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

function serializeSubmission(value: StoredMailSendSubmission): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_SERIALIZED_SUBMISSION_BYTES) {
    throw unavailable();
  }
  return serialized;
}

function insertSubmissionRow(
  database: DatabaseSync,
  submission: StoredMailSendSubmission,
  serialized: string,
): void {
  database
    .prepare(
      `INSERT INTO outbox(
         operation_id, account_id, idempotency_key, request_fingerprint,
         version, status, runnable_at, created_at, updated_at, submission_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const submission = submissionFromRow({
    submission_json: row.submission_json,
  });
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

function selectedSubmissionFromRow(
  accountId: string,
  expected: ReadonlyMap<string, RunnableMetadata>,
  row: Record<string, unknown>,
): StoredMailSendSubmission {
  if (
    !isExactRecord(row, [
      "created_at",
      "operation_id",
      "runnable_at",
      "submission_json",
    ])
  ) {
    throw unavailable();
  }
  const metadata = runnableMetadataFromRow(accountId, {
    created_at: row.created_at,
    operation_id: row.operation_id,
    runnable_at: row.runnable_at,
  });
  const selected = expected.get(metadata.operationId);
  const submission = submissionFromRow({
    submission_json: row.submission_json,
  });
  if (
    !selected ||
    selected.accountId !== accountId ||
    selected.runnableAt !== metadata.runnableAt ||
    selected.createdAt !== metadata.createdAt ||
    submission.accountId !== accountId ||
    submission.operationId !== metadata.operationId ||
    submissionRunnableAt(submission) !== metadata.runnableAt ||
    submission.createdAt !== metadata.createdAt
  ) {
    throw unavailable();
  }
  return submission;
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

function validateSubmission(value: unknown): StoredMailSendSubmission {
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
  const message = validateMessage(value.message);
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

function validateMessage(value: unknown): StoredMailSendMessage {
  if (
    !isExactRecord(value, [
      "envelope",
      "messageId",
      "providerThreadId",
      "rawRfc2822Base64Url",
      "rawRfc2822Bytes",
      "rawRfc2822Sha256",
    ]) ||
    typeof value.messageId !== "string" ||
    Buffer.byteLength(value.messageId) > 998 ||
    !SAFE_MESSAGE_ID.test(value.messageId) ||
    !isOptionalProviderId(value.providerThreadId) ||
    typeof value.rawRfc2822Base64Url !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.rawRfc2822Base64Url) ||
    !Number.isSafeInteger(value.rawRfc2822Bytes) ||
    (value.rawRfc2822Bytes as number) < 1 ||
    (value.rawRfc2822Bytes as number) >
      MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes ||
    typeof value.rawRfc2822Sha256 !== "string" ||
    !SAFE_FINGERPRINT.test(value.rawRfc2822Sha256)
  ) {
    throw unavailable();
  }
  const envelope = validateEnvelope(value.envelope);
  const raw = Buffer.from(value.rawRfc2822Base64Url, "base64url");
  try {
    if (
      raw.byteLength !== value.rawRfc2822Bytes ||
      raw.toString("base64url") !== value.rawRfc2822Base64Url ||
      createHash("sha256").update(raw).digest("hex") !==
        value.rawRfc2822Sha256
    ) {
      throw unavailable();
    }
  } finally {
    raw.fill(0);
  }
  return Object.freeze({
    messageId: value.messageId,
    envelope,
    providerThreadId: value.providerThreadId,
    rawRfc2822Base64Url: value.rawRfc2822Base64Url,
    rawRfc2822Bytes: value.rawRfc2822Bytes as number,
    rawRfc2822Sha256: value.rawRfc2822Sha256,
  });
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
  current: StoredMailSendSubmission,
  next: StoredMailSendSubmission,
): void {
  if (
    current.operationId !== next.operationId ||
    current.accountId !== next.accountId ||
    current.providerKind !== next.providerKind ||
    current.idempotencyKey !== next.idempotencyKey ||
    current.requestFingerprint !== next.requestFingerprint ||
    current.createdAt !== next.createdAt ||
    JSON.stringify(current.message) !== JSON.stringify(next.message)
  ) {
    throw unavailable();
  }
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

function submissionRunnableAt(value: StoredMailSendSubmission): number | null {
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
