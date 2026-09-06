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
  /** Roots a visitor has written to. Not the roots that have `shareEdit` on,
   *  which is the whole of the difference at the read boundary: a root nobody
   *  has written to yet holds no visitor Markdown, so the reference check
   *  still decides for it. The new rule applies to these and to no others, so
   *  no existing read-only share changes behaviour. */
  roots: string[];
  /** Uploaded by a visitor: name → the one root it belongs to. */
  uploads: Record<string, { root: string; bytes: number; at: string }>;
  /** Named by the subtree before the first visitor write to the root, which
   *  is when the walk that builds this runs: name → roots. */
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
 *  empty scope, never a throw: a corrupted index must not turn every image on
 *  the site into a 500. An empty scope holds no root, so the reference check
 *  decides again, which is what a read-only share has always done, and a
 *  visitor gains nothing by it: the write boundary rebuilds a lost root's
 *  baseline from the live subtree before it admits any reference, so no page
 *  can name an attachment the subtree does not already show. Each section is
 *  validated on its own, so one bad entry cannot turn a byte total into NaN
 *  or a grant into a crash. */
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

/** The owner names an attachment in a page the link already shows. The owner
 *  has authority over the whole notes folder, so this is the owner choosing to
 *  expose that file, which is what the first baseline walk assumes about every
 *  reference it finds. A visitor's reference still grants nothing: only an
 *  owner write reaches here.
 *
 *  An upload comes here too. It has a home root in the ledger, which is where
 *  its bytes are charged and the one root that may name it before any page
 *  shows it. That is not the same question as which roots may show it: an
 *  owner who moves the page carrying a visitor's image into a second shared
 *  root used to get a broken picture there, permanently, with no signal and
 *  no action that repaired it. The baseline is how the second root learns.
 *
 *  Returns the same object when the root is unscoped or every name is already
 *  in its baseline, so a caller can tell by identity whether there is anything
 *  to persist. */
export function extendBaseline(
  scope: AttachmentScope,
  root: string,
  names: readonly string[],
): AttachmentScope {
  if (!scope.roots.includes(root)) return scope;
  let baseline: AttachmentScope["baseline"] | undefined;
  for (const name of names) {
    const roots = scope.baseline[name] ?? [];
    if (roots.includes(root)) continue;
    baseline ??= { ...scope.baseline };
    baseline[name] = [...roots, root];
  }
  if (!baseline) return scope;
  return { roots: scope.roots, uploads: scope.uploads, baseline };
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

/** Where a visitor uploaded the file. The one grant that stands with no live
 *  page behind it: the upload is the reason the write naming it exists, and
 *  nothing shows it yet. Its bytes are charged to this root and no other, so
 *  an owner move never re-charges a quota. */
export function rootOwnsUpload(
  scope: AttachmentScope,
  name: string,
  root: string,
): boolean {
  return scope.uploads[name]?.root === root;
}

/** Whether the index puts this attachment on this root's link at all. A name
 *  the index has never heard of belongs to no root, which is a 404 at the read
 *  boundary. An upload's home root grants it, and so does any root the owner
 *  has since shown it under. The write boundary asks a second, live question
 *  on top of this one, so a baseline entry alone does not let a visitor put
 *  back a picture the owner has moved out. */
export function attachmentGrantsRoot(
  scope: AttachmentScope,
  name: string,
  root: string,
): boolean {
  return (
    rootOwnsUpload(scope, name, root) ||
    (scope.baseline[name] ?? []).includes(root)
  );
}
