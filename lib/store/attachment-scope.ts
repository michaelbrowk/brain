import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./atomic";

/**
 * Which root each attachment belongs to.
 *
 * The reference tokenizer cannot decide this once visitors write Markdown: any
 * existing `_attachments` filename named in a shared page would make a private
 * page's image readable. This file decides instead, and it lives in the notes
 * folder so it is written by the same atomicWrite, inside the same mutate(),
 * and committed by the same scheduleCommit as the bytes it authorizes. A
 * restore of the notes folder restores it with them.
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

export function attachmentScopePath(notesRoot: string): string {
  return path.join(
    /* turbopackIgnore: true */ notesRoot,
    "_attachments",
    "scope.json",
  );
}

/** A missing or malformed file is an empty scope, never a throw: a corrupted
 *  index must degrade to "no visitor attachment is readable", not to a 500 on
 *  every image on the site. Each section is validated on its own, so one bad
 *  entry cannot turn a byte total into NaN or a grant into a crash. */
export async function readAttachmentScope(
  notesRoot: string,
): Promise<AttachmentScope> {
  let raw: string;
  try {
    raw = await fs.readFile(attachmentScopePath(notesRoot), "utf8");
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

/** Caller owns mutate(). */
export async function writeAttachmentScope(
  notesRoot: string,
  scope: AttachmentScope,
): Promise<void> {
  await atomicWrite(
    attachmentScopePath(notesRoot),
    `${JSON.stringify(scope, null, 2)}\n`,
  );
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
