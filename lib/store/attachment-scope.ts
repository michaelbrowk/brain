import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic";
import { assertInRoot } from "./paths";
import { assertRealDirectory, ensureRealDirectory } from "./real-directory";

/**
 * Which root each attachment belongs to.
 *
 * The reference tokenizer cannot decide this once visitors write Markdown: any
 * existing `_attachments` filename named in a shared page would make a private
 * page's image readable. This file decides instead, and it lives in the notes
 * folder so it is written by the same atomicWrite, inside the same mutate(),
 * and committed by the same scheduleCommit as the bytes it authorizes. A
 * restore of the notes folder restores it with them. It is reached the way
 * the bytes are: through the path jail, never through a symlink.
 */
export interface AttachmentScope {
  /** Roots that have ever had `shareEdit` on. The new rule applies to these
   *  and to no others, so no existing read-only share changes behaviour. */
  roots: string[];
  /** Uploaded by a visitor: name → the one root it belongs to. */
  uploads: Record<string, { root: string; bytes: number; at: string }>;
  /** Named by the subtree before the root first became editable: name → roots. */
  baseline: Record<string, string[]>;
}

const EMPTY: AttachmentScope = { roots: [], uploads: {}, baseline: {} };

/** Five characters: one short of the six the attachment-name rule demands,
 *  which is what keeps the index from being served by /api/media or swept
 *  by the Store. A test pins that. */
const SCOPE_FILE = "scope.json";

function attachmentDirectory(notesRoot: string): string {
  return assertInRoot(
    notesRoot,
    path.join(/* turbopackIgnore: true */ notesRoot, "_attachments"),
  );
}

export function attachmentScopePath(notesRoot: string): string {
  const dir = attachmentDirectory(notesRoot);
  return assertInRoot(dir, path.join(dir, SCOPE_FILE));
}

/** A missing, malformed, symlinked or otherwise untrustworthy file is an
 *  empty scope, never a throw: a corrupted index must degrade to "no visitor
 *  attachment is readable", not to a 500 on every image on the site. Each
 *  section is validated on its own, so one bad entry cannot turn a byte
 *  total into NaN or a grant into a crash. */
export async function readAttachmentScope(
  notesRoot: string,
): Promise<AttachmentScope> {
  let raw: string;
  try {
    await assertRealDirectory(attachmentDirectory(notesRoot));
    raw = await readRegularFileNoFollow(attachmentScopePath(notesRoot));
  } catch {
    return { ...EMPTY };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (!isRecord(parsed)) return { ...EMPTY };
  return {
    roots: Array.isArray(parsed.roots)
      ? parsed.roots.filter((root): root is string => typeof root === "string")
      : [],
    uploads: readUploads(parsed.uploads),
    baseline: readBaseline(parsed.baseline),
  };
}

async function readRegularFileNoFollow(file: string): Promise<string> {
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("attachment scope index is not a regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function readUploads(value: unknown): AttachmentScope["uploads"] {
  const uploads: AttachmentScope["uploads"] = {};
  if (!isRecord(value)) return uploads;
  for (const [name, entry] of Object.entries(value)) {
    if (
      isRecord(entry) &&
      typeof entry.root === "string" &&
      typeof entry.bytes === "number" &&
      Number.isFinite(entry.bytes) &&
      typeof entry.at === "string"
    ) {
      uploads[name] = { root: entry.root, bytes: entry.bytes, at: entry.at };
    }
  }
  return uploads;
}

function readBaseline(value: unknown): AttachmentScope["baseline"] {
  const baseline: AttachmentScope["baseline"] = {};
  if (!isRecord(value)) return baseline;
  for (const [name, roots] of Object.entries(value)) {
    if (Array.isArray(roots)) {
      baseline[name] = roots.filter(
        (root): root is string => typeof root === "string",
      );
    }
  }
  return baseline;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same steps saveAttachmentUnlocked takes for the bytes: the directory
 *  is made if missing and proven real before the write, and proven the same
 *  directory after it. Caller owns mutate(). */
export async function writeAttachmentScope(
  notesRoot: string,
  scope: AttachmentScope,
): Promise<void> {
  const dir = attachmentDirectory(notesRoot);
  const file = assertInRoot(dir, path.join(dir, SCOPE_FILE));
  const identity = await ensureRealDirectory(dir);
  await atomicWrite(file, `${JSON.stringify(scope, null, 2)}\n`);
  await assertRealDirectory(dir, identity);
}

export function recordUpload(
  scope: AttachmentScope,
  name: string,
  root: string,
  bytes: number,
  at: string,
): AttachmentScope {
  return {
    roots: scope.roots.includes(root) ? scope.roots : [...scope.roots, root],
    uploads: { ...scope.uploads, [name]: { root, bytes, at } },
    baseline: scope.baseline,
  };
}

/** The sweep removed these files, so their bytes stop counting against
 *  their roots. Returns the same object when none of the names was an
 *  upload, so a caller can tell by identity whether there is anything to
 *  persist. */
export function forgetUploads(
  scope: AttachmentScope,
  names: readonly string[],
): AttachmentScope {
  const uploads = { ...scope.uploads };
  let changed = false;
  for (const name of names) {
    if (name in uploads) {
      delete uploads[name];
      changed = true;
    }
  }
  if (!changed) return scope;
  return { roots: scope.roots, uploads, baseline: scope.baseline };
}

/** Built once, on the first visitor write to a root, never inside
 *  configureShare, which would hold the mutation queue for an O(subtree) walk
 *  during an owner's confirmation click. A second call returns the same
 *  object untouched, so a caller can tell by identity whether there is
 *  anything to persist. */
export function recordBaseline(
  scope: AttachmentScope,
  root: string,
  names: readonly string[],
): AttachmentScope {
  if (scope.roots.includes(root)) return scope;
  const baseline = { ...scope.baseline };
  for (const name of names) {
    const roots = baseline[name] ?? [];
    if (!roots.includes(root)) baseline[name] = [...roots, root];
  }
  return { roots: [...scope.roots, root], uploads: scope.uploads, baseline };
}

export function rootIsScoped(scope: AttachmentScope, root: string): boolean {
  return scope.roots.includes(root);
}

export function rootUploadBytes(scope: AttachmentScope, root: string): number {
  let total = 0;
  for (const entry of Object.values(scope.uploads)) {
    if (entry.root === root) total += entry.bytes;
  }
  return total;
}

/** An upload belongs to exactly one root. A name the index has never heard of
 *  belongs to none, which is a 404 at the read boundary. */
export function attachmentGrantsRoot(
  scope: AttachmentScope,
  name: string,
  root: string,
): boolean {
  const upload = scope.uploads[name];
  if (upload) return upload.root === root;
  return (scope.baseline[name] ?? []).includes(root);
}
