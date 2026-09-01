import { connect } from "cloudflare:sockets";

import {
  RELAY_MAX_CLIENT_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_SERVER_BYTES,
  RELAY_SESSION_MS,
  canonicalizeLiteralAddress,
  createRelayChallenge,
  decodeDataFrame,
  encodeAckControl,
  encodeDataFrame,
  encodeEofControl,
  nextSequence,
  parseAckControl,
  parseAuthorizeControl,
  parseControlJson,
  parseEofControl,
  verifyRelayAuthorizationHmac,
  type RelayAuthorization,
  type RelayChallenge,
  type RelayErrorCode,
} from "./protocol";

export interface MailEgressEnv {
  readonly MAIL_EGRESS_ENABLED?: string;
  readonly MAIL_EGRESS_HMAC_KEY?: string;
}

export interface RelayTcpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<{ readonly remoteAddress?: string }>;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface RelayRuntimeDependencies {
  readonly now: () => number;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly connectTcp: (
    address: { readonly hostname: string; readonly port: number },
    options: { readonly secureTransport: "off"; readonly allowHalfOpen: true },
  ) => RelayTcpSocket;
  readonly createWebSocketPair: () => {
    readonly client: WebSocket;
    readonly server: WebSocket;
  };
  readonly scheduleTimer: (handler: () => void, milliseconds: number) => unknown;
  readonly cancelTimer: (handle: unknown) => void;
}

const defaultDependencies: RelayRuntimeDependencies = {
  now: () => Date.now(),
  randomBytes: (size) => {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return bytes;
  },
  connectTcp: (address, options) =>
    connect(address, options) as unknown as RelayTcpSocket,
  createWebSocketPair: () => {
    const pair = new WebSocketPair();
    return { client: pair[0], server: pair[1] };
  },
  scheduleTimer: (handler, milliseconds) => setTimeout(handler, milliseconds),
  cancelTimer: (handle) => clearTimeout(handle as number),
};

export function createMailEgressHandler(
  overrides: Partial<RelayRuntimeDependencies> = {},
): ExportedHandler<MailEgressEnv> {
  const dependencies = Object.freeze({ ...defaultDependencies, ...overrides });
  return {
    fetch(request, env) {
      const url = new URL(request.url);
      if (
        url.pathname !== "/v1/tunnel" ||
        url.search !== "" ||
        env.MAIL_EGRESS_ENABLED !== "true"
      ) {
        return new Response("Not found", { status: 404 });
      }
      if (
        request.method !== "GET" ||
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
      ) {
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      const hmacKey = env.MAIL_EGRESS_HMAC_KEY;
      if (!hmacKey || !/^[A-Za-z0-9_-]{43}$/.test(hmacKey)) {
        return new Response("Mail egress unavailable", { status: 503 });
      }

      const { client, server } = dependencies.createWebSocketPair();
      const startedAt = dependencies.now();
      // Accepted WebSockets keep their own event loop alive. waitUntil is capped at
      // 30 seconds after the HTTP response, shorter than a valid relay session.
      void runRelaySession(server, hmacKey, dependencies, startedAt);
      return new Response(null, { status: 101, webSocket: client });
    },
  };
}

export function runRelaySession(
  webSocket: WebSocket,
  hmacKey: string,
  dependencies: RelayRuntimeDependencies = defaultDependencies,
  startedAt = dependencies.now(),
): Promise<void> {
  return new RelaySession(webSocket, hmacKey, dependencies, startedAt).run();
}

type RelayState = "waiting_authorization" | "authenticating" | "relaying" | "closed";

interface PendingServerAck {
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
}

class RelaySession {
  private state: RelayState = "waiting_authorization";
  private readonly challenge: RelayChallenge;
  private readonly completion: Promise<void>;
  private resolveCompletion!: () => void;
  private timer: unknown;
  private deadlineAt: number;
  private socket: RelayTcpSocket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private nextClientSequence = 0;
  private nextServerSequence = 0;
  private clientBytes = 0;
  private serverBytes = 0;
  private clientWritePending = false;
  private clientEofReceived = false;
  private clientEofAwaitingServerEof = false;
  private clientEofAcknowledged = false;
  private serverEofSent = false;
  private serverReadFailedAwaitingClientEof = false;
  private serverEofAcknowledged = false;
  private pendingServerAck: PendingServerAck | null = null;

  constructor(
    private readonly webSocket: WebSocket,
    private readonly hmacKey: string,
    private readonly dependencies: RelayRuntimeDependencies,
    private readonly startedAt: number,
  ) {
    this.challenge = createRelayChallenge(startedAt, dependencies.randomBytes(32));
    this.deadlineAt = this.challenge.expiresAt;
    this.completion = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  run(): Promise<void> {
    this.webSocket.binaryType = "arraybuffer";
    this.webSocket.accept({ allowHalfOpen: true });
    this.webSocket.addEventListener("message", this.onMessage);
    this.webSocket.addEventListener("close", this.onClose);
    this.webSocket.addEventListener("error", this.onError);
    this.scheduleDeadline(this.challenge.expiresAt);
    try {
      this.webSocket.send(JSON.stringify({ type: "challenge", challenge: this.challenge }));
    } catch {
      this.terminate();
    }
    return this.completion;
  }

  private readonly onMessage = (event: MessageEvent): void => {
    void this.handleMessage(event.data).catch((error: unknown) => {
      if (error instanceof RelayAbort) this.fail(error.code);
      else this.fail("protocol_violation");
    });
  };

  private readonly onClose = (): void => {
    if (this.state !== "closed") this.terminate();
  };

  private readonly onError = (): void => {
    if (this.state !== "closed") this.terminate();
  };

  private async handleMessage(data: unknown): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "authenticating") {
      throw new RelayAbort("auth_replayed");
    }
    if (this.state === "waiting_authorization") {
      this.state = "authenticating";
      if (typeof data !== "string") throw new RelayAbort("auth_failed");
      await this.authorize(data);
      return;
    }
    if (typeof data === "string") {
      await this.handleRelayControl(data);
      return;
    }
    if (!(data instanceof ArrayBuffer)) throw new RelayAbort("protocol_violation");
    await this.handleClientData(data);
  }

  private async authorize(text: string): Promise<void> {
    let authorization: RelayAuthorization;
    try {
      authorization = parseAuthorizeControl(
        text,
        this.challenge,
        this.dependencies.now(),
      ).authorization;
      if (!(await verifyRelayAuthorizationHmac(this.hmacKey, authorization))) {
        throw new Error("invalid relay HMAC");
      }
    } catch {
      throw new RelayAbort("auth_failed");
    }
    if (this.state !== "authenticating") return;
    const authorizedDeadline = Math.min(
      this.startedAt + RELAY_SESSION_MS,
      authorization.deadlineAt,
    );
    if (this.dependencies.now() >= authorizedDeadline) {
      throw new RelayAbort("deadline_exceeded");
    }
    this.scheduleDeadline(authorizedDeadline);

    let socket: RelayTcpSocket;
    let socketInfo: { readonly remoteAddress?: string };
    try {
      socket = this.dependencies.connectTcp(
        { hostname: authorization.address, port: authorization.port },
        { secureTransport: "off", allowHalfOpen: true },
      );
      this.socket = socket;
      // The reader and writer own the observable result. socket.closed can
      // reject before the reader reports a normal remote FIN.
      void socket.closed.catch(() => undefined);
      socketInfo = await socket.opened;
    } catch {
      throw new RelayAbort("connect_failed");
    }
    if (this.state !== "authenticating") {
      void socket.close().catch(() => undefined);
      return;
    }
    if (this.dependencies.now() >= this.deadlineAt) {
      void socket.close().catch(() => undefined);
      throw new RelayAbort("deadline_exceeded");
    }
    const reportedRemoteAddress = socketInfo.remoteAddress ?? null;
    let remoteAddress: string | null = null;
    if (reportedRemoteAddress !== null) {
      const canonicalObservedAddress = canonicalizeLiteralAddress(
        reportedRemoteAddress,
        authorization.family,
      );
      if (canonicalObservedAddress === authorization.address) {
        remoteAddress = authorization.address;
      } else if (
        reportedRemoteAddress !== `${authorization.address}:${authorization.port}`
      ) {
        throw new RelayAbort("target_rejected");
      }
    }

    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.state = "relaying";
    this.webSocket.send(
      JSON.stringify({
        type: "ready",
        sessionId: authorization.sessionId,
        attemptId: authorization.attemptId,
        resolutionId: authorization.resolutionId,
        address: authorization.address,
        family: authorization.family,
        port: authorization.port,
        remoteAddress,
        connectedAt: this.dependencies.now(),
      }),
    );
    void this.pumpServerData().catch((error: unknown) => {
      if (this.state === "closed") return;
      if (error instanceof RelayAbort) this.fail(error.code);
      else {
        this.fail("connect_failed");
      }
    });
  }

  private async handleRelayControl(text: string): Promise<void> {
    const control = parseControlJson(text);
    if (control.type === "ack") {
      const pending = this.pendingServerAck;
      if (!pending) throw new RelayAbort("protocol_violation");
      parseAckControl(text, pending.sequence);
      this.pendingServerAck = null;
      this.nextServerSequence = nextSequence(this.nextServerSequence);
      pending.resolve();
      return;
    }
    if (control.type === "client_eof") {
      if (this.clientEofReceived || this.clientWritePending || !this.writer) {
        throw new RelayAbort("protocol_violation");
      }
      parseEofControl(text, "client_eof", this.nextClientSequence);
      this.clientEofReceived = true;
      try {
        await this.writer.close();
      } catch {
        if (this.state === "closed") return;
        if (!this.serverEofSent) {
          if (this.serverReadFailedAwaitingClientEof) {
            this.sendServerEof();
          } else {
            this.clientEofAwaitingServerEof = true;
            return;
          }
        }
      }
      if (this.state === "closed") return;
      if (this.serverReadFailedAwaitingClientEof && !this.serverEofSent) {
        this.sendServerEof();
      }
      this.acknowledgeClientEof();
      return;
    }
    if (control.type === "server_eof_ack") {
      if (!this.serverEofSent || this.serverEofAcknowledged) {
        throw new RelayAbort("protocol_violation");
      }
      parseEofControl(text, "server_eof_ack", this.nextServerSequence);
      this.serverEofAcknowledged = true;
      this.maybeFinishCleanly();
      return;
    }
    throw new RelayAbort("protocol_violation");
  }

  private async handleClientData(frame: ArrayBuffer): Promise<void> {
    if (this.clientEofReceived || this.clientWritePending || !this.writer) {
      throw new RelayAbort("protocol_violation");
    }
    this.clientWritePending = true;
    try {
      const decoded = decodeDataFrame(frame);
      if (decoded.sequence !== this.nextClientSequence) {
        throw new RelayAbort("protocol_violation");
      }
      if (this.clientBytes + decoded.payload.byteLength > RELAY_MAX_CLIENT_BYTES) {
        throw new RelayAbort("client_limit");
      }
      this.clientBytes += decoded.payload.byteLength;
      try {
        await this.writer.write(decoded.payload);
      } catch {
        throw new RelayAbort("connect_failed");
      }
      if (this.state === "closed") return;
      this.webSocket.send(encodeAckControl(this.nextClientSequence));
      this.nextClientSequence = nextSequence(this.nextClientSequence);
    } finally {
      this.clientWritePending = false;
    }
  }

  private async pumpServerData(): Promise<void> {
    const reader = this.reader;
    if (!reader) throw new RelayAbort("connect_failed");
    while (this.state === "relaying") {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        if (this.isClosed()) return;
        if (this.clientEofReceived) {
          this.sendServerEof();
        } else {
          // Cloudflare can surface a provider's post-QUIT reset as a read
          // rejection. Keep it fail-closed until the authenticated client has
          // completed its write side after validating the SMTP reply.
          this.serverReadFailedAwaitingClientEof = true;
        }
        return;
      }
      const { done, value } = result;
      if (done) {
        this.sendServerEof();
        return;
      }
      if (!(value instanceof Uint8Array)) throw new RelayAbort("connect_failed");
      for (let offset = 0; offset < value.byteLength; offset += RELAY_MAX_FRAME_BYTES) {
        const payload = value.subarray(
          offset,
          Math.min(value.byteLength, offset + RELAY_MAX_FRAME_BYTES),
        );
        if (payload.byteLength === 0) continue;
        if (this.serverBytes + payload.byteLength > RELAY_MAX_SERVER_BYTES) {
          throw new RelayAbort("server_limit");
        }
        this.serverBytes += payload.byteLength;
        await this.sendServerFrame(payload);
      }
    }
  }

  private async sendServerFrame(payload: Uint8Array): Promise<void> {
    if (this.pendingServerAck) throw new RelayAbort("protocol_violation");
    const sequence = this.nextServerSequence;
    const acknowledged = new Promise<void>((resolve, reject) => {
      this.pendingServerAck = { sequence, resolve, reject };
    });
    try {
      this.webSocket.send(encodeDataFrame(sequence, payload));
    } catch {
      this.pendingServerAck = null;
      throw new RelayAbort("protocol_violation");
    }
    await acknowledged;
  }

  private acknowledgeClientEof(): void {
    if (!this.clientEofReceived || this.clientEofAcknowledged) {
      throw new RelayAbort("protocol_violation");
    }
    this.clientEofAwaitingServerEof = false;
    this.clientEofAcknowledged = true;
    this.webSocket.send(
      encodeEofControl("client_eof_ack", this.nextClientSequence),
    );
    this.maybeFinishCleanly();
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  private sendServerEof(): void {
    if (this.serverEofSent) throw new RelayAbort("protocol_violation");
    this.serverReadFailedAwaitingClientEof = false;
    this.serverEofSent = true;
    this.webSocket.send(
      encodeEofControl("server_eof", this.nextServerSequence),
    );
    if (this.clientEofAwaitingServerEof) this.acknowledgeClientEof();
  }

  private maybeFinishCleanly(): void {
    if (this.clientEofAcknowledged && this.serverEofAcknowledged) {
      this.terminate(undefined, true);
    }
  }

  private scheduleDeadline(deadlineAt: number): void {
    if (this.timer !== undefined) this.dependencies.cancelTimer(this.timer);
    this.deadlineAt = deadlineAt;
    this.timer = this.dependencies.scheduleTimer(
      () => this.fail("deadline_exceeded"),
      Math.max(0, deadlineAt - this.dependencies.now()),
    );
  }

  private fail(code: RelayErrorCode): void {
    this.terminate(code, false);
  }

  private terminate(code?: RelayErrorCode, clean = false): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.dependencies.cancelTimer(this.timer);
    const terminationError = new Error(code ?? "relay closed");
    this.pendingServerAck?.reject(terminationError);
    this.pendingServerAck = null;

    if (code) {
      try {
        this.webSocket.send(JSON.stringify({ type: "error", code }));
      } catch {
        // The peer may already be gone.
      }
    }
    try {
      this.webSocket.close(clean ? 1000 : 1008, code ?? "complete");
    } catch {
      // The peer may already be gone.
    }
    this.webSocket.removeEventListener("message", this.onMessage);
    this.webSocket.removeEventListener("close", this.onClose);
    this.webSocket.removeEventListener("error", this.onError);

    const cleanup: Promise<unknown>[] = [];
    if (!clean && this.reader) cleanup.push(this.reader.cancel().catch(() => undefined));
    if (!clean && this.writer) cleanup.push(this.writer.abort().catch(() => undefined));
    if (this.socket) cleanup.push(this.socket.close().catch(() => undefined));
    void Promise.allSettled(cleanup).then(() => this.resolveCompletion());
  }
}

class RelayAbort extends Error {
  constructor(readonly code: RelayErrorCode) {
    super(code);
  }
}

export default createMailEgressHandler();
