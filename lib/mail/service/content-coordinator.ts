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
  MAIL_PARSER_FAILURE_CODES,
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
const MAX_CONCURRENT_REMOTE_IMAGE_DRAINS = 2;
/** Bodies one account's prefetch keeps claimed at a time, queued or running. */
const MAX_BACKGROUND_FETCHES_PER_ACCOUNT = 2;
/**
 * The least time between two prefetch fetches on one IMAP account. Every
 * fetch there is a session of its own, DNS to LOGIN, so two hundred bodies at
 * full speed would be two hundred logins in a few minutes against a host that
 * may count them. Paced, the first fill takes about seventeen minutes and
 * makes twelve logins a minute at most; afterwards only new mail is fetched.
 * Batching bodies into one session would save the logins themselves, but it
 * belongs in the session factory, which IMAP IDLE is reshaping.
 */
const IMAP_PREFETCH_SPACING_MS = 5_000;

export type MailContentServiceErrorCode =
  | "mail_content_request_invalid"
  | "mail_content_account_not_found"
  | "mail_content_message_not_found"
  | "mail_content_attachment_not_found"
  | "mail_content_remote_image_not_found"
  | "mail_content_remote_image_refused"
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
  | { readonly kind: "retry"; readonly notBefore: number }
  /**
   * Prefetch work that chose to wait without trying, such as its pacing on an
   * account where every fetch is a login. It is the prefetch's own wait: work
   * an owner has taken over runs again at once.
   */
  | { readonly kind: "deferred"; readonly notBefore: number };

export interface MailContentQueueTask {
  readonly accountId: string;
  readonly providerMessageId: string;
  /**
   * Work nobody is waiting for: the body prefetch. It runs behind every
   * owner request and in one worker slot at most, and an owner asking for the
   * same message moves it into the owner's lane (`promote`).
   */
  readonly background?: boolean;
  /** Called once when the queue lets go of the task, however it ended. */
  readonly onSettled?: () => void;
  run(
    signal: AbortSignal,
    lane: { readonly background: boolean },
  ): Promise<MailContentQueueRunResult>;
}

export interface MailContentWorkQueuePort {
  has(accountId: string, providerMessageId: string): boolean;
  enqueue(task: MailContentQueueTask): "queued" | "coalesced";
  /** Moves this message's background work into the owner's lane. */
  promote(accountId: string, providerMessageId: string): void;
  /** Background work this account has queued, waiting or running. */
  backgroundCount(accountId: string): number;
  /** All of this account's work queued, waiting or running, whoever it is for. */
  workCount(accountId: string): number;
  /** Aborts and drops all background work and refuses more until resumed. */
  abortAndDrainBackground(): Promise<void>;
  resumeBackground(): void;
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

/** The messages a live draft answers or forwards, whose bodies stay put. */
export interface MailContentDraftSourcePort {
  listDraftSourceMessageIds(accountId: string): Promise<readonly string[]>;
}

/**
 * The image pipeline's own record, for the service's stdout stream. Payloads
 * stay inside the section 13 allowlist: a drain starts with the images it
 * means to take and finishes with the ones it attempted, which differ when
 * teardown cut it short or another path settled an image first; a fetched
 * image reports the bytes it added to the cache. A transient retry is always
 * one interval away, so the record does not repeat it. Nothing here names a
 * URL, a host or an image id.
 */
export type MailContentCoordinatorEvent =
  | Readonly<{
      event: "mail_remote_image_drain_started";
      accountId: string;
      remoteImageCount: number;
    }>
  | Readonly<{
      event: "mail_remote_image_drain_finished";
      accountId: string;
      remoteImageAttemptCount: number;
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
    }>;

interface QueueEntry {
  readonly key: string;
  readonly task: MailContentQueueTask;
  controller: AbortController;
  readonly drained: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  queued: boolean;
  running: boolean;
  /** Still prefetch work: no owner has asked for this message. */
  background: boolean;
  /** Holds the one worker slot prefetch work may use. */
  runningBackground: boolean;
  /**
   * Aborted and still winding down in its slot; it goes back in line once it
   * has, unless it is dropped meanwhile.
   */
  winding: boolean;
  /** A drain, a pause or the close ended it for good. */
  dropped: boolean;
  settled: boolean;
}

/**
 * Prefetch work never holds more than this many of the parser slots, so an
 * owner opening a message always finds one free unless another owner request
 * holds it.
 */
const MAX_BACKGROUND_WORKERS = MAIL_RESOURCE_LIMITS.concurrentMimeParsers - 1;

/**
 * Process-local content queue. Durable truth remains in SqliteMailContentCache.
 * Two lanes feed the same parser slots: an owner's request always starts
 * before queued prefetch work, and prefetch work takes one slot at most. When
 * an owner's request would still wait, because the other slot is an owner's
 * too, the running prefetch gives up its slot: it is aborted, and once its run
 * has wound down the slot passes on and the prefetch goes back in line. The
 * parser socket accepts two connections, the same two, so this is also what
 * keeps a second letter the owner opens from waiting on a letter nobody asked
 * for.
 */
export class InMemoryMailContentWorkQueue implements MailContentWorkQueuePort {
  private readonly clock: () => number;
  private readonly maxPending: number;
  private readonly entries = new Map<string, QueueEntry>();
  private readonly ownerPending: QueueEntry[] = [];
  private readonly backgroundPending: QueueEntry[] = [];
  private readonly invalidatedAccounts = new Set<string>();
  private active = 0;
  private activeBackground = 0;
  private backgroundStopped = false;
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
    if (
      typeof task.run !== "function" ||
      (task.onSettled !== undefined && typeof task.onSettled !== "function") ||
      (task.background === true && this.backgroundStopped) ||
      this.closed
    ) {
      throw unavailable();
    }
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
      background: task.background === true,
      runningBackground: false,
      winding: false,
      dropped: false,
      settled: false,
    };
    this.entries.set(key, entry);
    this.laneOf(entry).push(entry);
    queueMicrotask(() => this.pump());
    return "queued";
  }

  promote(accountIdInput: string, providerMessageIdInput: string): void {
    const accountId = contentAccountId(accountIdInput);
    const entry = this.entries.get(
      contentWorkKey(accountId, contentMessageId(providerMessageIdInput)),
    );
    if (entry === undefined || !entry.background) return;
    if (entry.dropped) {
      // Only the pause drops work whose account is still here. What the owner
      // asks for is not the pause's to stop: it runs again as the owner's
      // once this run has wound down, and the pause stops waiting for it.
      if (this.closed || this.invalidatedAccounts.has(accountId)) return;
      entry.dropped = false;
      entry.winding = entry.running;
      for (const resolve of entry.drained.splice(0)) resolve();
    }
    entry.background = false;
    if (entry.running && entry.runningBackground) {
      // The owner's own letter no longer counts as prefetch work, so it is
      // never the one given up for the owner's next letter.
      entry.runningBackground = false;
      this.activeBackground -= 1;
    }
    if (entry.queued) {
      removeFrom(this.backgroundPending, entry);
      this.ownerPending.push(entry);
    } else if (entry.timer !== null) {
      // A prefetch waiting out its pacing or a retry has an owner now, and an
      // owner does not wait for the prefetch's clock.
      clearTimeout(entry.timer);
      entry.timer = null;
      this.queuePending(entry);
      return;
    }
    this.pump();
  }

  backgroundCount(accountIdInput: string): number {
    const accountId = contentAccountId(accountIdInput);
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.background && entry.task.accountId === accountId) total += 1;
    }
    return total;
  }

  workCount(accountIdInput: string): number {
    const accountId = contentAccountId(accountIdInput);
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.task.accountId === accountId) total += 1;
    }
    return total;
  }

  async abortAndDrainAccount(accountIdInput: string): Promise<void> {
    const accountId = contentAccountId(accountIdInput);
    this.invalidatedAccounts.add(accountId);
    await this.dropAndDrain(
      (entry) => entry.task.accountId === accountId,
      new MailContentServiceError("mail_content_account_not_found"),
    );
  }

  async abortAndDrainBackground(): Promise<void> {
    this.backgroundStopped = true;
    await this.dropAndDrain((entry) => entry.background, unavailable());
  }

  resumeBackground(): void {
    if (this.closed) return;
    this.backgroundStopped = false;
  }

  private async dropAndDrain(
    matches: (entry: QueueEntry) => boolean,
    reason: Error,
  ): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const entry of [...this.entries.values()]) {
      if (!matches(entry)) continue;
      entry.dropped = true;
      entry.controller.abort(reason);
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
    entry.runningBackground = entry.background;
    if (entry.runningBackground) this.activeBackground += 1;
    // Read when asked: an owner can take the work over while it runs.
    const lane = Object.freeze({
      get background() {
        return entry.runningBackground;
      },
    });
    void Promise.resolve()
      .then(() => entry.task.run(entry.controller.signal, lane))
      .then(
        (result) => this.onResult(entry, result),
        () => this.onRejected(entry),
      );
  }

  private onResult(entry: QueueEntry, result: MailContentQueueRunResult): void {
    this.releaseActive(entry);
    if (entry.winding) {
      this.onWound(entry);
      return;
    }
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
      (result.kind !== "retry" && result.kind !== "deferred") ||
      !Number.isSafeInteger(result.notBefore) ||
      result.notBefore < 0
    ) {
      this.finish(entry);
      this.pump();
      return;
    }
    if (result.kind === "deferred" && !entry.background) {
      // An owner took this over while the prefetch was deciding to wait.
      this.queuePending(entry);
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
    if (entry.winding) {
      this.onWound(entry);
      return;
    }
    this.finish(entry);
    this.pump();
  }

  /**
   * A prefetch that gave its slot to an owner has finished winding down. It
   * goes back to the head of the line with a fresh signal, in whichever lane
   * it now belongs to, since it was first in line when it was displaced,
   * unless a drain, the pause or the close ended it meanwhile.
   */
  private onWound(entry: QueueEntry): void {
    entry.winding = false;
    if (entry.dropped || this.closed || this.entries.get(entry.key) !== entry) {
      this.finish(entry);
      this.pump();
      return;
    }
    entry.controller = new AbortController();
    this.queuePending(entry, true);
  }

  /**
   * When an owner's request would wait and a prefetch holds a slot, the
   * prefetch is aborted. It keeps the slot until its run has let go of the
   * provider and the parser: the parser socket counts a connection until its
   * worker exits, and one slot freed early let a third connection in, which
   * the socket dropped, failing the owner's letter it was meant to speed up.
   */
  private preemptForOwner(): void {
    if (
      this.closed ||
      this.ownerPending.length === 0 ||
      this.active < MAIL_RESOURCE_LIMITS.concurrentMimeParsers
    ) {
      return;
    }
    for (const entry of this.entries.values()) {
      if (!entry.running || !entry.runningBackground || entry.winding) continue;
      entry.winding = true;
      entry.controller.abort(unavailable());
      return;
    }
  }

  private queuePending(entry: QueueEntry, first = false): void {
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
      if (first) this.laneOf(entry).unshift(entry);
      else this.laneOf(entry).push(entry);
    }
    this.pump();
  }

  private pump(): void {
    while (
      !this.closed &&
      this.active < MAIL_RESOURCE_LIMITS.concurrentMimeParsers
    ) {
      let entry = this.ownerPending.shift();
      if (entry === undefined) {
        if (this.activeBackground >= MAX_BACKGROUND_WORKERS) break;
        entry = this.backgroundPending.shift();
        if (entry === undefined) break;
      }
      entry.queued = false;
      this.start(entry);
    }
    this.preemptForOwner();
  }

  private laneOf(entry: QueueEntry): QueueEntry[] {
    return entry.background ? this.backgroundPending : this.ownerPending;
  }

  private releaseActive(entry: QueueEntry): void {
    if (!entry.running) return;
    entry.running = false;
    this.active -= 1;
    if (entry.runningBackground) {
      entry.runningBackground = false;
      this.activeBackground -= 1;
    }
    if (this.active < 0 || this.activeBackground < 0) {
      this.active = Math.max(0, this.active);
      this.activeBackground = Math.max(0, this.activeBackground);
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
      removeFrom(this.ownerPending, entry);
      removeFrom(this.backgroundPending, entry);
      entry.queued = false;
    }
    entry.running = false;
    entry.winding = false;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    for (const resolve of entry.drained.splice(0)) resolve();
    if (entry.settled) return;
    entry.settled = true;
    try {
      entry.task.onSettled?.();
    } catch {
      // The listener's failure is its own; the queue has already let go.
    }
  }
}

function removeFrom(lane: QueueEntry[], entry: QueueEntry): void {
  const index = lane.indexOf(entry);
  if (index >= 0) lane.splice(index, 1);
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

/** What a fill may claim: see `readClaimPolicy`. */
interface BackgroundClaimPolicy {
  readonly claim: boolean;
  readonly newerThan: number | null;
  /** What the account can take before it reaches the budget. */
  readonly roomBytes: number;
}

interface RemoteImageDrain {
  /** Settles once the drain has let go of its slot and every image. */
  readonly done: Promise<void>;
  readonly controller: AbortController;
  /** Started by a prefetch commit and not yet asked for by an open. */
  background: boolean;
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
  private readonly onContentReady: ((accountId: string, messageId: string) => void) | null;
  private readonly clock: () => number;
  private readonly capacityReclaimer: MailContentCapacityReclaimer;
  private readonly remoteImageFetcher: RemoteImageFetcherPort;
  private readonly remoteImageFetches = new Map<string, Promise<void>>();
  private readonly remoteImageMessageTails = new Map<string, Promise<void>>();
  private readonly remoteImageDrains = new Map<string, RemoteImageDrain>();
  private readonly remoteImageDrainWaiters: Array<() => void> = [];
  private activeRemoteImageDrains = 0;
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly invalidatedAccounts = new Set<string>();
  private readonly bodyCacheMaxBytes: number;
  private readonly imapPrefetchSpacingMs: number;
  private readonly draftSources: MailContentDraftSourcePort | null;
  private readonly backgroundFillTails = new Map<string, Promise<void>>();
  private readonly lastImapPrefetchAt = new Map<string, number>();
  private readonly leaseReleases = new Set<Promise<void>>();
  private resolutionTail: Promise<void> = Promise.resolve();
  private backgroundStopped = false;
  private closed = false;

  /*
   * The prefetch takes no fetch stream from the download routes' ledger. It
   * did once, and the reader's pictures, which ask for two streams at once,
   * then found one taken for the whole of a fetch and gave up on the second.
   * The prefetch's own bound is its single worker slot in the queue.
   */
  constructor(options: {
    readonly stateDirectory: string;
    readonly store: MultiMailAccountStore;
    readonly runner: MailContentWorkRunnerPort;
    readonly queue?: MailContentWorkQueuePort;
    readonly retryPolicy?: MailContentRetryPolicyPort;
    readonly remoteImageFetcher?: RemoteImageFetcherPort;
    /** Per account; `MAIL_RESOURCE_LIMITS.bodyCacheMaxBytes` unless a test sets it. */
    readonly bodyCacheMaxBytes?: number;
    /** `IMAP_PREFETCH_SPACING_MS` unless a test sets it. */
    readonly imapPrefetchSpacingMs?: number;
    readonly draftSources?: MailContentDraftSourcePort;
    readonly onBackgroundWorkAvailable?: () => void;
    readonly onEvent?: (event: MailContentCoordinatorEvent) => void;
    /** Each ready commit, for the change feed: a reader waiting on this
     *  message fetches once instead of polling for it. */
    readonly onContentReady?: (accountId: string, messageId: string) => void;
    readonly clock?: () => number;
  }) {
    if (
      !path.isAbsolute(options.stateDirectory) ||
      path.resolve(options.stateDirectory) !== options.stateDirectory ||
      typeof options.runner?.run !== "function" ||
      (options.remoteImageFetcher !== undefined &&
        typeof options.remoteImageFetcher.fetch !== "function") ||
      (options.bodyCacheMaxBytes !== undefined &&
        (!Number.isSafeInteger(options.bodyCacheMaxBytes) ||
          options.bodyCacheMaxBytes < 0 ||
          options.bodyCacheMaxBytes > MAIL_RESOURCE_LIMITS.bodyCacheMaxBytes)) ||
      (options.imapPrefetchSpacingMs !== undefined &&
        (!Number.isSafeInteger(options.imapPrefetchSpacingMs) ||
          options.imapPrefetchSpacingMs < 0 ||
          options.imapPrefetchSpacingMs > 24 * 60 * 60 * 1_000)) ||
      (options.draftSources !== undefined &&
        typeof options.draftSources.listDraftSourceMessageIds !== "function") ||
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
    this.bodyCacheMaxBytes =
      options.bodyCacheMaxBytes ?? MAIL_RESOURCE_LIMITS.bodyCacheMaxBytes;
    this.imapPrefetchSpacingMs =
      options.imapPrefetchSpacingMs ?? IMAP_PREFETCH_SPACING_MS;
    this.draftSources = options.draftSources ?? null;
    this.onBackgroundWorkAvailable = options.onBackgroundWorkAvailable ?? null;
    this.onEvent = options.onEvent ?? null;
    this.onContentReady = options.onContentReady ?? null;
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
        this.startRemoteImageDrain(accountId, messageId, false);
        return this.projectSnapshot(entry, messageId, snapshot);
      }
      // Only work this process has in flight short-circuits, and it becomes
      // the owner's, so it no longer waits behind the rest of the prefetch.
      // Anything else re-claims now: a background start whose content never
      // landed (a transient failure waiting out its retry window, a row a
      // format or generation change invalidated) and a row still marked
      // fetching by a process that has stopped.
      if (snapshot.kind === "fetching" && this.queue.has(accountId, messageId)) {
        this.queue.promote(accountId, messageId);
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
      this.queue.promote(accountId, messageId);
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
    await this.enqueueClaimed(entry, accountId, messageId, claim.lease, false);
    return contentState(accountId, messageId, "fetching");
  }

  /**
   * The prefetch's own claim: true when it queued a fetch. Unlike an owner's
   * request it answers nothing, so a body that turns out ready is not read.
   */
  private async startBackgroundFetch(
    entry: RegistryEntry,
    accountId: string,
    messageId: string,
  ): Promise<boolean> {
    if (this.queue.has(accountId, messageId)) return false;
    const claim = await entry.cache.claim(messageId, this.readTime());
    if (claim.kind !== "claimed") return false;
    if (this.backgroundStopped) {
      // The pause came while this claim was being made: give it back.
      await entry.cache.voidLease(claim.lease).catch(() => undefined);
      return false;
    }
    await this.enqueueClaimed(entry, accountId, messageId, claim.lease, true);
    return true;
  }

  private async enqueueClaimed(
    entry: RegistryEntry,
    accountId: string,
    messageId: string,
    claimedLease: MailContentLease,
    background: boolean,
  ): Promise<void> {
    let firstLease: MailContentLease | null = claimedLease;
    let attempt = 0;
    try {
      this.queue.enqueue({
        accountId,
        providerMessageId: messageId,
        background,
        // Each prefetch that lets go claims the next one for its account, so
        // the pipeline refills itself instead of waking the whole scheduler,
        // whose pass would visit every account to find it. One dropped before
        // its fetch began, by the pause or while it waited for its turn,
        // gives its claim back first.
        ...(background
          ? {
              onSettled: () => {
                const unused = firstLease;
                firstLease = null;
                if (unused !== null) this.releaseUnusedLease(accountId, unused);
                this.refillBackgroundPrefetch(accountId);
              },
            }
          : {}),
        run: async (signal, lane) => {
          if (lane.background) {
            // The claimed lease is kept for the turn this waits for.
            const turnAt = await this.imapPrefetchTurn(accountId);
            if (turnAt !== null) return deferredUntil(turnAt);
          }
          const lease = firstLease;
          firstLease = null;
          return this.runQueuedAttempt({
            accountId,
            messageId,
            lease,
            signal,
            lane,
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
          lease: claimedLease,
          kind: "transient",
          errorCode,
          now: this.readTime(),
        })
        .catch(() => undefined);
      throw contentServiceError(error);
    }
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
      // A refusal is an answer of its own: the reader must be able to tell
      // an image the cache gave up on from a row it does not have, since
      // only the second is worth asking for again.
      if (snapshot.state === "permanent_failure") throw remoteImageRefused();
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
    if (signal.aborted || this.closed || this.backgroundStopped) {
      return backgroundPrefetchComplete();
    }

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
      if ((await this.fillBackgroundPrefetch(entry, accountId)) > 0) {
        return Object.freeze({ kind: "worked" as const });
      }
      return Object.freeze({ kind: "complete" as const });
    });
    if (selection.kind === "complete") return backgroundPrefetchComplete();
    return Object.freeze({ hasMore: true });
  }

  /**
   * Brings the account under the byte budget, then claims cohort bodies for
   * the prefetch until the account has `MAX_BACKGROUND_FETCHES_PER_ACCOUNT` in
   * flight, and answers how many it claimed. A scheduler step calls it, and so
   * does every prefetch that lets go, which is what carries the cohort forward
   * between steps and keeps the budget checked after every body that lands.
   * One call claims two at most, so a cache that has just grown its cohort
   * fills it at that pace rather than all at once. Calls for one account take
   * turns, or two of them could each see room for the same slot. The pause
   * is checked before every claim, the budget before the first: an account
   * with two in flight is left alone until one lands.
   */
  private fillBackgroundPrefetch(
    entry: RegistryEntry,
    accountId: string,
  ): Promise<number> {
    const previous = this.backgroundFillTails.get(accountId) ?? Promise.resolve();
    const run = previous.then(async () => {
      let policy: BackgroundClaimPolicy | null = null;
      let roomBytes = 0;
      let claimed = 0;
      for (
        let round = 0;
        round < MAX_BACKGROUND_FETCHES_PER_ACCOUNT &&
        !this.closed &&
        !this.backgroundStopped &&
        this.queue.backgroundCount(accountId) < MAX_BACKGROUND_FETCHES_PER_ACCOUNT;
        round += 1
      ) {
        if (policy === null) {
          policy = await this.readClaimPolicy(entry, accountId);
          // A body still on its way is not in the byte count yet, so the room
          // holds only while none is, the owner's or the prefetch's: a fill
          // beside one would fetch a body back into room it is about to
          // take, then evict it.
          roomBytes = this.queue.workCount(accountId) === 0 ? policy.roomBytes : 0;
        }
        if (!policy.claim) break;
        const candidate = await entry.cache.findBackgroundContentCandidate(
          this.readTime(),
          policy.newerThan,
          roomBytes,
        );
        if (candidate === null) break;
        await entry.cache.markBackgroundContentPrefetchStarted(
          candidate.messageId,
          this.readTime(),
        );
        if (await this.startBackgroundFetch(entry, accountId, candidate.messageId)) {
          claimed += 1;
          roomBytes = Math.max(0, roomBytes - candidate.estimatedBytes);
        }
      }
      return claimed;
    });
    const tail = settledTail(run);
    this.backgroundFillTails.set(accountId, tail);
    void tail.then(() => {
      if (this.backgroundFillTails.get(accountId) === tail) {
        this.backgroundFillTails.delete(accountId);
      }
    });
    return run;
  }

  /**
   * Holds the account to the byte budget and says what the prefetch may claim
   * next. Under the budget, anything, and the room left lets an evicted body
   * back in once it fits (`findBackgroundContentCandidate`). At it, only a
   * letter newer than the body the budget would give up next, since anything
   * older would be that body. The drafts are asked only once the account is
   * at the budget, since asking writes to the outbox. When they cannot
   * answer, nothing is evicted and nothing is claimed: a body a draft needs
   * is worth more than a prefetch.
   */
  private async readClaimPolicy(
    entry: RegistryEntry,
    accountId: string,
  ): Promise<BackgroundClaimPolicy> {
    const bytes = await entry.cache.readBodyCacheBytes();
    if (bytes < this.bodyCacheMaxBytes) {
      return claimUnderBudget(this.bodyCacheMaxBytes - bytes);
    }
    let pinnedMessageIds: readonly string[] = [];
    if (this.draftSources !== null) {
      try {
        pinnedMessageIds = (
          await this.draftSources.listDraftSourceMessageIds(accountId)
        ).filter(isContentMessageId);
      } catch {
        return Object.freeze({ claim: false, newerThan: null, roomBytes: 0 });
      }
    }
    const result = await entry.cache.evictBodiesOverBudget({
      maxBytes: this.bodyCacheMaxBytes,
      now: this.readTime(),
      pinnedMessageIds,
    });
    if (result.evictedMessages > 0) await entry.cache.collectGarbage();
    if (result.remainingBytes < this.bodyCacheMaxBytes) {
      return claimUnderBudget(this.bodyCacheMaxBytes - result.remainingBytes);
    }
    return Object.freeze({
      claim: result.oldestKeptKey !== null,
      newerThan: result.oldestKeptKey,
      roomBytes: 0,
    });
  }

  /** Detached; the pause waits for it, so a resume finds the claim free. */
  private releaseUnusedLease(accountId: string, lease: MailContentLease): void {
    if (this.closed) return;
    const release = this.withEntry(accountId, (entry) =>
      voidAbandonedLease(entry, lease),
    )
      .catch(() => undefined)
      .finally(() => this.leaseReleases.delete(release));
    this.leaseReleases.add(release);
  }

  /**
   * Detached: a failed refill waits for the account's next scheduler step.
   * The fill itself answers the pause and the close.
   */
  private refillBackgroundPrefetch(accountId: string): void {
    void this.withEntry(accountId, (entry) =>
      this.fillBackgroundPrefetch(entry, accountId),
    ).catch(() => undefined);
  }

  /**
   * Null when a prefetch on this account may fetch now, or the time its turn
   * comes. Only an IMAP account waits (`IMAP_PREFETCH_SPACING_MS`), and only
   * the prefetch: an owner's fetch never asks.
   */
  private async imapPrefetchTurn(accountId: string): Promise<number | null> {
    let account;
    try {
      account = await this.store.readAccount(accountId);
    } catch {
      return null;
    }
    if (account?.providerKind !== "imap") return null;
    const now = this.readTime();
    const previous = this.lastImapPrefetchAt.get(accountId);
    if (previous !== undefined && now < previous + this.imapPrefetchSpacingMs) {
      return previous + this.imapPrefetchSpacingMs;
    }
    this.lastImapPrefetchAt.set(accountId, now);
    return null;
  }

  /**
   * The Mail switch's stop for the prefetch: nothing more is claimed, and
   * prefetch work queued, waiting or running is aborted and dropped, along
   * with the image drains prefetch commits started. A body whose fetch it
   * stopped reads as never fetched and is claimed again on resume, and an
   * image it stopped stays pending for the scheduler. Owner work is
   * untouched.
   */
  async stopBackgroundPrefetch(): Promise<void> {
    this.backgroundStopped = true;
    const drains = [...this.remoteImageDrains.values()].filter(
      (drain) => drain.background,
    );
    for (const drain of drains) drain.controller.abort(unavailable());
    await this.queue.abortAndDrainBackground();
    await Promise.all([
      ...this.backgroundFillTails.values(),
      ...this.leaseReleases,
      ...drains.map((drain) => drain.done),
    ]);
  }

  startBackgroundPrefetch(): void {
    if (this.closed) return;
    this.backgroundStopped = false;
    this.queue.resumeBackground();
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
      if (liveSnapshot.state === "permanent_failure") throw remoteImageRefused();
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
        await entry.cache
          .markRemoteImageFailure({
            snapshot: liveSnapshot,
            kind,
            ...(kind === "transient"
              ? {
                  retryAt:
                    now + MAIL_RESOURCE_LIMITS.remoteImageTransientRetryMs,
                }
              : {}),
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
              }
            : {
                event: "mail_remote_image_settled",
                accountId: snapshot.accountId,
                phase: remoteImageRefusal(errorCode),
                errorCode,
              },
        );
        if (kind === "permanent") throw remoteImageRefused();
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
    /** Prefetch work until an owner takes it over, which can happen mid-run. */
    readonly lane: { readonly background: boolean };
    readonly nextAttempt: () => number;
  }): Promise<MailContentQueueRunResult> {
    if (this.closed) return complete();
    try {
      return await this.withEntry(input.accountId, async (entry) => {
        let lease = input.lease;
        if (input.signal.aborted) {
          await voidAbandonedLease(entry, lease);
          return complete();
        }
        // A prefetch can wait behind owner work and its pacing for longer
        // than its lease lives. An expired lease is claimed afresh rather than
        // run into a commit the cache would refuse.
        if (lease !== null && lease.expiresAt <= this.readTime()) lease = null;
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
          // A prefetch does not wake it: two hundred bodies would be two
          // hundred passes over every account for nothing, since the
          // prefetch claims its own next body, and the scheduler's own
          // interval already covers what a drain leaves behind. The change
          // feed hears of every ready body, the prefetch's too: a reader
          // waiting on a letter the prefetch lands fetches it at once.
          const background = input.lane.background;
          this.startRemoteImageDrain(input.accountId, input.messageId, background);
          if (!background) this.signalBackgroundWork();
          this.signalContentReady(input.accountId, input.messageId);
          return complete();
        } catch (error) {
          if (input.signal.aborted || this.closed) {
            // Stopped for an owner, the pause or a teardown, not failed: the
            // lease is voided, so whoever comes next claims the body at once
            // instead of waiting out this one.
            await voidAbandonedLease(entry, lease);
            return complete();
          }
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
          // A letter that brought the parser down may do so every time, so
          // nobody's attempt at it is retried: the prefetch leaves it for an
          // open, and an open leaves it for the next open. The runner has
          // already parsed it up to three times in this one attempt. The
          // queue's four attempts made that twelve parser processes an ask,
          // and the reader asks three times an open.
          if (MAIL_PARSER_FAILURE_CODES.includes(failure.errorCode)) {
            return complete();
          }
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
      // A parser-caused failure is not retried on its own (see
      // `runQueuedAttempt`), so to whoever polls it is final: `transient`
      // would tell the reader the service is between retries, and it would
      // ask again, three times an open. The row stays a transient failure,
      // which is what lets the next open claim it and try once more.
      return contentState(
        accountId,
        messageId,
        MAIL_PARSER_FAILURE_CODES.includes(snapshot.errorCode)
          ? "permanent"
          : "transient",
      );
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
      // No work of this process holds a lease on this account yet, so any
      // lease still live belongs to a process that stopped mid-fetch, and any
      // body half received is one it was streaming.
      await cache.voidInterruptedLeases();
      await blobStore.removeIncomingFiles();
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
   *
   * A drain a prefetch commit started is the prefetch's, and the Mail switch
   * stops it with the rest of the prefetch (`stopBackgroundPrefetch`). An
   * open while it runs takes it out of the pause's reach and runs a drain of
   * the owner's own after it, since the prefetch's drain listed only the
   * images the prefetch may fetch, and may have been stopped already.
   */
  private startRemoteImageDrain(
    accountId: string,
    messageId: string,
    background: boolean,
  ): void {
    if (this.closed || (background && this.backgroundStopped)) return;
    const key = contentWorkKey(accountId, messageId);
    const existing = this.remoteImageDrains.get(key);
    if (existing !== undefined) {
      if (background || !existing.background) return;
      existing.background = false;
      void existing.done.then(() =>
        this.startRemoteImageDrain(accountId, messageId, false),
      );
      return;
    }
    const controller = new AbortController();
    const drain = (async () => {
      if (!(await this.acquireRemoteImageDrainSlot(controller.signal))) return;
      try {
        await this.withEntry(accountId, (entry) =>
          this.drainRemoteImages(entry, messageId, controller.signal),
        );
      } catch {
        // Each image's outcome is on record; the drain itself answers no one.
      } finally {
        this.releaseRemoteImageDrainSlot();
      }
    })().finally(() => {
      if (this.remoteImageDrains.get(key)?.done === drain) {
        this.remoteImageDrains.delete(key);
      }
    });
    this.remoteImageDrains.set(key, { done: drain, controller, background });
  }

  /**
   * Drains are per message and the reader opens a thread's messages
   * together, so without a ceiling a long thread would dial that many
   * origins at once, each able to buffer a message's whole image budget.
   * Two: before the drain existed the process dialed one origin at a time,
   * one more lets a slow origin hold up only itself, and it matches the
   * parser and reader concurrency on either side of it. A freed slot passes
   * straight to the next waiter, in arrival order. A drain stopped while it
   * waits leaves the line and takes no slot: false.
   */
  private acquireRemoteImageDrainSlot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.activeRemoteImageDrains < MAX_CONCURRENT_REMOTE_IMAGE_DRAINS) {
      this.activeRemoteImageDrains += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const index = this.remoteImageDrainWaiters.indexOf(waiter);
        if (index >= 0) this.remoteImageDrainWaiters.splice(index, 1);
        resolve(false);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.remoteImageDrainWaiters.push(waiter);
    });
  }

  private releaseRemoteImageDrainSlot(): void {
    const next = this.remoteImageDrainWaiters.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.activeRemoteImageDrains -= 1;
  }

  private async drainRemoteImages(
    entry: RegistryEntry,
    messageId: string,
    drainSignal: AbortSignal,
  ): Promise<void> {
    const accountId = entry.cache.accountId;
    const signal = AbortSignal.any([entry.lifecycle.signal, drainSignal]);
    const pending = await entry.cache.listPendingRemoteImages(
      messageId,
      this.readTime(),
    );
    if (pending.length === 0) return;
    this.emit({
      event: "mail_remote_image_drain_started",
      accountId,
      remoteImageCount: pending.length,
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
        remoteImageAttemptCount: taken,
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

  /** Nor the commit it reports: the body is ready whatever the listener did. */
  private signalContentReady(accountId: string, messageId: string): void {
    if (this.onContentReady === null || this.closed) return;
    try {
      this.onContentReady(accountId, messageId);
    } catch {
      // The reader's own polling is the fallback for a lost hint.
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

function isContentMessageId(value: unknown): value is string {
  try {
    validateMailContentMessageId(value);
    return true;
  } catch {
    return false;
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

function deferredUntil(notBefore: number): MailContentQueueRunResult {
  if (!Number.isSafeInteger(notBefore) || notBefore < 0) throw unavailable();
  return Object.freeze({ kind: "deferred" as const, notBefore });
}

/** Best effort: a failure leaves the lease to run out on its own. */
async function voidAbandonedLease(
  entry: RegistryEntry,
  lease: MailContentLease | null,
): Promise<void> {
  if (lease === null) return;
  await entry.cache.voidLease(lease).catch(() => undefined);
}

function backgroundPrefetchComplete(): MailBackgroundContentPrefetchResult {
  return Object.freeze({ hasMore: false });
}

function claimUnderBudget(roomBytes: number): BackgroundClaimPolicy {
  return Object.freeze({ claim: true, newerThan: null, roomBytes });
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

function remoteImageRefused(): MailContentServiceError {
  return new MailContentServiceError("mail_content_remote_image_refused");
}

function unavailable(): MailContentServiceError {
  return new MailContentServiceError("mail_content_unavailable");
}
