import type { SubmissionRecord } from "../send-state";

export interface MailSmtpSubmissionStateInitializeResult {
  readonly created: boolean;
  readonly state: SubmissionRecord;
}

/**
 * Persistence boundary for the first-party SMTP/Sent-copy worker. The Gmail
 * sender does not call this interface.
 */
export interface MailSmtpSubmissionStateStore {
  initializeSmtpSubmissionState(
    accountId: string,
    operationId: string,
  ): Promise<MailSmtpSubmissionStateInitializeResult>;
  readSmtpSubmissionState(
    accountId: string,
    operationId: string,
  ): Promise<SubmissionRecord | null>;
  compareAndSwapSmtpSubmissionState(
    accountId: string,
    operationId: string,
    expectedVersion: number,
    next: SubmissionRecord,
  ): Promise<boolean>;
}

/** Identity of one SMTP-owned operation; payload bytes stay in the store. */
export interface MailSmtpSubmissionIdentity {
  readonly accountId: string;
  readonly operationId: string;
}

/**
 * Complete store surface required by the SMTP submission worker. Ownership is
 * decided once, atomically, when an IMAP-provider outbox row is inserted: the
 * same SQLite transaction creates its smtp_submission_state row, and the
 * legacy outbox compare-and-swap refuses every IMAP-provider row afterwards.
 */
export interface MailSmtpSubmissionWorkStore
  extends MailSmtpSubmissionStateStore {
  /** Runnable SMTP-owned operations ordered by runnable time, fair by account. */
  listRunnableSmtpSubmissions(
    now: number,
    limit: number,
  ): Promise<readonly MailSmtpSubmissionIdentity[]>;
  /** Operations whose ambiguity only reconciliation can resolve. */
  listReconcilableSmtpSubmissions(
    limit: number,
  ): Promise<readonly MailSmtpSubmissionIdentity[]>;
  /** Earliest runnable time across every SMTP-owned operation. */
  nextRunnableSmtpAt(): Promise<number | null>;
  /**
   * Integrity-checked raw RFC 2822 bytes for one SMTP-owned operation. The
   * caller owns the buffer and must wipe it with fill(0) after use.
   */
  readSmtpSubmissionRaw(
    accountId: string,
    operationId: string,
  ): Promise<Buffer | null>;
}
