import { createHash } from "node:crypto";
import { readPrivateOperatorText } from "./private-operator-file.ts";
import { normalizeNotionId } from "./snapshot.ts";

const MAX_BINDINGS_BYTES = 2 * 1024 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;
const BRAIN_PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type NotionBindingDisposition = "create" | "skip" | "preserve" | "adopt";

interface NotionBindingBase {
  notionId: string;
  disposition: NotionBindingDisposition;
}

export interface NotionCreateBinding extends NotionBindingBase {
  disposition: "create";
}

export interface NotionSkipBinding extends NotionBindingBase {
  disposition: "skip";
  reason: string;
}

export interface NotionPreserveBinding extends NotionBindingBase {
  disposition: "preserve";
  brainPageId: string;
  expectedRev: string;
  expectedParentId: string | null;
  expectedBeforeId: string | null;
}

export interface NotionAdoptBinding extends NotionBindingBase {
  disposition: "adopt";
  brainPageId: string;
  expectedRev: string;
  expectedParentId: string | null;
  expectedBeforeId: string | null;
}

export type NotionBinding =
  | NotionCreateBinding
  | NotionSkipBinding
  | NotionPreserveBinding
  | NotionAdoptBinding;

export interface NotionBindings {
  version: 1;
  snapshotFingerprint: string;
  entries: NotionBinding[];
  entryByNotionId: ReadonlyMap<string, NotionBinding>;
  fingerprint: string;
}

export interface PrivateNotionBindingsReadOptions {
  forbiddenRoots?: readonly string[];
}

/** Parse the reviewed data without touching the filesystem. Live execution
 * must use readPrivateNotionBindingsFile so mode, owner, and path identity are
 * checked before any destination access. */
export function parseNotionBindingsJson(input: string): NotionBindings {
  if (Buffer.byteLength(input, "utf8") > MAX_BINDINGS_BYTES) {
    throw new Error("Notion bindings exceed byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Notion bindings contain invalid JSON");
  }
  const value = objectRecord(parsed);
  exactKeys(value, ["version", "snapshotFingerprint", "entries"]);
  if (value.version !== 1) throw new Error("unsupported Notion bindings version");
  const snapshotFingerprint = hashValue(value.snapshotFingerprint, "snapshotFingerprint");
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 20_000) {
    throw new Error("invalid Notion bindings entries");
  }
  const entries = value.entries.map(parseBinding);
  const entryByNotionId = new Map<string, NotionBinding>();
  const brainPageIds = new Set<string>();
  for (const entry of entries) {
    if (entryByNotionId.has(entry.notionId)) {
      throw new Error("duplicate Notion binding source id");
    }
    entryByNotionId.set(entry.notionId, entry);
    if (entry.disposition === "preserve" || entry.disposition === "adopt") {
      if (brainPageIds.has(entry.brainPageId)) {
        throw new Error("Notion bindings map multiple sources to one Brain page");
      }
      brainPageIds.add(entry.brainPageId);
    }
  }
  const normalized = { version: 1 as const, snapshotFingerprint, entries };
  return {
    ...normalized,
    entryByNotionId,
    fingerprint: bindingsFingerprint(normalized),
  };
}

/**
 * Open a private reviewed mapping without following symlinks. The containing
 * directory and file must both belong to the effective user and have 0700 and
 * 0600 modes respectively. This file may identify personal destination pages
 * and must never be committed with source code.
 */
export async function readPrivateNotionBindingsFile(
  filePath: string,
  options: PrivateNotionBindingsReadOptions = {},
): Promise<NotionBindings> {
  const text = await readPrivateOperatorText(filePath, {
    label: "Notion bindings",
    maxBytes: MAX_BINDINGS_BYTES,
    forbiddenRoots: options.forbiddenRoots,
  });
  return parseNotionBindingsJson(text);
}

function parseBinding(input: unknown): NotionBinding {
  const value = objectRecord(input);
  const disposition = value.disposition;
  if (disposition === "create") {
    exactKeys(value, ["notionId", "disposition"]);
    return {
      notionId: notionIdValue(value.notionId),
      disposition,
    };
  }
  if (disposition === "skip") {
    exactKeys(value, ["notionId", "disposition", "reason"]);
    return {
      notionId: notionIdValue(value.notionId),
      disposition,
      reason: safeText(value.reason, "reason", 500),
    };
  }
  if (disposition === "preserve") {
    exactKeys(value, [
      "notionId",
      "disposition",
      "brainPageId",
      "expectedRev",
      "expectedParentId",
      "expectedBeforeId",
    ]);
    const brainId = brainPageId(value.brainPageId, "brainPageId");
    const expectedParentId = nullableBrainPageId(
      value.expectedParentId,
      "expectedParentId",
    );
    const expectedBeforeId = nullableBrainPageId(
      value.expectedBeforeId,
      "expectedBeforeId",
    );
    assertNotSelfPlacement(brainId, expectedParentId, expectedBeforeId);
    return {
      notionId: notionIdValue(value.notionId),
      disposition,
      brainPageId: brainId,
      expectedRev: safeText(value.expectedRev, "expectedRev", 128),
      expectedParentId,
      expectedBeforeId,
    };
  }
  if (disposition === "adopt") {
    exactKeys(value, [
      "notionId",
      "disposition",
      "brainPageId",
      "expectedRev",
      "expectedParentId",
      "expectedBeforeId",
    ]);
    const brainId = brainPageId(value.brainPageId, "brainPageId");
    const expectedParentId = nullableBrainPageId(value.expectedParentId, "expectedParentId");
    const expectedBeforeId = nullableBrainPageId(value.expectedBeforeId, "expectedBeforeId");
    assertNotSelfPlacement(brainId, expectedParentId, expectedBeforeId);
    return {
      notionId: notionIdValue(value.notionId),
      disposition,
      brainPageId: brainId,
      expectedRev: safeText(value.expectedRev, "expectedRev", 128),
      expectedParentId,
      expectedBeforeId,
    };
  }
  throw new Error("invalid Notion binding disposition");
}

function assertNotSelfPlacement(
  brainPageId: string,
  expectedParentId: string | null,
  expectedBeforeId: string | null,
): void {
  if (expectedParentId === brainPageId || expectedBeforeId === brainPageId) {
    throw new Error("Notion binding cannot place a page relative to itself");
  }
}

function bindingsFingerprint(input: {
  version: 1;
  snapshotFingerprint: string;
  entries: NotionBinding[];
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        version: input.version,
        snapshotFingerprint: input.snapshotFingerprint,
        entries: [...input.entries].sort((left, right) =>
          left.notionId.localeCompare(right.notionId),
        ),
      }),
    )
    .digest("hex");
}

function notionIdValue(input: unknown): string {
  if (typeof input !== "string") throw new Error("Notion binding notionId must be a string");
  return normalizeNotionId(input);
}

function brainPageId(input: unknown, field: string): string {
  if (typeof input !== "string" || !BRAIN_PAGE_ID_RE.test(input)) {
    throw new Error(`invalid Notion binding ${field}`);
  }
  return input;
}

function nullableBrainPageId(input: unknown, field: string): string | null {
  return input === null ? null : brainPageId(input, field);
}

function hashValue(input: unknown, field: string): string {
  if (typeof input !== "string" || !HASH_RE.test(input)) {
    throw new Error(`invalid Notion binding ${field}`);
  }
  return input;
}

function safeText(input: unknown, field: string, maxLength: number): string {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(input)
  ) {
    throw new Error(`invalid Notion binding ${field}`);
  }
  return input;
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Notion bindings value must be an object");
  }
  return input as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const allowed = new Set(required);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("Notion bindings value has missing or unknown fields");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
