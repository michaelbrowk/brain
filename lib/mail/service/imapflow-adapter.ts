import {
  ImapFlow,
  type CopyResponseObject,
  type FetchMessageObject,
  type FetchOptions,
  type FetchQueryObject,
  type ImapFlowOptions,
  type ListOptions,
  type ListResponse,
  type MailboxLockObject,
  type MailboxObject,
  type SearchObject,
  type SequenceString,
  type StoreOptions,
} from "imapflow";

import type {
  MailDnsResolverPort,
  MailEndpoint,
  ValidatedMailDialTarget,
} from "../ports";
import { canonicalizeMailPeerAddress } from "../security";
import type { MultiMailAccountStore } from "./account-store";
import {
  MailAccountError,
  type StoredImapMailAccount,
} from "./account-types";

const MAX_IMAP_HANDSHAKE_LINE_BYTES = 64 * 1024;
const MAX_IMAP_HANDSHAKE_LITERAL_BYTES = 64 * 1024;
const MAX_IMAP_TARGET_ATTEMPT_MS = 3_000;
/** Largest single IMAP literal a read session accepts from the provider. */
export const MAX_IMAP_READ_LITERAL_BYTES = 256 * 1024;
const MAX_IMAP_READ_OPERATION_MS = 10_000;

export interface ImapCredentialVerificationRequest {
  readonly endpoint: MailEndpoint;
  readonly username: string;
  readonly password: Buffer;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface ImapCredentialVerifier {
  verify(request: ImapCredentialVerificationRequest): Promise<void>;
}

interface ImapVerificationClient {
  readonly secureConnection: boolean;
  readonly authenticated: boolean | string;
  connect(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: unknown) => void): this;
  unbind(): {
    readonly readSocket: ImapOwnedSocket;
    readonly writeSocket: ImapOwnedSocket;
  };
}

interface ImapOwnedSocket {
  readonly remoteAddress?: string;
  once(event: "error", listener: (error: unknown) => void): this;
  destroy(): void;
}

export interface ImapReadClient {
  readonly secureConnection: boolean;
  readonly authenticated: boolean | string;
  readonly mailbox: MailboxObject | false;
  connect(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: unknown) => void): this;
  unbind(): {
    readonly readSocket: ImapOwnedSocket;
    readonly writeSocket: ImapOwnedSocket;
  };
  getMailboxLock(
    path: string | string[],
    options?: {
      readonly readOnly?: boolean;
      readonly acquireTimeout?: number;
      readonly maxLockHoldTime?: number | false;
    },
  ): Promise<MailboxLockObject>;
  fetchAll(
    range: SequenceString | number[] | SearchObject,
    query: FetchQueryObject,
    options?: FetchOptions,
  ): Promise<FetchMessageObject[]>;
}

/**
 * The commands a session may issue once the caller takes a writable mailbox
 * lock. ImapFlow issues `UID STORE` for flags and `UID MOVE` (RFC 6851) for a
 * relocation. Mailbox roles are discovered through LIST, which carries the
 * SPECIAL-USE and XLIST attributes as `specialUse`.
 */
export interface ImapMutationCommands {
  /**
   * What the server advertised after authentication, as ImapFlow parsed it.
   *
   * A caller has to read this before it moves anything. ImapFlow gates its own
   * `UID MOVE` on `MOVE` being present here and emulates the command when it
   * is not — COPY, then `\Deleted`, then EXPUNGE — returning the COPY's result
   * whatever the delete did. A relocation issued against a server without MOVE
   * can therefore report success with the message still in the Inbox, and on a
   * server without UIDPLUS the emulation's EXPUNGE is a bare one, which
   * removes every `\Deleted` message in the mailbox rather than the one being
   * moved. The mailbox is the owner's, so the emulation is not ours to take.
   */
  readonly capabilities: ReadonlyMap<string, boolean | number>;
  list(options?: ListOptions): Promise<ListResponse[]>;
  search(
    query: SearchObject,
    options?: { readonly uid?: boolean },
  ): Promise<number[] | false>;
  messageFlagsAdd(
    range: SequenceString | number[] | SearchObject,
    flags: string[],
    options?: StoreOptions,
  ): Promise<boolean>;
  messageFlagsRemove(
    range: SequenceString | number[] | SearchObject,
    flags: string[],
    options?: StoreOptions,
  ): Promise<boolean>;
  messageMove(
    range: SequenceString | number[] | SearchObject,
    destination: string,
    options?: { readonly uid?: boolean },
  ): Promise<CopyResponseObject | false>;
}

/** One authenticated session. Reads always; mutates on a writable lock. */
export interface ImapSessionClient extends ImapReadClient, ImapMutationCommands {}

type ImapReadClientFactory = (options: ImapFlowOptions) => ImapSessionClient;

/**
 * Opens one bounded provider session for a trusted IMAP account. DNS and
 * binding metadata are validated before the password is decrypted. The password
 * buffer is owned here and is overwritten on every exit. Reads take a read-only
 * mailbox lock; a thread mutation takes a writable one.
 */
export class ImapFlowReadSessionFactory {
  private readonly dns: MailDnsResolverPort;
  private readonly store: MultiMailAccountStore;
  private readonly createClient: ImapReadClientFactory;
  private readonly now: () => number;
  private readonly operationTimeoutMs: number;

  constructor(options: {
    readonly dns: MailDnsResolverPort;
    readonly store: MultiMailAccountStore;
    readonly createClient?: ImapReadClientFactory;
    readonly now?: () => number;
    readonly operationTimeoutMs?: number;
  }) {
    this.dns = options.dns;
    this.store = options.store;
    this.createClient = options.createClient ?? ((config) => new ImapFlow(config));
    this.now = options.now ?? Date.now;
    const timeout = options.operationTimeoutMs ?? MAX_IMAP_READ_OPERATION_MS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) {
      throw new MailAccountError("account_request_invalid");
    }
    this.operationTimeoutMs = timeout;
  }

  async withSession<T>(
    expected: StoredImapMailAccount,
    signal: AbortSignal,
    operation: (client: ImapSessionClient) => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    const current = await this.store.readAccount(expected.account.accountId);
    if (!sameImapBinding(current, expected)) {
      throw new MailAccountError("account_state_invalid");
    }
    const deadlineAt = this.now() + this.operationTimeoutMs;
    const targets = await this.dns.resolve(
      "imap",
      expected.account.endpoint,
      deadlineAt,
      signal,
    );
    const loaded = await this.store.loadProvisionedAccount(
      expected.account.accountId,
    );
    if (loaded === null || !sameImapBinding(loaded.stored, expected)) {
      loaded?.password.fill(0);
      throw new MailAccountError("account_state_invalid");
    }
    try {
      let lastError: MailAccountError | null = null;
      for (const [index, target] of targets.entries()) {
        if (signal.aborted || this.now() >= deadlineAt) {
          throw new MailAccountError("imap_connection_timeout");
        }
        const remainingTargets = targets.length - index;
        const remainingMs = deadlineAt - this.now();
        const fairTargetBudgetMs = Math.max(
          1,
          Math.floor(remainingMs / remainingTargets),
        );
        const targetDeadlineAt =
          this.now() +
          (index === targets.length - 1
            ? remainingMs
            : Math.min(MAX_IMAP_TARGET_ATTEMPT_MS, fairTargetBudgetMs));
        const attempt = await this.runTarget(
          target,
          expected,
          loaded.password,
          signal,
          Math.min(deadlineAt, targetDeadlineAt, target.expiresAt),
          operation,
        );
        if (attempt.ok) return attempt.value;
        if (attempt.sessionReady || attempt.error.code === "imap_authentication_failed") {
          throw attempt.error;
        }
        if (
          attempt.error.code === "imap_connection_timeout" &&
          (signal.aborted || this.now() >= deadlineAt)
        ) {
          throw attempt.error;
        }
        lastError = preferStableImapError(lastError, attempt.error);
      }
      throw lastError ?? new MailAccountError("imap_connection_failed");
    } finally {
      loaded.password.fill(0);
    }
  }

  private async runTarget<T>(
    target: ValidatedMailDialTarget,
    account: StoredImapMailAccount,
    password: Buffer,
    signal: AbortSignal,
    deadlineAt: number,
    operation: (client: ImapSessionClient) => Promise<T>,
  ): Promise<
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: MailAccountError;
        readonly sessionReady: boolean;
      }
  > {
    const remainingMs = deadlineAt - this.now();
    if (remainingMs < 1) {
      return Object.freeze({
        ok: false,
        error: new MailAccountError("imap_connection_timeout"),
        sessionReady: false,
      });
    }
    const client = this.createClient(
      createReadOptions(target, account.account.username, password, remainingMs),
    );
    client.on("error", () => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let sessionReady = false;
    let sockets:
      | {
          readonly readSocket: ImapOwnedSocket;
          readonly writeSocket: ImapOwnedSocket;
        }
      | undefined;
    try {
      const value = await Promise.race([
        (async () => {
          await client.connect();
          if (client.secureConnection !== true) {
            throw new MailAccountError("imap_tls_failed");
          }
          if (
            client.authenticated !== true &&
            (typeof client.authenticated !== "string" ||
              client.authenticated.length === 0)
          ) {
            throw new MailAccountError("imap_authentication_failed");
          }
          sessionReady = true;
          const result = await operation(client);
          const current = await this.store.readAccount(
            account.account.accountId,
          );
          if (!sameImapBinding(current, account)) {
            throw new MailAccountError("account_state_invalid");
          }
          if (signal.aborted || this.now() >= deadlineAt) {
            throw new MailAccountError("imap_connection_timeout");
          }
          sockets = client.unbind();
          const observedAddress = sockets.readSocket.remoteAddress;
          if (
            typeof observedAddress !== "string" ||
            canonicalizeMailPeerAddress(observedAddress, target.family) !==
              target.address
          ) {
            throw new MailAccountError("imap_connection_failed");
          }
          return result;
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            client.close();
            reject(new MailAccountError("imap_connection_timeout"));
          }, remainingMs);
        }),
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => {
            client.close();
            reject(new MailAccountError("imap_connection_timeout"));
          };
          if (signal.aborted) abortHandler();
          else signal.addEventListener("abort", abortHandler, { once: true });
        }),
      ]);
      return Object.freeze({ ok: true, value });
    } catch (error) {
      // Once authentication succeeded, the caller owns protocol semantics.
      // Preserve its stable provider error instead of misclassifying it as a
      // connection retry that would authenticate against another address.
      if (sessionReady && !(error instanceof MailAccountError)) throw error;
      return Object.freeze({
        ok: false,
        error: mapImapError(error),
        sessionReady,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
      if (sockets) destroyOwnedSockets(sockets);
      else client.close();
    }
  }
}

type ImapVerificationClientFactory = (
  options: ImapFlowOptions,
) => ImapVerificationClient;

export class ImapFlowCredentialVerifier implements ImapCredentialVerifier {
  private readonly dns: MailDnsResolverPort;
  private readonly createClient: ImapVerificationClientFactory;
  private readonly now: () => number;

  constructor(options: {
    readonly dns: MailDnsResolverPort;
    readonly createClient?: ImapVerificationClientFactory;
    readonly now?: () => number;
  }) {
    this.dns = options.dns;
    this.createClient = options.createClient ?? ((config) => new ImapFlow(config));
    this.now = options.now ?? Date.now;
  }

  async verify(request: ImapCredentialVerificationRequest): Promise<void> {
    const targets = await this.dns.resolve(
      "imap",
      request.endpoint,
      request.deadlineAt,
      request.signal,
    );
    let lastError: MailAccountError | null = null;
    for (const [index, target] of targets.entries()) {
      if (this.now() >= request.deadlineAt || request.signal.aborted) {
        throw new MailAccountError("imap_connection_timeout");
      }
      const remainingTargets = targets.length - index;
      const remainingMs = request.deadlineAt - this.now();
      const fairTargetBudgetMs = Math.max(
        1,
        Math.floor(remainingMs / remainingTargets),
      );
      const targetDeadlineAt =
        this.now() +
        (index === targets.length - 1
          ? remainingMs
          : Math.min(MAX_IMAP_TARGET_ATTEMPT_MS, fairTargetBudgetMs));
      try {
        await this.verifyTarget(target, request, targetDeadlineAt);
        return;
      } catch (error) {
        const mapped = mapImapError(error);
        if (mapped.code === "imap_authentication_failed") {
          throw mapped;
        }
        if (
          mapped.code === "imap_connection_timeout" &&
          (request.signal.aborted || this.now() >= request.deadlineAt)
        ) {
          throw mapped;
        }
        lastError = preferStableImapError(lastError, mapped);
      }
    }
    throw lastError ?? new MailAccountError("imap_connection_failed");
  }

  private async verifyTarget(
    target: ValidatedMailDialTarget,
    request: ImapCredentialVerificationRequest,
    targetDeadlineAt: number,
  ): Promise<void> {
    if (request.signal.aborted) {
      throw new MailAccountError("imap_connection_timeout");
    }
    const effectiveDeadline = Math.min(
      request.deadlineAt,
      target.expiresAt,
      targetDeadlineAt,
    );
    const now = this.now();
    if (effectiveDeadline <= now) {
      throw new MailAccountError("imap_connection_timeout");
    }
    const remainingMs = effectiveDeadline - now;
    const client = this.createClient(
      createVerificationOptions(target, request, remainingMs),
    );
    // ImapFlow rejects connect() on socket failures, but this listener also
    // prevents a late EventEmitter error from becoming process-fatal.
    client.on("error", () => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let sockets:
      | {
          readonly readSocket: ImapOwnedSocket;
          readonly writeSocket: ImapOwnedSocket;
        }
      | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            client.close();
            reject(new MailAccountError("imap_connection_timeout"));
          }, remainingMs);
        }),
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => {
            client.close();
            reject(new MailAccountError("imap_connection_timeout"));
          };
          if (request.signal.aborted) {
            abortHandler();
            return;
          }
          request.signal.addEventListener("abort", abortHandler, { once: true });
        }),
      ]);
      if (request.signal.aborted || this.now() >= effectiveDeadline) {
        throw new MailAccountError("imap_connection_timeout");
      }
      if (client.secureConnection !== true) {
        throw new MailAccountError("imap_tls_failed");
      }
      // A server may greet with PREAUTH. ImapFlow then skips the supplied
      // credentials and leaves this public flag false; never save an untested
      // password from that session.
      if (
        client.authenticated !== true &&
        (typeof client.authenticated !== "string" ||
          client.authenticated.length === 0)
      ) {
        throw new MailAccountError("imap_authentication_failed");
      }

      // unbind() is ImapFlow's public socket-ownership handoff. Compression is
      // disabled, so readSocket is the provider socket and exposes Node's public
      // remoteAddress. No private ImapFlow field is inspected.
      sockets = client.unbind();
      const observedAddress = sockets.readSocket.remoteAddress;
      if (
        typeof observedAddress !== "string" ||
        canonicalizeMailPeerAddress(observedAddress, target.family) !==
          target.address
      ) {
        throw new MailAccountError("imap_connection_failed");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortHandler) {
        request.signal.removeEventListener("abort", abortHandler);
      }
      if (sockets) {
        destroyOwnedSockets(sockets);
      } else {
        client.close();
      }
    }
  }
}

export function createVerificationOptions(
  target: ValidatedMailDialTarget,
  request: Pick<ImapCredentialVerificationRequest, "username" | "password">,
  timeoutMs: number,
): ImapFlowOptions {
  const implicitTls = target.tls === "implicit";
  return Object.freeze({
    host: target.address,
    port: target.port,
    secure: implicitTls,
    doSTARTTLS: implicitTls ? false : true,
    servername: target.hostname,
    auth: Object.freeze({
      user: request.username,
      pass: new TextDecoder("utf-8", { fatal: true }).decode(request.password),
    }),
    tls: Object.freeze({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2" as const,
    }),
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableAutoEnable: true,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    maxLineLength: MAX_IMAP_HANDSHAKE_LINE_BYTES,
    maxLiteralSize: MAX_IMAP_HANDSHAKE_LITERAL_BYTES,
  });
}

export function createReadOptions(
  target: ValidatedMailDialTarget,
  username: string,
  password: Buffer,
  timeoutMs: number,
): ImapFlowOptions {
  const implicitTls = target.tls === "implicit";
  return Object.freeze({
    host: target.address,
    port: target.port,
    secure: implicitTls,
    doSTARTTLS: implicitTls ? false : true,
    servername: target.hostname,
    auth: Object.freeze({
      user: username,
      pass: new TextDecoder("utf-8", { fatal: true }).decode(password),
    }),
    tls: Object.freeze({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2" as const,
    }),
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    disableCompression: true,
    disableAutoEnable: true,
    disableBinary: true,
    qresync: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    maxLineLength: MAX_IMAP_HANDSHAKE_LINE_BYTES,
    maxLiteralSize: MAX_IMAP_READ_LITERAL_BYTES,
    maxLockHoldTime: timeoutMs,
  });
}

function destroyOwnedSockets(sockets: {
  readonly readSocket: ImapOwnedSocket;
  readonly writeSocket: ImapOwnedSocket;
}): void {
  const unique = new Set([sockets.readSocket, sockets.writeSocket]);
  for (const socket of unique) {
    socket.once("error", () => undefined);
    socket.destroy();
  }
}

function sameImapBinding(
  value: Awaited<ReturnType<MultiMailAccountStore["readAccount"]>>,
  expected: StoredImapMailAccount,
): value is StoredImapMailAccount {
  return (
    value !== null &&
    value.providerKind === "imap" &&
    value.status === "connected" &&
    value.account.accountId === expected.account.accountId &&
    value.account.emailAddress === expected.account.emailAddress &&
    value.account.endpoint.hostname === expected.account.endpoint.hostname &&
    value.account.endpoint.port === expected.account.endpoint.port &&
    value.account.endpoint.tls === expected.account.endpoint.tls &&
    value.account.username === expected.account.username &&
    value.account.credentialRef.id === expected.account.credentialRef.id &&
    value.account.credentialRef.version === expected.account.credentialRef.version &&
    value.account.transportBindingRef.id ===
      expected.account.transportBindingRef.id &&
    value.account.transportBindingRef.version ===
      expected.account.transportBindingRef.version
  );
}

/**
 * Ranks how much one attempt actually observed. `imap_connection_failed` is the
 * catch-all mapImapError verdict, so it must never replace a classified error
 * from another address. A company-only host commonly answers on neither family:
 * the routable one stays silent while the host has no route for the other, and
 * only the silent-server verdict describes what happened.
 */
function stableImapErrorRank(code: string): number {
  switch (code) {
    case "imap_authentication_failed":
      return 4;
    case "imap_tls_failed":
      return 3;
    case "imap_connection_timeout":
      return 2;
    case "imap_connection_failed":
      return 0;
    default:
      return 1;
  }
}

/** Keeps the first, most specific verdict across one validated answer set. */
function preferStableImapError(
  current: MailAccountError | null,
  next: MailAccountError,
): MailAccountError {
  if (current === null) return next;
  return stableImapErrorRank(next.code) > stableImapErrorRank(current.code)
    ? next
    : current;
}

function mapImapError(error: unknown): MailAccountError {
  if (error instanceof MailAccountError) return error;
  // ImapFlow 1.4.7 declares AuthenticationFailure as a package export, but its
  // CommonJS entry only exports ImapFlow. The error's documented own boolean
  // marker is stable and avoids a broken runtime instanceof check.
  if (ownDataProperty(error, "authenticationFailed") === true) {
    return new MailAccountError("imap_authentication_failed");
  }
  if (
    typeof ownDataProperty(error, "code") === "string" &&
    [
      "CONNECT_TIMEOUT",
      "GREETING_TIMEOUT",
      "ETIMEOUT",
      "ETIMEDOUT",
      "ERR_SOCKET_CONNECTION_TIMEOUT",
    ].includes(ownDataProperty(error, "code") as string)
  ) {
    return new MailAccountError("imap_connection_timeout");
  }
  if (error !== null && typeof error === "object") {
    const rawCode = ownDataProperty(error, "code");
    const code = typeof rawCode === "string" ? rawCode : "";
    if (
      ownDataProperty(error, "tlsFailed") === true ||
      code.startsWith("ERR_TLS_") ||
      code.startsWith("ERR_SSL_") ||
      [
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "STARTTLS_INJECTION",
        "UNABLE_TO_GET_ISSUER_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UPGRADE_TIMEOUT",
      ].includes(code)
    ) {
      return new MailAccountError("imap_tls_failed");
    }
  }
  return new MailAccountError("imap_connection_failed");
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
