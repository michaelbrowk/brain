import { EventEmitter, once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SmtpEgressTunnelOpenRequest } from "./ports";
import { MAIL_RESOURCE_LIMITS } from "./security";
import {
  openCloudflareEgressTunnel,
  type CloudflareEgressClientOptions,
  type RelayWebSocket,
} from "./cloudflare-egress-client";

const NOW = 1_000;
const HMAC_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const CHALLENGE = {
  version: 1,
  audience: "brain-mail-smtp-egress-v1",
  challenge: "a".repeat(64),
  issuedAt: NOW,
  expiresAt: NOW + 5_000,
} as const;
const REQUEST: SmtpEgressTunnelOpenRequest = {
  transport: "authenticated_byte_relay",
  sessionId: "relay-session",
  attemptId: "relay-attempt",
  target: {
    protocol: "smtp",
    hostname: "smtp.example.com",
    port: 465,
    tls: "implicit",
    address: "1.1.1.1",
    family: 4,
    resolutionId: "relay-resolution",
    resolvedAt: NOW,
    expiresAt: 61_000,
  },
  deadlineAt: 31_000,
};

class FakeWebSocket extends EventEmitter implements RelayWebSocket {
  binaryType = "nodebuffer";
  readonly sent: Array<string | Buffer> = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  onSend: ((data: string | Buffer) => void) | undefined;
  failNextSend: Error | undefined;
  deferNextSend = false;
  deferredSendCallback: ((error?: Error) => void) | undefined;

  send(data: string | ArrayBuffer | ArrayBufferView, callback?: (error?: Error) => void): void {
    const stored =
      typeof data === "string"
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(stored);
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      callback?.(error);
      return;
    }
    if (this.deferNextSend) {
      this.deferNextSend = false;
      this.deferredSendCallback = callback;
      this.onSend?.(stored);
      return;
    }
    callback?.();
    this.onSend?.(stored);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }

  serverText(value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    this.emit("message", Buffer.from(text, "utf8"), false);
  }

  serverData(sequence: number, payload: Uint8Array): void {
    const frame = Buffer.alloc(4 + payload.byteLength);
    frame.writeUInt32BE(sequence, 0);
    frame.set(payload, 4);
    this.emit("message", frame, true);
  }
}

interface Opened {
  readonly socket: FakeWebSocket;
  readonly connection: Awaited<ReturnType<typeof openCloudflareEgressTunnel>>;
  readonly authorization: Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Cloudflare SMTP egress client", () => {
  it("signs the fixed challenge with the shared golden HMAC and exact target", async () => {
    const { socket, connection, authorization } = await openConnection();
    expect(authorization).toEqual({
      ...CHALLENGE,
      transport: "authenticated_byte_relay",
      sessionId: REQUEST.sessionId,
      attemptId: REQUEST.attemptId,
      resolutionId: REQUEST.target.resolutionId,
      address: REQUEST.target.address,
      family: REQUEST.target.family,
      port: REQUEST.target.port,
      targetExpiresAt: REQUEST.target.expiresAt,
      deadlineAt: REQUEST.deadlineAt,
      hmacSha256: "3a97c31941f5b7af55317999fee117ed051e589d2ba54d59dfa7fc5bc8096cef",
    });
    expect(connection.proof).toEqual({
      transport: "authenticated_byte_relay",
      sessionId: REQUEST.sessionId,
      attemptId: REQUEST.attemptId,
      resolutionId: REQUEST.target.resolutionId,
      address: REQUEST.target.address,
      family: REQUEST.target.family,
      port: REQUEST.target.port,
      remoteAddress: null,
      connectedAt: NOW,
    });
    connection.stream.destroy();
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("accepts Worker challenge clocks skewed ten seconds in either direction", async () => {
    const brainNow = 20_000;
    for (const workerIssuedAt of [brainNow - 10_000, brainNow + 10_000]) {
      const socket = new FakeWebSocket();
      const opening = openCloudflareEgressTunnel(REQUEST, {
        ...baseOptions(),
        now: () => brainNow,
        webSocketFactory: () => socket,
      });
      socket.serverText({
        type: "challenge",
        challenge: {
          ...CHALLENGE,
          issuedAt: workerIssuedAt,
          expiresAt: workerIssuedAt + 5_000,
        },
      });
      socket.serverText(readyControl({ connectedAt: workerIssuedAt }));
      const connection = await opening;
      connection.stream.destroy();
    }
  });

  it("rejects relay query strings so credentials cannot enter URL observability", async () => {
    await expect(
      openCloudflareEgressTunnel(REQUEST, {
        ...baseOptions(),
        url: "wss://relay.example.test/mail?token=must-not-cross",
        webSocketFactory: () => new FakeWebSocket(),
      }),
    ).rejects.toThrow(/without query/i);
  });

  it("rejects a ready proof for any substituted target", async () => {
    const socket = new FakeWebSocket();
    const opening = beginOpen(socket);
    socket.serverText({ type: "challenge", challenge: CHALLENGE });
    socket.serverText(readyControl({ address: "9.9.9.9" }));
    await expect(opening).rejects.toThrow(/does not match/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("splits writes into sequential 16 KiB DATA frames and waits for exact ACKs", async () => {
    const { socket, connection } = await openConnection();
    socket.sent.length = 0;
    const payload = Buffer.alloc(MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes + 1, 0x5a);
    let writeFinished = false;
    const writing = new Promise<void>((resolve, reject) => {
      connection.stream.write(payload, (error) => {
        writeFinished = true;
        if (error) reject(error);
        else resolve();
      });
    });
    await turn();
    expect(binaryFrames(socket)).toHaveLength(1);
    expect(readSequence(binaryFrames(socket)[0])).toBe(0);
    expect(writeFinished).toBe(false);
    socket.serverText({ type: "ack", sequence: 0 });
    await turn();
    expect(binaryFrames(socket)).toHaveLength(2);
    expect(readSequence(binaryFrames(socket)[1])).toBe(1);
    expect(binaryFrames(socket)[1]).toHaveLength(5);
    expect(writeFinished).toBe(false);
    socket.serverText({ type: "ack", sequence: 1 });
    await writing;
    connection.stream.destroy();
  });

  it("handles a DATA send failure without an unhandled ACK rejection", async () => {
    const { socket, connection } = await openConnection();
    socket.sent.length = 0;
    socket.failNextSend = new Error("network write failed");
    const error = await writeError(connection.stream, Buffer.from([1]));
    expect(error.message).toMatch(/network write failed/i);
    await turn();
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("allows exactly 2 MiB outbound, then fails closed on one extra byte", async () => {
    const { socket, connection } = await openConnection();
    socket.sent.length = 0;
    socket.onSend = (data) => {
      if (Buffer.isBuffer(data)) {
        queueMicrotask(() => socket.serverText({ type: "ack", sequence: readSequence(data) }));
      }
    };
    await write(connection.stream, Buffer.alloc(MAIL_RESOURCE_LIMITS.egressTunnelClientBytes));
    expect(binaryFrames(socket)).toHaveLength(
      MAIL_RESOURCE_LIMITS.egressTunnelClientBytes /
        MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes,
    );
    const error = await writeError(connection.stream, Buffer.from([1]));
    expect(error.message).toMatch(/outbound byte limit/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("does not ACK inbound DATA until _read asks for it", async () => {
    const { socket, connection } = await openConnection();
    socket.sent.length = 0;
    socket.serverData(0, Uint8Array.of(1, 2, 3));
    expect(textControls(socket)).toEqual([]);
    expect(connection.stream.read()).toEqual(Buffer.from([1, 2, 3]));
    expect(textControls(socket)).toContainEqual({ type: "ack", sequence: 0 });
    connection.stream.destroy();
  });

  it("holds ACK after push reaches the read buffer limit until demand resumes", async () => {
    const { socket, connection } = await openConnection();
    socket.sent.length = 0;
    socket.serverData(
      0,
      new Uint8Array(MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes),
    );
    const readable = connection.stream as typeof connection.stream & {
      _read(size: number): void;
    };
    const framesToFillBuffer = Math.ceil(
      readable.readableHighWaterMark / MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes,
    );
    for (let sequence = 0; sequence < framesToFillBuffer; sequence += 1) {
      if (sequence > 0) {
        socket.serverData(
          sequence,
          new Uint8Array(MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes),
        );
      }
      readable._read(MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes);
      const acks = textControls(socket).filter((control) => control.type === "ack");
      expect(acks).toHaveLength(sequence === framesToFillBuffer - 1 ? sequence : sequence + 1);
    }
    expect(readable.read()).toHaveLength(
      framesToFillBuffer * MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes,
    );
    await turn();
    expect(textControls(socket)).toContainEqual({
      type: "ack",
      sequence: framesToFillBuffer - 1,
    });
    connection.stream.destroy();
  });

  it("allows exactly 128 KiB inbound, then rejects one extra byte", async () => {
    const { socket, connection } = await openConnection();
    socket.sent.length = 0;
    connection.stream.resume();
    for (let sequence = 0; sequence < 8; sequence += 1) {
      socket.serverData(
        sequence,
        new Uint8Array(MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes),
      );
      await turn();
    }
    expect(textControls(socket).filter((control) => control.type === "ack")).toHaveLength(8);
    const streamError = once(connection.stream, "error");
    socket.serverData(8, Uint8Array.of(1));
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/inbound byte limit/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("waits for both directional EOF controls before a clean WebSocket close", async () => {
    const { socket, connection } = await openConnection();
    let relayClosed = false;
    void connection.closed.then(() => {
      relayClosed = true;
    });
    socket.sent.length = 0;
    let writableFinished = false;
    connection.stream.end(() => {
      writableFinished = true;
    });
    await turn();
    expect(textControls(socket)).toContainEqual({ type: "client_eof", sequence: 0 });
    expect(writableFinished).toBe(false);
    socket.serverText({ type: "client_eof_ack", sequence: 0 });
    await turn();
    expect(writableFinished).toBe(true);
    expect(socket.closes).toEqual([]);
    const readableEnded = once(connection.stream, "end");
    connection.stream.resume();
    socket.serverText({ type: "server_eof", sequence: 0 });
    await readableEnded;
    expect(textControls(socket)).toContainEqual({ type: "server_eof_ack", sequence: 0 });
    expect(socket.closes).toEqual([]);
    expect(relayClosed).toBe(false);
    socket.emit("close", 1000, Buffer.alloc(0));
    await connection.closed;
    expect(relayClosed).toBe(true);
  });

  it("enforces the absolute deadline and never reconnects", async () => {
    vi.useFakeTimers();
    let factoryCalls = 0;
    const socket = new FakeWebSocket();
    const opening = openCloudflareEgressTunnel(REQUEST, {
      ...baseOptions(),
      webSocketFactory: () => {
        factoryCalls += 1;
        return socket;
      },
    });
    socket.serverText({ type: "challenge", challenge: CHALLENGE });
    socket.serverText(readyControl());
    const connection = await opening;
    const streamError = once(connection.stream, "error");
    await vi.advanceTimersByTimeAsync(REQUEST.deadlineAt - NOW);
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/absolute deadline/i);
    expect(factoryCalls).toBe(1);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("fails closed on malformed, duplicate, and out-of-order frames", async () => {
    const malformed = new FakeWebSocket();
    const malformedOpening = beginOpen(malformed);
    malformed.serverText({ type: "challenge", challenge: { ...CHALLENGE, extra: true } });
    await expect(malformedOpening).rejects.toThrow(/unknown field/i);

    const { socket, connection } = await openConnection();
    const streamError = once(connection.stream, "error");
    socket.serverData(1, Uint8Array.of(1));
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/duplicate or out of order/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("rejects oversized controls and DATA before copying injected WebSocket buffers", async () => {
    const controlSocket = new FakeWebSocket();
    const controlOpening = beginOpen(controlSocket);
    controlSocket.emit("message", Buffer.alloc(8 * 1024 + 1), false);
    await expect(controlOpening).rejects.toThrow(/control frame size/i);
    expect(controlSocket.closes.at(-1)?.code).toBe(1008);

    const { socket, connection } = await openConnection();
    const streamError = once(connection.stream, "error");
    socket.emit(
      "message",
      Buffer.alloc(5 + MAIL_RESOURCE_LIMITS.egressTunnelFrameBytes),
      true,
    );
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/DATA frame size/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("treats WebSocket close before both EOF controls as truncation", async () => {
    const { socket, connection } = await openConnection();
    const streamError = once(connection.stream, "error");
    socket.emit("close", 1000, Buffer.alloc(0));
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/before both EOF/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("treats WebSocket 1000 after only client EOF as truncation", async () => {
    const { socket, connection } = await openConnection();
    connection.stream.end();
    await turn();
    socket.serverText({ type: "client_eof_ack", sequence: 0 });
    await turn();
    const streamError = once(connection.stream, "error");
    socket.emit("close", 1000, Buffer.alloc(0));
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/before both EOF/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("fails closed when the server EOF ACK send callback fails", async () => {
    const { socket, connection } = await openConnection();
    connection.stream.end();
    await turn();
    socket.serverText({ type: "client_eof_ack", sequence: 0 });
    await turn();
    socket.deferNextSend = true;
    connection.stream.resume();
    socket.serverText({ type: "server_eof", sequence: 0 });
    await turn();
    expect(socket.closes).toEqual([]);
    const streamError = once(connection.stream, "error");
    socket.deferredSendCallback?.(new Error("ACK send failed"));
    const [error] = (await streamError) as [Error];
    expect(error.message).toMatch(/ACK send failed/i);
    expect(socket.closes.at(-1)?.code).toBe(1008);
  });

  it("rejects a late WebSocket 1006 after both local EOFs", async () => {
    const { socket, connection } = await openConnection();
    connection.stream.end();
    await turn();
    socket.serverText({ type: "client_eof_ack", sequence: 0 });
    connection.stream.resume();
    socket.serverText({ type: "server_eof", sequence: 0 });
    await turn();
    expect(socket.closes).toEqual([]);
    const closed = expect(connection.closed).rejects.toThrow(/before both EOF/i);
    socket.emit("close", 1006, Buffer.alloc(0));
    await closed;
  });
});

async function openConnection(): Promise<Opened> {
  const socket = new FakeWebSocket();
  const opening = beginOpen(socket);
  socket.serverText({ type: "challenge", challenge: CHALLENGE });
  const authorize = textControls(socket)[0];
  expect(authorize?.type).toBe("authorize");
  const authorization = authorize.authorization as Record<string, unknown>;
  socket.serverText(readyControl());
  return { socket, connection: await opening, authorization };
}

function beginOpen(socket: FakeWebSocket) {
  return openCloudflareEgressTunnel(REQUEST, {
    ...baseOptions(),
    webSocketFactory: () => socket,
  });
}

function baseOptions(): Omit<CloudflareEgressClientOptions, "webSocketFactory"> {
  return {
    url: "wss://relay.example.test/mail",
    hmacKeyBase64Url: HMAC_KEY,
    now: () => NOW,
  };
}

function readyControl(overrides: Record<string, unknown> = {}) {
  return {
    type: "ready",
    sessionId: REQUEST.sessionId,
    attemptId: REQUEST.attemptId,
    resolutionId: REQUEST.target.resolutionId,
    address: REQUEST.target.address,
    family: REQUEST.target.family,
    port: REQUEST.target.port,
    remoteAddress: null,
    connectedAt: NOW,
    ...overrides,
  };
}

function textControls(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

function binaryFrames(socket: FakeWebSocket): Buffer[] {
  return socket.sent.filter((value): value is Buffer => Buffer.isBuffer(value));
}

function readSequence(frame: Buffer): number {
  return frame.readUInt32BE(0);
}

function write(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

function writeError(stream: NodeJS.WritableStream, chunk: Buffer): Promise<Error> {
  return new Promise((resolve) => {
    stream.write(chunk, (error?: Error | null) =>
      resolve(error ?? new Error("write unexpectedly succeeded")),
    );
  });
}

function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
