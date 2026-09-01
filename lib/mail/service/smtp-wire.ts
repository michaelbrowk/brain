import type { Duplex } from "node:stream";
import tls from "node:tls";

import type {
  MailEnvelope,
  MailTlsMode,
  SmtpRecipientRejection,
  SmtpSubmissionHooks,
  SmtpSubmissionOutcome,
} from "../ports";
import { MAIL_RESOURCE_LIMITS, admitOutgoingRawMessage } from "../security";

const MAX_REPLY_LINE_BYTES = 1_000;
const MAX_REPLY_LINES = 64;
const PHASE_TIMEOUT_MS = 15_000;
const QUIT_TIMEOUT_MS = 2_000;
const CRLF = "\r\n";
const SAFE_SMTP_ADDRESS = /^[^<>\s@]+@[^<>\s@]+$/;

/**
 * First-party SMTP Submission engine over one caller-supplied byte transport
 * (a direct pinned-IP socket or the authenticated relay stream). It owns the
 * protocol state machine only: DNS pinning, endpoint validation, and tunnel
 * authentication happen before this module, through lib/mail/security.ts.
 *
 * TLS policy: implicit TLS wraps the transport before the greeting; STARTTLS
 * requires the advertised capability, rejects any pre-upgrade buffered bytes
 * (STARTTLS injection), and re-issues EHLO after the handshake. Certificate
 * verification is always on and authentication happens only after verified
 * TLS. Every read and write is bounded by a phase timeout and the caller's
 * absolute deadline, and total server bytes are capped.
 */
export interface SmtpWireOptions {
  readonly connection: Duplex;
  readonly tls: MailTlsMode;
  /** Original account hostname, used for SNI and certificate verification. */
  readonly servername: string;
  readonly username: string;
  /** Caller-owned secret bytes. This module wipes only its derived copies. */
  readonly password: Buffer;
  readonly deadlineAt: number;
  readonly ehloHostname?: string;
  readonly now?: () => number;
  /**
   * Additional trusted roots for deterministic tests. Verification itself is
   * never disabled; production callers must leave this unset.
   */
  readonly trustedRootCertificates?: readonly string[];
}

export interface SmtpWireSubmission {
  readonly envelope: MailEnvelope;
  /** Caller-owned raw RFC 2822 bytes. The caller wipes them after use. */
  readonly raw: Buffer;
}

export type SmtpAuthenticationOutcome =
  | Readonly<{ readonly kind: "authenticated" }>
  | Exclude<SmtpSubmissionOutcome, { readonly kind: "accepted" }>;

class SmtpWireFailure extends Error {
  constructor(
    readonly errorCode: string,
    readonly deliveryRisk: "none" | "possible",
  ) {
    super(errorCode);
    this.name = "SmtpWireFailure";
  }
}

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** Buffered bounded reader/writer over the active (possibly TLS) stream. */
class SmtpChannel {
  private stream: Duplex;
  private buffered = Buffer.alloc(0);
  private inboundBytes = 0;
  private failure: Error | null = null;
  private ended = false;
  private wake: (() => void) | null = null;
  private readonly onData = (chunk: Buffer) => this.receive(chunk);
  private readonly onError = (error: unknown) =>
    this.fail(
      error instanceof Error ? error : new Error("smtp transport failed"),
    );
  private readonly onClose = () => {
    this.ended = true;
    this.wakeReader();
  };

  constructor(
    stream: Duplex,
    private readonly now: () => number,
    private riskRef: { risk: "none" | "possible" },
  ) {
    this.stream = stream;
    this.attach(stream);
  }

  private attach(stream: Duplex): void {
    stream.on("data", this.onData);
    stream.on("error", this.onError);
    stream.on("end", this.onClose);
    stream.on("close", this.onClose);
  }

  private detach(stream: Duplex): void {
    stream.off("data", this.onData);
    stream.off("error", this.onError);
    stream.off("end", this.onClose);
    stream.off("close", this.onClose);
  }

  private receive(chunk: Buffer): void {
    this.inboundBytes += chunk.byteLength;
    if (
      this.inboundBytes > MAIL_RESOURCE_LIMITS.egressTunnelServerBytes ||
      this.buffered.byteLength + chunk.byteLength >
        MAIL_RESOURCE_LIMITS.egressTunnelServerBytes
    ) {
      this.fail(new SmtpWireFailure("smtp_response_too_large", this.riskRef.risk));
      return;
    }
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.wakeReader();
  }

  private fail(error: Error): void {
    if (this.failure === null) this.failure = error;
    this.wakeReader();
    this.stream.destroy();
  }

  private wakeReader(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /**
   * Hands the raw stream to a TLS upgrade. Any bytes the server pushed before
   * the upgrade are a STARTTLS injection and fail closed.
   */
  beginTlsUpgrade(): Duplex {
    if (this.failure) throw this.failure;
    if (this.buffered.byteLength !== 0) {
      throw new SmtpWireFailure("smtp_starttls_injection", this.riskRef.risk);
    }
    const stream = this.stream;
    this.detach(stream);
    return stream;
  }

  /** Continues the channel over the verified TLS socket. */
  completeTlsUpgrade(secured: Duplex): void {
    this.stream = secured;
    this.attach(secured);
  }

  async readLine(deadlineAt: number): Promise<string> {
    while (true) {
      if (this.failure) throw this.failure;
      const index = this.buffered.indexOf(0x0a);
      if (index !== -1) {
        const line = this.buffered.subarray(0, index + 1);
        this.buffered = this.buffered.subarray(index + 1);
        if (
          line.byteLength > MAX_REPLY_LINE_BYTES ||
          line.byteLength < 2 ||
          line[line.byteLength - 2] !== 0x0d
        ) {
          throw new SmtpWireFailure("smtp_response_invalid", this.riskRef.risk);
        }
        return line.subarray(0, line.byteLength - 2).toString("latin1");
      }
      if (this.buffered.byteLength > MAX_REPLY_LINE_BYTES) {
        throw new SmtpWireFailure("smtp_response_invalid", this.riskRef.risk);
      }
      if (this.ended) {
        throw new SmtpWireFailure("smtp_connection_closed", this.riskRef.risk);
      }
      await this.waitForActivity(deadlineAt);
    }
  }

  private async waitForActivity(deadlineAt: number): Promise<void> {
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) {
      this.fail(
        new SmtpWireFailure("smtp_connection_timeout", this.riskRef.risk),
      );
      throw this.failure;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.wake === wake) this.wake = null;
        resolve();
      }, remaining);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.wake = wake;
    });
  }

  async write(bytes: Buffer, deadlineAt: number): Promise<void> {
    if (this.failure) throw this.failure;
    const remaining = deadlineAt - this.now();
    if (remaining <= 0) {
      throw new SmtpWireFailure("smtp_connection_timeout", this.riskRef.risk);
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeout = new SmtpWireFailure(
          "smtp_connection_timeout",
          this.riskRef.risk,
        );
        this.fail(timeout);
        reject(timeout);
      }, remaining);
      this.stream.write(bytes, (error) => {
        clearTimeout(timer);
        if (error) {
          reject(
            this.failure ??
              new SmtpWireFailure("smtp_connection_closed", this.riskRef.risk),
          );
        } else {
          resolve();
        }
      });
    });
    if (this.failure) throw this.failure;
  }

  destroy(): void {
    this.detach(this.stream);
    this.stream.destroy();
  }
}

export async function submitSmtpMessage(
  options: SmtpWireOptions,
  submission: SmtpWireSubmission,
  hooks: SmtpSubmissionHooks,
): Promise<SmtpSubmissionOutcome> {
  const now = options.now ?? Date.now;
  validateWireOptions(options, now());
  const envelope = validateWireEnvelope(submission.envelope);
  admitOutgoingRawMessage(submission.raw.byteLength);
  const deadlineAt = Math.min(options.deadlineAt, hooks.deadlineAt);
  const riskRef: { risk: "none" | "possible" } = { risk: "none" };
  const channel = new SmtpChannel(options.connection, now, riskRef);
  let barrierError: unknown = null;
  try {
    if (options.tls === "implicit") {
      await upgradeTls(channel, options, now, deadlineAt, riskRef);
    }
    const greeting = await readReply(channel, phaseDeadline(now, deadlineAt));
    if (greeting.code !== 220) {
      return transportError("smtp_greeting_rejected", riskRef.risk);
    }

    const ehloHostname = validateEhloHostname(
      options.ehloHostname ?? "brain-mail.invalid",
    );
    let capabilities = await ehlo(channel, ehloHostname, now, deadlineAt);
    if (capabilities === null) {
      return transportError("smtp_ehlo_rejected", riskRef.risk);
    }

    if (options.tls === "starttls") {
      if (!capabilities.has("STARTTLS")) {
        return transportError("smtp_starttls_unavailable", riskRef.risk);
      }
      await writeCommand(channel, "STARTTLS", now, deadlineAt);
      const upgrade = await readReply(channel, phaseDeadline(now, deadlineAt));
      if (upgrade.code !== 220) {
        return transportError("smtp_starttls_rejected", riskRef.risk);
      }
      await upgradeTls(channel, options, now, deadlineAt, riskRef);
      capabilities = await ehlo(channel, ehloHostname, now, deadlineAt);
      if (capabilities === null) {
        return transportError("smtp_ehlo_rejected", riskRef.risk);
      }
    }

    // Authentication happens only on this side of verified TLS.
    const authOutcome = await authenticate(
      channel,
      capabilities,
      options,
      now,
      deadlineAt,
    );
    if (authOutcome !== null) return authOutcome;

    await writeCommand(channel, `MAIL FROM:<${envelope.from}>`, now, deadlineAt);
    const mailReply = await readReply(channel, phaseDeadline(now, deadlineAt));
    if (mailReply.code !== 250) {
      return definiteRejection(mailReply.code, "smtp_sender", riskRef.risk);
    }

    const acceptedRecipients: string[] = [];
    const rejectedRecipients: SmtpRecipientRejection[] = [];
    for (const address of [
      ...envelope.to,
      ...envelope.cc,
      ...envelope.bcc,
    ]) {
      await writeCommand(channel, `RCPT TO:<${address}>`, now, deadlineAt);
      const reply = await readReply(channel, phaseDeadline(now, deadlineAt));
      if (reply.code === 250 || reply.code === 251) {
        acceptedRecipients.push(address);
      } else if (reply.code >= 400 && reply.code <= 599) {
        rejectedRecipients.push(
          Object.freeze({
            address,
            responseCode: reply.code,
            retryable: reply.code < 500,
            errorCode:
              reply.code < 500
                ? "smtp_recipient_deferred"
                : "smtp_recipient_rejected",
          }),
        );
      } else {
        return transportError("smtp_response_invalid", riskRef.risk);
      }
    }
    if (acceptedRecipients.length === 0) {
      const retryable = rejectedRecipients.find((entry) => entry.retryable);
      const representative = retryable ?? rejectedRecipients[0];
      if (!representative) {
        return transportError("smtp_response_invalid", riskRef.risk);
      }
      return Object.freeze({
        kind: "rejected",
        responseCode: representative.responseCode,
        retryable: representative.retryable,
        errorCode:
          representative.retryable === true
            ? "smtp_recipients_deferred"
            : "smtp_recipients_rejected",
      });
    }

    await writeCommand(channel, "DATA", now, deadlineAt);
    const dataReply = await readReply(channel, phaseDeadline(now, deadlineAt));
    if (dataReply.code !== 354) {
      return definiteRejection(dataReply.code, "smtp_data", riskRef.risk);
    }

    // Durable barrier: delivery risk must be persisted before the first DATA
    // byte can leave the process. A failed barrier aborts without sending.
    try {
      await hooks.beforeData();
    } catch (error) {
      barrierError = error ?? new Error("smtp delivery-risk barrier failed");
      throw barrierError;
    }
    riskRef.risk = "possible";

    const stuffed = dotStuff(submission.raw);
    try {
      await channel.write(stuffed, phaseDeadline(now, deadlineAt));
    } finally {
      stuffed.fill(0);
    }
    const finalReply = await readReply(channel, phaseDeadline(now, deadlineAt));
    if (finalReply.code === 250) {
      await quitQuietly(channel, now);
      return Object.freeze({
        kind: "accepted",
        responseCode: 250,
        acceptedRecipients: Object.freeze(acceptedRecipients),
        rejectedRecipients: Object.freeze(rejectedRecipients),
      });
    }
    // A definite error reply to the final dot is a definite non-delivery.
    return definiteRejection(finalReply.code, "smtp_message", "none");
  } catch (error) {
    if (error === barrierError) throw error;
    if (error instanceof SmtpWireFailure) {
      return transportError(error.errorCode, error.deliveryRisk);
    }
    return transportError("smtp_connection_failed", riskRef.risk);
  } finally {
    channel.destroy();
  }
}

/**
 * Performs the complete TLS + EHLO + AUTH handshake and stops before MAIL
 * FROM. Account setup uses this to prove credentials without ever creating or
 * delivering a message.
 */
export async function verifySmtpAuthentication(
  options: SmtpWireOptions,
): Promise<SmtpAuthenticationOutcome> {
  const now = options.now ?? Date.now;
  const riskRef: { risk: "none" | "possible" } = { risk: "none" };
  let channel: SmtpChannel | null = null;
  try {
    validateWireOptions(options, now());
    const deadlineAt = options.deadlineAt;
    channel = new SmtpChannel(options.connection, now, riskRef);
    if (options.tls === "implicit") {
      await upgradeTls(channel, options, now, deadlineAt, riskRef);
    }
    const greeting = await readReply(channel, phaseDeadline(now, deadlineAt));
    if (greeting.code !== 220) {
      return transportError("smtp_greeting_rejected", "none") as Exclude<
        SmtpSubmissionOutcome,
        { readonly kind: "accepted" }
      >;
    }
    const ehloHostname = validateEhloHostname(
      options.ehloHostname ?? "brain-mail.invalid",
    );
    let capabilities = await ehlo(channel, ehloHostname, now, deadlineAt);
    if (capabilities === null) {
      return transportError("smtp_ehlo_rejected", "none") as Exclude<
        SmtpSubmissionOutcome,
        { readonly kind: "accepted" }
      >;
    }
    if (options.tls === "starttls") {
      if (!capabilities.has("STARTTLS")) {
        return transportError("smtp_starttls_unavailable", "none") as Exclude<
          SmtpSubmissionOutcome,
          { readonly kind: "accepted" }
        >;
      }
      await writeCommand(channel, "STARTTLS", now, deadlineAt);
      const upgrade = await readReply(channel, phaseDeadline(now, deadlineAt));
      if (upgrade.code !== 220) {
        return transportError("smtp_starttls_rejected", "none") as Exclude<
          SmtpSubmissionOutcome,
          { readonly kind: "accepted" }
        >;
      }
      await upgradeTls(channel, options, now, deadlineAt, riskRef);
      capabilities = await ehlo(channel, ehloHostname, now, deadlineAt);
      if (capabilities === null) {
        return transportError("smtp_ehlo_rejected", "none") as Exclude<
          SmtpSubmissionOutcome,
          { readonly kind: "accepted" }
        >;
      }
    }
    const authOutcome = await authenticate(
      channel,
      capabilities,
      options,
      now,
      deadlineAt,
    );
    if (authOutcome !== null) {
      return authOutcome as Exclude<
        SmtpSubmissionOutcome,
        { readonly kind: "accepted" }
      >;
    }
    await quitQuietly(channel, now);
    return Object.freeze({ kind: "authenticated" });
  } catch (error) {
    if (error instanceof SmtpWireFailure) {
      return transportError(error.errorCode, "none") as Exclude<
        SmtpSubmissionOutcome,
        { readonly kind: "accepted" }
      >;
    }
    return transportError("smtp_connection_failed", "none") as Exclude<
      SmtpSubmissionOutcome,
      { readonly kind: "accepted" }
    >;
  } finally {
    channel?.destroy();
  }
}

async function upgradeTls(
  channel: SmtpChannel,
  options: SmtpWireOptions,
  now: () => number,
  deadlineAt: number,
  riskRef: { risk: "none" | "possible" },
): Promise<void> {
  const plain = channel.beginTlsUpgrade();
  const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const remaining = phaseDeadline(now, deadlineAt) - now();
    if (remaining <= 0) {
      reject(new SmtpWireFailure("smtp_connection_timeout", riskRef.risk));
      return;
    }
    const socket = tls.connect({
      socket: plain,
      servername: options.servername,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(options.trustedRootCertificates
        ? { ca: [...options.trustedRootCertificates] }
        : {}),
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpWireFailure("smtp_connection_timeout", riskRef.risk));
    }, remaining);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      if (socket.authorized !== true) {
        socket.destroy();
        reject(new SmtpWireFailure("smtp_tls_failed", riskRef.risk));
        return;
      }
      resolve(socket);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new SmtpWireFailure("smtp_tls_failed", riskRef.risk));
    });
  });
  channel.completeTlsUpgrade(secured);
}

async function ehlo(
  channel: SmtpChannel,
  ehloHostname: string,
  now: () => number,
  deadlineAt: number,
): Promise<Set<string> | null> {
  await writeCommand(channel, `EHLO ${ehloHostname}`, now, deadlineAt);
  const reply = await readReply(channel, phaseDeadline(now, deadlineAt));
  if (reply.code !== 250) return null;
  const capabilities = new Set<string>();
  for (const line of reply.lines.slice(1)) {
    const keyword = line.split(/[\s=]/, 1)[0]?.toUpperCase() ?? "";
    if (keyword.length > 0) capabilities.add(keyword);
    if (keyword === "AUTH") {
      for (const mechanism of line.slice(4).trim().split(/[\s=]+/)) {
        if (mechanism.length > 0) {
          capabilities.add(`AUTH:${mechanism.toUpperCase()}`);
        }
      }
    }
  }
  return capabilities;
}

/** Returns null on success or the terminal outcome on authentication failure. */
async function authenticate(
  channel: SmtpChannel,
  capabilities: ReadonlySet<string>,
  options: SmtpWireOptions,
  now: () => number,
  deadlineAt: number,
): Promise<SmtpSubmissionOutcome | null> {
  const plain = capabilities.has("AUTH:PLAIN");
  const login = capabilities.has("AUTH:LOGIN");
  if (!plain && !login) {
    return transportError("smtp_auth_unsupported", "none");
  }
  let reply: SmtpReply;
  if (plain) {
    const username = Buffer.from(options.username, "utf8");
    const token = Buffer.concat([
      Buffer.from([0]),
      username,
      Buffer.from([0]),
      options.password,
    ]);
    const line = Buffer.from(`AUTH PLAIN ${token.toString("base64")}${CRLF}`);
    try {
      await channel.write(line, phaseDeadline(now, deadlineAt));
    } finally {
      token.fill(0);
      line.fill(0);
      username.fill(0);
    }
    reply = await readReply(channel, phaseDeadline(now, deadlineAt));
  } else {
    await writeCommand(channel, "AUTH LOGIN", now, deadlineAt);
    const promptUser = await readReply(channel, phaseDeadline(now, deadlineAt));
    if (promptUser.code !== 334) {
      return authOutcome(promptUser.code);
    }
    const userLine = Buffer.from(
      `${Buffer.from(options.username, "utf8").toString("base64")}${CRLF}`,
    );
    try {
      await channel.write(userLine, phaseDeadline(now, deadlineAt));
    } finally {
      userLine.fill(0);
    }
    const promptPassword = await readReply(
      channel,
      phaseDeadline(now, deadlineAt),
    );
    if (promptPassword.code !== 334) {
      return authOutcome(promptPassword.code);
    }
    const passwordLine = Buffer.from(
      `${options.password.toString("base64")}${CRLF}`,
    );
    try {
      await channel.write(passwordLine, phaseDeadline(now, deadlineAt));
    } finally {
      passwordLine.fill(0);
    }
    reply = await readReply(channel, phaseDeadline(now, deadlineAt));
  }
  if (reply.code === 235) return null;
  return authOutcome(reply.code);
}

function authOutcome(code: number): SmtpSubmissionOutcome {
  if (code >= 400 && code <= 499) {
    return Object.freeze({
      kind: "rejected",
      responseCode: code,
      retryable: true,
      errorCode: "smtp_auth_deferred",
    });
  }
  if (code >= 500 && code <= 599) {
    return Object.freeze({
      kind: "rejected",
      responseCode: code,
      retryable: false,
      errorCode: "smtp_auth_failed",
    });
  }
  return transportError("smtp_response_invalid", "none");
}

function definiteRejection(
  code: number,
  prefix: string,
  risk: "none" | "possible",
): SmtpSubmissionOutcome {
  if (code >= 400 && code <= 499) {
    return Object.freeze({
      kind: "rejected",
      responseCode: code,
      retryable: true,
      errorCode: `${prefix}_deferred`,
    });
  }
  if (code >= 500 && code <= 599) {
    return Object.freeze({
      kind: "rejected",
      responseCode: code,
      retryable: false,
      errorCode: `${prefix}_rejected`,
    });
  }
  return transportError("smtp_response_invalid", risk);
}

function transportError(
  errorCode: string,
  deliveryRisk: "none" | "possible",
): SmtpSubmissionOutcome {
  return Object.freeze({ kind: "transport_error", deliveryRisk, errorCode });
}

async function quitQuietly(
  channel: SmtpChannel,
  now: () => number,
): Promise<void> {
  try {
    await channel.write(
      Buffer.from(`QUIT${CRLF}`),
      now() + QUIT_TIMEOUT_MS,
    );
    await channel.readLine(now() + QUIT_TIMEOUT_MS);
  } catch {
    // The submission outcome is already final; QUIT is best effort.
  }
}

async function writeCommand(
  channel: SmtpChannel,
  command: string,
  now: () => number,
  deadlineAt: number,
): Promise<void> {
  if (/[\r\n]/.test(command)) {
    throw new SmtpWireFailure("smtp_command_invalid", "none");
  }
  await channel.write(
    Buffer.from(`${command}${CRLF}`, "utf8"),
    phaseDeadline(now, deadlineAt),
  );
}

async function readReply(
  channel: SmtpChannel,
  deadlineAt: number,
): Promise<SmtpReply> {
  const lines: string[] = [];
  let code: number | null = null;
  while (lines.length < MAX_REPLY_LINES) {
    const line = await channel.readLine(deadlineAt);
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) throw new SmtpWireFailure("smtp_response_invalid", "none");
    const lineCode = Number(match[1]);
    if (code === null) {
      code = lineCode;
    } else if (lineCode !== code) {
      throw new SmtpWireFailure("smtp_response_invalid", "none");
    }
    lines.push(match[3] ?? "");
    if (match[2] === " ") {
      return Object.freeze({ code, lines: Object.freeze(lines) });
    }
  }
  throw new SmtpWireFailure("smtp_response_too_large", "none");
}

function phaseDeadline(now: () => number, deadlineAt: number): number {
  return Math.min(deadlineAt, now() + PHASE_TIMEOUT_MS);
}

/** Escapes leading dots and guarantees CRLF framing plus the final dot. */
function dotStuff(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  const pushLine = (line: Buffer) => {
    if (line.byteLength > 0 && line[0] === 0x2e) {
      parts.push(Buffer.from("."));
    }
    parts.push(line);
  };
  for (let index = 0; index < raw.byteLength; index += 1) {
    if (raw[index] === 0x0a) {
      pushLine(raw.subarray(start, index + 1));
      start = index + 1;
    }
  }
  if (start < raw.byteLength) {
    pushLine(raw.subarray(start));
    parts.push(Buffer.from(CRLF));
  }
  parts.push(Buffer.from(`.${CRLF}`));
  return Buffer.concat(parts);
}

function validateWireOptions(options: SmtpWireOptions, now: number): void {
  if (
    (options.tls !== "implicit" && options.tls !== "starttls") ||
    typeof options.servername !== "string" ||
    options.servername.length === 0 ||
    /\s/.test(options.servername) ||
    typeof options.username !== "string" ||
    options.username.length === 0 ||
    /[\r\n]/.test(options.username) ||
    !Buffer.isBuffer(options.password) ||
    options.password.byteLength === 0 ||
    options.password.includes(0) ||
    !Number.isSafeInteger(options.deadlineAt) ||
    options.deadlineAt <= now
  ) {
    throw new Error("smtp wire options are invalid");
  }
}

function validateEhloHostname(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(value)) {
    throw new Error("smtp EHLO hostname is invalid");
  }
  return value;
}

function validateWireEnvelope(envelope: MailEnvelope): MailEnvelope {
  const recipients = [...envelope.to, ...envelope.cc, ...envelope.bcc];
  if (
    recipients.length === 0 ||
    recipients.length > MAIL_RESOURCE_LIMITS.addressesPerMessage
  ) {
    throw new Error("smtp wire envelope is invalid");
  }
  for (const address of [envelope.from, ...recipients]) {
    if (
      typeof address !== "string" ||
      address.length > 254 ||
      !SAFE_SMTP_ADDRESS.test(address)
    ) {
      throw new Error("smtp wire envelope is invalid");
    }
  }
  return envelope;
}
