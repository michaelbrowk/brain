import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailBlobDescriptor } from "../ports";
import {
  AtomicMailBlobStore,
  MailBlobStoreError,
  type MailBlobReadSnapshot,
} from "./content-blob-store";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const SECOND_ACCOUNT_ID = "account-a22222222222222222222222222222222";
const roots: string[] = [];
const stores: AtomicMailBlobStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("atomic account mail blob store", () => {
  it("publishes exact bytes atomically and verifies before yielding", async () => {
    const fixture = await createStore();
    const source = Buffer.from("safe attachment bytes");
    const descriptor = descriptorFor(source);

    await fixture.store.put(descriptor, chunks(source, 3));
    expect(await fixture.store.has(descriptor)).toBe(true);
    expect(await collect(fixture.store.read(descriptor))).toEqual(source);

    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    expect(await readFile(published)).toEqual(source);
  });

  it("stores an honest zero-byte CAS object without inventing payload bytes", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(0);
    const descriptor = descriptorFor(source);

    await fixture.store.put(descriptor, chunks(source, 3));
    expect(await fixture.store.has(descriptor)).toBe(true);
    expect(await collect(fixture.store.read(descriptor))).toEqual(source);
    expect(
      await fixture.store.read(descriptor)[Symbol.asyncIterator]().next(),
    ).toEqual({ done: true, value: undefined });
  });

  it("publishes an incoming one-pass stream after deriving its descriptor", async () => {
    const fixture = await createStore();
    const source = Buffer.from("descriptor is unknown before this stream ends");

    const descriptor = await fixture.store.putIncoming(chunks(source, 5), 64);

    expect(descriptor).toEqual(descriptorFor(source));
    expect(await fixture.store.has(descriptor)).toBe(true);
    expect(await collect(fixture.store.read(descriptor))).toEqual(source);
  });

  it("accepts the exact incoming limit and removes an over-limit temporary file", async () => {
    const fixture = await createStore();
    const exact = Buffer.from("four");

    await expect(fixture.store.putIncoming(chunks(exact, 2), 4)).resolves.toEqual(
      descriptorFor(exact),
    );
    await expect(
      fixture.store.putIncoming(chunks(Buffer.from("abcde"), 2), 4),
    ).rejects.toMatchObject({ code: "mail_blob_integrity_failed" });

    expect(await readFileNames(fixture.store.directoryPath)).toEqual([
      descriptorFor(exact).sha256,
    ]);
  });

  it("removes an incoming temporary file when the producer aborts", async () => {
    const fixture = await createStore();
    const aborted = new DOMException("cancelled", "AbortError");

    await expect(
      fixture.store.putIncoming(
        (async function* () {
          yield Buffer.from("partial raw message");
          throw aborted;
        })(),
        64,
      ),
    ).rejects.toMatchObject({ code: "mail_blob_store_unavailable" });

    expect(await readFileNames(fixture.store.directoryPath)).toEqual([]);
  });

  it("yields a verified snapshot even if the published inode changes later", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(192 * 1024, 0x41);
    source.fill(0x42, 64 * 1024, 128 * 1024);
    source.fill(0x43, 128 * 1024);
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 32 * 1024));

    const iterator = fixture.store.read(descriptor)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!)).toEqual(source.subarray(0, 64 * 1024));

    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    await chmod(published, 0o600);
    const handle = await open(published, "r+");
    try {
      await handle.write(Buffer.alloc(64 * 1024, 0x58), 0, 64 * 1024, 64 * 1024);
      await handle.sync();
    } finally {
      await handle.close();
      await chmod(published, 0o400);
    }

    const remaining: Buffer[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(Buffer.from(next.value));
    }
    expect(Buffer.concat(remaining)).toEqual(source.subarray(64 * 1024));
  });

  it("zeroizes the verified snapshot and yielded chunk when a reader returns early", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(96 * 1024, 0x5a);
    const descriptor = descriptorFor(source);
    const verified = Buffer.from(source);
    vi.spyOn(
      fixture.store as unknown as {
        readVerifiedBuffer(value: MailBlobDescriptor): Promise<Buffer>;
      },
      "readVerifiedBuffer",
    ).mockResolvedValue(verified);

    const iterator = fixture.store.read(descriptor)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!)).toEqual(source.subarray(0, 64 * 1024));

    await expect(iterator.return?.()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(Buffer.from(first.value!)).toEqual(Buffer.alloc(64 * 1024));
    expect(verified).toEqual(Buffer.alloc(source.byteLength));
  });

  it("zeroizes the verified snapshot and yielded chunk after normal completion", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(8 * 1024, 0x4c);
    const descriptor = descriptorFor(source);
    const verified = Buffer.from(source);
    vi.spyOn(
      fixture.store as unknown as {
        readVerifiedBuffer(value: MailBlobDescriptor): Promise<Buffer>;
      },
      "readVerifiedBuffer",
    ).mockResolvedValue(verified);

    const iterator = fixture.store.read(descriptor)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(Buffer.from(first.value!)).toEqual(source);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    expect(Buffer.from(first.value!)).toEqual(Buffer.alloc(source.byteLength));
    expect(verified).toEqual(Buffer.alloc(source.byteLength));
  });

  it("zeroizes the verified snapshot and yielded chunk when a reader throws", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(96 * 1024, 0x6b);
    const descriptor = descriptorFor(source);
    const verified = Buffer.from(source);
    vi.spyOn(
      fixture.store as unknown as {
        readVerifiedBuffer(value: MailBlobDescriptor): Promise<Buffer>;
      },
      "readVerifiedBuffer",
    ).mockResolvedValue(verified);

    const iterator = fixture.store.read(descriptor)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);

    await expect(iterator.throw?.(new Error("reader failed"))).rejects.toMatchObject({
      code: "mail_blob_store_unavailable",
    });
    expect(Buffer.from(first.value!)).toEqual(Buffer.alloc(64 * 1024));
    expect(verified).toEqual(Buffer.alloc(source.byteLength));
  });

  it("preverifies an anonymous attachment snapshot and streams only 64 KiB chunks", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(160 * 1024, 0x31);
    source.fill(0x32, 64 * 1024, 128 * 1024);
    source.fill(0x33, 128 * 1024);
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 16 * 1024));

    const snapshot = await fixture.store.openVerifiedSnapshot(descriptor);
    expect(await readFileNames(fixture.store.directoryPath)).toEqual([
      descriptor.sha256,
    ]);

    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    await chmod(published, 0o600);
    await writeFile(published, Buffer.alloc(source.byteLength, 0x58));
    await chmod(published, 0o400);

    const sizes: number[] = [];
    const received: Buffer[] = [];
    for await (const chunk of snapshot.body) {
      sizes.push(chunk.byteLength);
      received.push(Buffer.from(chunk));
    }
    expect(sizes).toEqual([64 * 1024, 64 * 1024, 32 * 1024]);
    expect(Buffer.concat(received)).toEqual(source);
    await expect(snapshot.dispose()).resolves.toBeUndefined();
  });

  it("unlinks and syncs the snapshot name before the first plaintext write", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(8 * 1024, 0x54);
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 1024));
    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    const probe = await open(published, "r");
    const handlePrototype = Object.getPrototypeOf(probe) as {
      write(...args: unknown[]): Promise<unknown>;
      sync(): Promise<void>;
    };
    await probe.close();
    const originalWrite = handlePrototype.write;
    const originalSync = handlePrototype.sync;
    let namesAtFirstWrite: string[] | null = null;
    let directorySynced = false;
    let directorySyncedAtFirstWrite = false;
    const sync = vi
      .spyOn(handlePrototype, "sync")
      .mockImplementation(async function (this: FileHandle) {
        const isDirectory = (await this.stat()).isDirectory();
        await Reflect.apply(originalSync, this, []);
        if (isDirectory) directorySynced = true;
      });
    const write = vi
      .spyOn(handlePrototype, "write")
      .mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
        namesAtFirstWrite ??= await readFileNames(fixture.store.directoryPath);
        directorySyncedAtFirstWrite = directorySynced;
        return Reflect.apply(originalWrite, this, args) as Promise<unknown>;
      });
    let snapshot: MailBlobReadSnapshot | null = null;
    try {
      snapshot = await fixture.store.openVerifiedSnapshot(descriptor);
    } finally {
      write.mockRestore();
      sync.mockRestore();
    }

    expect(namesAtFirstWrite).toEqual([descriptor.sha256]);
    expect(directorySyncedAtFirstWrite).toBe(true);
    if (snapshot === null) throw new Error("snapshot was not created");
    await expect(snapshot.dispose()).resolves.toBeUndefined();
  });

  it("disposes a created snapshot when the mutation lease commit fails", async () => {
    const fixture = await createStore();
    const source = Buffer.from("snapshot ownership starts after commit");
    const descriptor = descriptorFor(source);
    const dispose = vi.fn(async () => undefined);
    vi.spyOn(
      fixture.store as unknown as {
        createVerifiedSnapshotUnlocked(
          value: MailBlobDescriptor,
          signal: AbortSignal | undefined,
        ): Promise<{
          readonly bytes: number;
          readonly body: AsyncIterable<Uint8Array>;
          dispose(): Promise<void>;
        }>;
      },
      "createVerifiedSnapshotUnlocked",
    ).mockResolvedValue({
      bytes: source.byteLength,
      body: chunks(source, source.byteLength),
      dispose,
    });
    const database = (
      fixture.store as unknown as {
        mutationDatabase: { exec(statement: string): void };
      }
    ).mutationDatabase;
    const originalExec = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((statement: string) => {
      if (statement === "COMMIT") throw new Error("injected commit failure");
      originalExec(statement);
    });

    await expect(
      fixture.store.openVerifiedSnapshot(descriptor),
    ).rejects.toMatchObject({ code: "mail_blob_store_unavailable" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes an attachment snapshot on early return and rejects reuse", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(96 * 1024, 0x6d);
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 8 * 1024));
    const snapshot = await fixture.store.openVerifiedSnapshot(descriptor);
    const iterator = snapshot.body[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBe(64 * 1024);
    await iterator.return?.();
    await expect(snapshot.dispose()).resolves.toBeUndefined();
    await expect(collect(snapshot.body)).rejects.toMatchObject({
      code: "mail_blob_store_unavailable",
    });
  });

  it("leaves no snapshot path when attachment setup is already aborted", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(8 * 1024, 0x44);
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 1024));
    const controller = new AbortController();
    controller.abort();

    await expect(
      fixture.store.openVerifiedSnapshot(descriptor, controller.signal),
    ).rejects.toMatchObject({ code: "mail_blob_store_unavailable" });
    expect(await readFileNames(fixture.store.directoryPath)).toEqual([
      descriptor.sha256,
    ]);
  });

  it("zeroizes a partially filled snapshot when the file read throws", async () => {
    const fixture = await createStore();
    const source = Buffer.alloc(12 * 1024, 0x3d);
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 1024));
    const probe = await open(
      path.join(fixture.store.directoryPath, descriptor.sha256),
      "r",
    );
    const handlePrototype = Object.getPrototypeOf(probe) as {
      read(...args: unknown[]): Promise<unknown>;
    };
    await probe.close();
    let allocated: Buffer | null = null;
    const originalAllocUnsafe = Buffer.allocUnsafe;
    const allocation = vi
      .spyOn(Buffer, "allocUnsafe")
      .mockImplementation((size: number) => {
        const value = originalAllocUnsafe(size);
        if (size === source.byteLength && allocated === null) allocated = value;
        return value;
      });
    const read = vi
      .spyOn(handlePrototype, "read")
      .mockImplementationOnce(async (...args: unknown[]) => {
        const target = args[0];
        if (Buffer.isBuffer(target)) target.fill(0x7d);
        throw new Error("injected read failure");
      });
    try {
      await expect(collect(fixture.store.read(descriptor))).rejects.toMatchObject({
        code: "mail_blob_store_unavailable",
      });
    } finally {
      read.mockRestore();
      allocation.mockRestore();
    }
    if (allocated === null) throw new Error("snapshot allocation was not observed");
    expect(allocated).toEqual(Buffer.alloc(source.byteLength));
  });

  it("zeroizes a verified read buffer when the mutation lease commit fails", async () => {
    const fixture = await createStore();
    const source = Buffer.from("verified bytes must not survive commit failure");
    const descriptor = descriptorFor(source);
    const verified = Buffer.from(source);
    vi.spyOn(
      fixture.store as unknown as {
        readVerifiedBuffer(value: MailBlobDescriptor): Promise<Buffer>;
      },
      "readVerifiedBuffer",
    ).mockResolvedValue(verified);
    const database = (
      fixture.store as unknown as {
        mutationDatabase: { exec(statement: string): void };
      }
    ).mutationDatabase;
    const originalExec = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation((statement: string) => {
      if (statement === "COMMIT") throw new Error("injected commit failure");
      originalExec(statement);
    });

    await expect(collect(fixture.store.read(descriptor))).rejects.toMatchObject({
      code: "mail_blob_store_unavailable",
    });
    expect(verified).toEqual(Buffer.alloc(source.byteLength));
  });

  it("serializes two store instances and never replaces the first inode", async () => {
    const fixture = await createStore();
    const secondStore = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(secondStore);
    await secondStore.initialize();
    const source = Buffer.from("one immutable publication");
    const descriptor = descriptorFor(source);
    const hold = deferred<void>();
    const published = deferred<number>();

    const first = fixture.store.withMutationLease(async (lease) => {
      await lease.put(descriptor, chunks(source, 2));
      published.resolve((await stat(path.join(fixture.store.directoryPath, descriptor.sha256))).ino);
      await hold.promise;
    });
    const firstInode = await published.promise;

    let secondConsumed = false;
    const second = secondStore.put(
      descriptor,
      (async function* () {
        secondConsumed = true;
        yield source;
      })(),
    );
    await nextTurn();
    expect(secondConsumed).toBe(false);
    hold.resolve(undefined);
    await Promise.all([first, second]);

    expect(secondConsumed).toBe(false);
    expect(
      (await stat(path.join(fixture.store.directoryPath, descriptor.sha256))).ino,
    ).toBe(firstInode);
  });

  it("does not recover another instance's active temporary publication", async () => {
    const fixture = await createStore();
    const secondStore = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(secondStore);
    await secondStore.initialize();
    const source = Buffer.alloc(128 * 1024, 0x61);
    const descriptor = descriptorFor(source);
    const started = deferred<void>();
    const release = deferred<void>();

    const writing = fixture.store.put(
      descriptor,
      (async function* () {
        yield source.subarray(0, 64 * 1024);
        started.resolve(undefined);
        await release.promise;
        yield source.subarray(64 * 1024);
      })(),
    );
    await started.promise;
    expect(
      (await readFileNames(fixture.store.directoryPath)).some((name) =>
        name.startsWith(".tmp-"),
      ),
    ).toBe(true);

    let cleanupSettled = false;
    const cleanup = secondStore
      .cleanupTemporaryFiles({ now: Date.now() + 60_000, olderThanMs: 1 })
      .then((value) => {
        cleanupSettled = true;
        return value;
      });
    await nextTurn();
    expect(cleanupSettled).toBe(false);
    expect(
      (await readFileNames(fixture.store.directoryPath)).some((name) =>
        name.startsWith(".tmp-"),
      ),
    ).toBe(true);

    release.resolve(undefined);
    await expect(writing).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBe(0);
    expect(await collect(secondStore.read(descriptor))).toEqual(source);
  });

  it("keeps the lease until a fire-and-forget blob operation settles", async () => {
    const fixture = await createStore();
    const secondStore = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(secondStore);
    await secondStore.initialize();
    const source = Buffer.alloc(96 * 1024, 0x71);
    const descriptor = descriptorFor(source);
    const started = deferred<void>();
    const release = deferred<void>();

    let callbackReturned = false;
    const mutation = fixture.store.withMutationLease(async (lease) => {
      void lease.put(
        descriptor,
        (async function* () {
          yield source.subarray(0, 32 * 1024);
          started.resolve(undefined);
          await release.promise;
          yield source.subarray(32 * 1024);
        })(),
      );
      await started.promise;
      callbackReturned = true;
    });
    await started.promise;
    await nextTurn();
    expect(callbackReturned).toBe(true);

    let mutationSettled = false;
    void mutation.then(() => {
      mutationSettled = true;
    });
    let cleanupSettled = false;
    const cleanup = secondStore
      .cleanupTemporaryFiles({ now: Date.now() + 60_000, olderThanMs: 1 })
      .then((value) => {
        cleanupSettled = true;
        return value;
      });
    await nextTurn();
    expect(mutationSettled).toBe(false);
    expect(cleanupSettled).toBe(false);

    release.resolve(undefined);
    await expect(mutation).resolves.toBeUndefined();
    await expect(cleanup).resolves.toBe(0);
    expect(await collect(secondStore.read(descriptor))).toEqual(source);
  });

  it("rejects a lease when an unawaited blob operation fails", async () => {
    const fixture = await createStore();
    const source = Buffer.from("wrong digest in background");
    await expect(
      fixture.store.withMutationLease(async (lease) => {
        void lease.put(
          { sha256: "a".repeat(64), bytes: source.byteLength },
          chunks(source, 3),
        );
      }),
    ).rejects.toMatchObject({ code: "mail_blob_integrity_failed" });
    expect(await readFileNames(fixture.store.directoryPath)).toEqual([]);
  });

  it("recovers the no-clobber link window left by a crashed publisher", async () => {
    const fixture = await createStore();
    const source = Buffer.from("durable crash recovery");
    const descriptor = descriptorFor(source);
    const temporary = path.join(
      fixture.store.directoryPath,
      `.tmp-${descriptor.sha256}-${"c".repeat(32)}`,
    );
    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    await writeFile(temporary, source, { mode: 0o400 });
    await link(temporary, published);
    expect((await stat(temporary)).nlink).toBe(2);

    const restarted = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(restarted);
    await restarted.initialize();

    expect(await readFileNames(restarted.directoryPath)).toEqual([
      descriptor.sha256,
    ]);
    expect((await stat(published)).nlink).toBe(1);
    expect(await collect(restarted.read(descriptor))).toEqual(source);
  });

  it("removes a one-link temporary file left by a crashed writer on restart", async () => {
    const fixture = await createStore();
    const temporary = path.join(
      fixture.store.directoryPath,
      `.tmp-${"d".repeat(64)}-${"e".repeat(32)}`,
    );
    await writeFile(temporary, Buffer.alloc(32 * 1024, 0x71), { mode: 0o600 });
    expect((await stat(temporary)).nlink).toBe(1);

    const restarted = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(restarted);
    await restarted.initialize();

    expect(await readFileNames(restarted.directoryPath)).toEqual([]);
  });

  it("removes a legacy named snapshot safely on restart", async () => {
    const fixture = await createStore();
    const legacyBytes = Buffer.from("legacy plaintext snapshot");
    const legacy = path.join(
      fixture.store.directoryPath,
      `.snapshot-${"a".repeat(32)}`,
    );
    await writeFile(legacy, legacyBytes, { mode: 0o600 });
    const held = await open(legacy, "r");

    const restarted = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(restarted);
    try {
      await restarted.initialize();
      const zeroized = Buffer.alloc(legacyBytes.byteLength, 0x7f);
      const { bytesRead } = await held.read(
        zeroized,
        0,
        zeroized.byteLength,
        0,
      );
      expect(bytesRead).toBe(legacyBytes.byteLength);
      expect(zeroized).toEqual(Buffer.alloc(legacyBytes.byteLength));
    } finally {
      await held.close();
    }

    expect(await readFileNames(restarted.directoryPath)).toEqual([]);
  });

  it("fails closed instead of following a legacy snapshot symlink", async () => {
    const fixture = await createStore();
    const outside = path.join(fixture.root, "outside-legacy-snapshot");
    await writeFile(outside, "must survive", { mode: 0o600 });
    await symlink(
      outside,
      path.join(fixture.store.directoryPath, `.snapshot-${"b".repeat(32)}`),
    );
    const restarted = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(restarted);

    await expect(restarted.initialize()).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
    expect(await readFile(outside, "utf8")).toBe("must survive");
  });

  it("keeps identical content isolated between account directories", async () => {
    const fixture = await createStore();
    const secondAccountDirectory = path.join(
      fixture.root,
      "cache",
      SECOND_ACCOUNT_ID,
    );
    await mkdir(secondAccountDirectory, { mode: 0o700 });
    const secondAccount = new AtomicMailBlobStore({
      cacheRoot: path.join(fixture.root, "cache"),
      accountId: SECOND_ACCOUNT_ID,
    });
    stores.push(secondAccount);
    await secondAccount.initialize();
    const source = Buffer.from("same bytes, separate account ownership");
    const descriptor = descriptorFor(source);

    await Promise.all([
      fixture.store.put(descriptor, chunks(source, 4)),
      secondAccount.put(descriptor, chunks(source, 5)),
    ]);
    const firstPath = path.join(fixture.store.directoryPath, descriptor.sha256);
    const secondPath = path.join(secondAccount.directoryPath, descriptor.sha256);
    expect((await stat(firstPath)).ino).not.toBe((await stat(secondPath)).ino);

    await fixture.store.remove(descriptor);
    expect(await fixture.store.has(descriptor)).toBe(false);
    expect(await collect(secondAccount.read(descriptor))).toEqual(source);
  });

  it("reclaims an abandoned temporary file in another account during capacity preflight", async () => {
    const fixture = await createStore();
    const secondDirectory = path.join(
      fixture.root,
      "cache",
      SECOND_ACCOUNT_ID,
      "content-blobs",
    );
    await mkdir(secondDirectory, { recursive: true, mode: 0o700 });
    const abandoned = path.join(
      secondDirectory,
      `.tmp-${"a".repeat(64)}-${"f".repeat(32)}`,
    );
    await writeFile(abandoned, Buffer.alloc(24 * 1024, 0x72), { mode: 0o600 });
    const source = Buffer.from("capacity scan owns abandoned temps");

    await fixture.store.put(descriptorFor(source), chunks(source, 7));

    expect(await readFileNames(secondDirectory)).toEqual([]);
    expect(await collect(fixture.store.read(descriptorFor(source)))).toEqual(source);
  });

  it("rejects size and digest mismatches without leaving temporary files", async () => {
    const fixture = await createStore();
    const source = Buffer.from("body");

    await expect(
      fixture.store.put(
        { ...descriptorFor(source), bytes: source.byteLength - 1 },
        chunks(source, 2),
      ),
    ).rejects.toMatchObject({ code: "mail_blob_integrity_failed" });
    await expect(
      fixture.store.put(
        { sha256: "a".repeat(64), bytes: source.byteLength },
        chunks(source, 2),
      ),
    ).rejects.toMatchObject({ code: "mail_blob_integrity_failed" });
    expect(await readFileNames(fixture.store.directoryPath)).toEqual([]);
  });

  it("fails closed on a symlink, hard link, or changed published bytes", async () => {
    const fixture = await createStore();
    const source = Buffer.from("original");
    const descriptor = descriptorFor(source);
    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    const external = path.join(fixture.root, "external");
    await writeFile(external, source, { mode: 0o400 });

    await symlink(external, published);
    await expect(fixture.store.has(descriptor)).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
    await rm(published);

    await link(external, published);
    await expect(collect(fixture.store.read(descriptor))).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
    await rm(published);

    await fixture.store.put(descriptor, chunks(source, 8));
    await chmod(published, 0o600);
    await writeFile(published, Buffer.from("tampered"));
    await chmod(published, 0o400);
    await expect(collect(fixture.store.read(descriptor))).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
  });

  it("discards only an owned corrupt publication so it can be rebuilt", async () => {
    const fixture = await createStore();
    const source = Buffer.from("original bytes");
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 3));
    await expect(fixture.store.discardCorrupt(descriptor)).resolves.toBe("valid");

    const published = path.join(fixture.store.directoryPath, descriptor.sha256);
    await chmod(published, 0o600);
    await writeFile(published, Buffer.from("tampered bytes"));
    await chmod(published, 0o400);
    await expect(fixture.store.discardCorrupt(descriptor)).resolves.toBe(
      "discarded",
    );
    await expect(fixture.store.discardCorrupt(descriptor)).resolves.toBe("missing");
    await fixture.store.put(descriptor, chunks(source, 4));
    expect(await collect(fixture.store.read(descriptor))).toEqual(source);
  });

  it("keeps a valid shared object when only caller metadata has the wrong size", async () => {
    const fixture = await createStore();
    const source = Buffer.from("shared immutable bytes");
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 3));

    await expect(
      fixture.store.discardCorrupt({ ...descriptor, bytes: descriptor.bytes - 1 }),
    ).resolves.toBe("metadata_mismatch");
    expect(await collect(fixture.store.read(descriptor))).toEqual(source);
  });

  it("rejects an account directory replaced by a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-blobs-"));
    roots.push(root);
    const cacheRoot = path.join(root, "cache");
    const outside = path.join(root, "outside");
    await mkdir(cacheRoot, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, path.join(cacheRoot, ACCOUNT_ID));

    const store = new AtomicMailBlobStore({ cacheRoot, accountId: ACCOUNT_ID });
    stores.push(store);
    await expect(store.initialize()).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
  });

  it("keeps referenced blobs and removes only verified unreferenced blobs", async () => {
    const fixture = await createStore();
    const kept = descriptorFor(Buffer.from("keep"));
    const removed = descriptorFor(Buffer.from("remove"));
    await fixture.store.put(kept, chunks(Buffer.from("keep"), 2));
    await fixture.store.put(removed, chunks(Buffer.from("remove"), 2));

    await expect(
      fixture.store.collectGarbage(async () => [kept]),
    ).resolves.toEqual([removed]);
    expect(await fixture.store.has(kept)).toBe(true);
    expect(await fixture.store.has(removed)).toBe(false);
  });

  it("cleans only old store-owned temp files and rejects unknown entries", async () => {
    const fixture = await createStore();
    const oldTemp = path.join(
      fixture.store.directoryPath,
      `.tmp-${"a".repeat(64)}-${"b".repeat(32)}`,
    );
    await writeFile(oldTemp, "partial", { mode: 0o600 });
    const old = new Date(1_000);
    await utimes(oldTemp, old, old);

    await expect(
      fixture.store.cleanupTemporaryFiles({ now: 10_000, olderThanMs: 5_000 }),
    ).resolves.toBe(1);

    await writeFile(path.join(fixture.store.directoryPath, "unexpected"), "x", {
      mode: 0o600,
    });
    await expect(
      fixture.store.cleanupTemporaryFiles({ now: 20_000, olderThanMs: 5_000 }),
    ).rejects.toMatchObject({ code: "mail_blob_integrity_failed" });
  });

  it("validates descriptors and requires explicit initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-mail-blobs-"));
    roots.push(root);
    const store = new AtomicMailBlobStore({
      cacheRoot: path.join(root, "cache"),
      accountId: ACCOUNT_ID,
    });
    stores.push(store);
    const descriptor = descriptorFor(Buffer.from("x"));
    await expect(store.has(descriptor)).rejects.toMatchObject({
      code: "mail_blob_store_unavailable",
    });
    await store.initialize();
    await expect(store.has({ sha256: "../escape", bytes: 1 })).rejects.toBeInstanceOf(
      MailBlobStoreError,
    );
  });

  it("rolls back and rejects even when a lease callback throws undefined", async () => {
    const fixture = await createStore();
    await expect(
      fixture.store.withMutationLease(async () => {
        throw undefined;
      }),
    ).rejects.toBeUndefined();

    const source = Buffer.from("lock released after rollback");
    const descriptor = descriptorFor(source);
    await expect(
      fixture.store.put(descriptor, chunks(source, 4)),
    ).resolves.toBeUndefined();
  });

  it("rejects cache metadata that is not owned by the service uid", async () => {
    const fixture = await createStore();
    const source = Buffer.from("owner-bound content");
    const descriptor = descriptorFor(source);
    await fixture.store.put(descriptor, chunks(source, 4));
    if (typeof process.geteuid !== "function") throw new Error("POSIX uid required");
    const actualUid = process.geteuid();
    const uid = vi.spyOn(process, "geteuid").mockReturnValue(actualUid + 1);
    try {
      await expect(fixture.store.has(descriptor)).rejects.toMatchObject({
        code: "mail_blob_integrity_failed",
      });
    } finally {
      uid.mockRestore();
    }
  });

  it("rejects a mutation lock path replaced after DatabaseSync opens it", async () => {
    const fixture = await createStore();
    const lockPath = path.join(
      fixture.root,
      ".content-blobs.lock.sqlite3",
    );
    const outside = path.join(fixture.root, "replacement-lock");
    await writeFile(outside, "not the opened lock inode", { mode: 0o600 });
    await unlink(lockPath);
    await symlink(outside, lockPath);

    const descriptor = descriptorFor(Buffer.from("x"));
    await expect(fixture.store.has(descriptor)).rejects.toMatchObject({
      code: "mail_blob_integrity_failed",
    });
  });
});

async function createStore(): Promise<{
  readonly root: string;
  readonly store: AtomicMailBlobStore;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-blobs-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  await mkdir(path.join(cacheRoot, ACCOUNT_ID), { mode: 0o700 });
  const store = new AtomicMailBlobStore({ cacheRoot, accountId: ACCOUNT_ID });
  stores.push(store);
  await store.initialize();
  return { root, store };
}

function descriptorFor(value: Buffer): MailBlobDescriptor {
  return Object.freeze({
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function* chunks(value: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += size) {
    yield value.subarray(offset, Math.min(value.byteLength, offset + size));
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const result: Buffer[] = [];
  for await (const chunk of source) result.push(Buffer.from(chunk));
  return Buffer.concat(result);
}

async function readFileNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}
