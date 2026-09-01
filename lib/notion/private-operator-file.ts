import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 128 * 1024 * 1024;
const SOURCE_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export interface PrivateOperatorFileOptions {
  /** A non-sensitive label used in errors. Paths and file contents are never
   * included in errors. */
  label?: string;
  /** Maximum encoded UTF-8 size. Defaults to 8 MiB and is always enforced. */
  maxBytes?: number;
  /** Additional trees which may contain source exports or notes. Operator
   * state must live outside every listed tree. */
  forbiddenRoots?: readonly string[];
}

/**
 * Read private operator state without following the file symlink or trusting a
 * pathname identity only once. The direct parent must already exist as an
 * effective-user-owned 0700 directory and the file must be a single-link 0600
 * regular file owned by the same user.
 */
export async function readPrivateOperatorText(
  filePath: string,
  options: PrivateOperatorFileOptions = {},
): Promise<string> {
  const label = safeLabel(options.label);
  try {
    const maxBytes = validatedMaxBytes(options.maxBytes, label);
    const context = await validatePrivateTarget(filePath, options, label);
    const before = await fs.lstat(filePath);
    assertPrivateFile(before, context.effectiveUserId, maxBytes, label);

    let handle: FileHandle | undefined;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | requiredNoFollowFlag(label),
      );
      const [opened, pathAfterOpen, parentAfterOpen] = await Promise.all([
        handle.stat(),
        fs.lstat(filePath),
        fs.lstat(context.parentPath),
      ]);
      assertPrivateFile(opened, context.effectiveUserId, maxBytes, label);
      assertPrivateFile(pathAfterOpen, context.effectiveUserId, maxBytes, label);
      assertSameFile(before, opened, label, "changed while opening");
      assertSameFile(opened, pathAfterOpen, label, "path changed while opening");
      assertSameParent(context.parentBefore, parentAfterOpen, label);

      const bytes = await handle.readFile();
      if (bytes.byteLength > maxBytes) {
        fail(label, "exceeds the byte limit");
      }

      const [after, pathAfterRead, parentAfterRead] = await Promise.all([
        handle.stat(),
        fs.lstat(filePath),
        fs.lstat(context.parentPath),
      ]);
      assertPrivateFile(after, context.effectiveUserId, maxBytes, label);
      assertPrivateFile(pathAfterRead, context.effectiveUserId, maxBytes, label);
      assertSameFile(opened, after, label, "changed while reading");
      assertSameFile(after, pathAfterRead, label, "path changed while reading");
      assertSameParent(context.parentBefore, parentAfterRead, label);
      if (after.size !== bytes.byteLength) {
        fail(label, "changed while reading");
      }

      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail(label, "is not valid UTF-8 text");
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  } catch (error) {
    rethrowSafe(error, label, "read");
  }
  // TypeScript does not preserve the `never` control flow through the nested
  // async try/finally above. Runtime cannot reach this fail-closed guard.
  fail(label, "could not be read securely");
}

/**
 * Create private operator state exactly once. Existing files (including
 * symlinks) are never opened or replaced. The file and its parent directory
 * are fsynced before success is returned.
 */
export async function writeNewPrivateOperatorText(
  filePath: string,
  text: string,
  options: PrivateOperatorFileOptions = {},
): Promise<void> {
  const label = safeLabel(options.label);
  let context: PrivateTargetContext | undefined;
  let createdIdentity: FileIdentity | undefined;
  let completed = false;
  let handle: FileHandle | undefined;
  try {
    if (typeof text !== "string") fail(label, "contents must be text");
    const maxBytes = validatedMaxBytes(options.maxBytes, label);
    const bytes = Buffer.from(text, "utf8");
    if (bytes.byteLength > maxBytes) fail(label, "exceeds the byte limit");

    context = await validatePrivateTarget(filePath, options, label);
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        requiredNoFollowFlag(label),
      0o600,
    );
    const [opened, pathAfterOpen, parentAfterOpen] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
      fs.lstat(context.parentPath),
    ]);
    createdIdentity = { dev: opened.dev, ino: opened.ino };
    assertPrivateFile(opened, context.effectiveUserId, maxBytes, label);
    assertPrivateFile(pathAfterOpen, context.effectiveUserId, maxBytes, label);
    assertSameFile(opened, pathAfterOpen, label, "path changed while creating");
    assertSameParent(context.parentBefore, parentAfterOpen, label);
    if (opened.size !== 0) fail(label, "was not created empty");

    await handle.writeFile(bytes);
    await handle.sync();
    const [after, pathAfterWrite, parentAfterWrite] = await Promise.all([
      handle.stat(),
      fs.lstat(filePath),
      fs.lstat(context.parentPath),
    ]);
    assertPrivateFile(after, context.effectiveUserId, maxBytes, label);
    assertPrivateFile(pathAfterWrite, context.effectiveUserId, maxBytes, label);
    assertSameFile(after, pathAfterWrite, label, "path changed while writing");
    assertSameParent(context.parentBefore, parentAfterWrite, label);
    if (
      after.dev !== createdIdentity.dev ||
      after.ino !== createdIdentity.ino ||
      after.size !== bytes.byteLength
    ) {
      fail(label, "changed while writing");
    }

    await handle.close();
    handle = undefined;
    await syncPrivateDirectory(context, label);
    completed = true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!completed && context && createdIdentity) {
      await removeOwnedPartialFile(filePath, context, createdIdentity);
    }
    rethrowSafe(error, label, "write");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface PrivateTargetContext {
  effectiveUserId: number;
  parentBefore: Stats;
  parentPath: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

class PrivateOperatorFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateOperatorFileError";
  }
}

async function validatePrivateTarget(
  filePath: string,
  options: PrivateOperatorFileOptions,
  label: string,
): Promise<PrivateTargetContext> {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    fail(label, "path must be absolute");
  }
  if (!path.basename(filePath)) fail(label, "path must name a file");

  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined) {
    fail(label, "owner cannot be verified on this platform");
  }
  const parentPath = path.dirname(filePath);
  const prospectiveFile = await canonicalProspectivePath(filePath);
  await assertOutsideForbiddenRoots(
    prospectiveFile,
    options.forbiddenRoots,
    label,
  );
  const parentBefore = await fs.lstat(parentPath);
  assertPrivateParent(parentBefore, effectiveUserId, label);
  const canonicalParent = await fs.realpath(parentPath);
  const canonicalFile = path.join(canonicalParent, path.basename(filePath));
  await assertOutsideForbiddenRoots(canonicalFile, options.forbiddenRoots, label);
  const parentAfterCanonicalization = await fs.lstat(parentPath);
  assertSameParent(parentBefore, parentAfterCanonicalization, label);
  return { effectiveUserId, parentBefore, parentPath };
}

function assertPrivateParent(
  stat: Stats,
  effectiveUserId: number,
  label: string,
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(label, "parent must be a real directory");
  }
  if (stat.uid !== effectiveUserId) {
    fail(label, "parent must be owned by the effective user");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    fail(label, "parent mode must be 0700");
  }
}

function assertPrivateFile(
  stat: Stats,
  effectiveUserId: number,
  maxBytes: number,
  label: string,
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(label, "must be a regular file");
  }
  if (stat.uid !== effectiveUserId) {
    fail(label, "must be owned by the effective user");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    fail(label, "mode must be 0600");
  }
  if (stat.nlink !== 1) {
    fail(label, "must not have multiple hard links");
  }
  if (stat.size > maxBytes) fail(label, "exceeds the byte limit");
}

function assertSameFile(
  expected: Stats,
  actual: Stats,
  label: string,
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
    fail(label, reason);
  }
}

function assertSameParent(expected: Stats, actual: Stats, label: string): void {
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    expected.uid !== actual.uid ||
    (expected.mode & 0o777) !== (actual.mode & 0o777)
  ) {
    fail(label, "parent changed during access");
  }
}

async function assertOutsideForbiddenRoots(
  canonicalFile: string,
  additionalRoots: readonly string[] | undefined,
  label: string,
): Promise<void> {
  const roots = [
    SOURCE_REPOSITORY_ROOT,
    process.cwd(),
    // The same fallback lib/store/index.ts takes when NOTES_ROOT is unset,
    // repeated rather than imported for the reason SOURCE_REPOSITORY_ROOT is.
    process.env.NOTES_ROOT ?? path.join(os.homedir(), "brain-notes"),
    ...(additionalRoots ?? []),
  ];
  for (const root of roots) {
    if (typeof root !== "string" || !path.isAbsolute(root)) {
      fail(label, "forbidden roots must be absolute");
    }
    const canonicalRoot = await canonicalProspectivePath(root);
    if (pathContains(canonicalRoot, canonicalFile)) {
      fail(label, "must be outside repository, notes, and export roots");
    }
  }
}

async function syncPrivateDirectory(
  context: PrivateTargetContext,
  label: string,
): Promise<void> {
  const directoryFlag = fsConstants.O_DIRECTORY ?? 0;
  const handle = await fs.open(
    context.parentPath,
    fsConstants.O_RDONLY | requiredNoFollowFlag(label) | directoryFlag,
  );
  try {
    const opened = await handle.stat();
    assertPrivateParent(opened, context.effectiveUserId, label);
    assertSameParent(context.parentBefore, opened, label);
    try {
      await handle.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
    const after = await fs.lstat(context.parentPath);
    assertSameParent(context.parentBefore, after, label);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function removeOwnedPartialFile(
  filePath: string,
  context: PrivateTargetContext,
  identity: FileIdentity,
): Promise<void> {
  try {
    const [file, parent] = await Promise.all([
      fs.lstat(filePath),
      fs.lstat(context.parentPath),
    ]);
    if (
      file.isFile() &&
      !file.isSymbolicLink() &&
      file.dev === identity.dev &&
      file.ino === identity.ino &&
      file.uid === context.effectiveUserId &&
      file.nlink === 1 &&
      parent.dev === context.parentBefore.dev &&
      parent.ino === context.parentBefore.ino
    ) {
      await fs.unlink(filePath);
      await syncPrivateDirectory(context, "private operator file").catch(
        () => undefined,
      );
    }
  } catch {
    // Cleanup is best-effort and may never delete a pathname with a different
    // identity. Preserve the original fail-closed error.
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
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(".." + path.sep))
  );
}

function validatedMaxBytes(input: number | undefined, label: string): number {
  const value = input ?? DEFAULT_MAX_BYTES;
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > ABSOLUTE_MAX_BYTES
  ) {
    fail(label, "byte limit is invalid");
  }
  return value;
}

function requiredNoFollowFlag(label: string): number {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    fail(label, "cannot reject symlinks on this platform");
  }
  return fsConstants.O_NOFOLLOW;
}

function safeLabel(input: string | undefined): string {
  if (input === undefined) return "private operator file";
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(input)) {
    throw new PrivateOperatorFileError("private operator file label is invalid");
  }
  return input;
}

function fail(label: string, reason: string): never {
  throw new PrivateOperatorFileError(`${label}: ${reason}`);
}

function rethrowSafe(
  error: unknown,
  label: string,
  operation: "read" | "write",
): never {
  if (error instanceof PrivateOperatorFileError) throw error;
  const code = errorCode(error);
  if (code === "EEXIST") fail(label, "already exists");
  if (code === "ENOENT") fail(label, "does not exist");
  if (code === "ELOOP") fail(label, "must not be a symlink");
  if (code === "EACCES" || code === "EPERM") {
    fail(label, "cannot be accessed securely");
  }
  fail(label, `could not be ${operation} securely`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}
