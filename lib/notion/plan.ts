import {
  assertEnhancedMarkdownReady,
  buildNotionDocumentFromEnhancedMarkdown,
  type EnhancedMarkdownStats,
} from "./enhanced-markdown.ts";
import { sourceHashForNotionDocument } from "./converter.ts";
import type { ResolvedNotionAsset } from "./notion-assets.ts";
import { stableNotionAssetId } from "./notion-assets.ts";
import {
  assertSnapshotsMatch,
  type ChannelSnapshotCounts,
  type NotionSnapshot,
  type SnapshotManifestRecord,
  type SnapshotPageRecord,
} from "./snapshot.ts";
import { isBrainCompatibleNotionIcon } from "./protocol.ts";
import type {
  NotionExecutionPage,
  NotionExecutionPlan,
} from "./execution-plan.ts";

export const CHANNEL_PILOT_COUNTS: Readonly<ChannelSnapshotCounts> = {
  pages: 16,
  assets: 3,
  emptyBlocks: 22,
  hardBreaks: 2,
  externalLinks: 7,
  databases: 0,
  tables: 0,
  columns: 0,
  callouts: 0,
  toggles: 0,
};

/** The pilot adapter authorizes a frozen page inventory: an import runs only
 * against the exact tree below, and a look-alike is rejected. Nothing in it was
 * measured — the ids, the titles, the child counts and the block counters are
 * invented, and lib/notion/channel-fixture.test-helper.ts builds the single
 * snapshot that satisfies them. Pointing the adapter at a workspace means
 * rewriting it, not swapping constants: the title guards, the child counts and
 * the asset count are frozen alongside the ids, so no tree but this one can
 * pass. Kept as the worked example the executor's tests drive. */
export const CHANNEL_ROOT_NOTION_ID = "f1e50000000000000000000000000000";

export const CHANNEL_PILOT_TOPOLOGY = [
  [CHANNEL_ROOT_NOTION_ID, null, 0],
  ["f1e50000000000000000000000000001", CHANNEL_ROOT_NOTION_ID, 0],
  ["f1e50000000000000000000000000002", CHANNEL_ROOT_NOTION_ID, 1],
  ["f1e50000000000000000000000000003", CHANNEL_ROOT_NOTION_ID, 2],
  ["f1e50000000000000000000000000004", "f1e50000000000000000000000000001", 0],
  ["f1e50000000000000000000000000005", "f1e50000000000000000000000000001", 1],
  ["f1e50000000000000000000000000006", "f1e50000000000000000000000000001", 2],
  ["f1e50000000000000000000000000007", "f1e50000000000000000000000000001", 3],
  ["f1e50000000000000000000000000008", "f1e50000000000000000000000000001", 4],
  ["f1e50000000000000000000000000009", "f1e50000000000000000000000000001", 5],
  ["f1e5000000000000000000000000000a", "f1e50000000000000000000000000001", 6],
  ["f1e5000000000000000000000000000b", "f1e50000000000000000000000000001", 7],
  ["f1e5000000000000000000000000000c", "f1e50000000000000000000000000001", 8],
  ["f1e5000000000000000000000000000d", "f1e50000000000000000000000000001", 9],
  ["f1e5000000000000000000000000000e", "f1e50000000000000000000000000001", 10],
  ["f1e5000000000000000000000000000f", "f1e50000000000000000000000000003", 0],
] as const satisfies readonly (readonly [string, string | null, number])[];

export type ChannelPlanPage = NotionExecutionPage;

export type ChannelPilotPlan = NotionExecutionPlan<
  ChannelPlanPage,
  ChannelSnapshotCounts
>;

/** A pilot is authorized only by two independently received identical snapshots. */
export function freezeChannelSnapshot(
  received: NotionSnapshot,
  fresh: NotionSnapshot,
): NotionSnapshot {
  assertSnapshotsMatch(received, fresh);
  return received;
}

/** Signed URLs rotate independently of source identity. Validate both exact
 * inventories, then download only through the fresh snapshot URLs. */
export function selectFreshChannelAssetSnapshot(
  received: NotionSnapshot,
  fresh: NotionSnapshot,
): NotionSnapshot {
  validateChannelPilotSnapshot(received);
  validateChannelPilotSnapshot(fresh);
  assertSnapshotsMatch(received, fresh);
  return fresh;
}

/** Manifest producer used by snapshot capture and tests. Counts are derived
 * from records rather than copied from a caller-supplied manifest. */
export function produceChannelManifest(
  rootNotionId: string,
  pages: readonly SnapshotPageRecord[],
): SnapshotManifestRecord {
  if (rootNotionId !== CHANNEL_ROOT_NOTION_ID) {
    throw new Error("Channel manifest root is not the reviewed root");
  }
  return {
    type: "manifest",
    version: 1,
    pilot: "channel",
    rootNotionId,
    counts: deriveChannelInventory(pages),
  };
}

export function buildChannelPilotPlan(
  snapshot: NotionSnapshot,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
): ChannelPilotPlan {
  validateChannelPilotSnapshot(snapshot);
  const sourceById = new Map(snapshot.pages.map((page) => [page.notionId, page]));
  if (sourceById.size !== CHANNEL_PILOT_COUNTS.pages) {
    throw new Error("Channel pilot must contain exactly 16 unique pages");
  }
  const root = sourceById.get(snapshot.manifest.rootNotionId);
  if (!root || root.parentNotionId !== null || root.title !== "Channel") {
    throw new Error("Channel pilot root must be the top-level page Channel");
  }

  const children = childMap(snapshot.pages);
  assertContiguousSiblingPositions(children);
  const rootChildren = children.get(root.notionId) ?? [];
  if (rootChildren.length !== 3) {
    throw new Error("Channel pilot root must have exactly three children");
  }
  const sections = exactlyOneByTitle(rootChildren, "Sections");
  const plates = exactlyOneByTitle(rootChildren, "Plates");
  const sectionChildren = children.get(sections.notionId) ?? [];
  if (sectionChildren.length !== 11) {
    throw new Error("Channel pilot Sections page must have exactly 11 children");
  }
  const plateChildren = children.get(plates.notionId) ?? [];
  if (
    plateChildren.length !== 1 ||
    plateChildren[0].title !== "Colophon" ||
    (children.get(plateChildren[0].notionId)?.length ?? 0) !== 0
  ) {
    throw new Error("Channel pilot Plates page must contain only Colophon");
  }
  const reachable = new Set<string>();
  visit(root.notionId, children, reachable);
  if (reachable.size !== snapshot.pages.length) {
    throw new Error("Channel pilot hierarchy is disconnected or cyclic");
  }

  const allAssets = snapshot.pages.flatMap((page) =>
    page.assets.map((asset) => ({ page, asset })),
  );
  if (
    allAssets.length !== 3 ||
    allAssets.some(
      ({ page, asset }) =>
        page.notionId !== plates.notionId || asset.kind !== "image",
    )
  ) {
    throw new Error("Channel pilot requires three standalone PNG images on Plates");
  }
  const expectedAssetIds = new Set(
    allAssets.map(({ asset }) => stableNotionAssetId(asset.url)),
  );
  if (
    resolvedAssets.size !== expectedAssetIds.size ||
    [...expectedAssetIds].some((sourceId) => !resolvedAssets.has(sourceId))
  ) {
    throw new Error("Channel pilot resolved asset set does not match the snapshot");
  }

  const stats: EnhancedMarkdownStats = {
    emptyBlocks: 0,
    hardBreaks: 0,
    externalLinks: 0,
    pageRefs: 0,
    assets: 0,
  };
  const materialized = new Map<
    string,
    Omit<ChannelPlanPage, "beforeNotionId">
  >();
  for (const source of snapshot.pages) {
    if (!isBrainCompatibleNotionIcon(source.icon)) {
      throw new Error("Channel pilot contains an incompatible page icon");
    }
    const enhanced = buildNotionDocumentFromEnhancedMarkdown(
      source,
      resolvedAssets,
    );
    assertEnhancedMarkdownReady(enhanced);
    for (const key of Object.keys(stats) as Array<keyof EnhancedMarkdownStats>) {
      stats[key] += enhanced.stats[key];
    }
    for (const block of enhanced.document.blocks) {
      if (block.type !== "rich_markdown") continue;
      for (const segment of block.segments) {
        if (segment.type === "page_ref" && !sourceById.has(segment.notionId)) {
          throw new Error("Channel pilot has a page reference outside the frozen set");
        }
      }
    }
    materialized.set(source.notionId, {
      notionId: source.notionId,
      parentNotionId: source.parentNotionId,
      position: source.position,
      title: source.title,
      document: enhanced.document,
      sourceHash: sourceHashForNotionDocument(enhanced.document),
      assetSourceIds: source.assets.map((asset) => stableNotionAssetId(asset.url)),
    });
  }
  if (
    stats.emptyBlocks !== CHANNEL_PILOT_COUNTS.emptyBlocks ||
    stats.hardBreaks !== CHANNEL_PILOT_COUNTS.hardBreaks ||
    stats.externalLinks !== CHANNEL_PILOT_COUNTS.externalLinks ||
    stats.assets !== CHANNEL_PILOT_COUNTS.assets
  ) {
    throw new Error("Channel pilot enhanced Markdown inventory does not match manifest");
  }

  const pages: ChannelPlanPage[] = [];
  const addInMutationOrder = (notionId: string) => {
    const source = materialized.get(notionId);
    if (!source) throw new Error("Channel pilot plan is missing a page");
    const siblings = source.parentNotionId
      ? children.get(source.parentNotionId) ?? []
      : [root];
    const index = siblings.findIndex((candidate) => candidate.notionId === notionId);
    const beforeNotionId = siblings[index + 1]?.notionId ?? null;
    pages.push({ ...source, beforeNotionId });
    const descendants = children.get(notionId) ?? [];
    for (const child of [...descendants].reverse()) {
      addInMutationOrder(child.notionId);
    }
  };
  addInMutationOrder(root.notionId);
  const pageByNotionId = new Map(pages.map((page) => [page.notionId, page]));
  return {
    fingerprint: snapshot.fingerprint,
    rootNotionId: root.notionId,
    pages,
    pageByNotionId,
    counts: { ...CHANNEL_PILOT_COUNTS },
  };
}

/** Pure, no-network producer/inventory gate. The CLI calls this before it
 * resolves a single signed asset URL. */
export function validateChannelPilotSnapshot(snapshot: NotionSnapshot): void {
  if (snapshot.manifest.rootNotionId !== CHANNEL_ROOT_NOTION_ID) {
    throw new Error("Channel pilot root Notion id is not the reviewed root");
  }
  if (snapshot.pages.length !== CHANNEL_PILOT_TOPOLOGY.length) {
    throw new Error("Channel pilot must contain exactly 16 reviewed pages");
  }
  const actual = new Map(
    snapshot.pages.map((page) => [
      page.notionId,
      [page.parentNotionId, page.position] as const,
    ]),
  );
  if (actual.size !== CHANNEL_PILOT_TOPOLOGY.length) {
    throw new Error("Channel pilot must contain unique reviewed Notion ids");
  }
  for (const [notionId, parentNotionId, position] of CHANNEL_PILOT_TOPOLOGY) {
    const placement = actual.get(notionId);
    if (!placement || placement[0] !== parentNotionId || placement[1] !== position) {
      throw new Error("Channel pilot Notion id inventory or topology is not reviewed");
    }
  }
  const derived = deriveChannelInventory(snapshot.pages);
  assertExactCounts(snapshot.manifest.counts);
  assertExactCounts(derived);
  for (const key of Object.keys(CHANNEL_PILOT_COUNTS) as Array<keyof ChannelSnapshotCounts>) {
    if (snapshot.manifest.counts[key] !== derived[key]) {
      throw new Error("Channel pilot manifest does not match derived inventory: " + key);
    }
  }
}

export function deriveChannelInventory(
  pages: readonly SnapshotPageRecord[],
): ChannelSnapshotCounts {
  const combined = pages.map((page) => page.enhancedMarkdown).join("\n");
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
  const count = (pattern: RegExp) => [...combined.matchAll(pattern)].length;
  const tableHeaders = count(/^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}.*\|/gm);
  return {
    pages: pages.length,
    assets: pages.reduce((sum, page) => sum + page.assets.length, 0),
    emptyBlocks: count(/(?:<empty-block\s*\/>|<!--\s*notion-empty-block\s*-->)/gi),
    hardBreaks: count(/<br\s*\/?\s*>/gi),
    externalLinks,
    databases: count(/<(?:database|data-source)\b/gi),
    tables: tableHeaders + count(/<table\b/gi),
    columns: count(/<(?:column-list|columns)\b/gi),
    callouts: count(/<callout\b/gi),
    toggles: count(/<(?:toggle|details)\b/gi),
  };
}

function assertExactCounts(actual: ChannelSnapshotCounts): void {
  for (const key of Object.keys(CHANNEL_PILOT_COUNTS) as Array<keyof ChannelSnapshotCounts>) {
    if (actual[key] !== CHANNEL_PILOT_COUNTS[key]) {
      throw new Error("Channel pilot count mismatch: " + key);
    }
  }
}

function childMap(
  pages: SnapshotPageRecord[],
): Map<string, SnapshotPageRecord[]> {
  const children = new Map<string, SnapshotPageRecord[]>();
  for (const page of pages) {
    if (!page.parentNotionId) continue;
    const siblings = children.get(page.parentNotionId) ?? [];
    siblings.push(page);
    children.set(page.parentNotionId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.position - right.position);
  }
  return children;
}

function assertContiguousSiblingPositions(
  children: ReadonlyMap<string, SnapshotPageRecord[]>,
): void {
  for (const siblings of children.values()) {
    for (const [index, page] of siblings.entries()) {
      if (page.position !== index) {
        throw new Error("Channel pilot sibling positions must be unique and contiguous");
      }
    }
  }
}

function exactlyOneByTitle(
  pages: SnapshotPageRecord[],
  title: string,
): SnapshotPageRecord {
  const matches = pages.filter((page) => page.title === title);
  if (matches.length !== 1) {
    throw new Error("Channel pilot must contain exactly one " + title + " root child");
  }
  return matches[0];
}

function visit(
  notionId: string,
  children: ReadonlyMap<string, SnapshotPageRecord[]>,
  seen: Set<string>,
): void {
  if (seen.has(notionId)) throw new Error("Channel pilot hierarchy contains a cycle");
  seen.add(notionId);
  for (const child of children.get(notionId) ?? []) {
    visit(child.notionId, children, seen);
  }
}
