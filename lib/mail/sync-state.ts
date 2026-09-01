export type MailboxSyncPhase = "idle" | "syncing" | "rebuilding" | "backoff";

export interface MailboxSyncCursor {
  readonly generation: number;
  readonly uidValidity: string;
  readonly highestUid: number;
  readonly highestModSeq: string | null;
}

export interface MailboxSyncLease {
  readonly attemptId: string;
  readonly startedAt: number;
  readonly expiresAt: number;
  /** Set only after this attempt has selected the mailbox and observed UIDVALIDITY. */
  readonly observedUidValidity: string | null;
}

export interface MailboxSyncState {
  readonly version: number;
  readonly phase: MailboxSyncPhase;
  readonly active: MailboxSyncCursor | null;
  readonly resume: MailboxSyncCursor | null;
  readonly lease: MailboxSyncLease | null;
  readonly failureCount: number;
  readonly retryAt: number | null;
  readonly lastErrorCode: string | null;
}

const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 30 * 60_000;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_MODSEQ = BigInt("9223372036854775807");

export function createMailboxSyncState(): MailboxSyncState {
  return freezeState({
    version: 0,
    phase: "idle",
    active: null,
    resume: null,
    lease: null,
    failureCount: 0,
    retryAt: null,
    lastErrorCode: null,
  });
}

export function beginMailboxSync(
  state: MailboxSyncState,
  input: { readonly attemptId: string; readonly now: number; readonly leaseMs: number },
): MailboxSyncState {
  validateState(state);
  assertSafeIdentifier(input.attemptId, "sync attempt id");
  assertTimestamp(input.now, "sync start time");
  assertLeaseMs(input.leaseMs);
  const expiresAt = input.now + input.leaseMs;
  assertTimestamp(expiresAt, "sync lease expiry time");

  if (state.phase === "syncing" || state.phase === "rebuilding") {
    throw new Error("mailbox sync already has an active attempt");
  }
  if (state.phase === "backoff" && state.retryAt !== null && input.now < state.retryAt) {
    throw new Error("mailbox sync is still in backoff");
  }

  return freezeState({
    ...state,
    version: state.version + 1,
    phase: isRebuild(state.active, state.resume) ? "rebuilding" : "syncing",
    lease: {
      attemptId: input.attemptId,
      startedAt: input.now,
      expiresAt,
      observedUidValidity: null,
    },
    retryAt: null,
    lastErrorCode: null,
  });
}

export function observeMailboxIdentity(
  state: MailboxSyncState,
  input: { readonly attemptId: string; readonly now: number; readonly uidValidity: string },
): MailboxSyncState {
  const lease = requireAttempt(state, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "mailbox identity observation time");
  const uidValidity = validateUidValidity(input.uidValidity);
  let resume = state.resume;

  if (resume?.uidValidity !== uidValidity) {
    if (state.active?.uidValidity === uidValidity) {
      resume = { ...state.active };
    } else {
      const generation = Math.max(state.active?.generation ?? 0, resume?.generation ?? 0) + 1;
      resume = {
        generation,
        uidValidity,
        highestUid: 0,
        highestModSeq: null,
      };
    }
  }

  return freezeState({
    ...state,
    version: state.version + 1,
    phase: isRebuild(state.active, resume) ? "rebuilding" : "syncing",
    resume,
    lease: {
      ...lease,
      observedUidValidity: uidValidity,
    },
  });
}

export function advanceMailboxSync(
  state: MailboxSyncState,
  input: {
    readonly attemptId: string;
    readonly now: number;
    readonly uidValidity: string;
    readonly highestUid: number;
    readonly highestModSeq: string | null;
  },
): MailboxSyncState {
  const lease = requireAttempt(state, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "mailbox sync advance time");
  const uidValidity = validateUidValidity(input.uidValidity);
  const resume = state.resume;
  if (!resume) throw new Error("mailbox identity must be observed before advancing sync");
  if (lease.observedUidValidity !== uidValidity) {
    throw new Error("mailbox identity must be observed by the active sync attempt");
  }
  if (resume.uidValidity !== uidValidity) {
    throw new Error("mailbox UIDVALIDITY does not match the staged sync generation");
  }

  assertUid(input.highestUid, true);
  if (input.highestUid < resume.highestUid) {
    throw new Error("mailbox highest UID cannot move backwards");
  }
  const highestModSeq = validateModSeq(input.highestModSeq);
  if (resume.highestModSeq !== null) {
    if (highestModSeq === null) {
      throw new Error("mailbox highest MODSEQ cannot disappear within a generation");
    }
    if (BigInt(highestModSeq) < BigInt(resume.highestModSeq)) {
      throw new Error("mailbox highest MODSEQ cannot move backwards");
    }
  }

  return freezeState({
    ...state,
    version: state.version + 1,
    resume: {
      ...resume,
      highestUid: input.highestUid,
      highestModSeq,
    },
  });
}

export function completeMailboxSync(
  state: MailboxSyncState,
  input: { readonly attemptId: string; readonly now: number },
): MailboxSyncState {
  const lease = requireAttempt(state, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "sync completion time");
  if (!state.resume) throw new Error("mailbox sync cannot complete before observing identity");
  if (lease.observedUidValidity !== state.resume.uidValidity) {
    throw new Error("mailbox sync cannot complete without observing identity in this attempt");
  }

  return freezeState({
    ...state,
    version: state.version + 1,
    phase: "idle",
    active: { ...state.resume },
    resume: null,
    lease: null,
    failureCount: 0,
    retryAt: null,
    lastErrorCode: null,
  });
}

export function failMailboxSync(
  state: MailboxSyncState,
  input: { readonly attemptId: string; readonly now: number; readonly errorCode: string },
): MailboxSyncState {
  const lease = requireAttempt(state, input.attemptId);
  assertTimestampWithinLease(input.now, lease, "sync failure time");
  assertErrorCode(input.errorCode);
  return transitionToBackoff(state, input.now, input.errorCode);
}

export function recoverExpiredMailboxSync(
  state: MailboxSyncState,
  input: { readonly now: number },
): MailboxSyncState {
  validateState(state);
  assertTimestamp(input.now, "sync recovery time");
  if (!state.lease || (state.phase !== "syncing" && state.phase !== "rebuilding")) {
    throw new Error("mailbox sync has no active lease to recover");
  }
  if (input.now < state.lease.expiresAt) {
    throw new Error("mailbox sync lease has not expired");
  }
  return transitionToBackoff(state, input.now, "worker_lease_expired");
}

export function remoteMessageKey(
  accountId: string,
  mailboxId: string,
  uidValidity: string,
  uid: number,
): string {
  assertKeySegment(accountId, "account id");
  assertKeySegment(mailboxId, "mailbox id");
  validateUidValidity(uidValidity);
  assertUid(uid, false);
  return `${accountId}/${mailboxId}/${uidValidity}/${uid}`;
}

function transitionToBackoff(
  state: MailboxSyncState,
  now: number,
  errorCode: string,
): MailboxSyncState {
  const failureCount = state.failureCount + 1;
  const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(failureCount - 1, 10));
  return freezeState({
    ...state,
    version: state.version + 1,
    phase: "backoff",
    lease: null,
    failureCount,
    retryAt: now + delay,
    lastErrorCode: errorCode,
  });
}

function requireAttempt(state: MailboxSyncState, attemptId: string): MailboxSyncLease {
  validateState(state);
  assertSafeIdentifier(attemptId, "sync attempt id");
  if ((state.phase !== "syncing" && state.phase !== "rebuilding") || !state.lease) {
    throw new Error("mailbox sync has no active attempt");
  }
  if (state.lease.attemptId !== attemptId) {
    throw new Error("mailbox sync attempt does not match the active lease");
  }
  return state.lease;
}

function validateState(state: MailboxSyncState): void {
  assertNonNegativeInteger(state.version, "mailbox sync state version");
  if (!["idle", "syncing", "rebuilding", "backoff"].includes(state.phase)) {
    throw new Error("mailbox sync state phase is invalid");
  }
  if (state.active) validateCursor(state.active, "active mailbox cursor");
  if (state.resume) validateCursor(state.resume, "resume mailbox cursor");
  if (state.lease) validateLease(state.lease);
  assertNonNegativeInteger(state.failureCount, "mailbox sync failure count");
  if (state.retryAt !== null) assertTimestamp(state.retryAt, "mailbox sync retry time");
  if (state.lastErrorCode !== null) assertErrorCode(state.lastErrorCode);

  if (state.lease && state.phase !== "syncing" && state.phase !== "rebuilding") {
    throw new Error("mailbox sync state has a lease outside an active phase");
  }
  if (!state.lease && (state.phase === "syncing" || state.phase === "rebuilding")) {
    throw new Error("mailbox sync active phase is missing its lease");
  }
  if (state.phase === "backoff" && state.retryAt === null) {
    throw new Error("mailbox sync backoff state is missing its retry time");
  }
  if (state.phase !== "backoff" && state.retryAt !== null) {
    throw new Error("mailbox sync retry time exists outside backoff");
  }
  if (state.phase === "rebuilding" && !isRebuild(state.active, state.resume)) {
    throw new Error("mailbox rebuilding state is missing a changed UIDVALIDITY");
  }
  if (state.phase === "syncing" && isRebuild(state.active, state.resume)) {
    throw new Error("mailbox syncing state contains a rebuild cursor");
  }
  if (
    state.active &&
    state.resume &&
    state.active.uidValidity === state.resume.uidValidity &&
    state.active.generation !== state.resume.generation
  ) {
    throw new Error("mailbox cursors reuse UIDVALIDITY across generations");
  }
  if (
    state.active &&
    state.resume &&
    state.active.uidValidity !== state.resume.uidValidity &&
    state.resume.generation <= state.active.generation
  ) {
    throw new Error("mailbox rebuild generation must advance");
  }
  if (
    state.lease &&
    state.lease.observedUidValidity !== null &&
    state.lease.observedUidValidity !== state.resume?.uidValidity
  ) {
    throw new Error("mailbox lease observation does not match its resume cursor");
  }
}

function validateCursor(cursor: MailboxSyncCursor, label: string): void {
  if (!Number.isSafeInteger(cursor.generation) || cursor.generation < 1) {
    throw new Error(`${label} generation is invalid`);
  }
  validateUidValidity(cursor.uidValidity);
  assertUid(cursor.highestUid, true);
  validateModSeq(cursor.highestModSeq);
}

function validateLease(lease: MailboxSyncLease): void {
  assertSafeIdentifier(lease.attemptId, "sync attempt id");
  assertTimestamp(lease.startedAt, "sync lease start time");
  assertTimestamp(lease.expiresAt, "sync lease expiry time");
  if (
    lease.expiresAt <= lease.startedAt ||
    lease.expiresAt - lease.startedAt > MAX_LEASE_MS
  ) {
    throw new Error("mailbox sync lease duration is invalid");
  }
  if (lease.observedUidValidity !== null) {
    validateUidValidity(lease.observedUidValidity);
  }
}

function validateUidValidity(value: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new Error("mailbox UIDVALIDITY must be a positive decimal value");
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric > 0xffff_ffff) {
    throw new Error("mailbox UIDVALIDITY exceeds the unsigned 32-bit range");
  }
  return value;
}

function validateModSeq(value: string | null): string | null {
  if (value === null) return null;
  if (!/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > MAX_MODSEQ) {
    throw new Error("mailbox MODSEQ must be an unsigned 63-bit positive value");
  }
  return value;
}

function assertUid(value: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new Error(`mailbox UID must be an integer between ${minimum} and 4294967295`);
  }
}

function assertLeaseMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_LEASE_MS) {
    throw new Error(`mailbox sync lease must be between 1000 and ${MAX_LEASE_MS} milliseconds`);
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
}

function assertTimestampWithinLease(
  value: number,
  lease: MailboxSyncLease,
  label: string,
): void {
  assertTimestamp(value, label);
  if (value < lease.startedAt || value > lease.expiresAt) {
    throw new Error(`${label} is outside the active lease`);
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertErrorCode(value: string): void {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) throw new Error("mail error code is invalid");
}

function assertKeySegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/.test(value)) {
    throw new Error(`${label} cannot be used in a remote message key`);
  }
}

function isRebuild(
  active: MailboxSyncCursor | null,
  resume: MailboxSyncCursor | null,
): boolean {
  return active !== null && resume !== null && active.uidValidity !== resume.uidValidity;
}

function freezeState(state: MailboxSyncState): MailboxSyncState {
  validateState(state);
  return Object.freeze({
    ...state,
    active: state.active ? Object.freeze({ ...state.active }) : null,
    resume: state.resume ? Object.freeze({ ...state.resume }) : null,
    lease: state.lease ? Object.freeze({ ...state.lease }) : null,
  });
}
