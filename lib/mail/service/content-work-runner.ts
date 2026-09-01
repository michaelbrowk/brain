import { createHash } from "node:crypto";

import type {
  IsolatedMailParserPort,
  MailIncomingBlobStorePort,
  MailMimeParseBudget,
  ParsedMailArtifactSet,
} from "../ports";
import {
  preferSanitizedHtmlAlternative,
  readableMailBody,
  readableSanitizedMailHtml,
} from "../reader-content";
import {
  MAIL_RESOURCE_LIMITS,
  validateParsedMailArtifactSet,
} from "../security";
import { StoredGmailAccessTokenPort } from "../providers/gmail/access-token-port";
import { GmailApiClient } from "../providers/gmail/api-client";
import { GmailContentSourceAdapter } from "../providers/gmail/content-source-adapter";
import {
  ImapContentSourceAdapter,
  type ImapReadSessions,
} from "../providers/imap/sync-adapter";
import type { MultiMailAccountStore } from "./account-store";
import { MailContentCacheError } from "./content-cache";
import {
  MailContentWorkError,
  type MailContentWorkInput,
  type MailContentWorkRunnerPort,
} from "./content-coordinator";
import {
  MailContentSourceError,
  type MailContentSourcePort,
} from "./content-source";
import { CompleteSetMailDnsResolver } from "./dns";
import { ImapFlowReadSessionFactory } from "./imapflow-adapter";

export interface MailContentSourceLease {
  readonly source: MailContentSourcePort;
  destroy(): void;
}

export interface MailContentSourceFactoryPort {
  create(input: {
    readonly accountId: string;
    readonly blobStore: MailContentWorkInput["blobStore"];
    readonly incomingBlobStore: MailIncomingBlobStorePort & {
      readonly accountId: string;
    };
  }): Promise<MailContentSourceLease>;
}

/**
 * Production-only composition for raw MIME fetching. A Gmail access-token
 * cache is scoped to one content operation and is wiped immediately after it.
 * A custom-domain IMAP account fetches through the same bounded read-only
 * session factory that metadata sync uses, so DNS, binding, and credential
 * handling stay inside that factory.
 */
export function createProductionMailContentSourceFactory(options: {
  readonly store: MultiMailAccountStore;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly request?: typeof fetch;
  readonly now?: () => number;
  readonly imapSessions?: ImapReadSessions;
}): MailContentSourceFactoryPort {
  const imapSessions =
    options.imapSessions ??
    new ImapFlowReadSessionFactory({
      dns: new CompleteSetMailDnsResolver(),
      store: options.store,
    });
  return Object.freeze({
    async create(input: {
      readonly accountId: string;
      readonly blobStore: MailContentWorkInput["blobStore"];
      readonly incomingBlobStore: MailIncomingBlobStorePort & {
        readonly accountId: string;
      };
    }) {
      let account;
      try {
        account = await options.store.readAccount(input.accountId);
      } catch {
        throw transient("mail_content_source_transient");
      }
      if (account === null) {
        throw permanent("mail_content_source_permanent");
      }
      if (account.status !== "connected") {
        throw transient("mail_content_source_reauth_required");
      }
      switch (account.providerKind) {
        case "imap":
          return Object.freeze({
            source: new ImapContentSourceAdapter({
              account,
              sessions: imapSessions,
              blobStore: input.incomingBlobStore,
              ...(options.now === undefined ? {} : { now: options.now }),
            }),
            destroy: () => undefined,
          });
        case "gmail":
          break;
        default:
          throw permanent("mail_content_source_permanent");
      }
      const tokenPort = new StoredGmailAccessTokenPort({
        accountId: input.accountId,
        store: options.store,
        environment: options.environment,
        ...(options.request === undefined ? {} : { request: options.request }),
      });
      const client = new GmailApiClient({
        tokenPort,
        ...(options.request === undefined ? {} : { request: options.request }),
      });
      return Object.freeze({
        source: new GmailContentSourceAdapter({
          accountId: input.accountId,
          client,
          blobStore: input.incomingBlobStore,
          ...(options.now === undefined ? {} : { now: options.now }),
        }),
        destroy: () => tokenPort.destroy(),
      });
    },
  });
}

/** Joins the raw source, isolated parser, and durable content lease. */
export class ProductionMailContentWorkRunner implements MailContentWorkRunnerPort {
  private readonly sourceFactory: MailContentSourceFactoryPort;
  private readonly parser: IsolatedMailParserPort;
  private readonly now: () => number;

  constructor(options: {
    readonly sourceFactory: MailContentSourceFactoryPort;
    readonly parser: IsolatedMailParserPort;
    readonly now?: () => number;
  }) {
    this.sourceFactory = options.sourceFactory;
    this.parser = options.parser;
    this.now = options.now ?? Date.now;
  }

  async run(input: MailContentWorkInput, signal: AbortSignal): Promise<void> {
    let sourceLease: MailContentSourceLease | null = null;
    let artifacts: ParsedMailArtifactSet | null = null;
    try {
      signal.throwIfAborted();
      sourceLease = await this.sourceFactory.create({
        accountId: input.accountId,
        blobStore: input.blobStore,
        incomingBlobStore: input.cache.incomingBlobStore(input.lease),
      });
      const raw = await sourceLease.source.fetchRaw({
        accountId: input.accountId,
        providerMessageId: input.providerMessageId,
        signal,
        deadlineAt: input.deadlineAt,
      });
      await input.cache.stageBlob(
        input.lease,
        raw.descriptor,
        emptyChunks(),
        this.readNow(),
      );
      const parsed = await this.parser.parse({
        operationId: operationId(input),
        rawMime: raw.descriptor,
        rawMimeStream: input.blobStore.read(raw.descriptor),
        budget: parserBudget(input.deadlineAt, this.readNow()),
        signal,
      });
      if (parsed.kind !== "parsed") throw parserFailure(parsed);
      artifacts = parsed.artifacts;
      artifacts = validateParsedMailArtifactSet(artifacts);
      await publishParsedContent(input, raw.descriptor, artifacts, this.readNow());
    } catch (error) {
      throw mapWorkError(error, signal);
    } finally {
      wipeArtifacts(artifacts);
      sourceLease?.destroy();
    }
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw transient("mail_content_source_transient");
    }
    return now;
  }
}

async function publishParsedContent(
  input: MailContentWorkInput,
  rawMime: { readonly sha256: string; readonly bytes: number },
  artifacts: ParsedMailArtifactSet,
  now: number,
): Promise<void> {
  const staged = [
    artifacts.text,
    artifacts.sanitizedHtml,
    ...artifacts.attachments.map((attachment) => attachment.blob),
  ].filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null);
  for (const artifact of staged) {
    await input.cache.stageBlob(
      input.lease,
      artifact.descriptor,
      chunks(artifact.data),
      now,
    );
  }
  await input.cache.commitReady({
    lease: input.lease,
    rawMime,
    text: artifacts.text?.descriptor ?? null,
    sanitizedHtml: artifacts.sanitizedHtml?.descriptor ?? null,
    attachments: artifacts.attachments.map((attachment) =>
      Object.freeze({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        disposition: attachment.disposition,
        contentId: attachment.contentId,
        blob: attachment.blob.descriptor,
      }),
    ),
    remoteImages: selectedRemoteImages(artifacts),
    now,
  });
}

function selectedRemoteImages(
  artifacts: ParsedMailArtifactSet,
): ParsedMailArtifactSet["remoteImages"] {
  if (artifacts.remoteImages.length === 0 || artifacts.sanitizedHtml === null) {
    return Object.freeze([]);
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = artifacts.text === null
      ? null
      : readableMailBody(decoder.decode(artifacts.text.data));
    const html = readableSanitizedMailHtml(
      decoder.decode(artifacts.sanitizedHtml.data),
    );
    return preferSanitizedHtmlAlternative(text, html)
      ? artifacts.remoteImages
      : Object.freeze([]);
  } catch {
    return Object.freeze([]);
  }
}

function parserBudget(leaseDeadlineAt: number, now: number): MailMimeParseBudget {
  const deadlineAt = Math.min(
    leaseDeadlineAt,
    now + MAIL_RESOURCE_LIMITS.mimeParserDeadlineMs,
  );
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= now) {
    throw transient("mail_content_source_transient");
  }
  return Object.freeze({
    deadlineAt,
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
    maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
    maxInlineImagePixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels,
    maxInlineImageFrames: MAIL_RESOURCE_LIMITS.maxInlineImageFrames,
  });
}

function parserFailure(outcome: Exclude<Awaited<ReturnType<IsolatedMailParserPort["parse"]>>, { readonly kind: "parsed" }>): MailContentWorkError {
  return outcome.kind === "transient_failure"
    ? transient(outcome.errorCode)
    : permanent(outcome.errorCode);
}

function mapWorkError(error: unknown, signal: AbortSignal): MailContentWorkError {
  if (error instanceof MailContentWorkError) return error;
  if (error instanceof MailContentCacheError) {
    if (error.code === "mail_content_cache_capacity_exhausted") {
      return transient("mail_content_cache_capacity_exhausted");
    }
    return transient("mail_content_cache_unavailable");
  }
  if (error instanceof MailContentSourceError) {
    switch (error.code) {
      case "mail_content_source_reauth_required":
        return transient(error.code);
      case "mail_content_source_permanent":
      case "mail_content_source_invalid_response":
        return permanent(error.code);
      case "mail_content_source_rate_limited":
      case "mail_content_source_transient":
        return transient(error.code);
    }
  }
  if (signal.aborted) return transient("mail_content_source_transient");
  return transient("content_worker_failed");
}

function operationId(input: MailContentWorkInput): string {
  const digest = createHash("sha256")
    .update(input.accountId)
    .update("\u0000")
    .update(input.providerMessageId)
    .update("\u0000")
    .update(input.lease.token)
    .digest("hex");
  return `content-${digest}`;
}

async function* chunks(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.byteLength > 0) yield data;
}

async function* emptyChunks(): AsyncIterable<Uint8Array> {}

function wipeArtifacts(artifacts: ParsedMailArtifactSet | null): void {
  if (artifacts === null) return;
  artifacts.text?.data.fill(0);
  artifacts.sanitizedHtml?.data.fill(0);
  for (const attachment of artifacts.attachments) attachment.blob.data.fill(0);
}

function transient(errorCode: string): MailContentWorkError {
  return new MailContentWorkError("transient", errorCode);
}

function permanent(errorCode: string): MailContentWorkError {
  return new MailContentWorkError("permanent", errorCode);
}
