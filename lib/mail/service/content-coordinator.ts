import path from "node:path";

import {
  validateMailContentAccountId,
  validateMailContentAttachmentId,
  validateMailContentMessageId,
  validateMailContentRemoteImageId,
} from "../content-codec";
import type {
  MailContentAttachmentDto,
  MailMessageContent,
} from "../content-types";
import type { MailBlobDescriptor } from "../ports";
import { MAIL_RESOURCE_LIMITS } from "../security";
import type { MultiMailAccountStore } from "./account-store";
import { MailAccountError } from "./account-types";
import type { MailAccountRemovalGuard } from "./accounts";
import {
  AtomicMailBlobStore,
  type MailBlobReadSnapshot,
} from "./content-blob-store";
import {
  MailContentCacheError,
  type MailContentCapacityReclaimer,
  type CachedMailContent,
  type CachedMailRemoteImageSnapshot,
  type MailContentCacheSnapshot,
  type MailContentLease,
  SqliteMailContentCache,
} from "./content-cache";
import {
  PinnedRemoteImageFetcher,
  RemoteImageFetchError,
  type RemoteImageFetcherPort,
} from "./remote-image-fetcher";

const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 60_000;
const DEFAULT_RETRY_ATTEMPTS = 4;

export type MailContentServiceErrorCode =
  | "mail_content_request_invalid"
  | "mail_content_account_not_found"
  | "mail_content_message_not_found"
  | "mail_content_attachment_not_found"
  | "mail_content_remote_image_not_found"
  | "mail_content_unavailable";

export class MailContentServiceError extends Error {
  constructor(readonly code: MailContentServiceErrorCode) {
    super(code);
    this.name = "MailContentServiceError";
  }
}

export type MailContentWorkFailureKind = "transient" | "permanent";

export class MailContentWorkError extends Error {
  readonly kind: MailContentWorkFailureKind;
  readonly errorCode: string;

  constructor(kind: MailContentWorkFailureKind, errorCode: string) {
    if (
      (kind !== "transient" && kind !== "permanent") ||
      !SAFE_ERROR_CODE.test(errorCode)
    ) {
      throw new MailContentServiceError("mail_content_request_invalid");
    }
    super(errorCode);
    this.name = "MailContentWorkError";
    this.kind = kind;
    this.errorCode = errorCode;
  }
}

export interface MailContentWorkInput {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly lease: MailContentLease;
  readonly cache: SqliteMailContentCache;
  readonly blobStore: AtomicMailBlobStore;
  readonly deadlineAt: number;
}

/**
 * Integration seam for the raw-fetch and isolated-parser slices. A runner must
 * either commit this exact lease ready or throw a classified work error.
 */
export interface MailContentWorkRunnerPort {
  run(input: MailContentWorkInput, signal: AbortSignal): Promise<void>;
}

export interface MailContentRetryPolicyPort {
  nextDelayMs(input: {
    readonly accountId: string;
    readonly providerMessageId: string;
    readonly attempt: number;
    readonly errorCode: string;
  }): number | null;
}

export type MailContentQueueRunResult =
  | { readonly kind: "complete" }
  | { readonly kind: "retry"; readonly notBefore: number };

export interface MailContentQueueTask {
  readonly accountId: string;
  readonly providerMessageId: string;
  run(signal: AbortSignal): Promise<MailContentQueueRunResult>;
}

export interface MailContentWorkQueuePort {
  has(accountId: string, providerMessageId: string): boolean;
  enqueue(task: MailContentQueueTask): "queued" | "coalesced";
  abortAndDrainAccount(accountId: string): Promise<void>;
  restoreAccount(accountId: string): void;
  close(): Promise<void>;
}

export interface MailAttachmentDownload {
  readonly accountId: string;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly bytes: number;
  readonly body: AsyncIterable<Uint8Array>;
  dispose(): Promise<void>;
}

export interface MailContentService {
  getContent(input: {
    readonly accountId: string;
    readonly messageId: string;
  }): Promise<MailMessageContent>;
  requestContent(input: {
    readonly accountId: string;
    readonly messageId: string;
  }): Promise<MailMessageContent>;
  downloadAttachment(input: {
    readonly accountId: string;
    readonly attachmentId: string;
    readonly signal?: AbortSignal;
  }): Promise<MailAttachmentDownload>;
  downloadRemoteImage?(input: {
    readonly accountId: string;
    readonly remoteImageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MailAttachmentDownload>;
}

export interface MailBackgroundContentPrefetchResult {
  readonly hasMore: boolean;
}

/**
 * The image pipeline's own record, for the service's stdout stream. Payloads
 * stay inside the section 13 allowlist: a remote image reaches the reader
 * through the attachment download contract, so a drain counts its images as
 * `attachmentCount`; a fetched image reports the bytes it added to the cache
 * as `cacheBytes`; a transient refusal reports how far off its retry is as a
 * `durationBucket`. Nothing here names a URL, a host or an image id.
 */
export type MailContentCoordinatorEvent =
  | Readonly<{
      event: "mail_remote_image_drain_started";
      accountId: string;
      attachmentCount: number;
    }>
  | Readonly<{
      event: "mail_remote_image_drain_finished";
      accountId: string;
      attachmentCount: number;
    }>
  | Readonly<{
      event: "mail_remote_image_settled";
      accountId: string;
      phase: "fetched";
      cacheBytes: number;
    }>
  | Readonly<{
      event: "mail_remote_image_settled";
      accountId: string;
      phase: "blocked" | "origin_refused" | "budget_exhausted";
      errorCode: string;
    }>
  | Readonly<{
      event: "mail_remote_image_settled";
      accountId: string;
      phase: "transient";
      errorCode: string;
      durationBucket: string;
    }>;

interface QueueEntry {
  readonly key: string;
  readonly task: MailContentQueueTask;
  readonly controller: AbortController;
  readonly drained: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  running: boolean;
}

/** Process-local content queue. Durable truth remains in SqliteMailContentCache. */
export class InMemoryMailContentWorkQueue implements MailContentWorkQueuePort {
  private readonly clock: () => number;
  private readonly maxPending: number;
  private readonly entries = new Map<string, QueueEntry>();
  private readonly pending: QueueEntry[] = [];
  private readonly invalidatedAccounts = new Set<string>();
  private active = 0;
  private closed = false;

  constructor(options: {
    readonly clock?: () => number;
    readonly maxPending?: number;
  } = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxPending = positiveInteger(
      options.maxPending ?? MAIL_RESOURCE_LIMITS.maxQueuedSubmissions,
    );
    if (this.maxPending > MAIL_RESOURCE_LIMITS.maxQueuedSubmissions) {
      throw new MailContentServiceError("mail_content_request_invalid");
    }
  }

  has(accountIdInput: string, providerMessageIdInput: string): boolean {
    const accountId = contentAccountId(accountIdInput);
    const providerMessageId = contentMessageId(providerMessageIdInput);
    return this.entries.has(contentWorkKey(accountId, providerMessageId));
  }

  enqueue(task: MailContentQueueTask): "queued" | "coalesced" {
    const accountId = contentAccountId(task.accountId);
    const providerMessageId = contentMessageId(task.providerMessageId);
    if (typeof task.run !== "function" || this.closed) throw unavailable();
    if (this.invalidatedAccounts.has(accountId)) throw accountNotFound();
    const key = contentWorkKey(accountId, providerMessageId);
    if (this.entries.has(key)) return "coalesced";
    if (this.pendingSize() >= this.maxPending) {
      throw new MailContentWorkError("transient", "queue_full");
    }
    const entry: QueueEntry = {
      key,
      task: Object.freeze({ ...task, accountId, providerMessageId }),
      controller: new AbortController(),
      drained: [],
      timer: null,
      queued: true,
      running: false,
    };
    this.entries.set(key, entry);
    this.pending.push(entry);
    queueMicrotask(() => this.pump());
    return "queued";
  }

  async abortAndDrainAccount(accountIdInput: string): Promise<void> {
    const accountId = contentAccountId(accountIdInput);
    this.invalidatedAccounts.add(accountId);
    const matching = [...this.entries.values()].filter(
      (entry) => entry.task.accountId === accountId,
    );
    const waits: Promise<void>[] = [];
    for (const entry of matching) {
      entry.controller.abort(new MailContentServiceError("mail_content_account_not_found"));
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.running) {
        waits.push(new Promise<void>((resolve) => entry.drained.push(resolve)));
      } else {
        this.finish(entry);
      }
    }
    this.pump();
    await Promise.all(waits);
  }

  restoreAccount(accountIdInput: string): void {
    if (this.closed) return;
    this.invalidatedAccounts.delete(contentAccountId(accountIdInput));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const accountIds = new Set(
      [...this.entries.values()].map((entry) => entry.task.accountId),
    );
    await Promise.all(
      [...accountIds].map((accountId) => this.abortAndDrainAccount(accountId)),
    );
  }

  private start(entry: QueueEntry): void {
    if (
      this.entries.get(entry.key) !== entry ||
      entry.running ||
      entry.controller.signal.aborted ||
      this.closed
    ) {
      if (!entry.running) this.finish(entry);
      return;
    }
    entry.running = true;
    this.active += 1;
    void Promise.resolve()
      .then(() => entry.task.run(entry.controller.signal))
      .then(
        (result) => this.onResult(entry, result),
        () => this.onRejected(entry),
      );
  }

  private onResult(entry: QueueEntry, result: MailContentQueueRunResult): void {
    this.releaseActive(entry);
    if (
      result.kind === "complete" ||
      entry.controller.signal.aborted ||
      this.closed ||
      this.entries.get(entry.key) !== entry
    ) {
      this.finish(entry);
      this.pump();
      return;
    }
    if (
      result.kind !== "retry" ||
      !Number.isSafeInteger(result.notBefore) ||
      result.notBefore < 0
    ) {
      this.finish(entry);
      this.pump();
      return;
    }
    const delay = Math.max(0, result.notBefore - this.clock());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.queuePending(entry);
    }, Math.min(delay, 2_147_483_647));
    entry.timer.unref?.();
    this.pump();
  }

  private onRejected(entry: QueueEntry): void {
    this.releaseActive(entry);
    this.finish(entry);
    this.pump();
  }

  private queuePending(entry: QueueEntry): void {
    if (
      this.entries.get(entry.key) !== entry ||
      entry.controller.signal.aborted ||
      this.closed
    ) {
      this.finish(entry);
      this.pump();
      return;
    }
    if (!entry.queued) {
      entry.queued = true;
      this.pending.push(entry);
    }
    this.pump();
  }

  private pump(): void {
    while (
      !this.closed &&
      this.active < MAIL_RESOURCE_LIMITS.concurrentMimeParsers &&
      this.pending.length > 0
    ) {
      const entry = this.pending.shift()!;
      entry.queued = false;
      this.start(entry);
    }
  }

  private releaseActive(entry: QueueEntry): void {
    if (!entry.running) return;
    entry.running = false;
    this.active -= 1;
    if (this.active < 0) {
      this.active = 0;
      throw new MailContentServiceError("mail_content_unavailable");
    }
  }

  private pendingSize(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (!entry.running) total += 1;
    }
    return total;
  }

  private finish(entry: QueueEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.queued) {
      const index = this.pending.indexOf(entry);
      if (index >= 0) this.pending.splice(index, 1);
      entry.queued = false;
    }
    entry.running = false;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    for (const resolve of entry.drained.splice(0)) resolve();
  }
}

export class ExponentialMailContentRetryPolicy
  implements MailContentRetryPolicyPort
{
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly maxAttempts: number;

  constructor(options: {
    readonly baseMs?: number;
    readonly maxMs?: number;
    readonly maxAttempts?: number;
  } = {}) {
    this.baseMs = positiveInteger(options.baseMs ?? DEFAULT_RETRY_BASE_MS);
    this.maxMs = positiveInteger(options.maxMs ?? DEFAULT_RETRY_MAX_MS);
    this.maxAttempts = positiveInteger(
      options.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS,
    );
    if (this.baseMs > this.maxMs || this.maxAttempts > 32) {
      throw new MailContentServiceError("mail_content_request_invalid");
    }
  }

  nextDelayMs(input: {
    readonly accountId: string;
    readonly providerMessageId: string;
    readonly attempt: number;
    readonly errorCode: string;
  }): number | null {
    contentAccountId(input.accountId);
    contentMessageId(input.providerMessageId);
    if (
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !SAFE_ERROR_CODE.test(input.errorCode)
    ) {
      throw new MailContentServiceError("mail_content_request_invalid");
    }
    // OAuth reconnect is user-driven. Persist a retryable cache state, but do
    // not run a background timer against credentials that are known to need
    // intervention. The next explicit content request claims a fresh lease.
    if (input.errorCode === "mail_content_source_reauth_required") return null;
    if (input.attempt >= this.maxAttempts) return null;
    return Math.min(this.maxMs, this.baseMs * 2 ** (input.attempt - 1));
  }
}

interface RegistryEntry {
  readonly cache: SqliteMailContentCache;
  readonly blobStore: AtomicMailBlobStore;
  readonly lifecycle: AbortController;
  activeOperations: number;
  readonly drained: Array<() => void>;
}

export class MailContentCoordinator
  implements MailContentService, MailAccountRemovalGuard
{
  private readonly cacheRoot: string;
  private readonly store: MultiMailAccountStore;
  private readonly runner: MailContentWorkRunnerPort;
  private readonly queue: MailContentWorkQueuePort;
  private readonly retryPolicy: MailContentRetryPolicyPort;
  private readonly onBackgroundWorkAvailable: (() => void) | null;
  private readonly onEvent: ((event: MailContentCoordinatorEvent) => void) | null;
  private readonly clock: () => number;
  private readonly capacityReclaimer: MailContentCapacityReclaimer;
  private readonly remoteImageFetcher: RemoteImageFetcherPort;
  private readonly remoteImageFetches = new Map<string, Promise<void>>();
  private readonly remoteImageMessageTails = new Map<string, Promise<void>>();
  private readonly remoteImageDrains = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly invalidatedAccounts = new Set<string>();
  private resolutionTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: {
    readonly stateDirectory: string;
    readonly store: MultiMailAccountStore;
    readonly runner: MailContentWorkRunnerPort;
    readonly queue?: MailContentWorkQueuePort;
    readonly retryPolicy?: MailContentRetryPolicyPort;
    readonly remoteImageFetcher?: RemoteImageFetcherPort;
    readonly onBackgroundWorkAvailable?: () => void;
    readonly onEvent?: (event: MailContentCoordinatorEvent) => void;
    readonly clock?: () => number;
  }) {
    if (
      !path.isAbsolute(options.stateDirectory) ||
      path.resolve(options.stateDirectory) !== options.stateDirectory ||
      typeof options.runner?.run !== "function" ||
      (options.remoteImageFetcher !== undefined &&
        typeof options.remoteImageFetcher.fetch !== "function") ||
      (options.onBackgroundWorkAvailable !== undefined &&
        typeof options.onBackgroundWorkAvailable !== "function") ||
      (options.onEvent !== undefined && typeof options.onEvent !== "function")
    ) {
      throw new MailContentServiceError("mail_content_request_invalid");
    }
    this.cacheRoot = path.join(options.stateDirectory, "cache");
    this.store = options.store;
    this.runner = options.runner;
    this.clock = options.clock ?? Date.now;
    this.queue = options.queue ?? new InMemoryMailContentWorkQueue({ clock: this.clock });
    this.retryPolicy = options.retryPolicy ?? new ExponentialMailContentRetryPolicy();
    this.onBackgroundWorkAvailable = options.onBackgroundWorkAvailable ?? null;
    this.onEvent = options.onEvent ?? null;
    this.remoteImageFetcher =
      options.remoteImageFetcher ?? new PinnedRemoteImageFetcher();
    this.capacityReclaimer = new GlobalMailContentCapacityReclaimer({
      cacheRoot: this.cacheRoot,
      store: this.store,
      clock: this.clock,
    });
  }

  async getContent(input: {
    readonly accountId: string;
    readonly messageId: string;
  }): Promise<MailMessageContent> {
    const accountId = contentAccountId(input.accountId);
    const messageId = contentMessageId(input.messageId);
    return this.withEntry(accountId, async (entry) =>
      this.projectSnapshot(entry, messageId, await entry.cache.inspect(messageId)),
    );
  }

  async requestContent(input: {
    readonly accountId: string;
    readonly messageId: string;
  }): Promise<MailMessageContent> {
    const accountId = contentAccountId(input.accountId);
    const messageId = contentMessageId(input.messageId);
    return this.withEntry(accountId, async (entry) => {
      await entry.cache.recordUserContentDemand(messageId, this.readTime());
      this.signalBackgroundWork();
      const snapshot = await entry.cache.inspect(messageId);
      if (snapshot.kind === "ready") {
        // The body is cached but its images may not be. Opening the message
        // is the owner's approval to fetch them, so the drain starts now
        // rather than when the scheduler next reaches this account.
        this.startRemoteImageDrain(accountId, messageId);
        return this.projectSnapshot(entry, messageId, snapshot);
      }
      // Only work in flight short-circuits. A background start whose content
      // never landed (transient failure waiting out its retry window, a row
      // invalidated by a format or generation change) must not strand the
      // owner's explicit demand: it re-claims now.
      if (
        snapshot.kind === "fetching" &&
        (await entry.cache.isBackgroundContentPrefetchStarted(messageId))
      ) {
        return this.projectSnapshot(entry, messageId, snapshot);
      }
      return this.requestContentForEntry(entry, accountId, messageId);
    });
  }

  private async requestContentForEntry(
    entry: RegistryEntry,
    accountId: string,
    messageId: string,
  ): Promise<MailMessageContent> {
    if (this.queue.has(accountId, messageId)) {
      return contentState(accountId, messageId, "fetching");
    }
    const claim = await entry.cache.claim(messageId, this.readTime());
    if (claim.kind === "not_active") throw messageNotFound();
    if (claim.kind === "ready") {
      return this.projectSnapshot(
        entry,
        messageId,
        await entry.cache.inspect(messageId),
      );
    }
    if (claim.kind === "permanent_failure") {
      return contentState(accountId, messageId, "permanent");
    }
    if (claim.kind === "busy") {
      return contentState(accountId, messageId, "fetching");
    }
    let firstLease: MailContentLease | null = claim.lease;
    let attempt = 0;
    try {
      this.queue.enqueue({
        accountId,
        providerMessageId: messageId,
        run: async (signal) => {
          const lease = firstLease;
          firstLease = null;
          return this.runQueuedAttempt({
            accountId,
            messageId,
            lease,
            signal,
            nextAttempt: () => {
              attempt += 1;
              return attempt;
            },
          });
        },
      });
    } catch (error) {
      const errorCode =
        error instanceof MailContentWorkError && error.kind === "transient"
          ? error.errorCode
          : "content_queue_unavailable";
      await entry.cache
        .markFailure({
          lease: claim.lease,
          kind: "transient",
          errorCode,
          now: this.readTime(),
        })
        .catch(() => undefined);
      throw contentServiceError(error);
    }
    return contentState(accountId, messageId, "fetching");
  }

  async downloadAttachment(input: {
    readonly accountId: string;
    readonly attachmentId: string;
    readonly signal?: AbortSignal;
  }): Promise<MailAttachmentDownload> {
    const accountId = contentAccountId(input.accountId);
    const attachmentId = contentAttachmentId(input.attachmentId);
    return this.withEntry(accountId, async (entry) => {
      const snapshot = await entry.cache.readAttachment(attachmentId);
      if (snapshot === null || snapshot.accountId !== accountId) {
        throw attachmentNotFound();
      }
      let verified: MailBlobReadSnapshot;
      try {
        verified = await entry.blobStore.openVerifiedSnapshot(
          snapshot.attachment.blob,
          input.signal,
        );
      } catch {
        if (input.signal?.aborted) throw unavailable();
        await invalidateBlobRead(
          entry,
          snapshot,
          snapshot.attachment.blob,
          this.readTime(),
        );
        throw unavailable();
      }
      return Object.freeze({
        accountId,
        messageId: snapshot.providerMessageId,
        attachmentId,
        filename: snapshot.attachment.filename,
        mimeType: snapshot.attachment.mimeType,
        bytes: snapshot.attachment.blob.bytes,
        body: verified.body,
        dispose: verified.dispose,
      });
    });
  }

  async downloadRemoteImage(input: {
    readonly accountId: string;
    readonly remoteImageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MailAttachmentDownload> {
    const accountId = contentAccountId(input.accountId);
    const remoteImageId = contentRemoteImageId(input.remoteImageId);
    return this.withEntry(accountId, async (entry) => {
      if (input.signal?.aborted) throw unavailable();
      const snapshot = await entry.cache.inspectRemoteImage(
        remoteImageId,
        this.readTime(),
      );
      if (snapshot === null || snapshot.accountId !== accountId) {
        throw remoteImageNotFound();
      }
      if (snapshot.state === "permanent_failure") {
        throw remoteImageNotFound();
      }
      // The reader endpoint is cache-only. A cold read must never reveal open
      // time by initiating an origin request; only the background sync path
      // below may populate pending remote images.
      if (snapshot.state !== "ready") throw unavailable();
      let verified: MailBlobReadSnapshot;
      try {
        verified = await entry.blobStore.openVerifiedSnapshot(
          snapshot.blob,
          input.signal,
        );
      } catch {
        if (input.signal?.aborted) throw unavailable();
        await entry.cache
          .invalidateRemoteImage({ snapshot, now: this.readTime() })
          .catch(() => undefined);
        throw unavailable();
      }
      return Object.freeze({
        accountId,
        messageId: snapshot.providerMessageId,
        attachmentId: remoteImageId,
        filename: null,
        mimeType: snapshot.mimeType,
        bytes: snapshot.blob.bytes,
        body: verified.body,
        dispose: verified.dispose,
      });
    });
  }

  async runBackgroundPrefetchStep(
    accountIdInput: string,
    signal: AbortSignal,
  ): Promise<MailBackgroundContentPrefetchResult> {
    const accountId = contentAccountId(accountIdInput);
    if (
      signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function"
    ) {
      throw requestInvalid();
    }
    if (signal.aborted || this.closed) return backgroundPrefetchComplete();

    const selection = await this.withEntry(accountId, async (entry) => {
      const cohort = await entry.cache.refreshBackgroundPrivacyCohort(
        this.readTime(),
      );
      if (cohort.purgedContent) await entry.cache.collectGarbage();
      const remoteImageId = await entry.cache.findBackgroundRemoteImageCandidate(
        this.readTime(),
      );
      if (remoteImageId !== null) {
        const snapshot = await entry.cache.inspectRemoteImage(
          remoteImageId,
          this.readTime(),
        );
        if (snapshot !== null && snapshot.state === "pending") {
          const prefetchSignal = AbortSignal.any([
            signal,
            entry.lifecycle.signal,
          ]);
          try {
            await this.loadRemoteImage(entry, snapshot, prefetchSignal);
          } catch {
            if (prefetchSignal.aborted || this.closed) throw unavailable();
            // The exact failure state is durable. Continue the detached batch
            // so one bad sender host cannot block unrelated cached messages.
          }
        }
        return Object.freeze({ kind: "worked" as const });
      }
      const messageId = await entry.cache.findBackgroundContentCandidate(
        this.readTime(),
      );
      if (messageId !== null) {
        await entry.cache.markBackgroundContentPrefetchStarted(
          messageId,
          this.readTime(),
        );
        await this.requestContentForEntry(entry, accountId, messageId);
        return Object.freeze({ kind: "worked" as const });
      }
      return Object.freeze({ kind: "complete" as const });
    });
    if (selection.kind === "complete") return backgroundPrefetchComplete();
    return Object.freeze({ hasMore: true });
  }

  private async loadRemoteImage(
    entry: RegistryEntry,
    snapshot: Extract<CachedMailRemoteImageSnapshot, { readonly state: "pending" }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const key = `${snapshot.accountId}:${snapshot.remoteImageId}`;
    const existing = this.remoteImageFetches.get(key);
    if (existing !== undefined) return joinAbortable(existing, signal);
    const messageKey = `${snapshot.accountId}:${snapshot.providerMessageId}`;
    const previous = this.remoteImageMessageTails.get(messageKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      if (signal?.aborted) throw unavailable();
      const liveSnapshot = await entry.cache.inspectRemoteImage(
        snapshot.remoteImageId,
        this.readTime(),
      );
      if (liveSnapshot === null || liveSnapshot.accountId !== snapshot.accountId) {
        throw remoteImageNotFound();
      }
      if (liveSnapshot.state === "ready") return;
      if (liveSnapshot.state === "permanent_failure") throw remoteImageNotFound();
      if (liveSnapshot.state === "transient_failure") throw unavailable();
      let result: Awaited<ReturnType<RemoteImageFetcherPort["fetch"]>> | null = null;
      try {
        const budget = await entry.cache.readRemoteImageBudget(liveSnapshot);
        if (
          budget.maxBytes < 1 ||
          budget.maxPixels < 1 ||
          budget.maxFrames < 1
        ) {
          throw new RemoteImageFetchError(
            "permanent",
            "remote_image_budget_exceeded",
          );
        }
        result = await this.remoteImageFetcher.fetch(
          liveSnapshot.sourceUrl,
          budget,
          signal,
        );
        await entry.cache.storeRemoteImage({
          snapshot: liveSnapshot,
          mimeType: result.mimeType,
          data: result.data,
          raster: result.raster,
          now: this.readTime(),
        });
        this.emit({
          event: "mail_remote_image_settled",
          accountId: snapshot.accountId,
          phase: "fetched",
          cacheBytes: result.data.byteLength,
        });
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof RemoteImageFetchError &&
            error.code === "remote_image_fetch_aborted")
        ) {
          throw unavailable();
        }
        const kind =
          error instanceof RemoteImageFetchError
            ? error.kind
            : error instanceof MailContentCacheError &&
                error.code === "mail_content_remote_image_budget_exhausted"
              ? "permanent"
              : "transient";
        const errorCode =
          error instanceof RemoteImageFetchError ||
          error instanceof MailContentCacheError
            ? error.code
            : "remote_image_fetch_failed";
        const now = this.readTime();
        const retryAt = now + MAIL_RESOURCE_LIMITS.remoteImageTransientRetryMs;
        await entry.cache
          .markRemoteImageFailure({
            snapshot: liveSnapshot,
            kind,
            ...(kind === "transient" ? { retryAt } : {}),
            now,
          })
          .catch(() => undefined);
        this.emit(
          kind === "transient"
            ? {
                event: "mail_remote_image_settled",
                accountId: snapshot.accountId,
                phase: "transient",
                errorCode,
                durationBucket: durationBucket(retryAt - now),
              }
            : {
                event: "mail_remote_image_settled",
                accountId: snapshot.accountId,
                phase: remoteImageRefusal(errorCode),
                errorCode,
              },
        );
        if (kind === "permanent") throw remoteImageNotFound();
        throw unavailable();
      } finally {
        result?.data.fill(0);
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.remoteImageMessageTails.set(messageKey, tail);
    this.remoteImageFetches.set(key, run);
    try {
      await run;
    } finally {
      if (this.remoteImageFetches.get(key) === run) {
        this.remoteImageFetches.delete(key);
      }
      if (this.remoteImageMessageTails.get(messageKey) === tail) {
        this.remoteImageMessageTails.delete(messageKey);
      }
    }
  }

  async invalidateAccount(accountIdInput: string): Promise<void> {
    const accountId = contentAccountId(accountIdInput);
    const block = async () => {
      this.invalidatedAccounts.add(accountId);
      this.entries.get(accountId)?.lifecycle.abort(accountNotFound());
    };
    const blocked = this.resolutionTail.then(block, block);
    this.resolutionTail = settledTail(blocked);
    await blocked;
    await this.queue.abortAndDrainAccount(accountId);
    const teardown = async () => {
      const entry = this.entries.get(accountId);
      if (!entry) return;
      if (entry.activeOperations > 0) {
        await new Promise<void>((resolve) => entry.drained.push(resolve));
      }
      await closeEntry(entry);
      this.entries.delete(accountId);
    };
    const run = this.resolutionTail.then(teardown, teardown);
    this.resolutionTail = settledTail(run);
    await run;
  }

  restoreInvalidatedAccount(accountIdInput: string): void {
    const accountId = contentAccountId(accountIdInput);
    if (this.closed) return;
    this.invalidatedAccounts.delete(accountId);
    this.queue.restoreAccount(accountId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue.close();
    const execute = async () => {
      for (const accountId of this.entries.keys()) {
        this.invalidatedAccounts.add(accountId);
      }
      for (const entry of this.entries.values()) {
        entry.lifecycle.abort(unavailable());
      }
      const active = [...this.entries.values()].filter(
        (entry) => entry.activeOperations > 0,
      );
      await Promise.all(
        active.map(
          (entry) => new Promise<void>((resolve) => entry.drained.push(resolve)),
        ),
      );
      await Promise.all([...this.entries.values()].map(closeEntry));
      this.entries.clear();
    };
    const run = this.resolutionTail.then(execute, execute);
    this.resolutionTail = settledTail(run);
    await run;
  }

  private async runQueuedAttempt(input: {
    readonly accountId: string;
    readonly messageId: string;
    readonly lease: MailContentLease | null;
    readonly signal: AbortSignal;
    readonly nextAttempt: () => number;
  }): Promise<MailContentQueueRunResult> {
    if (input.signal.aborted || this.closed) return complete();
    try {
      return await this.withEntry(input.accountId, async (entry) => {
        let lease = input.lease;
        if (lease === null) {
          const claim = await entry.cache.claim(input.messageId, this.readTime());
          if (
            claim.kind === "ready" ||
            claim.kind === "permanent_failure" ||
            claim.kind === "not_active"
          ) {
            return complete();
          }
          if (claim.kind === "busy") return retryAt(claim.expiresAt);
          lease = claim.lease;
        }
        try {
          await this.runner.run(
            {
              accountId: input.accountId,
              providerMessageId: input.messageId,
              lease,
              cache: entry.cache,
              blobStore: entry.blobStore,
              deadlineAt: lease.expiresAt,
            },
            input.signal,
          );
          const state = await entry.cache.inspect(input.messageId);
          if (
            state.kind !== "ready" ||
            state.content.sourceGeneration !== lease.sourceGeneration ||
            state.content.version !== lease.version
          ) {
            throw new MailContentWorkError(
              "transient",
              "content_worker_incomplete",
            );
          }
          // Freshly committed content may reference pending remote images.
          // Their drain starts here, detached from this attempt; the
          // scheduler still hears about it for whatever the drain leaves.
          this.startRemoteImageDrain(input.accountId, input.messageId);
          this.signalBackgroundWork();
          return complete();
        } catch (error) {
          if (input.signal.aborted || this.closed) return complete();
          const failure = workFailure(error);
          try {
            await entry.cache.markFailure({
              lease,
              kind: failure.kind,
              errorCode: failure.errorCode,
              now: this.readTime(),
            });
          } catch (markError) {
            if (
              markError instanceof MailContentCacheError &&
              markError.code === "mail_content_lease_stale"
            ) {
              return complete();
            }
            throw markError;
          }
          if (failure.kind === "permanent") return complete();
          const attempt = input.nextAttempt();
          const delay = this.retryPolicy.nextDelayMs({
            accountId: input.accountId,
            providerMessageId: input.messageId,
            attempt,
            errorCode: failure.errorCode,
          });
          return delay === null ? complete() : retryAt(this.readTime() + delay);
        }
      });
    } catch {
      return complete();
    }
  }

  private async projectSnapshot(
    entry: RegistryEntry,
    messageId: string,
    snapshot: MailContentCacheSnapshot,
  ): Promise<MailMessageContent> {
    const accountId = entry.cache.accountId;
    if (snapshot.kind === "not_active") throw messageNotFound();
    if (snapshot.kind === "not_requested") {
      return contentState(accountId, messageId, "not_requested");
    }
    if (snapshot.kind === "fetching") {
      return contentState(accountId, messageId, "fetching");
    }
    if (snapshot.kind === "transient_failure") {
      return contentState(accountId, messageId, "transient");
    }
    if (snapshot.kind === "permanent_failure") {
      return contentState(accountId, messageId, "permanent");
    }
    try {
      const [textBody, htmlBody] = await Promise.all([
        readOptionalTextBlob(
          entry,
          snapshot.content,
          snapshot.content.text,
          this.readTime(),
        ),
        readOptionalTextBlob(
          entry,
          snapshot.content,
          snapshot.content.sanitizedHtml,
          this.readTime(),
        ),
      ]);
      return Object.freeze({
        apiVersion: 1 as const,
        accountId,
        messageId,
        state: "ready" as const,
        textBody,
        htmlBody,
        attachments: Object.freeze(
          snapshot.content.attachments.map(
            (attachment): MailContentAttachmentDto =>
              Object.freeze({
                attachmentId: attachment.attachmentId,
                filename: attachment.filename,
                mimeType: attachment.mimeType,
                disposition: attachment.disposition,
                contentId: attachment.contentId,
                bytes: attachment.blob.bytes,
              }),
          ),
        ),
      });
    } catch (error) {
      if (error instanceof BlobReadInvalidatedError) {
        return contentState(accountId, messageId, "transient");
      }
      throw error;
    }
  }

  private async withEntry<T>(
    accountId: string,
    operation: (entry: RegistryEntry) => Promise<T> | T,
  ): Promise<T> {
    let leased: RegistryEntry | null = null;
    const claim = async () => {
      if (this.closed) throw unavailable();
      if (this.invalidatedAccounts.has(accountId)) throw accountNotFound();
      const entry = await this.resolveUnlocked(accountId);
      entry.activeOperations += 1;
      leased = entry;
    };
    const run = this.resolutionTail.then(claim, claim);
    this.resolutionTail = settledTail(run);
    await run;
    if (leased === null) throw unavailable();
    const entry = leased as RegistryEntry;
    try {
      return await operation(entry);
    } catch (error) {
      throw contentServiceError(error);
    } finally {
      entry.activeOperations -= 1;
      if (entry.activeOperations === 0) {
        for (const resolve of entry.drained.splice(0)) resolve();
      }
    }
  }

  private async resolveUnlocked(accountId: string): Promise<RegistryEntry> {
    let account;
    try {
      account = await this.store.readAccount(accountId);
    } catch {
      throw unavailable();
    }
    if (account === null) {
      const stale = this.entries.get(accountId);
      if (stale) {
        await closeEntry(stale);
        this.entries.delete(accountId);
      }
      throw accountNotFound();
    }
    const current = this.entries.get(accountId);
    if (current) return current;
    const blobStore = new AtomicMailBlobStore({
      cacheRoot: this.cacheRoot,
      accountId,
    });
    const cache = new SqliteMailContentCache({
      cacheRoot: this.cacheRoot,
      accountId,
      blobStore,
      clock: this.clock,
      capacityReclaimer: this.capacityReclaimer,
    });
    try {
      await cache.initialize();
      const created: RegistryEntry = {
        cache,
        blobStore,
        lifecycle: new AbortController(),
        activeOperations: 0,
        drained: [],
      };
      this.entries.set(accountId, created);
      return created;
    } catch (error) {
      await cache.close().catch(() => undefined);
      await blobStore.close().catch(() => undefined);
      throw contentServiceError(error);
    }
  }

  /**
   * Opening a message is the owner's approval to fetch its images, and a
   * ready commit is the moment they become fetchable. Either starts the drain
   * now, detached from the response that noticed it, instead of leaving the
   * images to whichever scheduler pass next reaches this account. The drain
   * takes its own registry lease, so account teardown waits for it and the
   * entry's lifecycle abort stops it. One drain per message at a time: a
   * second open while it runs has nothing to add.
   */
  private startRemoteImageDrain(accountId: string, messageId: string): void {
    if (this.closed) return;
    const key = contentWorkKey(accountId, messageId);
    if (this.remoteImageDrains.has(key)) return;
    const drain = this.withEntry(accountId, (entry) =>
      this.drainRemoteImages(entry, messageId),
    )
      .catch(() => undefined)
      .finally(() => {
        if (this.remoteImageDrains.get(key) === drain) {
          this.remoteImageDrains.delete(key);
        }
      });
    this.remoteImageDrains.set(key, drain);
  }

  private async drainRemoteImages(
    entry: RegistryEntry,
    messageId: string,
  ): Promise<void> {
    const accountId = entry.cache.accountId;
    const signal = entry.lifecycle.signal;
    const pending = await entry.cache.listPendingRemoteImages(
      messageId,
      this.readTime(),
    );
    if (pending.length === 0) return;
    this.emit({
      event: "mail_remote_image_drain_started",
      accountId,
      attachmentCount: pending.length,
    });
    let taken = 0;
    try {
      for (const remoteImageId of pending) {
        if (signal.aborted || this.closed) break;
        const snapshot = await entry.cache.inspectRemoteImage(
          remoteImageId,
          this.readTime(),
        );
        if (snapshot === null || snapshot.state !== "pending") continue;
        taken += 1;
        try {
          await this.loadRemoteImage(entry, snapshot, signal);
        } catch {
          // The outcome is durable and already on record. One refused image
          // must not stop the rest of the message.
        }
      }
    } finally {
      this.emit({
        event: "mail_remote_image_drain_finished",
        accountId,
        attachmentCount: taken,
      });
    }
  }

  /** Observability must never change what the cache does. */
  private emit(event: MailContentCoordinatorEvent): void {
    if (this.onEvent === null) return;
    try {
      this.onEvent(event);
    } catch {
      // A failing observer is the observer's problem.
    }
  }

  /** An observer failure must never affect the request that noticed work. */
  private signalBackgroundWork(): void {
    if (this.onBackgroundWorkAvailable === null || this.closed) return;
    try {
      this.onBackgroundWorkAvailable();
    } catch {
      // The scheduler owns its own failure handling.
    }
  }

  private readTime(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }
}

/**
 * Cross-account reclaim is deliberately driven from the account registry. Any
 * unknown cache directory still counts toward capacity but is never deleted by
 * this path, so a damaged or disconnected account cannot cause us to remove
 * content whose ownership we cannot prove.
 */
class GlobalMailContentCapacityReclaimer
  implements MailContentCapacityReclaimer
{
  private readonly cacheRoot: string;
  private readonly store: MultiMailAccountStore;
  private readonly clock: () => number;

  constructor(options: {
    readonly cacheRoot: string;
    readonly store: MultiMailAccountStore;
    readonly clock: () => number;
  }) {
    this.cacheRoot = options.cacheRoot;
    this.store = options.store;
    this.clock = options.clock;
  }

  async reclaim(now: number, minimumBytes: number): Promise<void> {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(minimumBytes) ||
      minimumBytes < 0 ||
      minimumBytes > MAIL_RESOURCE_LIMITS.maxCacheBytes
    ) {
      throw unavailable();
    }
    let remainingBytes = minimumBytes;
    const accounts = await this.store.listAccounts();
    for (const account of [...accounts].sort((left, right) =>
      left.account.accountId.localeCompare(right.account.accountId),
    )) {
      const accountId = contentAccountId(account.account.accountId);
      const blobStore = new AtomicMailBlobStore({
        cacheRoot: this.cacheRoot,
        accountId,
      });
      const cache = new SqliteMailContentCache({
        cacheRoot: this.cacheRoot,
        accountId,
        blobStore,
        clock: this.clock,
      });
      try {
        await cache.initialize();
        const evicted =
          remainingBytes === 0
            ? []
            : await cache.evictReadyRemoteImages({
                minimumBytes: remainingBytes,
                now,
              });
        remainingBytes = Math.max(
          0,
          remainingBytes -
            evicted.reduce((total, descriptor) => total + descriptor.bytes, 0),
        );
        await cache.reapExpiredLeases(now);
        await cache.collectGarbage();
      } finally {
        await closeEntry({
          cache,
          blobStore,
          lifecycle: new AbortController(),
          activeOperations: 0,
          drained: [],
        });
      }
      if (minimumBytes > 0 && remainingBytes === 0) break;
    }
  }
}

class BlobReadInvalidatedError extends Error {}

async function readOptionalTextBlob(
  entry: RegistryEntry,
  snapshot: CachedMailContent,
  descriptor: MailBlobDescriptor | null,
  now: number,
): Promise<string | null> {
  if (descriptor === null) return null;
  let body: Buffer | null = null;
  try {
    body = await collectBlob(entry.blobStore, descriptor);
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    await invalidateBlobRead(entry, snapshot, descriptor, now);
    throw new BlobReadInvalidatedError();
  } finally {
    body?.fill(0);
  }
}

async function invalidateBlobRead(
  entry: RegistryEntry,
  snapshot:
    | CachedMailContent
    | {
        readonly accountId: string;
        readonly providerMessageId: string;
        readonly sourceGeneration: number;
        readonly version: number;
        readonly contentFormatVersion: number;
      },
  descriptor: MailBlobDescriptor,
  now: number,
): Promise<void> {
  try {
    await entry.cache.invalidateReady({
      accountId: snapshot.accountId,
      providerMessageId: snapshot.providerMessageId,
      sourceGeneration: snapshot.sourceGeneration,
      version: snapshot.version,
      contentFormatVersion: snapshot.contentFormatVersion,
      failedBlob: descriptor,
      errorCode: "blob_read_failed",
      now,
    });
  } catch {
    throw unavailable();
  }
}

async function collectBlob(
  blobStore: AtomicMailBlobStore,
  descriptor: MailBlobDescriptor,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of blobStore.read(descriptor)) {
      total += chunk.byteLength;
      if (total > descriptor.bytes) throw unavailable();
      chunks.push(Buffer.from(chunk));
    }
    if (total !== descriptor.bytes) throw unavailable();
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

async function closeEntry(entry: RegistryEntry): Promise<void> {
  entry.lifecycle.abort(unavailable());
  let firstError: unknown;
  try {
    await entry.cache.close();
  } catch (error) {
    firstError = error;
  }
  try {
    await entry.blobStore.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

function contentState(
  accountId: string,
  messageId: string,
  state: "not_requested" | "fetching" | "transient" | "permanent",
): MailMessageContent {
  return Object.freeze({ apiVersion: 1, accountId, messageId, state });
}

function workFailure(error: unknown): MailContentWorkError {
  return error instanceof MailContentWorkError
    ? error
    : new MailContentWorkError("transient", "content_worker_failed");
}

function contentServiceError(error: unknown): MailContentServiceError {
  if (error instanceof MailContentServiceError) return error;
  if (error instanceof MailAccountError && error.code === "account_not_found") {
    return accountNotFound();
  }
  if (error instanceof MailContentCacheError) {
    if (error.code === "mail_content_request_invalid") return requestInvalid();
    return unavailable();
  }
  return unavailable();
}

function contentWorkKey(accountId: string, providerMessageId: string): string {
  return `${accountId}:${providerMessageId}`;
}

/** A caller joining a fetch it does not own still leaves when told to. */
function joinAbortable(
  work: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(unavailable());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(unavailable());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function remoteImageRefusal(
  errorCode: string,
): "blocked" | "origin_refused" | "budget_exhausted" {
  if (errorCode === "remote_image_origin_rejected") return "origin_refused";
  if (
    errorCode === "remote_image_budget_exceeded" ||
    errorCode === "mail_content_remote_image_budget_exhausted"
  ) {
    return "budget_exhausted";
  }
  return "blocked";
}

/** Coarse enough that a retry time never dates a message. */
function durationBucket(ms: number): string {
  if (ms < 60_000) return "under_1m";
  if (ms < 10 * 60_000) return "under_10m";
  if (ms < 60 * 60_000) return "under_1h";
  return "over_1h";
}

function contentAccountId(value: unknown): string {
  try {
    return validateMailContentAccountId(value);
  } catch {
    throw requestInvalid();
  }
}

function contentMessageId(value: unknown): string {
  try {
    return validateMailContentMessageId(value);
  } catch {
    throw requestInvalid();
  }
}

function contentAttachmentId(value: unknown): string {
  try {
    return validateMailContentAttachmentId(value);
  } catch {
    throw requestInvalid();
  }
}

function contentRemoteImageId(value: unknown): string {
  try {
    return validateMailContentRemoteImageId(value);
  } catch {
    throw requestInvalid();
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw requestInvalid();
  return value;
}

function complete(): MailContentQueueRunResult {
  return Object.freeze({ kind: "complete" as const });
}

function retryAt(notBefore: number): MailContentQueueRunResult {
  if (!Number.isSafeInteger(notBefore) || notBefore < 0) throw unavailable();
  return Object.freeze({ kind: "retry" as const, notBefore });
}

function backgroundPrefetchComplete(): MailBackgroundContentPrefetchResult {
  return Object.freeze({ hasMore: false });
}

function settledTail<T>(promise: Promise<T>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function requestInvalid(): MailContentServiceError {
  return new MailContentServiceError("mail_content_request_invalid");
}

function accountNotFound(): MailContentServiceError {
  return new MailContentServiceError("mail_content_account_not_found");
}

function messageNotFound(): MailContentServiceError {
  return new MailContentServiceError("mail_content_message_not_found");
}

function attachmentNotFound(): MailContentServiceError {
  return new MailContentServiceError("mail_content_attachment_not_found");
}

function remoteImageNotFound(): MailContentServiceError {
  return new MailContentServiceError("mail_content_remote_image_not_found");
}

function unavailable(): MailContentServiceError {
  return new MailContentServiceError("mail_content_unavailable");
}
