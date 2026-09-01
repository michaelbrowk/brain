import net from "node:net";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

import type {
  MailDnsResolverPort,
  MailEndpoint,
  SmtpEgressTunnelOpenRequest,
  SmtpSubmissionHooks,
  SmtpSubmissionOutcome,
  ValidatedMailDialTarget,
} from "../ports";
import {
  MAIL_RESOURCE_LIMITS,
  canonicalizeMailPeerAddress,
  validateMailEndpoint,
  validateSmtpEgressTunnelOpenRequest,
} from "../security";
import {
  openCloudflareEgressTunnel,
  type CloudflareEgressClientOptions,
} from "../cloudflare-egress-client";
import { submitSmtpMessage } from "./smtp-wire";
import { verifySmtpAuthentication } from "./smtp-wire";
import { buildSmtpWireRfc2822 } from "./outbound-message";
import {
  MailAccountError,
  type MailAccountErrorCode,
} from "./account-types";
import type {
  MailSmtpSubmissionAttempt,
  MailSmtpSubmissionTransport,
} from "./smtp-worker";

const MAX_TARGET_ATTEMPT_MS = 10_000;
const DIRECT_CONNECT_TIMEOUT_MS = 10_000;

/** Transport-retryable wire failures that may try the next validated address. */
const NEXT_TARGET_ERROR_CODES = new Set([
  "smtp_connection_failed",
  "smtp_connection_timeout",
  "smtp_connection_closed",
  "smtp_tls_failed",
  "smtp_greeting_rejected",
]);

export interface MailSmtpByteConnection {
  readonly stream: Duplex;
  close(): Promise<void>;
}

/** Opens exactly one validated byte transport for one SMTP attempt. */
export interface MailSmtpConnectionFactory {
  open(request: SmtpEgressTunnelOpenRequest): Promise<MailSmtpByteConnection>;
}

export interface MailSmtpAccess {
  readonly endpoint: MailEndpoint;
  readonly username: string;
  /** Returns caller-owned secret bytes; the transport wipes them after use. */
  readPassword(): Promise<Buffer>;
}

export interface MailSmtpAccessResolver {
  resolveSmtpAccess(accountId: string): Promise<MailSmtpAccess | null>;
}

export interface SmtpCredentialVerifyRequest {
  readonly endpoint: MailEndpoint;
  readonly username: string;
  /** Caller-owned secret bytes; derived wire buffers are wiped internally. */
  readonly password: Buffer;
  readonly deadlineAt: number;
  readonly signal: AbortSignal;
}

export interface SmtpCredentialVerifier {
  verify(request: SmtpCredentialVerifyRequest): Promise<void>;
}

/** AUTH-only verifier over the same pinned DNS and egress path as delivery. */
export class FirstPartySmtpCredentialVerifier
  implements SmtpCredentialVerifier
{
  private readonly now: () => number;

  constructor(
    private readonly options: {
      readonly dns: MailDnsResolverPort;
      readonly connections: MailSmtpConnectionFactory;
      readonly transportKind: "direct" | "authenticated_byte_relay";
      readonly now?: () => number;
      readonly trustedRootCertificates?: readonly string[];
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  async verify(request: SmtpCredentialVerifyRequest): Promise<void> {
    const endpoint = validateMailEndpoint("smtp", request.endpoint);
    if (request.signal.aborted || this.now() >= request.deadlineAt) {
      throw new MailAccountError("smtp_connection_timeout");
    }
    let targets: readonly ValidatedMailDialTarget[];
    try {
      targets = await this.options.dns.resolve(
        "smtp",
        endpoint,
        request.deadlineAt,
        request.signal,
      );
    } catch {
      throw new MailAccountError(
        request.signal.aborted || this.now() >= request.deadlineAt
          ? "smtp_connection_timeout"
          : "smtp_dns_failed",
      );
    }
    let lastError: MailAccountErrorCode = "smtp_connection_failed";
    for (const [index, target] of targets.entries()) {
      if (request.signal.aborted || this.now() >= request.deadlineAt) {
        throw new MailAccountError("smtp_connection_timeout");
      }
      const deadlineAt = Math.min(
        request.deadlineAt,
        target.expiresAt - 1,
        this.now() +
          (index === targets.length - 1
            ? MAIL_RESOURCE_LIMITS.egressTunnelSessionMs
            : MAX_TARGET_ATTEMPT_MS),
      );
      if (deadlineAt <= this.now()) continue;
      const attemptId = `attempt-${randomUUID()}`;
      let connection: MailSmtpByteConnection;
      try {
        connection = await this.options.connections.open({
          transport: this.options.transportKind,
          sessionId: `smtp-verify-${randomUUID()}`,
          attemptId,
          target,
          deadlineAt,
        });
      } catch {
        lastError = "smtp_connection_failed";
        continue;
      }
      try {
        const outcome = await verifySmtpAuthentication({
          connection: connection.stream,
          tls: target.tls,
          servername: target.hostname,
          username: request.username,
          password: request.password,
          deadlineAt,
          now: this.now,
          ...(this.options.trustedRootCertificates
            ? {
                trustedRootCertificates:
                  this.options.trustedRootCertificates,
              }
            : {}),
        });
        if (outcome.kind === "authenticated") return;
        const mapped = mapAuthenticationError(outcome.errorCode);
        if (
          outcome.kind === "transport_error" &&
          NEXT_TARGET_ERROR_CODES.has(outcome.errorCode)
        ) {
          lastError = mapped;
          continue;
        }
        throw new MailAccountError(mapped);
      } finally {
        await connection.close().catch(() => undefined);
      }
    }
    throw new MailAccountError(lastError);
  }
}

function mapAuthenticationError(errorCode: string): MailAccountErrorCode {
  if (errorCode === "smtp_auth_failed" || errorCode === "smtp_auth_deferred") {
    return "smtp_authentication_failed";
  }
  if (errorCode === "smtp_tls_failed") return "smtp_tls_failed";
  if (errorCode === "smtp_connection_timeout") {
    return "smtp_connection_timeout";
  }
  return "smtp_connection_failed";
}

type CreateDirectConnection = (options: {
  readonly host: string;
  readonly port: number;
  readonly family: 4 | 6;
}) => net.Socket;

/**
 * Direct pinned-IP dial path. The open request passes the exact security
 * boundary in lib/mail/security.ts, the socket dials the validated literal
 * address, and the observed remote address must match it before any byte is
 * exchanged. TLS and the SMTP protocol run above this transport in smtp-wire.
 */
export class DirectSmtpConnectionFactory implements MailSmtpConnectionFactory {
  private readonly createConnection: CreateDirectConnection;
  private readonly now: () => number;

  constructor(options?: {
    readonly createConnection?: CreateDirectConnection;
    readonly now?: () => number;
  }) {
    this.createConnection =
      options?.createConnection ??
      ((target) =>
        net.connect({
          host: target.host,
          port: target.port,
          family: target.family,
          noDelay: true,
        }));
    this.now = options?.now ?? Date.now;
  }

  async open(
    request: SmtpEgressTunnelOpenRequest,
  ): Promise<MailSmtpByteConnection> {
    const validated = validateSmtpEgressTunnelOpenRequest(request, this.now());
    if (validated.transport !== "direct") {
      throw new Error("direct SMTP connection factory requires direct transport");
    }
    const { target } = validated;
    const socket = this.createConnection({
      host: target.address,
      port: target.port,
      family: target.family,
    });
    socket.setNoDelay?.(true);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = Math.min(
          DIRECT_CONNECT_TIMEOUT_MS,
          Math.max(1, validated.deadlineAt - this.now()),
        );
        const timer = setTimeout(() => {
          reject(new Error("smtp direct connect timed out"));
        }, timeout);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const observed = socket.remoteAddress;
      if (
        typeof observed !== "string" ||
        canonicalizeMailPeerAddress(observed, target.family) !== target.address
      ) {
        throw new Error("smtp direct connection peer does not match its target");
      }
    } catch (error) {
      socket.destroy();
      throw error;
    }
    return Object.freeze({
      stream: socket,
      close: async () => {
        socket.destroy();
      },
    });
  }
}

/** Authenticated Cloudflare byte relay behind the same connection port. */
export class CloudflareSmtpConnectionFactory implements MailSmtpConnectionFactory {
  constructor(private readonly options: CloudflareEgressClientOptions) {}

  async open(
    request: SmtpEgressTunnelOpenRequest,
  ): Promise<MailSmtpByteConnection> {
    const connection = await openCloudflareEgressTunnel(request, this.options);
    return Object.freeze({
      stream: connection.stream,
      close: async () => {
        connection.stream.destroy();
      },
    });
  }
}

/**
 * Production SMTP submission transport. Every attempt resolves a fresh
 * validated DNS generation, dials targets sequentially without credential
 * spray, runs the first-party wire engine over the opened byte transport, and
 * stops advancing to another target as soon as a definite response arrived or
 * the DATA barrier ran.
 */
export class FirstPartySmtpSubmissionTransport
  implements MailSmtpSubmissionTransport
{
  private readonly dns: MailDnsResolverPort;
  private readonly connections: MailSmtpConnectionFactory;
  private readonly access: MailSmtpAccessResolver;
  private readonly transportKind: "direct" | "authenticated_byte_relay";
  private readonly now: () => number;
  private readonly trustedRootCertificates: readonly string[] | undefined;

  constructor(options: {
    readonly dns: MailDnsResolverPort;
    readonly connections: MailSmtpConnectionFactory;
    readonly access: MailSmtpAccessResolver;
    readonly transportKind: "direct" | "authenticated_byte_relay";
    readonly now?: () => number;
    /** Deterministic-test roots only; certificate verification stays on. */
    readonly trustedRootCertificates?: readonly string[];
  }) {
    this.dns = options.dns;
    this.connections = options.connections;
    this.access = options.access;
    this.transportKind = options.transportKind;
    this.now = options.now ?? Date.now;
    this.trustedRootCertificates = options.trustedRootCertificates;
  }

  async submit(
    attempt: MailSmtpSubmissionAttempt,
    hooks: SmtpSubmissionHooks,
  ): Promise<SmtpSubmissionOutcome> {
    const access = await this.access.resolveSmtpAccess(attempt.accountId);
    if (access === null) {
      return Object.freeze({
        kind: "transport_error",
        deliveryRisk: "none",
        errorCode: "smtp_account_unavailable",
      });
    }
    const endpoint = validateMailEndpoint("smtp", access.endpoint);
    let targets: readonly ValidatedMailDialTarget[];
    try {
      targets = await this.dns.resolve(
        "smtp",
        endpoint,
        attempt.deadlineAt,
        attempt.signal,
      );
    } catch {
      return Object.freeze({
        kind: "transport_error",
        deliveryRisk: "none",
        errorCode: "smtp_dns_failed",
      });
    }
    let wireRaw: Buffer | null = null;
    let password: Buffer | null = null;
    try {
      wireRaw = buildSmtpWireRfc2822(attempt.raw);
      password = await access.readPassword();
      let lastOutcome: SmtpSubmissionOutcome | null = null;
      for (const [index, target] of targets.entries()) {
        if (attempt.signal.aborted || this.now() >= attempt.deadlineAt) break;
        const targetDeadlineAt = this.targetDeadline(
          attempt.deadlineAt,
          target,
          index === targets.length - 1,
        );
        if (targetDeadlineAt <= this.now()) continue;
        const outcome = await this.submitToTarget(
          Object.freeze({ ...attempt, raw: wireRaw }),
          hooks,
          target,
          access.username,
          password,
          targetDeadlineAt,
        );
        if (
          outcome.kind === "transport_error" &&
          outcome.deliveryRisk === "none" &&
          NEXT_TARGET_ERROR_CODES.has(outcome.errorCode)
        ) {
          lastOutcome = outcome;
          continue;
        }
        return outcome;
      }
      return (
        lastOutcome ??
        Object.freeze({
          kind: "transport_error" as const,
          deliveryRisk: "none" as const,
          errorCode: "smtp_connection_failed",
        })
      );
    } finally {
      password?.fill(0);
      wireRaw?.fill(0);
    }
  }

  private targetDeadline(
    deadlineAt: number,
    target: ValidatedMailDialTarget,
    isFinal: boolean,
  ): number {
    const absolute = Math.min(
      deadlineAt,
      target.expiresAt - 1,
      this.now() + MAIL_RESOURCE_LIMITS.egressTunnelSessionMs,
    );
    if (isFinal) return absolute;
    return Math.min(absolute, this.now() + MAX_TARGET_ATTEMPT_MS);
  }

  private async submitToTarget(
    attempt: MailSmtpSubmissionAttempt,
    hooks: SmtpSubmissionHooks,
    target: ValidatedMailDialTarget,
    username: string,
    password: Buffer,
    deadlineAt: number,
  ): Promise<SmtpSubmissionOutcome> {
    let connection: MailSmtpByteConnection;
    try {
      connection = await this.connections.open({
        transport: this.transportKind,
        sessionId: `smtp-s-${randomUUID()}`,
        attemptId: attempt.attemptId,
        target,
        deadlineAt,
      });
    } catch {
      return Object.freeze({
        kind: "transport_error",
        deliveryRisk: "none",
        errorCode: "smtp_connection_failed",
      });
    }
    try {
      return await submitSmtpMessage(
        {
          connection: connection.stream,
          tls: target.tls,
          servername: target.hostname,
          username,
          password,
          deadlineAt,
          now: this.now,
          ...(this.trustedRootCertificates
            ? { trustedRootCertificates: this.trustedRootCertificates }
            : {}),
        },
        { envelope: attempt.envelope, raw: attempt.raw },
        hooks,
      );
    } finally {
      await connection.close().catch(() => undefined);
    }
  }
}
