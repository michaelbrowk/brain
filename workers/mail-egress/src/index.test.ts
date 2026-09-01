import { describe, expect, it, vi } from "vitest";

import {
  createMailEgressHandler,
  runRelaySession,
  type RelayRuntimeDependencies,
  type RelayTcpSocket,
} from "./index";
import {
  canonicalizeRelayAuthorization,
  decodeDataFrame,
  encodeAckControl,
  encodeDataFrame,
  encodeEofControl,
  type RelayAuthorization,
  type RelayChallenge,
} from "./protocol";

const HMAC_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("Mail egress Worker runtime", () => {
  it("stays unavailable until explicitly enabled", async () => {
    const handler = createMailEgressHandler();
    const response = await handler.fetch!(
      new Request("https://relay.example/v1/tunnel", {
        headers: { Upgrade: "websocket" },
      }) as unknown as Parameters<NonNullable<typeof handler.fetch>>[0],
      { MAIL_EGRESS_HMAC_KEY: HMAC_KEY },
      executionContext(),
    );
    expect(response.status).toBe(404);
  });

  it("rejects query strings before creating a WebSocket", async () => {
    const createWebSocketPair = vi.fn(() => {
      throw new Error("must not create a pair");
    });
    const handler = createMailEgressHandler({ createWebSocketPair });
    const response = await handler.fetch!(
      new Request("https://relay.example/v1/tunnel?token=must-not-log", {
        headers: { Upgrade: "websocket" },
      }) as unknown as Parameters<NonNullable<typeof handler.fetch>>[0],
      { MAIL_EGRESS_ENABLED: "true", MAIL_EGRESS_HMAC_KEY: HMAC_KEY },
      executionContext(),
    );
    expect(response.status).toBe(404);
    expect(createWebSocketPair).not.toHaveBeenCalled();
  });

  it("relays one bounded frame at a time and closes only after both EOF acknowledgements", async () => {
    const fixture = relayFixture();
    const authorization = await authorize(fixture);
    expect(fixture.connectTcp).toHaveBeenCalledTimes(1);
    expect(fixture.connectTcp).toHaveBeenCalledWith(
      { hostname: authorization.address, port: 465 },
      { secureTransport: "off", allowHalfOpen: true },
    );

    fixture.client.send(encodeDataFrame(0, new Uint8Array([1, 2, 3])));
    expect(await fixture.messages.next()).toBe(encodeAckControl(0));
    expect(fixture.socket.writes).toEqual([new Uint8Array([1, 2, 3])]);

    fixture.socket.readController.enqueue(new Uint8Array(20 * 1024).fill(7));
    const first = decodeDataFrame(await fixture.messages.nextBinary());
    expect(first.sequence).toBe(0);
    expect(first.payload.byteLength).toBe(16 * 1024);
    await fixture.messages.expectNoMessage();
    fixture.client.send(encodeAckControl(0));
    const second = decodeDataFrame(await fixture.messages.nextBinary());
    expect(second.sequence).toBe(1);
    expect(second.payload.byteLength).toBe(4 * 1024);
    fixture.client.send(encodeAckControl(1));

    fixture.socket.readController.close();
    expect(await fixture.messages.next()).toBe(encodeEofControl("server_eof", 2));
    fixture.client.send(encodeEofControl("server_eof_ack", 2));
    fixture.client.send(encodeEofControl("client_eof", 1));
    expect(await fixture.messages.next()).toBe(encodeEofControl("client_eof_ack", 1));
    await fixture.session;
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
  });

  it("completes client-first EOF when remote FIN makes writer.close fail", async () => {
    const fixture = relayFixture({ closeError: new Error("EPIPE") });
    await authorize(fixture);
    fixture.client.send(encodeEofControl("client_eof", 0));
    await fixture.messages.expectNoMessage();
    fixture.socket.readController.close();
    expect(await fixture.messages.next()).toBe(encodeEofControl("server_eof", 0));
    expect(await fixture.messages.next()).toBe(encodeEofControl("client_eof_ack", 0));
    fixture.client.send(encodeEofControl("server_eof_ack", 0));
    await fixture.session;
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
    expect((await fixture.webSocketClosed).code).toBe(1000);
  });

  it("completes remote-first EOF when writer.close reports EPIPE", async () => {
    const fixture = relayFixture({ closeError: new Error("EPIPE") });
    await authorize(fixture);
    fixture.socket.readController.close();
    expect(await fixture.messages.next()).toBe(encodeEofControl("server_eof", 0));
    fixture.client.send(encodeEofControl("client_eof", 0));
    expect(await fixture.messages.next()).toBe(encodeEofControl("client_eof_ack", 0));
    fixture.client.send(encodeEofControl("server_eof_ack", 0));
    await fixture.session;
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
    expect((await fixture.webSocketClosed).code).toBe(1000);
  });

  it("fails closed when writer.close fails without a clean remote EOF", async () => {
    const fixture = relayFixture({ closeError: new Error("EPIPE") });
    await authorize(fixture);
    fixture.client.send(encodeEofControl("client_eof", 0));
    await fixture.messages.expectNoMessage();
    fixture.fireTimer();
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "deadline_exceeded" }),
    );
    await fixture.session;
    expect((await fixture.webSocketClosed).code).toBe(1008);
  });

  it("completes only after client EOF when a provider resets after acknowledged data", async () => {
    const fixture = relayFixture();
    await authorize(fixture);
    fixture.socket.readController.enqueue(new Uint8Array([2, 2, 1]));
    const frame = decodeDataFrame(await fixture.messages.nextBinary());
    expect(frame.payload).toEqual(new Uint8Array([2, 2, 1]));
    fixture.client.send(encodeAckControl(0));
    fixture.socket.readController.error(new Error("ECONNRESET"));
    await fixture.messages.expectNoMessage();
    fixture.client.send(encodeEofControl("client_eof", 0));
    expect(await fixture.messages.next()).toBe(encodeEofControl("server_eof", 1));
    expect(await fixture.messages.next()).toBe(encodeEofControl("client_eof_ack", 0));
    fixture.client.send(encodeEofControl("server_eof_ack", 1));
    await fixture.session;
    expect((await fixture.webSocketClosed).code).toBe(1000);
  });

  it("keeps a provider read reset fail-closed without client EOF", async () => {
    const fixture = relayFixture();
    await authorize(fixture);
    fixture.socket.readController.error(new Error("ECONNRESET"));
    await fixture.messages.expectNoMessage();
    fixture.fireTimer();
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "deadline_exceeded" }),
    );
    await fixture.session;
    expect((await fixture.webSocketClosed).code).toBe(1008);
  });

  it("consumes authorization before awaiting crypto or TCP and rejects replay", async () => {
    const fixture = relayFixture({ opened: new Promise(() => undefined) });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge);
    const control = JSON.stringify({ type: "authorize", authorization });
    fixture.client.send(control);
    fixture.client.send(control);
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "auth_replayed" }),
    );
    await fixture.session;
    expect(fixture.connectTcp).toHaveBeenCalledTimes(1);
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
  });

  it("never opens TCP for an invalid HMAC or non-canonical target", async () => {
    const fixture = relayFixture();
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge);
    fixture.client.send(
      JSON.stringify({
        type: "authorize",
        authorization: { ...authorization, hmacSha256: "0".repeat(64) },
      }),
    );
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "auth_failed" }),
    );
    await fixture.session;
    expect(fixture.connectTcp).not.toHaveBeenCalled();
  });

  it("never opens TCP for a validly signed private target", async () => {
    const fixture = relayFixture();
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge, {
      address: "127.0.0.1",
    });
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "auth_failed" }),
    );
    await fixture.session;
    expect(fixture.connectTcp).not.toHaveBeenCalled();
  });

  it("rejects a connected peer that differs from the signed literal", async () => {
    const fixture = relayFixture({
      opened: Promise.resolve({ remoteAddress: "8.8.8.8" }),
    });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge);
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "target_rejected" }),
    );
    await fixture.session;
    expect(fixture.socket.writes).toEqual([]);
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
  });

  it("accepts workerd CONNECT authority for the signed literal", async () => {
    const fixture = relayFixture({
      opened: Promise.resolve({ remoteAddress: "1.1.1.1:465" }),
    });
    await authorize(fixture, null);
    fixture.client.close(1000, "test complete");
    await fixture.session;
    expect(fixture.connectTcp).toHaveBeenCalledTimes(1);
  });

  it("rejects workerd CONNECT authority with a different port", async () => {
    const fixture = relayFixture({
      opened: Promise.resolve({ remoteAddress: "1.1.1.1:587" }),
    });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge);
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "target_rejected" }),
    );
    await fixture.session;
    expect(fixture.socket.writes).toEqual([]);
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
  });

  it("accepts workerd IPv6 authority without claiming an observed peer", async () => {
    const address = "2606:4700:4700::1111";
    const fixture = relayFixture({
      opened: Promise.resolve({ remoteAddress: `${address}:587` }),
    });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge, {
      address,
      family: 6,
      port: 587,
    });
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    expect(await fixture.messages.next()).toEqual(
      JSON.stringify({
        type: "ready",
        sessionId: authorization.sessionId,
        attemptId: authorization.attemptId,
        resolutionId: authorization.resolutionId,
        address,
        family: 6,
        port: 587,
        remoteAddress: null,
        connectedAt: 1_000,
      }),
    );
    fixture.client.close(1000, "test complete");
    await fixture.session;
  });

  it("rejects workerd IPv6 authority with a different port", async () => {
    const address = "2606:4700:4700::1111";
    const fixture = relayFixture({
      opened: Promise.resolve({ remoteAddress: `${address}:465` }),
    });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge, {
      address,
      family: 6,
      port: 587,
    });
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "target_rejected" }),
    );
    await fixture.session;
    expect(fixture.socket.writes).toEqual([]);
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
  });

  it("lets clean reader EOF win over an early socket.closed rejection", async () => {
    let rejectClosed!: (reason: Error) => void;
    const closed = new Promise<void>((_, reject) => {
      rejectClosed = reject;
    });
    const fixture = relayFixture({ closed });
    await authorize(fixture);
    rejectClosed(new Error("socket failed"));
    fixture.socket.readController.close();
    expect(await fixture.messages.next()).toBe(encodeEofControl("server_eof", 0));
    fixture.client.send(encodeEofControl("client_eof", 0));
    expect(await fixture.messages.next()).toBe(encodeEofControl("client_eof_ack", 0));
    fixture.client.send(encodeEofControl("server_eof_ack", 0));
    await fixture.session;
  });

  it("rejects out-of-order DATA before forwarding it", async () => {
    const fixture = relayFixture();
    await authorize(fixture);
    fixture.client.send(encodeDataFrame(1, new Uint8Array([9])));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "protocol_violation" }),
    );
    await fixture.session;
    expect(fixture.socket.writes).toEqual([]);
  });

  it("rejects concurrent client DATA while the TCP writer is blocked", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const fixture = relayFixture({ writeGate });
    await authorize(fixture);
    fixture.client.send(encodeDataFrame(0, new Uint8Array([1])));
    await vi.waitFor(() => expect(fixture.socket.writes).toHaveLength(1));
    fixture.client.send(encodeDataFrame(1, new Uint8Array([2])));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "protocol_violation" }),
    );
    releaseWrite();
    await fixture.session;
    expect(fixture.socket.writes).toHaveLength(1);
  });

  it("allows exactly 2 MiB client-to-TCP and rejects the next byte before write", async () => {
    const fixture = relayFixture();
    await authorize(fixture);
    const payload = new Uint8Array(16 * 1024);
    for (let sequence = 0; sequence < 128; sequence += 1) {
      fixture.client.send(encodeDataFrame(sequence, payload));
      expect(await fixture.messages.next()).toBe(encodeAckControl(sequence));
    }
    fixture.client.send(encodeDataFrame(128, new Uint8Array([1])));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "client_limit" }),
    );
    await fixture.session;
    expect(fixture.socket.writes).toHaveLength(128);
  });

  it("allows exactly 128 KiB TCP-to-client and rejects the next byte", async () => {
    const fixture = relayFixture();
    await authorize(fixture);
    fixture.socket.readController.enqueue(new Uint8Array(128 * 1024));
    for (let sequence = 0; sequence < 8; sequence += 1) {
      const frame = decodeDataFrame(await fixture.messages.nextBinary());
      expect(frame.sequence).toBe(sequence);
      expect(frame.payload.byteLength).toBe(16 * 1024);
      fixture.client.send(encodeAckControl(sequence));
    }
    fixture.socket.readController.enqueue(new Uint8Array([1]));
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "server_limit" }),
    );
    await fixture.session;
  });

  it("enforces the absolute session timer without connecting", async () => {
    const fixture = relayFixture();
    await fixture.messages.next();
    expect(fixture.scheduledDelay()).toBe(5_000);
    fixture.fireTimer();
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "deadline_exceeded" }),
    );
    await fixture.session;
    expect(fixture.connectTcp).not.toHaveBeenCalled();
  });

  it("narrows the timer to the signed deadline before a pending TCP connect", async () => {
    const fixture = relayFixture({ opened: new Promise(() => undefined) });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge, { deadlineAt: 3_000 });
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    await vi.waitFor(() => expect(fixture.connectTcp).toHaveBeenCalledTimes(1));
    expect(fixture.scheduledDelay()).toBe(2_000);
    fixture.advanceTo(3_000);
    fixture.fireTimer();
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "deadline_exceeded" }),
    );
    await fixture.session;
    expect(fixture.socket.close).toHaveBeenCalledTimes(1);
  });

  it("does not send ready when TCP opens exactly at the signed deadline", async () => {
    let resolveOpened!: (value: { readonly remoteAddress?: string }) => void;
    const opened = new Promise<{ readonly remoteAddress?: string }>((resolve) => {
      resolveOpened = resolve;
    });
    const fixture = relayFixture({ opened });
    const challenge = challengeFrom(await fixture.messages.next());
    const authorization = await signedAuthorization(challenge, { deadlineAt: 3_000 });
    fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
    await vi.waitFor(() => expect(fixture.connectTcp).toHaveBeenCalledTimes(1));
    fixture.advanceTo(3_000);
    resolveOpened({ remoteAddress: "1.1.1.1" });
    expect(await fixture.messages.next()).toBe(
      JSON.stringify({ type: "error", code: "deadline_exceeded" }),
    );
    await fixture.session;
    expect(fixture.socket.writes).toEqual([]);
  });
});

async function authorize(
  fixture: ReturnType<typeof relayFixture>,
  expectedRemoteAddress: string | null = "1.1.1.1",
): Promise<RelayAuthorization> {
  const challenge = challengeFrom(await fixture.messages.next());
  const authorization = await signedAuthorization(challenge);
  fixture.client.send(JSON.stringify({ type: "authorize", authorization }));
  expect(await fixture.messages.next()).toEqual(
    JSON.stringify({
      type: "ready",
      sessionId: authorization.sessionId,
      attemptId: authorization.attemptId,
      resolutionId: authorization.resolutionId,
      address: authorization.address,
      family: authorization.family,
      port: authorization.port,
      remoteAddress: expectedRemoteAddress,
      connectedAt: 1_000,
    }),
  );
  return authorization;
}

function relayFixture(
  options: {
    opened?: Promise<{ readonly remoteAddress?: string }>;
    closed?: Promise<void>;
    writeGate?: Promise<void>;
    closeError?: Error;
  } = {},
) {
  const pair = new WebSocketPair();
  const client = pair[0];
  client.binaryType = "arraybuffer";
  client.accept({ allowHalfOpen: true });
  const webSocketClosed = new Promise<CloseEvent>((resolve) => {
    client.addEventListener("close", resolve);
  });
  const messages = messageQueue(client);
  const socket = fakeSocket(options);
  const connectTcp = vi.fn(() => socket);
  let timer: (() => void) | null = null;
  let timerDelay = -1;
  let currentTime = 1_000;
  const dependencies: RelayRuntimeDependencies = {
    now: () => currentTime,
    randomBytes: (size) => new Uint8Array(size).fill(0xab),
    connectTcp,
    createWebSocketPair: () => {
      throw new Error("not used by direct session tests");
    },
    scheduleTimer: (handler, milliseconds) => {
      timer = handler;
      timerDelay = milliseconds;
      return 1;
    },
    cancelTimer: () => {
      timer = null;
    },
  };
  const session = runRelaySession(pair[1], HMAC_KEY, dependencies, 1_000);
  return {
    client,
    messages,
    socket,
    connectTcp,
    session,
    webSocketClosed,
    fireTimer: () => {
      if (!timer) throw new Error("timer is not scheduled");
      timer();
    },
    scheduledDelay: () => timerDelay,
    advanceTo: (time: number) => {
      currentTime = time;
    },
  };
}

function fakeSocket(options: {
  opened?: Promise<{ readonly remoteAddress?: string }>;
  closed?: Promise<void>;
  writeGate?: Promise<void>;
  closeError?: Error;
}): RelayTcpSocket & {
  readonly writes: Uint8Array[];
  readonly readController: ReadableStreamDefaultController<Uint8Array>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const writes: Uint8Array[] = [];
  let readController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readController = controller;
    },
  });
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      writes.push(new Uint8Array(chunk));
      await options.writeGate;
    },
    close() {
      if (options.closeError) throw options.closeError;
    },
  });
  return {
    readable,
    writable,
    opened: options.opened ?? Promise.resolve({ remoteAddress: "1.1.1.1" }),
    closed: options.closed ?? new Promise(() => undefined),
    close: vi.fn(async () => undefined),
    writes,
    readController,
  };
}

function messageQueue(webSocket: WebSocket) {
  const queued: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  webSocket.addEventListener("message", (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event.data);
    else queued.push(event.data);
  });
  return {
    next: async (): Promise<unknown> => {
      if (queued.length > 0) return queued.shift();
      return new Promise((resolve) => waiters.push(resolve));
    },
    nextBinary: async (): Promise<ArrayBuffer> => {
      const value = queued.length > 0
        ? queued.shift()
        : await new Promise((resolve) => waiters.push(resolve));
      if (!(value instanceof ArrayBuffer)) throw new Error("expected binary relay frame");
      return value;
    },
    expectNoMessage: async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(queued).toEqual([]);
    },
  };
}

function challengeFrom(message: unknown): RelayChallenge {
  if (typeof message !== "string") throw new Error("expected challenge control");
  const value = JSON.parse(message) as { type: string; challenge: RelayChallenge };
  expect(value.type).toBe("challenge");
  return value.challenge;
}

async function signedAuthorization(
  challenge: RelayChallenge,
  overrides: Partial<
    Pick<
      RelayAuthorization,
      "address" | "family" | "port" | "targetExpiresAt" | "deadlineAt"
    >
  > = {},
): Promise<RelayAuthorization> {
  const unsigned = {
    ...challenge,
    transport: "authenticated_byte_relay" as const,
    sessionId: "relay-session",
    attemptId: "relay-attempt",
    resolutionId: "relay-resolution",
    address: overrides.address ?? "1.1.1.1",
    family: overrides.family ?? (4 as const),
    port: overrides.port ?? (465 as const),
    targetExpiresAt: overrides.targetExpiresAt ?? 61_000,
    deadlineAt: overrides.deadlineAt ?? 31_000,
  };
  const key = new Uint8Array(32).fill(1);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ownedBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    ownedBuffer(
      new TextEncoder().encode(
        canonicalizeRelayAuthorization(unsigned),
      ),
    ),
  );
  return {
    ...unsigned,
    hmacSha256: Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}
