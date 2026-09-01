import { createHash } from "node:crypto";
import {
  assertCollectionRowMatchesDefinition,
  collectionDefinitionSchema,
  collectionRowSchema,
  type CollectionDefinition,
  type CollectionRow,
} from "../collections/model.ts";
import { stableNotionAssetId } from "./notion-assets.ts";
import { normalizeNotionId } from "./snapshot.ts";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_ASSETS_PER_NODE = 64;

export type NotionSnapshotNodeKind = "page" | "collection" | "row";

export interface NotionSnapshotV2Counts {
  nodes: number;
  pages: number;
  collections: number;
  rows: number;
  assets: number;
  emptyBlocks: number;
  hardBreaks: number;
  externalLinks: number;
  tables: number;
  columns: number;
  callouts: number;
  toggles: number;
}

export interface NotionSnapshotV2Manifest {
  type: "manifest";
  version: 2;
  source: "notion";
  rootNotionIds: string[];
  counts: NotionSnapshotV2Counts;
}

export interface NotionSnapshotV2Asset {
  url: string;
  name: string;
  kind: "image" | "file" | "cover";
}

interface NotionSnapshotV2NodeBase {
  type: "node";
  kind: NotionSnapshotNodeKind;
  notionId: string;
  parentNotionId: string | null;
  position: number;
  title: string;
  icon?: string;
  enhancedMarkdown: string;
  assets: NotionSnapshotV2Asset[];
}

export interface NotionSnapshotV2Page extends NotionSnapshotV2NodeBase {
  kind: "page";
}

export interface NotionSnapshotV2Collection extends NotionSnapshotV2NodeBase {
  kind: "collection";
  collection: CollectionDefinition;
}

export interface NotionSnapshotV2Row extends NotionSnapshotV2NodeBase {
  kind: "row";
  collectionRow: CollectionRow;
}

export type NotionSnapshotV2Node =
  | NotionSnapshotV2Page
  | NotionSnapshotV2Collection
  | NotionSnapshotV2Row;

export interface NotionSnapshotV2End {
  type: "end";
  nodeCount: number;
  assetCount: number;
}

export interface NotionSnapshotV2 {
  manifest: NotionSnapshotV2Manifest;
  nodes: NotionSnapshotV2Node[];
  fingerprint: string;
}

export interface NotionSnapshotV2ReadOptions {
  maxBytes?: number;
  maxLineBytes?: number;
  expectedSnapshots?: number;
}

export async function readNotionSnapshotV2Jsonl(
  input: string | AsyncIterable<string | Uint8Array>,
  options: Omit<NotionSnapshotV2ReadOptions, "expectedSnapshots"> = {},
): Promise<NotionSnapshotV2> {
  const snapshots = await readNotionSnapshotV2SequenceJsonl(input, {
    ...options,
    expectedSnapshots: 1,
  });
  return snapshots[0];
}

export async function readNotionSnapshotV2SequenceJsonl(
  input: string | AsyncIterable<string | Uint8Array>,
  options: NotionSnapshotV2ReadOptions = {},
): Promise<NotionSnapshotV2[]> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(maxLineBytes) ||
    maxLineBytes <= 0 ||
    maxLineBytes > maxBytes
  ) {
    throw new Error("invalid Notion snapshot v2 byte limits");
  }
  const text = await readBoundedText(input, maxBytes);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("Notion snapshot v2 JSONL is empty");

  const snapshots: NotionSnapshotV2[] = [];
  let manifest: NotionSnapshotV2Manifest | undefined;
  let nodes: NotionSnapshotV2Node[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      throw new Error(`blank Notion snapshot v2 JSONL line ${index + 1}`);
    }
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      throw new Error(`Notion snapshot v2 JSONL line ${index + 1} exceeds byte limit`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid Notion snapshot v2 JSON on line ${index + 1}`);
    }
    const type = objectRecord(parsed).type;
    if (type === "manifest") {
      if (manifest) throw new Error("Notion snapshot v2 manifest appeared before end");
      manifest = parseManifest(parsed);
      nodes = [];
      continue;
    }
    if (!manifest) throw new Error("Notion snapshot v2 must start with manifest");
    if (type === "node") {
      if (nodes.length >= MAX_NODES) {
        throw new Error("Notion snapshot v2 exceeds node limit");
      }
      nodes.push(parseNode(parsed));
      continue;
    }
    if (type === "end") {
      snapshots.push(finalizeSnapshot(manifest, nodes, parseEnd(parsed)));
      manifest = undefined;
      nodes = [];
      continue;
    }
    throw new Error(`unsupported Notion snapshot v2 record on line ${index + 1}`);
  }
  if (manifest) throw new Error("Notion snapshot v2 has no end record");
  if (
    options.expectedSnapshots !== undefined &&
    snapshots.length !== options.expectedSnapshots
  ) {
    throw new Error(
      `expected ${options.expectedSnapshots} Notion snapshot v2 records, received ${snapshots.length}`,
    );
  }
  return snapshots;
}

export function assertNotionSnapshotV2Match(
  received: NotionSnapshotV2,
  fresh: NotionSnapshotV2,
): void {
  if (received.fingerprint !== fresh.fingerprint) {
    throw new Error("fresh Notion snapshot v2 does not match the frozen received set");
  }
}

export function deriveNotionSnapshotV2Counts(
  nodes: readonly NotionSnapshotV2Node[],
): NotionSnapshotV2Counts {
  const combined = nodes.map((node) => node.enhancedMarkdown).join("\n");
  const count = (pattern: RegExp) => [...combined.matchAll(pattern)].length;
  const externalLinks = [...combined.matchAll(/(?<!!)\[[^\]]*\]\((https:\/\/[^)\s]+)\)/gi)]
    .filter((match) => {
      try {
        const host = new URL(match[1]).hostname;
        return ![
          "notion.so",
          "www.notion.so",
          "notion.com",
          "www.notion.com",
          "app.notion.com",
        ].includes(host) && !host.endsWith(".notion.site");
      } catch {
        return false;
      }
    }).length;
  return {
    nodes: nodes.length,
    pages: nodes.filter((node) => node.kind === "page").length,
    collections: nodes.filter((node) => node.kind === "collection").length,
    rows: nodes.filter((node) => node.kind === "row").length,
    assets: nodes.reduce((sum, node) => sum + node.assets.length, 0),
    emptyBlocks: count(/(?:<empty-block\s*\/>|<!--\s*notion-empty-block\s*-->)/gi),
    hardBreaks: count(/<br\s*\/?\s*>/gi),
    externalLinks,
    tables:
      count(/^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}.*\|/gm) + count(/<table\b/gi),
    columns: count(/<(?:column-list|columns)\b/gi),
    callouts: count(/<callout\b/gi),
    toggles: count(/<(?:toggle|details)\b/gi),
  };
}

function finalizeSnapshot(
  manifest: NotionSnapshotV2Manifest,
  nodes: NotionSnapshotV2Node[],
  end: NotionSnapshotV2End,
): NotionSnapshotV2 {
  if (nodes.length !== manifest.counts.nodes || nodes.length !== end.nodeCount) {
    throw new Error("Notion snapshot v2 node count mismatch");
  }
  const ids = new Set<string>();
  const nodeById = new Map<string, NotionSnapshotV2Node>();
  const assetDescriptors = new Map<string, string>();
  let assetCount = 0;
  for (const node of nodes) {
    if (ids.has(node.notionId)) throw new Error("duplicate Notion snapshot v2 node id");
    ids.add(node.notionId);
    nodeById.set(node.notionId, node);
    const localAssets = new Set<string>();
    for (const asset of node.assets) {
      assetCount += 1;
      const sourceId = stableNotionAssetId(asset.url);
      if (localAssets.has(sourceId)) {
        throw new Error("duplicate Notion snapshot v2 asset on one node");
      }
      localAssets.add(sourceId);
      const descriptor = stableJson({ name: asset.name, kind: asset.kind });
      const previous = assetDescriptors.get(sourceId);
      if (previous !== undefined && previous !== descriptor) {
        throw new Error("Notion snapshot v2 asset descriptor conflict");
      }
      assetDescriptors.set(sourceId, descriptor);
    }
  }
  if (assetCount !== manifest.counts.assets || assetCount !== end.assetCount) {
    throw new Error("Notion snapshot v2 asset count mismatch");
  }
  const roots = nodes.filter((node) => node.parentNotionId === null);
  if (
    roots.length !== manifest.rootNotionIds.length ||
    roots.some((node, index) => node.notionId !== manifest.rootNotionIds[index])
  ) {
    throw new Error("Notion snapshot v2 roots do not match manifest order");
  }
  for (const node of nodes) {
    if (node.parentNotionId && !nodeById.has(node.parentNotionId)) {
      throw new Error("Notion snapshot v2 parent is missing");
    }
    if (node.kind === "row") {
      const parent = node.parentNotionId
        ? nodeById.get(node.parentNotionId)
        : undefined;
      if (!parent || parent.kind !== "collection") {
        throw new Error("Notion snapshot v2 row parent must be a collection");
      }
      assertRowMatchesCollection(node, parent);
    }
    if (node.kind === "collection") {
      for (const view of node.collection.views) {
        for (const rowNotionId of view.rowNotionIds) {
          const row = nodeById.get(rowNotionId);
          if (
            !row ||
            row.kind !== "row" ||
            row.parentNotionId !== node.notionId
          ) {
            throw new Error(
              "Notion snapshot v2 collection view references a missing row",
            );
          }
        }
      }
    }
  }
  assertSiblingPositions(nodes);
  assertReachable(nodes, manifest.rootNotionIds);
  const derived = deriveNotionSnapshotV2Counts(nodes);
  for (const key of Object.keys(derived) as Array<keyof NotionSnapshotV2Counts>) {
    if (derived[key] !== manifest.counts[key]) {
      throw new Error(`Notion snapshot v2 manifest count mismatch: ${key}`);
    }
  }
  const withoutFingerprint = { manifest, nodes };
  return {
    ...withoutFingerprint,
    fingerprint: snapshotFingerprint(withoutFingerprint),
  };
}

function snapshotFingerprint(snapshot: {
  manifest: NotionSnapshotV2Manifest;
  nodes: NotionSnapshotV2Node[];
}): string {
  const nodes = snapshot.nodes
    .map((node) => {
      let enhancedMarkdown = node.enhancedMarkdown;
      const assets = node.assets
        .map((asset) => {
          const sourceId = stableNotionAssetId(asset.url);
          enhancedMarkdown = enhancedMarkdown.split(asset.url).join(`notion-asset:${sourceId}`);
          return { sourceId, name: asset.name, kind: asset.kind };
        })
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
      return {
        ...node,
        icon: node.icon ?? null,
        enhancedMarkdown,
        assets,
      };
    })
    .sort((left, right) => left.notionId.localeCompare(right.notionId));
  return createHash("sha256")
    .update(
      stableJson({
        version: snapshot.manifest.version,
        source: snapshot.manifest.source,
        rootNotionIds: snapshot.manifest.rootNotionIds,
        counts: snapshot.manifest.counts,
        nodes,
      }),
    )
    .digest("hex");
}

function parseManifest(input: unknown): NotionSnapshotV2Manifest {
  const value = objectRecord(input);
  exactKeys(value, ["type", "version", "source", "rootNotionIds", "counts"]);
  if (value.type !== "manifest" || value.version !== 2 || value.source !== "notion") {
    throw new Error("invalid Notion snapshot v2 manifest");
  }
  if (
    !Array.isArray(value.rootNotionIds) ||
    value.rootNotionIds.length < 1 ||
    value.rootNotionIds.length > 64
  ) {
    throw new Error("invalid Notion snapshot v2 roots");
  }
  const rootNotionIds = value.rootNotionIds.map((id) =>
    normalizeNotionId(stringValue(id, "rootNotionIds")),
  );
  if (new Set(rootNotionIds).size !== rootNotionIds.length) {
    throw new Error("duplicate Notion snapshot v2 root id");
  }
  return {
    type: "manifest",
    version: 2,
    source: "notion",
    rootNotionIds,
    counts: parseCounts(value.counts),
  };
}

function parseCounts(input: unknown): NotionSnapshotV2Counts {
  const value = objectRecord(input);
  const keys: Array<keyof NotionSnapshotV2Counts> = [
    "nodes",
    "pages",
    "collections",
    "rows",
    "assets",
    "emptyBlocks",
    "hardBreaks",
    "externalLinks",
    "tables",
    "columns",
    "callouts",
    "toggles",
  ];
  exactKeys(value, keys);
  return Object.fromEntries(
    keys.map((key) => [key, nonNegativeInteger(value[key], key)]),
  ) as unknown as NotionSnapshotV2Counts;
}

function parseNode(input: unknown): NotionSnapshotV2Node {
  const value = objectRecord(input);
  const kind = value.kind;
  const baseKeys = [
    "type",
    "kind",
    "notionId",
    "parentNotionId",
    "position",
    "title",
    "enhancedMarkdown",
    "assets",
  ];
  if (kind === "page") exactKeys(value, baseKeys, ["icon"]);
  else if (kind === "collection") exactKeys(value, [...baseKeys, "collection"], ["icon"]);
  else if (kind === "row") exactKeys(value, [...baseKeys, "collectionRow"], ["icon"]);
  else throw new Error("invalid Notion snapshot v2 node kind");
  if (value.type !== "node") throw new Error("invalid Notion snapshot v2 node");
  const title = stringValue(value.title, "title").trim();
  const enhancedMarkdown = stringValue(value.enhancedMarkdown, "enhancedMarkdown")
    .replace(/\r\n?/g, "\n");
  if (
    (!title && kind !== "row") ||
    title.length > 500 ||
    hasControl(title) ||
    enhancedMarkdown.includes("\0") ||
    Buffer.byteLength(enhancedMarkdown, "utf8") > 2 * 1024 * 1024
  ) {
    throw new Error("invalid Notion snapshot v2 node text");
  }
  if (!Array.isArray(value.assets) || value.assets.length > MAX_ASSETS_PER_NODE) {
    throw new Error("invalid Notion snapshot v2 node assets");
  }
  const icon = value.icon === undefined ? undefined : stringValue(value.icon, "icon");
  if (icon !== undefined && (icon.length > 64 || hasControl(icon))) {
    throw new Error("invalid Notion snapshot v2 icon");
  }
  const base: NotionSnapshotV2NodeBase = {
    type: "node",
    kind,
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
  if (kind === "collection") {
    const parsed = collectionDefinitionSchema.safeParse(value.collection);
    if (!parsed.success) {
      throw new Error("invalid Notion snapshot v2 collection definition");
    }
    if (parsed.data.databaseId !== base.notionId) {
      throw new Error("Notion snapshot v2 collection id does not match its node");
    }
    return { ...base, kind, collection: parsed.data };
  }
  if (kind === "row") {
    const parsed = collectionRowSchema.safeParse(value.collectionRow);
    if (!parsed.success) {
      throw new Error("invalid Notion snapshot v2 collection row");
    }
    return { ...base, kind, collectionRow: parsed.data };
  }
  return { ...base, kind };
}

function parseAsset(input: unknown): NotionSnapshotV2Asset {
  const value = objectRecord(input);
  exactKeys(value, ["url", "name", "kind"]);
  const kind = value.kind;
  if (kind !== "image" && kind !== "file" && kind !== "cover") {
    throw new Error("invalid Notion snapshot v2 asset kind");
  }
  const url = stringValue(value.url, "asset.url");
  stableNotionAssetId(url);
  const name = boundedText(value.name, "asset.name", 500);
  if (Buffer.byteLength(name, "utf8") > 1_000) {
    throw new Error("invalid Notion snapshot v2 asset name");
  }
  return { url, name, kind };
}

function parseEnd(input: unknown): NotionSnapshotV2End {
  const value = objectRecord(input);
  exactKeys(value, ["type", "nodeCount", "assetCount"]);
  if (value.type !== "end") throw new Error("invalid Notion snapshot v2 end record");
  return {
    type: "end",
    nodeCount: nonNegativeInteger(value.nodeCount, "nodeCount"),
    assetCount: nonNegativeInteger(value.assetCount, "assetCount"),
  };
}

function assertRowMatchesCollection(
  row: NotionSnapshotV2Row,
  collection: NotionSnapshotV2Collection,
): void {
  try {
    assertCollectionRowMatchesDefinition(collection.collection, row.collectionRow);
  } catch {
    throw new Error("Notion snapshot v2 row does not match collection definition");
  }
  const sourceTitle =
    row.collectionRow.values[collection.collection.titlePropertyId];
  const expectedBrainTitle =
    sourceTitle?.type === "title" && sourceTitle.value.trim()
      ? sourceTitle.value.trim()
      : "Untitled";
  if (
    sourceTitle?.type !== "title" ||
    row.title !== expectedBrainTitle
  ) {
    throw new Error("Notion snapshot v2 row title does not match its typed value");
  }
  const definitions = new Map(
    collection.collection.properties.map((property) => [property.id, property]),
  );
  for (const [propertyId, value] of Object.entries(row.collectionRow.values)) {
    const definition = definitions.get(propertyId);
    if (!definition) continue;
    if (
      definition.type === "select" &&
      value.type === "select" &&
      value.value !== null &&
      !definition.options.some((option) => option.id === value.value?.id)
    ) {
      throw new Error("Notion snapshot v2 row uses an unknown collection option");
    }
    if (
      definition.type === "multi_select" &&
      value.type === "multi_select" &&
      value.value.some(
        (selected) =>
          !definition.options.some((option) => option.id === selected.id),
      )
    ) {
      throw new Error("Notion snapshot v2 row uses an unknown collection option");
    }
  }
}

function assertSiblingPositions(nodes: readonly NotionSnapshotV2Node[]): void {
  const groups = new Map<string | null, NotionSnapshotV2Node[]>();
  for (const node of nodes) {
    const siblings = groups.get(node.parentNotionId) ?? [];
    siblings.push(node);
    groups.set(node.parentNotionId, siblings);
  }
  for (const siblings of groups.values()) {
    siblings.sort((left, right) => left.position - right.position);
    siblings.forEach((node, index) => {
      if (node.position !== index) {
        throw new Error("Notion snapshot v2 sibling positions must be contiguous");
      }
    });
  }
}

function assertReachable(
  nodes: readonly NotionSnapshotV2Node[],
  rootNotionIds: readonly string[],
): void {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentNotionId) continue;
    const values = children.get(node.parentNotionId) ?? [];
    values.push(node.notionId);
    children.set(node.parentNotionId, values);
  }
  const seen = new Set<string>();
  const visit = (notionId: string) => {
    if (seen.has(notionId)) {
      throw new Error("Notion snapshot v2 hierarchy contains a cycle");
    }
    seen.add(notionId);
    for (const child of children.get(notionId) ?? []) visit(child);
  };
  for (const root of rootNotionIds) visit(root);
  if (seen.size !== nodes.length) {
    throw new Error("Notion snapshot v2 hierarchy is disconnected");
  }
}

async function readBoundedText(
  input: string | AsyncIterable<string | Uint8Array>,
  maxBytes: number,
): Promise<string> {
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > maxBytes) {
      throw new Error("Notion snapshot v2 JSONL exceeds byte limit");
    }
    return input;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new Error("Notion snapshot v2 JSONL exceeds byte limit");
    }
    text += decoder.decode(bytes, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function objectRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Notion snapshot v2 record must be an object");
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
    throw new Error("Notion snapshot v2 record has missing or unknown fields");
  }
}

function stringValue(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new Error(`Notion snapshot v2 ${field} must be a string`);
  }
  return input;
}

function boundedText(input: unknown, field: string, maxLength: number): string {
  const value = stringValue(input, field);
  if (!value.trim() || value.length > maxLength || hasControl(value)) {
    throw new Error(`invalid Notion snapshot v2 ${field}`);
  }
  return value;
}

function hasControl(input: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(input);
}

function nonNegativeInteger(input: unknown, field: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 0) {
    throw new Error(`Notion snapshot v2 ${field} must be a non-negative integer`);
  }
  return input as number;
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
