/**
 * Provider-neutral boundaries for Brain Mail.
 *
 * Credential values never cross the service API. A protocol-session factory
 * owns the provider library, trusted binding resolution, and temporary secret
 * bytes inside the isolated adapter edge. A secret may be loaded before the
 * network handshake because ImapFlow accepts auth at client construction time
 * and the first-party SMTP adapter owns auth state for the connection; their
 * immutable policy must prevent any auth command or bytes from being sent
 * before verified TLS.
 */

export type MailProtocol = "imap" | "smtp";
export type MailTlsMode = "implicit" | "starttls";

export interface CredentialRef {
  readonly id: string;
  readonly version: number;
}

export interface MailProtocolAuthRef {
  readonly username: string;
  readonly credentialRef: CredentialRef;
}

export interface MailEndpoint {
  readonly hostname: string;
  readonly port: number;
  readonly tls: MailTlsMode;
}

/** One address from a DNS answer set that was validated as a complete set. */
export interface ValidatedMailDialTarget extends MailEndpoint {
  readonly protocol: MailProtocol;
  readonly address: string;
  readonly family: 4 | 6;
  readonly resolutionId: string;
  readonly resolvedAt: number;
  readonly expiresAt: number;
}

/** Resolves every reconnect and rejects the whole answer set if any address is unsafe. */
export interface MailDnsResolverPort {
  resolve(
    protocol: MailProtocol,
    endpoint: MailEndpoint,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<readonly ValidatedMailDialTarget[]>;
}

export interface MailTlsProof {
  readonly protocol: MailProtocol;
  readonly resolutionId: string;
  /** Original endpoint hostname retained for SNI and certificate verification. */
  readonly hostname: string;
  /** Literal configured dial address; this is not an observed socket peer. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly tls: MailTlsMode;
  readonly certificateVerified: true;
  readonly startTlsVerified: boolean;
  readonly establishedAt: number;
}

export interface MailProtocolConnectionPolicy {
  /** Provider libraries dial the validated address, never a re-resolved hostname. */
  readonly dialAddress: string;
  /** The original account hostname is retained for SNI and certificate verification. */
  readonly originalHostname: string;
  readonly tlsServername: string;
  readonly tls: MailTlsMode;
  readonly certificateVerification: "required";
  readonly startTls: "required" | "not_applicable";
  readonly authentication: "after_verified_tls";
  readonly logging: "disabled";
  /** Explicit application transport. Ambient HTTP/SOCKS proxy variables stay disabled. */
  readonly egressTransport: "direct" | "authenticated_byte_relay";
  readonly proxy: "disabled";
}

export interface MailProtocolSessionOpenRequest {
  readonly accountId: string;
  readonly target: ValidatedMailDialTarget;
  readonly bindingRef: MailTransportBindingRef;
  readonly deadlineAt: number;
}

/** Identity and transport policy bound once by a protocol-session factory. */
export interface MailProtocolSessionContext {
  readonly proof: MailTlsProof;
  readonly binding: MailTransportBinding;
  readonly connectionPolicy: MailProtocolConnectionPolicy;
  close(): Promise<void>;
}

export interface MailProtocolRuntimeConfig {
  readonly endpoint: MailEndpoint;
  readonly auth: MailProtocolAuthRef;
  /** Opaque reference to a trusted account/protocol/endpoint/credential binding. */
  readonly transportBindingRef: MailTransportBindingRef;
}

export interface MailAccountRuntimeConfig {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly imap: MailProtocolRuntimeConfig;
  readonly smtp: MailProtocolRuntimeConfig;
}

export interface MailTransportBindingRef {
  readonly id: string;
  readonly version: number;
}

/**
 * Resolved only inside the transport edge from trusted provisioning storage.
 * Callers cannot pair an arbitrary credential with an arbitrary dial target.
 */
export interface MailTransportBinding {
  readonly accountId: string;
  readonly protocol: MailProtocol;
  readonly endpoint: MailEndpoint;
  readonly auth: MailProtocolAuthRef;
}

export interface MailEnvelope {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

export interface MailboxCursor {
  readonly uidValidity: string;
  readonly highestUid: number;
  readonly highestModSeq: string | null;
}

export interface ImapSyncRequest {
  readonly accountId: string;
  readonly mailboxId: string;
  readonly remotePath: string;
  readonly cursor: MailboxCursor | null;
  readonly maxMessages: number;
  readonly deadlineAt: number;
}

/** Metadata sync does not imply that the raw MIME body has been fetched. */
export interface ImapMessageMetadata {
  readonly uid: number;
  readonly modSeq: string | null;
  readonly flags: readonly string[];
  readonly rfc822Size: number | null;
}

export interface ImapSyncPage {
  readonly uidValidity: string;
  readonly highestModSeq: string | null;
  readonly highestUid: number;
  readonly vanishedUids: readonly number[];
  readonly messages: readonly ImapMessageMetadata[];
}

export interface ImapRawMessageRequest {
  readonly accountId: string;
  readonly mailboxId: string;
  readonly remotePath: string;
  readonly uidValidity: string;
  readonly uid: number;
  readonly advertisedBytes: number | null;
  readonly maxBytes: number;
  readonly deadlineAt: number;
}

export interface MailBlobDescriptor {
  readonly sha256: string;
  readonly bytes: number;
}

export interface ImapSentCopyRequest {
  readonly accountId: string;
  readonly mailboxId: string;
  readonly remotePath: string;
  readonly operationId: string;
  readonly messageId: string;
  readonly rawMime: MailBlobDescriptor;
}

export type ImapAppendOutcome =
  | {
      readonly kind: "stored";
      readonly uidValidity: string;
      readonly uid: number;
    }
  | { readonly kind: "stored_without_uid" }
  | {
      readonly kind: "rejected";
      readonly retryable: boolean;
      readonly errorCode: string;
    }
  | {
      readonly kind: "transport_error";
      readonly deliveryRisk: "none" | "possible";
      readonly errorCode: string;
    };

export interface ImapAppendHooks {
  readonly deadlineAt: number;
  /** The adapter must await this after continuation and before the first literal byte. */
  beforeLiteral(): Promise<void>;
}

export interface ImapSessionPort extends MailProtocolSessionContext {
  readonly capabilities: readonly string[];
  syncMailbox(request: ImapSyncRequest): AsyncIterable<ImapSyncPage>;
  fetchRawMessage(request: ImapRawMessageRequest): AsyncIterable<Uint8Array>;
  appendSentCopy(
    request: ImapSentCopyRequest,
    hooks: ImapAppendHooks,
  ): Promise<ImapAppendOutcome>;
}

export interface ImapSessionFactoryPort {
  open(request: MailProtocolSessionOpenRequest): Promise<ImapSessionPort>;
}

export interface SmtpSubmissionRequest {
  readonly accountId: string;
  readonly operationId: string;
  readonly messageId: string;
  readonly envelope: MailEnvelope;
  readonly rawMimeSha256: string;
  readonly rawMimeBytes: number;
}

export interface SmtpRecipientRejection {
  readonly address: string;
  readonly responseCode: number;
  readonly retryable: boolean;
  readonly errorCode: string;
}

export type SmtpSubmissionOutcome =
  | {
      readonly kind: "accepted";
      readonly responseCode: number;
      readonly acceptedRecipients: readonly string[];
      readonly rejectedRecipients: readonly SmtpRecipientRejection[];
    }
  | {
      readonly kind: "rejected";
      readonly responseCode: number;
      readonly retryable: boolean;
      readonly errorCode: string;
    }
  | {
      readonly kind: "transport_error";
      readonly deliveryRisk: "none" | "possible";
      readonly errorCode: string;
    };

export interface SmtpSubmissionHooks {
  readonly deadlineAt: number;
  /** The adapter must await this after 354 and before the first DATA byte. */
  beforeData(): Promise<void>;
}

/**
 * Raw SMTP egress opened to one already validated literal address.
 *
 * A relay transports bytes only. Brain still owns SMTP parsing, STARTTLS,
 * certificate verification, authentication, and the exact DATA barrier.
 */
export interface SmtpEgressTunnelOpenRequest {
  readonly transport: "direct" | "authenticated_byte_relay";
  readonly sessionId: string;
  readonly attemptId: string;
  readonly target: ValidatedMailDialTarget;
  readonly deadlineAt: number;
}

export interface SmtpEgressRelayChallenge {
  readonly version: 1;
  readonly audience: "brain-mail-smtp-egress-v1";
  /** 32 random bytes encoded as 64 lowercase hexadecimal characters. */
  readonly challenge: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Challenge response sent before the relay may open its one TCP connection.
 * The HMAC covers every field except hmacSha256 using the canonical payload
 * produced by the security boundary.
 */
export interface SmtpEgressRelayAuthorizationPayload extends SmtpEgressRelayChallenge {
  readonly transport: "authenticated_byte_relay";
  readonly sessionId: string;
  readonly attemptId: string;
  readonly resolutionId: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 465 | 587;
  readonly targetExpiresAt: number;
  readonly deadlineAt: number;
}

export interface SmtpEgressRelayAuthorization
  extends SmtpEgressRelayAuthorizationPayload {
  readonly hmacSha256: string;
}

export interface SmtpEgressTunnelProof {
  readonly transport: "direct" | "authenticated_byte_relay";
  readonly sessionId: string;
  readonly attemptId: string;
  readonly resolutionId: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 465 | 587;
  /** A relay may not expose this value. When present it must equal address. */
  readonly remoteAddress: string | null;
  readonly connectedAt: number;
}

export interface SmtpEgressTunnelPort {
  readonly proof: SmtpEgressTunnelProof;
  read(): AsyncIterable<Uint8Array>;
  /** Resolves only after the complete chunk has reached the underlying TCP writer. */
  write(chunk: Uint8Array, deadlineAt: number): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpEgressTunnelFactoryPort {
  open(request: SmtpEgressTunnelOpenRequest): Promise<SmtpEgressTunnelPort>;
}

/** One first-party SMTP wire session owns one physical authenticated connection. */
export interface SmtpSessionPort extends MailProtocolSessionContext {
  submit(
    request: SmtpSubmissionRequest,
    hooks: SmtpSubmissionHooks,
  ): Promise<SmtpSubmissionOutcome>;
}

export interface SmtpSessionFactoryPort {
  /** Opens exactly one SMTP protocol session over one direct or authenticated relay. */
  open(request: MailProtocolSessionOpenRequest): Promise<SmtpSessionPort>;
}

export interface MailBlobStorePort {
  has(descriptor: MailBlobDescriptor): Promise<boolean>;
  put(descriptor: MailBlobDescriptor, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  read(descriptor: MailBlobDescriptor): AsyncIterable<Uint8Array>;
  remove(descriptor: MailBlobDescriptor): Promise<void>;
}

/**
 * A bounded, one-pass publication boundary for bytes whose digest is not known
 * before the provider stream has been consumed.
 */
export interface MailIncomingBlobStorePort extends MailBlobStorePort {
  putIncoming(
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<MailBlobDescriptor>;
}

/**
 * Versioned persistence boundary. Concrete SQLite records stay private to the
 * future service so the Brain web process never opens the mail databases.
 */
export interface VersionedState {
  readonly version: number;
}

export interface MailboxSyncCommitCursor extends MailboxCursor {
  readonly generation: number;
}

/** Minimum state shape required for an atomic metadata-page commit. */
export interface MailboxSyncCommitState extends VersionedState {
  readonly resume: MailboxSyncCommitCursor | null;
}

/** Every async worker transition is persisted with an optimistic version check. */
export interface VersionedStateStorePort<T extends VersionedState> {
  read(key: string): Promise<T | null>;
  insert(key: string, value: T): Promise<boolean>;
  compareAndSwap(key: string, expectedVersion: number, next: T): Promise<boolean>;
}

export interface MailboxSyncPageCommit<T extends MailboxSyncCommitState> {
  readonly key: string;
  readonly expectedVersion: number;
  readonly next: T;
  readonly generation: number;
  readonly page: ImapSyncPage;
}

/** Fetched rows and the resume cursor advance in one durable transaction. */
export interface MailboxSyncStateStorePort<T extends MailboxSyncCommitState>
  extends VersionedStateStorePort<T> {
  commitPage(input: MailboxSyncPageCommit<T>): Promise<boolean>;
}

export interface MailMimeParseBudget {
  readonly deadlineAt: number;
  readonly maxRawBytes: number;
  readonly maxDecodedBytes: number;
  readonly maxHeaderBytes: number;
  readonly maxHtmlCharacters: number;
  readonly maxTextCharacters: number;
  readonly maxAddresses: number;
  readonly maxParts: number;
  readonly maxDepth: number;
  readonly maxDomNodes: number;
  readonly maxDomAttributes: number;
  readonly maxRemoteImages: number;
  readonly maxInlineImagePixels: number;
  readonly maxInlineImageFrames: number;
}

/** Exact JSON projection allowed to cross the parser-worker socket. */
export interface MailMimeWorkerRequest {
  readonly operationId: string;
  readonly rawMime: MailBlobDescriptor;
  readonly budget: MailMimeParseBudget;
}

/** Parent-owned raw bytes and cancellation stay outside the JSON IPC envelope. */
export interface MailMimeParseRequest extends MailMimeWorkerRequest {
  readonly rawMimeStream: AsyncIterable<Uint8Array>;
  readonly signal: AbortSignal;
}

export interface ParsedMailStagedBlob {
  readonly descriptor: MailBlobDescriptor;
  readonly data: Uint8Array;
}

export type ParsedMailAttachmentDisposition = "attachment" | "inline";

export interface ParsedMailAttachment {
  readonly filename: string | null;
  readonly mimeType: string;
  readonly disposition: ParsedMailAttachmentDisposition;
  readonly contentId: string | null;
  readonly blob: ParsedMailStagedBlob;
}

export interface ParsedMailRemoteImage {
  readonly remoteImageId: string;
  readonly sourceUrl: string;
}

export interface ParsedMailArtifactSet {
  readonly text: ParsedMailStagedBlob | null;
  readonly sanitizedHtml: ParsedMailStagedBlob | null;
  readonly attachments: readonly ParsedMailAttachment[];
  readonly remoteImages: readonly ParsedMailRemoteImage[];
}

export type MailMimeTransientErrorCode =
  | "mail_mime_aborted"
  | "mail_mime_source_unavailable"
  | "mail_mime_worker_crashed"
  | "mail_mime_worker_timeout"
  | "mail_mime_worker_unavailable";

export type MailMimePermanentErrorCode =
  | "mail_mime_invalid"
  | "mail_mime_limit_exceeded";

export type MailMimeIntegrityErrorCode = "mail_mime_integrity_failed";

export type MailMimeParseOutcome =
  | {
      readonly kind: "parsed";
      readonly artifacts: ParsedMailArtifactSet;
    }
  | {
      readonly kind: "transient_failure";
      readonly errorCode: MailMimeTransientErrorCode;
    }
  | {
      readonly kind: "permanent_failure";
      readonly errorCode: MailMimePermanentErrorCode;
    }
  | {
      readonly kind: "integrity_failure";
      readonly errorCode: MailMimeIntegrityErrorCode;
    };

export interface MailParserIsolation {
  readonly networkAccess: false;
  readonly credentialAccess: false;
  readonly sandboxVersion: number;
}

/** Implemented by a separate no-network, no-credential parser worker. */
export interface IsolatedMailParserPort {
  readonly isolation: MailParserIsolation;
  parse(request: MailMimeParseRequest): Promise<MailMimeParseOutcome>;
}

export interface MailSystemUsage {
  readonly accounts: number;
  readonly mailboxes: number;
  readonly activeImapConnections: number;
  readonly idleSessions: number;
  readonly concurrentFetchStreams: number;
  readonly concurrentMimeParsers: number;
  readonly concurrentSmtpSubmissions: number;
  readonly queuedSubmissions: number;
  readonly cacheBytes: number;
  readonly cacheMessages: number;
  readonly temporaryBytes: number;
  readonly walBytes: number;
  readonly openFileDescriptors: number;
}

export interface MailSystemAdmissionPort {
  readUsage(): Promise<MailSystemUsage>;
  reserve(
    operationId: string,
    delta: Partial<MailSystemUsage>,
  ): Promise<{ readonly reservationId: string }>;
  release(reservationId: string): Promise<void>;
}

export interface MailServiceHealth {
  readonly apiVersion: 1;
  readonly build: {
    readonly commit: string;
    readonly builtAt: string;
  };
  readonly status: "ok" | "degraded";
  readonly localSchemaVersion: number | null;
  readonly cacheSchemaVersion: number | null;
  readonly receiveReadiness: "not_configured" | "ready" | "degraded";
  readonly sendReadiness:
    | "not_configured"
    | "ready"
    | "egress_blocked"
    | "degraded";
  readonly activeAccounts: number;
  readonly queuedSubmissions: number;
  readonly lastSuccessfulSyncAgeMs: number | null;
  readonly cachePressure: "normal" | "warning" | "critical";
  readonly lastErrorCode: string | null;
}

export interface QueueSubmissionRequest extends SmtpSubmissionRequest {
  readonly idempotencyKey: string;
}

export interface QueueSubmissionResult {
  readonly operationId: string;
  readonly created: boolean;
  /** Fingerprint of caller-stable immutable request fields; excludes server metadata. */
  readonly requestFingerprint: string;
}

/** Unix-socket API exposed to Brain. It contains no credential values. */
export interface BrainMailServicePort {
  health(): Promise<MailServiceHealth>;
  queueSubmission(request: QueueSubmissionRequest): Promise<QueueSubmissionResult>;
  findSubmissionByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<QueueSubmissionResult | null>;
  syncMailbox(request: { readonly accountId: string; readonly mailboxId: string }): Promise<void>;
}
