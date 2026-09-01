import { Resolver } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import { checkServerIdentity, connect as connectTls, type TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";

import {
  openCloudflareEgressTunnel,
  type CloudflareEgressClientOptions,
} from "../lib/mail/cloudflare-egress-client";
import type {
  SmtpEgressTunnelOpenRequest,
  ValidatedMailDialTarget,
} from "../lib/mail/ports";
import { validateResolvedMailTargets } from "../lib/mail/security";

const PROBE_SESSION_MS = 58_000;
const DNS_LOOKUP_MS = 5_000;
const DNS_MAX_AGE_MS = 5 * 60_000;
const PROBE_TEARDOWN_MARGIN_MS = 10_000;
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_REPLY_LINES = 128;
const MAX_LINE_BYTES = 1_000;
const FORBIDDEN_COMMAND = /^(?:AUTH|MAIL|RCPT|DATA)(?:\s|$)/i;
const EHLO = "EHLO brain-probe.invalid\r\n";
const STARTTLS = "STARTTLS\r\n";
const NOOP = "NOOP\r\n";
const QUIT = "QUIT\r\n";

export interface LiveProbeConfig {
  readonly relay: CloudflareEgressClientOptions;
  readonly hostname: string;
  readonly family: 4 | 6;
  readonly address?: string;
  readonly holdSeconds: 0 | 31;
}

export interface LiveProbeResult {
  readonly port: 465 | 587;
  readonly family: 4 | 6;
  readonly tlsAuthorized: true;
  readonly originalSni: true;
  readonly startTls: boolean;
  readonly heldFor31Seconds: boolean;
  readonly authCommandsSent: 0;
}

export interface WrongHostnameProbeResult {
  readonly port: 587;
  readonly rejectedBeforeAuth: true;
  readonly authCommandsSent: 0;
  readonly errorCode: "ERR_TLS_CERT_ALTNAME_INVALID" | "ERR_SSL_TLSV1_UNRECOGNIZED_NAME";
}

export function readLiveProbeConfig(env: NodeJS.ProcessEnv): LiveProbeConfig {
  const url = requiredEnv(env, "BRAIN_MAIL_EGRESS_URL");
  const literalHmacKey = optionalEnv(env, "BRAIN_MAIL_EGRESS_HMAC_KEY");
  const hmacKeyFile = optionalEnv(env, "BRAIN_MAIL_EGRESS_HMAC_KEY_FILE");
  if (literalHmacKey && hmacKeyFile) throw new ProbeFailure("config_hmac_ambiguous");
  if (literalHmacKey) throw new ProbeFailure("config_hmac_literal_forbidden");
  if (!hmacKeyFile) throw new ProbeFailure("config_hmac_file_missing");
  const hmacKeyBase64Url = readHmacKeyFile(hmacKeyFile);
  const hostname = requiredEnv(env, "BRAIN_MAIL_EGRESS_SMTP_HOST").toLowerCase();
  if (!isHostname(hostname)) throw new ProbeFailure("config_hostname_invalid");
  const familySource = env.BRAIN_MAIL_EGRESS_SMTP_FAMILY ?? "4";
  if (familySource !== "4" && familySource !== "6") {
    throw new ProbeFailure("config_family_invalid");
  }
  const holdSource = env.BRAIN_MAIL_EGRESS_HOLD_SECONDS ?? "0";
  if (holdSource !== "0" && holdSource !== "31") {
    throw new ProbeFailure("config_hold_invalid");
  }
  const accessClientId = optionalEnv(env, "BRAIN_MAIL_EGRESS_ACCESS_CLIENT_ID");
  const accessClientSecret = optionalEnv(env, "BRAIN_MAIL_EGRESS_ACCESS_CLIENT_SECRET");
  if ((accessClientId === undefined) !== (accessClientSecret === undefined)) {
    throw new ProbeFailure("config_access_pair_invalid");
  }
  return Object.freeze({
    relay: Object.freeze({
      url,
      hmacKeyBase64Url,
      ...(accessClientId && accessClientSecret
        ? { accessClientId, accessClientSecret }
        : {}),
    }),
    hostname,
    family: Number(familySource) as 4 | 6,
    address: optionalEnv(env, "BRAIN_MAIL_EGRESS_SMTP_ADDRESS"),
    holdSeconds: Number(holdSource) as 0 | 31,
  });
}

export async function probeImplicitTls(config: LiveProbeConfig): Promise<LiveProbeResult> {
  const opened = await openRelay(config, 465);
  const tlsSocket = await establishTls(opened.stream, config.hostname, opened.deadlineAt);
  const replies = new BoundedReplyReader(tlsSocket, opened.deadlineAt);
  try {
    await expectReply(replies, 220, false);
    await sendCommand(tlsSocket, EHLO, opened.deadlineAt);
    await expectReply(replies, 250, false);
    const quitReply = expectReply(replies, 221, false);
    await closeProbeTlsRelay(
      tlsSocket,
      opened.stream,
      quitReply,
      opened.closed,
      opened.deadlineAt,
    );
    return successResult(465, config, false, false);
  } catch (error) {
    tlsSocket.destroy();
    opened.stream.destroy();
    throw stableFailure(error, "implicit_tls_probe_failed");
  }
}

export async function probeStartTls(config: LiveProbeConfig): Promise<LiveProbeResult> {
  const opened = await openStartTlsTransport(config);
  const tlsSocket = await establishTls(opened.stream, config.hostname, opened.deadlineAt);
  const replies = new BoundedReplyReader(tlsSocket, opened.deadlineAt);
  try {
    await sendCommand(tlsSocket, EHLO, opened.deadlineAt);
    await expectReply(replies, 250, false);
    await optionalHold(tlsSocket, replies, config.holdSeconds, opened.deadlineAt);
    const quitReply = expectReply(replies, 221, false);
    await closeProbeTlsRelay(
      tlsSocket,
      opened.stream,
      quitReply,
      opened.closed,
      opened.deadlineAt,
    );
    return successResult(587, config, true, config.holdSeconds === 31);
  } catch (error) {
    tlsSocket.destroy();
    opened.stream.destroy();
    throw stableFailure(error, "starttls_probe_failed");
  }
}

export async function probeWrongHostname(
  config: LiveProbeConfig,
): Promise<WrongHostnameProbeResult> {
  const opened = await openStartTlsTransport(config);
  const wrongHostname = `invalid-${randomUUID()}.invalid`;
  try {
    const tlsSocket = await establishTls(
      opened.stream,
      wrongHostname,
      opened.deadlineAt,
    );
    tlsSocket.destroy();
    throw new ProbeFailure("wrong_hostname_was_accepted");
  } catch (error) {
    opened.stream.destroy();
    const code = errorCode(error);
    if (
      code !== "ERR_TLS_CERT_ALTNAME_INVALID" &&
      code !== "ERR_SSL_TLSV1_UNRECOGNIZED_NAME"
    ) {
      throw new ProbeFailure("wrong_hostname_not_proven");
    }
    return {
      port: 587,
      rejectedBeforeAuth: true,
      authCommandsSent: 0,
      errorCode: code,
    };
  }
}

async function openStartTlsTransport(
  config: LiveProbeConfig,
): Promise<{
  readonly stream: Duplex;
  readonly closed: Promise<void>;
  readonly deadlineAt: number;
}> {
  const opened = await openRelay(config, 587);
  const replies = new BoundedReplyReader(opened.stream, opened.deadlineAt);
  try {
    await expectReply(replies, 220, false);
    await sendCommand(opened.stream, EHLO, opened.deadlineAt);
    await expectReply(replies, 250, true);
    await sendCommand(opened.stream, STARTTLS, opened.deadlineAt);
    await expectReply(replies, 220, false);
    if (!replies.releaseForTls()) throw new ProbeFailure("starttls_buffer_not_empty");
    return opened;
  } catch (error) {
    opened.stream.destroy();
    throw stableFailure(error, "starttls_negotiation_failed");
  }
}

async function openRelay(
  config: LiveProbeConfig,
  port: 465 | 587,
): Promise<{
  readonly stream: Duplex;
  readonly closed: Promise<void>;
  readonly deadlineAt: number;
}> {
  const target = await resolveTarget(config, port);
  const now = Date.now();
  const deadlineAt = Math.min(now + PROBE_SESSION_MS, target.expiresAt - 1_000);
  if (
    deadlineAt <=
    now + config.holdSeconds * 1_000 + PROBE_TEARDOWN_MARGIN_MS
  ) {
    throw new ProbeFailure("dns_lifetime_too_short");
  }
  const id = randomUUID();
  const request: SmtpEgressTunnelOpenRequest = {
    transport: "authenticated_byte_relay",
    sessionId: `live-${id}`,
    attemptId: `probe-${id}`,
    target,
    deadlineAt,
  };
  try {
    const connection = await openCloudflareEgressTunnel(request, config.relay);
    return {
      stream: connection.stream,
      closed: connection.closed,
      deadlineAt,
    };
  } catch (error) {
    throw stableFailure(error, "relay_open_failed");
  }
}

async function resolveTarget(
  config: LiveProbeConfig,
  port: 465 | 587,
): Promise<ValidatedMailDialTarget> {
  const resolver = new Resolver();
  let answers: ReadonlyArray<{ readonly address: string; readonly ttl: number }>;
  try {
    answers = await withDeadline(
      config.family === 4
        ? resolver.resolve4(config.hostname, { ttl: true })
        : resolver.resolve6(config.hostname, { ttl: true }),
      Date.now() + DNS_LOOKUP_MS,
      "dns_lookup_deadline",
    );
  } catch {
    resolver.cancel();
    throw new ProbeFailure("dns_lookup_failed");
  }
  const resolvedAt = Date.now();
  const ttlMs = Math.max(0, Math.min(...answers.map((answer) => answer.ttl)) * 1_000);
  const targets = validateResolvedMailTargets(
    "smtp",
    {
      hostname: config.hostname,
      port,
      tls: port === 465 ? "implicit" : "starttls",
    },
    {
      resolutionId: `dns-${randomUUID()}`,
      resolvedAt,
      expiresAt: resolvedAt + Math.min(DNS_MAX_AGE_MS, ttlMs),
      addresses: answers.map((answer) => ({
        address: answer.address,
        family: config.family,
      })),
    },
    resolvedAt,
  );
  const selected = config.address
    ? targets.find((target) => target.address === config.address)
    : [...targets].sort((left, right) => left.address.localeCompare(right.address))[0];
  if (!selected) throw new ProbeFailure("dns_address_not_found");
  return selected;
}

async function establishTls(
  stream: Duplex,
  servername: string,
  deadlineAt: number,
): Promise<TLSSocket> {
  const tlsTransport = createTlsRelayTransport(stream);
  const tlsSocket = connectTls({
    socket: tlsTransport,
    servername,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    checkServerIdentity,
  });
  try {
    await waitTlsSecure(tlsSocket, deadlineAt);
  } catch (error) {
    tlsSocket.destroy();
    stream.destroy();
    throw error;
  }
  if (!tlsSocket.authorized || tlsSocket.servername !== servername) {
    tlsSocket.destroy();
    stream.destroy();
    throw new ProbeFailure("tls_identity_not_authorized");
  }
  return tlsSocket;
}

export function createTlsRelayTransport(relayStream: Duplex): Duplex {
  return new TlsRelayTransport(relayStream);
}

class TlsRelayTransport extends Duplex {
  private drainingAfterTls = false;

  constructor(private readonly relayStream: Duplex) {
    super({ allowHalfOpen: true });
    relayStream.on("data", this.onRelayData);
    relayStream.once("end", this.onRelayEnd);
    relayStream.once("error", this.onRelayError);
    relayStream.once("close", this.onRelayClose);
  }

  override _read(): void {
    this.relayStream.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.relayStream.destroyed || this.relayStream.writableEnded) {
      callback(new Error("relay transport is not writable"));
      return;
    }
    this.relayStream.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    // TLSSocket owns only this adapter. The raw relay EOF is sent explicitly
    // after SMTP 221 so a remote-first TLS close cannot truncate the tunnel.
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.relayStream.off("data", this.onRelayData);
    this.relayStream.off("end", this.onRelayEnd);
    this.relayStream.off("error", this.onRelayError);
    this.relayStream.off("close", this.onRelayClose);
    if (!this.relayStream.destroyed && !this.relayStream.readableEnded) {
      this.drainingAfterTls = true;
      this.relayStream.on("data", this.onDrainData);
      this.relayStream.once("end", this.stopDraining);
      this.relayStream.once("close", this.stopDraining);
      this.relayStream.resume();
    }
    callback(error);
  }

  private readonly onRelayData = (chunk: Buffer): void => {
    if (!this.push(chunk)) this.relayStream.pause();
  };

  private readonly onRelayEnd = (): void => {
    this.push(null);
  };

  private readonly onRelayError = (error: Error): void => {
    this.destroy(error);
  };

  private readonly onRelayClose = (): void => {
    if (!this.relayStream.readableEnded && !this.destroyed) {
      this.destroy(new Error("relay transport closed before server EOF"));
    }
  };

  private readonly onDrainData = (): void => undefined;

  private readonly stopDraining = (): void => {
    if (!this.drainingAfterTls) return;
    this.drainingAfterTls = false;
    this.relayStream.off("data", this.onDrainData);
    this.relayStream.off("end", this.stopDraining);
    this.relayStream.off("close", this.stopDraining);
  };
}

class BoundedReplyReader {
  private buffer = Buffer.alloc(0);
  private released = false;

  constructor(
    private readonly stream: Duplex,
    private readonly deadlineAt: number,
  ) {}

  async readReply(): Promise<{ readonly code: number; readonly startTls: boolean }> {
    if (this.released) throw new ProbeFailure("reply_reader_released");
    let expectedCode: number | undefined;
    let startTls = false;
    let totalBytes = 0;
    for (let lineCount = 0; lineCount < MAX_REPLY_LINES; lineCount += 1) {
      const line = await this.readLine();
      totalBytes += line.byteLength + 2;
      if (totalBytes > MAX_REPLY_BYTES || line.byteLength < 4) {
        throw new ProbeFailure("smtp_reply_limit");
      }
      const code = parseReplyCode(line);
      expectedCode ??= code;
      if (code !== expectedCode) throw new ProbeFailure("smtp_reply_code_changed");
      const separator = line[3];
      if (separator !== 0x20 && separator !== 0x2d) {
        throw new ProbeFailure("smtp_reply_separator_invalid");
      }
      if (isStartTlsCapability(line)) startTls = true;
      if (separator === 0x20) return { code, startTls };
    }
    throw new ProbeFailure("smtp_reply_line_limit");
  }

  releaseForTls(): boolean {
    this.released = true;
    return this.buffer.byteLength === 0;
  }

  private async readLine(): Promise<Buffer> {
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const raw = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
        if (line.byteLength > MAX_LINE_BYTES) throw new ProbeFailure("smtp_line_limit");
        return line;
      }
      if (this.buffer.byteLength > MAX_LINE_BYTES) throw new ProbeFailure("smtp_line_limit");
      const chunk = this.stream.read() as Buffer | null;
      if (chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        continue;
      }
      await waitReadable(this.stream, this.deadlineAt);
    }
  }
}

async function expectReply(
  reader: BoundedReplyReader,
  expectedCode: number,
  requireStartTls: boolean,
): Promise<void> {
  const reply = await reader.readReply();
  if (reply.code !== expectedCode) throw new ProbeFailure("smtp_unexpected_reply");
  if (requireStartTls && !reply.startTls) throw new ProbeFailure("starttls_not_advertised");
}

async function optionalHold(
  stream: Duplex,
  replies: BoundedReplyReader,
  seconds: 0 | 31,
  deadlineAt: number,
): Promise<void> {
  for (const intervalMs of probeHeartbeatIntervals(seconds)) {
    await withDeadline(delay(intervalMs), deadlineAt, "hold_deadline");
    await sendCommand(stream, NOOP, deadlineAt);
    await expectReply(replies, 250, false);
  }
}

export function probeHeartbeatIntervals(seconds: 0 | 31): readonly number[] {
  const intervals: number[] = [];
  let remainingMs = seconds * 1_000;
  while (remainingMs > 0) {
    const intervalMs = Math.min(5_000, remainingMs);
    intervals.push(intervalMs);
    remainingMs -= intervalMs;
  }
  return Object.freeze(intervals);
}

export async function closeProbeTlsRelay(
  tlsSocket: TLSSocket,
  relayStream: Duplex,
  quitReply: Promise<void>,
  relayClosed: Promise<void>,
  deadlineAt: number,
): Promise<void> {
  void quitReply.catch(() => undefined);
  void relayClosed.catch(() => undefined);
  const relayCloseConfirmed = withDeadline(
    relayClosed,
    deadlineAt,
    "relay_close_deadline",
  );
  void relayCloseConfirmed.catch(() => undefined);
  if (tlsSocket.destroyed || tlsSocket.writableEnded) {
    throw new ProbeFailure("tls_closed_before_quit");
  }
  const relayReadableEnded = waitReadableEnd(relayStream, deadlineAt);
  void relayReadableEnded.catch(() => undefined);
  const relayFinished = waitWritableFinish(
    relayStream,
    deadlineAt,
    "relay_finish_deadline",
    "relay_closed_before_finish",
  );
  void relayFinished.catch(() => undefined);
  // A complete SMTP 221 is the application-level proof that QUIT crossed TLS.
  // Only then do we half-close the raw relay. The Worker holds a provider reset
  // fail-closed until this authenticated client EOF arrives.
  const onTlsError = () => undefined;
  const releaseTlsGuard = () => {
    tlsSocket.off("error", onTlsError);
    tlsSocket.off("close", releaseTlsGuard);
  };
  tlsSocket.on("error", onTlsError);
  tlsSocket.once("close", releaseTlsGuard);
  try {
    await sendCommand(tlsSocket, QUIT, deadlineAt);
    await quitReply;
    if (!relayStream.writableEnded) relayStream.end();
    await Promise.all([
      relayFinished,
      relayReadableEnded,
      relayCloseConfirmed,
    ]);
  } finally {
    if (!tlsSocket.destroyed) tlsSocket.destroy();
    if (tlsSocket.closed) releaseTlsGuard();
  }
}

async function sendCommand(stream: Duplex, command: string, deadlineAt: number): Promise<void> {
  if (FORBIDDEN_COMMAND.test(command)) throw new ProbeFailure("forbidden_command");
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      stream.write(command, "ascii", (error) => (error ? reject(error) : resolve()));
    }),
    deadlineAt,
    "smtp_write_deadline",
  );
}

function waitReadable(stream: Duplex, deadlineAt: number): Promise<void> {
  if (stream.destroyed || stream.readableEnded) {
    return Promise.reject(new ProbeFailure("smtp_early_eof"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(onDeadline, Math.max(0, deadlineAt - Date.now()));
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new ProbeFailure("smtp_early_eof"));
    };
    const onClose = () => {
      cleanup();
      reject(new ProbeFailure("smtp_early_eof"));
    };
    const onError = () => {
      cleanup();
      if (stream.readableLength > 0) {
        resolve();
        return;
      }
      reject(new ProbeFailure("smtp_stream_error"));
    };
    function onDeadline() {
      cleanup();
      reject(new ProbeFailure("smtp_read_deadline"));
    }
    stream.once("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function waitTlsSecure(tlsSocket: TLSSocket, deadlineAt: number): Promise<void> {
  if (tlsSocket.destroyed || tlsSocket.closed) {
    return Promise.reject(new ProbeFailure("tls_closed_before_secure"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(onDeadline, Math.max(0, deadlineAt - Date.now()));
    const cleanup = () => {
      clearTimeout(timer);
      tlsSocket.off("secureConnect", onSecure);
      tlsSocket.off("close", onClose);
      tlsSocket.off("error", onError);
    };
    const onSecure = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new ProbeFailure("tls_closed_before_secure"));
    };
    function onDeadline() {
      cleanup();
      reject(new ProbeFailure("tls_deadline"));
    }
    tlsSocket.once("secureConnect", onSecure);
    tlsSocket.once("close", onClose);
    tlsSocket.once("error", onError);
  });
}

function waitWritableFinish(
  stream: Duplex,
  deadlineAt: number,
  deadlineCode: string,
  closeCode: string,
): Promise<void> {
  if (stream.writableFinished) return Promise.resolve();
  if (stream.destroyed) return Promise.reject(new ProbeFailure(closeCode));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(onDeadline, Math.max(0, deadlineAt - Date.now()));
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("finish", onFinish);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ProbeFailure(closeCode));
    };
    const onError = () => {
      cleanup();
      reject(new ProbeFailure(closeCode));
    };
    function onDeadline() {
      cleanup();
      reject(new ProbeFailure(deadlineCode));
    }
    stream.once("finish", onFinish);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function waitReadableEnd(stream: Duplex, deadlineAt: number): Promise<void> {
  if (stream.readableEnded) return Promise.resolve();
  if (stream.destroyed) {
    return Promise.reject(new ProbeFailure("relay_closed_before_server_eof"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(onDeadline, Math.max(0, deadlineAt - Date.now()));
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("end", onEnd);
      stream.off("close", onClose);
      stream.off("error", onError);
    };
    const onEnd = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ProbeFailure("relay_closed_before_server_eof"));
    };
    const onError = () => {
      cleanup();
      reject(new ProbeFailure("relay_closed_before_server_eof"));
    };
    function onDeadline() {
      cleanup();
      reject(new ProbeFailure("relay_server_eof_deadline"));
    }
    stream.once("end", onEnd);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}


async function withDeadline<T>(promise: Promise<T>, deadlineAt: number, code: string): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new ProbeFailure(code);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeFailure(code)), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseReplyCode(line: Buffer): number {
  if (line[0] < 0x30 || line[0] > 0x39 || line[1] < 0x30 || line[1] > 0x39 || line[2] < 0x30 || line[2] > 0x39) {
    throw new ProbeFailure("smtp_reply_code_invalid");
  }
  return (line[0] - 0x30) * 100 + (line[1] - 0x30) * 10 + line[2] - 0x30;
}

function isStartTlsCapability(line: Buffer): boolean {
  const capability = line.subarray(4).toString("ascii").trim().split(/\s+/, 1)[0];
  return capability.toUpperCase() === "STARTTLS";
}

function successResult(
  port: 465 | 587,
  config: LiveProbeConfig,
  startTls: boolean,
  heldFor31Seconds: boolean,
): LiveProbeResult {
  return {
    port,
    family: config.family,
    tlsAuthorized: true,
    originalSni: true,
    startTls,
    heldFor31Seconds,
    authCommandsSent: 0,
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = optionalEnv(env, name);
  if (!value) throw new ProbeFailure(`config_missing_${name.toLowerCase()}`);
  return value;
}

function readHmacKeyFile(path: string): string {
  if (!isAbsolute(path)) throw new ProbeFailure("config_hmac_path_not_absolute");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size < 2 ||
      stat.size > 1_024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new ProbeFailure("config_hmac_file_permissions_invalid");
    }
    const source = readFileSync(descriptor, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new ProbeFailure("config_hmac_file_json_invalid");
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !("MAIL_EGRESS_HMAC_KEY" in value) ||
      typeof value.MAIL_EGRESS_HMAC_KEY !== "string" ||
      !isCanonicalHmacKey(value.MAIL_EGRESS_HMAC_KEY)
    ) {
      throw new ProbeFailure("config_hmac_file_shape_invalid");
    }
    return value.MAIL_EGRESS_HMAC_KEY;
  } catch (error) {
    throw stableFailure(error, "config_hmac_file_unreadable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function isCanonicalHmacKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.includes(".") && value.split(".").every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function stableFailure(error: unknown, fallback: string): ProbeFailure {
  return error instanceof ProbeFailure ? error : new ProbeFailure(fallback);
}

export class ProbeFailure extends Error {
  constructor(readonly stableCode: string) {
    super(stableCode);
    this.name = "ProbeFailure";
  }
}
