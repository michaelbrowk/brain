import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAIL_HTML_POLICY,
  MAIL_PARSER_PROCESS_LIMITS,
  MAIL_PROCESS_LIMITS,
  MAIL_RESOURCE_LIMITS,
  admitMailSystemUsage,
  admitMimeProgress,
  admitMimeShape,
  admitOutgoingRawMessage,
  admitRawMessage,
  canonicalizeSmtpEgressRelayAuthorization,
  classifyEmailResource,
  createSmtpEgressRelayAuthorizationPayload,
  isForbiddenResolvedAddress,
  isInlineSafeAttachment,
  mailRequestPhase,
  projectMailLogRecord,
  validateImapSyncPage,
  validateMailAccountRuntimeConfig,
  validateMailBlobDescriptor,
  validateMailMimeParseRequest,
  validateMailRemoteImageSourceUrl,
  validateMailProtocolSessionOpenRequest,
  validateMailServiceHealth,
  validateMailSystemReservationDelta,
  validateMailEndpoint,
  validateMailTlsProof,
  validateMimeParseBudget,
  validateParsedMailArtifactSet,
  validateResolvedMailTargets,
  validateSmtpEgressRelayAuthorizationEnvelope,
  validateSmtpEgressRelayChallenge,
  validateSmtpEgressTunnelOpenRequest,
  validateSmtpEgressTunnelProof,
} from "./security";

describe("mail security and resource contracts", () => {
  it("keeps the personal-mail workload inside the shared droplet budget", () => {
    expect(MAIL_RESOURCE_LIMITS).toMatchObject({
      maxAccounts: 3,
      rawMessageBytes: 40 * 1024 * 1024,
      headerBytes: 256 * 1024,
      htmlCharacters: 1024 * 1024,
      textCharacters: 2 * 1024 * 1024,
      mimeParts: 256,
      mimeNestingDepth: 32,
      addressesPerMessage: 200,
      syncBatchMessages: 50,
      concurrentFetchStreams: 2,
      concurrentMimeParsers: 2,
      concurrentSmtpSubmissions: 1,
      outgoingRawMessageBytes: 1024 * 1024,
      egressTunnelFrameBytes: 16 * 1024,
      egressTunnelClientBytes: 2 * 1024 * 1024,
    });
    expect(MAIL_PARSER_PROCESS_LIMITS.memoryMaxBytes).toBeLessThan(
      MAIL_PROCESS_LIMITS.memoryMaxBytes,
    );
    expect(MAIL_PARSER_PROCESS_LIMITS.cpuQuotaPercent).toBeLessThan(
      MAIL_PROCESS_LIMITS.cpuQuotaPercent,
    );
    expect(MAIL_RESOURCE_LIMITS.idleRestartMs).toBeLessThan(29 * 60_000);
    expect(() => admitRawMessage(MAIL_RESOURCE_LIMITS.rawMessageBytes)).not.toThrow();
    expect(() => admitRawMessage(MAIL_RESOURCE_LIMITS.rawMessageBytes + 1)).toThrow(
      /raw message/i,
    );
    expect(() =>
      admitOutgoingRawMessage(MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes),
    ).not.toThrow();
    expect(() =>
      admitOutgoingRawMessage(MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes + 1),
    ).toThrow(/outgoing raw message/i);
    expect(() =>
      admitMimeShape({
        headerBytes: MAIL_RESOURCE_LIMITS.headerBytes + 1,
        htmlCharacters: 0,
        textCharacters: 0,
        partCount: 1,
        nestingDepth: 1,
        addressCount: 1,
      }),
    ).toThrow(/headers/i);
    expect(MAIL_PROCESS_LIMITS).toMatchObject({
      memoryHighBytes: 192 * 1024 * 1024,
      memoryMaxBytes: 256 * 1024 * 1024,
      cpuQuotaPercent: 35,
      tasksMax: 32,
      openFilesMax: 256,
    });
  });

  it("enforces incremental parser and system-wide quotas", () => {
    expect(() =>
      admitMimeProgress({
        rawBytes: MAIL_RESOURCE_LIMITS.rawMessageBytes,
        decodedBytes: MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes,
        headerBytes: MAIL_RESOURCE_LIMITS.headerBytes,
        htmlCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
        textCharacters: MAIL_RESOURCE_LIMITS.textCharacters,
        addressCount: MAIL_RESOURCE_LIMITS.addressesPerMessage,
        partCount: MAIL_RESOURCE_LIMITS.mimeParts,
        nestingDepth: MAIL_RESOURCE_LIMITS.mimeNestingDepth,
        domNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
        domAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
        inlineImageDecodedPixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels,
        inlineImageFrames: MAIL_RESOURCE_LIMITS.maxInlineImageFrames,
      }),
    ).not.toThrow();
    expect(() =>
      admitMimeProgress({
        rawBytes: 1,
        decodedBytes: MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes + 1,
        headerBytes: 1,
        htmlCharacters: 1,
        textCharacters: 1,
        addressCount: 1,
        partCount: 1,
        nestingDepth: 1,
        domNodes: 1,
        domAttributes: 1,
        inlineImageDecodedPixels: 1,
        inlineImageFrames: 1,
      }),
    ).toThrow(/decoded/i);
    expect(() =>
      admitMimeProgress({
        rawBytes: 1,
        decodedBytes: 1,
        headerBytes: 1,
        htmlCharacters: 1,
        textCharacters: 1,
        addressCount: 1,
        partCount: 1,
        nestingDepth: 1,
        domNodes: 1,
        domAttributes: 1,
        inlineImageDecodedPixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels + 1,
        inlineImageFrames: 1,
      }),
    ).toThrow(/image pixel/i);
    expect(() =>
      validateMimeParseBudget(
        {
          deadlineAt: 2,
          maxRawBytes: MAIL_RESOURCE_LIMITS.rawMessageBytes,
          maxDecodedBytes: MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes,
          maxHeaderBytes: MAIL_RESOURCE_LIMITS.headerBytes,
          maxHtmlCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
          maxTextCharacters: MAIL_RESOURCE_LIMITS.textCharacters,
          maxAddresses: MAIL_RESOURCE_LIMITS.addressesPerMessage,
          maxParts: MAIL_RESOURCE_LIMITS.mimeParts,
          maxDepth: MAIL_RESOURCE_LIMITS.mimeNestingDepth,
          maxDomNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
          maxDomAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
          maxInlineImagePixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels,
          maxInlineImageFrames: MAIL_RESOURCE_LIMITS.maxInlineImageFrames,
          maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
        },
        1,
      ),
    ).not.toThrow();

    const usage = {
      accounts: MAIL_RESOURCE_LIMITS.maxAccounts,
      mailboxes:
        MAIL_RESOURCE_LIMITS.maxAccounts * MAIL_RESOURCE_LIMITS.maxMailboxesPerAccount,
      activeImapConnections: MAIL_RESOURCE_LIMITS.maxActiveImapConnections,
      idleSessions: MAIL_RESOURCE_LIMITS.maxIdleSessions,
      concurrentFetchStreams: MAIL_RESOURCE_LIMITS.concurrentFetchStreams,
      concurrentMimeParsers: MAIL_RESOURCE_LIMITS.concurrentMimeParsers,
      concurrentSmtpSubmissions: MAIL_RESOURCE_LIMITS.concurrentSmtpSubmissions,
      queuedSubmissions: MAIL_RESOURCE_LIMITS.maxQueuedSubmissions,
      cacheBytes: MAIL_RESOURCE_LIMITS.maxCacheBytes,
      cacheMessages: MAIL_RESOURCE_LIMITS.maxCacheMessages,
      temporaryBytes: MAIL_RESOURCE_LIMITS.maxTemporaryBytes,
      walBytes: MAIL_RESOURCE_LIMITS.maxWalBytes,
      openFileDescriptors: MAIL_RESOURCE_LIMITS.maxOpenFileDescriptors,
    };
    expect(() => admitMailSystemUsage(usage)).not.toThrow();
    expect(() =>
      admitMailSystemUsage({
        ...usage,
        queuedSubmissions: MAIL_RESOURCE_LIMITS.maxQueuedSubmissions + 1,
      }),
    ).toThrow(/quota/i);
  });

  it("validates exact aggregate reservation deltas and parser requests", () => {
    expect(
      validateMailSystemReservationDelta({
        concurrentFetchStreams: 1,
        temporaryBytes: 1_024,
      }),
    ).toEqual({ concurrentFetchStreams: 1, temporaryBytes: 1_024 });
    for (const delta of [
      { concurrentMimeParsers: -1 },
      { concurrentSmtpSubmissions: 0.5 },
      { concurrentFetchStreams: Number.NaN },
      { concurrentFetchStreams: MAIL_RESOURCE_LIMITS.concurrentFetchStreams + 1 },
      { unknownCounter: 1 },
    ]) {
      expect(() =>
        validateMailSystemReservationDelta(
          delta as Parameters<typeof validateMailSystemReservationDelta>[0],
        ),
      ).toThrow();
    }

    const projected = validateMailMimeParseRequest(
      {
        operationId: "parse-1",
        rawMime: { sha256: "a".repeat(64), bytes: 512, secret: "drop-me" },
        budget: {
          deadlineAt: 2,
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
          maxInlineImageFrames: 10,
          maxRemoteImages: 10,
          credentialRef: { id: "must-not-cross" },
        },
        endpoint: "must-not-cross",
      } as Parameters<typeof validateMailMimeParseRequest>[0],
      1,
    );
    expect(projected).toEqual({
      operationId: "parse-1",
      rawMime: { sha256: "a".repeat(64), bytes: 512 },
      budget: {
        deadlineAt: 2,
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
        maxInlineImageFrames: 10,
        maxRemoteImages: 10,
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/credential|endpoint|secret/i);
    expect(
      validateMailBlobDescriptor({ sha256: "0".repeat(64), bytes: 0 }),
    ).toEqual({ sha256: "0".repeat(64), bytes: 0 });
    expect(() =>
      validateMailMimeParseRequest(
        {
          ...projected,
          rawMime: { sha256: "0".repeat(64), bytes: 0 },
        },
        1,
      ),
    ).toThrow(/raw message size/i);

    const textData = Buffer.from("bounded text");
    const attachmentData = Buffer.from("attachment");
    expect(
      validateParsedMailArtifactSet({
        text: { ...stagedBlob(textData), secret: "drop-me" },
        sanitizedHtml: null,
        remoteImages: [],
        attachments: [
          {
            filename: "note.txt",
            mimeType: "text/plain",
            disposition: "attachment",
            contentId: null,
            blob: { ...stagedBlob(attachmentData), endpoint: "drop-me" },
            secret: "drop-me",
          },
        ],
        credentialRef: { id: "drop-me" },
      } as unknown as Parameters<typeof validateParsedMailArtifactSet>[0]),
    ).toEqual({
      text: stagedBlob(textData),
      sanitizedHtml: null,
      remoteImages: [],
      attachments: [
        {
          filename: "note.txt",
          mimeType: "text/plain",
          disposition: "attachment",
          contentId: null,
          blob: stagedBlob(attachmentData),
        },
      ],
    });
    expect(
      validateParsedMailArtifactSet({
        text: null,
        sanitizedHtml: null,
        remoteImages: [],
        attachments: [
          {
            filename: "empty.bin",
            mimeType: "application/octet-stream",
            disposition: "attachment",
            contentId: null,
            blob: stagedBlob(Buffer.alloc(0)),
          },
        ],
      }),
    ).toEqual({
      text: null,
      sanitizedHtml: null,
      remoteImages: [],
      attachments: [
        {
          filename: "empty.bin",
          mimeType: "application/octet-stream",
          disposition: "attachment",
          contentId: null,
          blob: stagedBlob(Buffer.alloc(0)),
        },
      ],
    });
    expect(() =>
      validateParsedMailArtifactSet({
        text: stagedBlob(Buffer.alloc(0)),
        sanitizedHtml: null,
        remoteImages: [],
        attachments: [],
      }),
    ).toThrow(/must not be empty/i);
    expect(() =>
      validateParsedMailArtifactSet({
        text: null,
        sanitizedHtml: null,
        remoteImages: [],
        attachments: Array.from(
          { length: MAIL_RESOURCE_LIMITS.mimeParts + 1 },
          () => ({
            filename: null,
            mimeType: "application/octet-stream",
            disposition: "attachment" as const,
            contentId: null,
            blob: stagedBlob(Buffer.from("x")),
          }),
        ),
      }),
    ).toThrow(/attachment count/i);
  });

  it("keeps remote image origins in an exact opaque manifest", () => {
    const remoteImageId = `remote-image-a${"1".repeat(32)}`;
    const sourceUrl = "https://images.example.com/banner.png?campaign=mail";
    const sanitizedHtml = stagedBlob(
      Buffer.from(`<img data-brain-remote-image="${remoteImageId}" alt="Banner">`),
    );
    expect(
      validateParsedMailArtifactSet({
        text: null,
        sanitizedHtml,
        attachments: [],
        remoteImages: [{ remoteImageId, sourceUrl }],
      }),
    ).toEqual({
      text: null,
      sanitizedHtml,
      attachments: [],
      remoteImages: [{ remoteImageId, sourceUrl }],
    });
    expect(validateMailRemoteImageSourceUrl(sourceUrl)).toBe(sourceUrl);
    for (const unsafe of [
      "http://images.example.com/banner.png",
      "https://127.0.0.1/banner.png",
      "https://localhost/banner.png",
      "https://localhost./banner.png",
      "https://foo.local./banner.png",
      "https://user:secret@images.example.com/banner.png",
    ]) {
      expect(() => validateMailRemoteImageSourceUrl(unsafe)).toThrow(/invalid/i);
    }
    expect(() =>
      validateParsedMailArtifactSet({
        text: null,
        sanitizedHtml: stagedBlob(Buffer.from("<p>no image reference</p>")),
        attachments: [],
        remoteImages: [{ remoteImageId, sourceUrl }],
      }),
    ).toThrow(/does not match/i);
    expect(() =>
      validateParsedMailArtifactSet({
        text: null,
        sanitizedHtml: stagedBlob(
          Buffer.from(
            `<img data-brain-remote-image="${remoteImageId}">${sourceUrl}`,
          ),
        ),
        attachments: [],
        remoteImages: [{ remoteImageId, sourceUrl }],
      }),
    ).toThrow(/does not match/i);
  });

  it("allows only standard TLS mail endpoints", () => {
    expect(
      validateMailEndpoint("imap", {
        hostname: "imap.example.com",
        port: 993,
        tls: "implicit",
      }),
    ).toEqual({ hostname: "imap.example.com", port: 993, tls: "implicit" });
    expect(
      validateMailEndpoint("smtp", {
        hostname: "smtp.example.com",
        port: 587,
        tls: "starttls",
      }),
    ).toEqual({ hostname: "smtp.example.com", port: 587, tls: "starttls" });

    expect(() =>
      validateMailEndpoint("imap", {
        hostname: "127.0.0.1",
        port: 993,
        tls: "implicit",
      }),
    ).toThrow(/hostname/i);
    expect(() =>
      validateMailEndpoint("smtp", {
        hostname: "smtp.example.com",
        port: 25,
        tls: "starttls",
      }),
    ).toThrow(/port/i);
    expect(() =>
      validateMailEndpoint("smtp", {
        hostname: "smtp.example.com",
        port: 587,
        tls: "implicit",
      }),
    ).toThrow(/tls/i);
  });

  it("binds TLS proof to the configured literal address and original hostname", () => {
    const endpoint = { hostname: "smtp.example.com", port: 587, tls: "starttls" as const };
    const [target] = validateResolvedMailTargets("smtp", endpoint, {
      resolutionId: "resolution-1",
      resolvedAt: 100,
      expiresAt: 1_000,
      addresses: [{ address: "1.1.1.1", family: 4 }],
    }, 100);
    const proof = {
      protocol: "smtp" as const,
      resolutionId: "resolution-1",
      hostname: "smtp.example.com",
      address: "1.1.1.1",
      family: 4 as const,
      tls: "starttls" as const,
      certificateVerified: true as const,
      startTlsVerified: true,
      establishedAt: 101,
    };
    expect(validateMailTlsProof(target, proof, 101)).toEqual(proof);
    expect(() =>
      validateMailTlsProof(target, { ...proof, address: "9.9.9.9" }, 101),
    ).toThrow(/pinned/i);
    expect(() =>
      validateMailTlsProof(target, { ...proof, hostname: "attacker.example.net" }, 101),
    ).toThrow(/pinned/i);
    expect(() =>
      validateMailTlsProof(target, { ...proof, startTlsVerified: false }, 101),
    ).toThrow(/pinned/i);
    expect(() =>
      validateResolvedMailTargets("smtp", endpoint, {
        resolutionId: "resolution-2",
        resolvedAt: 100,
        expiresAt: 1_000,
        addresses: [
          { address: "1.1.1.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }, 100),
    ).toThrow(/forbidden/i);
    expect(() =>
      validateResolvedMailTargets("smtp", endpoint, {
        resolutionId: "resolution-3",
        resolvedAt: 100,
        expiresAt: 1_000,
        addresses: [],
      }, 100),
    ).toThrow(/count/i);
  });

  it("preserves separate provider-specific IMAP and SMTP authentication references", () => {
    const config = validateMailAccountRuntimeConfig({
      accountId: "account-1",
      emailAddress: "me@example.com",
      imap: {
        endpoint: { hostname: "imap.example.com", port: 993, tls: "implicit" },
        auth: {
          username: "imap-login",
          credentialRef: { id: "imap-secret", version: 2 },
        },
        transportBindingRef: { id: "imap-binding", version: 3 },
      },
      smtp: {
        endpoint: { hostname: "smtp.example.com", port: 587, tls: "starttls" },
        auth: {
          username: "smtp-login",
          credentialRef: { id: "smtp-secret", version: 7 },
        },
        transportBindingRef: { id: "smtp-binding", version: 8 },
      },
    });
    expect(config.imap.auth).toEqual({
      username: "imap-login",
      credentialRef: { id: "imap-secret", version: 2 },
    });
    expect(config.smtp.auth).toEqual({
      username: "smtp-login",
      credentialRef: { id: "smtp-secret", version: 7 },
    });
  });

  it("blocks resolved internal and metadata-network addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.2",
      "172.16.0.1",
      "192.168.1.2",
      "169.254.169.254",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "100.64.0.1",
      "::ffff:127.0.0.1",
      "::127.0.0.1",
      "fec0::1",
      "2002:0a00:0001::1",
      "198.18.0.1",
      "192.0.0.1",
      "192.0.2.10",
      "198.51.100.10",
      "203.0.113.10",
      "2001:db8::1",
      "2001:1000::1",
      "2001:6000::1",
      "3fff::1",
      "3ffe::1",
      "3fff:1000::1",
      "2d00::1",
      "100::1",
      "::ffff:1.1.1.1",
    ]) {
      expect(isForbiddenResolvedAddress(address), address).toBe(true);
    }
    expect(isForbiddenResolvedAddress("1.1.1.1")).toBe(false);
    for (const address of [
      "2001:200::1",
      "2001:9ff::1",
      "2001:2000::1",
      "2001:3fff::1",
      "2001:4000::1",
      "2001:5000::1",
      "2001:8000::1",
      "2001:a000::1",
      "2001:bfff::1",
      "2003::1",
      "2410::1",
      "2606:4700:4700::1111",
      "2610::1",
      "2620::1",
      "2630::1",
      "2a10::1",
    ]) {
      expect(isForbiddenResolvedAddress(address), address).toBe(false);
    }
  });

  it("canonicalizes IPv6 answers before pinning and duplicate detection", () => {
    const endpoint = { hostname: "imap.example.com", port: 993, tls: "implicit" as const };
    const [target] = validateResolvedMailTargets("imap", endpoint, {
      resolutionId: "resolution-ipv6",
      resolvedAt: 100,
      expiresAt: 1_000,
      addresses: [{ address: "2606:4700:4700:0:0:0:0:1111", family: 6 }],
    }, 100);
    expect(target.address).toBe("2606:4700:4700::1111");
    expect(() =>
      validateResolvedMailTargets("imap", endpoint, {
        resolutionId: "resolution-ipv6-duplicate",
        resolvedAt: 100,
        expiresAt: 1_000,
        addresses: [
          { address: "2606:4700:4700:0:0:0:0:1111", family: 6 },
          { address: "2606:4700:4700::1111", family: 6 },
        ],
      }, 100),
    ).toThrow(/repeats/i);
  });

  it("validates an exact session-open target before an adapter can use it", () => {
    const [target] = validateResolvedMailTargets(
      "smtp",
      { hostname: "smtp.example.com", port: 465, tls: "implicit" },
      {
        resolutionId: "resolution-open",
        resolvedAt: 100,
        expiresAt: 1_000,
        addresses: [{ address: "1.1.1.1", family: 4 }],
      },
      100,
    );
    const request = {
      accountId: "account-1",
      target,
      bindingRef: { id: "binding-1", version: 1 },
      deadlineAt: 101,
    };
    expect(validateMailProtocolSessionOpenRequest("smtp", request, 100)).toEqual(request);
    expect(() =>
      validateMailProtocolSessionOpenRequest("smtp", {
        ...request,
        target: { ...target, address: "127.0.0.1" },
      }, 100),
    ).toThrow(/canonical public address/i);
    expect(() =>
      validateMailProtocolSessionOpenRequest("smtp", {
        ...request,
        credentialRef: { id: "must-not-cross", version: 1 },
      } as Parameters<typeof validateMailProtocolSessionOpenRequest>[1], 100),
    ).toThrow(/unknown field/i);
    expect(() =>
      validateMailProtocolSessionOpenRequest("smtp", {
        ...request,
        accountId: 1,
      } as unknown as Parameters<typeof validateMailProtocolSessionOpenRequest>[1], 100),
    ).toThrow(/account id is invalid/i);
    expect(() =>
      validateMailProtocolSessionOpenRequest(
        "smtp",
        { ...request, deadlineAt: target.expiresAt + 1 },
        100,
      ),
    ).toThrow(/deadline exceeds target expiry/i);
    expect(() =>
      validateMailProtocolSessionOpenRequest("smtp", request, target.expiresAt),
    ).toThrow(/expired/i);
  });

  it("bounds DNS freshness and validates authenticated SMTP tunnel proofs", () => {
    const endpoint = { hostname: "smtp.example.com", port: 465, tls: "implicit" as const };
    const [target] = validateResolvedMailTargets(
      "smtp",
      endpoint,
      {
        resolutionId: "relay-resolution",
        resolvedAt: 1_000,
        expiresAt: 61_000,
        addresses: [{ address: "1.1.1.1", family: 4 }],
      },
      1_000,
    );
    const request = {
      transport: "authenticated_byte_relay" as const,
      sessionId: "relay-session",
      attemptId: "relay-attempt",
      target,
      deadlineAt: 31_000,
    } as const;
    expect(validateSmtpEgressTunnelOpenRequest(request, 1_000)).toEqual(request);

    const challenge = {
      version: 1 as const,
      audience: "brain-mail-smtp-egress-v1" as const,
      challenge: "a".repeat(64),
      issuedAt: 1_000,
      expiresAt: 6_000,
    };
    expect(validateSmtpEgressRelayChallenge(challenge, 1_000)).toEqual(challenge);
    const authorizationPayload = createSmtpEgressRelayAuthorizationPayload(
      request,
      challenge,
      1_000,
    );
    expect(canonicalizeSmtpEgressRelayAuthorization(authorizationPayload)).toBe(
      [
        "brain-mail-smtp-egress-hmac-v1",
        "1",
        "brain-mail-smtp-egress-v1",
        "authenticated_byte_relay",
        "a".repeat(64),
        "1000",
        "6000",
        request.sessionId,
        request.attemptId,
        target.resolutionId,
        target.address,
        "4",
        "465",
        "61000",
        "31000",
      ].join("\n"),
    );
    const authorization = {
      ...authorizationPayload,
      hmacSha256: "b".repeat(64),
    };
    expect(
      validateSmtpEgressRelayAuthorizationEnvelope(challenge, authorization, 1_000),
    ).toEqual(authorization);
    expect(() =>
      validateSmtpEgressRelayAuthorizationEnvelope(
        { ...challenge, challenge: "c".repeat(64) },
        authorization,
        1_000,
      ),
    ).toThrow(/this connection challenge/i);
    expect(
      canonicalizeSmtpEgressRelayAuthorization({
        ...authorizationPayload,
        address: "9.9.9.9",
      }),
    ).not.toBe(canonicalizeSmtpEgressRelayAuthorization(authorizationPayload));
    expect(() =>
      validateSmtpEgressRelayAuthorizationEnvelope(
        challenge,
        { ...authorization, hmacSha256: "not-a-hmac" },
        1_000,
      ),
    ).toThrow(/HMAC/i);
    expect(() =>
      validateSmtpEgressRelayAuthorizationEnvelope(
        challenge,
        { ...authorization, port: 25 } as unknown as Parameters<
          typeof validateSmtpEgressRelayAuthorizationEnvelope
        >[1],
        1_000,
      ),
    ).toThrow(/port/i);
    expect(() => validateSmtpEgressRelayChallenge(challenge, challenge.expiresAt)).toThrow(
      /expired/i,
    );
    expect(() =>
      createSmtpEgressRelayAuthorizationPayload(
        request,
        { ...challenge, issuedAt: 2_000, expiresAt: 7_000 },
        1_000,
      ),
    ).not.toThrow();

    const proof = {
      transport: "authenticated_byte_relay" as const,
      sessionId: request.sessionId,
      attemptId: request.attemptId,
      resolutionId: target.resolutionId,
      address: target.address,
      family: target.family,
      port: 465 as const,
      remoteAddress: null,
      connectedAt: 1_001,
    };
    expect(validateSmtpEgressTunnelProof(request, proof, 1_001)).toEqual(proof);
    expect(() =>
      validateSmtpEgressTunnelProof(
        request,
        { ...proof, remoteAddress: "9.9.9.9" },
        1_001,
      ),
    ).toThrow(/remote address/i);
    expect(() =>
      validateSmtpEgressTunnelProof(
        request,
        { ...proof, sessionId: "other-session" },
        1_001,
      ),
    ).toThrow(/does not match/i);
    expect(() =>
      validateSmtpEgressTunnelProof(
        request,
        { ...proof, transport: "direct", remoteAddress: null },
        1_001,
      ),
    ).toThrow(/does not match/i);
    const directRequest = { ...request, transport: "direct" as const };
    expect(() =>
      validateSmtpEgressTunnelProof(
        directRequest,
        { ...proof, transport: "direct", remoteAddress: null },
        1_001,
      ),
    ).toThrow(/must expose/i);
    expect(
      validateSmtpEgressTunnelProof(
        directRequest,
        { ...proof, transport: "direct", remoteAddress: target.address },
        1_001,
      ),
    ).toMatchObject({ transport: "direct", remoteAddress: target.address });
    expect(
      validateSmtpEgressTunnelProof(
        request,
        { ...proof, connectedAt: 999_999 },
        1_001,
      ),
    ).toMatchObject({ transport: "authenticated_byte_relay", connectedAt: 999_999 });
    expect(() =>
      validateSmtpEgressTunnelProof(
        directRequest,
        {
          ...proof,
          transport: "direct",
          remoteAddress: target.address,
          connectedAt: 999_999,
        },
        1_001,
      ),
    ).toThrow(/time/i);
    expect(() =>
      validateResolvedMailTargets(
        "smtp",
        endpoint,
        {
          resolutionId: "stale-resolution",
          resolvedAt: 1_000,
          expiresAt: 1_000 + 5 * 60_000 + 1,
          addresses: [{ address: "1.1.1.1", family: 4 }],
        },
        1_000,
      ),
    ).toThrow(/freshness/i);
  });

  it("blocks the RFC 6052 and RFC 8215 NAT64 translation prefixes", () => {
    for (const address of [
      "64:ff9b::7f00:1",
      "64:ff9b::a00:1",
      "64:ff9b::6440:1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::7f00:1",
      "64:ff9b:1::ac10:1",
      "64:ff9b:1::c0a8:1",
      "64:ff9b:1::a9fe:a9fe",
    ]) {
      expect(isForbiddenResolvedAddress(address), address).toBe(true);
    }

    expect(isForbiddenResolvedAddress("64:ff9b::cb00:710a")).toBe(true);
    expect(isForbiddenResolvedAddress("64:ff9b:1::cb00:710a")).toBe(true);
  });

  it("validates bounded IMAP metadata pages before persistence", () => {
    const page = {
      uidValidity: "101",
      highestModSeq: "9223372036854775807",
      highestUid: 7,
      vanishedUids: [2],
      messages: [{ uid: 7, modSeq: "9", flags: ["\\Seen"], rfc822Size: 512 }],
    };
    expect(validateImapSyncPage(page)).toEqual(page);
    expect(() =>
      validateImapSyncPage({
        ...page,
        messages: Array.from(
          { length: MAIL_RESOURCE_LIMITS.syncBatchMessages + 1 },
          (_, index) => ({
            uid: index + 1,
            modSeq: "9",
            flags: [],
            rfc822Size: 1,
          }),
        ),
        highestUid: MAIL_RESOURCE_LIMITS.syncBatchMessages + 1,
        vanishedUids: [],
      }),
    ).toThrow(/message count/i);
    expect(() =>
      validateImapSyncPage({ ...page, highestModSeq: "9223372036854775808" }),
    ).toThrow(/63-bit/i);
    expect(() =>
      validateImapSyncPage({ ...page, vanishedUids: [7] }),
    ).toThrow(/vanishes/i);
    expect(() =>
      validateImapSyncPage({
        ...page,
        highestModSeq: "8",
      }),
    ).toThrow(/page cursor/i);
  });

  it("blocks remote content and only identifies strict cid references", () => {
    expect(classifyEmailResource("https://tracker.example/pixel.gif")).toEqual({
      kind: "blocked_remote",
    });
    expect(classifyEmailResource("//tracker.example/pixel.gif")).toEqual({
      kind: "blocked_remote",
    });
    expect(classifyEmailResource("cid:logo@example.com")).toEqual({
      kind: "inline_cid",
      contentId: "logo@example.com",
    });
    expect(classifyEmailResource("data:image/png;base64,AAAA")).toEqual({
      kind: "blocked",
    });
    expect(classifyEmailResource("javascript:alert(1)")).toEqual({
      kind: "blocked",
    });

    expect(MAIL_HTML_POLICY.sandbox).toBe("allow-same-origin");
    expect(MAIL_HTML_POLICY.contentSecurityPolicy).toContain("default-src 'none'");
    expect(MAIL_HTML_POLICY.contentSecurityPolicy).toContain(
      "style-src 'unsafe-inline'",
    );
    expect(MAIL_HTML_POLICY.forbiddenTags).toEqual(
      expect.arrayContaining(["script", "iframe", "form", "svg", "math", "style"]),
    );
    expect(MAIL_HTML_POLICY.forbiddenAttributes).not.toContain("style");
    expect(MAIL_HTML_POLICY.forbiddenAttributePrefixes).toContain("on");
    expect(MAIL_HTML_POLICY.classifiedResourceAttributes).toEqual(
      expect.arrayContaining(["href", "src"]),
    );
  });

  it("renders only verified raster cid attachments inline", () => {
    expect(
      isInlineSafeAttachment({
        mimeType: "image/png",
        disposition: "inline",
        contentId: "logo@example.com",
        verifiedRaster: { width: 800, height: 600, frames: 1 },
      }),
    ).toBe(true);
    for (const mimeType of ["image/svg+xml", "text/html", "application/pdf"] ) {
      expect(
        isInlineSafeAttachment({
          mimeType,
          disposition: "inline",
          contentId: "asset@example.com",
          verifiedRaster: { width: 800, height: 600, frames: 1 },
        }),
      ).toBe(false);
    }
    expect(
      isInlineSafeAttachment({
        mimeType: "image/png",
        disposition: "inline",
        contentId: "huge@example.com",
        verifiedRaster: { width: 100_000, height: 100_000, frames: 1 },
      }),
    ).toBe(false);
    expect(
      isInlineSafeAttachment({
        mimeType: "image/gif",
        disposition: "inline",
        contentId: "animated@example.com",
        verifiedRaster: { width: 1_000, height: 1_000, frames: 41 },
      }),
    ).toBe(false);
    expect(
      isInlineSafeAttachment({
        mimeType: "image/png",
        disposition: "inline",
        contentId: "unverified@example.com",
        verifiedRaster: null,
      }),
    ).toBe(false);
  });

  it("enforces cumulative inline raster limits at exactly 12M pixels and 100 frames", () => {
    const pixelsAtLimit = validateParsedMailArtifactSet({
      text: null,
      sanitizedHtml: null,
      remoteImages: [],
      attachments: [
        inlineRasterArtifact("pixels-a", "image/png", testPng(3_000, 2_000)),
        inlineRasterArtifact("pixels-b", "image/png", testPng(3_000, 2_000)),
        inlineRasterArtifact("pixels-over", "image/png", testPng(1, 1)),
      ],
    });
    expect(pixelsAtLimit.attachments.map((attachment) => attachment.contentId)).toEqual([
      "pixels-a",
      "pixels-b",
      null,
    ]);

    const framesAtLimit = validateParsedMailArtifactSet({
      text: null,
      sanitizedHtml: null,
      remoteImages: [],
      attachments: [
        inlineRasterArtifact("frames-a", "image/gif", testGif(1, 1, 50)),
        inlineRasterArtifact("frames-b", "image/gif", testGif(1, 1, 50)),
        inlineRasterArtifact("frames-over", "image/gif", testGif(1, 1, 1)),
      ],
    });
    expect(framesAtLimit.attachments.map((attachment) => attachment.contentId)).toEqual([
      "frames-a",
      "frames-b",
      null,
    ]);
  });

  it("exposes the complete bounded health contract", () => {
    expect(
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "ok",
        localSchemaVersion: null,
        cacheSchemaVersion: null,
        receiveReadiness: "not_configured",
        sendReadiness: "not_configured",
        activeAccounts: 0,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: null,
        cachePressure: "normal",
        lastErrorCode: null,
      }),
    ).toMatchObject({
      apiVersion: 1,
      localSchemaVersion: null,
      cacheSchemaVersion: null,
      status: "ok",
    });
    expect(
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "degraded",
        localSchemaVersion: 1,
        cacheSchemaVersion: 2,
        receiveReadiness: "ready",
        sendReadiness: "egress_blocked",
        activeAccounts: 2,
        queuedSubmissions: 3,
        lastSuccessfulSyncAgeMs: 60_000,
        cachePressure: "warning",
        lastErrorCode: "imap_timeout",
      }),
    ).toEqual({
      apiVersion: 1,
      build: { commit: "dev", builtAt: "dev" },
      status: "degraded",
      localSchemaVersion: 1,
      cacheSchemaVersion: 2,
      receiveReadiness: "ready",
      sendReadiness: "egress_blocked",
      activeAccounts: 2,
      queuedSubmissions: 3,
      lastSuccessfulSyncAgeMs: 60_000,
      cachePressure: "warning",
      lastErrorCode: "imap_timeout",
    });
    expect(() =>
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "ok",
        localSchemaVersion: 1,
        cacheSchemaVersion: 1,
        receiveReadiness: "ready",
        sendReadiness: "ready",
        activeAccounts: 1,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: 0,
        cachePressure: "normal",
        lastErrorCode: "server said private subject",
      }),
    ).toThrow(/error code/i);
    expect(() =>
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "ok",
        localSchemaVersion: 1,
        cacheSchemaVersion: 1,
        receiveReadiness: "ready",
        sendReadiness: "egress_blocked",
        activeAccounts: 1,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: 0,
        cachePressure: "normal",
        lastErrorCode: null,
      }),
    ).toThrow(/inconsistent/i);
    expect(() =>
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "2026-07-13T12:00:00.000Z" },
        status: "ok",
        localSchemaVersion: null,
        cacheSchemaVersion: null,
        receiveReadiness: "not_configured",
        sendReadiness: "not_configured",
        activeAccounts: 0,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: null,
        cachePressure: "normal",
        lastErrorCode: null,
      }),
    ).toThrow(/build identity/i);
    expect(() =>
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "ok",
        localSchemaVersion: null,
        cacheSchemaVersion: null,
        receiveReadiness: "ready",
        sendReadiness: "not_configured",
        activeAccounts: 0,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: null,
        cachePressure: "normal",
        lastErrorCode: null,
      }),
    ).toThrow(/initialized schemas/i);
    expect(() =>
      validateMailServiceHealth({
        apiVersion: 1,
        build: { commit: "dev", builtAt: "dev" },
        status: "degraded",
        localSchemaVersion: null,
        cacheSchemaVersion: null,
        receiveReadiness: "not_configured",
        sendReadiness: "egress_blocked",
        activeAccounts: 0,
        queuedSubmissions: 0,
        lastSuccessfulSyncAgeMs: null,
        cachePressure: "normal",
        lastErrorCode: null,
      }),
    ).toThrow(/local schema/i);
  });

  it("fails closed on unknown or accessor-backed health fields", () => {
    const health = {
      apiVersion: 1 as const,
      build: { commit: "dev", builtAt: "dev" },
      status: "ok" as const,
      localSchemaVersion: 1,
      cacheSchemaVersion: 1,
      receiveReadiness: "ready" as const,
      sendReadiness: "ready" as const,
      activeAccounts: 1,
      queuedSubmissions: 0,
      lastSuccessfulSyncAgeMs: 0,
      cachePressure: "normal" as const,
      lastErrorCode: null,
    };

    expect(() =>
      validateMailServiceHealth({
        ...health,
        credentialRef: "must-not-cross",
      } as unknown as Parameters<typeof validateMailServiceHealth>[0]),
    ).toThrow(/unknown field/i);

    let accessorRead = false;
    const accessorBacked = Object.defineProperty({ ...health }, "status", {
      enumerable: true,
      get() {
        accessorRead = true;
        return "ok";
      },
    });
    expect(() =>
      validateMailServiceHealth(
        accessorBacked as Parameters<typeof validateMailServiceHealth>[0],
      ),
    ).toThrow(/data properties/i);
    expect(accessorRead).toBe(false);
  });

  it("projects only stable documented scalar mail log fields", () => {
    const fixture = {
      event: "mail_sync_failed",
      accountId: "account-1",
      mailboxId: "mailbox-1",
      operationId: "operation-1",
      phase: "backoff",
      durationBucket: "under_1_second",
      messageCount: 4,
      rawMimeBytes: 512,
      errorCode: "imap_timeout",
      queueDepth: 9,
      nested: {
        errorCode: "must_not_survive",
      },
    };

    expect(projectMailLogRecord(fixture)).toEqual({
      event: "mail_sync_failed",
      accountId: "account-1",
      mailboxId: "mailbox-1",
      operationId: "operation-1",
      phase: "backoff",
      durationBucket: "under_1_second",
      messageCount: 4,
      rawMimeBytes: 512,
      errorCode: "imap_timeout",
    });
  });

  it("drops credentials, server text, arrays, buffers, and unknown nested data", () => {
    const projected = projectMailLogRecord({
      event: "mail_submit_failed",
      accountId: "account-1",
      auth: { user: "me@example.com", pass: "provider-secret" },
      user: "me@example.com",
      pass: "provider-secret",
      error: "server echoed a private subject",
      response: "250 recipient@example.com accepted",
      reason: "private reason",
      detail: "private detail",
      recipients: ["recipient@example.com"],
      payload: Buffer.from("raw secret"),
      passwordBytes: 16,
      nested: { subject: "private subject" },
      messageCount: [1],
      rawMimeBytes: Buffer.from([1, 2, 3]),
    });

    expect(projected).toEqual({
      event: "mail_submit_failed",
      accountId: "account-1",
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /example\.com|provider-secret|private|recipient|raw secret/i,
    );
  });

  it("fails closed on unstable or unsafe allowed log values", () => {
    expect(projectMailLogRecord({ event: "Mail Sync Failed", accountId: "account-1" })).toBeNull();
    expect(projectMailLogRecord(["mail_sync_failed"])).toBeNull();
    expect(projectMailLogRecord(Buffer.from("mail_sync_failed"))).toBeNull();

    expect(
      projectMailLogRecord({
        event: "mail_sync_failed",
        accountId: "person@example.com",
        mailboxId: "mailbox/../../secret",
        operationId: "operation\nsubject",
        phase: "Backoff",
        durationBucket: "1 second",
        errorCode: "server said recipient@example.com",
        messageCount: -1,
        attachmentCount: 1.5,
        rawMimeBytes: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ event: "mail_sync_failed" });
  });

  /*
    A phase is what lets an operator place a failure. It is derived rather than
    passed so it cannot drift from the routes, and it carries no part of the
    path itself — a thread id, a message id and an attachment id all live there,
    and none of them has a field on the allowlist.
  */
  it("names a route family and its verb, and never the ids in the path", () => {
    expect(mailRequestPhase("PATCH", "/v1/threads/thread_1")).toBe("thread_patch");
    expect(mailRequestPhase("GET", "/v1/threads/thread_1")).toBe("thread_get");
    expect(mailRequestPhase("GET", "/v1/threads")).toBe("thread_list_get");
    expect(mailRequestPhase("POST", "/v1/message-content/m1")).toBe(
      "message_content_post",
    );
    expect(mailRequestPhase("GET", "/v1/mailboxes/sent/threads/t1")).toBe(
      "mailbox_thread_get",
    );
    expect(mailRequestPhase("POST", "/v1/drafts/d1/send")).toBe("draft_send_post");
    expect(mailRequestPhase("GET", "/v1/health")).toBe("health_get");
    expect(mailRequestPhase("GET", "/v1/oauth/gmail/callback")).toBe(
      "gmail_oauth_get",
    );
  });

  it("stays inside the stable code shape for an unknown route or a hostile verb", () => {
    for (const phase of [
      mailRequestPhase("GET", "/v1/nothing-here"),
      mailRequestPhase("GET", "/"),
      mailRequestPhase("SUBJECT: private", "/v1/threads/thread_1"),
      mailRequestPhase("", "/v1/threads/thread_1"),
    ]) {
      expect(phase).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(
        projectMailLogRecord({ event: "mail_request_failed", phase }),
      ).toEqual({ event: "mail_request_failed", phase });
    }
    // A route with no family has no verb worth naming either.
    expect(mailRequestPhase("GET", "/v1/nothing-here")).toBe("unknown_route");
    expect(mailRequestPhase("SUBJECT: private", "/v1/threads/t1")).toBe(
      "thread_other",
    );
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

function inlineRasterArtifact(
  contentId: string,
  mimeType: string,
  data: Buffer,
) {
  return {
    filename: `${contentId}.bin`,
    mimeType,
    disposition: "inline" as const,
    contentId,
    blob: stagedBlob(data),
  };
}

function testPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    testPngChunk("IHDR", header),
    testPngChunk("IDAT", Buffer.from([1])),
    testPngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function testPngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

function testGif(width: number, height: number, frames: number): Buffer {
  const logical = Buffer.alloc(7);
  logical.writeUInt16LE(width, 0);
  logical.writeUInt16LE(height, 2);
  const frame = Buffer.from([
    0x2c, 0, 0, 0, 0,
    width & 0xff, (width >>> 8) & 0xff,
    height & 0xff, (height >>> 8) & 0xff,
    0,
    2,
    2, 0x44, 0x01,
    0,
  ]);
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    logical,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}
