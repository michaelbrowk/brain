import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  MailBlobDescriptor,
  MailIncomingBlobStorePort,
} from "../ports";
import {
  MAIL_RESOURCE_LIMITS,
  validateMailBlobDescriptor,
} from "../security";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const PUBLISHED_BLOB = /^[a-f0-9]{64}$/;
const TEMPORARY_BLOB = /^\.tmp-([a-f0-9]{64})-([a-f0-9]{32})$/;
const LEGACY_SNAPSHOT = /^\.snapshot-[a-f0-9]{32}$/;
const READ_CHUNK_BYTES = 64 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
const MUTATION_LOCK_FILE = ".content-blobs.lock.sqlite3";
const DEFAULT_MIN_CACHE_FREE_BYTES = MAIL_RESOURCE_LIMITS.maxTemporaryBytes;

/**
 * A process-local queue complements SQLite's cross-process writer lock. Without
 * it, a second DatabaseSync BEGIN IMMEDIATE in this process could block the
 * event loop while the first async filesystem mutation still needs it.
 */
const mutationTails = new Map<string, Promise<void>>();

export type MailBlobStoreErrorCode =
  | "mail_blob_request_invalid"
  | "mail_blob_not_found"
  | "mail_blob_integrity_failed"
  | "mail_blob_cache_capacity_exhausted"
  | "mail_blob_store_unavailable";

export class MailBlobStoreError extends Error {
  constructor(readonly code: MailBlobStoreErrorCode) {
    super(code);
    this.name = "MailBlobStoreError";
  }
}

export interface MailBlobMutationLease {
  has(descriptor: MailBlobDescriptor): Promise<boolean>;
  discardCorrupt(
    descriptor: MailBlobDescriptor,
  ): Promise<"valid" | "metadata_mismatch" | "missing" | "discarded">;
  put(
    descriptor: MailBlobDescriptor,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void>;
  putIncoming(
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<MailBlobDescriptor>;
  remove(descriptor: MailBlobDescriptor): Promise<void>;
  removeUnreferenced(
    referenced: readonly MailBlobDescriptor[],
  ): Promise<readonly MailBlobDescriptor[]>;
  cleanupTemporaryFiles(input: {
    readonly now: number;
    readonly olderThanMs: number;
  }): Promise<number>;
}

export interface MailBlobReadSnapshot {
  readonly bytes: number;
  readonly body: AsyncIterable<Uint8Array>;
  dispose(): Promise<void>;
}

/**
 * Rebuildable, account-scoped content-addressed storage.
 *
 * Publication is temp -> hash/size check -> fsync -> chmod -> no-clobber link
 * -> unlink temp -> directory fsync. Public callers never supply a path or
 * filename. Published inodes are immutable to this module.
 *
 * Trust boundary: cacheRoot must be a service-owned 0700 tree. The store
 * detects path/inode substitution around every operation, but cannot make a
 * same-UID process with arbitrary filesystem access harmless because Node does
 * not expose fd-relative unlinkat(2). Reads still fail closed and serve only a
 * fully verified in-memory snapshot.
 */
export class AtomicMailBlobStore implements MailIncomingBlobStorePort {
  readonly accountId: string;
  readonly directoryPath: string;

  private readonly cacheRoot: string;
  private readonly accountDirectory: string;
  private readonly mutationLockPath: string;
  private readonly maxCacheBytes: number;
  private readonly minCacheFreeBytes: number;
  private initialized = false;
  private closed = false;
  private mutationDatabase: DatabaseSync | null = null;
  private mutationLockIdentity: { readonly dev: number; readonly ino: number } | null =
    null;

  constructor(options: {
    readonly cacheRoot: string;
    readonly accountId: string;
    readonly maxCacheBytes?: number;
    readonly minCacheFreeBytes?: number;
  }) {
    this.cacheRoot = requireAbsolutePath(options.cacheRoot);
    this.accountId = validateAccountId(options.accountId);
    this.accountDirectory = path.join(this.cacheRoot, this.accountId);
    this.directoryPath = path.join(this.accountDirectory, "content-blobs");
    // This SQLite lease deliberately belongs to the private state directory,
    // outside account directories and the strict cache-root inventory. A
    // capacity reservation must serialize writers from every account, while
    // account deletion can still rename exactly one cache directory.
    this.mutationLockPath = path.join(
      path.dirname(this.cacheRoot),
      MUTATION_LOCK_FILE,
    );
    this.maxCacheBytes = positiveCacheByteLimit(
      options.maxCacheBytes ?? MAIL_RESOURCE_LIMITS.maxCacheBytes,
    );
    this.minCacheFreeBytes = cacheByteLimit(
      options.minCacheFreeBytes ?? DEFAULT_MIN_CACHE_FREE_BYTES,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.closed) throw new MailBlobStoreError("mail_blob_store_unavailable");
    await assertPrivateDirectory(path.dirname(this.cacheRoot));
    await ensurePrivateDirectory(this.cacheRoot);
    await ensurePrivateDirectory(this.accountDirectory);
    await ensurePrivateDirectory(this.directoryPath);
    await this.assertTrustedDirectories();
    let lockProof: FileHandle | null = null;
    try {
      await ensurePrivateFile(this.mutationLockPath);
      lockProof = await open(
        this.mutationLockPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      const lockStat = await lockProof.stat();
      assertPrivateOwnedFileStat(lockStat);
      this.mutationDatabase = new DatabaseSync(this.mutationLockPath, {
        open: true,
        readOnly: false,
      });
      this.mutationDatabase.exec(`
        PRAGMA trusted_schema = OFF;
        PRAGMA journal_mode = DELETE;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
      `);
      const lockPathStat = await lstat(this.mutationLockPath);
      assertPrivateOwnedFileStat(lockPathStat);
      assertSameInode(lockStat, lockPathStat);
      assertSameInode(lockStat, await lockProof.stat());
      this.mutationLockIdentity = Object.freeze({
        dev: lockStat.dev,
        ino: lockStat.ino,
      });
      await lockProof.close();
      lockProof = null;
      this.initialized = true;
      await this.withMutationLease(async () => {
        await this.recoverInterruptedPublicationsUnlocked();
      });
    } catch (error) {
      this.initialized = false;
      await lockProof?.close().catch(() => undefined);
      this.mutationDatabase?.close();
      this.mutationDatabase = null;
      this.mutationLockIdentity = null;
      throw blobStoreError(error);
    }
  }

  async has(descriptor: MailBlobDescriptor): Promise<boolean> {
    const normalized = blobDescriptor(descriptor);
    return this.withMutationLease(async () => this.hasUnlocked(normalized));
  }

  async put(
    descriptor: MailBlobDescriptor,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    const normalized = blobDescriptor(descriptor);
    if (!isAsyncIterable(chunks)) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    await this.withCapacityReservation(
      normalized.bytes,
      undefined,
      async (lease) => lease.put(normalized, chunks),
    );
  }

  async putIncoming(
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<MailBlobDescriptor> {
    if (!isAsyncIterable(chunks)) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    const limit = incomingByteLimit(maxBytes);
    return this.withCapacityReservation(
      limit,
      undefined,
      async (lease) => lease.putIncoming(chunks, limit),
    );
  }

  /**
   * Reserves bounded global capacity before opening a new temporary file. The
   * root SQLite mutation lease remains held through the write, so the check is
   * a reservation between cooperating Brain Mail writers, not a TOCTOU claim
   * about unrelated filesystem users.
   *
   * A caller may reclaim stale metadata after the first failed preflight. The
   * callback runs outside the lease because content GC acquires this same
   * lease. Capacity is always checked again before publication proceeds.
   */
  async withCapacityReservation<T>(
    maximumAdditionalBytes: number,
    reclaim: (() => Promise<void>) | undefined,
    operation: (lease: MailBlobMutationLease) => Promise<T>,
  ): Promise<T> {
    const additionalBytes = cacheByteLimit(maximumAdditionalBytes);
    if (typeof operation !== "function") {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    try {
      return await this.withMutationLease(async (lease) => {
        await this.assertCapacityAvailableUnlocked(additionalBytes);
        return operation(lease);
      });
    } catch (error) {
      if (
        !(error instanceof MailBlobStoreError) ||
        error.code !== "mail_blob_cache_capacity_exhausted" ||
        reclaim === undefined
      ) {
        throw error;
      }
    }
    try {
      await reclaim();
    } catch (error) {
      throw blobStoreError(error);
    }
    return this.withMutationLease(async (lease) => {
      await this.assertCapacityAvailableUnlocked(additionalBytes);
      return operation(lease);
    });
  }

  async *read(descriptor: MailBlobDescriptor): AsyncIterable<Uint8Array> {
    const normalized = blobDescriptor(descriptor);
    let verified: Buffer | null = null;
    try {
      // Verify and snapshot every byte before yielding. Keeping one descriptor
      // open is not enough against a same-UID writer mutating that inode after
      // verification; the bounded buffer is the immutable response snapshot.
      await this.withMutationLease(async () => {
        verified = await this.readVerifiedBuffer(normalized);
      });
      const snapshot = verified as Buffer | null;
      if (snapshot === null) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      let position = 0;
      while (position < normalized.bytes) {
        const end = Math.min(position + READ_CHUNK_BYTES, normalized.bytes);
        const chunk = Buffer.from(snapshot.subarray(position, end));
        try {
          yield chunk;
        } finally {
          chunk.fill(0);
        }
        position = end;
      }
    } catch (error) {
      throw blobStoreError(error);
    } finally {
      (verified as Buffer | null)?.fill(0);
    }
  }

  /**
   * Copies and verifies a published blob into an anonymous file before any
   * response byte can be observed. The returned body is one-shot and bounded
   * to 64 KiB chunks. Its disposer overwrites and closes the anonymous file.
   */
  async openVerifiedSnapshot(
    descriptor: MailBlobDescriptor,
    signal?: AbortSignal,
  ): Promise<MailBlobReadSnapshot> {
    const normalized = blobDescriptor(descriptor);
    assertAbortSignal(signal);
    const ownership: { candidate: MailBlobReadSnapshot | null } = {
      candidate: null,
    };
    let committed = false;
    try {
      const snapshot = await this.withMutationLease(async () => {
        ownership.candidate = await this.createVerifiedSnapshotUnlocked(
          normalized,
          signal,
        );
        return ownership.candidate;
      });
      committed = true;
      return snapshot;
    } catch (error) {
      throw blobStoreError(error);
    } finally {
      if (!committed) {
        await ownership.candidate?.dispose().catch(() => undefined);
      }
    }
  }

  async remove(descriptor: MailBlobDescriptor): Promise<void> {
    const normalized = blobDescriptor(descriptor);
    await this.withMutationLease(async (lease) => lease.remove(normalized));
  }

  /** Removes only an owned regular file that no longer matches its digest/size. */
  async discardCorrupt(
    descriptor: MailBlobDescriptor,
  ): Promise<"valid" | "metadata_mismatch" | "missing" | "discarded"> {
    const normalized = blobDescriptor(descriptor);
    return this.withMutationLease(async (lease) =>
      lease.discardCorrupt(normalized),
    );
  }

  /**
   * Loads references only after acquiring the same cross-process mutation
   * lease used for publication. This closes the "reference became live while
   * GC was waiting" race.
   */
  async collectGarbage(
    loadReferenced: () =>
      | readonly MailBlobDescriptor[]
      | Promise<readonly MailBlobDescriptor[]>,
  ): Promise<readonly MailBlobDescriptor[]> {
    if (typeof loadReferenced !== "function") {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    return this.withMutationLease(async (lease) => {
      await this.recoverInterruptedPublicationsUnlocked();
      const referenced = await loadReferenced();
      return lease.removeUnreferenced(referenced);
    });
  }

  /** Removes only stale, regular temp files created by this store. */
  async cleanupTemporaryFiles(input: {
    readonly now: number;
    readonly olderThanMs: number;
  }): Promise<number> {
    const now = timestamp(input.now);
    const olderThanMs = positiveDuration(input.olderThanMs);
    return this.withMutationLease(async (lease) => {
      const recovered = await this.recoverInterruptedPublicationsUnlocked();
      return recovered + (await lease.cleanupTemporaryFiles({ now, olderThanMs }));
    });
  }

  /** Explicit startup/maintenance recovery; steady-state reads never scan the directory. */
  async recoverInterruptedPublications(): Promise<void> {
    await this.withMutationLease(async () => {
      await this.recoverInterruptedPublicationsUnlocked();
    });
  }

  /**
   * Executes filesystem and future SQLite reference changes beneath one
   * account-scoped lease. The lease object is invalid after the callback.
   */
  async withMutationLease<T>(
    operation: (lease: MailBlobMutationLease) => Promise<T>,
  ): Promise<T> {
    if (typeof operation !== "function") {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    await this.requireInitialized();
    return this.mutate(async () => {
      const database = this.requireMutationDatabase();
      try {
        database.exec("BEGIN IMMEDIATE");
      } catch (error) {
        throw blobStoreError(error);
      }
      let active = true;
      const started: Promise<
        | { readonly ok: true }
        | { readonly ok: false; readonly error: unknown }
      >[] = [];
      const requireActive = (): void => {
        if (!active) throw new MailBlobStoreError("mail_blob_store_unavailable");
      };
      const track = <Value>(work: () => Promise<Value>): Promise<Value> => {
        requireActive();
        const promise = work();
        started.push(
          promise.then(
            () => Object.freeze({ ok: true as const }),
            (error: unknown) => Object.freeze({ ok: false as const, error }),
          ),
        );
        return promise;
      };
      const lease: MailBlobMutationLease = Object.freeze({
        has: (descriptor: MailBlobDescriptor) => {
          return track(async () => this.hasUnlocked(blobDescriptor(descriptor)));
        },
        discardCorrupt: (descriptor: MailBlobDescriptor) => {
          return track(async () =>
            this.discardCorruptUnlocked(blobDescriptor(descriptor)),
          );
        },
        put: (
          descriptor: MailBlobDescriptor,
          chunks: AsyncIterable<Uint8Array>,
        ) => {
          return track(async () =>
            this.putUnlocked(blobDescriptor(descriptor), chunks),
          );
        },
        putIncoming: (
          chunks: AsyncIterable<Uint8Array>,
          maxBytes: number,
        ) => {
          return track(async () =>
            this.putIncomingUnlocked(chunks, incomingByteLimit(maxBytes)),
          );
        },
        remove: (descriptor: MailBlobDescriptor) => {
          return track(async () =>
            this.removeUnlocked(blobDescriptor(descriptor)),
          );
        },
        removeUnreferenced: (
          referenced: readonly MailBlobDescriptor[],
        ) => {
          return track(async () => this.removeUnreferencedUnlocked(referenced));
        },
        cleanupTemporaryFiles: (input: {
          readonly now: number;
          readonly olderThanMs: number;
        }) => {
          return track(async () => this.cleanupTemporaryFilesUnlocked(input));
        },
      });
      let result: T | undefined;
      let operationFailed = false;
      let operationError: unknown;
      try {
        result = await operation(lease);
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }
      active = false;
      const outcomes = await Promise.all(started);
      const backgroundFailure = outcomes.find(
        (outcome): outcome is { readonly ok: false; readonly error: unknown } =>
          !outcome.ok,
      );
      if (operationFailed || backgroundFailure !== undefined) {
        try {
          if (database.isTransaction) database.exec("ROLLBACK");
        } catch (error) {
          throw blobStoreError(error);
        }
        if (operationFailed) throw operationError;
        throw blobStoreError(backgroundFailure!.error);
      }
      try {
        database.exec("COMMIT");
        return result as T;
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw blobStoreError(error);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.mutate(async () => {
      this.closed = true;
      this.initialized = false;
      this.mutationDatabase?.close();
      this.mutationDatabase = null;
      this.mutationLockIdentity = null;
    });
  }

  private async hasUnlocked(descriptor: MailBlobDescriptor): Promise<boolean> {
    let handle: FileHandle | null = null;
    try {
      handle = await this.openPublished(descriptor);
      await verifyHandle(handle, descriptor);
      return true;
    } catch (error) {
      if (isFileError(error, "ENOENT")) return false;
      throw blobStoreError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async putUnlocked(
    descriptor: MailBlobDescriptor,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<void> {
    if (!isAsyncIterable(chunks)) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    if (await this.hasUnlocked(descriptor)) return;

    const temporaryPath = this.temporaryPath(descriptor.sha256);
    const publishedPath = this.publishedPath(descriptor.sha256);
    let handle: FileHandle | null = null;
    let temporaryExists = true;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      for await (const candidate of chunks) {
        if (!(candidate instanceof Uint8Array)) {
          throw new MailBlobStoreError("mail_blob_request_invalid");
        }
        if (candidate.byteLength === 0) continue;
        if (bytes + candidate.byteLength > descriptor.bytes) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        const chunk = Buffer.from(
          candidate.buffer,
          candidate.byteOffset,
          candidate.byteLength,
        );
        hash.update(chunk);
        await writeComplete(handle, chunk);
        bytes += chunk.byteLength;
      }
      if (bytes !== descriptor.bytes || hash.digest("hex") !== descriptor.sha256) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temporaryPath, 0o400);
      await this.assertTrustedDirectories();
      try {
        // link(2) is an atomic, no-clobber publication primitive. rename(2)
        // would silently replace a valid blob created by another process.
        await link(temporaryPath, publishedPath);
      } catch (error) {
        if (!isFileError(error, "EEXIST")) throw error;
        if (!(await this.hasUnlocked(descriptor))) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        await unlink(temporaryPath);
        temporaryExists = false;
        await syncDirectory(this.directoryPath);
        return;
      }
      await unlink(temporaryPath);
      temporaryExists = false;
      await syncDirectory(this.directoryPath);
      const verified = await this.openPublished(descriptor);
      try {
        await verifyHandle(verified, descriptor);
      } finally {
        await verified.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
      throw blobStoreError(error);
    }
  }

  private async putIncomingUnlocked(
    chunks: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<MailBlobDescriptor> {
    if (!isAsyncIterable(chunks)) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }

    let temporaryPath = this.temporaryPath(randomBytes(32).toString("hex"));
    let handle: FileHandle | null = null;
    let temporaryExists = true;
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      for await (const candidate of chunks) {
        if (!(candidate instanceof Uint8Array)) {
          throw new MailBlobStoreError("mail_blob_request_invalid");
        }
        if (candidate.byteLength === 0) continue;
        if (candidate.byteLength > maxBytes - bytes) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        const chunk = Buffer.from(
          candidate.buffer,
          candidate.byteOffset,
          candidate.byteLength,
        );
        hash.update(chunk);
        await writeComplete(handle, chunk);
        bytes += chunk.byteLength;
      }

      const descriptor = blobDescriptor({
        sha256: hash.digest("hex"),
        bytes,
      });
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temporaryPath, 0o400);

      const finalizedTemporaryPath = this.temporaryPath(descriptor.sha256);
      await rename(temporaryPath, finalizedTemporaryPath);
      temporaryPath = finalizedTemporaryPath;
      await this.assertTrustedDirectories();

      if (await this.hasUnlocked(descriptor)) {
        await unlink(temporaryPath);
        temporaryExists = false;
        await syncDirectory(this.directoryPath);
        return descriptor;
      }

      const publishedPath = this.publishedPath(descriptor.sha256);
      try {
        await link(temporaryPath, publishedPath);
      } catch (error) {
        if (!isFileError(error, "EEXIST")) throw error;
        if (!(await this.hasUnlocked(descriptor))) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        await unlink(temporaryPath);
        temporaryExists = false;
        await syncDirectory(this.directoryPath);
        return descriptor;
      }
      await unlink(temporaryPath);
      temporaryExists = false;
      await syncDirectory(this.directoryPath);

      const verified = await this.openPublished(descriptor);
      try {
        await verifyHandle(verified, descriptor);
      } finally {
        await verified.close();
      }
      return descriptor;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
      throw blobStoreError(error);
    }
  }

  private async readVerifiedBuffer(
    descriptor: MailBlobDescriptor,
  ): Promise<Buffer> {
    const handle = await this.openPublished(descriptor);
    try {
      return await readAndVerifyHandle(handle, descriptor);
    } finally {
      await handle.close();
    }
  }

  private async createVerifiedSnapshotUnlocked(
    descriptor: MailBlobDescriptor,
    signal: AbortSignal | undefined,
  ): Promise<MailBlobReadSnapshot> {
    throwIfAborted(signal);
    const source = await this.openPublished(descriptor);
    const snapshotPath = this.containedPath(
      `.snapshot-${randomBytes(16).toString("hex")}`,
    );
    let snapshot: FileHandle | null = null;
    let snapshotExists = false;
    let completed = false;
    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const hash = createHash("sha256");
    let position = 0;
    try {
      snapshot = await open(
        snapshotPath,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      snapshotExists = true;
      await assertSecureHandle(snapshot, 0);
      const pathStat = await secureFileStat(snapshotPath);
      assertSameInode(await snapshot.stat(), pathStat);
      await unlinkVerifiedPath(snapshotPath, pathStat);
      snapshotExists = false;
      await syncDirectory(this.directoryPath);
      await assertSecureHandle(snapshot, 0, 0);
      while (position < descriptor.bytes) {
        throwIfAborted(signal);
        const requested = Math.min(
          scratch.byteLength,
          descriptor.bytes - position,
        );
        const { bytesRead } = await source.read(
          scratch,
          0,
          requested,
          position,
        );
        if (bytesRead < 1) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        const chunk = scratch.subarray(0, bytesRead);
        hash.update(chunk);
        await writeAll(snapshot, chunk, position);
        position += bytesRead;
      }
      throwIfAborted(signal);
      if (hash.digest("hex") !== descriptor.sha256) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      await assertSecureHandle(source, descriptor.bytes);
      await snapshot.sync();
      await snapshot.chmod(0o400);
      await assertSecureHandle(snapshot, descriptor.bytes, 0);
      completed = true;
      return createReadSnapshot(snapshot, descriptor.bytes, signal);
    } catch (error) {
      if (snapshot !== null) {
        await zeroizeAndCloseSnapshot(snapshot, position).catch(() => undefined);
      }
      if (snapshotExists) await unlink(snapshotPath).catch(() => undefined);
      throw error;
    } finally {
      scratch.fill(0);
      await source.close().catch(() => undefined);
      if (!completed && snapshot !== null) {
        await snapshot.close().catch(() => undefined);
      }
    }
  }

  private async removeUnlocked(descriptor: MailBlobDescriptor): Promise<void> {
    let handle: FileHandle | null = null;
    try {
      handle = await this.openPublished(descriptor);
      await verifyHandle(handle, descriptor);
      const openedStat = await handle.stat();
      const filePath = this.publishedPath(descriptor.sha256);
      const pathStat = await secureFileStat(filePath);
      assertSameInode(openedStat, pathStat);
      await unlink(filePath);
      await syncDirectory(this.directoryPath);
    } catch (error) {
      if (isFileError(error, "ENOENT")) return;
      throw blobStoreError(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async discardCorruptUnlocked(
    descriptor: MailBlobDescriptor,
  ): Promise<"valid" | "metadata_mismatch" | "missing" | "discarded"> {
    const filePath = this.publishedPath(descriptor.sha256);
    let handle: FileHandle | null = null;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isFileError(error, "ENOENT")) return "missing";
      throw blobStoreError(error);
    }
    try {
      const openedStat = await handle.stat();
      assertPrivateOwnedFileStat(openedStat);
      try {
        const actual = blobDescriptor({
          sha256: descriptor.sha256,
          bytes: openedStat.size,
        });
        await verifyHandle(handle, actual);
        return openedStat.size === descriptor.bytes ? "valid" : "metadata_mismatch";
      } catch (error) {
        if (
          !(error instanceof MailBlobStoreError) ||
          (error.code !== "mail_blob_integrity_failed" &&
            error.code !== "mail_blob_request_invalid")
        ) {
          throw error;
        }
      }
      const pathStat = await secureFileStat(filePath);
      assertSameInode(openedStat, pathStat);
      await unlinkVerifiedPath(filePath, pathStat);
      await syncDirectory(this.directoryPath);
      return "discarded";
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async removeUnreferencedUnlocked(
    referenced: readonly MailBlobDescriptor[],
  ): Promise<readonly MailBlobDescriptor[]> {
    const normalized = normalizeDescriptorSet(referenced);
    const removed: MailBlobDescriptor[] = [];
    const entries = await readdir(this.directoryPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (TEMPORARY_BLOB.test(entry.name)) continue;
      if (!PUBLISHED_BLOB.test(entry.name) || !entry.isFile()) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      const expected = normalized.get(entry.name);
      const fileStat = await secureFileStat(this.publishedPath(entry.name));
      const descriptor = Object.freeze({
        sha256: entry.name,
        bytes: fileStat.size,
      });
      if (expected !== undefined) {
        if (expected.bytes !== fileStat.size || !(await this.hasUnlocked(expected))) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        continue;
      }
      await this.removeUnlocked(descriptor);
      removed.push(descriptor);
    }
    return Object.freeze(removed);
  }

  private async cleanupTemporaryFilesUnlocked(input: {
    readonly now: number;
    readonly olderThanMs: number;
  }): Promise<number> {
    const now = timestamp(input.now);
    const olderThanMs = positiveDuration(input.olderThanMs);
    let removed = 0;
    const entries = await readdir(this.directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (PUBLISHED_BLOB.test(entry.name)) continue;
      if (!TEMPORARY_BLOB.test(entry.name) || !entry.isFile()) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      const filePath = this.containedPath(entry.name);
      const fileStat = await secureFileStat(filePath);
      if (fileStat.mtimeMs > now - olderThanMs) continue;
      await unlinkVerifiedPath(filePath, fileStat);
      removed += 1;
    }
    if (removed > 0) await syncDirectory(this.directoryPath);
    return removed;
  }

  private async recoverInterruptedPublicationsUnlocked(): Promise<number> {
    const entries = await readdir(this.directoryPath, { withFileTypes: true });
    let recovered = 0;
    for (const entry of entries) {
      if (LEGACY_SNAPSHOT.test(entry.name)) {
        if (!entry.isFile()) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        await removeLegacySnapshot(this.directoryPath, entry.name);
        recovered += 1;
        continue;
      }
      const match = TEMPORARY_BLOB.exec(entry.name);
      if (match === null) continue;
      if (!entry.isFile()) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      await recoverTemporaryBlob(this.directoryPath, entry.name, match[1]!);
      recovered += 1;
    }
    if (recovered > 0) await syncDirectory(this.directoryPath);
    return recovered;
  }

  private async assertCapacityAvailableUnlocked(
    maximumAdditionalBytes: number,
  ): Promise<void> {
    const additionalBytes = cacheByteLimit(maximumAdditionalBytes);
    const usedBytes = await this.publishedCacheBytesUnlocked();
    if (usedBytes > this.maxCacheBytes - additionalBytes) {
      throw new MailBlobStoreError("mail_blob_cache_capacity_exhausted");
    }

    // statfs is necessarily a preflight: another service outside this lease
    // can consume disk space after the check. We still fail closed when the
    // floor is already unavailable and reserve the incoming upper bound while
    // this store's root SQLite lease is held.
    let filesystem;
    try {
      filesystem = await statfs(this.cacheRoot);
    } catch (error) {
      throw blobStoreError(error);
    }
    const availableBytes = filesystemBytes(filesystem.bavail, filesystem.bsize);
    if (availableBytes < this.minCacheFreeBytes + additionalBytes) {
      throw new MailBlobStoreError("mail_blob_cache_capacity_exhausted");
    }
  }

  private async publishedCacheBytesUnlocked(): Promise<number> {
    let total = 0;
    const accounts = await readdir(this.cacheRoot, { withFileTypes: true });
    for (const account of accounts) {
      if (!SAFE_ACCOUNT_ID.test(account.name)) continue;
      if (!account.isDirectory()) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      const accountDirectory = path.join(this.cacheRoot, account.name);
      await assertPrivateDirectory(accountDirectory);
      const blobDirectory = path.join(accountDirectory, "content-blobs");
      let entries;
      try {
        entries = await readdir(blobDirectory, { withFileTypes: true });
      } catch (error) {
        if (isFileError(error, "ENOENT")) continue;
        throw blobStoreError(error);
      }
      await assertPrivateDirectory(blobDirectory);
      let recovered = 0;
      for (const entry of entries) {
        if (LEGACY_SNAPSHOT.test(entry.name)) {
          if (!entry.isFile()) {
            throw new MailBlobStoreError("mail_blob_integrity_failed");
          }
          await removeLegacySnapshot(blobDirectory, entry.name);
          recovered += 1;
          continue;
        }
        const match = TEMPORARY_BLOB.exec(entry.name);
        if (match === null) continue;
        if (!entry.isFile()) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        await recoverTemporaryBlob(blobDirectory, entry.name, match[1]!);
        recovered += 1;
      }
      if (recovered > 0) await syncDirectory(blobDirectory);
      for (const entry of entries) {
        if (TEMPORARY_BLOB.test(entry.name) || LEGACY_SNAPSHOT.test(entry.name)) {
          continue;
        }
        if (!PUBLISHED_BLOB.test(entry.name) || !entry.isFile()) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
        const fileStat = await secureFileStat(path.join(blobDirectory, entry.name));
        if (fileStat.size > this.maxCacheBytes - total) {
          throw new MailBlobStoreError("mail_blob_cache_capacity_exhausted");
        }
        total += fileStat.size;
      }
    }
    return total;
  }

  private async requireInitialized(): Promise<void> {
    if (!this.initialized || this.closed) {
      throw new MailBlobStoreError("mail_blob_store_unavailable");
    }
    await this.assertTrustedDirectories();
    await this.assertTrustedMutationLock();
  }

  private async assertTrustedDirectories(): Promise<void> {
    await assertPrivateDirectory(path.dirname(this.cacheRoot));
    await assertPrivateDirectory(this.cacheRoot);
    await assertPrivateDirectory(this.accountDirectory);
    await assertPrivateDirectory(this.directoryPath);
    await assertContained(this.cacheRoot, this.accountDirectory);
    await assertContained(this.accountDirectory, this.directoryPath);
    await assertContained(path.dirname(this.cacheRoot), this.cacheRoot);
  }

  private async assertTrustedMutationLock(): Promise<void> {
    const identity = this.mutationLockIdentity;
    if (identity === null) {
      throw new MailBlobStoreError("mail_blob_store_unavailable");
    }
    const lockStat = await lstat(this.mutationLockPath);
    assertPrivateOwnedFileStat(lockStat);
    assertSameInode(identity, lockStat);
  }

  private async openPublished(descriptor: MailBlobDescriptor): Promise<FileHandle> {
    await this.assertTrustedDirectories();
    const handle = await open(
      this.publishedPath(descriptor.sha256),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await assertSecureHandle(handle, descriptor.bytes);
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private publishedPath(sha256: string): string {
    if (!PUBLISHED_BLOB.test(sha256)) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    return this.containedPath(sha256);
  }

  private temporaryPath(sha256: string): string {
    if (!PUBLISHED_BLOB.test(sha256)) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    return this.containedPath(
      `.tmp-${sha256}-${randomBytes(16).toString("hex")}`,
    );
  }

  private containedPath(name: string): string {
    const candidate = path.join(this.directoryPath, name);
    if (path.dirname(candidate) !== this.directoryPath) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    return candidate;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = mutationTails.get(this.mutationLockPath) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    mutationTails.set(this.mutationLockPath, tail);
    void tail.then(() => {
      if (mutationTails.get(this.mutationLockPath) === tail) {
        mutationTails.delete(this.mutationLockPath);
      }
    });
    return run;
  }

  private requireMutationDatabase(): DatabaseSync {
    if (this.mutationDatabase === null || this.closed) {
      throw new MailBlobStoreError("mail_blob_store_unavailable");
    }
    return this.mutationDatabase;
  }
}

async function recoverTemporaryBlob(
  directoryPath: string,
  entryName: string,
  sha256: string,
): Promise<void> {
  if (!TEMPORARY_BLOB.test(entryName) || !PUBLISHED_BLOB.test(sha256)) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  const temporaryPath = path.join(directoryPath, entryName);
  const publishedPath = path.join(directoryPath, sha256);
  if (
    path.dirname(temporaryPath) !== directoryPath ||
    path.dirname(publishedPath) !== directoryPath
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  const temporaryStat = await lstat(temporaryPath);
  if (
    !temporaryStat.isFile() ||
    temporaryStat.isSymbolicLink() ||
    temporaryStat.nlink < 1 ||
    temporaryStat.nlink > 2 ||
    (temporaryStat.mode & 0o077) !== 0 ||
    temporaryStat.uid !== effectiveUid()
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  if (temporaryStat.nlink === 2) {
    const publishedStat = await lstat(publishedPath);
    assertSameInode(temporaryStat, publishedStat);
    const descriptor = Object.freeze({ sha256, bytes: publishedStat.size });
    const handle = await open(
      publishedPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await verifyHandle(handle, descriptor, 2);
    } finally {
      await handle.close();
    }
  }
  await unlinkVerifiedPath(temporaryPath, temporaryStat);
}

async function removeLegacySnapshot(
  directoryPath: string,
  entryName: string,
): Promise<void> {
  if (!LEGACY_SNAPSHOT.test(entryName)) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  const snapshotPath = path.join(directoryPath, entryName);
  if (path.dirname(snapshotPath) !== directoryPath) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  const snapshotStat = await secureFileStat(snapshotPath);
  let handle: FileHandle | null = null;
  let anonymous = false;
  try {
    handle = await open(
      snapshotPath,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    await assertSecureHandle(handle, snapshotStat.size);
    assertSameInode(await handle.stat(), snapshotStat);
    await unlinkVerifiedPath(snapshotPath, snapshotStat);
    anonymous = true;
    await syncDirectory(directoryPath);
    await assertSecureHandle(handle, snapshotStat.size, 0);
    const disposable = handle;
    handle = null;
    await zeroizeAndCloseSnapshot(disposable, snapshotStat.size);
  } catch (error) {
    if (handle !== null) {
      if (anonymous) {
        await zeroizeAndCloseSnapshot(handle, snapshotStat.size).catch(
          () => undefined,
        );
      } else {
        await handle.close().catch(() => undefined);
      }
    }
    throw error;
  }
}

async function verifyHandle(
  handle: FileHandle,
  descriptor: MailBlobDescriptor,
  expectedLinks = 1,
): Promise<void> {
  const value = await readAndVerifyHandle(handle, descriptor, expectedLinks);
  value.fill(0);
}

function createReadSnapshot(
  handle: FileHandle,
  bytes: number,
  signal: AbortSignal | undefined,
): MailBlobReadSnapshot {
  let claimed = false;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposePromise !== null) return disposePromise;
    disposed = true;
    disposePromise = zeroizeAndCloseSnapshot(handle, bytes).catch((error) => {
      throw blobStoreError(error);
    });
    return disposePromise;
  };
  const body: AsyncIterable<Uint8Array> = Object.freeze({
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      if (claimed || disposed) {
        throw new MailBlobStoreError("mail_blob_store_unavailable");
      }
      claimed = true;
      let position = 0;
      let chunk: Buffer | null = null;
      try {
        while (position < bytes) {
          throwIfAborted(signal);
          chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, bytes - position));
          const { bytesRead } = await handle.read(
            chunk,
            0,
            chunk.byteLength,
            position,
          );
          if (bytesRead !== chunk.byteLength) {
            throw new MailBlobStoreError("mail_blob_integrity_failed");
          }
          position += bytesRead;
          try {
            yield chunk;
          } finally {
            chunk.fill(0);
            chunk = null;
          }
        }
        throwIfAborted(signal);
        if (position !== bytes) {
          throw new MailBlobStoreError("mail_blob_integrity_failed");
        }
      } catch (error) {
        throw blobStoreError(error);
      } finally {
        chunk?.fill(0);
        await dispose();
      }
    },
  });
  return Object.freeze({ bytes, body, dispose });
}

async function zeroizeAndCloseSnapshot(
  handle: FileHandle,
  bytes: number,
): Promise<void> {
  const zeroes = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(1, bytes)));
  let firstError: unknown;
  try {
    let position = 0;
    while (position < bytes) {
      const length = Math.min(zeroes.byteLength, bytes - position);
      await writeAll(handle, zeroes.subarray(0, length), position);
      position += length;
    }
    await handle.sync();
  } catch (error) {
    firstError = error;
  } finally {
    zeroes.fill(0);
    try {
      await handle.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function writeAll(
  handle: FileHandle,
  chunk: Uint8Array,
  start: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      start + offset,
    );
    if (bytesWritten < 1) {
      throw new MailBlobStoreError("mail_blob_store_unavailable");
    }
    offset += bytesWritten;
  }
}

function assertAbortSignal(signal: AbortSignal | undefined): void {
  if (
    signal !== undefined &&
    (typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function")
  ) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

async function readAndVerifyHandle(
  handle: FileHandle,
  descriptor: MailBlobDescriptor,
  expectedLinks = 1,
): Promise<Buffer> {
  await assertSecureHandle(handle, descriptor.bytes, expectedLinks);
  const result = Buffer.allocUnsafe(descriptor.bytes);
  try {
    let position = 0;
    while (position < descriptor.bytes) {
      const { bytesRead } = await handle.read(
        result,
        position,
        descriptor.bytes - position,
        position,
      );
      if (bytesRead < 1) {
        throw new MailBlobStoreError("mail_blob_integrity_failed");
      }
      position += bytesRead;
    }
    if (createHash("sha256").update(result).digest("hex") !== descriptor.sha256) {
      throw new MailBlobStoreError("mail_blob_integrity_failed");
    }
    await assertSecureHandle(handle, descriptor.bytes, expectedLinks);
    return result;
  } catch (error) {
    result.fill(0);
    throw error;
  }
}

async function assertSecureHandle(
  handle: FileHandle,
  bytes: number,
  expectedLinks = 1,
): Promise<void> {
  const fileStat = await handle.stat();
  if (
    !fileStat.isFile() ||
    fileStat.nlink !== expectedLinks ||
    fileStat.size !== bytes ||
    (fileStat.mode & 0o077) !== 0 ||
    fileStat.uid !== effectiveUid()
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
}

async function secureFileStat(filePath: string) {
  const fileStat = await lstat(filePath);
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.nlink !== 1 ||
    (fileStat.mode & 0o077) !== 0 ||
    fileStat.uid !== effectiveUid()
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  return fileStat;
}

function assertSameInode(
  opened: { readonly dev: number; readonly ino: number },
  pathStat: { readonly dev: number; readonly ino: number },
): void {
  if (opened.dev !== pathStat.dev || opened.ino !== pathStat.ino) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
}

function assertPrivateOwnedFileStat(fileStat: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly nlink: number;
  readonly mode: number;
  readonly uid: number;
}): void {
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.nlink !== 1 ||
    (fileStat.mode & 0o077) !== 0 ||
    fileStat.uid !== effectiveUid()
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
}

async function unlinkVerifiedPath(
  filePath: string,
  expected: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly nlink: number;
  },
): Promise<void> {
  const current = await lstat(filePath);
  assertSameInode(expected, current);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.size !== expected.size ||
    current.nlink !== expected.nlink ||
    (current.mode & 0o077) !== 0 ||
    current.uid !== effectiveUid()
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
  await unlink(filePath);
}

async function writeComplete(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (bytesWritten < 1) {
      throw new MailBlobStoreError("mail_blob_store_unavailable");
    }
    offset += bytesWritten;
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const directoryStat = await handle.stat();
    if (!directoryStat.isDirectory()) {
      throw new MailBlobStoreError("mail_blob_integrity_failed");
    }
    if (directoryStat.uid !== effectiveUid()) {
      throw new MailBlobStoreError("mail_blob_integrity_failed");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await assertPrivateDirectory(directoryPath);
}

async function assertPrivateDirectory(directoryPath: string): Promise<void> {
  const directoryStat = await lstat(directoryPath);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o077) !== 0 ||
    directoryStat.uid !== effectiveUid()
  ) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
}

async function ensurePrivateFile(filePath: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      filePath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.sync();
  } catch (error) {
    if (!isFileError(error, "EEXIST")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  await assertPrivateFile(filePath);
}

async function assertPrivateFile(filePath: string): Promise<void> {
  const fileStat = await lstat(filePath);
  assertPrivateOwnedFileStat(fileStat);
}

function effectiveUid(): number {
  if (typeof process.geteuid !== "function") {
    throw new MailBlobStoreError("mail_blob_store_unavailable");
  }
  const uid = process.geteuid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new MailBlobStoreError("mail_blob_store_unavailable");
  }
  return uid;
}

async function assertContained(parent: string, child: string): Promise<void> {
  const parentReal = await realpath(parent);
  const childReal = await realpath(child);
  if (!childReal.startsWith(`${parentReal}${path.sep}`)) {
    throw new MailBlobStoreError("mail_blob_integrity_failed");
  }
}

function normalizeDescriptorSet(
  descriptors: readonly MailBlobDescriptor[],
): Map<string, MailBlobDescriptor> {
  if (!Array.isArray(descriptors)) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  const result = new Map<string, MailBlobDescriptor>();
  for (const descriptor of descriptors) {
    const normalized = blobDescriptor(descriptor);
    const existing = result.get(normalized.sha256);
    if (existing !== undefined && existing.bytes !== normalized.bytes) {
      throw new MailBlobStoreError("mail_blob_request_invalid");
    }
    result.set(normalized.sha256, normalized);
  }
  return result;
}

function blobDescriptor(value: MailBlobDescriptor): MailBlobDescriptor {
  try {
    return validateMailBlobDescriptor(value);
  } catch {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
}

function validateAccountId(value: string): string {
  if (!SAFE_ACCOUNT_ID.test(value)) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return value;
}

function requireAbsolutePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return value;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return value;
}

function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return value;
}

function incomingByteLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAIL_RESOURCE_LIMITS.rawMessageBytes
  ) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return value;
}

function cacheByteLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAIL_RESOURCE_LIMITS.maxCacheBytes
  ) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return value;
}

function positiveCacheByteLimit(value: number): number {
  const normalized = cacheByteLimit(value);
  if (normalized < 1) {
    throw new MailBlobStoreError("mail_blob_request_invalid");
  }
  return normalized;
}

function filesystemBytes(blocks: number | bigint, blockSize: number | bigint): number {
  const available = BigInt(blocks) * BigInt(blockSize);
  if (available < BigInt(0) || available > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MailBlobStoreError("mail_blob_store_unavailable");
  }
  return Number(available);
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function"
  );
}

function isFileError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function blobStoreError(error: unknown): MailBlobStoreError {
  if (error instanceof MailBlobStoreError) return error;
  if (isFileError(error, "ENOENT")) {
    return new MailBlobStoreError("mail_blob_not_found");
  }
  if (
    isFileError(error, "ELOOP") ||
    isFileError(error, "EMLINK") ||
    isFileError(error, "ENOTDIR")
  ) {
    return new MailBlobStoreError("mail_blob_integrity_failed");
  }
  return new MailBlobStoreError("mail_blob_store_unavailable");
}
