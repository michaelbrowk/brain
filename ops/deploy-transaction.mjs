#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA_RE = /^[0-9a-f]{40}$/;
const BASE_RE = /^\/[A-Za-z0-9._/-]+$/;

function reject(message) {
  throw new Error(message);
}

function validateBase(base) {
  if (
    typeof base !== "string" ||
    !BASE_RE.test(base) ||
    base === "/" ||
    base.includes("/../") ||
    base.endsWith("/..") ||
    resolve(base) !== base
  ) {
    reject("deployment base is invalid");
  }
  return base;
}

function validateReleasePath(value, base, label) {
  if (
    typeof value !== "string" ||
    /[\r\n\0]/.test(value) ||
    resolve(value) !== value ||
    !value.startsWith(`${base}/releases/`) ||
    value === `${base}/releases/`
  ) {
    reject(`${label} is outside the release directory`);
  }
  return value;
}

function validateTreePath(value, base) {
  const allowed = [`${base}/incoming/`, `${base}/releases/`];
  if (
    typeof value !== "string" ||
    /[\r\n\0]/.test(value) ||
    resolve(value) !== value ||
    !allowed.some((prefix) => value.startsWith(prefix))
  ) {
    reject("release tree is outside a deployment data directory");
  }
  return value;
}

export function validateTransaction(value, base) {
  validateBase(base);
  if (!value || typeof value !== "object" || value.schema !== 1) {
    reject("deployment transaction schema is invalid");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "bootstrap,commit,createdAt,previous,release,schema") {
    reject("deployment transaction has unknown fields");
  }
  validateReleasePath(value.previous, base, "previous release");
  validateReleasePath(value.release, base, "candidate release");
  if (value.previous === value.release) {
    reject("deployment transaction targets are identical");
  }
  if (!SHA_RE.test(value.commit ?? "")) {
    reject("deployment transaction commit is invalid");
  }
  if (typeof value.bootstrap !== "boolean") {
    reject("deployment transaction bootstrap flag is invalid");
  }
  if (
    typeof value.createdAt !== "string" ||
    !value.createdAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    reject("deployment transaction timestamp is invalid");
  }
  return value;
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishExclusive(temporary, destination, alreadyExistsMessage) {
  let linked = false;
  try {
    // link(2) is the portable no-replace publication primitive available in
    // Node. Unlike rename(), two concurrent writers cannot both overwrite the
    // destination and report success.
    await link(temporary, destination);
    linked = true;
    await syncDirectory(dirname(destination));
    await unlink(temporary);
    await syncDirectory(dirname(destination));
  } catch (error) {
    // Once the destination link exists it is the recovery authority. Never
    // remove it merely because a later fsync or temporary-link cleanup failed.
    await rm(temporary, { force: true }).catch(() => {});
    if (!linked && error?.code === "EEXIST") reject(alreadyExistsMessage);
    throw error;
  }
}

function journalPath(base) {
  return join(validateBase(base), ".deploy-transaction.json");
}

function pendingPath(base) {
  return join(validateBase(base), ".deploy-pending.json");
}

function bootstrapMarkerPath(base) {
  return join(validateBase(base), ".bootstrap-deploy-once");
}

export async function writeBootstrapMarker(base, commit) {
  const marker = bootstrapMarkerPath(base);
  if (!SHA_RE.test(commit ?? "")) {
    reject("bootstrap marker commit is invalid");
  }
  try {
    await lstat(marker);
    reject("bootstrap marker already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${marker}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${commit}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await publishExclusive(temporary, marker, "bootstrap marker already exists");
  return marker;
}

export async function beginTransaction({
  base,
  previous,
  release,
  commit,
  bootstrap,
}) {
  const pending = await readPendingRelease(base);
  if (pending.release !== release || pending.commit !== commit) {
    reject("deployment pending marker does not match the transaction");
  }
  await assertRealDirectory(previous, "previous release");
  await assertRealDirectory(release, "candidate release");
  const value = validateTransaction(
    {
      schema: 1,
      previous,
      release,
      commit,
      bootstrap,
      createdAt: new Date().toISOString(),
    },
    base,
  );
  return publishTransaction(base, value);
}

async function publishTransaction(base, value) {
  const journal = journalPath(base);
  try {
    await lstat(journal);
    reject("deployment transaction already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${journal}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await publishExclusive(
    temporary,
    journal,
    "deployment transaction already exists",
  );
  return value;
}

function exactTransaction(left, right) {
  return (
    left.previous === right.previous &&
    left.release === right.release &&
    left.commit === right.commit &&
    left.bootstrap === right.bootstrap
  );
}

/**
 * Re-establish rollback authority after clearTransaction unlinked the journal
 * but could not prove the parent-directory fsync. This path is intentionally
 * separate from beginTransaction: the success path may already have cleared
 * its pending marker, while the in-process rollback still holds the exact
 * previous/candidate tuple that must become durable before current moves.
 */
export async function ensureTransaction(
  { base, previous, release, commit, bootstrap },
  publish = publishTransaction,
) {
  await assertRealDirectory(previous, "previous release");
  await assertRealDirectory(release, "candidate release");
  const expected = validateTransaction(
    {
      schema: 1,
      previous,
      release,
      commit,
      bootstrap,
      createdAt: new Date().toISOString(),
    },
    base,
  );
  try {
    const existing = await readTransaction(base);
    if (!exactTransaction(existing, expected)) {
      reject("existing deployment transaction does not match rollback authority");
    }
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return publish(base, expected);
}

export function validatePendingRelease(value, base) {
  validateBase(base);
  if (!value || typeof value !== "object" || value.schema !== 1) {
    reject("deployment pending marker schema is invalid");
  }
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "commit,createdAt,release,schema") {
    reject("deployment pending marker has unknown fields");
  }
  validateReleasePath(value.release, base, "pending release");
  if (!SHA_RE.test(value.commit ?? "")) {
    reject("deployment pending marker commit is invalid");
  }
  if (
    typeof value.createdAt !== "string" ||
    !value.createdAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    reject("deployment pending marker timestamp is invalid");
  }
  return value;
}

export async function writePendingRelease({ base, release, commit }) {
  const marker = pendingPath(base);
  const value = validatePendingRelease(
    {
      schema: 1,
      release,
      commit,
      createdAt: new Date().toISOString(),
    },
    base,
  );
  try {
    await lstat(release);
    reject("pending release target already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await lstat(marker);
    reject("deployment pending marker already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = `${marker}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  await publishExclusive(
    temporary,
    marker,
    "deployment pending marker already exists",
  );
  return value;
}

export async function readPendingRelease(base) {
  const marker = pendingPath(base);
  const metadata = await lstat(marker);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    reject("deployment pending marker is not a regular file");
  }
  if ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.geteuid()) {
    reject("deployment pending marker ownership or mode is invalid");
  }
  if (metadata.size < 2 || metadata.size > 4096) {
    reject("deployment pending marker size is invalid");
  }
  return validatePendingRelease(JSON.parse(await readFile(marker, "utf8")), base);
}

export async function clearPendingRelease(base, expectedRelease, expectedCommit) {
  const marker = pendingPath(base);
  const value = await readPendingRelease(base);
  if (value.release !== expectedRelease || value.commit !== expectedCommit) {
    reject("deployment pending marker does not match the expected release");
  }
  await unlink(marker);
  await syncDirectory(dirname(marker));
  return true;
}

export async function readTransaction(base) {
  const journal = journalPath(base);
  const metadata = await lstat(journal);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    reject("deployment transaction is not a regular file");
  }
  if ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.geteuid()) {
    reject("deployment transaction ownership or mode is invalid");
  }
  if (metadata.size < 2 || metadata.size > 4096) {
    reject("deployment transaction size is invalid");
  }
  return validateTransaction(JSON.parse(await readFile(journal, "utf8")), base);
}

export async function clearTransaction(base, sync = syncDirectory) {
  const journal = journalPath(base);
  try {
    await unlink(journal);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  try {
    await sync(dirname(journal));
  } catch (firstError) {
    // A successful unlink followed by a transient fsync error leaves the name
    // absent but its crash durability uncertain. Retry the same directory
    // barrier before reporting failure; rollback still recreates authority if
    // both barriers fail.
    try {
      await sync(dirname(journal));
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        "deployment transaction unlink could not be made durable",
      );
    }
  }
  return true;
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Inspect every durable authority before recovery mutates the filesystem.
 * The production shell consumes this exact classifier, and fault-injection
 * tests exercise it at every promotion boundary. */
export async function inspectRecoveryState(base, currentTarget) {
  validateBase(base);
  validateReleasePath(currentTarget, base, "current release");
  await assertRealDirectory(currentTarget, "current release");
  const journalMetadata = await lstatIfPresent(journalPath(base));
  const pendingMetadata = await lstatIfPresent(pendingPath(base));

  if (journalMetadata) {
    const transaction = await readTransaction(base);
    await assertRealDirectory(transaction.previous, "previous release");
    if (
      currentTarget !== transaction.previous &&
      currentTarget !== transaction.release
    ) {
      reject("current points outside the recorded deployment transaction");
    }
    const candidateMetadata = await lstatIfPresent(transaction.release);
    if (candidateMetadata) {
      if (
        !candidateMetadata.isDirectory() ||
        candidateMetadata.isSymbolicLink()
      ) {
        reject("deployment transaction candidate is invalid");
      }
    } else if (currentTarget !== transaction.previous) {
      reject("deployment transaction candidate is missing while active");
    }
    let pendingPresent = false;
    if (pendingMetadata) {
      const pending = await readPendingRelease(base);
      if (
        pending.release !== transaction.release ||
        pending.commit !== transaction.commit
      ) {
        reject("deployment pending marker disagrees with transaction journal");
      }
      pendingPresent = true;
    }
    return {
      kind: "transaction",
      previous: transaction.previous,
      release: transaction.release,
      commit: transaction.commit,
      bootstrap: transaction.bootstrap,
      candidatePresent: Boolean(candidateMetadata),
      pendingPresent,
    };
  }

  if (pendingMetadata) {
    const pending = await readPendingRelease(base);
    if (currentTarget === pending.release) {
      reject("active release has a pending marker without a transaction journal");
    }
    const candidateMetadata = await lstatIfPresent(pending.release);
    if (
      candidateMetadata &&
      (!candidateMetadata.isDirectory() || candidateMetadata.isSymbolicLink())
    ) {
      reject("deployment pending candidate is invalid");
    }
    return {
      kind: "pending",
      release: pending.release,
      commit: pending.commit,
      candidatePresent: Boolean(candidateMetadata),
    };
  }

  return { kind: "none" };
}

function recoveryFields(state) {
  if (state.kind === "none") return "none\n";
  if (state.kind === "pending") {
    return `pending\n${state.release}\n${state.commit}\n`;
  }
  return (
    `transaction\n${state.previous}\n${state.release}\n${state.commit}\n` +
    `${state.bootstrap ? "1" : "0"}\n`
  );
}

export async function syncDeploymentDirectory(base) {
  await syncDirectory(validateBase(base));
}

export async function syncReleaseDirectory(base) {
  const releases = join(validateBase(base), "releases");
  await assertRealDirectory(releases, "release directory");
  await syncDirectory(releases);
  await syncDirectory(base);
}

async function assertRealDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") reject(`${label} is not a real directory`);
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    reject(`${label} is not a real directory`);
  }
}

async function syncRegularFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncReleaseTree(base, path) {
  validateBase(base);
  validateTreePath(path, base);
  const root = await lstat(path);
  if (!root.isDirectory() || root.isSymbolicLink()) {
    reject("release tree root is not a real directory");
  }
  const pending = [path];
  const directories = [];
  let entriesSeen = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entriesSeen += 1;
      if (entriesSeen > 200_000) reject("release tree has too many entries");
      const child = join(directory, entry.name);
      const metadata = await lstat(child);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        pending.push(child);
      } else if (metadata.isFile() && !metadata.isSymbolicLink()) {
        await syncRegularFile(child);
      } else if (!metadata.isSymbolicLink()) {
        reject("release tree contains a non-durable special entry");
      }
    }
  }
  for (const directory of directories.reverse()) {
    await syncDirectory(directory);
  }
  await syncDirectory(dirname(path));
  await syncDirectory(base);
}

async function main() {
  const [command, base, previous, release, commit, bootstrap] =
    process.argv.slice(2);
  if (command === "begin" && base && previous && release && commit) {
    if (bootstrap !== "0" && bootstrap !== "1") {
      reject("bootstrap must be 0 or 1");
    }
    const value = await beginTransaction({
      base,
      previous,
      release,
      commit,
      bootstrap: bootstrap === "1",
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (command === "read" && base && !previous) {
    process.stdout.write(`${JSON.stringify(await readTransaction(base))}\n`);
    return;
  }
  if (command === "read-fields" && base && !previous) {
    const value = await readTransaction(base);
    process.stdout.write(
      `${value.previous}\n${value.release}\n${value.commit}\n${value.bootstrap ? "1" : "0"}\n`,
    );
    return;
  }
  if (command === "clear" && base && !previous) {
    if (!(await clearTransaction(base))) {
      reject("deployment transaction is missing during clear");
    }
    return;
  }
  if (
    command === "ensure" &&
    base &&
    previous &&
    release &&
    commit &&
    (bootstrap === "0" || bootstrap === "1")
  ) {
    const value = await ensureTransaction({
      base,
      previous,
      release,
      commit,
      bootstrap: bootstrap === "1",
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (
    command === "inspect-recovery-fields" &&
    base &&
    previous &&
    !release
  ) {
    process.stdout.write(
      recoveryFields(await inspectRecoveryState(base, previous)),
    );
    return;
  }
  if (command === "write-pending" && base && previous && release && !commit) {
    const value = await writePendingRelease({
      base,
      release: previous,
      commit: release,
    });
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (command === "read-pending-fields" && base && !previous) {
    const value = await readPendingRelease(base);
    process.stdout.write(`${value.release}\n${value.commit}\n`);
    return;
  }
  if (
    command === "clear-pending" &&
    base &&
    previous &&
    release &&
    !commit
  ) {
    await clearPendingRelease(base, previous, release);
    return;
  }
  if (command === "sync-releases" && base && !previous) {
    await syncReleaseDirectory(base);
    return;
  }
  if (command === "sync" && base && !previous) {
    await syncDeploymentDirectory(base);
    return;
  }
  if (command === "sync-tree" && base && previous && !release) {
    await syncReleaseTree(base, previous);
    return;
  }
  if (command === "write-bootstrap" && base && previous && !release) {
    await writeBootstrapMarker(base, previous);
    return;
  }
  reject(
    "usage: deploy-transaction.mjs begin <base> <previous> <release> " +
    "<commit> <0|1> | ensure <base> <previous> <release> <commit> <0|1> | " +
      "read <base> | read-fields <base> | clear <base> | " +
      "inspect-recovery-fields <base> <current-release> | " +
      "sync <base> | sync-tree <base> <release-tree> | " +
      "write-bootstrap <base> <commit> | " +
      "write-pending <base> <release> <commit> | read-pending-fields <base> | " +
      "clear-pending <base> <release> <commit> | sync-releases <base>",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`deployment transaction rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
