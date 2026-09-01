import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ZERO_HASH = "0".repeat(64);
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const REMOTE_RUN_BUDGET_BYTES = 4 * 1024 * 1024;
const REMOTE_CLEANUP_RESERVE_BYTES = 512 * 1024;
const REMOTE_ACK_RESERVE_BYTES = 32 * 1024;
const SOURCE_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FORBIDDEN_KEYS = new Set([
  "body",
  "markdown",
  "content",
  "sourceurl",
  "signedurl",
  "mcptoken",
  "authorization",
  "database64",
  "bytes",
]);

export interface PilotJournalEvent {
  type: string;
  [key: string]: unknown;
}

export interface PilotJournalRecord {
  seq: number;
  prevHash: string;
  event: PilotJournalEvent;
  hash: string;
}

export interface PilotJournalOpenOptions {
  forbiddenRoots?: readonly string[];
}

interface PilotJournalLock {
  directoryHandle: FileHandle;
  markerHandle: FileHandle;
  lockPath: string;
  markerPath: string;
}

export class PilotJournalCapacityError extends Error {
  readonly code = "journal_capacity";

  constructor() {
    super("pilot journal has no safe capacity for another remote mutation");
    this.name = "PilotJournalCapacityError";
  }
}

export class PilotJournal {
  readonly records: readonly PilotJournalRecord[];
  #handle: FileHandle;
  #lock: PilotJournalLock;
  #records: PilotJournalRecord[];
  #bytes: number;
  #remoteCeiling: number | undefined;
  #poisoned = false;

  private constructor(
    handle: FileHandle,
    lock: PilotJournalLock,
    records: PilotJournalRecord[],
    bytes: number,
  ) {
    this.#handle = handle;
    this.#lock = lock;
    this.#records = records;
    this.#bytes = bytes;
    this.records = this.#records;
  }

  static async open(
    filePath: string,
    options: PilotJournalOpenOptions = {},
  ): Promise<PilotJournal> {
    if (!path.isAbsolute(filePath)) {
      throw new Error("pilot journal path must be absolute");
    }
    const forbiddenRoots = [
      SOURCE_REPOSITORY_ROOT,
      process.cwd(),
      // The same fallback lib/store/index.ts takes when NOTES_ROOT is unset,
      // repeated rather than imported because this module stays free of the
      // store the way SOURCE_REPOSITORY_ROOT above does.
      process.env.NOTES_ROOT ?? path.join(os.homedir(), "brain-notes"),
      ...(options.forbiddenRoots ?? []),
    ];
    const resolvedForbiddenRoots = await Promise.all(
      forbiddenRoots.map(canonicalExistingOrResolved),
    );
    for (const root of resolvedForbiddenRoots) {
      if (pathContains(root, path.resolve(filePath))) {
        throw new Error("pilot journal must be outside the repository and notes roots");
      }
    }
    const prospectiveFilePath = await canonicalProspectivePath(filePath);
    for (const root of resolvedForbiddenRoots) {
      if (pathContains(root, prospectiveFilePath)) {
        throw new Error("pilot journal must be outside the repository and notes roots");
      }
    }
    const journalParent = path.dirname(filePath);
    await fs.mkdir(journalParent, { recursive: true, mode: 0o700 });
    const parentBefore = await assertPrivateJournalParent(journalParent);
    const canonicalFilePath = path.join(
      await fs.realpath(journalParent),
      path.basename(filePath),
    );
    for (const root of resolvedForbiddenRoots) {
      if (pathContains(root, canonicalFilePath)) {
        throw new Error("pilot journal must be outside the repository and notes roots");
      }
    }
    const lockPath = filePath + ".lock";
    let lock: PilotJournalLock;
    try {
      lock = await acquireLock(lockPath);
    } catch (error) {
      if (await pathExists(lockPath)) {
        throw new Error("pilot journal is locked by another process");
      }
      throw error;
    }
    let created = false;
    let handle: FileHandle;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDWR |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      created = true;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        await releaseLock(lock);
        throw error;
      }
      let existingHandle: FileHandle | undefined;
      try {
        const beforeOpen = await fs.lstat(filePath);
        if (beforeOpen.isSymbolicLink()) {
          throw new Error("pilot journal must be a regular file");
        }
        assertPrivateJournalFile(beforeOpen);
        existingHandle = await fs.open(
          filePath,
          fsConstants.O_RDWR |
            fsConstants.O_APPEND |
            fsConstants.O_NOFOLLOW,
        );
        const [opened, afterOpen] = await Promise.all([
          existingHandle.stat(),
          fs.lstat(filePath),
        ]);
        if (
          !opened.isFile() ||
          !afterOpen.isFile() ||
          afterOpen.isSymbolicLink() ||
          opened.dev !== afterOpen.dev ||
          opened.ino !== afterOpen.ino ||
          beforeOpen.dev !== afterOpen.dev ||
          beforeOpen.ino !== afterOpen.ino
        ) {
          throw new Error("pilot journal path changed while opening");
        }
        assertPrivateJournalFile(opened);
        assertPrivateJournalFile(afterOpen);
        handle = existingHandle;
      } catch (openError) {
        await existingHandle?.close().catch(() => undefined);
        await releaseLock(lock);
        throw openError;
      }
    }
    try {
      const stat = await handle.stat();
      assertPrivateJournalFile(stat);
      const [pathAfterOpen, parentAfterOpen] = await Promise.all([
        fs.lstat(filePath),
        fs.lstat(journalParent),
      ]);
      assertPrivateJournalFile(pathAfterOpen);
      assertSameJournalFile(stat, pathAfterOpen, "path changed while opening");
      assertSameJournalParent(parentBefore, parentAfterOpen);
      if (created) await syncDirectory(path.dirname(filePath));
      const text = await handle.readFile({ encoding: "utf8" });
      const [afterRead, pathAfterRead, parentAfterRead] = await Promise.all([
        handle.stat(),
        fs.lstat(filePath),
        fs.lstat(journalParent),
      ]);
      assertPrivateJournalFile(afterRead);
      assertPrivateJournalFile(pathAfterRead);
      assertSameJournalFile(stat, afterRead, "changed while reading");
      assertSameJournalFile(afterRead, pathAfterRead, "path changed while reading");
      assertSameJournalParent(parentBefore, parentAfterRead);
      if (afterRead.size !== Buffer.byteLength(text, "utf8")) {
        throw new Error("pilot journal changed while reading");
      }
      const records = parseJournal(text);
      return new PilotJournal(
        handle,
        lock,
        records,
        stat.size,
      );
    } catch (error) {
      await handle.close().catch(() => undefined);
      await releaseLock(lock);
      throw error;
    }
  }

  latest(type: string, notionId?: string): PilotJournalEvent | undefined {
    for (let index = this.#records.length - 1; index >= 0; index -= 1) {
      const event = this.#records[index].event;
      if (
        event.type === type &&
        (notionId === undefined || event.notionId === notionId)
      ) {
        return event;
      }
    }
    return undefined;
  }

  assertNewRemoteRunCapacity(runStarted: PilotJournalEvent): void {
    assertSafeEvent(runStarted);
    const seq = this.#records.length + 1;
    const prevHash = this.#records.at(-1)?.hash ?? ZERO_HASH;
    const core = { seq, prevHash, event: runStarted };
    const lineBytes = Buffer.byteLength(
      JSON.stringify({ ...core, hash: journalHash(core) }) + "\n",
    );
    if (this.#bytes + lineBytes + REMOTE_RUN_BUDGET_BYTES > MAX_JOURNAL_BYTES) {
      throw new PilotJournalCapacityError();
    }
  }

  async activateRemoteRunCapacity(
    runId: string,
    fingerprint: string,
  ): Promise<void> {
    const previous = [...this.#records]
      .reverse()
      .find(
        (record) =>
          record.event.type === "capacity_reserved" &&
          record.event.runId === runId &&
          record.event.fingerprint === fingerprint,
      );
    if (previous) {
      const ceiling = previous.event.ceilingBytes;
      if (
        !Number.isSafeInteger(ceiling) ||
        (ceiling as number) < this.#bytes ||
        (ceiling as number) > MAX_JOURNAL_BYTES
      ) {
        throw new PilotJournalCapacityError();
      }
      this.#remoteCeiling = ceiling as number;
      return;
    }
    const ceilingBytes = this.#bytes + REMOTE_RUN_BUDGET_BYTES;
    if (ceilingBytes > MAX_JOURNAL_BYTES) {
      throw new PilotJournalCapacityError();
    }
    await this.append({
      type: "capacity_reserved",
      runId,
      fingerprint,
      ceilingBytes,
    });
    this.#remoteCeiling = ceilingBytes;
  }

  assertRemoteMutationCapacity(kind: "normal" | "cleanup"): void {
    const reserve =
      REMOTE_ACK_RESERVE_BYTES +
      (kind === "normal" ? REMOTE_CLEANUP_RESERVE_BYTES : 0);
    if (
      this.#remoteCeiling === undefined ||
      this.#bytes + reserve > this.#remoteCeiling
    ) {
      throw new PilotJournalCapacityError();
    }
  }

  async append(event: PilotJournalEvent): Promise<PilotJournalRecord> {
    if (this.#poisoned) {
      throw new Error("pilot journal append state is indeterminate");
    }
    assertSafeEvent(event);
    const seq = this.#records.length + 1;
    const prevHash = this.#records.at(-1)?.hash ?? ZERO_HASH;
    const core = { seq, prevHash, event };
    const record: PilotJournalRecord = {
      ...core,
      hash: journalHash(core),
    };
    const line = JSON.stringify(record) + "\n";
    const lineBytes = Buffer.byteLength(line);
    if (this.#bytes + lineBytes > MAX_JOURNAL_BYTES) {
      throw new Error("pilot journal exceeds byte limit");
    }
    try {
      await this.#handle.appendFile(line);
      await this.#handle.sync();
    } catch (error) {
      // appendFile can have installed the complete record before fsync reports
      // an error. Reconcile the exact validated chain before rethrowing so the
      // executor's best-effort run_stopped append cannot reuse seq/prevHash.
      // If the tail cannot be proven, poison this handle instead of risking a
      // second append onto a partial or foreign record.
      try {
        const diskText = await readHandleText(this.#handle);
        const diskRecords = parseJournal(diskText);
        if (!isExactJournalExtension(this.#records, diskRecords, record)) {
          this.#poisoned = true;
          throw new Error("pilot journal append tail is indeterminate");
        }
        this.#records.push(record);
        this.#bytes = Buffer.byteLength(diskText);
      } catch {
        this.#poisoned = true;
      }
      throw error;
    }
    this.#records.push(record);
    this.#bytes += lineBytes;
    return record;
  }

  async close(): Promise<void> {
    try {
      await this.#handle.close();
    } finally {
      await releaseLock(this.#lock);
    }
  }
}

async function readHandleText(handle: FileHandle): Promise<string> {
  const stat = await handle.stat();
  if (stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("pilot journal exceeds byte limit");
  }
  const bytes = Buffer.alloc(stat.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesRead === 0) {
      throw new Error("pilot journal changed during reconciliation");
    }
    offset += result.bytesRead;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isExactJournalExtension(
  previous: readonly PilotJournalRecord[],
  current: readonly PilotJournalRecord[],
  expected: PilotJournalRecord,
): boolean {
  if (current.length !== previous.length + 1) return false;
  for (const [index, record] of previous.entries()) {
    if (stableJson(record) !== stableJson(current[index])) return false;
  }
  return stableJson(current.at(-1)) === stableJson(expected);
}

export function assertSafeJournalEvent(event: PilotJournalEvent): void {
  assertSafeEvent(event);
}

function parseJournal(text: string): PilotJournalRecord[] {
  if (!text) return [];
  if (!text.endsWith("\n")) {
    throw new Error("pilot journal has a truncated final record");
  }
  const records: PilotJournalRecord[] = [];
  for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
    if (!line) throw new Error("pilot journal contains a blank record");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("pilot journal contains invalid JSON");
    }
    const record = parseRecord(value);
    const expectedSeq = index + 1;
    const expectedPrevious = records.at(-1)?.hash ?? ZERO_HASH;
    if (record.seq !== expectedSeq || record.prevHash !== expectedPrevious) {
      throw new Error("pilot journal sequence or chain is invalid");
    }
    const expectedHash = journalHash({
      seq: record.seq,
      prevHash: record.prevHash,
      event: record.event,
    });
    if (record.hash !== expectedHash) {
      throw new Error("pilot journal hash is invalid");
    }
    records.push(record);
  }
  return records;
}

function parseRecord(input: unknown): PilotJournalRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("pilot journal record must be an object");
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "event,hash,prevHash,seq") {
    throw new Error("pilot journal record has unknown fields");
  }
  if (
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 1 ||
    typeof value.prevHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.prevHash) ||
    typeof value.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !value.event ||
    typeof value.event !== "object" ||
    Array.isArray(value.event)
  ) {
    throw new Error("pilot journal record is invalid");
  }
  const event = value.event as PilotJournalEvent;
  assertSafeEvent(event);
  return {
    seq: value.seq as number,
    prevHash: value.prevHash,
    event,
    hash: value.hash,
  };
}

function assertSafeEvent(event: PilotJournalEvent): void {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    typeof event.type !== "string" ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(event.type)
  ) {
    throw new Error("pilot journal event is invalid");
  }
  inspectSafeValue(event, new WeakSet<object>());
}

function inspectSafeValue(value: unknown, seen: WeakSet<object>): void {
  if (typeof value === "string") {
    if (/https?:\/\//i.test(value)) {
      throw new Error("pilot journal must not contain URLs");
    }
    if (Buffer.byteLength(value, "utf8") > 4096) {
      throw new Error("pilot journal string is too large");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("pilot journal contains a non-finite number");
    }
    return;
  }
  if (typeof value === "boolean" || value === null) return;
  if (value === undefined || typeof value !== "object") {
    throw new Error("pilot journal contains a non-JSON value");
  }
  if (seen.has(value)) throw new Error("pilot journal contains a cycle");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) inspectSafeValue(child, seen);
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("pilot journal contains a non-plain object");
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      FORBIDDEN_KEYS.has(normalizedKey) ||
      (normalizedKey.endsWith("token") && normalizedKey !== "reservationtoken")
    ) {
      throw new Error("pilot journal contains forbidden field: " + key);
    }
    inspectSafeValue(child, seen);
  }
  seen.delete(value);
}

function journalHash(input: {
  seq: number;
  prevHash: string;
  event: PilotJournalEvent;
}): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => JSON.stringify(key) + ":" + stableJson(child))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function assertPrivateJournalParent(directory: string): Promise<Stats> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("pilot journal parent must be a real private directory");
  }
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined || stat.uid !== effectiveUserId) {
    throw new Error("pilot journal parent must be owned by the effective user");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error("pilot journal parent mode must be 0700");
  }
  return stat;
}

function assertPrivateJournalFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("pilot journal must be a regular file");
  }
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined || stat.uid !== effectiveUserId) {
    throw new Error("pilot journal must be owned by the effective user");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("pilot journal mode must be 0600");
  }
  if (stat.nlink !== 1) {
    throw new Error("pilot journal must not have multiple hard links");
  }
  if (stat.size > MAX_JOURNAL_BYTES) {
    throw new Error("pilot journal exceeds byte limit");
  }
}

function assertSameJournalFile(
  expected: Stats,
  actual: Stats,
  reason: string,
): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.uid !== actual.uid ||
    (expected.mode & 0o777) !== (actual.mode & 0o777) ||
    expected.nlink !== actual.nlink ||
    expected.size !== actual.size ||
    expected.mtimeMs !== actual.mtimeMs ||
    expected.ctimeMs !== actual.ctimeMs
  ) {
    throw new Error(`pilot journal ${reason}`);
  }
}

function assertSameJournalParent(expected: Stats, actual: Stats): void {
  const effectiveUserId = process.geteuid?.();
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    effectiveUserId === undefined ||
    actual.uid !== effectiveUserId ||
    (actual.mode & 0o777) !== 0o700 ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.uid !== actual.uid ||
    (expected.mode & 0o777) !== (actual.mode & 0o777)
  ) {
    throw new Error("pilot journal parent changed during access");
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

async function acquireLock(lockPath: string): Promise<PilotJournalLock> {
  const owner = randomBytes(24).toString("hex");
  const pendingPath = `${lockPath}.pending-${owner}`;
  const markerName = `owner-${owner}`;
  const pendingMarkerPath = path.join(pendingPath, markerName);
  let markerHandle: FileHandle | undefined;
  let directoryHandle: FileHandle | undefined;
  let published = false;
  try {
    await fs.mkdir(pendingPath, { mode: 0o700 });
    markerHandle = await fs.open(pendingMarkerPath, "wx", 0o600);
    await markerHandle.writeFile(String(process.pid) + "\n", "utf8");
    await markerHandle.sync();
    directoryHandle = await fs.open(pendingPath, "r");
    await directoryHandle.sync();
    await fs.rename(pendingPath, lockPath);
    published = true;
    const lock = {
      directoryHandle,
      markerHandle,
      lockPath,
      markerPath: path.join(lockPath, markerName),
    };
    await syncDirectory(path.dirname(lockPath));
    return lock;
  } catch (error) {
    if (published && markerHandle && directoryHandle) {
      await releaseLock({
        directoryHandle,
        markerHandle,
        lockPath,
        markerPath: path.join(lockPath, markerName),
      }).catch(() => undefined);
    } else {
      await markerHandle?.close().catch(() => undefined);
      await directoryHandle?.close().catch(() => undefined);
      await fs.rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function releaseLock(lock: PilotJournalLock): Promise<void> {
  let firstError: unknown;
  let ownMarkerRemoved = false;
  let ownDirectoryRemoved = false;
  try {
    await lock.markerHandle.close();
  } catch (error) {
    firstError = error;
  }
  try {
    await fs.unlink(lock.markerPath);
    ownMarkerRemoved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && firstError === undefined) {
      firstError = error;
    }
  }
  if (ownMarkerRemoved) {
    try {
      await lock.directoryHandle.sync();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
    try {
      await fs.rmdir(lock.lockPath);
      ownDirectoryRemoved = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A manually recovered successor owns this path now. Its unpredictable
      // marker keeps the directory non-empty, so the predecessor must leave it.
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && firstError === undefined) {
        firstError = error;
      }
    }
  }
  try {
    await lock.directoryHandle.close();
  } catch (error) {
    if (firstError === undefined) firstError = error;
  }
  if (ownDirectoryRemoved) {
    try {
      await syncDirectory(path.dirname(lock.lockPath));
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

async function pathExists(input: string): Promise<boolean> {
  try {
    await fs.lstat(input);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalExistingOrResolved(input: string): Promise<string> {
  const resolved = path.resolve(input);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolved;
  }
}

async function canonicalProspectivePath(input: string): Promise<string> {
  let cursor = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try {
      const existing = await fs.realpath(cursor);
      return path.join(existing, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}
