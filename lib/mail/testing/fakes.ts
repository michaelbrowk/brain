import type {
  ImapAppendHooks,
  ImapAppendOutcome,
  ImapRawMessageRequest,
  ImapSessionFactoryPort,
  ImapSessionPort,
  ImapSentCopyRequest,
  ImapSyncPage,
  ImapSyncRequest,
  IsolatedMailParserPort,
  MailMimeParseOutcome,
  MailMimeParseRequest,
  MailMimeWorkerRequest,
  MailParserIsolation,
  MailProtocolConnectionPolicy,
  MailProtocolSessionOpenRequest,
  MailSystemAdmissionPort,
  MailSystemUsage,
  MailTransportBinding,
  MailTlsProof,
  MailboxSyncPageCommit,
  MailboxSyncCommitState,
  MailboxSyncStateStorePort,
  ParsedMailArtifactSet,
  SmtpSessionFactoryPort,
  SmtpSessionPort,
  SmtpSubmissionHooks,
  SmtpSubmissionOutcome,
  SmtpSubmissionRequest,
  VersionedState,
  VersionedStateStorePort,
} from "../ports";
import type { SubmissionRecord } from "../send-state";
import {
  admitMailSystemUsage,
  validateImapSyncPage,
  validateMailMimeParseRequest,
  validateMailProtocolSessionOpenRequest,
  validateMailSystemReservationDelta,
  validateMailTlsProof,
  validateParsedMailArtifactSet,
} from "../security";

interface FakeImapScript {
  readonly capabilities: readonly string[];
  readonly pages: readonly ImapSyncPage[];
  readonly failAfterPages?: number;
  readonly failureCode?: string;
  readonly rawMessageChunks?: readonly Uint8Array[];
  readonly appendOutcomes?: readonly ImapAppendOutcome[];
}

export type FakeMailSessionEvent =
  | "binding_resolved"
  | "credential_loaded"
  | "relay_authorized"
  | "relay_connected"
  | "dial_started"
  | "tls_verified"
  | "starttls_verified"
  | "auth_sent"
  | "session_ready";

interface FakeProtocolSessionOptions {
  /** Authenticated relays may return no observed peer address. */
  readonly smtpTunnelRemoteAddress?: string | null;
  readonly smtpEgressTransport?: "direct" | "authenticated_byte_relay";
  readonly now?: number;
  readonly certificateValid?: boolean;
  readonly certificateHostnameValid?: boolean;
  readonly startTlsAvailable?: boolean;
  readonly bindings?: Readonly<Record<string, MailTransportBinding>>;
  readonly credentials?: Readonly<Record<string, Uint8Array>>;
}

interface FakeProtocolSessionCore {
  readonly proof: MailTlsProof;
  readonly binding: MailTransportBinding;
  readonly connectionPolicy: MailProtocolConnectionPolicy;
  isClosed(): boolean;
  close(): Promise<void>;
}

export class FakeMailAdapterError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "FakeMailAdapterError";
    this.code = code;
  }
}

export class FakeImapSessionFactory implements ImapSessionFactoryPort {
  readonly capabilities: readonly string[];
  readonly openCalls: MailProtocolSessionOpenRequest[] = [];
  readonly calls: ImapSyncRequest[] = [];
  readonly rawMessageCalls: ImapRawMessageRequest[] = [];
  readonly appendCalls: ImapSentCopyRequest[] = [];
  readonly events: FakeMailSessionEvent[] = [];
  readonly credentialReads: Array<{ readonly id: string; readonly version: number }> = [];
  private readonly pages: readonly ImapSyncPage[];
  private readonly failAfterPages: number | null;
  private readonly failureCode: string;
  private readonly rawMessageChunks: readonly Uint8Array[];
  private readonly appendOutcomes: readonly ImapAppendOutcome[];
  private readonly options: FakeProtocolSessionOptions;
  private nextAppendOutcome = 0;

  constructor(script: FakeImapScript, options: FakeProtocolSessionOptions = {}) {
    this.capabilities = Object.freeze([...script.capabilities]);
    this.pages = Object.freeze([...script.pages]);
    this.failAfterPages = script.failAfterPages ?? null;
    this.failureCode = script.failureCode ?? "imap_scripted_failure";
    this.rawMessageChunks = Object.freeze(
      (script.rawMessageChunks ?? []).map((chunk) => new Uint8Array(chunk)),
    );
    this.appendOutcomes = Object.freeze([...(script.appendOutcomes ?? [])]);
    this.options = options;
    if (
      this.failAfterPages !== null &&
      (!Number.isSafeInteger(this.failAfterPages) || this.failAfterPages < 0)
    ) {
      throw new Error("fake IMAP failAfterPages must be a non-negative integer");
    }
  }

  async open(request: MailProtocolSessionOpenRequest): Promise<ImapSessionPort> {
    const validatedRequest = validateMailProtocolSessionOpenRequest(
      "imap",
      request,
      this.options.now ?? request.target.resolvedAt + 1,
    );
    this.openCalls.push(cloneAndFreeze(validatedRequest));
    const core = await openFakeProtocolSession(
      "imap",
      validatedRequest,
      this.options,
      this.events,
      this.credentialReads,
    );
    return {
      proof: core.proof,
      binding: core.binding,
      connectionPolicy: core.connectionPolicy,
      capabilities: this.capabilities,
      syncMailbox: (syncRequest) => this.syncMailbox(core, syncRequest),
      fetchRawMessage: (rawRequest) => this.fetchRawMessage(core, rawRequest),
      appendSentCopy: (appendRequest, hooks) =>
        this.appendSentCopy(core, appendRequest, hooks),
      close: core.close,
    };
  }

  private async *syncMailbox(
    core: FakeProtocolSessionCore,
    request: ImapSyncRequest,
  ): AsyncIterable<ImapSyncPage> {
    assertSessionOperation(core, "imap", request.accountId, request.deadlineAt);
    if (!Number.isSafeInteger(request.maxMessages) || request.maxMessages < 1) {
      throw new FakeMailAdapterError("imap_page_limit_invalid");
    }
    this.calls.push(copyImapRequest(request));
    let yielded = 0;
    for (const page of this.pages) {
      if (this.failAfterPages !== null && yielded >= this.failAfterPages) {
        throw new FakeMailAdapterError(this.failureCode);
      }
      yielded += 1;
      yield page;
    }
    if (this.failAfterPages !== null && yielded >= this.failAfterPages) {
      throw new FakeMailAdapterError(this.failureCode);
    }
  }

  private async *fetchRawMessage(
    core: FakeProtocolSessionCore,
    request: ImapRawMessageRequest,
  ): AsyncIterable<Uint8Array> {
    assertSessionOperation(core, "imap", request.accountId, request.deadlineAt);
    this.rawMessageCalls.push(cloneAndFreeze(request));
    for (const chunk of this.rawMessageChunks) yield new Uint8Array(chunk);
  }

  private async appendSentCopy(
    core: FakeProtocolSessionCore,
    request: ImapSentCopyRequest,
    hooks: ImapAppendHooks,
  ): Promise<ImapAppendOutcome> {
    assertSessionOperation(core, "imap", request.accountId, hooks.deadlineAt);
    const outcome = this.appendOutcomes[this.nextAppendOutcome];
    if (!outcome) throw new FakeMailAdapterError("imap_append_script_exhausted");
    this.nextAppendOutcome += 1;
    this.appendCalls.push(cloneAndFreeze(request));
    if (
      outcome.kind === "stored" ||
      outcome.kind === "stored_without_uid" ||
      (outcome.kind === "transport_error" && outcome.deliveryRisk === "possible")
    ) {
      await hooks.beforeLiteral();
    }
    return cloneAndFreeze(outcome);
  }
}

export class FakeSmtpSessionFactory implements SmtpSessionFactoryPort {
  readonly openCalls: MailProtocolSessionOpenRequest[] = [];
  readonly calls: SmtpSubmissionRequest[] = [];
  readonly events: FakeMailSessionEvent[] = [];
  readonly credentialReads: Array<{ readonly id: string; readonly version: number }> = [];
  private readonly outcomes: readonly SmtpSubmissionOutcome[];
  private readonly options: FakeProtocolSessionOptions;
  private nextOutcome = 0;

  constructor(
    outcomes: readonly SmtpSubmissionOutcome[],
    options: FakeProtocolSessionOptions = {},
  ) {
    this.outcomes = Object.freeze([...outcomes]);
    this.options = options;
  }

  async open(request: MailProtocolSessionOpenRequest): Promise<SmtpSessionPort> {
    const validatedRequest = validateMailProtocolSessionOpenRequest(
      "smtp",
      request,
      this.options.now ?? request.target.resolvedAt + 1,
    );
    this.openCalls.push(cloneAndFreeze(validatedRequest));
    const core = await openFakeProtocolSession(
      "smtp",
      validatedRequest,
      this.options,
      this.events,
      this.credentialReads,
    );
    return {
      proof: core.proof,
      binding: core.binding,
      connectionPolicy: core.connectionPolicy,
      submit: (submission, hooks) => this.submit(core, submission, hooks),
      close: core.close,
    };
  }

  private async submit(
    core: FakeProtocolSessionCore,
    request: SmtpSubmissionRequest,
    hooks: SmtpSubmissionHooks,
  ): Promise<SmtpSubmissionOutcome> {
    assertSessionOperation(core, "smtp", request.accountId, hooks.deadlineAt);
    const outcome = this.outcomes[this.nextOutcome];
    if (!outcome) throw new FakeMailAdapterError("smtp_script_exhausted");
    this.nextOutcome += 1;
    this.calls.push(copySmtpRequest(request));
    if (
      outcome.kind === "accepted" ||
      (outcome.kind === "transport_error" && outcome.deliveryRisk === "possible")
    ) {
      await hooks.beforeData();
    }
    return cloneAndFreeze(outcome);
  }
}

async function openFakeProtocolSession(
  protocol: "imap" | "smtp",
  request: MailProtocolSessionOpenRequest,
  options: FakeProtocolSessionOptions,
  events: FakeMailSessionEvent[],
  credentialReads: Array<{ readonly id: string; readonly version: number }>,
): Promise<FakeProtocolSessionCore> {
  const { target, bindingRef } = request;
  const binding = options.bindings?.[bindingKey(bindingRef)];
  if (!binding) throw new FakeMailAdapterError("transport_binding_not_found");
  events.push("binding_resolved");
  if (
    binding.accountId !== request.accountId ||
    binding.protocol !== protocol ||
    target.protocol !== protocol ||
    binding.endpoint.hostname !== target.hostname ||
    binding.endpoint.port !== target.port ||
    binding.endpoint.tls !== target.tls
  ) {
    throw new FakeMailAdapterError("transport_binding_target_mismatch");
  }

  const credentialRef = binding.auth.credentialRef;
  const stored = options.credentials?.[`${credentialRef.id}:${credentialRef.version}`];
  if (!stored) throw new FakeMailAdapterError("credential_not_found");
  const credential = new Uint8Array(stored);
  credentialReads.push({ id: credentialRef.id, version: credentialRef.version });
  events.push("credential_loaded");

  const connectionPolicy: MailProtocolConnectionPolicy = Object.freeze({
    dialAddress: target.address,
    originalHostname: target.hostname,
    tlsServername: target.hostname,
    tls: target.tls,
    certificateVerification: "required",
    startTls: target.tls === "starttls" ? "required" : "not_applicable",
    authentication: "after_verified_tls",
    logging: "disabled",
    egressTransport:
      protocol === "smtp"
        ? (options.smtpEgressTransport ?? "authenticated_byte_relay")
        : "direct",
    proxy: "disabled",
  });

  try {
    if (
      protocol === "smtp" &&
      connectionPolicy.egressTransport === "authenticated_byte_relay"
    ) {
      events.push("relay_authorized");
    }
    events.push("dial_started");
    if (
      protocol === "smtp" &&
      connectionPolicy.egressTransport === "authenticated_byte_relay"
    ) {
      events.push("relay_connected");
    }
    if (
      protocol === "smtp" &&
      options.smtpTunnelRemoteAddress !== undefined &&
      options.smtpTunnelRemoteAddress !== null &&
      options.smtpTunnelRemoteAddress !== target.address
    ) {
      throw new FakeMailAdapterError("smtp_tunnel_remote_address_mismatch");
    }
    if (
      protocol === "smtp" &&
      connectionPolicy.egressTransport === "direct" &&
      (options.smtpTunnelRemoteAddress === undefined ||
        options.smtpTunnelRemoteAddress === null)
    ) {
      throw new FakeMailAdapterError("smtp_direct_remote_address_missing");
    }
    if (options.certificateValid === false) {
      throw new FakeMailAdapterError("tls_certificate_invalid");
    }
    if (options.certificateHostnameValid === false) {
      throw new FakeMailAdapterError("tls_hostname_mismatch");
    }
    if (target.tls === "starttls" && options.startTlsAvailable === false) {
      throw new FakeMailAdapterError("starttls_unavailable");
    }
    const establishedAt = options.now ?? target.resolvedAt + 1;
    const proof = validateMailTlsProof(
      target,
      {
        protocol,
        resolutionId: target.resolutionId,
        hostname: target.hostname,
        address: target.address,
        family: target.family,
        tls: target.tls,
        certificateVerified: true,
        startTlsVerified: target.tls === "starttls",
        establishedAt,
      },
      establishedAt,
    );
    events.push(target.tls === "starttls" ? "starttls_verified" : "tls_verified");
    events.push("auth_sent");
    events.push("session_ready");
    let closed = false;
    return {
      proof,
      binding: cloneAndFreeze(binding),
      connectionPolicy,
      isClosed: () => closed,
      close: async () => {
        closed = true;
      },
    };
  } finally {
    credential.fill(0);
  }
}

export class FakeIsolatedMailParser implements IsolatedMailParserPort {
  readonly isolation: MailParserIsolation = Object.freeze({
    networkAccess: false,
    credentialAccess: false,
    sandboxVersion: 1,
  });
  readonly calls: MailMimeWorkerRequest[] = [];
  private readonly result: ParsedMailArtifactSet;
  private readonly now: number;

  constructor(result: ParsedMailArtifactSet, now = 0) {
    this.result = validateParsedMailArtifactSet(result);
    this.now = now;
  }

  async parse(request: MailMimeParseRequest): Promise<MailMimeParseOutcome> {
    this.calls.push(validateMailMimeParseRequest(request, this.now));
    return Object.freeze({
      kind: "parsed" as const,
      artifacts: validateParsedMailArtifactSet(this.result),
    });
  }
}

export class FakeOutbox {
  private readonly byIdempotencyKey = new Map<string, SubmissionRecord>();
  private readonly idempotencyKeyByOperation = new Map<string, string>();

  enqueue(record: SubmissionRecord): { created: boolean; record: SubmissionRecord } {
    const { idempotencyKey, operationId } = record.submission;
    const operationKey = this.idempotencyKeyByOperation.get(operationId);
    if (operationKey && operationKey !== idempotencyKey) {
      throw new Error("send operation cannot be reused with another idempotency key");
    }

    const existing = this.byIdempotencyKey.get(idempotencyKey);
    if (existing) {
      if (submissionFingerprint(existing) !== submissionFingerprint(record)) {
        throw new Error("idempotency key cannot be reused for different mail content");
      }
      return { created: false, record: existing };
    }

    this.byIdempotencyKey.set(idempotencyKey, record);
    this.idempotencyKeyByOperation.set(operationId, idempotencyKey);
    return { created: true, record };
  }

  findByIdempotencyKey(idempotencyKey: string): SubmissionRecord | null {
    return this.byIdempotencyKey.get(idempotencyKey) ?? null;
  }
}

export class FakeMailSystemAdmission implements MailSystemAdmissionPort {
  private usage: MailSystemUsage;
  private readonly reservations = new Map<string, Readonly<Partial<MailSystemUsage>>>();
  private nextReservation = 1;

  constructor(initialUsage: MailSystemUsage) {
    admitMailSystemUsage(initialUsage);
    this.usage = cloneAndFreeze(initialUsage);
  }

  async readUsage(): Promise<MailSystemUsage> {
    return cloneAndFreeze(this.usage);
  }

  async reserve(
    operationId: string,
    inputDelta: Partial<MailSystemUsage>,
  ): Promise<{ readonly reservationId: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) {
      throw new Error("mail admission operation id is invalid");
    }
    const delta = validateMailSystemReservationDelta(inputDelta);
    const next = { ...this.usage };
    for (const [field, value] of Object.entries(delta) as Array<
      [keyof MailSystemUsage, number]
    >) {
      next[field] += value;
    }
    admitMailSystemUsage(next);
    const reservationId = `reservation-${this.nextReservation++}`;
    this.usage = cloneAndFreeze(next);
    this.reservations.set(reservationId, delta);
    return Object.freeze({ reservationId });
  }

  async release(reservationId: string): Promise<void> {
    const delta = this.reservations.get(reservationId);
    if (!delta) throw new Error("mail admission reservation is missing or already released");
    const next = { ...this.usage };
    for (const [field, value] of Object.entries(delta) as Array<
      [keyof MailSystemUsage, number]
    >) {
      next[field] -= value;
    }
    admitMailSystemUsage(next);
    this.usage = cloneAndFreeze(next);
    this.reservations.delete(reservationId);
  }
}

export class FakeVersionedStateStore<T extends VersionedState>
  implements VersionedStateStorePort<T>
{
  protected readonly records = new Map<string, T>();

  async read(key: string): Promise<T | null> {
    const value = this.records.get(key);
    return value ? cloneAndFreeze(value) : null;
  }

  async insert(key: string, value: T): Promise<boolean> {
    if (this.records.has(key)) return false;
    this.records.set(key, cloneAndFreeze(value));
    return true;
  }

  async compareAndSwap(key: string, expectedVersion: number, next: T): Promise<boolean> {
    const current = this.records.get(key);
    if (!current || current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) {
      throw new Error("compare-and-swap must advance the state version by one");
    }
    this.records.set(key, cloneAndFreeze(next));
    return true;
  }

}

export class FakeMailboxSyncStateStore<T extends MailboxSyncCommitState>
  extends FakeVersionedStateStore<T>
  implements MailboxSyncStateStorePort<T>
{
  readonly committedPages: Array<{
    readonly key: string;
    readonly generation: number;
    readonly page: ImapSyncPage;
  }> = [];

  async commitPage(input: MailboxSyncPageCommit<T>): Promise<boolean> {
    const current = this.records.get(input.key);
    if (!current || current.version !== input.expectedVersion) return false;
    if (input.next.version !== input.expectedVersion + 1) {
      throw new Error("sync page commit must advance the state version by one");
    }
    const resume = input.next.resume;
    const page = validateImapSyncPage(input.page);
    const currentResume = current.resume;
    if (
      !currentResume ||
      !resume ||
      !Number.isSafeInteger(input.generation) ||
      input.generation < 1 ||
      input.generation !== resume.generation ||
      resume.generation !== currentResume.generation ||
      resume.uidValidity !== currentResume.uidValidity ||
      resume.highestUid < currentResume.highestUid ||
      (currentResume.highestModSeq !== null &&
        (resume.highestModSeq === null ||
          BigInt(resume.highestModSeq) < BigInt(currentResume.highestModSeq))) ||
      page.uidValidity !== resume.uidValidity ||
      page.highestUid !== resume.highestUid ||
      page.highestModSeq !== resume.highestModSeq
    ) {
      throw new Error("sync page commit does not match its staged cursor");
    }
    const next = cloneAndFreeze(input.next);
    this.records.set(input.key, next);
    this.committedPages.push({
      key: input.key,
      generation: input.generation,
      page,
    });
    return true;
  }
}

function copyImapRequest(request: ImapSyncRequest): ImapSyncRequest {
  return Object.freeze({
    accountId: request.accountId,
    mailboxId: request.mailboxId,
    remotePath: request.remotePath,
    cursor: request.cursor
      ? Object.freeze({
          uidValidity: request.cursor.uidValidity,
          highestUid: request.cursor.highestUid,
          highestModSeq: request.cursor.highestModSeq,
        })
      : null,
    maxMessages: request.maxMessages,
    deadlineAt: request.deadlineAt,
  });
}

function assertSessionOperation(
  session: FakeProtocolSessionCore,
  expected: "imap" | "smtp",
  accountId: string,
  deadlineAt: number,
): void {
  if (session.isClosed()) throw new FakeMailAdapterError("protocol_session_closed");
  const { proof, binding, connectionPolicy } = session;
  if (
    proof.protocol !== expected ||
    proof.certificateVerified !== true ||
    (proof.tls === "starttls" && proof.startTlsVerified !== true) ||
    binding.accountId !== accountId ||
    binding.protocol !== expected ||
    connectionPolicy.dialAddress !== proof.address ||
    connectionPolicy.originalHostname !== proof.hostname ||
    connectionPolicy.tlsServername !== proof.hostname ||
    connectionPolicy.tls !== proof.tls ||
    connectionPolicy.certificateVerification !== "required" ||
    connectionPolicy.startTls !==
      (proof.tls === "starttls" ? "required" : "not_applicable") ||
    connectionPolicy.authentication !== "after_verified_tls" ||
    connectionPolicy.logging !== "disabled" ||
    connectionPolicy.proxy !== "disabled"
  ) {
    throw new FakeMailAdapterError("protocol_session_invalid");
  }
  assertFutureDeadline(deadlineAt, proof.establishedAt);
}

function bindingKey(ref: { readonly id: string; readonly version: number }): string {
  return `${ref.id}:${ref.version}`;
}

function assertFutureDeadline(deadlineAt: number, after: number): void {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= after) {
    throw new FakeMailAdapterError("mail_operation_deadline_invalid");
  }
}

function copySmtpRequest(request: SmtpSubmissionRequest): SmtpSubmissionRequest {
  return Object.freeze({
    accountId: request.accountId,
    operationId: request.operationId,
    messageId: request.messageId,
    envelope: Object.freeze({
      from: request.envelope.from,
      to: Object.freeze([...request.envelope.to]),
      cc: Object.freeze([...request.envelope.cc]),
      bcc: Object.freeze([...request.envelope.bcc]),
    }),
    rawMimeSha256: request.rawMimeSha256,
    rawMimeBytes: request.rawMimeBytes,
  });
}

function submissionFingerprint(record: SubmissionRecord): string {
  const value = record.submission;
  return JSON.stringify([
    value.operationId,
    value.idempotencyKey,
    value.accountId,
    value.messageId,
    value.envelope.from,
    value.envelope.to,
    value.envelope.cc,
    value.envelope.bcc,
    value.rawMimeSha256,
    value.rawMimeBytes,
  ]);
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
