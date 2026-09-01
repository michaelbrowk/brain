import { createHmac } from "node:crypto";
import { Duplex } from "node:stream";

import WebSocket from "ws";

import type {
  SmtpEgressRelayAuthorization,
  SmtpEgressRelayChallenge,
  SmtpEgressTunnelOpenRequest,
  SmtpEgressTunnelProof,
} from "./ports";
import {
  MAIL_RESOURCE_LIMITS,
  SMTP_EGRESS_RELAY_CHALLENGE_TTL_MS,
  canonicalizeSmtpEgressRelayAuthorization,
  createSmtpEgressRelayAuthorizationPayload,
  validateSmtpEgressTunnelOpenRequest,
  validateSmtpEgressTunnelProof,
} from "./security";

const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_SEQUENCE = 0xffff_ffff;
const CLEAN_CLOSE_CODE = 1000;
const PROTOCOL_CLOSE_CODE = 1008;

const CHALLENGE_CONTROL_FIELDS = ["type", "challenge"] as const;
const READY_CONTROL_FIELDS = [
  "type",
  "sessionId",
  "attemptId",
  "resolutionId",
  "address",
  "family",
  "port",
  "remoteAddress",
  "connectedAt",
] as const;
const ACK_CONTROL_FIELDS = ["type", "sequence"] as const;
const ERROR_CONTROL_FIELDS = ["type", "code"] as const;
const EOF_CONTROL_FIELDS = ["type", "sequence"] as const;
const RELAY_ERROR_CODES = new Set([
  "bad_request",
  "auth_failed",
  "auth_replayed",
  "target_rejected",
  "connect_failed",
  "protocol_violation",
  "client_limit",
  "server_limit",
  "deadline_exceeded",
]);

type WebSocketPayload = string | ArrayBuffer | ArrayBufferView;

export interface RelayWebSocket {
  binaryType: string;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary?: boolean) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  send(data: WebSocketPayload, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export type RelayWebSocketFactory = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => RelayWebSocket;

export interface CloudflareEgressClientOptions {
  readonly url: string;
  /** Canonical unpadded base64url encoding of exactly 32 HMAC key bytes. */
  readonly hmacKeyBase64Url: string;
  readonly accessClientId?: string;
  readonly accessClientSecret?: string;
  readonly webSocketFactory?: RelayWebSocketFactory;
  readonly now?: () => number;
}

export interface CloudflareEgressConnection {
  readonly proof: SmtpEgressTunnelProof;
  readonly stream: Duplex;
  readonly closed: Promise<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

type HandshakeState = "challenge" | "ready" | "open";

/** Opens one WebSocket and one relay TCP connection. It never reconnects. */
export async function openCloudflareEgressTunnel(
  request: SmtpEgressTunnelOpenRequest,
  options: CloudflareEgressClientOptions,
): Promise<CloudflareEgressConnection> {
  const now = options.now ?? Date.now;
  const openedAt = now();
  const validatedRequest = validateSmtpEgressTunnelOpenRequest(request, openedAt);
  if (validatedRequest.transport !== "authenticated_byte_relay") {
    throw new Error("Cloudflare egress requires authenticated byte relay transport");
  }
  const url = validateRelayUrl(options.url);
  const hmacKey = decodeHmacKey(options.hmacKeyBase64Url);
  const headers = accessHeaders(options);
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  const socket = factory(url, { headers });
  socket.binaryType = "arraybuffer";

  const connection = new RelayDuplexConnection(
    socket,
    validatedRequest,
    hmacKey,
    now,
    openedAt,
  );
  return connection.open();
}

class RelayDuplexConnection {
  private readonly ready = deferred<CloudflareEgressConnection>();
  private readonly closed = deferred<void>();
  private readonly stream: RelayDuplex;
  private state: HandshakeState = "challenge";
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly socket: RelayWebSocket,
    private readonly request: SmtpEgressTunnelOpenRequest,
    private readonly hmacKey: Buffer,
    private readonly now: () => number,
    openedAt: number,
  ) {
    void this.closed.promise.catch(() => undefined);
    this.stream = new RelayDuplex(socket, request.deadlineAt, now, (error) => {
      this.fail(error);
    });
    // A connection can fail between construction and the caller receiving the
    // stream. Keep that error observable through the rejected open promise.
    this.stream.on("error", () => undefined);
    socket.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    socket.on("error", (error) => this.fail(toError(error, "relay WebSocket failed")));
    socket.on("close", (code) => {
      if (!this.stream.isCleanlyClosed(code)) {
        this.fail(new Error("relay WebSocket closed before both EOF handshakes"));
      } else {
        if (this.timer !== undefined) {
          clearTimeout(this.timer);
          this.timer = undefined;
        }
        this.closed.resolve();
      }
    });
    const handshakeDeadlineAt = Math.min(
      request.deadlineAt,
      openedAt + SMTP_EGRESS_RELAY_CHALLENGE_TTL_MS,
    );
    const delay = handshakeDeadlineAt - now();
    this.timer = setTimeout(
      () => this.fail(new Error("relay absolute deadline exceeded")),
      Math.max(0, delay),
    );
  }

  open(): Promise<CloudflareEgressConnection> {
    return this.ready.promise;
  }

  private onMessage(data: unknown, isBinary?: boolean): void {
    if (this.settled && this.stream.destroyed) return;
    try {
      const binary = isBinary ?? typeof data !== "string";
      if (this.state !== "open") {
        if (binary) {
          throw new Error("relay sent binary DATA before authorization completed");
        }
        this.onHandshakeControl(toText(data));
        return;
      }
      if (binary) {
        this.stream.receiveData(toRelayDataFrame(data));
      } else {
        this.stream.receiveControl(toText(data));
      }
    } catch (error) {
      this.fail(toError(error, "relay protocol violation"));
    }
  }

  private onHandshakeControl(text: string): void {
    const control = parseControl(text);
    if (control.type === "error") {
      throw relayError(control);
    }
    if (this.state === "challenge") {
      assertExactDataProperties(control, CHALLENGE_CONTROL_FIELDS, "relay challenge control");
      if (control.type !== "challenge") {
        throw new Error("relay challenge control is missing");
      }
      // issuedAt/expiresAt belong to the Worker's clock. The Worker owns their
      // freshness gate. Brain bounds receipt with its local five-second timer.
      const challenge = control.challenge as SmtpEgressRelayChallenge;
      const payload = createSmtpEgressRelayAuthorizationPayload(
        this.request,
        challenge,
        this.now(),
      );
      let hmacSha256: string;
      try {
        hmacSha256 = createHmac("sha256", this.hmacKey)
          .update(canonicalizeSmtpEgressRelayAuthorization(payload), "utf8")
          .digest("hex");
      } finally {
        this.hmacKey.fill(0);
      }
      const authorization: SmtpEgressRelayAuthorization = Object.freeze({
        ...payload,
        hmacSha256,
      });
      this.state = "ready";
      this.sendControl({ type: "authorize", authorization });
      return;
    }
    assertExactDataProperties(control, READY_CONTROL_FIELDS, "relay ready control");
    if (control.type !== "ready") throw new Error("relay ready control is missing");
    const proof = validateSmtpEgressTunnelProof(
      this.request,
      {
        transport: "authenticated_byte_relay",
        sessionId: control.sessionId as string,
        attemptId: control.attemptId as string,
        resolutionId: control.resolutionId as string,
        address: control.address as string,
        family: control.family as 4 | 6,
        port: control.port as 465 | 587,
        remoteAddress: control.remoteAddress as string | null,
        connectedAt: control.connectedAt as number,
      },
      this.now(),
    );
    this.state = "open";
    this.settled = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.fail(new Error("relay absolute deadline exceeded")),
      Math.max(0, this.request.deadlineAt - this.now()),
    );
    (this.timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.stream.markReady();
    this.ready.resolve(
      Object.freeze({ proof, stream: this.stream, closed: this.closed.promise }),
    );
  }

  private sendControl(value: object): void {
    this.socket.send(JSON.stringify(value), (error) => {
      if (error) this.fail(toError(error, "relay control send failed"));
    });
  }

  private fail(error: Error): void {
    this.hmacKey.fill(0);
    this.closed.reject(error);
    if (!this.settled) {
      this.settled = true;
      this.ready.reject(error);
    }
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.stream.destroyed) this.stream.destroy(error);
  }
}

class RelayDuplex extends Duplex {
  private ready = false;
  private outboundSequence = 0;
  private inboundSequence = 0;
  private outboundBytes = 0;
  private inboundBytes = 0;
  private outboundAck: Deferred<void> | undefined;
  private outboundAckSequence: number | undefined;
  private pendingInbound:
    | { readonly sequence: number; readonly payload: Buffer; readonly delivered: boolean }
    | undefined;
  private readRequested = false;
  private clientEofSent = false;
  private clientEofAcked = false;
  private serverEofReceived = false;
  private serverEofAckSent = false;
  private expectedSocketClose = false;
  private finalCallback: ((error?: Error | null) => void) | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly socket: RelayWebSocket,
    deadlineAt: number,
    now: () => number,
    private readonly onProtocolError: (error: Error) => void,
  ) {
    super({ allowHalfOpen: true });
    this.deadlineTimer = setTimeout(
      () => this.abort(new Error("relay absolute deadline exceeded")),
      Math.max(0, deadlineAt - now()),
    );
  }

  markReady(): void {
    this.ready = true;
  }

  isCleanlyClosed(closeCode: number): boolean {
    return (
      closeCode === CLEAN_CLOSE_CODE &&
      this.clientEofAcked &&
      this.serverEofReceived &&
      this.serverEofAckSent
    );
  }

  receiveData(frame: ArrayBuffer): void {
    if (!this.ready || this.serverEofReceived || this.pendingInbound) {
      throw new Error("relay sent DATA while another inbound frame was unacknowledged");
    }
    if (frame.byteLength < 5 || frame.byteLength > 4 + MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes) {
      throw new Error("relay DATA frame size is invalid");
    }
    const sequence = new DataView(frame).getUint32(0, false);
    if (sequence !== this.inboundSequence) {
      throw new Error("relay DATA sequence is duplicate or out of order");
    }
    const payload = Buffer.from(new Uint8Array(frame, 4));
    if (this.inboundBytes + payload.byteLength > MAIL_RESOURCE_LIMITS.egressTunnelServerBytes) {
      throw new Error("relay inbound byte limit exceeded");
    }
    this.inboundBytes += payload.byteLength;
    this.pendingInbound = { sequence, payload, delivered: false };
    this.deliverInboundIfRequested();
  }

  receiveControl(text: string): void {
    const control = parseControl(text);
    if (control.type === "error") throw relayError(control);
    if (control.type === "ack") {
      assertExactDataProperties(control, ACK_CONTROL_FIELDS, "relay ACK control");
      assertSequence(control.sequence);
      if (!this.outboundAck || control.sequence !== this.outboundAckSequence) {
        throw new Error("relay ACK is duplicate or does not match the in-flight frame");
      }
      const ack = this.outboundAck;
      this.outboundAck = undefined;
      this.outboundAckSequence = undefined;
      ack.resolve();
      return;
    }
    if (control.type === "client_eof_ack") {
      assertExactDataProperties(control, EOF_CONTROL_FIELDS, "relay client EOF ACK");
      assertSequence(control.sequence);
      if (!this.clientEofSent || this.clientEofAcked || control.sequence !== this.outboundSequence) {
        throw new Error("relay client EOF ACK is duplicate or out of order");
      }
      this.clientEofAcked = true;
      const callback = this.finalCallback;
      this.finalCallback = undefined;
      callback?.();
      return;
    }
    if (control.type === "server_eof") {
      assertExactDataProperties(control, EOF_CONTROL_FIELDS, "relay server EOF");
      assertSequence(control.sequence);
      if (this.serverEofReceived || this.pendingInbound || control.sequence !== this.inboundSequence) {
        throw new Error("relay server EOF is duplicate or out of order");
      }
      this.serverEofReceived = true;
      this.sendControl(
        { type: "server_eof_ack", sequence: this.inboundSequence },
        () => {
          this.serverEofAckSent = true;
          this.push(null);
        },
      );
      return;
    }
    throw new Error("relay sent an unexpected control frame");
  }

  abort(error: Error): void {
    if (!this.destroyed) this.onProtocolError(error);
  }

  override _read(): void {
    if (this.pendingInbound?.delivered) {
      this.acknowledgeInbound(this.pendingInbound);
    }
    this.readRequested = true;
    this.deliverInboundIfRequested();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void this.writeChunk(chunk).then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.ready || this.clientEofSent) {
      callback(new Error("relay client EOF state is invalid"));
      return;
    }
    this.clientEofSent = true;
    this.finalCallback = callback;
    try {
      this.sendControl({ type: "client_eof", sequence: this.outboundSequence });
    } catch (error) {
      this.finalCallback = undefined;
      callback(toError(error, "relay client EOF failed"));
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.deadlineTimer !== undefined) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = undefined;
    }
    const closed = this.outboundAck;
    this.outboundAck = undefined;
    this.outboundAckSequence = undefined;
    closed?.reject(error ?? new Error("relay stream closed"));
    if (this.finalCallback) {
      const finalCallback = this.finalCallback;
      this.finalCallback = undefined;
      finalCallback(error ?? new Error("relay stream closed before EOF acknowledgement"));
    }
    if (!this.expectedSocketClose) {
      const clean =
        !error &&
        this.clientEofAcked &&
        this.serverEofReceived &&
        this.serverEofAckSent;
      if (!clean) {
        this.expectedSocketClose = true;
        this.socket.close(PROTOCOL_CLOSE_CODE, "protocol error");
      }
    }
    callback(error);
  }

  private async writeChunk(chunk: Buffer): Promise<void> {
    if (!this.ready || this.clientEofSent) throw new Error("relay stream is not writable");
    if (this.outboundBytes + chunk.byteLength > MAIL_RESOURCE_LIMITS.egressTunnelClientBytes) {
      const error = new Error("relay outbound byte limit exceeded");
      this.abort(error);
      throw error;
    }
    this.outboundBytes += chunk.byteLength;
    for (let offset = 0; offset < chunk.byteLength; offset += MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes) {
      const payload = chunk.subarray(
        offset,
        Math.min(chunk.byteLength, offset + MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes),
      );
      await this.sendData(payload);
    }
  }

  private async sendData(payload: Buffer): Promise<void> {
    if (payload.byteLength === 0) return;
    if (this.outboundSequence > MAX_SEQUENCE) throw new Error("relay sequence is exhausted");
    const sequence = this.outboundSequence;
    const frame = Buffer.allocUnsafe(4 + payload.byteLength);
    frame.writeUInt32BE(sequence, 0);
    payload.copy(frame, 4);
    const ack = deferred<void>();
    // A socket send can fail before execution reaches the later await. Keep the
    // deferred rejection observed from the moment it becomes destroy-visible.
    void ack.promise.catch(() => undefined);
    this.outboundAck = ack;
    this.outboundAckSequence = sequence;
    try {
      await new Promise<void>((resolve, reject) => {
        this.socket.send(frame, (error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      const failure = toError(error, "relay DATA send failed");
      if (this.outboundAck === ack) {
        this.outboundAck = undefined;
        this.outboundAckSequence = undefined;
        ack.reject(failure);
      }
      throw failure;
    }
    await ack.promise;
    if (sequence === MAX_SEQUENCE) throw new Error("relay sequence is exhausted");
    this.outboundSequence = sequence + 1;
  }

  private deliverInboundIfRequested(): void {
    if (
      !this.readRequested ||
      !this.pendingInbound ||
      this.pendingInbound.delivered ||
      this.destroyed
    ) {
      return;
    }
    const frame = this.pendingInbound;
    this.readRequested = false;
    if (this.push(frame.payload)) {
      this.acknowledgeInbound(frame);
    } else {
      this.pendingInbound = { ...frame, delivered: true };
    }
  }

  private acknowledgeInbound(frame: { readonly sequence: number }): void {
    this.pendingInbound = undefined;
    this.inboundSequence = incrementSequence(frame.sequence);
    this.sendControl({ type: "ack", sequence: frame.sequence });
  }

  private sendControl(value: object, onSent?: () => void): void {
    this.socket.send(JSON.stringify(value), (error) => {
      if (error) {
        this.abort(toError(error, "relay control send failed"));
      } else {
        onSent?.();
      }
    });
  }

}

function parseControl(text: string): Record<string, unknown> {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CONTROL_BYTES) {
    throw new Error("relay control frame size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("relay control frame is not valid JSON");
  }
  if (!isPlainRecord(value)) throw new Error("relay control frame is invalid");
  return value;
}

function assertExactDataProperties(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} is invalid`);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`${label} contains an unknown field`);
    }
  }
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label} fields must be own data properties`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function relayError(control: Record<string, unknown>): Error {
  assertExactDataProperties(control, ERROR_CONTROL_FIELDS, "relay error control");
  if (control.type !== "error" || typeof control.code !== "string" || !RELAY_ERROR_CODES.has(control.code)) {
    return new Error("relay error control is invalid");
  }
  return new Error(`relay failed with ${control.code}`);
}

function assertSequence(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_SEQUENCE) {
    throw new Error("relay sequence is invalid");
  }
}

function incrementSequence(sequence: number): number {
  if (sequence === MAX_SEQUENCE) throw new Error("relay sequence is exhausted");
  return sequence + 1;
}

function decodeHmacKey(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("relay HMAC key must be canonical base64url for 32 bytes");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("relay HMAC key must be canonical base64url for 32 bytes");
  }
  return bytes;
}

function validateRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relay URL is invalid");
  }
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
    throw new Error("relay URL must be a credential-free wss URL without query or fragment");
  }
  return url.toString();
}

function accessHeaders(options: CloudflareEgressClientOptions): Readonly<Record<string, string>> {
  const { accessClientId, accessClientSecret } = options;
  if ((accessClientId === undefined) !== (accessClientSecret === undefined)) {
    throw new Error("Cloudflare Access credentials must be supplied as a pair");
  }
  if (accessClientId === undefined || accessClientSecret === undefined) return Object.freeze({});
  if (!accessClientId || !accessClientSecret || /[\r\n]/.test(accessClientId + accessClientSecret)) {
    throw new Error("Cloudflare Access credentials are invalid");
  }
  return Object.freeze({
    "CF-Access-Client-Id": accessClientId,
    "CF-Access-Client-Secret": accessClientSecret,
  });
}

const defaultWebSocketFactory: RelayWebSocketFactory = (url, init) =>
  new WebSocket(url, {
    headers: { ...init.headers },
    maxPayload: 4 + MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes,
    perMessageDeflate: false,
  }) as unknown as RelayWebSocket;

function toArrayBuffer(value: unknown): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  throw new Error("relay DATA frame must be binary");
}

function toRelayDataFrame(value: unknown): ArrayBuffer {
  const byteLength = binaryByteLength(value);
  if (
    byteLength === null ||
    byteLength > 4 + MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes
  ) {
    throw new Error("relay DATA frame size is invalid");
  }
  return toArrayBuffer(value);
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  const byteLength = binaryByteLength(value);
  if (byteLength === null || byteLength > MAX_CONTROL_BYTES) {
    throw new Error("relay control frame size is invalid");
  }
  const bytes = new Uint8Array(toArrayBuffer(value));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("relay text control is not valid UTF-8");
  }
}

function binaryByteLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
