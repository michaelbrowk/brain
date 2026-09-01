import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAIL_RESOURCE_LIMITS } from "../security";
import { createQueuedSubmission } from "../send-state";
import type {
  ImapSyncPage,
  MailSystemUsage,
  MailTransportBinding,
  MailTransportBindingRef,
  SmtpSubmissionRequest,
  ValidatedMailDialTarget,
} from "../ports";
import {
  FakeImapSessionFactory,
  FakeIsolatedMailParser,
  FakeMailboxSyncStateStore,
  FakeMailSystemAdmission,
  FakeOutbox,
  FakeSmtpSessionFactory,
  FakeVersionedStateStore,
} from "./fakes";

const page = (highestUid: number): ImapSyncPage => ({
  uidValidity: "101",
  highestModSeq: String(highestUid * 10),
  highestUid,
  vanishedUids: [],
  messages: [
    {
      uid: highestUid,
      modSeq: String(highestUid * 10),
      flags: ["\\Seen"],
      rfc822Size: 128,
    },
  ],
});

describe("deterministic mail adapter fakes", () => {
  const credentialRef = { id: "credential-1", version: 1 } as const;
  const bindingRefs = {
    imap: { id: "imap-binding", version: 1 },
    smtp: { id: "smtp-binding", version: 1 },
    smtpStartTls: { id: "smtp-starttls-binding", version: 1 },
  } as const;
  const dialTarget = (protocol: "imap" | "smtp"): ValidatedMailDialTarget => ({
    protocol,
    hostname: `${protocol}.example.com`,
    port: protocol === "imap" ? 993 : 465,
    tls: "implicit",
    address: "93.184.216.34",
    family: 4,
    resolutionId: `${protocol}-resolution-1`,
    resolvedAt: 1,
    expiresAt: 60_001,
  });
  const binding = (
    protocol: "imap" | "smtp",
    endpoint: MailTransportBinding["endpoint"] = {
      hostname: `${protocol}.example.com`,
      port: protocol === "imap" ? 993 : 465,
      tls: "implicit" as const,
    },
  ): MailTransportBinding => ({
    accountId: "account-1",
    protocol,
    endpoint,
    auth: { username: "me@example.com", credentialRef },
  });
  const trustedBindings = {
    "imap-binding:1": binding("imap"),
    "smtp-binding:1": binding("smtp"),
    "smtp-starttls-binding:1": binding("smtp", {
      hostname: "smtp.example.com",
      port: 587,
      tls: "starttls",
    }),
  } as const;
  const secret = new TextEncoder().encode("synthetic-provider-secret");
  const sessionOptions = (
    options: Omit<
      NonNullable<ConstructorParameters<typeof FakeSmtpSessionFactory>[1]>,
      "bindings" | "credentials"
    > = {},
  ) => ({
    bindings: trustedBindings,
    credentials: { "credential-1:1": secret },
    ...options,
  });
  const openRequest = (
    protocol: "imap" | "smtp",
    target = dialTarget(protocol),
    bindingRef: MailTransportBindingRef =
      protocol === "imap" ? bindingRefs.imap : bindingRefs.smtp,
  ) => ({
    accountId: "account-1",
    target,
    bindingRef,
    deadlineAt: 1_000,
  });

  it("scripts IMAP pages and a disconnect without network access", async () => {
    const factory = new FakeImapSessionFactory(
      {
        capabilities: ["IMAP4rev1", "IDLE", "QRESYNC"],
        pages: [page(1), page(2)],
        failAfterPages: 1,
        failureCode: "imap_connection_lost",
      },
      sessionOptions(),
    );
    const seen: ImapSyncPage[] = [];
    const session = await factory.open(openRequest("imap"));

    await expect(async () => {
      for await (const item of session.syncMailbox({
        accountId: "account-1",
        mailboxId: "inbox",
        remotePath: "INBOX",
        cursor: null,
        maxMessages: 50,
        deadlineAt: 1_000,
      })) {
        seen.push(item);
      }
    }).rejects.toMatchObject({ code: "imap_connection_lost" });

    expect(seen).toEqual([page(1)]);
    expect(factory.calls).toHaveLength(1);
    expect(JSON.stringify(factory.calls)).not.toMatch(/password|token|secret|credential/i);
  });

  it("scripts SMTP handoff outcomes and records only immutable metadata", async () => {
    const factory = new FakeSmtpSessionFactory(
      [
        {
          kind: "transport_error",
          deliveryRisk: "possible",
          errorCode: "connection_lost_after_data",
        },
        {
          kind: "accepted",
          responseCode: 250,
          acceptedRecipients: ["friend@example.net"],
          rejectedRecipients: [],
        },
      ],
      sessionOptions(),
    );
    const request: SmtpSubmissionRequest = {
      accountId: "account-1",
      operationId: "send-1",
      messageId: "<send-1@example.com>",
      envelope: {
        from: "me@example.com",
        to: ["friend@example.net"],
        cc: [],
        bcc: [],
      },
      rawMimeSha256: "c".repeat(64),
      rawMimeBytes: 512,
    };

    const session = await factory.open(openRequest("smtp"));
    let barriers = 0;
    const hooks = {
      deadlineAt: 1_000,
      beforeData: async () => {
        barriers += 1;
      },
    };
    await expect(session.submit(request, hooks)).resolves.toMatchObject({
      kind: "transport_error",
      deliveryRisk: "possible",
    });
    await expect(session.submit(request, hooks)).resolves.toEqual({
      kind: "accepted",
      responseCode: 250,
      acceptedRecipients: ["friend@example.net"],
      rejectedRecipients: [],
    });
    expect(barriers).toBe(2);
    expect(factory.calls).toEqual([request, request]);
  });

  it("deduplicates queued sends by idempotency key without changing MIME", () => {
    const outbox = new FakeOutbox();
    const send = createQueuedSubmission({
      operationId: "send-operation-1",
      idempotencyKey: "compose-action-1",
      accountId: "account-1",
      messageId: "<send-1@example.com>",
      envelope: {
        from: "me@example.com",
        to: ["friend@example.net"],
        cc: [],
        bcc: [],
      },
      rawMimeSha256: "d".repeat(64),
      rawMimeBytes: 256,
      createdAt: 1,
    });

    expect(outbox.enqueue(send)).toEqual({ created: true, record: send });
    expect(outbox.findByIdempotencyKey("compose-action-1")).toBe(send);
    expect(outbox.enqueue(send)).toEqual({ created: false, record: send });
    const reconstructedAfterLostResponse = createQueuedSubmission({
      ...send.submission,
      createdAt: send.submission.createdAt + 10_000,
    });
    expect(outbox.enqueue(reconstructedAfterLostResponse)).toEqual({
      created: false,
      record: send,
    });
    expect(() =>
      outbox.enqueue({
        ...send,
        submission: { ...send.submission, rawMimeSha256: "e".repeat(64) },
      }),
    ).toThrow(/idempotency/i);
  });

  it("rejects a stale compare-and-swap after another worker commits", async () => {
    const store = new FakeVersionedStateStore<{ readonly version: number; readonly value: string }>();
    await store.insert("mailbox-1", { version: 0, value: "initial" });
    const workerA = await store.read("mailbox-1");
    const workerB = await store.read("mailbox-1");

    await expect(
      store.compareAndSwap("mailbox-1", workerA!.version, {
        version: workerA!.version + 1,
        value: "worker-a",
      }),
    ).resolves.toBe(true);
    await expect(
      store.compareAndSwap("mailbox-1", workerB!.version, {
        version: workerB!.version + 1,
        value: "worker-b",
      }),
    ).resolves.toBe(false);
    await expect(store.read("mailbox-1")).resolves.toEqual({
      version: 1,
      value: "worker-a",
    });
  });

  it("commits a sync page and its cursor version atomically", async () => {
    const store = new FakeMailboxSyncStateStore<{
      readonly version: number;
      readonly resume: {
        readonly generation: number;
        readonly uidValidity: string;
        readonly highestUid: number;
        readonly highestModSeq: string | null;
      } | null;
    }>();
    await store.insert("mailbox-1", {
      version: 0,
      resume: {
        generation: 1,
        uidValidity: "101",
        highestUid: 0,
        highestModSeq: null,
      },
    });

    await expect(
      store.commitPage({
        key: "mailbox-1",
        expectedVersion: 0,
        next: {
          version: 1,
          resume: {
            generation: 1,
            uidValidity: "101",
            highestUid: 2,
            highestModSeq: "20",
          },
        },
        generation: 1,
        page: page(1),
      }),
    ).rejects.toThrow(/staged cursor/i);
    await expect(store.read("mailbox-1")).resolves.toMatchObject({ version: 0 });

    await expect(
      store.commitPage({
        key: "mailbox-1",
        expectedVersion: 0,
        next: {
          version: 1,
          resume: {
            generation: 1,
            uidValidity: "101",
            highestUid: 1,
            highestModSeq: "10",
          },
        },
        generation: 1,
        page: page(1),
      }),
    ).resolves.toBe(true);
    await expect(
      store.commitPage({
        key: "mailbox-1",
        expectedVersion: 0,
        next: {
          version: 1,
          resume: {
            generation: 1,
            uidValidity: "101",
            highestUid: 2,
            highestModSeq: "20",
          },
        },
        generation: 1,
        page: page(2),
      }),
    ).resolves.toBe(false);
    expect(store.committedPages).toEqual([
      { key: "mailbox-1", generation: 1, page: page(1) },
    ]);
    await expect(store.read("mailbox-1")).resolves.toEqual({
      version: 1,
      resume: {
        generation: 1,
        uidValidity: "101",
        highestUid: 1,
        highestModSeq: "10",
      },
    });
  });

  it("admits concurrent work atomically without counter underflow", async () => {
    // Seed one parser slot below the quota so exactly one reservation fits.
    const usage: MailSystemUsage = {
      accounts: 0,
      mailboxes: 0,
      activeImapConnections: 0,
      idleSessions: 0,
      concurrentFetchStreams: 0,
      concurrentMimeParsers: MAIL_RESOURCE_LIMITS.concurrentMimeParsers - 1,
      concurrentSmtpSubmissions: 0,
      queuedSubmissions: 0,
      cacheBytes: 0,
      cacheMessages: 0,
      temporaryBytes: 0,
      walBytes: 0,
      openFileDescriptors: 0,
    };
    const admission = new FakeMailSystemAdmission(usage);
    const reservations = await Promise.allSettled([
      admission.reserve("parse-1", { concurrentMimeParsers: 1 }),
      admission.reserve("parse-2", { concurrentMimeParsers: 1 }),
    ]);
    expect(reservations.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    await expect(admission.readUsage()).resolves.toMatchObject({
      concurrentMimeParsers: MAIL_RESOURCE_LIMITS.concurrentMimeParsers,
    });
    const accepted = reservations.find(
      (result): result is PromiseFulfilledResult<{ readonly reservationId: string }> =>
        result.status === "fulfilled",
    );
    await admission.release(accepted!.value.reservationId);
    await expect(admission.readUsage()).resolves.toEqual(usage);
    await expect(
      admission.reserve("parse-negative", { concurrentMimeParsers: -1 }),
    ).rejects.toThrow();
  });

  it("keeps secrets in the adapter edge while sending auth only after verified TLS", async () => {
    const crossPairFactory = new FakeSmtpSessionFactory([], sessionOptions());
    await expect(
      crossPairFactory.open(
        openRequest("smtp", {
          ...dialTarget("smtp"),
          hostname: "attacker.example.net",
        }),
      ),
    ).rejects.toMatchObject({ code: "transport_binding_target_mismatch" });
    expect(crossPairFactory.credentialReads).toHaveLength(0);
    expect(crossPairFactory.events).toEqual(["binding_resolved"]);

    const forgedTargetFactory = new FakeSmtpSessionFactory([], sessionOptions());
    await expect(
      forgedTargetFactory.open(
        openRequest("smtp", { ...dialTarget("smtp"), address: "127.0.0.1" }),
      ),
    ).rejects.toThrow(/canonical public address/i);
    expect(forgedTargetFactory.openCalls).toHaveLength(0);
    expect(forgedTargetFactory.credentialReads).toHaveLength(0);
    expect(forgedTargetFactory.events).toEqual([]);

    const directWithoutPeerFactory = new FakeSmtpSessionFactory(
      [],
      sessionOptions({ smtpEgressTransport: "direct" }),
    );
    await expect(
      directWithoutPeerFactory.open(openRequest("smtp")),
    ).rejects.toMatchObject({ code: "smtp_direct_remote_address_missing" });
    expect(directWithoutPeerFactory.events).toEqual([
      "binding_resolved",
      "credential_loaded",
      "dial_started",
    ]);

    const directFactory = new FakeSmtpSessionFactory(
      [],
      sessionOptions({
        smtpEgressTransport: "direct",
        smtpTunnelRemoteAddress: dialTarget("smtp").address,
      }),
    );
    const directSession = await directFactory.open(openRequest("smtp"));
    expect(directSession.connectionPolicy.egressTransport).toBe("direct");
    await directSession.close();

    const failures = [
      {
        factory: new FakeSmtpSessionFactory([], sessionOptions({
          certificateValid: false,
        })),
        target: dialTarget("smtp"),
        bindingRef: bindingRefs.smtp,
      },
      {
        factory: new FakeSmtpSessionFactory([], sessionOptions({
          certificateHostnameValid: false,
        })),
        target: dialTarget("smtp"),
        bindingRef: bindingRefs.smtp,
      },
      {
        factory: new FakeSmtpSessionFactory([], sessionOptions({
          smtpTunnelRemoteAddress: "127.0.0.1",
        })),
        target: dialTarget("smtp"),
        bindingRef: bindingRefs.smtp,
      },
      {
        factory: new FakeSmtpSessionFactory([], sessionOptions({
          startTlsAvailable: false,
        })),
        target: { ...dialTarget("smtp"), tls: "starttls" as const, port: 587 },
        bindingRef: bindingRefs.smtpStartTls,
      },
    ];
    for (const { factory, target, bindingRef } of failures) {
      await expect(
        factory.open(openRequest("smtp", target, bindingRef)),
      ).rejects.toBeInstanceOf(Error);
      // Secret bytes can exist inside the adapter before its TLS handshake;
      // neither ImapFlow nor the first-party SMTP wire sends auth before TLS.
      expect(factory.credentialReads).toEqual([{ id: "credential-1", version: 1 }]);
      expect(factory.events).toEqual([
        "binding_resolved",
        "credential_loaded",
        "relay_authorized",
        "dial_started",
        "relay_connected",
      ]);
      expect(factory.events).not.toContain("auth_sent");
      expect(factory.events).not.toContain("session_ready");
    }

    const successfulFactory = new FakeSmtpSessionFactory([], sessionOptions());
    const session = await successfulFactory.open(openRequest("smtp"));
    expect(successfulFactory.events).toEqual([
      "binding_resolved",
      "credential_loaded",
      "relay_authorized",
      "dial_started",
      "relay_connected",
      "tls_verified",
      "auth_sent",
      "session_ready",
    ]);
    expect(successfulFactory.events.indexOf("auth_sent")).toBeGreaterThan(
      successfulFactory.events.indexOf("tls_verified"),
    );
    expect(session.connectionPolicy).toEqual({
      dialAddress: "93.184.216.34",
      originalHostname: "smtp.example.com",
      tlsServername: "smtp.example.com",
      tls: "implicit",
      certificateVerification: "required",
      startTls: "not_applicable",
      authentication: "after_verified_tls",
      logging: "disabled",
      egressTransport: "authenticated_byte_relay",
      proxy: "disabled",
    });

    await expect(
      session.submit(
        {
          accountId: "other-account",
          operationId: "cross-account-send",
          messageId: "<cross-account@example.com>",
          envelope: { from: "me@example.com", to: [], cc: [], bcc: [] },
          rawMimeSha256: "e".repeat(64),
          rawMimeBytes: 1,
        },
        { deadlineAt: 1_000, beforeData: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: "protocol_session_invalid" });

    await session.close();
    await expect(
      session.submit(
        {
          accountId: "account-1",
          operationId: "send-after-close",
          messageId: "<send-after-close@example.com>",
          envelope: { from: "me@example.com", to: [], cc: [], bcc: [] },
          rawMimeSha256: "f".repeat(64),
          rawMimeBytes: 1,
        },
        { deadlineAt: 1_000, beforeData: async () => undefined },
      ),
    ).rejects.toMatchObject({ code: "protocol_session_closed" });
  });

  it("runs APPEND through the durable literal barrier and supports UID-less success", async () => {
    const factory = new FakeImapSessionFactory(
      {
        capabilities: ["IMAP4rev1"],
        pages: [],
        appendOutcomes: [{ kind: "stored_without_uid" }],
      },
      sessionOptions(),
    );
    const session = await factory.open(openRequest("imap"));
    let barriers = 0;
    await expect(
      session.appendSentCopy(
        {
          accountId: "account-1",
          mailboxId: "sent",
          remotePath: "Sent",
          operationId: "send-1",
          messageId: "<send-1@example.com>",
          rawMime: { sha256: "a".repeat(64), bytes: 512 },
        },
        {
          deadlineAt: 1_000,
          beforeLiteral: async () => {
            barriers += 1;
          },
        },
      ),
    ).resolves.toEqual({ kind: "stored_without_uid" });
    expect(barriers).toBe(1);
  });

  it("keeps the MIME parser fake structurally isolated from network and credentials", async () => {
    const textData = Buffer.from("fake parsed text");
    const parser = new FakeIsolatedMailParser({
      text: { ...stagedBlob(textData), secret: "must-not-cross" },
      sanitizedHtml: null,
      remoteImages: [],
      attachments: [],
      endpoint: "must-not-cross",
    } as unknown as ConstructorParameters<typeof FakeIsolatedMailParser>[0]);
    expect(parser.isolation).toEqual({
      networkAccess: false,
      credentialAccess: false,
      sandboxVersion: 1,
    });
    const result = await parser.parse({
      operationId: "parse-1",
      rawMime: { sha256: "a".repeat(64), bytes: 512, secret: "must-not-cross" },
      budget: {
        deadlineAt: 1_000,
        maxRawBytes: 1_024,
        maxDecodedBytes: 2_048,
        maxHeaderBytes: 512,
        maxHtmlCharacters: 1_024,
        maxTextCharacters: 2_048,
        maxAddresses: 10,
        maxParts: 10,
        maxDepth: 4,
        maxDomNodes: 100,
        maxDomAttributes: 200,
        maxInlineImagePixels: 1_000_000,
        maxInlineImageFrames: 1,
        maxRemoteImages: 10,
        credentialRef: { id: "must-not-cross" },
      },
      rawMimeStream: chunksFor(Buffer.alloc(512)),
      signal: new AbortController().signal,
      endpoint: "must-not-cross",
    } as unknown as Parameters<typeof parser.parse>[0]);
    expect(JSON.stringify(parser.calls)).not.toMatch(/credential|password|endpoint|hostname/i);
    expect(result).toEqual({
      kind: "parsed",
      artifacts: {
        text: stagedBlob(textData),
        sanitizedHtml: null,
        remoteImages: [],
        attachments: [],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|endpoint/i);
    expect(parser.calls).toEqual([
      {
        operationId: "parse-1",
        rawMime: { sha256: "a".repeat(64), bytes: 512 },
        budget: {
          deadlineAt: 1_000,
          maxRawBytes: 1_024,
          maxDecodedBytes: 2_048,
          maxHeaderBytes: 512,
          maxHtmlCharacters: 1_024,
          maxTextCharacters: 2_048,
          maxAddresses: 10,
          maxParts: 10,
          maxDepth: 4,
          maxDomNodes: 100,
          maxDomAttributes: 200,
          maxInlineImagePixels: 1_000_000,
          maxInlineImageFrames: 1,
          maxRemoteImages: 10,
        },
      },
    ]);
  });
});

function stagedBlob(data: Uint8Array) {
  return {
    descriptor: {
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes: data.byteLength,
    },
    data,
  };
}

async function* chunksFor(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
