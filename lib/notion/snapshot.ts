import { createHash } from "node:crypto";
import { stableNotionAssetId } from "./notion-assets.ts";

const NOTION_ID_RE = /^[a-f0-9]{32}$/;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

export interface ChannelSnapshotCounts {
  pages: number;
  assets: number;
  emptyBlocks: number;
  hardBreaks: number;
  externalLinks: number;
  databases: number;
  tables: number;
  columns: number;
  callouts: number;
  toggles: number;
}

export interface SnapshotAssetRecord {
  url: string;
  name: string;
  kind: "image" | "file" | "cover";
}

export interface SnapshotManifestRecord {
  type: "manifest";
  version: 1;
  pilot: "channel";
  rootNotionId: string;
  counts: ChannelSnapshotCounts;
}

export interface SnapshotPageRecord {
  type: "page";
  notionId: string;
  parentNotionId: string | null;
  position: number;
  title: string;
  icon?: string;
  enhancedMarkdown: string;
  assets: SnapshotAssetRecord[];
}

export interface SnapshotEndRecord {
  type: "end";
  pageCount: number;
  assetCount: number;
}

export interface NotionSnapshot {
  manifest: SnapshotManifestRecord;
  pages: SnapshotPageRecord[];
  fingerprint: string;
}

export interface SnapshotReadOptions {
  maxBytes?: number;
  maxLineBytes?: number;
  expectedSnapshots?: number;
}

export async function readSnapshotJsonl(
  input: string | AsyncIterable<string | Uint8Array>,
  options: Omit<SnapshotReadOptions, "expectedSnapshots"> = {},
): Promise<NotionSnapshot> {
  const snapshots = await readSnapshotSequenceJsonl(input, {
    ...options,
    expectedSnapshots: 1,
  });
  return snapshots[0];
}

export async function readSnapshotSequenceJsonl(
  input: string | AsyncIterable<string | Uint8Array>,
  options: SnapshotReadOptions = {},
): Promise<NotionSnapshot[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(maxLineBytes) ||
    maxLineBytes <= 0 ||
    maxLineBytes > maxBytes
  ) {
    throw new Error("invalid snapshot byte limits");
  }
  const text = await readBoundedText(input, maxBytes);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("snapshot JSONL is empty");

  const snapshots: NotionSnapshot[] = [];
  let manifest: SnapshotManifestRecord | undefined;
  let pages: SnapshotPageRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) throw new Error(`blank snapshot JSONL line ${index + 1}`);
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      throw new Error(`snapshot JSONL line ${index + 1} exceeds byte limit`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid snapshot JSON on line ${index + 1}`);
    }
    const type = recordType(parsed);
    if (type === "manifest") {
      if (manifest) throw new Error("snapshot manifest appeared before end");
      manifest = parseManifest(parsed);
      pages = [];
      continue;
    }
    if (!manifest) throw new Error("snapshot must start with manifest");
    if (type === "page") {
      pages.push(parsePage(parsed));
      continue;
    }
    if (type === "end") {
      const end = parseEnd(parsed);
      snapshots.push(finalizeSnapshot(manifest, pages, end));
      manifest = undefined;
      pages = [];
      continue;
    }
    throw new Error(`unsupported snapshot record type on line ${index + 1}`);
  }
  if (manifest) throw new Error("snapshot JSONL has no end record");
  const expectedSnapshots = options.expectedSnapshots;
  if (
    expectedSnapshots !== undefined &&
    snapshots.length !== expectedSnapshots
  ) {
    throw new Error(`expected ${expectedSnapshots} snapshots, received ${snapshots.length}`);
  }
  return snapshots;
}

export function assertSnapshotsMatch(
  frozen: NotionSnapshot,
  fresh: NotionSnapshot,
): void {
  if (frozen.fingerprint !== fresh.fingerprint) {
    throw new Error("fresh Notion snapshot does not match the frozen received set");
  }
}

export function normalizeNotionId(input: string): string {
  const normalized = input.replace(/-/g, "").toLowerCase();
  if (!NOTION_ID_RE.test(normalized)) {
    throw new Error("Notion id must be 32 hexadecimal characters");
  }
  return normalized;
}

function finalizeSnapshot(
  manifest: SnapshotManifestRecord,
  pages: SnapshotPageRecord[],
  end: SnapshotEndRecord,
): NotionSnapshot {
  if (pages.length !== manifest.counts.pages || pages.length !== end.pageCount) {
    throw new Error("snapshot page count mismatch");
  }
  const ids = new Set<string>();
  const assetIds = new Set<string>();
  let assetCount = 0;
  for (const page of pages) {
    if (ids.has(page.notionId)) throw new Error("duplicate snapshot page id");
    ids.add(page.notionId);
    for (const asset of page.assets) {
      assetCount += 1;
      const stableId = stableNotionAssetId(asset.url);
      if (assetIds.has(stableId)) throw new Error("duplicate snapshot asset id");
      assetIds.add(stableId);
    }
  }
  if (assetCount !== manifest.counts.assets || assetCount !== end.assetCount) {
    throw new Error("snapshot asset count mismatch");
  }
  if (!ids.has(manifest.rootNotionId)) {
    throw new Error("snapshot root is missing");
  }
  for (const page of pages) {
    if (page.parentNotionId && !ids.has(page.parentNotionId)) {
      throw new Error("snapshot parent is missing");
    }
  }
  const snapshot = { manifest, pages, fingerprint: "" };
  return { ...snapshot, fingerprint: snapshotFingerprint(snapshot) };
}

function snapshotFingerprint(
  snapshot: Omit<NotionSnapshot, "fingerprint">,
): string {
  const pages = snapshot.pages
    .map((page) => {
      let markdown = page.enhancedMarkdown;
      const assets = page.assets
        .map((asset) => {
          const sourceId = stableNotionAssetId(asset.url);
          markdown = markdown.split(asset.url).join(`notion-asset:${sourceId}`);
          return { sourceId, name: asset.name, kind: asset.kind };
        })
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
      return {
        notionId: page.notionId,
        parentNotionId: page.parentNotionId,
        position: page.position,
        title: page.title,
        icon: page.icon ?? null,
        enhancedMarkdown: markdown,
        assets,
      };
    })
    .sort((left, right) => left.notionId.localeCompare(right.notionId));
  return createHash("sha256")
    .update(
      stableJson({
        version: snapshot.manifest.version,
        pilot: snapshot.manifest.pilot,
        rootNotionId: snapshot.manifest.rootNotionId,
        counts: snapshot.manifest.counts,
        pages,
      }),
    )
    .digest("hex");
}

function parseManifest(input: unknown): SnapshotManifestRecord {
  const value = objectRecord(input);
  exactKeys(value, ["type", "version", "pilot", "rootNotionId", "counts"]);
  if (value.type !== "manifest" || value.version !== 1 || value.pilot !== "channel") {
    throw new Error("invalid snapshot manifest");
  }
  return {
    type: "manifest",
    version: 1,
    pilot: "channel",
    rootNotionId: normalizeNotionId(stringValue(value.rootNotionId, "rootNotionId")),
    counts: parseCounts(value.counts),
  };
}

function parseCounts(input: unknown): ChannelSnapshotCounts {
  const value = objectRecord(input);
  const keys: Array<keyof ChannelSnapshotCounts> = [
    "pages",
    "assets",
    "emptyBlocks",
    "hardBreaks",
    "externalLinks",
    "databases",
    "tables",
    "columns",
    "callouts",
    "toggles",
  ];
  exactKeys(value, keys);
  return Object.fromEntries(
    keys.map((key) => [key, nonNegativeInteger(value[key], key)]),
  ) as unknown as ChannelSnapshotCounts;
}

function parsePage(input: unknown): SnapshotPageRecord {
  const value = objectRecord(input);
  exactKeys(
    value,
    [
      "type",
      "notionId",
      "parentNotionId",
      "position",
      "title",
      "enhancedMarkdown",
      "assets",
    ],
    ["icon"],
  );
  if (value.type !== "page") throw new Error("invalid snapshot page record");
  const title = stringValue(value.title, "title").trim();
  const enhancedMarkdown = stringValue(
    value.enhancedMarkdown,
    "enhancedMarkdown",
  ).replace(/\r\n?/g, "\n");
  if (
    !title ||
    title.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(title) ||
    enhancedMarkdown.includes("\0") ||
    Buffer.byteLength(enhancedMarkdown) > 1024 * 1024
  ) {
    throw new Error("invalid snapshot page text");
  }
  if (!Array.isArray(value.assets) || value.assets.length > 20) {
    throw new Error("invalid snapshot page assets");
  }
  const icon = value.icon === undefined ? undefined : stringValue(value.icon, "icon");
  if (
    icon !== undefined &&
    (icon.length > 64 || /[\u0000-\u001f\u007f]/.test(icon))
  ) {
    throw new Error("invalid snapshot icon");
  }
  return {
    type: "page",
    notionId: normalizeNotionId(stringValue(value.notionId, "notionId")),
    parentNotionId:
      value.parentNotionId === null
        ? null
        : normalizeNotionId(stringValue(value.parentNotionId, "parentNotionId")),
    position: nonNegativeInteger(value.position, "position"),
    title,
    icon,
    enhancedMarkdown,
    assets: value.assets.map(parseAsset),
  };
}

function parseAsset(input: unknown): SnapshotAssetRecord {
  const value = objectRecord(input);
  exactKeys(value, ["url", "name", "kind"]);
  const kind = value.kind;
  if (kind !== "image" && kind !== "file" && kind !== "cover") {
    throw new Error("invalid snapshot asset kind");
  }
  const url = stringValue(value.url, "asset.url");
  stableNotionAssetId(url);
  const name = stringValue(value.name, "asset.name");
  if (
    !name.trim() ||
    name.length > 500 ||
    Buffer.byteLength(name, "utf8") > 1000 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("invalid snapshot asset name");
  }
  return { url, name, kind };
}

function parseEnd(input: unknown): SnapshotEndRecord {
  const value = objectRecord(input);
  exactKeys(value, ["type", "pageCount", "assetCount"]);
  if (value.type !== "end") throw new Error("invalid snapshot end record");
  return {
    type: "end",
    pageCount: nonNegativeInteger(value.pageCount, "pageCount"),
    assetCount: nonNegativeInteger(value.assetCount, "assetCount"),
  };
}

async function readBoundedText(
  input: string | AsyncIterable<string | Uint8Array>,
  maxBytes: number,
): Promise<string> {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maxBytes) {
      throw new Error("snapshot JSONL exceeds byte limit");
    }
    return input;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  for await (const chunk of input) {
    const bytes =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error("snapshot JSONL exceeds byte limit");
    text += decoder.decode(bytes, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function recordType(input: unknown): unknown {
  return objectRecord(input).type;
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("snapshot record must be an object");
  }
  return input as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error("snapshot record has missing or unknown fields");
  }
}

function stringValue(input: unknown, field: string): string {
  if (typeof input !== "string") throw new Error(`snapshot ${field} must be a string`);
  return input;
}

function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`snapshot ${field} must be a non-negative integer`);
  }
  return input as number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
