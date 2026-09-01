import { randomBytes } from "node:crypto";
import { chmod, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MailBlobDescriptor, MailIncomingBlobStorePort } from "../ports";
import { MAIL_INLINE_IMAGE_MAX_BYTES } from "../content-types";
import { inspectMailRaster, type VerifiedMailRaster } from "../raster-metadata";
import {
  MAIL_RESOURCE_LIMITS,
  validateMailBlobDescriptor,
  validateMailRemoteImageSourceUrl,
} from "../security";
import {
  AtomicMailBlobStore,
  MailBlobStoreError,
} from "./content-blob-store";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_PROVIDER_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_LEASE_TOKEN = /^content-lease-a[0-9a-f]{32}$/;
const SAFE_ATTACHMENT_ID = /^attachment-a[0-9a-f]{32}$/;
const SAFE_REMOTE_IMAGE_ID = /^remote-image-a[0-9a-f]{32}$/;
const SAFE_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const DATABASE_FILE = "messages.sqlite3";
const MESSAGE_CACHE_SCHEMA_VERSION = 1;
const MAX_FILENAME_BYTES = 1024;
const MAX_CONTENT_ID_BYTES = 998;

/** Increment whenever parser output or sanitizer policy changes incompatibly. */
export const MAIL_CONTENT_FORMAT_VERSION = 8;

const databaseTails = new Map<string, Promise<void>>();

const CONTENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS message_content (
    account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    source_thread_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK(source_generation > 0),
    version INTEGER NOT NULL CHECK(version > 0),
    content_format_version INTEGER NOT NULL DEFAULT 1
      CHECK(content_format_version > 0),
    state TEXT NOT NULL CHECK(state IN (
      'fetching', 'ready', 'transient_failure', 'permanent_failure'
    )),
    lease_token TEXT,
    lease_expires_at INTEGER,
    raw_sha256 TEXT,
    raw_bytes INTEGER,
    text_sha256 TEXT,
    text_bytes INTEGER,
    html_sha256 TEXT,
    html_bytes INTEGER,
    failure_code TEXT,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(account_id, provider_message_id),
    CHECK(
      (state = 'fetching' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
      (state <> 'fetching' AND lease_token IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK(
      (raw_sha256 IS NULL AND raw_bytes IS NULL) OR
      (length(raw_sha256) = 64 AND raw_bytes BETWEEN 1 AND 41943040)
    ),
    CHECK(
      (text_sha256 IS NULL AND text_bytes IS NULL) OR
      (length(text_sha256) = 64 AND text_bytes BETWEEN 1 AND 41943040)
    ),
    CHECK(
      (html_sha256 IS NULL AND html_bytes IS NULL) OR
      (length(html_sha256) = 64 AND html_bytes BETWEEN 1 AND 41943040)
    ),
    CHECK(state <> 'ready' OR raw_sha256 IS NOT NULL),
    CHECK(
      (state IN ('transient_failure', 'permanent_failure') AND failure_code IS NOT NULL) OR
      (state NOT IN ('transient_failure', 'permanent_failure') AND failure_code IS NULL)
    ),
    FOREIGN KEY(account_id, source_generation, source_thread_id)
      REFERENCES threads(account_id, generation, thread_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_content_staged_blobs (
    account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 41943040),
    staged_at INTEGER NOT NULL CHECK(staged_at >= 0),
    PRIMARY KEY(account_id, provider_message_id, lease_token, sha256),
    FOREIGN KEY(account_id, provider_message_id)
      REFERENCES message_content(account_id, provider_message_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_content_attachments (
    account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255),
    filename TEXT,
    mime_type TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('attachment', 'inline')),
    content_id TEXT,
    sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 41943040),
    PRIMARY KEY(account_id, provider_message_id, attachment_id),
    UNIQUE(account_id, attachment_id),
    UNIQUE(account_id, provider_message_id, ordinal),
    FOREIGN KEY(account_id, provider_message_id)
      REFERENCES message_content(account_id, provider_message_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_content_remote_images (
    account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    remote_image_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 31),
    source_url TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'pending', 'ready', 'transient_failure', 'permanent_failure'
    )),
    mime_type TEXT,
    sha256 TEXT,
    bytes INTEGER,
    width INTEGER,
    height INTEGER,
    frames INTEGER,
    retry_at INTEGER,
    updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
    PRIMARY KEY(account_id, provider_message_id, remote_image_id),
    UNIQUE(account_id, remote_image_id),
    UNIQUE(account_id, provider_message_id, ordinal),
    UNIQUE(account_id, provider_message_id, source_url),
    CHECK(
      (state = 'ready' AND mime_type IS NOT NULL AND sha256 IS NOT NULL
        AND bytes BETWEEN 1 AND 8388608 AND width > 0 AND height > 0
        AND frames > 0 AND retry_at IS NULL) OR
      (state = 'transient_failure' AND mime_type IS NULL AND sha256 IS NULL
        AND retry_at IS NOT NULL AND (
          (bytes IS NULL AND width IS NULL AND height IS NULL AND frames IS NULL) OR
          (bytes BETWEEN 1 AND 8388608 AND width > 0 AND height > 0 AND frames > 0)
        )) OR
      (state IN ('pending', 'permanent_failure') AND mime_type IS NULL
        AND sha256 IS NULL AND retry_at IS NULL AND (
          (bytes IS NULL AND width IS NULL AND height IS NULL AND frames IS NULL) OR
          (bytes BETWEEN 1 AND 8388608 AND width > 0 AND height > 0 AND frames > 0)
        ))
    ),
    FOREIGN KEY(account_id, provider_message_id)
      REFERENCES message_content(account_id, provider_message_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_content_privacy_cohort (
    account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK(source_generation > 0),
    selected_at INTEGER NOT NULL CHECK(selected_at >= 0),
    content_prefetch_started_at INTEGER,
    PRIMARY KEY(account_id, provider_message_id),
    FOREIGN KEY(account_id, source_generation, provider_message_id)
      REFERENCES messages(account_id, generation, message_id)
      ON DELETE CASCADE,
    CHECK(content_prefetch_started_at IS NULL OR
          content_prefetch_started_at >= selected_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS message_content_user_demand (
    account_id TEXT NOT NULL,
    provider_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK(source_generation > 0),
    requested_at INTEGER NOT NULL CHECK(requested_at >= 0),
    PRIMARY KEY(account_id, provider_message_id),
    FOREIGN KEY(account_id, source_generation, provider_message_id)
      REFERENCES messages(account_id, generation, message_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS message_content_state_idx
    ON message_content(account_id, state, lease_expires_at);
`;

export type MailContentCacheErrorCode =
  | "mail_content_request_invalid"
  | "mail_content_not_active"
  | "mail_content_lease_busy"
  | "mail_content_lease_stale"
  | "mail_content_permanent_failure"
  | "mail_content_integrity_failed"
  | "mail_content_remote_image_budget_exhausted"
  | "mail_content_cache_capacity_exhausted"
  | "mail_content_cache_unavailable";

export class MailContentCacheError extends Error {
  constructor(readonly code: MailContentCacheErrorCode) {
    super(code);
    this.name = "MailContentCacheError";
  }
}

export interface MailContentLease {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly sourceGeneration: number;
  readonly version: number;
  readonly token: string;
  readonly expiresAt: number;
}

/** Reclaims globally stale content before a new bounded write is refused. */
export interface MailContentCapacityReclaimer {
  reclaim(now: number, minimumBytes: number): Promise<void>;
}

export type MailContentClaimResult =
  | { readonly kind: "claimed"; readonly lease: MailContentLease }
  | { readonly kind: "ready" }
  | { readonly kind: "busy"; readonly expiresAt: number }
  | { readonly kind: "not_active" }
  | { readonly kind: "permanent_failure"; readonly errorCode: string };

export interface MailContentAttachmentInput {
  readonly filename: string | null;
  readonly mimeType: string;
  readonly disposition: "attachment" | "inline";
  /** Retained only after bounded magic-byte raster verification. */
  readonly contentId: string | null;
  readonly blob: MailBlobDescriptor;
}

export interface CachedMailAttachment extends MailContentAttachmentInput {
  readonly attachmentId: string;
  readonly ordinal: number;
}

export interface MailContentRemoteImageInput {
  readonly remoteImageId: string;
  readonly sourceUrl: string;
}

export interface MailRemoteImageBudget {
  readonly maxBytes: number;
  readonly maxPixels: number;
  readonly maxFrames: number;
}

export interface MailPrivacyPrefetchCohortResult {
  readonly selectedMessages: number;
  readonly purgedContent: boolean;
}

interface CachedMailRemoteImageSnapshotBase {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly sourceGeneration: number;
  readonly version: number;
  readonly contentFormatVersion: number;
  readonly remoteImageId: string;
  readonly sourceUrl: string;
}

interface ReusableReadyRemoteImage {
  readonly sourceUrl: string;
  readonly mimeType: string;
  readonly blob: MailBlobDescriptor;
  readonly raster: VerifiedMailRaster;
}

export type CachedMailRemoteImageSnapshot =
  | (CachedMailRemoteImageSnapshotBase & { readonly state: "pending" })
  | (CachedMailRemoteImageSnapshotBase & {
      readonly state: "transient_failure";
      readonly retryAt: number;
    })
  | (CachedMailRemoteImageSnapshotBase & {
      readonly state: "permanent_failure";
    })
  | (CachedMailRemoteImageSnapshotBase & {
      readonly state: "ready";
      readonly mimeType: string;
      readonly blob: MailBlobDescriptor;
      readonly raster: VerifiedMailRaster;
    });

export interface CachedMailContent {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly sourceGeneration: number;
  readonly version: number;
  readonly contentFormatVersion: number;
  readonly rawMime: MailBlobDescriptor;
  readonly text: MailBlobDescriptor | null;
  readonly sanitizedHtml: MailBlobDescriptor | null;
  readonly attachments: readonly CachedMailAttachment[];
}

export interface CachedMailAttachmentSnapshot {
  readonly accountId: string;
  readonly providerMessageId: string;
  readonly sourceGeneration: number;
  readonly version: number;
  readonly contentFormatVersion: number;
  readonly attachment: CachedMailAttachment;
}

/**
 * Read-only projection of the durable content state for one active message.
 * Provider generations and lease tokens remain private to the cache boundary.
 */
export type MailContentCacheSnapshot =
  | { readonly kind: "not_active" }
  | { readonly kind: "not_requested" }
  | {
      readonly kind: "fetching";
      readonly leaseExpiresAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "transient_failure";
      readonly errorCode: string;
      readonly updatedAt: number;
    }
  | {
      readonly kind: "permanent_failure";
      readonly errorCode: string;
      readonly updatedAt: number;
    }
  | { readonly kind: "ready"; readonly content: CachedMailContent };

export class SqliteMailContentCache {
  readonly accountId: string;

  private readonly cacheRoot: string;
  private readonly databasePath: string;
  private readonly accountDirectory: string;
  private readonly blobStore: AtomicMailBlobStore;
  private readonly clock: () => number;
  private readonly contentFormatVersion: number;
  private readonly capacityReclaimer: MailContentCapacityReclaimer | null;
  private database: DatabaseSync | null = null;
  private closed = false;

  constructor(options: {
    readonly cacheRoot: string;
    readonly accountId: string;
    readonly blobStore: AtomicMailBlobStore;
    readonly clock?: () => number;
    readonly contentFormatVersion?: number;
    readonly capacityReclaimer?: MailContentCapacityReclaimer;
  }) {
    const cacheRoot = requireAbsolutePath(options.cacheRoot);
    this.cacheRoot = cacheRoot;
    this.accountId = validateAccountId(options.accountId);
    if (options.blobStore.accountId !== this.accountId) {
      throw new MailContentCacheError("mail_content_request_invalid");
    }
    this.blobStore = options.blobStore;
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw new MailContentCacheError("mail_content_request_invalid");
    }
    this.clock = options.clock ?? Date.now;
    if (
      options.capacityReclaimer !== undefined &&
      typeof options.capacityReclaimer.reclaim !== "function"
    ) {
      throw new MailContentCacheError("mail_content_request_invalid");
    }
    this.capacityReclaimer = options.capacityReclaimer ?? null;
    this.contentFormatVersion = validateContentFormatVersionInput(
      options.contentFormatVersion ?? MAIL_CONTENT_FORMAT_VERSION,
    );
    this.accountDirectory = path.join(cacheRoot, this.accountId);
    this.databasePath = path.join(this.accountDirectory, DATABASE_FILE);
  }

  async initialize(): Promise<void> {
    if (this.database !== null) return;
    if (this.closed) throw unavailable();
    await assertPrivateDirectory(this.cacheRoot);
    await assertPrivateDirectory(this.accountDirectory);
    await assertContained(this.cacheRoot, this.accountDirectory);
    const databaseIdentity = await assertPrivateDatabase(this.databasePath);
    await assertSchemaVersionReadOnly(this.databasePath, databaseIdentity);
    try {
      await this.blobStore.initialize();
    } catch (error) {
      throw contentError(error);
    }
    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(this.databasePath, {
        allowExtension: false,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        timeout: SQLITE_BUSY_TIMEOUT_MS,
      });
      database.exec(`
        PRAGMA trusted_schema = OFF;
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
      `);
      const openedPath = await assertPrivateDatabase(this.databasePath);
      if (
        openedPath.dev !== databaseIdentity.dev ||
        openedPath.ino !== databaseIdentity.ino
      ) {
        throw integrityFailed();
      }
      assertSchemaVersion(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(CONTENT_SCHEMA_SQL);
        ensureContentFormatColumn(database);
        ensureRemoteImageRasterColumns(database);
        assertSchemaVersion(database);
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
      await secureSqliteFiles(this.databasePath);
      this.database = database;
      database = null;
    } catch (error) {
      database?.close();
      this.database = null;
      throw contentError(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.serialized(async () => {
      this.closed = true;
      const database = this.database;
      this.database = null;
      if (database !== null) {
        try {
          database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          database.close();
        }
      }
    });
  }

  async claim(providerMessageId: string, now: number): Promise<MailContentClaimResult> {
    const messageId = validateProviderId(providerMessageId);
    const timestamp = validateTimestamp(now);
    return this.serialized(async () =>
      this.transaction((database) => {
        const active = activeMessage(database, this.accountId, messageId);
        if (active === null) {
          database
            .prepare(
              `DELETE FROM message_content
                WHERE account_id = ? AND provider_message_id = ?`,
            )
            .run(this.accountId, messageId);
          return Object.freeze({ kind: "not_active" as const });
        }
        const row = contentState(database, this.accountId, messageId);
        const preserveReadyRemoteImages =
          row !== null &&
          row.state === "ready" &&
          row.source_generation === active.generation &&
          row.source_thread_id === active.threadId &&
          row.content_format_version !== this.contentFormatVersion;
        if (
          row !== null &&
          row.source_generation === active.generation &&
          row.source_thread_id === active.threadId &&
          row.content_format_version === this.contentFormatVersion
        ) {
          if (row.state === "ready") {
            return Object.freeze({ kind: "ready" as const });
          }
          if (row.state === "permanent_failure") {
            return Object.freeze({
              kind: "permanent_failure" as const,
              errorCode: validateErrorCode(row.failure_code),
            });
          }
          if (
            row.state === "fetching" &&
            typeof row.lease_expires_at === "number" &&
            row.lease_expires_at > timestamp
          ) {
            return Object.freeze({
              kind: "busy" as const,
              expiresAt: row.lease_expires_at,
            });
          }
        }

        const version = row === null ? 1 : validateVersion(row.version) + 1;
        if (!Number.isSafeInteger(version)) throw unavailable();
        const token = `content-lease-a${randomBytes(16).toString("hex")}`;
        const expiresAt = timestamp + MAIL_RESOURCE_LIMITS.workerLeaseMs;
        const lease = Object.freeze({
          accountId: this.accountId,
          providerMessageId: messageId,
          sourceGeneration: active.generation,
          version,
          token,
          expiresAt,
        });
        database
          .prepare(
            `INSERT INTO message_content(
               account_id, provider_message_id, source_thread_id,
               source_generation, version, content_format_version,
               state, lease_token, lease_expires_at, raw_sha256, raw_bytes,
               text_sha256, text_bytes, html_sha256, html_bytes, failure_code,
               updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'fetching', ?, ?, NULL, NULL, NULL, NULL,
                       NULL, NULL, NULL, ?)
             ON CONFLICT(account_id, provider_message_id) DO UPDATE SET
               source_thread_id = excluded.source_thread_id,
               source_generation = excluded.source_generation,
               version = excluded.version,
               content_format_version = excluded.content_format_version,
               state = 'fetching', lease_token = excluded.lease_token,
               lease_expires_at = excluded.lease_expires_at,
               raw_sha256 = NULL, raw_bytes = NULL, text_sha256 = NULL,
               text_bytes = NULL, html_sha256 = NULL, html_bytes = NULL,
               failure_code = NULL, updated_at = excluded.updated_at`,
          )
          .run(
            this.accountId,
            messageId,
            active.threadId,
            active.generation,
            version,
            this.contentFormatVersion,
            token,
            expiresAt,
            timestamp,
          );
        database
          .prepare(
            `DELETE FROM message_content_attachments
              WHERE account_id = ? AND provider_message_id = ?`,
          )
          .run(this.accountId, messageId);
        database
          .prepare(
            `DELETE FROM message_content_staged_blobs
              WHERE account_id = ? AND provider_message_id = ?`,
          )
          .run(this.accountId, messageId);
        if (preserveReadyRemoteImages) {
          const rows = database
            .prepare(
              `SELECT sha256, bytes
                 FROM message_content_remote_images
                WHERE account_id = ? AND provider_message_id = ?
                  AND state = 'ready'`,
            )
            .all(this.accountId, messageId);
          for (const remoteImage of rows) {
            const descriptor = descriptorFromColumns(
              remoteImage.sha256,
              remoteImage.bytes,
            );
            if (descriptor === null) throw integrityFailed();
            stageDescriptor(database, lease, descriptor, timestamp);
          }
        } else {
          database
            .prepare(
              `DELETE FROM message_content_remote_images
                WHERE account_id = ? AND provider_message_id = ?`,
            )
            .run(this.accountId, messageId);
        }
        return Object.freeze({
          kind: "claimed" as const,
          lease,
        });
      }),
    );
  }

  async stageBlob(
    leaseInput: MailContentLease,
    descriptorInput: MailBlobDescriptor,
    chunks: AsyncIterable<Uint8Array>,
    now: number,
  ): Promise<void> {
    const lease = validateLease(leaseInput, this.accountId);
    const descriptor = blobDescriptor(descriptorInput);
    const timestamp = validateTimestamp(now);
    const alreadyStaged = await this.serialized(async () =>
      this.transaction((database) => {
        assertLiveLease(database, lease, timestamp, this.contentFormatVersion);
        return stagedDescriptorExists(database, lease, descriptor);
      }),
    );
    if (alreadyStaged) return;
    await mapContentOperation(async () =>
      this.blobStore.withCapacityReservation(
        descriptor.bytes,
        () => this.reclaimCapacity(timestamp, descriptor.bytes),
        async (blobLease) => {
        await this.serialized(async () => {
          this.transaction((database) => {
            assertLiveLease(database, lease, timestamp, this.contentFormatVersion);
          });
        });
        await blobLease.put(descriptor, chunks);
        const completedAt = Math.max(timestamp, this.readCurrentTime());
        await this.serialized(async () => {
          this.transaction((database) => {
            assertLiveLease(database, lease, completedAt, this.contentFormatVersion);
            stageDescriptor(database, lease, descriptor, completedAt);
          });
        });
        },
      ),
    );
  }

  /**
   * Gives a raw-source adapter a lease-bound incoming store. Publishing raw
   * MIME and recording its staged reference happen under the same global
   * capacity reservation, before the provider is allowed to stream bytes.
   */
  incomingBlobStore(leaseInput: MailContentLease): MailIncomingBlobStorePort & {
    readonly accountId: string;
  } {
    const lease = validateLease(leaseInput, this.accountId);
    return Object.freeze({
      accountId: this.accountId,
      has: (descriptor: MailBlobDescriptor) => this.blobStore.has(descriptor),
      put: (descriptor: MailBlobDescriptor, chunks: AsyncIterable<Uint8Array>) =>
        this.blobStore.put(descriptor, chunks),
      read: (descriptor: MailBlobDescriptor) => this.blobStore.read(descriptor),
      remove: (descriptor: MailBlobDescriptor) => this.blobStore.remove(descriptor),
      putIncoming: (chunks: AsyncIterable<Uint8Array>, maxBytes: number) =>
        this.stageIncomingBlob(lease, chunks, maxBytes),
    });
  }

  private async stageIncomingBlob(
    lease: MailContentLease,
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<MailBlobDescriptor> {
    if (!isAsyncIterable(chunks)) throw invalidRequest();
    const maximumBytes = incomingByteLimit(maxBytes);
    const requestedAt = this.readCurrentTime();
    return mapContentOperation(async () =>
      this.blobStore.withCapacityReservation(
        maximumBytes,
        () => this.reclaimCapacity(requestedAt, maximumBytes),
        async (blobLease) => {
          await this.serialized(async () => {
            this.transaction((database) => {
              assertLiveLease(database, lease, requestedAt, this.contentFormatVersion);
            });
          });
          const descriptor = await blobLease.putIncoming(chunks, maximumBytes);
          const completedAt = Math.max(requestedAt, this.readCurrentTime());
          await this.serialized(async () => {
            this.transaction((database) => {
              assertLiveLease(database, lease, completedAt, this.contentFormatVersion);
              stageDescriptor(database, lease, descriptor, completedAt);
            });
          });
          return descriptor;
        },
      ),
    );
  }

  async commitReady(input: {
    readonly lease: MailContentLease;
    readonly rawMime: MailBlobDescriptor;
    readonly text: MailBlobDescriptor | null;
    readonly sanitizedHtml: MailBlobDescriptor | null;
    readonly attachments: readonly MailContentAttachmentInput[];
    readonly remoteImages?: readonly MailContentRemoteImageInput[];
    readonly now: number;
  }): Promise<CachedMailContent> {
    const lease = validateLease(input.lease, this.accountId);
    const requestedAt = validateTimestamp(input.now);
    const rawMime = nonEmptyBlobDescriptor(input.rawMime);
    const text = optionalNonEmptyBlobDescriptor(input.text);
    const sanitizedHtml = optionalNonEmptyBlobDescriptor(input.sanitizedHtml);
    const attachments = validateAttachments(input.attachments);
    const remoteImages = validateRemoteImages(input.remoteImages ?? []);
    const descriptors = uniqueDescriptors([
      rawMime,
      ...(text === null ? [] : [text]),
      ...(sanitizedHtml === null ? [] : [sanitizedHtml]),
      ...attachments.map((attachment) => attachment.blob),
    ]);
    const decodedBytes =
      (text?.bytes ?? 0) +
      (sanitizedHtml?.bytes ?? 0) +
      attachments.reduce((total, attachment) => total + attachment.blob.bytes, 0);
    if (decodedBytes > MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes) {
      throw invalidRequest();
    }

    return mapContentOperation(async () =>
      this.blobStore.withMutationLease(async (blobLease) => {
        const reusableCandidates = await this.serialized(async () =>
          this.transaction((database) => {
            assertLiveLease(
              database,
              lease,
              requestedAt,
              this.contentFormatVersion,
            );
            return reusableReadyRemoteImages(
              database,
              this.accountId,
              lease.providerMessageId,
              remoteImages,
            );
          }),
        );
        const reusableRemoteImages = new Map<string, ReusableReadyRemoteImage>();
        for (const candidate of reusableCandidates) {
          if (await blobLease.has(candidate.blob)) {
            reusableRemoteImages.set(candidate.sourceUrl, candidate);
          }
        }
        const committedDescriptors = uniqueDescriptors([
          ...descriptors.values(),
          ...reusableRemoteImages.values().map((image) => image.blob),
        ]);
        for (const descriptor of committedDescriptors.values()) {
          if (!(await blobLease.has(descriptor))) throw integrityFailed();
        }
        const committedAt = Math.max(requestedAt, this.readCurrentTime());
        return this.serialized(async () =>
          this.transaction((database) => {
          assertLiveLease(database, lease, committedAt, this.contentFormatVersion);
          assertDescriptorsStaged(database, lease, committedDescriptors);
          database
            .prepare(
              `DELETE FROM message_content_attachments
                WHERE account_id = ? AND provider_message_id = ?`,
            )
            .run(this.accountId, lease.providerMessageId);
          database
            .prepare(
              `DELETE FROM message_content_remote_images
                WHERE account_id = ? AND provider_message_id = ?`,
            )
            .run(this.accountId, lease.providerMessageId);
          const readyAttachments: CachedMailAttachment[] = [];
          for (const [ordinal, attachment] of attachments.entries()) {
            const attachmentId = allocateAttachmentId(database, this.accountId);
            database
              .prepare(
                `INSERT INTO message_content_attachments(
                   account_id, provider_message_id, attachment_id, ordinal,
                   filename, mime_type, disposition, content_id, sha256, bytes
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                this.accountId,
                lease.providerMessageId,
                attachmentId,
                ordinal,
                attachment.filename,
                attachment.mimeType,
                attachment.disposition,
                attachment.contentId,
                attachment.blob.sha256,
                attachment.blob.bytes,
              );
            readyAttachments.push(
              Object.freeze({ ...attachment, attachmentId, ordinal }),
            );
          }
          for (const [ordinal, remoteImage] of remoteImages.entries()) {
            const reusable = reusableRemoteImages.get(remoteImage.sourceUrl);
            if (reusable === undefined) {
              database
                .prepare(
                  `INSERT INTO message_content_remote_images(
                     account_id, provider_message_id, remote_image_id, ordinal,
                     source_url, state, mime_type, sha256, bytes, width, height,
                     frames, retry_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL,
                             NULL, NULL, NULL, ?)`,
                )
                .run(
                  this.accountId,
                  lease.providerMessageId,
                  remoteImage.remoteImageId,
                  ordinal,
                  remoteImage.sourceUrl,
                  committedAt,
                );
            } else {
              database
                .prepare(
                  `INSERT INTO message_content_remote_images(
                     account_id, provider_message_id, remote_image_id, ordinal,
                     source_url, state, mime_type, sha256, bytes, width, height,
                     frames, retry_at, updated_at
                   ) VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, NULL, ?)`,
                )
                .run(
                  this.accountId,
                  lease.providerMessageId,
                  remoteImage.remoteImageId,
                  ordinal,
                  remoteImage.sourceUrl,
                  reusable.mimeType,
                  reusable.blob.sha256,
                  reusable.blob.bytes,
                  reusable.raster.width,
                  reusable.raster.height,
                  reusable.raster.frames,
                  committedAt,
                );
            }
          }
          const updated = database
            .prepare(
              `UPDATE message_content
                  SET state = 'ready', lease_token = NULL,
                      lease_expires_at = NULL, raw_sha256 = ?, raw_bytes = ?,
                      text_sha256 = ?, text_bytes = ?, html_sha256 = ?,
                      html_bytes = ?, failure_code = NULL, updated_at = ?
                WHERE account_id = ? AND provider_message_id = ?
                  AND source_generation = ? AND version = ?
                  AND content_format_version = ?
                  AND state = 'fetching' AND lease_token = ?`,
            )
            .run(
              rawMime.sha256,
              rawMime.bytes,
              text?.sha256 ?? null,
              text?.bytes ?? null,
              sanitizedHtml?.sha256 ?? null,
              sanitizedHtml?.bytes ?? null,
              committedAt,
              this.accountId,
              lease.providerMessageId,
              lease.sourceGeneration,
              lease.version,
              this.contentFormatVersion,
              lease.token,
            );
          if (updated.changes !== 1) throw staleLease();
          database
            .prepare(
              `DELETE FROM message_content_staged_blobs
                WHERE account_id = ? AND provider_message_id = ?
                  AND lease_token = ?`,
            )
            .run(this.accountId, lease.providerMessageId, lease.token);
          return Object.freeze({
            accountId: this.accountId,
            providerMessageId: lease.providerMessageId,
            sourceGeneration: lease.sourceGeneration,
            version: lease.version,
            contentFormatVersion: this.contentFormatVersion,
            rawMime,
            text,
            sanitizedHtml,
            attachments: Object.freeze(readyAttachments),
          });
          }),
        );
      }),
    );
  }

  async markFailure(input: {
    readonly lease: MailContentLease;
    readonly kind: "transient" | "permanent";
    readonly errorCode: string;
    readonly now: number;
  }): Promise<void> {
    const lease = validateLease(input.lease, this.accountId);
    const requestedAt = validateTimestamp(input.now);
    const errorCode = validateErrorCode(input.errorCode);
    if (input.kind !== "transient" && input.kind !== "permanent") {
      throw invalidRequest();
    }
    await this.serialized(async () => {
      const failedAt = Math.max(requestedAt, this.readCurrentTime());
      return this.transaction((database) => {
        assertLiveLease(database, lease, failedAt, this.contentFormatVersion);
        const updated = database
          .prepare(
            `UPDATE message_content
                SET state = ?, lease_token = NULL, lease_expires_at = NULL,
                    raw_sha256 = NULL, raw_bytes = NULL, text_sha256 = NULL,
                    text_bytes = NULL, html_sha256 = NULL, html_bytes = NULL,
                    failure_code = ?, updated_at = ?
              WHERE account_id = ? AND provider_message_id = ?
                AND source_generation = ? AND version = ?
                AND content_format_version = ?
                AND state = 'fetching' AND lease_token = ?`,
          )
          .run(
            input.kind === "transient" ? "transient_failure" : "permanent_failure",
            errorCode,
            failedAt,
            this.accountId,
            lease.providerMessageId,
            lease.sourceGeneration,
            lease.version,
            this.contentFormatVersion,
            lease.token,
          );
        if (updated.changes !== 1) throw staleLease();
        database
          .prepare(
            `DELETE FROM message_content_staged_blobs
              WHERE account_id = ? AND provider_message_id = ?
                AND lease_token = ?`,
          )
          .run(this.accountId, lease.providerMessageId, lease.token);
      });
    });
  }

  async read(providerMessageId: string): Promise<CachedMailContent | null> {
    const messageId = validateProviderId(providerMessageId);
    return this.serialized(async () => {
      const database = this.requireDatabase();
      const row = database
        .prepare(
          `SELECT content.source_generation, content.version,
                  content.content_format_version, content.raw_sha256,
                  content.raw_bytes, content.text_sha256, content.text_bytes,
                  content.html_sha256, content.html_bytes
             FROM message_content AS content
             JOIN sync_state AS sync ON sync.account_id = content.account_id
             JOIN messages AS message
              ON message.account_id = content.account_id
             AND message.generation = content.source_generation
             AND message.message_id = content.provider_message_id
             AND message.thread_id = content.source_thread_id
            WHERE content.account_id = ? AND content.provider_message_id = ?
              AND content.state = 'ready'
              AND content.source_generation = sync.active_generation
              AND content.content_format_version = ?`,
        )
        .get(this.accountId, messageId, this.contentFormatVersion);
      if (row === undefined) return null;
      return contentFromRow(database, this.accountId, messageId, row);
    });
  }

  async inspect(providerMessageId: string): Promise<MailContentCacheSnapshot> {
    const messageId = validateProviderId(providerMessageId);
    return this.serialized(async () => {
      const database = this.requireDatabase();
      const active = activeMessage(database, this.accountId, messageId);
      if (active === null) {
        return Object.freeze({ kind: "not_active" as const });
      }
      const row = contentState(database, this.accountId, messageId);
      if (
        row === null ||
        row.source_generation !== active.generation ||
        row.source_thread_id !== active.threadId ||
        row.content_format_version !== this.contentFormatVersion
      ) {
        return Object.freeze({ kind: "not_requested" as const });
      }
      const updatedAt = validateTimestampState(row.updated_at);
      if (row.state === "fetching") {
        if (typeof row.lease_expires_at !== "number") throw integrityFailed();
        return Object.freeze({
          kind: "fetching" as const,
          leaseExpiresAt: validateTimestampState(row.lease_expires_at),
          updatedAt,
        });
      }
      if (row.state === "transient_failure") {
        return Object.freeze({
          kind: "transient_failure" as const,
          errorCode: validateErrorCode(row.failure_code),
          updatedAt,
        });
      }
      if (row.state === "permanent_failure") {
        return Object.freeze({
          kind: "permanent_failure" as const,
          errorCode: validateErrorCode(row.failure_code),
          updatedAt,
        });
      }
      return Object.freeze({
        kind: "ready" as const,
        content: contentFromRow(database, this.accountId, messageId, row),
      });
    });
  }

  async recordUserContentDemand(
    providerMessageId: string,
    now: number,
  ): Promise<void> {
    const messageId = validateProviderId(providerMessageId);
    const requestedAt = validateTimestamp(now);
    await this.serialized(async () =>
      this.transaction((database) => {
        const active = activeMessage(database, this.accountId, messageId);
        if (active === null) throw notActive();
        database
          .prepare(
            `INSERT INTO message_content_user_demand(
               account_id, provider_message_id, source_generation, requested_at
             ) VALUES (?, ?, ?, ?)
             ON CONFLICT(account_id, provider_message_id) DO UPDATE SET
               source_generation = excluded.source_generation,
               requested_at = CASE
                 WHEN requested_at < excluded.requested_at
                 THEN excluded.requested_at ELSE requested_at END`,
          )
          .run(this.accountId, messageId, active.generation, requestedAt);
      }),
    );
  }

  /**
   * Rebuilds a small, stable Inbox cohort from sync metadata only. Read state,
   * content requests, and existing remote manifests do not affect selection.
   */
  async refreshBackgroundPrivacyCohort(
    now: number,
  ): Promise<MailPrivacyPrefetchCohortResult> {
    const selectedAt = validateTimestamp(now);
    const minimumSentAt = Math.max(
      0,
      selectedAt - MAIL_RESOURCE_LIMITS.privacyPrefetchMaxAgeMs,
    );
    const maximumSentAt = Math.min(
      Number.MAX_SAFE_INTEGER,
      selectedAt + MAIL_RESOURCE_LIMITS.privacyPrefetchMaxFutureSkewMs,
    );
    return this.serialized(async () =>
      this.transaction((database) => {
        const rows = database
          .prepare(
            `SELECT message.message_id, message.generation
               FROM sync_state AS sync
               JOIN messages AS message
                 ON message.account_id = sync.account_id
                AND message.generation = sync.active_generation
              WHERE sync.account_id = ? AND sync.active_generation > 0
                AND message.in_inbox = 1
                AND message.sent_at BETWEEN ? AND ?
              ORDER BY message.sent_at DESC, message.message_id DESC
              LIMIT ?`,
          )
          .all(
            this.accountId,
            minimumSentAt,
            maximumSentAt,
            MAIL_RESOURCE_LIMITS.privacyPrefetchMaxMessagesPerAccount,
          );
        const selected = rows.map((row) => {
          if (
            typeof row.message_id !== "string" ||
            !SAFE_PROVIDER_ID.test(row.message_id)
          ) {
            throw integrityFailed();
          }
          return Object.freeze({
            messageId: row.message_id,
            generation: validateGeneration(row.generation),
          });
        });
        const selectedIds = new Set(selected.map((candidate) => candidate.messageId));
        const existing = database
          .prepare(
            `SELECT provider_message_id
               FROM message_content_privacy_cohort WHERE account_id = ?`,
          )
          .all(this.accountId);
        const remove = database.prepare(
          `DELETE FROM message_content_privacy_cohort
            WHERE account_id = ? AND provider_message_id = ?`,
        );
        for (const row of existing) {
          if (
            typeof row.provider_message_id !== "string" ||
            !SAFE_PROVIDER_ID.test(row.provider_message_id)
          ) {
            throw integrityFailed();
          }
          if (!selectedIds.has(row.provider_message_id)) {
            remove.run(this.accountId, row.provider_message_id);
          }
        }
        const insert = database.prepare(
          `INSERT INTO message_content_privacy_cohort(
             account_id, provider_message_id, source_generation, selected_at,
             content_prefetch_started_at
           ) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT(account_id, provider_message_id) DO UPDATE SET
             source_generation = excluded.source_generation,
             selected_at = CASE
               WHEN source_generation = excluded.source_generation
               THEN selected_at ELSE excluded.selected_at END,
             content_prefetch_started_at = CASE
               WHEN source_generation = excluded.source_generation
               THEN content_prefetch_started_at ELSE NULL END`,
        );
        for (const candidate of selected) {
          insert.run(
            this.accountId,
            candidate.messageId,
            candidate.generation,
            selectedAt,
          );
        }
        const purged = database
          .prepare(
            `DELETE FROM message_content AS content
              WHERE content.account_id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM message_content_privacy_cohort AS cohort
                   WHERE cohort.account_id = content.account_id
                     AND cohort.provider_message_id = content.provider_message_id
                     AND cohort.source_generation = content.source_generation
                )
                AND NOT EXISTS (
                  SELECT 1 FROM message_content_user_demand AS demand
                   WHERE demand.account_id = content.account_id
                     AND demand.provider_message_id = content.provider_message_id
                     AND demand.source_generation = content.source_generation
                )`,
          )
          .run(this.accountId);
        return Object.freeze({
          selectedMessages: selected.length,
          purgedContent: purged.changes > 0,
        });
      }),
    );
  }

  async findBackgroundContentCandidate(now: number): Promise<string | null> {
    const inspectedAt = validateTimestamp(now);
    return this.serialized(async () => {
      const row = this.requireDatabase()
        .prepare(
          `SELECT cohort.provider_message_id
             FROM message_content_privacy_cohort AS cohort
             JOIN sync_state AS sync ON sync.account_id = cohort.account_id
             JOIN messages AS message
               ON message.account_id = cohort.account_id
              AND message.generation = cohort.source_generation
              AND message.message_id = cohort.provider_message_id
             LEFT JOIN message_content AS content
               ON content.account_id = cohort.account_id
              AND content.provider_message_id = cohort.provider_message_id
            WHERE cohort.account_id = ?
              AND cohort.source_generation = sync.active_generation
              AND (
                cohort.content_prefetch_started_at IS NULL OR
                content.provider_message_id IS NULL OR
                content.source_generation <> cohort.source_generation OR
                content.source_thread_id <> message.thread_id OR
                content.content_format_version <> ? OR
                (content.state = 'transient_failure' AND
                  content.updated_at + ? <= ?) OR
                (content.state = 'fetching' AND content.lease_expires_at <= ?)
              )
            ORDER BY message.sent_at DESC, message.message_id DESC
            LIMIT 1`,
        )
        .get(
          this.accountId,
          this.contentFormatVersion,
          MAIL_RESOURCE_LIMITS.remoteImageTransientRetryMs,
          inspectedAt,
          inspectedAt,
        );
      if (row === undefined) return null;
      if (
        typeof row.provider_message_id !== "string" ||
        !SAFE_PROVIDER_ID.test(row.provider_message_id)
      ) {
        throw integrityFailed();
      }
      return row.provider_message_id;
    });
  }

  async markBackgroundContentPrefetchStarted(
    providerMessageId: string,
    now: number,
  ): Promise<void> {
    const messageId = validateProviderId(providerMessageId);
    const startedAt = validateTimestamp(now);
    await this.serialized(async () =>
      this.transaction((database) => {
        const updated = database
          .prepare(
            `UPDATE message_content_privacy_cohort
                SET content_prefetch_started_at = COALESCE(
                  content_prefetch_started_at, ?
                )
              WHERE account_id = ? AND provider_message_id = ?`,
          )
          .run(startedAt, this.accountId, messageId);
        if (updated.changes !== 1) throw notActive();
      }),
    );
  }

  async isBackgroundContentPrefetchStarted(
    providerMessageId: string,
  ): Promise<boolean> {
    const messageId = validateProviderId(providerMessageId);
    return this.serialized(async () => {
      const row = this.requireDatabase()
        .prepare(
          `SELECT 1 AS present
             FROM message_content_privacy_cohort AS cohort
             JOIN sync_state AS sync ON sync.account_id = cohort.account_id
            WHERE cohort.account_id = ? AND cohort.provider_message_id = ?
              AND cohort.source_generation = sync.active_generation
              AND cohort.content_prefetch_started_at IS NOT NULL`,
        )
        .get(this.accountId, messageId);
      return row !== undefined;
    });
  }

  /**
   * Selects one origin image only for a scheduler-owned privacy-cache pass.
   * A message is eligible through the started background cohort, or through a
   * live owner demand row at the same generation: opening a message is the
   * owner's approval to fetch its images server-side (Gmail-web semantics).
   */
  async findBackgroundRemoteImageCandidate(now: number): Promise<string | null> {
    const inspectedAt = validateTimestamp(now);
    return this.serialized(async () => {
      const row = this.requireDatabase()
        .prepare(
          `SELECT remote.remote_image_id
             FROM message_content_remote_images AS remote
             JOIN message_content AS content
               ON content.account_id = remote.account_id
              AND content.provider_message_id = remote.provider_message_id
             JOIN sync_state AS sync ON sync.account_id = content.account_id
             JOIN messages AS message
               ON message.account_id = content.account_id
              AND message.generation = content.source_generation
              AND message.message_id = content.provider_message_id
              AND message.thread_id = content.source_thread_id
             LEFT JOIN message_content_privacy_cohort AS cohort
               ON cohort.account_id = remote.account_id
              AND cohort.provider_message_id = remote.provider_message_id
              AND cohort.source_generation = content.source_generation
             LEFT JOIN message_content_user_demand AS demand
               ON demand.account_id = remote.account_id
              AND demand.provider_message_id = remote.provider_message_id
              AND demand.source_generation = content.source_generation
            WHERE remote.account_id = ? AND content.state = 'ready'
              AND content.source_generation = sync.active_generation
              AND content.content_format_version = ?
              AND (cohort.content_prefetch_started_at IS NOT NULL OR
                demand.provider_message_id IS NOT NULL)
              AND (
                (remote.state = 'pending' AND remote.bytes IS NULL) OR
                (remote.state = 'transient_failure' AND remote.retry_at <= ?)
              )
            ORDER BY CASE WHEN remote.state = 'pending' THEN 0 ELSE 1 END ASC,
                     message.sent_at DESC, message.message_id DESC,
                     COALESCE(remote.retry_at, 0) ASC, remote.ordinal ASC
            LIMIT 1`,
        )
        .get(this.accountId, this.contentFormatVersion, inspectedAt);
      if (row === undefined) return null;
      if (
        typeof row.remote_image_id !== "string" ||
        !SAFE_REMOTE_IMAGE_ID.test(row.remote_image_id)
      ) {
        throw integrityFailed();
      }
      return row.remote_image_id;
    });
  }

  async readAttachment(
    attachmentId: string,
  ): Promise<CachedMailAttachmentSnapshot | null> {
    const id = validateAttachmentId(attachmentId);
    return this.serialized(async () => {
      const row = this.requireDatabase()
        .prepare(
          `SELECT attachment.provider_message_id, attachment.attachment_id,
                  attachment.ordinal, attachment.filename,
                  attachment.mime_type, attachment.disposition,
                  attachment.content_id, attachment.sha256, attachment.bytes,
                  content.source_generation, content.version,
                  content.content_format_version
             FROM message_content_attachments AS attachment
             JOIN message_content AS content
               ON content.account_id = attachment.account_id
              AND content.provider_message_id = attachment.provider_message_id
             JOIN sync_state AS sync ON sync.account_id = content.account_id
             JOIN messages AS message
              ON message.account_id = content.account_id
             AND message.generation = content.source_generation
             AND message.message_id = content.provider_message_id
             AND message.thread_id = content.source_thread_id
            WHERE attachment.account_id = ? AND attachment.attachment_id = ?
              AND content.state = 'ready'
              AND content.source_generation = sync.active_generation
              AND content.content_format_version = ?`,
        )
        .get(this.accountId, id, this.contentFormatVersion);
      if (row === undefined) return null;
      if (
        typeof row.provider_message_id !== "string" ||
        !SAFE_PROVIDER_ID.test(row.provider_message_id)
      ) {
        throw integrityFailed();
      }
      return Object.freeze({
        accountId: this.accountId,
        providerMessageId: row.provider_message_id,
        sourceGeneration: validateGeneration(row.source_generation),
        version: validateVersion(row.version),
        contentFormatVersion: validatePositiveInteger(
          row.content_format_version,
        ),
        attachment: attachmentFromRow(row),
      });
    });
  }

  async inspectRemoteImage(
    remoteImageId: string,
    now: number,
  ): Promise<CachedMailRemoteImageSnapshot | null> {
    const id = validateRemoteImageId(remoteImageId);
    const inspectedAt = validateTimestamp(now);
    return this.serialized(async () => {
      const row = this.requireDatabase()
        .prepare(
          `SELECT remote.provider_message_id, remote.remote_image_id,
                  remote.source_url, remote.state, remote.mime_type,
                  remote.sha256, remote.bytes, remote.width, remote.height,
                  remote.frames, remote.retry_at,
                  content.source_generation, content.version,
                  content.content_format_version
             FROM message_content_remote_images AS remote
             JOIN message_content AS content
               ON content.account_id = remote.account_id
              AND content.provider_message_id = remote.provider_message_id
             JOIN sync_state AS sync ON sync.account_id = content.account_id
             JOIN messages AS message
               ON message.account_id = content.account_id
              AND message.generation = content.source_generation
              AND message.message_id = content.provider_message_id
              AND message.thread_id = content.source_thread_id
            WHERE remote.account_id = ? AND remote.remote_image_id = ?
              AND content.state = 'ready'
              AND content.source_generation = sync.active_generation
              AND content.content_format_version = ?`,
        )
        .get(this.accountId, id, this.contentFormatVersion);
      if (row === undefined) return null;
      const base = remoteImageSnapshotBase(this.accountId, row);
      if (row.state === "pending") {
        return Object.freeze({ ...base, state: "pending" as const });
      }
      if (row.state === "permanent_failure") {
        return Object.freeze({ ...base, state: "permanent_failure" as const });
      }
      if (row.state === "transient_failure") {
        const retryAt = validateTimestampState(row.retry_at);
        return retryAt <= inspectedAt
          ? Object.freeze({ ...base, state: "pending" as const })
          : Object.freeze({
              ...base,
              state: "transient_failure" as const,
              retryAt,
            });
      }
      if (row.state !== "ready") throw integrityFailed();
      let mimeType: string;
      let raster: VerifiedMailRaster;
      try {
        mimeType = validateRemoteImageMimeType(row.mime_type);
        raster = rasterFromColumns(row.width, row.height, row.frames);
      } catch {
        throw integrityFailed();
      }
      const touched = this.requireDatabase()
        .prepare(
          `UPDATE message_content_remote_images
              SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
            WHERE account_id = ? AND remote_image_id = ? AND state = 'ready'`,
        )
        .run(inspectedAt, inspectedAt, this.accountId, id);
      if (touched.changes !== 1) throw notActive();
      return Object.freeze({
        ...base,
        state: "ready" as const,
        mimeType,
        raster,
        blob:
          descriptorFromColumns(row.sha256, row.bytes) ??
          (() => {
            throw integrityFailed();
          })(),
      });
    });
  }

  async readRemoteImageBudget(
    snapshotInput: CachedMailRemoteImageSnapshot,
  ): Promise<MailRemoteImageBudget> {
    const snapshot = validateRemoteImageSnapshot(snapshotInput, this.accountId);
    if (snapshot.state === "ready" || snapshot.state === "permanent_failure") {
      throw invalidRequest();
    }
    return this.serialized(async () =>
      this.transaction((database) => {
        assertLiveRemoteImage(database, snapshot, this.contentFormatVersion);
        const usage = remoteImageUsage(
          database,
          this.accountId,
          snapshot.providerMessageId,
          snapshot.remoteImageId,
        );
        return Object.freeze({
          maxBytes: Math.max(
            0,
            MAIL_RESOURCE_LIMITS.maxRemoteImageBytesPerMessage - usage.bytes,
          ),
          maxPixels: Math.max(
            0,
            MAIL_RESOURCE_LIMITS.maxInlineImagePixels - usage.pixels,
          ),
          maxFrames: Math.max(
            0,
            MAIL_RESOURCE_LIMITS.maxInlineImageFrames - usage.frames,
          ),
        });
      }),
    );
  }

  async storeRemoteImage(input: {
    readonly snapshot: CachedMailRemoteImageSnapshot;
    readonly mimeType: string;
    readonly data: Uint8Array;
    readonly raster: VerifiedMailRaster;
    readonly now: number;
  }): Promise<CachedMailRemoteImageSnapshot & { readonly state: "ready" }> {
    const snapshot = validateRemoteImageSnapshot(input.snapshot, this.accountId);
    if (snapshot.state === "ready" || snapshot.state === "permanent_failure") {
      throw invalidRequest();
    }
    const mimeType = validateRemoteImageMimeType(input.mimeType);
    if (
      !(input.data instanceof Uint8Array) ||
      input.data.byteLength < 1 ||
      input.data.byteLength > MAIL_INLINE_IMAGE_MAX_BYTES
    ) {
      throw invalidRequest();
    }
    const raster = validateRemoteImageRaster(input.raster);
    const verifiedRaster = inspectMailRaster(mimeType, input.data);
    if (
      verifiedRaster === null ||
      verifiedRaster.width !== raster.width ||
      verifiedRaster.height !== raster.height ||
      verifiedRaster.frames !== raster.frames
    ) {
      throw invalidRequest();
    }
    const requestedAt = validateTimestamp(input.now);
    return mapContentOperation(async () =>
      this.blobStore.withCapacityReservation(
        input.data.byteLength,
        () => this.reclaimCapacity(requestedAt, input.data.byteLength),
        async (blobLease) => {
          const descriptor = await blobLease.putIncoming(
            oneChunk(input.data),
            MAIL_INLINE_IMAGE_MAX_BYTES,
          );
          const storedAt = Math.max(requestedAt, this.readCurrentTime());
          await this.serialized(async () => {
            this.transaction((database) => {
              assertLiveRemoteImage(database, snapshot, this.contentFormatVersion);
              const usage = remoteImageUsage(
                database,
                this.accountId,
                snapshot.providerMessageId,
                snapshot.remoteImageId,
              );
              const rasterPixels =
                raster.width * raster.height * raster.frames;
              if (
                usage.bytes + descriptor.bytes >
                  MAIL_RESOURCE_LIMITS.maxRemoteImageBytesPerMessage ||
                usage.pixels + rasterPixels >
                  MAIL_RESOURCE_LIMITS.maxInlineImagePixels ||
                usage.frames + raster.frames >
                  MAIL_RESOURCE_LIMITS.maxInlineImageFrames
              ) {
                throw remoteImageBudgetExhausted();
              }
              const updated = database
                .prepare(
                  `UPDATE message_content_remote_images
                      SET state = 'ready', mime_type = ?, sha256 = ?, bytes = ?,
                          width = ?, height = ?, frames = ?, retry_at = NULL,
                          updated_at = ?
                    WHERE account_id = ? AND provider_message_id = ?
                      AND remote_image_id = ? AND source_url = ?
                      AND state IN ('pending', 'transient_failure')`,
                )
                .run(
                  mimeType,
                  descriptor.sha256,
                  descriptor.bytes,
                  raster.width,
                  raster.height,
                  raster.frames,
                  storedAt,
                  this.accountId,
                  snapshot.providerMessageId,
                  snapshot.remoteImageId,
                  snapshot.sourceUrl,
                );
              if (updated.changes !== 1) throw notActive();
            });
          });
          return Object.freeze({
            ...remoteImageSnapshotBaseFromSnapshot(snapshot),
            state: "ready" as const,
            mimeType,
            blob: descriptor,
            raster,
          });
        },
      ),
    );
  }

  async markRemoteImageFailure(input: {
    readonly snapshot: CachedMailRemoteImageSnapshot;
    readonly kind: "transient" | "permanent";
    readonly retryAt?: number;
    readonly now: number;
  }): Promise<void> {
    const snapshot = validateRemoteImageSnapshot(input.snapshot, this.accountId);
    if (snapshot.state === "ready" || snapshot.state === "permanent_failure") {
      return;
    }
    const failedAt = validateTimestamp(input.now);
    const retryAt =
      input.kind === "transient"
        ? validateTimestamp(input.retryAt ?? -1)
        : null;
    if (
      (input.kind !== "transient" && input.kind !== "permanent") ||
      (input.kind === "transient" && retryAt! <= failedAt) ||
      (input.kind === "permanent" && input.retryAt !== undefined)
    ) {
      throw invalidRequest();
    }
    await this.serialized(async () => {
      this.transaction((database) => {
        assertLiveRemoteImage(database, snapshot, this.contentFormatVersion);
        const updated = database
          .prepare(
            `UPDATE message_content_remote_images
                SET state = ?, mime_type = NULL, sha256 = NULL,
                    retry_at = ?, updated_at = ?
              WHERE account_id = ? AND provider_message_id = ?
                AND remote_image_id = ? AND source_url = ?
                AND state IN ('pending', 'transient_failure')`,
          )
          .run(
            input.kind === "transient"
              ? "transient_failure"
              : "permanent_failure",
            retryAt,
            failedAt,
            this.accountId,
            snapshot.providerMessageId,
            snapshot.remoteImageId,
            snapshot.sourceUrl,
          );
        if (updated.changes !== 1) throw notActive();
      });
    });
  }

  async invalidateRemoteImage(input: {
    readonly snapshot: CachedMailRemoteImageSnapshot & { readonly state: "ready" };
    readonly now: number;
  }): Promise<boolean> {
    const snapshot = validateRemoteImageSnapshot(input.snapshot, this.accountId);
    if (snapshot.state !== "ready") throw invalidRequest();
    const invalidatedAt = validateTimestamp(input.now);
    return mapContentOperation(async () =>
      this.blobStore.withMutationLease(async (blobLease) => {
        const disposition = await blobLease.discardCorrupt(snapshot.blob);
        if (disposition === "valid") return false;
        return this.serialized(async () =>
          this.transaction((database) => {
            assertLiveRemoteImage(database, snapshot, this.contentFormatVersion);
            const updated = database
              .prepare(
                `UPDATE message_content_remote_images
                    SET state = 'transient_failure', mime_type = NULL,
                        sha256 = NULL, retry_at = ?, updated_at = ?
                  WHERE account_id = ? AND provider_message_id = ?
                    AND remote_image_id = ? AND source_url = ?
                    AND state = 'ready' AND mime_type = ?
                    AND sha256 = ? AND bytes = ?
                    AND width = ? AND height = ? AND frames = ?`,
              )
              .run(
                invalidatedAt + MAIL_RESOURCE_LIMITS.remoteImageTransientRetryMs,
                invalidatedAt,
                this.accountId,
                snapshot.providerMessageId,
                snapshot.remoteImageId,
                snapshot.sourceUrl,
                snapshot.mimeType,
                snapshot.blob.sha256,
                snapshot.blob.bytes,
                snapshot.raster.width,
                snapshot.raster.height,
                snapshot.raster.frames,
              );
            return updated.changes === 1;
          }),
        );
      }),
    );
  }

  /**
   * Invalidates one exact ready snapshot after a verified blob read fails.
   * The blob lease is acquired before SQLite so recovery follows the same
   * lock order as publication and garbage collection.
   */
  async invalidateReady(input: {
    readonly accountId: string;
    readonly providerMessageId: string;
    readonly sourceGeneration: number;
    readonly version: number;
    readonly contentFormatVersion: number;
    readonly failedBlob: MailBlobDescriptor;
    readonly errorCode: string;
    readonly now: number;
  }): Promise<boolean> {
    if (input.accountId !== this.accountId) throw invalidRequest();
    const messageId = validateProviderId(input.providerMessageId);
    const generation = validateGenerationInput(input.sourceGeneration);
    const version = validateVersionInput(input.version);
    const formatVersion = validateContentFormatVersionInput(
      input.contentFormatVersion,
    );
    if (formatVersion !== this.contentFormatVersion) throw invalidRequest();
    const failedBlob = blobDescriptor(input.failedBlob);
    const errorCode = validateErrorCodeInput(input.errorCode);
    const requestedAt = validateTimestamp(input.now);

    return mapContentOperation(async () =>
      this.blobStore.withMutationLease(async (blobLease) => {
        const disposition = await blobLease.discardCorrupt(failedBlob);
        if (disposition === "valid") return false;
        const invalidatedAt = Math.max(requestedAt, this.readCurrentTime());
        return this.serialized(async () =>
          this.transaction((database) => {
            if (
              !readyReferencesDescriptor(database, {
                accountId: this.accountId,
                providerMessageId: messageId,
                sourceGeneration: generation,
                version,
                contentFormatVersion: formatVersion,
                descriptor: failedBlob,
              })
            ) {
              return false;
            }
            if (!Number.isSafeInteger(version + 1)) throw unavailable();
            const updated = database
              .prepare(
                `UPDATE message_content
                    SET version = version + 1, state = 'transient_failure',
                        lease_token = NULL, lease_expires_at = NULL,
                        raw_sha256 = NULL, raw_bytes = NULL,
                        text_sha256 = NULL, text_bytes = NULL,
                        html_sha256 = NULL, html_bytes = NULL,
                        failure_code = ?, updated_at = ?
                  WHERE account_id = ? AND provider_message_id = ?
                    AND source_generation = ? AND version = ?
                    AND content_format_version = ? AND state = 'ready'`,
              )
              .run(
                errorCode,
                invalidatedAt,
                this.accountId,
                messageId,
                generation,
                version,
                formatVersion,
              );
            if (updated.changes !== 1) return false;
            database
              .prepare(
                `DELETE FROM message_content_attachments
                  WHERE account_id = ? AND provider_message_id = ?`,
              )
              .run(this.accountId, messageId);
            database
              .prepare(
                `DELETE FROM message_content_staged_blobs
                  WHERE account_id = ? AND provider_message_id = ?`,
              )
              .run(this.accountId, messageId);
            return true;
          }),
        );
      }),
    );
  }

  async reapExpiredLeases(now: number): Promise<number> {
    const timestamp = validateTimestamp(now);
    return this.serialized(async () =>
      this.transaction((database) => {
        const expired = database
          .prepare(
            `SELECT provider_message_id, lease_token
               FROM message_content
              WHERE account_id = ? AND state = 'fetching'
                AND lease_expires_at <= ?`,
          )
          .all(this.accountId, timestamp);
        for (const row of expired) {
          if (
            typeof row.provider_message_id !== "string" ||
            typeof row.lease_token !== "string"
          ) {
            throw integrityFailed();
          }
          database
            .prepare(
              `DELETE FROM message_content_staged_blobs
                WHERE account_id = ? AND provider_message_id = ?
                  AND lease_token = ?`,
            )
            .run(this.accountId, row.provider_message_id, row.lease_token);
        }
        const updated = database
          .prepare(
            `UPDATE message_content
                SET state = 'transient_failure', lease_token = NULL,
                    lease_expires_at = NULL, failure_code = 'lease_expired',
                    updated_at = ?
              WHERE account_id = ? AND state = 'fetching'
                AND lease_expires_at <= ?`,
          )
          .run(timestamp, this.accountId, timestamp);
        return Number(updated.changes);
      }),
    );
  }

  async collectGarbage(): Promise<readonly MailBlobDescriptor[]> {
    return mapContentOperation(async () =>
      this.blobStore.collectGarbage(async () =>
        this.serialized(async () =>
          this.transaction((database) => {
            deleteOrphanContent(
              database,
              this.accountId,
              this.contentFormatVersion,
            );
            return referencedDescriptors(
              database,
              this.accountId,
              this.contentFormatVersion,
            );
          }),
        ),
      ),
    );
  }

  async evictReadyRemoteImages(input: {
    readonly minimumBytes: number;
    readonly now: number;
  }): Promise<readonly MailBlobDescriptor[]> {
    const minimumBytes = validateReclaimBytes(input.minimumBytes);
    const evictedAt = validateTimestamp(input.now);
    if (minimumBytes === 0) return Object.freeze([]);
    return this.serialized(async () =>
      this.transaction((database) => {
        const rows = database
          .prepare(
            `SELECT remote.remote_image_id, remote.sha256, remote.bytes,
                    remote.width, remote.height, remote.frames
               FROM message_content_remote_images AS remote
               JOIN message_content AS content
                 ON content.account_id = remote.account_id
                AND content.provider_message_id = remote.provider_message_id
               JOIN sync_state AS sync ON sync.account_id = content.account_id
               JOIN messages AS message
                 ON message.account_id = content.account_id
                AND message.generation = content.source_generation
                AND message.message_id = content.provider_message_id
                AND message.thread_id = content.source_thread_id
              WHERE remote.account_id = ? AND remote.state = 'ready'
                AND content.state = 'ready'
                AND content.source_generation = sync.active_generation
                AND content.content_format_version = ?
              ORDER BY remote.updated_at ASC, remote.remote_image_id ASC`,
          )
          .all(this.accountId, this.contentFormatVersion);
        const reclaimable: MailBlobDescriptor[] = [];
        const reclaimableKeys = new Set<string>();
        let reclaimedBytes = 0;
        for (const row of rows) {
          if (reclaimedBytes >= minimumBytes) break;
          if (
            typeof row.remote_image_id !== "string" ||
            !SAFE_REMOTE_IMAGE_ID.test(row.remote_image_id)
          ) {
            throw integrityFailed();
          }
          const descriptor = descriptorFromColumns(row.sha256, row.bytes);
          if (descriptor === null) throw integrityFailed();
          rasterFromColumns(row.width, row.height, row.frames);
          const updated = database
            .prepare(
              `UPDATE message_content_remote_images
                  SET state = 'pending', mime_type = NULL, sha256 = NULL,
                      retry_at = NULL, updated_at = ?
                WHERE account_id = ? AND remote_image_id = ?
                  AND state = 'ready' AND sha256 = ? AND bytes = ?`,
            )
            .run(
              evictedAt,
              this.accountId,
              row.remote_image_id,
              descriptor.sha256,
              descriptor.bytes,
            );
          if (updated.changes !== 1) throw integrityFailed();
          const stillReferenced = referencedDescriptors(
            database,
            this.accountId,
            this.contentFormatVersion,
          ).some(
            (reference) =>
              reference.sha256 === descriptor.sha256 &&
              reference.bytes === descriptor.bytes,
          );
          const descriptorKey = `${descriptor.sha256}:${descriptor.bytes}`;
          if (!stillReferenced && !reclaimableKeys.has(descriptorKey)) {
            reclaimableKeys.add(descriptorKey);
            reclaimable.push(descriptor);
            reclaimedBytes += descriptor.bytes;
          }
        }
        return Object.freeze(reclaimable);
      }),
    );
  }

  private async reclaimCapacity(now: number, minimumBytes: number): Promise<void> {
    if (this.capacityReclaimer !== null) {
      await this.capacityReclaimer.reclaim(now, minimumBytes);
      return;
    }
    await this.evictReadyRemoteImages({ minimumBytes, now });
    await this.reapExpiredLeases(now);
    await this.collectGarbage();
  }

  private transaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.requireDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw contentError(error);
    }
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = databaseTails.get(this.databasePath) ?? Promise.resolve();
    const run = previous.then(operation, operation).catch((error: unknown) => {
      throw contentError(error);
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    databaseTails.set(this.databasePath, tail);
    void tail.then(() => {
      if (databaseTails.get(this.databasePath) === tail) {
        databaseTails.delete(this.databasePath);
      }
    });
    return run;
  }

  private requireDatabase(): DatabaseSync {
    if (this.database === null || this.closed) throw unavailable();
    return this.database;
  }

  private readCurrentTime(): number {
    let value: number;
    try {
      value = this.clock();
    } catch {
      throw unavailable();
    }
    if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
    return value;
  }
}

function activeMessage(
  database: DatabaseSync,
  accountId: string,
  messageId: string,
): { readonly generation: number; readonly threadId: string } | null {
  const row = database
    .prepare(
      `SELECT sync.active_generation AS generation, message.thread_id
         FROM sync_state AS sync
         JOIN messages AS message
           ON message.account_id = sync.account_id
          AND message.generation = sync.active_generation
        WHERE sync.account_id = ? AND message.message_id = ?
          AND sync.active_generation > 0`,
    )
    .get(accountId, messageId);
  if (row === undefined) return null;
  if (typeof row.thread_id !== "string" || !SAFE_PROVIDER_ID.test(row.thread_id)) {
    throw integrityFailed();
  }
  return Object.freeze({
    generation: validateGeneration(row.generation),
    threadId: row.thread_id,
  });
}

function contentState(
  database: DatabaseSync,
  accountId: string,
  messageId: string,
): Record<string, unknown> | null {
  const row = database
    .prepare(
      `SELECT source_thread_id, source_generation, version,
              content_format_version, state,
              lease_expires_at, failure_code, updated_at,
              raw_sha256, raw_bytes, text_sha256, text_bytes,
              html_sha256, html_bytes
         FROM message_content
        WHERE account_id = ? AND provider_message_id = ?`,
    )
    .get(accountId, messageId);
  if (row === undefined) return null;
  validateGeneration(row.source_generation);
  validateVersion(row.version);
  validatePositiveInteger(row.content_format_version);
  validateTimestampState(row.updated_at);
  if (
    typeof row.source_thread_id !== "string" ||
    !SAFE_PROVIDER_ID.test(row.source_thread_id)
  ) {
    throw integrityFailed();
  }
  if (
    row.state !== "fetching" &&
    row.state !== "ready" &&
    row.state !== "transient_failure" &&
    row.state !== "permanent_failure"
  ) {
    throw integrityFailed();
  }
  if (
    (row.lease_expires_at !== null &&
      (!Number.isSafeInteger(row.lease_expires_at) ||
        (row.lease_expires_at as number) < 0)) ||
    (row.failure_code !== null && typeof row.failure_code !== "string")
  ) {
    throw integrityFailed();
  }
  return row;
}

function assertLiveLease(
  database: DatabaseSync,
  lease: MailContentLease,
  now: number,
  contentFormatVersion: number,
): void {
  const row = database
    .prepare(
      `SELECT content.version, content.content_format_version,
              content.lease_token, content.lease_expires_at
         FROM message_content AS content
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
        WHERE content.account_id = ? AND content.provider_message_id = ?
          AND content.source_generation = ? AND content.state = 'fetching'
          AND content.source_generation = sync.active_generation`,
    )
    .get(lease.accountId, lease.providerMessageId, lease.sourceGeneration);
  if (
    row === undefined ||
    row.version !== lease.version ||
    row.content_format_version !== contentFormatVersion ||
    row.lease_token !== lease.token ||
    row.lease_expires_at !== lease.expiresAt ||
    typeof row.lease_expires_at !== "number" ||
    row.lease_expires_at <= now
  ) {
    throw staleLease();
  }
}

function assertDescriptorsStaged(
  database: DatabaseSync,
  lease: MailContentLease,
  descriptors: ReadonlyMap<string, MailBlobDescriptor>,
): void {
  const rows = database
    .prepare(
      `SELECT sha256, bytes FROM message_content_staged_blobs
        WHERE account_id = ? AND provider_message_id = ? AND lease_token = ?`,
    )
    .all(lease.accountId, lease.providerMessageId, lease.token);
  const staged = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.sha256 !== "string" || typeof row.bytes !== "number") {
      throw integrityFailed();
    }
    staged.set(row.sha256, row.bytes);
  }
  for (const descriptor of descriptors.values()) {
    if (staged.get(descriptor.sha256) !== descriptor.bytes) throw staleLease();
  }
}

function stagedDescriptorExists(
  database: DatabaseSync,
  lease: MailContentLease,
  descriptor: MailBlobDescriptor,
): boolean {
  const row = database
    .prepare(
      `SELECT bytes FROM message_content_staged_blobs
        WHERE account_id = ? AND provider_message_id = ?
          AND lease_token = ? AND sha256 = ?`,
    )
    .get(
      lease.accountId,
      lease.providerMessageId,
      lease.token,
      descriptor.sha256,
    );
  if (row === undefined) return false;
  if (row.bytes !== descriptor.bytes) throw integrityFailed();
  return true;
}

function stageDescriptor(
  database: DatabaseSync,
  lease: MailContentLease,
  descriptor: MailBlobDescriptor,
  stagedAt: number,
): void {
  if (stagedDescriptorExists(database, lease, descriptor)) return;
  database
    .prepare(
      `INSERT INTO message_content_staged_blobs(
         account_id, provider_message_id, lease_token, sha256, bytes, staged_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      lease.accountId,
      lease.providerMessageId,
      lease.token,
      descriptor.sha256,
      descriptor.bytes,
      stagedAt,
    );
}

function readyReferencesDescriptor(
  database: DatabaseSync,
  input: {
    readonly accountId: string;
    readonly providerMessageId: string;
    readonly sourceGeneration: number;
    readonly version: number;
    readonly contentFormatVersion: number;
    readonly descriptor: MailBlobDescriptor;
  },
): boolean {
  const { descriptor } = input;
  return (
    database
      .prepare(
        `SELECT 1
           FROM message_content AS content
           JOIN sync_state AS sync ON sync.account_id = content.account_id
           JOIN messages AS message
             ON message.account_id = content.account_id
            AND message.generation = content.source_generation
            AND message.message_id = content.provider_message_id
            AND message.thread_id = content.source_thread_id
          WHERE content.account_id = ? AND content.provider_message_id = ?
            AND content.source_generation = ? AND content.version = ?
            AND content.content_format_version = ? AND content.state = 'ready'
            AND content.source_generation = sync.active_generation
            AND (
              (content.raw_sha256 = ? AND content.raw_bytes = ?) OR
              (content.text_sha256 = ? AND content.text_bytes = ?) OR
              (content.html_sha256 = ? AND content.html_bytes = ?) OR
              EXISTS (
                SELECT 1
                  FROM message_content_attachments AS attachment
                 WHERE attachment.account_id = content.account_id
                   AND attachment.provider_message_id = content.provider_message_id
                   AND attachment.sha256 = ? AND attachment.bytes = ?
              )
            )`,
      )
      .get(
        input.accountId,
        input.providerMessageId,
        input.sourceGeneration,
        input.version,
        input.contentFormatVersion,
        descriptor.sha256,
        descriptor.bytes,
        descriptor.sha256,
        descriptor.bytes,
        descriptor.sha256,
        descriptor.bytes,
        descriptor.sha256,
        descriptor.bytes,
      ) !== undefined
  );
}

function contentFromRow(
  database: DatabaseSync,
  accountId: string,
  messageId: string,
  row: Record<string, unknown>,
): CachedMailContent {
  const rawMime = nonEmptyDescriptorFromColumns(row.raw_sha256, row.raw_bytes);
  if (rawMime === null) throw integrityFailed();
  const attachments = database
    .prepare(
      `SELECT attachment_id, ordinal, filename, mime_type, disposition,
              content_id, sha256, bytes
         FROM message_content_attachments
        WHERE account_id = ? AND provider_message_id = ?
        ORDER BY ordinal ASC`,
    )
    .all(accountId, messageId)
    .map(attachmentFromRow);
  return Object.freeze({
    accountId,
    providerMessageId: messageId,
    sourceGeneration: validateGeneration(row.source_generation),
    version: validateVersion(row.version),
    contentFormatVersion: validatePositiveInteger(row.content_format_version),
    rawMime,
    text: optionalNonEmptyDescriptorFromColumns(row.text_sha256, row.text_bytes),
    sanitizedHtml: optionalNonEmptyDescriptorFromColumns(
      row.html_sha256,
      row.html_bytes,
    ),
    attachments: Object.freeze(attachments),
  });
}

function attachmentFromRow(row: Record<string, unknown>): CachedMailAttachment {
  if (
    typeof row.attachment_id !== "string" ||
    !SAFE_ATTACHMENT_ID.test(row.attachment_id) ||
    !Number.isSafeInteger(row.ordinal) ||
    typeof row.mime_type !== "string" ||
    (row.disposition !== "attachment" && row.disposition !== "inline")
  ) {
    throw integrityFailed();
  }
  return Object.freeze({
    attachmentId: row.attachment_id,
    ordinal: row.ordinal as number,
    filename: validateOptionalText(row.filename, MAX_FILENAME_BYTES),
    mimeType: validateMimeType(row.mime_type),
    disposition: row.disposition,
    contentId: validateOptionalText(row.content_id, MAX_CONTENT_ID_BYTES),
    blob: descriptorFromColumns(row.sha256, row.bytes) ?? (() => { throw integrityFailed(); })(),
  });
}

function referencedDescriptors(
  database: DatabaseSync,
  accountId: string,
  contentFormatVersion: number,
): readonly MailBlobDescriptor[] {
  const rows = database
    .prepare(
      `SELECT content.raw_sha256 AS sha256, content.raw_bytes AS bytes
         FROM message_content AS content
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
        WHERE content.account_id = ? AND content.state = 'ready'
          AND content.source_generation = sync.active_generation
          AND content.content_format_version = ?
       UNION ALL
       SELECT content.text_sha256, content.text_bytes
         FROM message_content AS content
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
        WHERE content.account_id = ? AND content.state = 'ready'
          AND content.source_generation = sync.active_generation
          AND content.content_format_version = ?
          AND content.text_sha256 IS NOT NULL
       UNION ALL
       SELECT content.html_sha256, content.html_bytes
         FROM message_content AS content
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
        WHERE content.account_id = ? AND content.state = 'ready'
          AND content.source_generation = sync.active_generation
          AND content.content_format_version = ?
          AND content.html_sha256 IS NOT NULL
       UNION ALL
       SELECT attachment.sha256, attachment.bytes
         FROM message_content_attachments AS attachment
         JOIN message_content AS content
           ON content.account_id = attachment.account_id
          AND content.provider_message_id = attachment.provider_message_id
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
       WHERE attachment.account_id = ? AND content.state = 'ready'
          AND content.source_generation = sync.active_generation
          AND content.content_format_version = ?
       UNION ALL
       SELECT remote.sha256, remote.bytes
         FROM message_content_remote_images AS remote
         JOIN message_content AS content
           ON content.account_id = remote.account_id
          AND content.provider_message_id = remote.provider_message_id
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
        WHERE remote.account_id = ? AND remote.state = 'ready'
          AND content.state = 'ready'
          AND content.source_generation = sync.active_generation
          AND content.content_format_version = ?
       UNION ALL
       SELECT sha256, bytes FROM message_content_staged_blobs WHERE account_id = ?`,
    )
    .all(
      accountId,
      contentFormatVersion,
      accountId,
      contentFormatVersion,
      accountId,
      contentFormatVersion,
      accountId,
      contentFormatVersion,
      accountId,
      contentFormatVersion,
      accountId,
    );
  return Object.freeze(
    rows.map((row) => {
      const descriptor = descriptorFromColumns(row.sha256, row.bytes);
      if (descriptor === null) throw integrityFailed();
      return descriptor;
    }),
  );
}

function deleteOrphanContent(
  database: DatabaseSync,
  accountId: string,
  contentFormatVersion: number,
): void {
  database
    .prepare(
      `DELETE FROM message_content AS content
        WHERE content.account_id = ?
          AND (
            content.content_format_version <> ? OR
            NOT EXISTS (
              SELECT 1
                FROM sync_state AS sync
                JOIN messages AS message
                  ON message.account_id = sync.account_id
                 AND message.generation = sync.active_generation
               WHERE sync.account_id = content.account_id
                 AND sync.active_generation = content.source_generation
                 AND message.message_id = content.provider_message_id
                 AND message.thread_id = content.source_thread_id
            )
          )`,
    )
    .run(accountId, contentFormatVersion);
}

function validateAttachments(
  value: readonly MailContentAttachmentInput[],
): readonly MailContentAttachmentInput[] {
  if (!Array.isArray(value) || value.length > MAIL_RESOURCE_LIMITS.mimeParts) {
    throw invalidRequest();
  }
  return Object.freeze(
    value.map((attachment) => {
      if (
        attachment === null ||
        typeof attachment !== "object" ||
        (attachment.disposition !== "attachment" &&
          attachment.disposition !== "inline")
      ) {
        throw invalidRequest();
      }
      return Object.freeze({
        filename: validateOptionalText(attachment.filename, MAX_FILENAME_BYTES),
        mimeType: validateMimeType(attachment.mimeType),
        disposition: attachment.disposition,
        contentId: validateOptionalText(attachment.contentId, MAX_CONTENT_ID_BYTES),
        blob: blobDescriptor(attachment.blob),
      });
    }),
  );
}

function reusableReadyRemoteImages(
  database: DatabaseSync,
  accountId: string,
  providerMessageId: string,
  requestedImages: readonly MailContentRemoteImageInput[],
): readonly ReusableReadyRemoteImage[] {
  const requestedUrls = new Set(
    requestedImages.map((remoteImage) => remoteImage.sourceUrl),
  );
  if (requestedUrls.size === 0) return Object.freeze([]);
  const reusable = new Map<string, ReusableReadyRemoteImage>();
  const rows = database
    .prepare(
      `SELECT source_url, mime_type, sha256, bytes, width, height, frames
         FROM message_content_remote_images
        WHERE account_id = ? AND provider_message_id = ? AND state = 'ready'`,
    )
    .all(accountId, providerMessageId);
  for (const row of rows) {
    let sourceUrl: string;
    try {
      sourceUrl = validateMailRemoteImageSourceUrl(row.source_url);
    } catch {
      throw integrityFailed();
    }
    if (!requestedUrls.has(sourceUrl)) continue;
    if (reusable.has(sourceUrl)) throw integrityFailed();
    const blob = descriptorFromColumns(row.sha256, row.bytes);
    if (blob === null) throw integrityFailed();
    let mimeType: string;
    let raster: VerifiedMailRaster;
    try {
      mimeType = validateRemoteImageMimeType(row.mime_type);
      raster = rasterFromColumns(row.width, row.height, row.frames);
    } catch {
      throw integrityFailed();
    }
    reusable.set(
      sourceUrl,
      Object.freeze({ sourceUrl, mimeType, blob, raster }),
    );
  }
  return Object.freeze([...reusable.values()]);
}

function validateRemoteImages(
  value: readonly MailContentRemoteImageInput[],
): readonly MailContentRemoteImageInput[] {
  if (
    !Array.isArray(value) ||
    value.length > MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage
  ) {
    throw invalidRequest();
  }
  const ids = new Set<string>();
  const urls = new Set<string>();
  return Object.freeze(
    value.map((remoteImage) => {
      if (remoteImage === null || typeof remoteImage !== "object") {
        throw invalidRequest();
      }
      const remoteImageId = validateRemoteImageId(remoteImage.remoteImageId);
      let sourceUrl: string;
      try {
        sourceUrl = validateMailRemoteImageSourceUrl(remoteImage.sourceUrl);
      } catch {
        throw invalidRequest();
      }
      if (ids.has(remoteImageId) || urls.has(sourceUrl)) throw invalidRequest();
      ids.add(remoteImageId);
      urls.add(sourceUrl);
      return Object.freeze({ remoteImageId, sourceUrl });
    }),
  );
}

const REMOTE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function validateRemoteImageMimeType(value: unknown): string {
  const mimeType = validateMimeType(value);
  if (!REMOTE_IMAGE_MIME_TYPES.has(mimeType)) throw invalidRequest();
  return mimeType;
}

function validateRemoteImageRaster(value: unknown): VerifiedMailRaster {
  if (
    value === null ||
    typeof value !== "object" ||
    !("width" in value) ||
    !("height" in value) ||
    !("frames" in value)
  ) {
    throw invalidRequest();
  }
  const width = value.width;
  const height = value.height;
  const frames = value.frames;
  if (
    !Number.isSafeInteger(width) ||
    (width as number) < 1 ||
    !Number.isSafeInteger(height) ||
    (height as number) < 1 ||
    !Number.isSafeInteger(frames) ||
    (frames as number) < 1 ||
    (frames as number) > MAIL_RESOURCE_LIMITS.maxInlineImageFrames ||
    BigInt(width as number) * BigInt(height as number) * BigInt(frames as number) >
      BigInt(MAIL_RESOURCE_LIMITS.maxInlineImagePixels)
  ) {
    throw invalidRequest();
  }
  return Object.freeze({
    width: width as number,
    height: height as number,
    frames: frames as number,
  });
}

function rasterFromColumns(
  width: unknown,
  height: unknown,
  frames: unknown,
): VerifiedMailRaster {
  try {
    return validateRemoteImageRaster({ width, height, frames });
  } catch {
    throw integrityFailed();
  }
}

function remoteImageUsage(
  database: DatabaseSync,
  accountId: string,
  providerMessageId: string,
  excludedRemoteImageId: string,
): { readonly bytes: number; readonly pixels: number; readonly frames: number } {
  const rows = database
    .prepare(
      `SELECT state, sha256, bytes, width, height, frames
         FROM message_content_remote_images
        WHERE account_id = ? AND provider_message_id = ?
          AND remote_image_id <> ? AND bytes IS NOT NULL`,
    )
    .all(accountId, providerMessageId, excludedRemoteImageId);
  let bytes = 0;
  let pixels = 0;
  let frames = 0;
  for (const row of rows) {
    let reservedBytes: number;
    if (row.state === "ready") {
      const descriptor = descriptorFromColumns(row.sha256, row.bytes);
      if (descriptor === null || descriptor.bytes > MAIL_INLINE_IMAGE_MAX_BYTES) {
        throw integrityFailed();
      }
      reservedBytes = descriptor.bytes;
    } else if (
      (row.state === "pending" ||
        row.state === "transient_failure" ||
        row.state === "permanent_failure") &&
      row.sha256 === null &&
      typeof row.bytes === "number" &&
      Number.isSafeInteger(row.bytes) &&
      row.bytes >= 1 &&
      row.bytes <= MAIL_INLINE_IMAGE_MAX_BYTES
    ) {
      reservedBytes = row.bytes;
    } else {
      throw integrityFailed();
    }
    const raster = rasterFromColumns(row.width, row.height, row.frames);
    bytes += reservedBytes;
    pixels += raster.width * raster.height * raster.frames;
    frames += raster.frames;
  }
  if (
    !Number.isSafeInteger(bytes) ||
    bytes > MAIL_RESOURCE_LIMITS.maxRemoteImageBytesPerMessage ||
    !Number.isSafeInteger(pixels) ||
    pixels > MAIL_RESOURCE_LIMITS.maxInlineImagePixels ||
    !Number.isSafeInteger(frames) ||
    frames > MAIL_RESOURCE_LIMITS.maxInlineImageFrames
  ) {
    throw integrityFailed();
  }
  return Object.freeze({ bytes, pixels, frames });
}

function remoteImageSnapshotBase(
  accountId: string,
  row: Record<string, unknown>,
): CachedMailRemoteImageSnapshotBase {
  if (
    typeof row.provider_message_id !== "string" ||
    !SAFE_PROVIDER_ID.test(row.provider_message_id) ||
    typeof row.remote_image_id !== "string" ||
    !SAFE_REMOTE_IMAGE_ID.test(row.remote_image_id)
  ) {
    throw integrityFailed();
  }
  let sourceUrl: string;
  try {
    sourceUrl = validateMailRemoteImageSourceUrl(row.source_url);
  } catch {
    throw integrityFailed();
  }
  return Object.freeze({
    accountId,
    providerMessageId: row.provider_message_id,
    sourceGeneration: validateGeneration(row.source_generation),
    version: validateVersion(row.version),
    contentFormatVersion: validatePositiveInteger(row.content_format_version),
    remoteImageId: row.remote_image_id,
    sourceUrl,
  });
}

function remoteImageSnapshotBaseFromSnapshot(
  snapshot: CachedMailRemoteImageSnapshot,
): CachedMailRemoteImageSnapshotBase {
  return Object.freeze({
    accountId: snapshot.accountId,
    providerMessageId: snapshot.providerMessageId,
    sourceGeneration: snapshot.sourceGeneration,
    version: snapshot.version,
    contentFormatVersion: snapshot.contentFormatVersion,
    remoteImageId: snapshot.remoteImageId,
    sourceUrl: snapshot.sourceUrl,
  });
}

function validateRemoteImageSnapshot(
  value: CachedMailRemoteImageSnapshot,
  accountId: string,
): CachedMailRemoteImageSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    value.accountId !== accountId ||
    !SAFE_PROVIDER_ID.test(value.providerMessageId) ||
    !SAFE_REMOTE_IMAGE_ID.test(value.remoteImageId)
  ) {
    throw invalidRequest();
  }
  let sourceUrl: string;
  try {
    sourceUrl = validateMailRemoteImageSourceUrl(value.sourceUrl);
  } catch {
    throw invalidRequest();
  }
  const base = Object.freeze({
    accountId,
    providerMessageId: value.providerMessageId,
    sourceGeneration: validateGenerationInput(value.sourceGeneration),
    version: validateVersionInput(value.version),
    contentFormatVersion: validateContentFormatVersionInput(
      value.contentFormatVersion,
    ),
    remoteImageId: value.remoteImageId,
    sourceUrl,
  });
  if (value.state === "pending" || value.state === "permanent_failure") {
    return Object.freeze({ ...base, state: value.state });
  }
  if (value.state === "transient_failure") {
    return Object.freeze({
      ...base,
      state: value.state,
      retryAt: validateTimestamp(value.retryAt),
    });
  }
  if (value.state !== "ready") throw invalidRequest();
  return Object.freeze({
    ...base,
    state: "ready" as const,
    mimeType: validateRemoteImageMimeType(value.mimeType),
    blob: blobDescriptor(value.blob),
    raster: validateRemoteImageRaster(value.raster),
  });
}

function assertLiveRemoteImage(
  database: DatabaseSync,
  snapshot: CachedMailRemoteImageSnapshot,
  contentFormatVersion: number,
): void {
  const row = database
    .prepare(
      `SELECT remote.source_url, content.source_generation, content.version,
              content.content_format_version, content.state
         FROM message_content_remote_images AS remote
         JOIN message_content AS content
           ON content.account_id = remote.account_id
          AND content.provider_message_id = remote.provider_message_id
         JOIN sync_state AS sync ON sync.account_id = content.account_id
         JOIN messages AS message
           ON message.account_id = content.account_id
          AND message.generation = content.source_generation
          AND message.message_id = content.provider_message_id
          AND message.thread_id = content.source_thread_id
        WHERE remote.account_id = ? AND remote.provider_message_id = ?
          AND remote.remote_image_id = ?
          AND content.source_generation = sync.active_generation`,
    )
    .get(
      snapshot.accountId,
      snapshot.providerMessageId,
      snapshot.remoteImageId,
    );
  if (
    row === undefined ||
    row.source_url !== snapshot.sourceUrl ||
    row.source_generation !== snapshot.sourceGeneration ||
    row.version !== snapshot.version ||
    row.content_format_version !== snapshot.contentFormatVersion ||
    row.content_format_version !== contentFormatVersion ||
    row.state !== "ready"
  ) {
    throw notActive();
  }
}

async function* oneChunk(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.byteLength > 0) yield data;
}

function uniqueDescriptors(
  values: readonly MailBlobDescriptor[],
): ReadonlyMap<string, MailBlobDescriptor> {
  const result = new Map<string, MailBlobDescriptor>();
  for (const value of values) {
    const existing = result.get(value.sha256);
    if (existing !== undefined && existing.bytes !== value.bytes) {
      throw invalidRequest();
    }
    result.set(value.sha256, value);
  }
  return result;
}

function allocateAttachmentId(database: DatabaseSync, accountId: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = `attachment-a${randomBytes(16).toString("hex")}`;
    if (
      database
        .prepare(
          `SELECT 1 FROM message_content_attachments
            WHERE account_id = ? AND attachment_id = ?`,
        )
        .get(accountId, value) === undefined
    ) {
      return value;
    }
  }
  throw unavailable();
}

function validateLease(value: MailContentLease, accountId: string): MailContentLease {
  if (
    value === null ||
    typeof value !== "object" ||
    value.accountId !== accountId ||
    !SAFE_PROVIDER_ID.test(value.providerMessageId) ||
    !SAFE_LEASE_TOKEN.test(value.token)
  ) {
    throw invalidRequest();
  }
  return Object.freeze({
    accountId,
    providerMessageId: value.providerMessageId,
    sourceGeneration: validateGeneration(value.sourceGeneration),
    version: validateVersion(value.version),
    token: value.token,
    expiresAt: validateTimestamp(value.expiresAt),
  });
}

function descriptorFromColumns(
  sha256: unknown,
  bytes: unknown,
): MailBlobDescriptor | null {
  if (sha256 === null && bytes === null) return null;
  if (typeof sha256 !== "string" || typeof bytes !== "number") {
    throw integrityFailed();
  }
  try {
    return validateMailBlobDescriptor({ sha256, bytes });
  } catch {
    throw integrityFailed();
  }
}

function optionalNonEmptyBlobDescriptor(
  value: MailBlobDescriptor | null,
): MailBlobDescriptor | null {
  return value === null ? null : nonEmptyBlobDescriptor(value);
}

function nonEmptyBlobDescriptor(value: MailBlobDescriptor): MailBlobDescriptor {
  const descriptor = blobDescriptor(value);
  if (descriptor.bytes === 0) throw invalidRequest();
  return descriptor;
}

function blobDescriptor(value: MailBlobDescriptor): MailBlobDescriptor {
  try {
    return validateMailBlobDescriptor(value);
  } catch {
    throw invalidRequest();
  }
}

function nonEmptyDescriptorFromColumns(
  sha256: unknown,
  bytes: unknown,
): MailBlobDescriptor {
  const descriptor = descriptorFromColumns(sha256, bytes);
  if (descriptor === null || descriptor.bytes === 0) throw integrityFailed();
  return descriptor;
}

function optionalNonEmptyDescriptorFromColumns(
  sha256: unknown,
  bytes: unknown,
): MailBlobDescriptor | null {
  const descriptor = descriptorFromColumns(sha256, bytes);
  if (descriptor?.bytes === 0) throw integrityFailed();
  return descriptor;
}

function validateMimeType(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !MIME_TYPE.test(value)
  ) {
    throw invalidRequest();
  }
  return value.toLowerCase();
}

function validateOptionalText(value: unknown, maxBytes: number): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidRequest();
  }
  return value;
}

function validateProviderId(value: string): string {
  if (!SAFE_PROVIDER_ID.test(value)) throw invalidRequest();
  return value;
}

function validateAttachmentId(value: string): string {
  if (!SAFE_ATTACHMENT_ID.test(value)) throw invalidRequest();
  return value;
}

function validateRemoteImageId(value: string): string {
  if (!SAFE_REMOTE_IMAGE_ID.test(value)) throw invalidRequest();
  return value;
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) throw invalidRequest();
  return value;
}

function validateGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw integrityFailed();
  return value as number;
}

function validateGenerationInput(value: unknown): number {
  try {
    return validateGeneration(value);
  } catch {
    throw invalidRequest();
  }
}

function validateVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw integrityFailed();
  return value as number;
}

function validateVersionInput(value: unknown): number {
  try {
    return validateVersion(value);
  } catch {
    throw invalidRequest();
  }
}

function validatePositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw integrityFailed();
  return value as number;
}

function validateContentFormatVersionInput(value: unknown): number {
  try {
    return validatePositiveInteger(value);
  } catch {
    throw invalidRequest();
  }
}

function validateTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidRequest();
  return value;
}

function validateTimestampState(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw integrityFailed();
  }
  return value as number;
}

function validateReclaimBytes(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAIL_RESOURCE_LIMITS.maxCacheBytes
  ) {
    throw invalidRequest();
  }
  return value as number;
}

function incomingByteLimit(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAIL_RESOURCE_LIMITS.rawMessageBytes
  ) {
    throw invalidRequest();
  }
  return value as number;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function"
  );
}

function validateErrorCode(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ERROR_CODE.test(value)) {
    throw integrityFailed();
  }
  return value;
}

function validateErrorCodeInput(value: unknown): string {
  try {
    return validateErrorCode(value);
  } catch {
    throw invalidRequest();
  }
}

function requireAbsolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw invalidRequest();
  }
  return value;
}

function assertSchemaVersion(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get();
  if (row?.user_version !== MESSAGE_CACHE_SCHEMA_VERSION) throw unavailable();
}

function ensureContentFormatColumn(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA table_info(message_content)").all();
  let column = rows.find((row) => row.name === "content_format_version");
  if (column === undefined) {
    database.exec(`
      ALTER TABLE message_content
        ADD COLUMN content_format_version INTEGER NOT NULL DEFAULT 1
        CHECK(content_format_version > 0)
    `);
    column = database
      .prepare("PRAGMA table_info(message_content)")
      .all()
      .find((row) => row.name === "content_format_version");
  }
  if (
    column === undefined ||
    column.type !== "INTEGER" ||
    column.notnull !== 1 ||
    column.dflt_value !== "1" ||
    column.pk !== 0
  ) {
    throw integrityFailed();
  }
}

function ensureRemoteImageRasterColumns(database: DatabaseSync): void {
  let rows = database
    .prepare("PRAGMA table_info(message_content_remote_images)")
    .all();
  for (const name of ["width", "height", "frames"] as const) {
    if (!rows.some((row) => row.name === name)) {
      database.exec(
        `ALTER TABLE message_content_remote_images ADD COLUMN ${name} INTEGER`,
      );
      rows = database
        .prepare("PRAGMA table_info(message_content_remote_images)")
        .all();
    }
    const column = rows.find((row) => row.name === name);
    if (
      column === undefined ||
      column.type !== "INTEGER" ||
      column.notnull !== 0 ||
      column.dflt_value !== null ||
      column.pk !== 0
    ) {
      throw integrityFailed();
    }
  }
}

async function assertSchemaVersionReadOnly(
  databasePath: string,
  expected: { readonly dev: number; readonly ino: number },
): Promise<void> {
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: SQLITE_BUSY_TIMEOUT_MS,
    });
    const openedPath = await assertPrivateDatabase(databasePath);
    if (openedPath.dev !== expected.dev || openedPath.ino !== expected.ino) {
      throw integrityFailed();
    }
    assertSchemaVersion(database);
  } catch (error) {
    throw contentError(error);
  } finally {
    database?.close();
  }
}

async function assertPrivateDirectory(directoryPath: string): Promise<void> {
  const value = await lstat(directoryPath);
  if (
    !value.isDirectory() ||
    value.isSymbolicLink() ||
    (value.mode & 0o077) !== 0 ||
    value.uid !== effectiveUid()
  ) {
    throw integrityFailed();
  }
}

async function assertContained(parent: string, child: string): Promise<void> {
  const parentReal = await realpath(parent);
  const childReal = await realpath(child);
  if (!childReal.startsWith(`${parentReal}${path.sep}`)) throw integrityFailed();
}

async function assertPrivateDatabase(databasePath: string): Promise<{
  readonly dev: number;
  readonly ino: number;
}> {
  const value = await lstat(databasePath);
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1 ||
    (value.mode & 0o077) !== 0 ||
    value.uid !== effectiveUid()
  ) {
    throw integrityFailed();
  }
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

async function secureSqliteFiles(databasePath: string): Promise<void> {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const value = await lstat(candidate);
      if (
        !value.isFile() ||
        value.isSymbolicLink() ||
        value.nlink !== 1 ||
        value.uid !== effectiveUid()
      ) {
        throw integrityFailed();
      }
      await chmod(candidate, 0o600);
    } catch (error) {
      if (!isFileError(error, "ENOENT")) throw error;
    }
  }
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") throw unavailable();
  const value = process.geteuid();
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}

function isFileError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function invalidRequest(): MailContentCacheError {
  return new MailContentCacheError("mail_content_request_invalid");
}

function staleLease(): MailContentCacheError {
  return new MailContentCacheError("mail_content_lease_stale");
}

function notActive(): MailContentCacheError {
  return new MailContentCacheError("mail_content_not_active");
}

function remoteImageBudgetExhausted(): MailContentCacheError {
  return new MailContentCacheError(
    "mail_content_remote_image_budget_exhausted",
  );
}

function integrityFailed(): MailContentCacheError {
  return new MailContentCacheError("mail_content_integrity_failed");
}

function unavailable(): MailContentCacheError {
  return new MailContentCacheError("mail_content_cache_unavailable");
}

function contentError(error: unknown): MailContentCacheError {
  if (error instanceof MailContentCacheError) return error;
  if (error instanceof MailBlobStoreError) {
    if (error.code === "mail_blob_request_invalid") return invalidRequest();
    if (error.code === "mail_blob_cache_capacity_exhausted") {
      return new MailContentCacheError("mail_content_cache_capacity_exhausted");
    }
    if (
      error.code === "mail_blob_integrity_failed" ||
      error.code === "mail_blob_not_found"
    ) {
      return integrityFailed();
    }
  }
  return unavailable();
}

async function mapContentOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw contentError(error);
  }
}
