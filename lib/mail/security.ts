import { createHash } from "node:crypto";
import { isIP } from "node:net";

import type {
  ImapSyncPage,
  MailAccountRuntimeConfig,
  MailBlobDescriptor,
  MailEndpoint,
  MailMimeParseRequest,
  MailMimeParseBudget,
  MailMimeWorkerRequest,
  MailProtocol,
  MailProtocolSessionOpenRequest,
  MailServiceHealth,
  MailSystemUsage,
  MailTlsProof,
  ParsedMailArtifactSet,
  ParsedMailAttachment,
  ParsedMailStagedBlob,
  SmtpEgressRelayAuthorization,
  SmtpEgressRelayAuthorizationPayload,
  SmtpEgressRelayChallenge,
  SmtpEgressTunnelOpenRequest,
  SmtpEgressTunnelProof,
  ValidatedMailDialTarget,
} from "./ports";
import { MAIL_INLINE_IMAGE_MAX_BYTES } from "./content-types";
import { inspectMailRaster } from "./raster-metadata";

export const MAIL_MAX_DNS_GENERATION_AGE_MS = 5 * 60_000;
export const SMTP_EGRESS_RELAY_AUDIENCE = "brain-mail-smtp-egress-v1" as const;
export const SMTP_EGRESS_RELAY_CHALLENGE_TTL_MS = 5_000;

export const MAIL_RESOURCE_LIMITS = Object.freeze({
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
  egressTunnelServerBytes: 128 * 1024,
  egressTunnelSessionMs: 60_000,
  maxDnsAnswers: 16,
  maxFlagsPerMessage: 64,
  maxVanishedUidsPerPage: 2_000,
  maxMailboxesPerAccount: 256,
  maxActiveImapConnections: 5,
  maxIdleSessions: 3,
  maxQueuedSubmissions: 100,
  maxCacheBytes: 2 * 1024 * 1024 * 1024,
  maxCacheMessages: 100_000,
  maxTemporaryBytes: 128 * 1024 * 1024,
  maxWalBytes: 64 * 1024 * 1024,
  maxOpenFileDescriptors: 256,
  maxDecodedMimeBytes: 80 * 1024 * 1024,
  mimeParserDeadlineMs: 15_000,
  maxDomNodes: 50_000,
  maxDomAttributes: 200_000,
  maxRemoteImagesPerMessage: 32,
  maxRemoteImageUrlBytes: 2_048,
  maxRemoteImageManifestBytes: 64 * 1024,
  maxRemoteImageBytesPerMessage: 24 * 1024 * 1024,
  remoteImageFetchDeadlineMs: 8_000,
  remoteImageMaxRedirects: 3,
  remoteImageTransientRetryMs: 5 * 60_000,
  privacyPrefetchMaxMessagesPerAccount: 3,
  privacyPrefetchMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  privacyPrefetchMaxFutureSkewMs: 5 * 60 * 1_000,
  maxInlineImagePixels: 12_000_000,
  maxInlineImageFrames: 100,
  idleRestartMs: 25 * 60_000,
  workerLeaseMs: 5 * 60_000,
});

export const MAIL_PROCESS_LIMITS = Object.freeze({
  memoryHighBytes: 192 * 1024 * 1024,
  memoryMaxBytes: 256 * 1024 * 1024,
  cpuQuotaPercent: 35,
  tasksMax: 32,
  openFilesMax: MAIL_RESOURCE_LIMITS.maxOpenFileDescriptors,
});

export const MAIL_PARSER_PROCESS_LIMITS = Object.freeze({
  memoryHighBytes: 128 * 1024 * 1024,
  memoryMaxBytes: 192 * 1024 * 1024,
  cpuQuotaPercent: 20,
  tasksMax: 8,
  openFilesMax: 64,
});

export const MAIL_HTML_POLICY = Object.freeze({
  sandbox: "allow-same-origin",
  contentSecurityPolicy:
    "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  forbiddenTags: Object.freeze([
    "script",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "textarea",
    "select",
    "option",
    "base",
    "meta",
    "link",
    "style",
    "svg",
    "math",
  ]),
  forbiddenAttributes: Object.freeze([
    "srcset",
    "ping",
    "action",
    "formaction",
    "poster",
    "background",
  ]),
  forbiddenAttributePrefixes: Object.freeze(["on"]),
  classifiedResourceAttributes: Object.freeze(["href", "src"]),
});

export interface MimeShape {
  readonly headerBytes: number;
  readonly htmlCharacters: number;
  readonly textCharacters: number;
  readonly partCount: number;
  readonly nestingDepth: number;
  readonly addressCount: number;
}

export function admitRawMessage(bytes: number): void {
  assertWholeNumber(bytes, "raw message size", 1);
  if (bytes > MAIL_RESOURCE_LIMITS.rawMessageBytes) {
    throw new Error("raw message exceeds the configured byte limit");
  }
}

export function admitOutgoingRawMessage(bytes: number): void {
  assertWholeNumber(bytes, "outgoing raw message size", 1);
  if (bytes > MAIL_RESOURCE_LIMITS.outgoingRawMessageBytes) {
    throw new Error("outgoing raw message exceeds the configured byte limit");
  }
}

export function admitMimeShape(shape: MimeShape): void {
  assertWholeNumber(shape.headerBytes, "mail headers", 0);
  assertWholeNumber(shape.htmlCharacters, "HTML characters", 0);
  assertWholeNumber(shape.textCharacters, "text characters", 0);
  assertWholeNumber(shape.partCount, "MIME part count", 1);
  assertWholeNumber(shape.nestingDepth, "MIME nesting depth", 1);
  assertWholeNumber(shape.addressCount, "address count", 0);

  if (shape.headerBytes > MAIL_RESOURCE_LIMITS.headerBytes) {
    throw new Error("mail headers exceed the configured byte limit");
  }
  if (shape.htmlCharacters > MAIL_RESOURCE_LIMITS.htmlCharacters) {
    throw new Error("mail HTML exceeds the configured character limit");
  }
  if (shape.textCharacters > MAIL_RESOURCE_LIMITS.textCharacters) {
    throw new Error("mail text exceeds the configured character limit");
  }
  if (shape.partCount > MAIL_RESOURCE_LIMITS.mimeParts) {
    throw new Error("MIME part count exceeds the configured limit");
  }
  if (shape.nestingDepth > MAIL_RESOURCE_LIMITS.mimeNestingDepth) {
    throw new Error("MIME nesting depth exceeds the configured limit");
  }
  if (shape.addressCount > MAIL_RESOURCE_LIMITS.addressesPerMessage) {
    throw new Error("mail address count exceeds the configured limit");
  }
}

export interface MailMimeProgress {
  readonly rawBytes: number;
  readonly decodedBytes: number;
  readonly headerBytes: number;
  readonly htmlCharacters: number;
  readonly textCharacters: number;
  readonly addressCount: number;
  readonly partCount: number;
  readonly nestingDepth: number;
  readonly domNodes: number;
  readonly domAttributes: number;
  /** Cumulative decoded raster pixels across every frame and inline part. */
  readonly inlineImageDecodedPixels: number;
  readonly inlineImageFrames: number;
}

/** Called before retaining each decoded chunk, MIME part, or DOM node. */
export function admitMimeProgress(progress: MailMimeProgress): void {
  for (const [label, value] of Object.entries(progress)) {
    assertWholeNumber(value, label, 0);
  }
  if (progress.rawBytes > MAIL_RESOURCE_LIMITS.rawMessageBytes) {
    throw new Error("mail MIME progress exceeds the raw byte limit");
  }
  if (progress.decodedBytes > MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes) {
    throw new Error("mail MIME progress exceeds the decoded byte limit");
  }
  if (progress.headerBytes > MAIL_RESOURCE_LIMITS.headerBytes) {
    throw new Error("mail MIME progress exceeds the header byte limit");
  }
  if (progress.htmlCharacters > MAIL_RESOURCE_LIMITS.htmlCharacters) {
    throw new Error("mail MIME progress exceeds the HTML character limit");
  }
  if (progress.textCharacters > MAIL_RESOURCE_LIMITS.textCharacters) {
    throw new Error("mail MIME progress exceeds the text character limit");
  }
  if (progress.addressCount > MAIL_RESOURCE_LIMITS.addressesPerMessage) {
    throw new Error("mail MIME progress exceeds the address limit");
  }
  if (progress.partCount > MAIL_RESOURCE_LIMITS.mimeParts) {
    throw new Error("mail MIME progress exceeds the part limit");
  }
  if (progress.nestingDepth > MAIL_RESOURCE_LIMITS.mimeNestingDepth) {
    throw new Error("mail MIME progress exceeds the nesting limit");
  }
  if (progress.domNodes > MAIL_RESOURCE_LIMITS.maxDomNodes) {
    throw new Error("mail MIME progress exceeds the DOM node limit");
  }
  if (progress.domAttributes > MAIL_RESOURCE_LIMITS.maxDomAttributes) {
    throw new Error("mail MIME progress exceeds the DOM attribute limit");
  }
  if (progress.inlineImageDecodedPixels > MAIL_RESOURCE_LIMITS.maxInlineImagePixels) {
    throw new Error("mail MIME progress exceeds the decoded inline image pixel limit");
  }
  if (progress.inlineImageFrames > MAIL_RESOURCE_LIMITS.maxInlineImageFrames) {
    throw new Error("mail MIME progress exceeds the inline image frame limit");
  }
}

export function validateMimeParseBudget(
  budget: MailMimeParseBudget,
  now: number,
): MailMimeParseBudget {
  assertWholeNumber(now, "mail parser current time", 0);
  assertWholeNumber(budget.deadlineAt, "mail parser deadline", now + 1);
  if (budget.deadlineAt > now + MAIL_RESOURCE_LIMITS.mimeParserDeadlineMs) {
    throw new Error("mail parser deadline exceeds the service limit");
  }
  const bounded: Array<[number, number, string]> = [
    [budget.maxRawBytes, MAIL_RESOURCE_LIMITS.rawMessageBytes, "raw bytes"],
    [budget.maxDecodedBytes, MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes, "decoded bytes"],
    [budget.maxHeaderBytes, MAIL_RESOURCE_LIMITS.headerBytes, "header bytes"],
    [
      budget.maxHtmlCharacters,
      MAIL_RESOURCE_LIMITS.htmlCharacters,
      "HTML characters",
    ],
    [
      budget.maxTextCharacters,
      MAIL_RESOURCE_LIMITS.textCharacters,
      "text characters",
    ],
    [budget.maxAddresses, MAIL_RESOURCE_LIMITS.addressesPerMessage, "addresses"],
    [budget.maxParts, MAIL_RESOURCE_LIMITS.mimeParts, "parts"],
    [budget.maxDepth, MAIL_RESOURCE_LIMITS.mimeNestingDepth, "depth"],
    [budget.maxDomNodes, MAIL_RESOURCE_LIMITS.maxDomNodes, "DOM nodes"],
    [budget.maxDomAttributes, MAIL_RESOURCE_LIMITS.maxDomAttributes, "DOM attributes"],
    [
      budget.maxRemoteImages,
      MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
      "remote images",
    ],
    [
      budget.maxInlineImagePixels,
      MAIL_RESOURCE_LIMITS.maxInlineImagePixels,
      "inline image pixels",
    ],
    [
      budget.maxInlineImageFrames,
      MAIL_RESOURCE_LIMITS.maxInlineImageFrames,
      "inline image frames",
    ],
  ];
  for (const [value, maximum, label] of bounded) {
    assertWholeNumber(value, `mail parser ${label}`, 1);
    if (value > maximum) throw new Error(`mail parser ${label} exceeds the service limit`);
  }
  return Object.freeze({
    deadlineAt: budget.deadlineAt,
    maxRawBytes: budget.maxRawBytes,
    maxDecodedBytes: budget.maxDecodedBytes,
    maxHeaderBytes: budget.maxHeaderBytes,
    maxHtmlCharacters: budget.maxHtmlCharacters,
    maxTextCharacters: budget.maxTextCharacters,
    maxAddresses: budget.maxAddresses,
    maxParts: budget.maxParts,
    maxDepth: budget.maxDepth,
    maxDomNodes: budget.maxDomNodes,
    maxDomAttributes: budget.maxDomAttributes,
    maxRemoteImages: budget.maxRemoteImages,
    maxInlineImagePixels: budget.maxInlineImagePixels,
    maxInlineImageFrames: budget.maxInlineImageFrames,
  });
}

export function validateMailBlobDescriptor(
  descriptor: MailBlobDescriptor,
): MailBlobDescriptor {
  if (!isPlainRecord(descriptor) || !/^[a-f0-9]{64}$/i.test(descriptor.sha256)) {
    throw new Error("mail blob descriptor digest is invalid");
  }
  assertWholeNumber(descriptor.bytes, "mail blob descriptor bytes", 0);
  if (descriptor.bytes > MAIL_RESOURCE_LIMITS.rawMessageBytes) {
    throw new Error("mail blob descriptor exceeds the raw message limit");
  }
  return Object.freeze({
    sha256: descriptor.sha256.toLowerCase(),
    bytes: descriptor.bytes,
  });
}

/** Exact projection used immediately before crossing into the parser process. */
export function validateMailMimeParseRequest(
  request: Pick<MailMimeParseRequest, "operationId" | "rawMime" | "budget">,
  now: number,
): MailMimeWorkerRequest {
  if (!isPlainRecord(request)) throw new Error("mail parser request is invalid");
  assertSafeIdentifier(request.operationId, "mail parser operation id");
  const rawMime = validateMailBlobDescriptor(request.rawMime);
  admitRawMessage(rawMime.bytes);
  return Object.freeze({
    operationId: request.operationId,
    rawMime,
    budget: validateMimeParseBudget(request.budget, now),
  });
}

/** Exact bounded projection used immediately after parser-worker IPC. */
export function validateParsedMailArtifactSet(
  value: ParsedMailArtifactSet,
): ParsedMailArtifactSet {
  if (
    !isPlainRecord(value) ||
    !Array.isArray(value.attachments) ||
    !Array.isArray(value.remoteImages)
  ) {
    throw new Error("parsed mail artifact set is invalid");
  }
  if (value.attachments.length > MAIL_RESOURCE_LIMITS.mimeParts) {
    throw new Error("parsed mail artifact set exceeds the attachment count limit");
  }
  const text = value.text === null ? null : validateStagedMailBlob(value.text, false);
  const sanitizedHtml =
    value.sanitizedHtml === null
      ? null
      : validateStagedMailBlob(value.sanitizedHtml, false);
  const remoteImages = validateParsedRemoteImages(
    value.remoteImages,
    sanitizedHtml,
  );
  let inlinePixels = BigInt(0);
  let inlineFrames = 0;
  const attachments = value.attachments.map((candidate) => {
    const attachment = validateParsedMailAttachment(candidate);
    if (
      attachment.contentId === null ||
      attachment.disposition !== "inline" ||
      attachment.blob.descriptor.bytes > MAIL_INLINE_IMAGE_MAX_BYTES
    ) {
      return Object.freeze({ ...attachment, contentId: null });
    }
    const verifiedRaster = inspectMailRaster(
      attachment.mimeType,
      attachment.blob.data,
    );
    const safe = isInlineSafeAttachment({
      mimeType: attachment.mimeType,
      disposition: attachment.disposition,
      contentId: attachment.contentId,
      verifiedRaster,
    });
    if (!safe || verifiedRaster === null) {
      return Object.freeze({ ...attachment, contentId: null });
    }
    const decodedPixels =
      BigInt(verifiedRaster.width) *
      BigInt(verifiedRaster.height) *
      BigInt(verifiedRaster.frames);
    if (
      inlinePixels + decodedPixels >
        BigInt(MAIL_RESOURCE_LIMITS.maxInlineImagePixels) ||
      inlineFrames + verifiedRaster.frames >
        MAIL_RESOURCE_LIMITS.maxInlineImageFrames
    ) {
      return Object.freeze({ ...attachment, contentId: null });
    }
    inlinePixels += decodedPixels;
    inlineFrames += verifiedRaster.frames;
    return attachment;
  });
  const totalBytes = [text, sanitizedHtml, ...attachments].reduce(
    (total, artifact) =>
      total +
      BigInt(
        artifact === null
          ? 0
          : "blob" in artifact
            ? artifact.blob.descriptor.bytes
            : artifact.descriptor.bytes,
      ),
    BigInt(0),
  ) + BigInt(remoteImageManifestBytes(remoteImages));
  if (totalBytes > BigInt(MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes)) {
    throw new Error("parsed mail artifacts exceed the aggregate decoded byte limit");
  }
  return Object.freeze({
    text,
    sanitizedHtml,
    attachments: Object.freeze(attachments),
    remoteImages,
  });
}

const SAFE_REMOTE_IMAGE_ID = /^remote-image-a[0-9a-f]{32}$/;

function validateParsedRemoteImages(
  value: readonly unknown[],
  sanitizedHtml: ParsedMailStagedBlob | null,
): ParsedMailArtifactSet["remoteImages"] {
  if (value.length > MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage) {
    throw new Error("parsed mail artifact set exceeds the remote image limit");
  }
  const ids = new Set<string>();
  const sources = new Set<string>();
  const remoteImages = value.map((candidate) => {
    if (
      !isPlainRecord(candidate) ||
      Object.keys(candidate).sort().join(",") !== "remoteImageId,sourceUrl" ||
      typeof candidate.remoteImageId !== "string" ||
      !SAFE_REMOTE_IMAGE_ID.test(candidate.remoteImageId)
    ) {
      throw new Error("parsed mail remote image is invalid");
    }
    const sourceUrl = validateMailRemoteImageSourceUrl(candidate.sourceUrl);
    if (ids.has(candidate.remoteImageId) || sources.has(sourceUrl)) {
      throw new Error("parsed mail remote image is repeated");
    }
    ids.add(candidate.remoteImageId);
    sources.add(sourceUrl);
    return Object.freeze({
      remoteImageId: candidate.remoteImageId,
      sourceUrl,
    });
  });
  if (remoteImageManifestBytes(remoteImages) > MAIL_RESOURCE_LIMITS.maxRemoteImageManifestBytes) {
    throw new Error("parsed mail remote image manifest exceeds the byte limit");
  }
  if (remoteImages.length === 0) return Object.freeze(remoteImages);
  if (sanitizedHtml === null) {
    throw new Error("parsed mail remote images require sanitized HTML");
  }
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(sanitizedHtml.data);
  } catch {
    throw new Error("parsed mail sanitized HTML is invalid UTF-8");
  }
  const references = [
    ...html.matchAll(/<img data-brain-remote-image="(remote-image-a[0-9a-f]{32})"/g),
  ].map((match) => match[1]!);
  if (
    references.length === 0 ||
    references.some((remoteImageId) => !ids.has(remoteImageId)) ||
    remoteImages.some(
      (remoteImage) =>
        !references.includes(remoteImage.remoteImageId) ||
        html.includes(remoteImage.sourceUrl),
    )
  ) {
    throw new Error("parsed mail remote image manifest does not match sanitized HTML");
  }
  return Object.freeze(remoteImages);
}

function remoteImageManifestBytes(
  remoteImages: readonly { readonly remoteImageId: string; readonly sourceUrl: string }[],
): number {
  return remoteImages.reduce(
    (total, image) =>
      total + Buffer.byteLength(image.remoteImageId) + Buffer.byteLength(image.sourceUrl),
    0,
  );
}

export function validateMailRemoteImageSourceUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAIL_RESOURCE_LIMITS.maxRemoteImageUrlBytes ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new Error("mail remote image URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("mail remote image URL is invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== "" ||
    parsed.port !== "" ||
    parsed.toString() !== value ||
    isIP(hostname) !== 0 ||
    !isValidRemoteImageHostname(hostname)
  ) {
    throw new Error("mail remote image URL is invalid");
  }
  return value;
}

function isValidRemoteImageHostname(hostname: string): boolean {
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    hostname.endsWith(".") ||
    hostname === "localhost" ||
    /\.(?:localhost|local|internal|home\.arpa)$/.test(hostname)
  ) {
    return false;
  }
  const labels = hostname.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        /^(?:xn--)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  );
}

function validateStagedMailBlob(
  value: ParsedMailStagedBlob,
  allowEmpty: boolean,
): ParsedMailStagedBlob {
  if (!isPlainRecord(value) || !(value.data instanceof Uint8Array)) {
    throw new Error("parsed mail staged blob is invalid");
  }
  const descriptor = validateMailBlobDescriptor(value.descriptor);
  if (!allowEmpty && descriptor.bytes === 0) {
    throw new Error("parsed mail text artifacts must not be empty");
  }
  if (
    descriptor.bytes !== value.data.byteLength ||
    createHash("sha256").update(value.data).digest("hex") !== descriptor.sha256
  ) {
    throw new Error("parsed mail staged blob integrity check failed");
  }
  return Object.freeze({ descriptor, data: value.data });
}

function validateParsedMailAttachment(value: ParsedMailAttachment): ParsedMailAttachment {
  if (!isPlainRecord(value)) throw new Error("parsed mail attachment is invalid");
  const filename = validateOptionalMailMetadata(value.filename, "filename", 512);
  const contentId = validateOptionalMailMetadata(value.contentId, "content id", 512);
  if (
    typeof value.mimeType !== "string" ||
    value.mimeType.length > 127 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value.mimeType)
  ) {
    throw new Error("parsed mail attachment MIME type is invalid");
  }
  if (value.disposition !== "attachment" && value.disposition !== "inline") {
    throw new Error("parsed mail attachment disposition is invalid");
  }
  return Object.freeze({
    filename,
    mimeType: value.mimeType.toLowerCase(),
    disposition: value.disposition,
    contentId,
    blob: validateStagedMailBlob(value.blob, true),
  });
}

function validateOptionalMailMetadata(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`parsed mail attachment ${label} is invalid`);
  }
  return value;
}

const MAIL_SYSTEM_USAGE_LIMITS: Readonly<Record<keyof MailSystemUsage, number>> =
  Object.freeze({
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
  });

export function admitMailSystemUsage(usage: MailSystemUsage): void {
  if (!isPlainRecord(usage)) throw new Error("mail system usage is invalid");
  for (const [field, maximum] of Object.entries(MAIL_SYSTEM_USAGE_LIMITS) as Array<
    [keyof MailSystemUsage, number]
  >) {
    const value = usage[field];
    assertWholeNumber(value, `mail system ${field}`, 0);
    if (value > maximum) throw new Error(`mail system ${field} exceeds the configured quota`);
  }
}

/** Exact fail-closed projection for one atomic aggregate-capacity reservation. */
export function validateMailSystemReservationDelta(
  delta: Partial<MailSystemUsage>,
): Readonly<Partial<MailSystemUsage>> {
  if (!isPlainRecord(delta)) throw new Error("mail system reservation delta is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(delta);
  const allowed = new Set(Object.keys(MAIL_SYSTEM_USAGE_LIMITS));
  for (const field of Object.keys(descriptors)) {
    if (!allowed.has(field)) throw new Error("mail system reservation contains an unknown field");
  }

  const projected: Partial<Record<keyof MailSystemUsage, number>> = {};
  for (const [field, maximum] of Object.entries(MAIL_SYSTEM_USAGE_LIMITS) as Array<
    [keyof MailSystemUsage, number]
  >) {
    const descriptor = descriptors[field];
    if (!descriptor) continue;
    const value = dataPropertyValue(descriptor);
    assertWholeNumber(value as number, `mail system reservation ${field}`, 0);
    if ((value as number) > maximum) {
      throw new Error(`mail system reservation ${field} exceeds the configured quota`);
    }
    projected[field] = value as number;
  }
  return Object.freeze(projected);
}

export function validateImapSyncPage(page: ImapSyncPage): ImapSyncPage {
  const uidValidity = validateUnsigned32String(page.uidValidity, "IMAP page UIDVALIDITY");
  assertUnsigned32(page.highestUid, true, "IMAP page highest UID");
  const highestModSeq = validateUnsigned63String(
    page.highestModSeq,
    "IMAP page HIGHESTMODSEQ",
  );
  if (!Array.isArray(page.messages) || page.messages.length > MAIL_RESOURCE_LIMITS.syncBatchMessages) {
    throw new Error("IMAP page exceeds the configured message count");
  }
  if (
    !Array.isArray(page.vanishedUids) ||
    page.vanishedUids.length > MAIL_RESOURCE_LIMITS.maxVanishedUidsPerPage
  ) {
    throw new Error("IMAP page exceeds the configured vanished UID count");
  }
  const vanished = new Set<number>();
  for (const uid of page.vanishedUids) {
    assertUnsigned32(uid, false, "vanished IMAP UID");
    if (vanished.has(uid)) throw new Error("IMAP page repeats a vanished UID");
    vanished.add(uid);
  }
  const messageUids = new Set<number>();
  const messages = page.messages.map((message) => {
    assertUnsigned32(message.uid, false, "IMAP message UID");
    if (message.uid > page.highestUid) throw new Error("IMAP message UID exceeds page cursor");
    if (messageUids.has(message.uid) || vanished.has(message.uid)) {
      throw new Error("IMAP page repeats or vanishes a returned message UID");
    }
    messageUids.add(message.uid);
    const modSeq = validateUnsigned63String(message.modSeq, "IMAP message MODSEQ");
    if (
      (highestModSeq === null && modSeq !== null) ||
      (highestModSeq !== null && modSeq !== null && BigInt(modSeq) > BigInt(highestModSeq))
    ) {
      throw new Error("IMAP message MODSEQ exceeds or lacks its page cursor");
    }
    if (!Array.isArray(message.flags) || message.flags.length > MAIL_RESOURCE_LIMITS.maxFlagsPerMessage) {
      throw new Error("IMAP message exceeds the configured flag count");
    }
    const flags = message.flags.map((flag: unknown) => {
      if (
        typeof flag !== "string" ||
        flag.length < 1 ||
        flag.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(flag)
      ) {
        throw new Error("IMAP message flag is invalid");
      }
      return flag;
    });
    if (message.rfc822Size !== null) {
      assertWholeNumber(message.rfc822Size, "IMAP RFC822.SIZE", 0);
    }
    return Object.freeze({
      uid: message.uid,
      modSeq,
      flags: Object.freeze(flags),
      rfc822Size: message.rfc822Size,
    });
  });
  return Object.freeze({
    uidValidity,
    highestModSeq,
    highestUid: page.highestUid,
    vanishedUids: Object.freeze([...page.vanishedUids]),
    messages: Object.freeze(messages),
  });
}

export function validateMailEndpoint(
  protocol: MailProtocol,
  endpoint: MailEndpoint,
): MailEndpoint {
  if (protocol !== "imap" && protocol !== "smtp") {
    throw new Error("mail endpoint protocol is unsupported");
  }
  const hostname = normalizeHostname(endpoint.hostname);
  if (isIP(hostname) !== 0) {
    throw new Error("mail endpoint hostname must be a DNS name, not an IP literal");
  }
  if (!isValidDnsHostname(hostname)) {
    throw new Error("mail endpoint hostname is invalid");
  }

  assertWholeNumber(endpoint.port, "mail endpoint port", 1);
  if (endpoint.port > 65_535) {
    throw new Error("mail endpoint port is invalid");
  }

  const expectedTls = expectedTlsForPort(protocol, endpoint.port);
  if (endpoint.tls !== expectedTls) {
    throw new Error(`mail endpoint TLS mode must be ${expectedTls} on port ${endpoint.port}`);
  }

  return Object.freeze({ hostname, port: endpoint.port, tls: endpoint.tls });
}

export function validateResolvedMailTargets(
  protocol: MailProtocol,
  endpoint: MailEndpoint,
  input: {
    readonly resolutionId: string;
    readonly resolvedAt: number;
    readonly expiresAt: number;
    readonly addresses: readonly { readonly address: string; readonly family: 4 | 6 }[];
  },
  now: number,
): readonly ValidatedMailDialTarget[] {
  const validatedEndpoint = validateMailEndpoint(protocol, endpoint);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.resolutionId)) {
    throw new Error("mail DNS resolution id is invalid");
  }
  assertWholeNumber(input.resolvedAt, "mail DNS resolution time", 0);
  assertWholeNumber(now, "mail DNS validation time", input.resolvedAt);
  assertWholeNumber(input.expiresAt, "mail DNS resolution expiry", now + 1);
  if (input.expiresAt > input.resolvedAt + MAIL_MAX_DNS_GENERATION_AGE_MS) {
    throw new Error("mail DNS resolution expiry exceeds the freshness limit");
  }
  if (
    !Array.isArray(input.addresses) ||
    input.addresses.length === 0 ||
    input.addresses.length > MAIL_RESOURCE_LIMITS.maxDnsAnswers
  ) {
    throw new Error("mail DNS resolution answer count is invalid");
  }
  const unique = new Set<string>();
  const targets = input.addresses.map(({ address, family }) => {
    if ((family !== 4 && family !== 6) || isIP(address) !== family) {
      throw new Error("mail DNS answer family is invalid");
    }
    const canonicalAddress = canonicalizeResolvedAddress(address, family);
    if (!canonicalAddress || isForbiddenResolvedAddress(canonicalAddress)) {
      throw new Error("mail DNS answer contains a forbidden address");
    }
    const key = `${family}:${canonicalAddress}`;
    if (unique.has(key)) throw new Error("mail DNS resolution repeats an address");
    unique.add(key);
    return Object.freeze({
      ...validatedEndpoint,
      protocol,
      address: canonicalAddress,
      family,
      resolutionId: input.resolutionId,
      resolvedAt: input.resolvedAt,
      expiresAt: input.expiresAt,
    });
  });
  return Object.freeze(targets);
}

const MAIL_PROTOCOL_SESSION_OPEN_FIELDS = Object.freeze([
  "accountId",
  "target",
  "bindingRef",
  "deadlineAt",
] as const satisfies readonly (keyof MailProtocolSessionOpenRequest)[]);
const MAIL_DIAL_TARGET_FIELDS = Object.freeze([
  "protocol",
  "hostname",
  "port",
  "tls",
  "address",
  "family",
  "resolutionId",
  "resolvedAt",
  "expiresAt",
] as const satisfies readonly (keyof ValidatedMailDialTarget)[]);
const MAIL_TRANSPORT_BINDING_REF_FIELDS = Object.freeze(["id", "version"] as const);

/** Validates the complete adapter-open boundary before binding or secret access. */
export function validateMailProtocolSessionOpenRequest(
  expectedProtocol: MailProtocol,
  request: MailProtocolSessionOpenRequest,
  now: number,
): MailProtocolSessionOpenRequest {
  assertExactDataProperties(
    request,
    MAIL_PROTOCOL_SESSION_OPEN_FIELDS,
    "mail protocol session open request",
  );
  assertSafeIdentifier(request.accountId, "mail protocol session account id");
  const target = validateMailDialTarget(request.target);
  assertWholeNumber(now, "mail protocol session current time", target.resolvedAt);
  if (now >= target.expiresAt) {
    throw new Error("mail protocol session target has expired");
  }
  if (target.protocol !== expectedProtocol) {
    throw new Error("mail protocol session target protocol is invalid");
  }
  assertExactDataProperties(
    request.bindingRef,
    MAIL_TRANSPORT_BINDING_REF_FIELDS,
    "mail transport binding reference",
  );
  assertSafeIdentifier(request.bindingRef.id, "mail transport binding id");
  assertWholeNumber(request.bindingRef.version, "mail transport binding version", 1);
  assertWholeNumber(
    request.deadlineAt,
    "mail protocol session deadline",
    now + 1,
  );
  if (request.deadlineAt > target.expiresAt) {
    throw new Error("mail protocol session deadline exceeds target expiry");
  }
  return Object.freeze({
    accountId: request.accountId,
    target,
    bindingRef: Object.freeze({
      id: request.bindingRef.id,
      version: request.bindingRef.version,
    }),
    deadlineAt: request.deadlineAt,
  });
}

export function validateMailTlsProof(
  target: ValidatedMailDialTarget,
  proof: MailTlsProof,
  now: number,
): MailTlsProof {
  const validatedTarget = validateMailDialTarget(target);
  const targetAddress = validatedTarget.address;
  const proofAddress = canonicalizeResolvedAddress(proof.address, proof.family);
  if (
    proof.protocol !== validatedTarget.protocol ||
    proof.resolutionId !== validatedTarget.resolutionId ||
    proof.hostname !== validatedTarget.hostname ||
    proofAddress !== targetAddress ||
    proof.family !== validatedTarget.family ||
    proof.tls !== validatedTarget.tls ||
    proof.certificateVerified !== true ||
    (validatedTarget.tls === "starttls" && proof.startTlsVerified !== true) ||
    (validatedTarget.tls === "implicit" && proof.startTlsVerified !== false)
  ) {
    throw new Error("mail TLS proof does not match its pinned dial target");
  }
  assertWholeNumber(
    proof.establishedAt,
    "mail TLS establishment time",
    validatedTarget.resolvedAt,
  );
  assertWholeNumber(now, "mail TLS proof current time", proof.establishedAt);
  if (proof.establishedAt >= validatedTarget.expiresAt) {
    throw new Error("mail TLS proof was established after target expiry");
  }
  return Object.freeze({
    protocol: proof.protocol,
    resolutionId: proof.resolutionId,
    hostname: proof.hostname,
    address: targetAddress,
    family: proof.family,
    tls: proof.tls,
    certificateVerified: true,
    startTlsVerified: proof.startTlsVerified,
    establishedAt: proof.establishedAt,
  });
}

const SMTP_EGRESS_TUNNEL_OPEN_FIELDS = Object.freeze([
  "transport",
  "sessionId",
  "attemptId",
  "target",
  "deadlineAt",
] as const satisfies readonly (keyof SmtpEgressTunnelOpenRequest)[]);
const SMTP_EGRESS_RELAY_CHALLENGE_FIELDS = Object.freeze([
  "version",
  "audience",
  "challenge",
  "issuedAt",
  "expiresAt",
] as const satisfies readonly (keyof SmtpEgressRelayChallenge)[]);
const SMTP_EGRESS_RELAY_AUTHORIZATION_PAYLOAD_FIELDS = Object.freeze([
  ...SMTP_EGRESS_RELAY_CHALLENGE_FIELDS,
  "transport",
  "sessionId",
  "attemptId",
  "resolutionId",
  "address",
  "family",
  "port",
  "targetExpiresAt",
  "deadlineAt",
] as const satisfies readonly (keyof SmtpEgressRelayAuthorizationPayload)[]);
const SMTP_EGRESS_RELAY_AUTHORIZATION_FIELDS = Object.freeze([
  ...SMTP_EGRESS_RELAY_AUTHORIZATION_PAYLOAD_FIELDS,
  "hmacSha256",
] as const satisfies readonly (keyof SmtpEgressRelayAuthorization)[]);
const SMTP_EGRESS_TUNNEL_PROOF_FIELDS = Object.freeze([
  "transport",
  "sessionId",
  "attemptId",
  "resolutionId",
  "address",
  "family",
  "port",
  "remoteAddress",
  "connectedAt",
] as const satisfies readonly (keyof SmtpEgressTunnelProof)[]);

/** Validates the fresh, connection-local challenge emitted by the relay. */
export function validateSmtpEgressRelayChallenge(
  challenge: SmtpEgressRelayChallenge,
  now: number,
): SmtpEgressRelayChallenge {
  const projected = projectSmtpEgressRelayChallenge(challenge);
  assertWholeNumber(now, "SMTP egress relay challenge current time", projected.issuedAt);
  if (now >= projected.expiresAt) {
    throw new Error("SMTP egress relay challenge is expired");
  }
  return projected;
}

function projectSmtpEgressRelayChallenge(
  challenge: SmtpEgressRelayChallenge,
): SmtpEgressRelayChallenge {
  assertExactDataProperties(
    challenge,
    SMTP_EGRESS_RELAY_CHALLENGE_FIELDS,
    "SMTP egress relay challenge",
  );
  if (challenge.version !== 1 || challenge.audience !== SMTP_EGRESS_RELAY_AUDIENCE) {
    throw new Error("SMTP egress relay challenge version or audience is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(challenge.challenge)) {
    throw new Error("SMTP egress relay challenge entropy is invalid");
  }
  assertWholeNumber(challenge.issuedAt, "SMTP egress relay challenge issue time", 0);
  assertWholeNumber(
    challenge.expiresAt,
    "SMTP egress relay challenge expiry",
    challenge.issuedAt + 1,
  );
  if (
    challenge.expiresAt > challenge.issuedAt + SMTP_EGRESS_RELAY_CHALLENGE_TTL_MS
  ) {
    throw new Error("SMTP egress relay challenge exceeds its lifetime");
  }
  return Object.freeze({
    version: 1,
    audience: SMTP_EGRESS_RELAY_AUDIENCE,
    challenge: challenge.challenge,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  });
}

/**
 * Builds the exact unsigned payload Brain signs for one already validated
 * tunnel request. The Worker does not need this local request to verify it.
 */
export function createSmtpEgressRelayAuthorizationPayload(
  request: SmtpEgressTunnelOpenRequest,
  challenge: SmtpEgressRelayChallenge,
  now: number,
): SmtpEgressRelayAuthorizationPayload {
  const validatedRequest = validateSmtpEgressTunnelOpenRequest(request, now);
  if (validatedRequest.transport !== "authenticated_byte_relay") {
    throw new Error("SMTP egress relay authorization requires relay transport");
  }
  // Brain only validates the server challenge shape here. Freshness is owned
  // by the Worker that issued and stores it, avoiding a cross-host clock gate.
  const validatedChallenge = projectSmtpEgressRelayChallenge(challenge);
  const { target } = validatedRequest;
  return Object.freeze({
    ...validatedChallenge,
    transport: "authenticated_byte_relay",
    sessionId: validatedRequest.sessionId,
    attemptId: validatedRequest.attemptId,
    resolutionId: target.resolutionId,
    address: target.address,
    family: target.family,
    port: target.port as 465 | 587,
    targetExpiresAt: target.expiresAt,
    deadlineAt: validatedRequest.deadlineAt,
  });
}

/**
 * Exact Worker boundary before constant-time HMAC verification and TCP open.
 * expectedChallenge comes from this WebSocket's trusted connection state.
 * This function validates and projects the envelope but does not verify HMAC.
 */
export function validateSmtpEgressRelayAuthorizationEnvelope(
  expectedChallenge: SmtpEgressRelayChallenge,
  authorization: SmtpEgressRelayAuthorization,
  now: number,
): SmtpEgressRelayAuthorization {
  const expected = validateSmtpEgressRelayChallenge(expectedChallenge, now);
  assertExactDataProperties(
    authorization,
    SMTP_EGRESS_RELAY_AUTHORIZATION_FIELDS,
    "SMTP egress relay authorization",
  );
  const payload = projectSmtpEgressRelayAuthorizationPayload({
    version: authorization.version,
    audience: authorization.audience,
    challenge: authorization.challenge,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    transport: authorization.transport,
    sessionId: authorization.sessionId,
    attemptId: authorization.attemptId,
    resolutionId: authorization.resolutionId,
    address: authorization.address,
    family: authorization.family,
    port: authorization.port,
    targetExpiresAt: authorization.targetExpiresAt,
    deadlineAt: authorization.deadlineAt,
  });
  if (
    payload.version !== expected.version ||
    payload.audience !== expected.audience ||
    payload.challenge !== expected.challenge ||
    payload.issuedAt !== expected.issuedAt ||
    payload.expiresAt !== expected.expiresAt
  ) {
    throw new Error("SMTP egress relay authorization does not match this connection challenge");
  }
  if (
    payload.targetExpiresAt <= now ||
    payload.targetExpiresAt > now + MAIL_MAX_DNS_GENERATION_AGE_MS ||
    payload.deadlineAt <= now ||
    payload.deadlineAt > payload.targetExpiresAt ||
    payload.deadlineAt > now + MAIL_RESOURCE_LIMITS.egressTunnelSessionMs
  ) {
    throw new Error("SMTP egress relay authorization target or deadline is stale");
  }
  if (!/^[a-f0-9]{64}$/.test(authorization.hmacSha256)) {
    throw new Error("SMTP egress relay authorization HMAC is invalid");
  }
  return Object.freeze({
    ...payload,
    hmacSha256: authorization.hmacSha256,
  });
}

/** Stable ASCII payload signed with HMAC-SHA256 by Brain and the relay. */
export function canonicalizeSmtpEgressRelayAuthorization(
  payload: SmtpEgressRelayAuthorizationPayload,
): string {
  const projected = projectSmtpEgressRelayAuthorizationPayload(payload);
  return [
    "brain-mail-smtp-egress-hmac-v1",
    projected.version,
    projected.audience,
    projected.transport,
    projected.challenge,
    projected.issuedAt,
    projected.expiresAt,
    projected.sessionId,
    projected.attemptId,
    projected.resolutionId,
    projected.address,
    projected.family,
    projected.port,
    projected.targetExpiresAt,
    projected.deadlineAt,
  ].join("\n");
}

function projectSmtpEgressRelayAuthorizationPayload(
  payload: SmtpEgressRelayAuthorizationPayload,
): SmtpEgressRelayAuthorizationPayload {
  assertExactDataProperties(
    payload,
    SMTP_EGRESS_RELAY_AUTHORIZATION_PAYLOAD_FIELDS,
    "SMTP egress relay authorization payload",
  );
  const challenge = projectSmtpEgressRelayChallenge({
    version: payload.version,
    audience: payload.audience,
    challenge: payload.challenge,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
  if (payload.transport !== "authenticated_byte_relay") {
    throw new Error("SMTP egress relay authorization transport is invalid");
  }
  assertSafeIdentifier(payload.sessionId, "SMTP egress relay session id");
  assertSafeIdentifier(payload.attemptId, "SMTP egress relay attempt id");
  assertSafeIdentifier(payload.resolutionId, "SMTP egress relay resolution id");
  const address = canonicalizeResolvedAddress(payload.address, payload.family);
  if (!address || address !== payload.address || isForbiddenResolvedAddress(address)) {
    throw new Error("SMTP egress relay target is not a canonical public address");
  }
  if (payload.port !== 465 && payload.port !== 587) {
    throw new Error("SMTP egress relay port is invalid");
  }
  assertWholeNumber(
    payload.targetExpiresAt,
    "SMTP egress relay target expiry",
    1,
  );
  assertWholeNumber(
    payload.deadlineAt,
    "SMTP egress relay deadline",
    1,
  );
  if (payload.deadlineAt > payload.targetExpiresAt) {
    throw new Error("SMTP egress relay deadline exceeds its limit");
  }
  return Object.freeze({
    ...challenge,
    transport: "authenticated_byte_relay",
    sessionId: payload.sessionId,
    attemptId: payload.attemptId,
    resolutionId: payload.resolutionId,
    address,
    family: payload.family,
    port: payload.port,
    targetExpiresAt: payload.targetExpiresAt,
    deadlineAt: payload.deadlineAt,
  });
}

/** Exact boundary before a direct socket or authenticated byte relay is opened. */
export function validateSmtpEgressTunnelOpenRequest(
  request: SmtpEgressTunnelOpenRequest,
  now: number,
): SmtpEgressTunnelOpenRequest {
  assertExactDataProperties(
    request,
    SMTP_EGRESS_TUNNEL_OPEN_FIELDS,
    "SMTP egress tunnel open request",
  );
  if (request.transport !== "direct" && request.transport !== "authenticated_byte_relay") {
    throw new Error("SMTP egress tunnel transport is invalid");
  }
  assertSafeIdentifier(request.sessionId, "SMTP egress tunnel session id");
  assertSafeIdentifier(request.attemptId, "SMTP egress tunnel attempt id");
  const target = validateMailDialTarget(request.target);
  if (target.protocol !== "smtp") {
    throw new Error("SMTP egress tunnel target protocol is invalid");
  }
  assertWholeNumber(now, "SMTP egress tunnel current time", target.resolvedAt);
  if (now >= target.expiresAt) {
    throw new Error("SMTP egress tunnel target has expired");
  }
  assertWholeNumber(request.deadlineAt, "SMTP egress tunnel deadline", now + 1);
  if (
    request.deadlineAt > target.expiresAt ||
    request.deadlineAt > now + MAIL_RESOURCE_LIMITS.egressTunnelSessionMs
  ) {
    throw new Error("SMTP egress tunnel deadline exceeds its limit");
  }
  return Object.freeze({
    transport: request.transport,
    sessionId: request.sessionId,
    attemptId: request.attemptId,
    target,
    deadlineAt: request.deadlineAt,
  });
}

/** Exact proof returned before Brain starts SMTP or TLS over the tunnel. */
export function validateSmtpEgressTunnelProof(
  request: SmtpEgressTunnelOpenRequest,
  proof: SmtpEgressTunnelProof,
  now: number,
): SmtpEgressTunnelProof {
  const validatedRequest = validateSmtpEgressTunnelOpenRequest(request, now);
  assertExactDataProperties(
    proof,
    SMTP_EGRESS_TUNNEL_PROOF_FIELDS,
    "SMTP egress tunnel proof",
  );
  if (proof.transport !== "direct" && proof.transport !== "authenticated_byte_relay") {
    throw new Error("SMTP egress tunnel transport is invalid");
  }
  const { target } = validatedRequest;
  const proofAddress = canonicalizeResolvedAddress(proof.address, proof.family);
  if (
    proof.transport !== validatedRequest.transport ||
    proof.sessionId !== validatedRequest.sessionId ||
    proof.attemptId !== validatedRequest.attemptId ||
    proof.resolutionId !== target.resolutionId ||
    proofAddress !== target.address ||
    proof.family !== target.family ||
    proof.port !== target.port
  ) {
    throw new Error("SMTP egress tunnel proof does not match its request");
  }
  if (proof.remoteAddress !== null) {
    const remoteAddress = canonicalizeResolvedAddress(proof.remoteAddress, target.family);
    if (remoteAddress !== target.address) {
      throw new Error("SMTP egress tunnel remote address does not match its target");
    }
  } else if (proof.transport === "direct") {
    throw new Error("direct SMTP egress tunnel must expose its remote address");
  }
  assertWholeNumber(
    proof.connectedAt,
    "SMTP egress tunnel connected time",
    proof.transport === "direct" ? target.resolvedAt : 0,
  );
  // Direct proof timestamps come from this process and share its clock. Relay
  // timestamps come from Cloudflare and are informational only; local request
  // validation and the local absolute timer own freshness on the Brain side.
  if (
    proof.transport === "direct" &&
    (proof.connectedAt > now ||
      proof.connectedAt >= target.expiresAt ||
      proof.connectedAt >= validatedRequest.deadlineAt)
  ) {
    throw new Error("SMTP egress tunnel proof time is invalid");
  }
  return Object.freeze({
    transport: proof.transport,
    sessionId: proof.sessionId,
    attemptId: proof.attemptId,
    resolutionId: proof.resolutionId,
    address: target.address,
    family: target.family,
    port: target.port as 465 | 587,
    remoteAddress: proof.remoteAddress === null ? null : target.address,
    connectedAt: proof.connectedAt,
  });
}

export function validateMailAccountRuntimeConfig(
  config: MailAccountRuntimeConfig,
): MailAccountRuntimeConfig {
  assertSafeIdentifier(config.accountId, "mail account id");
  assertMailboxIdentity(config.emailAddress, "mail account address");
  const imap = validateProtocolRuntimeConfig("imap", config.imap);
  const smtp = validateProtocolRuntimeConfig("smtp", config.smtp);
  return Object.freeze({
    accountId: config.accountId,
    emailAddress: config.emailAddress,
    imap,
    smtp,
  });
}

export function isForbiddenResolvedAddress(address: string): boolean {
  if (address.includes("%")) return true;

  const family = isIP(address);
  if (family === 4) return isForbiddenIpv4(address);
  if (family !== 6) return true;

  const bytes = parseIpv6(address);
  if (!bytes) return true;

  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Compatible) return true;

  const rfc6052WellKnownNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  const rfc8215LocalNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01;
  if (rfc6052WellKnownNat64 || rfc8215LocalNat64) return true;

  // Mail endpoints must resolve to ordinary globally routed unicast addresses.
  // Translation, transition, documentation, and other special-purpose ranges
  // are rejected even when an operating system would accept them as dialable.
  // Fail closed to the currently allocated global-unicast blocks instead of
  // treating the whole 2000::/3 reservation as publicly routable. In
  // particular, 3ffe::/16 (former 6bone), 3fff::/16, and unallocated space
  // such as 2d00::/8 must never become an SSRF target merely because an OS is
  // willing to route it.
  const allocatedGlobalUnicast = ALLOCATED_IPV6_GLOBAL_PREFIXES.some(
    ({ prefix, bits }) => ipv6PrefixMatches(bytes, prefix, bits),
  );
  const ietfSpecialPurpose =
    bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] & 0xfe) === 0;
  const documentation2001 =
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8;
  const documentation3fff =
    bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0;

  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const siteLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0;
  const multicast = bytes[0] === 0xff;
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  const teredo = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0;

  return (
    !allocatedGlobalUnicast ||
    ietfSpecialPurpose ||
    documentation2001 ||
    documentation3fff ||
    uniqueLocal ||
    linkLocal ||
    siteLocal ||
    multicast ||
    sixToFour ||
    teredo
  );
}

// Exact IANA IPv6 unicast allocations as of 2025-10-10. Unlisted space in
// 2000::/3 remains reserved and is therefore rejected. 2001::/23 is omitted
// intentionally: it is IANA special-purpose space and is blocked wholesale.
const ALLOCATED_IPV6_GLOBAL_PREFIXES: ReadonlyArray<{
  readonly prefix: readonly number[];
  readonly bits: number;
}> = Object.freeze([
  { prefix: [0x20, 0x01, 0x02, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x04, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x06, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x08, 0x00], bits: 22 },
  { prefix: [0x20, 0x01, 0x0c, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x0e, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x12, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x14, 0x00], bits: 22 },
  { prefix: [0x20, 0x01, 0x18, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x1a, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x1c, 0x00], bits: 22 },
  { prefix: [0x20, 0x01, 0x20, 0x00], bits: 19 },
  { prefix: [0x20, 0x01, 0x40, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x42, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x44, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x46, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x48, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x4a, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x4c, 0x00], bits: 23 },
  { prefix: [0x20, 0x01, 0x50, 0x00], bits: 20 },
  { prefix: [0x20, 0x01, 0x80, 0x00], bits: 19 },
  { prefix: [0x20, 0x01, 0xa0, 0x00], bits: 20 },
  { prefix: [0x20, 0x01, 0xb0, 0x00], bits: 20 },
  { prefix: [0x20, 0x03, 0x00, 0x00], bits: 18 },
  { prefix: [0x24, 0x00], bits: 12 },
  { prefix: [0x24, 0x10], bits: 12 },
  { prefix: [0x26, 0x00], bits: 12 },
  { prefix: [0x26, 0x10, 0x00, 0x00], bits: 23 },
  { prefix: [0x26, 0x20, 0x00, 0x00], bits: 23 },
  { prefix: [0x26, 0x30], bits: 12 },
  { prefix: [0x28, 0x00], bits: 12 },
  { prefix: [0x2a, 0x00], bits: 12 },
  { prefix: [0x2a, 0x10], bits: 12 },
  { prefix: [0x2c, 0x00], bits: 12 },
]);

function ipv6PrefixMatches(
  address: readonly number[],
  prefix: readonly number[],
  prefixBits: number,
): boolean {
  const fullBytes = Math.floor(prefixBits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }

  const remainingBits = prefixBits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[fullBytes]! & mask) === (prefix[fullBytes]! & mask);
}

export type EmailResourceClassification =
  | { readonly kind: "inline_cid"; readonly contentId: string }
  | { readonly kind: "blocked_remote" }
  | { readonly kind: "blocked" };

export function classifyEmailResource(value: string): EmailResourceClassification {
  const source = value.trim();
  if (/^(?:https?:)?\/\//i.test(source)) return { kind: "blocked_remote" };

  const cid = /^cid:([^<>\s\u0000-\u001f\u007f]+)$/i.exec(source);
  if (cid) return { kind: "inline_cid", contentId: cid[1] };

  return { kind: "blocked" };
}

export interface InlineAttachmentCandidate {
  readonly mimeType: string;
  readonly disposition: string | null;
  readonly contentId: string | null;
  readonly verifiedRaster: {
    readonly width: number;
    readonly height: number;
    readonly frames: number;
  } | null;
}

const INLINE_RASTER_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isInlineSafeAttachment(candidate: InlineAttachmentCandidate): boolean {
  if (candidate.disposition?.toLowerCase() !== "inline") return false;
  if (!INLINE_RASTER_TYPES.has(candidate.mimeType.toLowerCase())) return false;
  if (!candidate.contentId) return false;
  if (!/^[^<>\s\u0000-\u001f\u007f]+$/.test(candidate.contentId)) return false;
  const raster = candidate.verifiedRaster;
  if (
    !raster ||
    !Number.isSafeInteger(raster.width) ||
    raster.width < 1 ||
    !Number.isSafeInteger(raster.height) ||
    raster.height < 1 ||
    !Number.isSafeInteger(raster.frames) ||
    raster.frames < 1 ||
    raster.frames > MAIL_RESOURCE_LIMITS.maxInlineImageFrames
  ) {
    return false;
  }
  const decodedPixels = BigInt(raster.width) * BigInt(raster.height) * BigInt(raster.frames);
  return decodedPixels <= BigInt(MAIL_RESOURCE_LIMITS.maxInlineImagePixels);
}

const MAIL_LOG_IDENTIFIER_FIELDS = Object.freeze([
  "accountId",
  "mailboxId",
  "operationId",
] as const);
const MAIL_LOG_CODE_FIELDS = Object.freeze([
  "phase",
  "durationBucket",
  "errorCode",
] as const);
const MAIL_LOG_STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAIL_LOG_SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAIL_LOG_NUMERIC_FIELDS = Object.freeze([
  "accountCount",
  "mailboxCount",
  "messageCount",
  "attachmentCount",
  "recipientCount",
  "queuedSubmissionCount",
  "rawMimeBytes",
  "cacheBytes",
  "temporaryBytes",
  "walBytes",
] as const);

export type MailLogRecord = Readonly<Record<string, string | number>> & {
  readonly event: string;
};

/**
 * Projects a candidate event onto the complete mail logging allowlist.
 *
 * Only stable scalar identifiers/codes and the explicitly named non-negative
 * integer counters survive. Unknown fields and every nested value are discarded.
 * Invalid or accessor-backed event names reject the entire record.
 */
export function projectMailLogRecord(value: unknown): MailLogRecord | null {
  try {
    if (!isPlainRecord(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const event = dataPropertyValue(descriptors.event);
    if (!isStableMailLogCode(event)) return null;

    const projected: Record<string, string | number> = { event };
    for (const field of MAIL_LOG_IDENTIFIER_FIELDS) {
      const fieldValue = dataPropertyValue(descriptors[field]);
      if (typeof fieldValue === "string" && MAIL_LOG_SAFE_IDENTIFIER.test(fieldValue)) {
        projected[field] = fieldValue;
      }
    }
    for (const field of MAIL_LOG_CODE_FIELDS) {
      const fieldValue = dataPropertyValue(descriptors[field]);
      if (isStableMailLogCode(fieldValue)) projected[field] = fieldValue;
    }
    for (const field of MAIL_LOG_NUMERIC_FIELDS) {
      const fieldValue = dataPropertyValue(descriptors[field]);
      if (typeof fieldValue === "number" && Number.isSafeInteger(fieldValue) && fieldValue >= 0) {
        projected[field] = fieldValue;
      }
    }

    return Object.freeze(projected) as MailLogRecord;
  } catch {
    return null;
  }
}

/**
 * Writes one projected event to stderr, which is where the service unit and the
 * Brain app both hand their output to the journal.
 *
 * Every caller goes through the projection, so the allowlist in section 13 of
 * `docs/mail-architecture.md` is the only thing that can reach a log file.
 * A record the projection rejects is dropped rather than partially written.
 */
export function writeMailLogRecord(value: unknown): void {
  const projected = projectMailLogRecord(value);
  if (projected) process.stderr.write(`${JSON.stringify(projected)}\n`);
}

/**
 * Which service route a request was for, as an allowlisted `phase` code.
 *
 * A failure that names only its error code cannot be placed: `mail_sync_unavailable`
 * reads the same whether a thread list, a mutation or a background sync raised it.
 * The family comes from a fixed table of path shapes and the verb comes from the
 * method, so a route added later degrades to `unknown_route` rather than logging a
 * path — ids in a path are message data and never belong in a record.
 */
export function mailRequestPhase(method: string, pathname: string): string {
  const family = MAIL_REQUEST_PHASE_FAMILIES.find(([pattern]) =>
    pattern.test(pathname),
  );
  if (family === undefined) return "unknown_route";
  const verb = /^[A-Za-z]{1,16}$/.test(method) ? method.toLowerCase() : "other";
  return `${family[1]}_${verb}`;
}

/**
 * Path shape to phase family, in match order. The more specific pattern for a
 * prefix has to come first: `/v1/drafts/<id>/send` before `/v1/drafts/<id>`.
 */
const MAIL_REQUEST_PHASE_FAMILIES: readonly (readonly [RegExp, string])[] =
  Object.freeze([
    [/^\/v1\/health$/, "health"],
    [/^\/v1\/threads$/, "thread_list"],
    [/^\/v1\/threads\/[^/]+$/, "thread"],
    [/^\/v1\/search$/, "thread_search"],
    [/^\/v1\/mailboxes\/[^/]+\/threads$/, "mailbox_thread_list"],
    [/^\/v1\/mailboxes\/[^/]+\/threads\/[^/]+$/, "mailbox_thread"],
    [/^\/v1\/message-content\/[^/]+$/, "message_content"],
    [/^\/v1\/attachments\/[^/]+$/, "attachment"],
    [/^\/v1\/remote-images\/[^/]+$/, "remote_image"],
    [/^\/v1\/sync$/, "sync"],
    [/^\/v1\/drafts$/, "draft_list"],
    [/^\/v1\/drafts\/[^/]+\/send$/, "draft_send"],
    [/^\/v1\/drafts\/[^/]+$/, "draft"],
    [/^\/v1\/send$/, "send"],
    [/^\/v1\/send\/[^/]+$/, "send_operation"],
    [/^\/v2\/accounts$/, "account_list"],
    [/^\/v2\/accounts\/[^/]+$/, "account"],
    [/^\/v1\/account$/, "account_status"],
    [/^\/v1\/admission$/, "admission"],
    [/^\/v1\/admission\/reservations(?:\/[^/]+)?$/, "admission_reservation"],
    [/^\/v1\/oauth\/gmail\/[^/]+$/, "gmail_oauth"],
  ] as const);

const MAIL_SERVICE_HEALTH_FIELDS = Object.freeze([
  "apiVersion",
  "build",
  "status",
  "localSchemaVersion",
  "cacheSchemaVersion",
  "receiveReadiness",
  "sendReadiness",
  "activeAccounts",
  "queuedSubmissions",
  "lastSuccessfulSyncAgeMs",
  "cachePressure",
  "lastErrorCode",
] as const satisfies readonly (keyof MailServiceHealth)[]);
const MAIL_SERVICE_HEALTH_FIELD_SET = new Set<string>(MAIL_SERVICE_HEALTH_FIELDS);
const MAIL_SERVICE_BUILD_FIELDS = Object.freeze(["commit", "builtAt"] as const);

export function validateMailServiceHealth(health: MailServiceHealth): MailServiceHealth {
  if (!isPlainRecord(health)) throw new Error("mail service health is invalid");
  const descriptors = Object.getOwnPropertyDescriptors(health);
  for (const field of Reflect.ownKeys(health)) {
    if (typeof field !== "string" || !MAIL_SERVICE_HEALTH_FIELD_SET.has(field)) {
      throw new Error("mail service health contains an unknown field");
    }
  }
  for (const field of MAIL_SERVICE_HEALTH_FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error("mail service health fields must be own data properties");
    }
  }
  if (health.apiVersion !== 1) {
    throw new Error("mail service health API version is invalid");
  }
  assertExactDataProperties(health.build, MAIL_SERVICE_BUILD_FIELDS, "mail service build");
  if (health.build.commit !== "dev" && !/^[a-f0-9]{40}$/.test(health.build.commit)) {
    throw new Error("mail service build commit is invalid");
  }
  if (
    health.build.builtAt !== "dev" &&
    (typeof health.build.builtAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(health.build.builtAt) ||
      Number.isNaN(Date.parse(health.build.builtAt)))
  ) {
    throw new Error("mail service build time is invalid");
  }
  if ((health.build.commit === "dev") !== (health.build.builtAt === "dev")) {
    throw new Error("mail service build identity is inconsistent");
  }
  if (health.status !== "ok" && health.status !== "degraded") {
    throw new Error("mail service health status is invalid");
  }
  if (health.localSchemaVersion !== null) {
    assertWholeNumber(health.localSchemaVersion, "mail health local schema version", 1);
  }
  if (health.cacheSchemaVersion !== null) {
    assertWholeNumber(health.cacheSchemaVersion, "mail health cache schema version", 1);
  }
  if (!("not_configured ready degraded".split(" ") as string[]).includes(health.receiveReadiness)) {
    throw new Error("mail health receive readiness is invalid");
  }
  if (
    !("not_configured ready egress_blocked degraded".split(" ") as string[]).includes(
      health.sendReadiness,
    )
  ) {
    throw new Error("mail health send readiness is invalid");
  }
  if (
    health.receiveReadiness === "ready" &&
    (health.localSchemaVersion === null || health.cacheSchemaVersion === null)
  ) {
    throw new Error("mail health receive readiness requires initialized schemas");
  }
  if (
    (health.sendReadiness === "ready" || health.sendReadiness === "egress_blocked") &&
    health.localSchemaVersion === null
  ) {
    throw new Error("mail health send readiness requires an initialized local schema");
  }
  assertWholeNumber(health.activeAccounts, "mail health active accounts", 0);
  if (health.activeAccounts > MAIL_RESOURCE_LIMITS.maxAccounts) {
    throw new Error("mail health active account count exceeds the configured quota");
  }
  assertWholeNumber(health.queuedSubmissions, "mail health queued submissions", 0);
  if (health.queuedSubmissions > MAIL_RESOURCE_LIMITS.maxQueuedSubmissions) {
    throw new Error("mail health queued submission count exceeds the configured quota");
  }
  if (health.lastSuccessfulSyncAgeMs !== null) {
    assertWholeNumber(
      health.lastSuccessfulSyncAgeMs,
      "mail health last successful sync age",
      0,
    );
  }
  if (!(["normal", "warning", "critical"] as const).includes(health.cachePressure)) {
    throw new Error("mail health cache pressure is invalid");
  }
  if (health.lastErrorCode !== null && !isStableMailLogCode(health.lastErrorCode)) {
    throw new Error("mail health error code is invalid");
  }
  const degraded =
    health.receiveReadiness === "degraded" ||
    health.sendReadiness === "degraded" ||
    health.sendReadiness === "egress_blocked" ||
    health.cachePressure === "critical" ||
    health.lastErrorCode !== null;
  if ((health.status === "degraded") !== degraded) {
    throw new Error("mail service health status is inconsistent with readiness");
  }
  return Object.freeze({
    apiVersion: 1,
    build: Object.freeze({
      commit: health.build.commit,
      builtAt: health.build.builtAt,
    }),
    status: health.status,
    localSchemaVersion: health.localSchemaVersion,
    cacheSchemaVersion: health.cacheSchemaVersion,
    receiveReadiness: health.receiveReadiness,
    sendReadiness: health.sendReadiness,
    activeAccounts: health.activeAccounts,
    queuedSubmissions: health.queuedSubmissions,
    lastSuccessfulSyncAgeMs: health.lastSuccessfulSyncAgeMs,
    cachePressure: health.cachePressure,
    lastErrorCode: health.lastErrorCode,
  });
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataPropertyValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isStableMailLogCode(value: unknown): value is string {
  return typeof value === "string" && MAIL_LOG_STABLE_CODE.test(value);
}

function normalizeHostname(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.endsWith(".") ? normalized.slice(0, -1) : normalized;
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253 || !hostname.includes(".")) return false;
  return hostname.split(".").every((label) => {
    if (label.length === 0 || label.length > 63) return false;
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  });
}

function expectedTlsForPort(protocol: MailProtocol, port: number): "implicit" | "starttls" {
  if (protocol === "imap") {
    if (port === 993) return "implicit";
    if (port === 143) return "starttls";
  } else {
    if (port === 465) return "implicit";
    if (port === 587) return "starttls";
  }
  throw new Error(`mail endpoint port ${port} is not allowed for ${protocol}`);
}

function isForbiddenIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && octets[2] === 0) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && octets[2] === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function validateMailDialTarget(target: ValidatedMailDialTarget): ValidatedMailDialTarget {
  assertExactDataProperties(target, MAIL_DIAL_TARGET_FIELDS, "mail dial target");
  if (target.protocol !== "imap" && target.protocol !== "smtp") {
    throw new Error("mail dial target protocol is unsupported");
  }
  const endpoint = validateMailEndpoint(target.protocol, target);
  const canonicalAddress = canonicalizeResolvedAddress(target.address, target.family);
  if (
    !canonicalAddress ||
    canonicalAddress !== target.address ||
    isForbiddenResolvedAddress(canonicalAddress)
  ) {
    throw new Error("mail dial target address is not a canonical public address");
  }
  assertSafeIdentifier(target.resolutionId, "mail dial target resolution id");
  assertWholeNumber(target.resolvedAt, "mail dial target resolution time", 0);
  assertWholeNumber(
    target.expiresAt,
    "mail dial target resolution expiry",
    target.resolvedAt + 1,
  );
  if (target.expiresAt > target.resolvedAt + MAIL_MAX_DNS_GENERATION_AGE_MS) {
    throw new Error("mail dial target expiry exceeds the freshness limit");
  }
  return Object.freeze({
    ...endpoint,
    protocol: target.protocol,
    address: canonicalAddress,
    family: target.family,
    resolutionId: target.resolutionId,
    resolvedAt: target.resolvedAt,
    expiresAt: target.expiresAt,
  });
}

function canonicalizeResolvedAddress(address: string, family: 4 | 6): string | null {
  if (address.includes("%") || isIP(address) !== family) return null;
  if (family === 4) return address.split(".").map(Number).join(".");

  const bytes = parseIpv6(address);
  if (!bytes) return null;
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((bytes[index * 2] << 8) | bytes[index * 2 + 1]).toString(16),
  );

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < groups.length && groups[end] === "0") end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  if (bestStart === -1) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLength).join(":");
  if (!left && !right) return "::";
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

/** Canonicalizes a public adapter-observed peer for exact pinned-target comparison. */
export function canonicalizeMailPeerAddress(
  address: string,
  family: 4 | 6,
): string | null {
  return canonicalizeResolvedAddress(address, family);
}

function parseIpv6(address: string): number[] | null {
  let source = address.toLowerCase();
  let ipv4Tail: number[] = [];
  const finalColon = source.lastIndexOf(":");
  const tail = source.slice(finalColon + 1);
  if (tail.includes(".")) {
    if (!isIP(tail)) return null;
    ipv4Tail = tail.split(".").map(Number);
    source = `${source.slice(0, finalColon)}:${(
      (ipv4Tail[0] << 8) |
      ipv4Tail[1]
    ).toString(16)}:${((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const fill = halves.length === 2 ? Array(8 - left.length - right.length).fill("0") : [];
  const groups = [...left, ...fill, ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function assertExactDataProperties(
  value: unknown,
  fields: readonly string[],
  label: string,
): void {
  if (!isPlainRecord(value)) throw new Error(`${label} is invalid`);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string" || !allowed.has(field)) {
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

function validateProtocolRuntimeConfig(
  protocol: MailProtocol,
  config: MailAccountRuntimeConfig["imap"],
): MailAccountRuntimeConfig["imap"] {
  const endpoint = validateMailEndpoint(protocol, config.endpoint);
  if (
    typeof config.auth.username !== "string" ||
    config.auth.username.length < 1 ||
    config.auth.username.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(config.auth.username)
  ) {
    throw new Error(`${protocol} authentication username is invalid`);
  }
  assertSafeIdentifier(config.auth.credentialRef.id, `${protocol} credential id`);
  assertWholeNumber(config.auth.credentialRef.version, `${protocol} credential version`, 1);
  assertSafeIdentifier(config.transportBindingRef.id, `${protocol} transport binding id`);
  assertWholeNumber(
    config.transportBindingRef.version,
    `${protocol} transport binding version`,
    1,
  );
  return Object.freeze({
    endpoint,
    auth: Object.freeze({
      username: config.auth.username,
      credentialRef: Object.freeze({
        id: config.auth.credentialRef.id,
        version: config.auth.credentialRef.version,
      }),
    }),
    transportBindingRef: Object.freeze({
      id: config.transportBindingRef.id,
      version: config.transportBindingRef.version,
    }),
  });
}

function validateUnsigned32String(value: string, label: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) throw new Error(`${label} is invalid`);
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric > 0xffff_ffff) {
    throw new Error(`${label} exceeds the unsigned 32-bit range`);
  }
  return value;
}

function validateUnsigned63String(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > BigInt("9223372036854775807")
  ) {
    throw new Error(`${label} exceeds the unsigned 63-bit range`);
  }
  return value;
}

function assertUnsigned32(value: number, allowZero: boolean, label: string): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > 0xffff_ffff) {
    throw new Error(`${label} is outside the unsigned 32-bit range`);
  }
}

function assertSafeIdentifier(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertMailboxIdentity(value: string, label: string): void {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    value.includes("\r") ||
    value.includes("\n") ||
    !/^[^<>\s@]+@[^<>\s@]+$/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

function assertWholeNumber(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a whole number of at least ${minimum}`);
  }
}
