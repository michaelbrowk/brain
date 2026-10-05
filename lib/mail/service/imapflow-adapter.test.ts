import type { ImapFlowOptions } from "imapflow";
import { describe, expect, it, vi } from "vitest";

import type { MailDnsResolverPort, ValidatedMailDialTarget } from "../ports";
import { MAIL_RESOURCE_LIMITS } from "../security";
import type { MultiMailAccountStore } from "./account-store";
import type { StoredImapMailAccount } from "./account-types";
import {
  createIdleOptions,
  createReadOptions,
  createVerificationOptions,
  ImapFlowCredentialVerifier,
  ImapFlowReadSessionFactory,
} from "./imapflow-adapter";

describe("ImapFlow credential verifier", () => {
  it("pins a literal peer, original SNI, TLS policy, limits, and disabled logs", () => {
    const options = createVerificationOptions(
      targetFixture(),
      {
        username: "person@example.test",
        password: Buffer.from("test-only-password"),
      },
      10_000,
    );

    expect(options).toMatchObject({
      host: "93.184.216.34",
      port: 993,
      servername: "imap.example.test",
      secure: true,
      doSTARTTLS: false,
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableAutoEnable: true,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      maxLineLength: 64 * 1024,
      maxLiteralSize: 64 * 1024,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    expect(options).not.toHaveProperty("proxy");
    expect(
      createVerificationOptions(
        { ...targetFixture(), port: 143, tls: "starttls" },
        {
          username: "person@example.test",
          password: Buffer.from("test-only-password"),
        },
        5_000,
      ),
    ).toMatchObject({ secure: false, doSTARTTLS: true });
  });

  it("authenticates, uses public unbind for peer proof, and destroys owned sockets", async () => {
    const readSocket = socketFixture("93.184.216.34");
    const writeSocket = socketFixture("93.184.216.34");
    const client = clientFixture({ readSocket, writeSocket });
    const createClient = vi.fn(() => client);
    const verifier = verifierFixture(createClient);

    await expect(verifier.verify(requestFixture())).resolves.toBeUndefined();
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.unbind).toHaveBeenCalledOnce();
    expect(readSocket.destroy).toHaveBeenCalledOnce();
    expect(writeSocket.destroy).toHaveBeenCalledOnce();
    expect(client.close).not.toHaveBeenCalled();
  });

  it("maps real Error TLS metadata without leaking its secret message", async () => {
    const failure = Object.assign(new Error("SECRET provider transcript"), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
    const client = clientFixture();
    client.connect.mockRejectedValueOnce(failure);
    const verifier = verifierFixture(() => client);

    const result = await verifier.verify(requestFixture()).catch((error) => error);
    expect(result).toMatchObject({
      code: "imap_tls_failed",
      message: "imap_tls_failed",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("maps ImapFlow's internal ETIMEOUT code to the stable timeout", async () => {
    const client = clientFixture();
    client.connect.mockRejectedValueOnce(
      Object.assign(new Error("SECRET socket timeout"), { code: "ETIMEOUT" }),
    );
    const verifier = verifierFixture(() => client);

    await expect(verifier.verify(requestFixture())).rejects.toMatchObject({
      code: "imap_connection_timeout",
      message: "imap_connection_timeout",
    });
  });

  it("keeps authentication failure distinct and never returns provider text", async () => {
    const client = clientFixture();
    client.connect.mockRejectedValueOnce(
      Object.assign(new Error("SECRET authentication response"), {
        authenticationFailed: true,
      }),
    );
    const verifier = verifierFixture(() => client);

    await expect(verifier.verify(requestFixture())).rejects.toMatchObject({
      code: "imap_authentication_failed",
      message: "imap_authentication_failed",
    });
  });

  it("rejects an observed peer mismatch after authentication", async () => {
    const client = clientFixture({
      readSocket: socketFixture("1.1.1.1"),
      writeSocket: socketFixture("1.1.1.1"),
    });
    const verifier = verifierFixture(() => client);

    await expect(verifier.verify(requestFixture())).rejects.toMatchObject({
      code: "imap_connection_failed",
    });
  });

  it("rejects a PREAUTH-like session that never tested the credentials", async () => {
    const client = clientFixture();
    client.authenticated = false;
    const verifier = verifierFixture(() => client);

    await expect(verifier.verify(requestFixture())).rejects.toMatchObject({
      code: "imap_authentication_failed",
    });
    expect(client.unbind).not.toHaveBeenCalled();
  });

  it("closes the ImapFlow client on request abort and ignores late connect", async () => {
    let resolveConnect: (() => void) | undefined;
    const client = clientFixture();
    client.connect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveConnect = resolve)),
    );
    const controller = new AbortController();
    const verifier = verifierFixture(() => client);
    const result = verifier.verify({
      ...requestFixture(),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    controller.abort();
    resolveConnect?.();

    await expect(result).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(client.close).toHaveBeenCalled();
    expect(client.unbind).not.toHaveBeenCalled();
  });

  it("bounds a dead first DNS target and succeeds on the second", async () => {
    const first = clientFixture();
    first.connect.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const second = clientFixture({
      readSocket: socketFixture("93.184.216.35"),
      writeSocket: socketFixture("93.184.216.35"),
    });
    const createClient = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const dns: MailDnsResolverPort = {
      resolve: async () => [
        targetFixture(),
        { ...targetFixture(), address: "93.184.216.35" },
      ],
    };
    const verifier = new ImapFlowCredentialVerifier({
      dns,
      createClient,
      now: () => 1_000,
    });

    await expect(
      verifier.verify({ ...requestFixture(), deadlineAt: 1_040 }),
    ).resolves.toBeUndefined();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient.mock.calls[0][0].connectionTimeout).toBe(20);
    expect(createClient.mock.calls[1][0].connectionTimeout).toBe(40);
    expect(first.close).toHaveBeenCalled();
    expect(second.unbind).toHaveBeenCalledOnce();
  });

  it("keeps a silent-server diagnosis when the next address family is unusable", async () => {
    // Production shape for a company-only IMAP host: the A record is filtered
    // and never answers, and the host has no route for the AAAA record. The
    // unusable family must not overwrite what the reachable family observed.
    const createClient = twoFamilyClients(
      connectRejects("CONNECT_TIMEOUT"),
      connectRejects("ENETUNREACH"),
    );

    await expect(
      dualStackVerifier(createClient).verify(requestFixture()),
    ).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("keeps a TLS diagnosis when the next address family is unusable", async () => {
    const createClient = twoFamilyClients(
      connectRejects("ERR_TLS_CERT_ALTNAME_INVALID"),
      connectRejects("ENETUNREACH"),
    );

    await expect(
      dualStackVerifier(createClient).verify(requestFixture()),
    ).rejects.toMatchObject({ code: "imap_tls_failed" });
  });

  it("still reports an unreachable server when no family observed more", async () => {
    const createClient = twoFamilyClients(
      connectRejects("ECONNREFUSED"),
      connectRejects("ENETUNREACH"),
    );

    await expect(
      dualStackVerifier(createClient).verify(requestFixture()),
    ).rejects.toMatchObject({ code: "imap_connection_failed" });
  });
});

describe("ImapFlow read session factory", () => {
  it("pins the literal target, original SNI, read limits, and disables logs and proxy", () => {
    const options = createReadOptions(
      targetFixture(),
      "person@example.test",
      Buffer.from("test-only-password"),
      8_000,
    );

    expect(options).toMatchObject({
      host: "93.184.216.34",
      port: 993,
      servername: "imap.example.test",
      secure: true,
      doSTARTTLS: false,
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableAutoEnable: true,
      disableBinary: true,
      qresync: false,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      socketTimeout: 8_000,
      maxLineLength: 64 * 1024,
      maxLiteralSize: 256 * 1024,
      maxLockHoldTime: 8_000,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    expect(options).not.toHaveProperty("proxy");
  });

  it("validates metadata and DNS before loading one credential, then wipes it", async () => {
    const order: string[] = [];
    const expected = imapAccountFixture();
    const password = Buffer.from("test-only-password");
    const store = storeFixture(expected, password, order);
    const dns: MailDnsResolverPort = {
      resolve: vi.fn(async () => {
        order.push("dns_resolved");
        return [targetFixture()];
      }),
    };
    const client = readClientFixture();
    const createClient = vi.fn((options: ImapFlowOptions) => {
      order.push("client_created");
      expect(options.auth?.pass).toBe("test-only-password");
      return client;
    });
    const factory = new ImapFlowReadSessionFactory({
      dns,
      store,
      createClient,
      now: () => 1_000,
    });

    await expect(
      factory.withSession(expected, new AbortController().signal, async () => {
        order.push("operation");
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(order).toEqual([
      "metadata_read",
      "dns_resolved",
      "credential_loaded",
      "client_created",
      "operation",
      "metadata_read",
    ]);
    expect(password.equals(Buffer.alloc(password.length))).toBe(true);
    expect(client.unbind).toHaveBeenCalledOnce();
    expect(client.readSocket.destroy).toHaveBeenCalledOnce();
  });

  it("rejects a changed binding before DNS, secret loading, or dialing", async () => {
    const expected = imapAccountFixture();
    const changed = imapAccountFixture({ credentialVersion: 2 });
    const store = storeFixture(changed, Buffer.from("unused"));
    const dns: MailDnsResolverPort = { resolve: vi.fn() };
    const createClient = vi.fn();
    const factory = new ImapFlowReadSessionFactory({
      dns,
      store,
      createClient,
    });

    await expect(
      factory.withSession(expected, new AbortController().signal, async () => "no"),
    ).rejects.toMatchObject({ code: "account_state_invalid" });
    expect(dns.resolve).not.toHaveBeenCalled();
    expect(store.loadProvisionedAccount).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("wipes a credential whose loaded binding no longer matches the trusted snapshot", async () => {
    const expected = imapAccountFixture();
    const changed = imapAccountFixture({ credentialVersion: 2 });
    const password = Buffer.from("test-only-password");
    const store = storeFixture(expected, password);
    vi.mocked(store.loadProvisionedAccount).mockResolvedValueOnce({
      stored: changed,
      password,
    });
    const dns: MailDnsResolverPort = {
      resolve: vi.fn().mockResolvedValue([targetFixture()]),
    };
    const createClient = vi.fn();
    const factory = new ImapFlowReadSessionFactory({
      dns,
      store,
      createClient,
      now: () => 1_000,
    });

    await expect(
      factory.withSession(expected, new AbortController().signal, async () => "no"),
    ).rejects.toMatchObject({ code: "account_state_invalid" });
    expect(password.equals(Buffer.alloc(password.length))).toBe(true);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects a binding rotated while the read operation is in flight", async () => {
    const expected = imapAccountFixture();
    const changed = imapAccountFixture({ credentialVersion: 2 });
    const store = storeFixture(expected, Buffer.from("test-only-password"));
    vi.mocked(store.readAccount)
      .mockResolvedValueOnce(expected)
      .mockResolvedValueOnce(changed);
    const dns: MailDnsResolverPort = {
      resolve: vi.fn().mockResolvedValue([targetFixture()]),
    };
    const client = readClientFixture();
    const factory = new ImapFlowReadSessionFactory({
      dns,
      store,
      createClient: () => client,
      now: () => 1_000,
    });

    await expect(
      factory.withSession(expected, new AbortController().signal, async () => "no"),
    ).rejects.toMatchObject({ code: "account_state_invalid" });
    expect(client.unbind).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it("does not retry another address after an authenticated operation fails", async () => {
    const expected = imapAccountFixture();
    const store = storeFixture(expected, Buffer.from("test-only-password"));
    const dns: MailDnsResolverPort = {
      resolve: vi.fn().mockResolvedValue([
        targetFixture(),
        { ...targetFixture(), address: "93.184.216.35" },
      ]),
    };
    const createClient = vi.fn(() => readClientFixture());
    const factory = new ImapFlowReadSessionFactory({
      dns,
      store,
      createClient,
      now: () => 1_000,
    });
    const stable = Object.assign(new Error("stable_operation_failure"), {
      code: "stable_operation_failure",
    });

    await expect(
      factory.withSession(expected, new AbortController().signal, async () => {
        throw stable;
      }),
    ).rejects.toBe(stable);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it("keeps a silent-server diagnosis when the next address family is unusable", async () => {
    const expected = imapAccountFixture();
    const store = storeFixture(expected, Buffer.from("test-only-password"));
    const dns: MailDnsResolverPort = {
      resolve: async () => [
        targetFixture(),
        { ...targetFixture(), address: "2a02:6b8::1", family: 6 as const },
      ],
    };
    const silent = readClientFixture();
    silent.connect.mockRejectedValueOnce(
      Object.assign(new Error("SECRET provider transcript"), {
        code: "CONNECT_TIMEOUT",
      }),
    );
    const unusable = readClientFixture();
    unusable.connect.mockRejectedValueOnce(
      Object.assign(new Error("SECRET provider transcript"), {
        code: "ENETUNREACH",
      }),
    );
    const createClient = vi
      .fn()
      .mockReturnValueOnce(silent)
      .mockReturnValueOnce(unusable);
    const factory = new ImapFlowReadSessionFactory({
      dns,
      store,
      createClient,
      now: () => 1_000,
    });

    await expect(
      factory.withSession(expected, new AbortController().signal, async () => "no"),
    ).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});

describe("ImapFlow IDLE session", () => {
  it("pins the literal target and outlives the IDLE restart without idling on its own", () => {
    const options = createIdleOptions(
      targetFixture(),
      "person@example.test",
      Buffer.from("test-only-password"),
      8_000,
    );

    expect(options).toMatchObject({
      host: "93.184.216.34",
      port: 993,
      servername: "imap.example.test",
      secure: true,
      doSTARTTLS: false,
      logger: false,
      logRaw: false,
      emitLogs: false,
      disableAutoIdle: true,
      disableCompression: true,
      disableAutoEnable: true,
      disableBinary: true,
      qresync: false,
      connectionTimeout: 8_000,
      greetingTimeout: 8_000,
      maxLineLength: 64 * 1024,
      maxLiteralSize: 64 * 1024,
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    });
    // Quiet for a whole IDLE is normal: the socket gives up only after the
    // supervisor would already have restarted it.
    expect(options.socketTimeout).toBeGreaterThan(MAIL_RESOURCE_LIMITS.idleRestartMs);
    expect(options).not.toHaveProperty("proxy");
    expect(options).not.toHaveProperty("maxIdleTime");
  });

  it("examines INBOX read-only and hands the session over open", async () => {
    const order: string[] = [];
    const expected = imapAccountFixture();
    const password = Buffer.from("test-only-password");
    const client = idleClientFixture();
    const factory = new ImapFlowReadSessionFactory({
      dns: { resolve: vi.fn(async () => [targetFixture()]) },
      store: storeFixture(expected, password, order),
      createClient: vi.fn(),
      createIdleClient: vi.fn((options: ImapFlowOptions) => {
        order.push("client_created");
        expect(options.auth?.pass).toBe("test-only-password");
        return client;
      }),
      now: () => 1_000,
    });

    await expect(
      factory.openIdleSession(expected.account.accountId, new AbortController().signal),
    ).resolves.toBe(client);
    expect(order).toEqual(["metadata_read", "credential_loaded", "client_created"]);
    // EXAMINE, not SELECT, and nothing after it: holding IDLE cannot clear
    // \Recent, move, flag or expunge anything.
    expect(client.mailboxOpen).toHaveBeenCalledExactlyOnceWith("INBOX", { readOnly: true });
    expect(client.idle).not.toHaveBeenCalled();
    expect(client.noop).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(password.equals(Buffer.alloc(password.length))).toBe(true);
  });

  it("refuses an account that is not a connected IMAP one before DNS or a secret", async () => {
    const imap = imapAccountFixture();
    for (const stored of [
      { ...imap, status: "reauth_required" as const },
      { ...imap, providerKind: "gmail" as const },
      null,
    ]) {
      const store = storeFixture(imap, Buffer.from("unused"));
      vi.mocked(store.readAccount).mockResolvedValue(
        stored as unknown as StoredImapMailAccount,
      );
      const dns: MailDnsResolverPort = { resolve: vi.fn() };
      const createIdleClient = vi.fn();
      const factory = new ImapFlowReadSessionFactory({
        dns,
        store,
        createClient: vi.fn(),
        createIdleClient,
      });
      await expect(
        factory.openIdleSession(imap.account.accountId, new AbortController().signal),
      ).rejects.toMatchObject({ code: "account_state_invalid" });
      expect(dns.resolve).not.toHaveBeenCalled();
      expect(store.loadProvisionedAccount).not.toHaveBeenCalled();
      expect(createIdleClient).not.toHaveBeenCalled();
    }
  });

  it("closes a session whose INBOX will not open, and tries no other address after login", async () => {
    const expected = imapAccountFixture();
    const client = idleClientFixture();
    client.mailboxOpen.mockRejectedValueOnce(new Error("SECRET provider transcript"));
    const createIdleClient = vi.fn(() => client);
    const factory = new ImapFlowReadSessionFactory({
      dns: {
        resolve: vi.fn(async () => [
          targetFixture(),
          { ...targetFixture(), address: "93.184.216.35" },
        ]),
      },
      store: storeFixture(expected, Buffer.from("test-only-password")),
      createClient: vi.fn(),
      createIdleClient,
      now: () => 1_000,
    });

    const failure = await factory
      .openIdleSession(expected.account.accountId, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "imap_connection_failed" });
    expect(String(failure)).not.toContain("SECRET");
    expect(client.close).toHaveBeenCalled();
    expect(createIdleClient).toHaveBeenCalledOnce();
  });

  it("refuses a session whose open mailbox is not INBOX", async () => {
    const expected = imapAccountFixture();
    for (const mailbox of [{ path: "Archive" }, false as const]) {
      const client = idleClientFixture();
      // The open answers as if it worked; what the session holds afterwards
      // is what the adapter checks.
      client.mailboxOpen.mockImplementationOnce(async () => {
        client.mailbox = mailbox;
        return { path: "INBOX" };
      });
      const factory = new ImapFlowReadSessionFactory({
        dns: { resolve: vi.fn(async () => [targetFixture()]) },
        store: storeFixture(expected, Buffer.from("test-only-password")),
        createClient: vi.fn(),
        createIdleClient: () => client,
        now: () => 1_000,
      });

      await expect(
        factory.openIdleSession(expected.account.accountId, new AbortController().signal),
      ).rejects.toMatchObject({ code: "imap_connection_failed" });
      expect(client.close).toHaveBeenCalled();
    }
  });

  it("closes the client when the caller aborts while it connects", async () => {
    const expected = imapAccountFixture();
    const client = idleClientFixture();
    client.connect.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const factory = new ImapFlowReadSessionFactory({
      dns: { resolve: vi.fn(async () => [targetFixture()]) },
      store: storeFixture(expected, Buffer.from("test-only-password")),
      createClient: vi.fn(),
      createIdleClient: () => client,
      now: () => 1_000,
    });

    const opening = factory.openIdleSession(expected.account.accountId, controller.signal);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalled());
    controller.abort();
    await expect(opening).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(client.close).toHaveBeenCalled();
  });
});

function idleClientFixture() {
  const client = {
    secureConnection: true,
    authenticated: true,
    mailbox: false as false | { path: string; readOnly?: boolean },
    capabilities: new Map<string, boolean | number>([
      ["IMAP4rev1", true],
      ["IDLE", true],
    ]),
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    mailboxOpen: vi.fn(async (path: string) => {
      client.mailbox = { path, readOnly: true };
      return client.mailbox;
    }),
    idle: vi.fn(async () => true),
    noop: vi.fn(async () => undefined),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
  return client;
}

function connectRejects(code: string) {
  const client = clientFixture();
  client.connect.mockRejectedValueOnce(
    Object.assign(new Error("SECRET provider transcript"), { code }),
  );
  return client;
}

function twoFamilyClients(
  ipv4: ReturnType<typeof clientFixture>,
  ipv6: ReturnType<typeof clientFixture>,
) {
  return vi.fn().mockReturnValueOnce(ipv4).mockReturnValueOnce(ipv6);
}

function dualStackVerifier(
  createClient: (options: ImapFlowOptions) => ReturnType<typeof clientFixture>,
) {
  const dns: MailDnsResolverPort = {
    resolve: async () => [
      targetFixture(),
      { ...targetFixture(), address: "2a02:6b8::1", family: 6 as const },
    ],
  };
  return new ImapFlowCredentialVerifier({ dns, createClient, now: () => 1_000 });
}

function verifierFixture(
  createClient: (options: ImapFlowOptions) => ReturnType<typeof clientFixture>,
) {
  const dns: MailDnsResolverPort = {
    resolve: async () => [targetFixture()],
  };
  return new ImapFlowCredentialVerifier({
    dns,
    createClient,
    now: () => 1_000,
  });
}

function requestFixture() {
  return {
    endpoint: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit" as const,
    },
    username: "person@example.test",
    password: Buffer.from("test-only-password"),
    deadlineAt: 11_000,
    signal: new AbortController().signal,
  };
}

function targetFixture(): ValidatedMailDialTarget {
  return {
    protocol: "imap",
    hostname: "imap.example.test",
    port: 993,
    tls: "implicit",
    address: "93.184.216.34",
    family: 4,
    resolutionId: "dns-test",
    resolvedAt: 1_000,
    expiresAt: 11_000,
  };
}

function socketFixture(remoteAddress: string) {
  return {
    remoteAddress,
    once: vi.fn().mockReturnThis(),
    destroy: vi.fn(),
  };
}

function clientFixture(options?: {
  readonly readSocket?: ReturnType<typeof socketFixture>;
  readonly writeSocket?: ReturnType<typeof socketFixture>;
}) {
  const readSocket = options?.readSocket ?? socketFixture("93.184.216.34");
  const writeSocket = options?.writeSocket ?? readSocket;
  return {
    secureConnection: true,
    authenticated: true,
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
    unbind: vi.fn(() => ({ readSocket, writeSocket })),
  };
}

function readClientFixture() {
  const readSocket = socketFixture("93.184.216.34");
  const writeSocket = readSocket;
  return {
    secureConnection: true,
    authenticated: true,
    mailbox: false as const,
    capabilities: new Map<string, boolean | number>([
      ["IMAP4rev1", true],
      ["MOVE", true],
      ["UIDPLUS", true],
    ]),
    connect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
    unbind: vi.fn(() => ({ readSocket, writeSocket })),
    getMailboxLock: vi.fn(),
    fetchAll: vi.fn(),
    status: vi.fn(),
    list: vi.fn(),
    mailboxCreate: vi.fn(),
    mailboxSubscribe: vi.fn(),
    search: vi.fn(),
    messageFlagsAdd: vi.fn(),
    messageFlagsRemove: vi.fn(),
    messageMove: vi.fn(),
    readSocket,
  };
}

function imapAccountFixture(options?: {
  readonly credentialVersion?: number;
}): StoredImapMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: "account-a11111111111111111111111111111111",
      emailAddress: "person@example.test",
      endpoint: Object.freeze({
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit" as const,
      }),
      username: "person@example.test",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version: options?.credentialVersion ?? 1,
      }),
      transportBindingRef: Object.freeze({
        id: "binding-r11111111111111111111111111111111",
        version: 1,
      }),
      connectedAt: 1,
    }),
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  });
}

function storeFixture(
  stored: StoredImapMailAccount,
  password: Buffer,
  order: string[] = [],
): MultiMailAccountStore {
  return {
    localSchemaVersion: 2,
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    countAccounts: vi.fn().mockResolvedValue(1),
    listAccounts: vi.fn().mockResolvedValue([stored]),
    readAccount: vi.fn(async () => {
      order.push("metadata_read");
      return stored;
    }),
    loadProvisionedAccount: vi.fn(async () => {
      order.push("credential_loaded");
      return { stored, password };
    }),
    save: vi.fn().mockResolvedValue(undefined),
    updateMetadata: vi.fn().mockResolvedValue(undefined),
    loadGmailCredential: vi.fn().mockResolvedValue(null),
    deleteAccount: vi.fn().mockResolvedValue(true),
  };
}
