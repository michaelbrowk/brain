import { createHash } from "node:crypto";
import {
  assertEnhancedMarkdownReady,
  buildNotionDocumentFromEnhancedMarkdown,
  type EnhancedMarkdownResult,
  type EnhancedMarkdownStats,
} from "./enhanced-markdown.ts";
import type { NotionImportBlock } from "./converter.ts";
import { sourceHashForNotionDocument } from "./converter.ts";
import type {
  NotionExecutionCounts,
  NotionExecutionPage,
  NotionExecutionPlan,
} from "./execution-plan.ts";
import type { PreparedNotionExecution } from "./executor.ts";
import type {
  NotionAdoptBinding,
  NotionBinding,
  NotionBindings,
  NotionPreserveBinding,
} from "./bindings.ts";
import type { ResolvedNotionAsset } from "./notion-assets.ts";
import { stableNotionAssetId } from "./notion-assets.ts";
import { isBrainCompatibleNotionIcon } from "./protocol.ts";
import type { SnapshotPageRecord } from "./snapshot.ts";
import type {
  NotionSnapshotV2,
  NotionSnapshotV2Node,
} from "./snapshot-v2.ts";

export type GenericMutationDisposition = "create" | "adopt";

export interface GenericNotionPlanPage extends NotionExecutionPage {
  disposition: GenericMutationDisposition;
  brainPageId?: string;
}

export interface GenericNotionPlanCounts extends NotionExecutionCounts {
  sourceNodes: number;
  create: number;
  adopt: number;
  preserve: number;
  skip: number;
}

export interface GenericNotionImportPlan
  extends NotionExecutionPlan<GenericNotionPlanPage, GenericNotionPlanCounts> {
  version: 2;
  snapshotFingerprint: string;
  bindingsFingerprint: string;
  sourceBoundaryFingerprint?: string;
  fixedPageIds: ReadonlyMap<string, string>;
  preservedBindings: readonly NotionPreserveBinding[];
  adoptionBindings: readonly NotionAdoptBinding[];
  skippedNotionIds: ReadonlySet<string>;
}

export type NotionV2NodeMaterializer = (
  node: NotionSnapshotV2Node,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
) => EnhancedMarkdownResult;

export interface BuildGenericNotionPlanOptions {
  materializeNode?: NotionV2NodeMaterializer;
  sourceBoundaryFingerprint?: string;
}

/** Notion permits database rows with an empty title. Brain still needs a
 * visible page title, while the typed collectionRow retains the exact empty
 * source value. */
export function brainTitleForNotionSnapshotNode(
  node: NotionSnapshotV2Node,
): string {
  return node.kind === "row" && !node.title ? "Untitled" : node.title;
}

/**
 * The existing remote executor can be reused today only for an all-create v2
 * plan. Anchored preserve/adopt plans require a separate read-before-write
 * baseline phase and are rejected here instead of being treated as creates.
 */
export function prepareGenericCreateOnlyExecution(
  plan: GenericNotionImportPlan,
  assets: ReadonlyMap<string, ResolvedNotionAsset>,
): PreparedNotionExecution {
  if (
    plan.fixedPageIds.size > 0 ||
    plan.preservedBindings.length > 0 ||
    plan.adoptionBindings.length > 0 ||
    plan.pages.some((page) => page.disposition !== "create")
  ) {
    throw new Error(
      "generic Notion preserve/adopt execution requires the baseline preflight phase",
    );
  }
  return prepareGenericNotionExecution(plan, assets, true);
}

/** Prepare create, preserve, and adopt plans for the metadata-first generic
 * executor. This performs no destination reads and no mutations. */
export function prepareGenericNotionExecution(
  plan: GenericNotionImportPlan,
  assets: ReadonlyMap<string, ResolvedNotionAsset>,
  requireActiveRoot = false,
): PreparedNotionExecution {
  const available = new Set([
    ...plan.pageByNotionId.keys(),
    ...plan.fixedPageIds.keys(),
  ]);
  if (!plan.pageByNotionId.has(plan.rootNotionId) || plan.pages.length < 1) {
    if (requireActiveRoot || !plan.fixedPageIds.has(plan.rootNotionId)) {
      throw new Error("generic Notion execution requires a mapped root");
    }
  }
  for (const page of plan.pages) {
    for (const dependency of [page.parentNotionId, page.beforeNotionId]) {
      if (dependency && !available.has(dependency)) {
        throw new Error("generic Notion execution has an unavailable placement");
      }
    }
    for (const sourceId of page.assetSourceIds) {
      if (!assets.has(sourceId)) {
        throw new Error("generic Notion execution is missing an asset");
      }
    }
  }
  const expectedAssets = new Set(plan.pages.flatMap((page) => page.assetSourceIds));
  if (
    assets.size !== expectedAssets.size ||
    [...assets.keys()].some((sourceId) => !expectedAssets.has(sourceId))
  ) {
    throw new Error("generic Notion execution has an unexpected asset");
  }
  return { plan, assets };
}

/**
 * Build an immutable generic plan without network or filesystem access. The
 * result is structurally compatible with the existing two-pass executor, but
 * preserve/adopt baselines remain explicit parameters. A live generic runner
 * must preflight those baselines before reusing the mutating executor.
 */
export function buildGenericNotionImportPlan(
  snapshot: NotionSnapshotV2,
  bindings: NotionBindings,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
  options: BuildGenericNotionPlanOptions = {},
): GenericNotionImportPlan {
  if (
    options.sourceBoundaryFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/.test(options.sourceBoundaryFingerprint)
  ) {
    throw new Error("invalid generic Notion source-boundary fingerprint");
  }
  if (bindings.snapshotFingerprint !== snapshot.fingerprint) {
    throw new Error("Notion bindings do not match the frozen snapshot v2");
  }
  if (snapshot.manifest.rootNotionIds.length !== 1) {
    throw new Error("generic Notion execution currently requires one reviewed root");
  }
  const nodeById = new Map(snapshot.nodes.map((node) => [node.notionId, node]));
  if (
    bindings.entries.length !== snapshot.nodes.length ||
    bindings.entries.some((entry) => !nodeById.has(entry.notionId)) ||
    snapshot.nodes.some((node) => !bindings.entryByNotionId.has(node.notionId))
  ) {
    throw new Error("Notion bindings must cover every snapshot v2 node exactly once");
  }
  assertSkippedSubtrees(snapshot.nodes, bindings.entryByNotionId);

  const activeNodes = snapshot.nodes.filter((node) => {
    const disposition = requiredBinding(bindings, node.notionId).disposition;
    return disposition === "create" || disposition === "adopt";
  });
  const expectedAssets = new Set(
    activeNodes.flatMap((node) =>
      node.assets.map((asset) => stableNotionAssetId(asset.url)),
    ),
  );
  const expectedAssetReferences = activeNodes.reduce(
    (sum, node) => sum + node.assets.length,
    0,
  );
  if (
    resolvedAssets.size !== expectedAssets.size ||
    [...expectedAssets].some((sourceId) => !resolvedAssets.has(sourceId)) ||
    [...resolvedAssets.keys()].some((sourceId) => !expectedAssets.has(sourceId))
  ) {
    throw new Error("generic Notion resolved assets do not match active snapshot nodes");
  }

  const materializeNode = options.materializeNode ?? materializePlainPage;
  const materialized = new Map<
    string,
    Omit<GenericNotionPlanPage, "beforeNotionId">
  >();
  const stats: EnhancedMarkdownStats = {
    emptyBlocks: 0,
    hardBreaks: 0,
    externalLinks: 0,
    pageRefs: 0,
    assets: 0,
  };
  for (const node of activeNodes) {
    if (!isBrainCompatibleNotionIcon(node.icon)) {
      throw new Error("generic Notion plan contains an incompatible page icon");
    }
    const enhanced = materializeNode(node, resolvedAssets);
    if (enhanced.document.notionId !== node.notionId) {
      throw new Error("generic Notion materializer returned a different source id");
    }
    const brainTitle = brainTitleForNotionSnapshotNode(node);
    if (enhanced.document.title !== brainTitle) {
      throw new Error("generic Notion materializer returned an unexpected Brain title");
    }
    assertEnhancedMarkdownReady(enhanced);
    for (const key of Object.keys(stats) as Array<keyof EnhancedMarkdownStats>) {
      stats[key] += enhanced.stats[key];
    }
    for (const pageRef of pageReferences(enhanced.document.blocks)) {
      const target = nodeById.get(pageRef);
      if (!target) {
        throw new Error("generic Notion plan has a page reference outside the frozen set");
      }
      if (requiredBinding(bindings, target.notionId).disposition === "skip") {
        throw new Error("generic Notion plan has a page reference to a skipped node");
      }
    }
    const binding = requiredBinding(bindings, node.notionId);
    if (binding.disposition !== "create" && binding.disposition !== "adopt") {
      throw new Error("generic Notion active node has a non-mutating disposition");
    }
    const assetSourceIds = node.assets.map((asset) => stableNotionAssetId(asset.url));
    materialized.set(node.notionId, {
      notionId: node.notionId,
      parentNotionId: node.parentNotionId,
      position: node.position,
      title: brainTitle,
      disposition: binding.disposition,
      ...(binding.disposition === "adopt" ? { brainPageId: binding.brainPageId } : {}),
      document: enhanced.document,
      collection: node.kind === "collection" ? node.collection : null,
      collectionRow: node.kind === "row" ? node.collectionRow : null,
      sourceHash: sourceHashForNotionDocument(enhanced.document),
      assetSourceIds,
    });
  }
  const materializedAssetReferences = [...materialized.values()].reduce(
    (sum, page) => sum + page.assetSourceIds.length,
    0,
  );
  if (materializedAssetReferences !== expectedAssetReferences) {
    throw new Error("generic Notion active asset inventory did not fully materialize");
  }

  const children = childMap(snapshot.nodes);
  const pages: GenericNotionPlanPage[] = [];
  const addInMutationOrder = (notionId: string): void => {
    const binding = requiredBinding(bindings, notionId);
    if (binding.disposition === "skip") return;
    const source = materialized.get(notionId);
    if (source) {
      const siblings = source.parentNotionId
        ? children.get(source.parentNotionId) ?? []
        : snapshot.manifest.rootNotionIds.map((root) => requiredNode(nodeById, root));
      const keptSiblings = siblings.filter(
        (sibling) => requiredBinding(bindings, sibling.notionId).disposition !== "skip",
      );
      const index = keptSiblings.findIndex((candidate) => candidate.notionId === notionId);
      if (index < 0) throw new Error("generic Notion plan lost an active sibling");
      pages.push({
        ...source,
        beforeNotionId: keptSiblings[index + 1]?.notionId ?? null,
      });
    }
    for (const child of [...(children.get(notionId) ?? [])].reverse()) {
      addInMutationOrder(child.notionId);
    }
  };
  addInMutationOrder(snapshot.manifest.rootNotionIds[0]);
  if (pages.length !== activeNodes.length) {
    throw new Error("generic Notion plan did not order every active node");
  }

  const fixedPageIds = new Map<string, string>();
  const preservedBindings: NotionPreserveBinding[] = [];
  const adoptionBindings: NotionAdoptBinding[] = [];
  const skippedNotionIds = new Set<string>();
  for (const binding of bindings.entries) {
    if (binding.disposition === "preserve") {
      fixedPageIds.set(binding.notionId, binding.brainPageId);
      preservedBindings.push(binding);
    } else if (binding.disposition === "adopt") {
      fixedPageIds.set(binding.notionId, binding.brainPageId);
      adoptionBindings.push(binding);
    } else if (binding.disposition === "skip") {
      skippedNotionIds.add(binding.notionId);
    }
  }
  assertPlacementDependencies(pages, bindings.entryByNotionId);

  const counts: GenericNotionPlanCounts = {
    pages: pages.length,
    assets: expectedAssetReferences,
    emptyBlocks: stats.emptyBlocks,
    hardBreaks: stats.hardBreaks,
    externalLinks: stats.externalLinks,
    sourceNodes: snapshot.nodes.length,
    create: pages.filter((page) => page.disposition === "create").length,
    adopt: adoptionBindings.length,
    preserve: preservedBindings.length,
    skip: skippedNotionIds.size,
  };
  const pageByNotionId = new Map(pages.map((page) => [page.notionId, page]));
  const fingerprint = genericPlanFingerprint({
    snapshotFingerprint: snapshot.fingerprint,
    bindingsFingerprint: bindings.fingerprint,
    sourceBoundaryFingerprint: options.sourceBoundaryFingerprint,
    rootNotionId: snapshot.manifest.rootNotionIds[0],
    pages,
    fixedPageIds,
    preservedBindings,
    adoptionBindings,
    skippedNotionIds,
    counts,
    resolvedAssets,
  });
  return {
    version: 2,
    fingerprint,
    snapshotFingerprint: snapshot.fingerprint,
    bindingsFingerprint: bindings.fingerprint,
    ...(options.sourceBoundaryFingerprint
      ? { sourceBoundaryFingerprint: options.sourceBoundaryFingerprint }
      : {}),
    rootNotionId: snapshot.manifest.rootNotionIds[0],
    pages,
    pageByNotionId,
    counts,
    fixedPageIds,
    preservedBindings,
    adoptionBindings,
    skippedNotionIds,
  };
}

function materializePlainPage(
  node: NotionSnapshotV2Node,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
): EnhancedMarkdownResult {
  if (node.kind !== "page") {
    throw new Error(
      "generic Notion collection and row mutations require an explicit typed materializer",
    );
  }
  const page: SnapshotPageRecord = {
    type: "page",
    notionId: node.notionId,
    parentNotionId: node.parentNotionId,
    position: node.position,
    title: node.title,
    icon: node.icon,
    enhancedMarkdown: node.enhancedMarkdown,
    assets: node.assets,
  };
  return buildNotionDocumentFromEnhancedMarkdown(page, resolvedAssets);
}

function genericPlanFingerprint(input: {
  snapshotFingerprint: string;
  bindingsFingerprint: string;
  sourceBoundaryFingerprint?: string;
  rootNotionId: string;
  pages: GenericNotionPlanPage[];
  fixedPageIds: ReadonlyMap<string, string>;
  preservedBindings: readonly NotionPreserveBinding[];
  adoptionBindings: readonly NotionAdoptBinding[];
  skippedNotionIds: ReadonlySet<string>;
  counts: GenericNotionPlanCounts;
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>;
}): string {
  return createHash("sha256")
    .update(
      stableJson({
        version: 2,
        snapshotFingerprint: input.snapshotFingerprint,
        bindingsFingerprint: input.bindingsFingerprint,
        sourceBoundaryFingerprint: input.sourceBoundaryFingerprint,
        rootNotionId: input.rootNotionId,
        counts: input.counts,
        pages: input.pages.map((page) => ({
          notionId: page.notionId,
          parentNotionId: page.parentNotionId,
          beforeNotionId: page.beforeNotionId,
          position: page.position,
          disposition: page.disposition,
          brainPageId: page.brainPageId ?? null,
          sourceHash: page.sourceHash,
          collection: page.collection ?? null,
          collectionRow: page.collectionRow ?? null,
          assetSourceIds: page.assetSourceIds,
        })),
        fixedPageIds: [...input.fixedPageIds].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
        preservedBindings: [...input.preservedBindings].sort((left, right) =>
          left.notionId.localeCompare(right.notionId),
        ),
        adoptionBindings: [...input.adoptionBindings].sort((left, right) =>
          left.notionId.localeCompare(right.notionId),
        ),
        skippedNotionIds: [...input.skippedNotionIds].sort(),
        assets: [...input.resolvedAssets]
          .map(([sourceId, asset]) => ({
            sourceId,
            name: asset.name,
            mimeType: asset.mimeType,
            sha256: asset.sha256,
            size: asset.bytes.byteLength,
          }))
          .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
      }),
    )
    .digest("hex");
}

function assertSkippedSubtrees(
  nodes: readonly NotionSnapshotV2Node[],
  bindings: ReadonlyMap<string, NotionBinding>,
): void {
  for (const node of nodes) {
    if (!node.parentNotionId) continue;
    const parent = bindings.get(node.parentNotionId);
    const binding = bindings.get(node.notionId);
    if (!parent || !binding) throw new Error("Notion bindings are incomplete");
    if (parent.disposition === "skip" && binding.disposition !== "skip") {
      throw new Error("Notion skip disposition must cover the complete subtree");
    }
  }
}

function assertPlacementDependencies(
  pages: readonly GenericNotionPlanPage[],
  bindings: ReadonlyMap<string, NotionBinding>,
): void {
  for (const page of pages) {
    for (const dependency of [page.parentNotionId, page.beforeNotionId]) {
      if (!dependency) continue;
      const binding = bindings.get(dependency);
      if (!binding || binding.disposition === "skip") {
        throw new Error("generic Notion placement depends on an unavailable node");
      }
    }
  }
}

function childMap(
  nodes: readonly NotionSnapshotV2Node[],
): Map<string, NotionSnapshotV2Node[]> {
  const children = new Map<string, NotionSnapshotV2Node[]>();
  for (const node of nodes) {
    if (!node.parentNotionId) continue;
    const siblings = children.get(node.parentNotionId) ?? [];
    siblings.push(node);
    children.set(node.parentNotionId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.position - right.position);
  }
  return children;
}

function pageReferences(blocks: readonly NotionImportBlock[]): Set<string> {
  const result = new Set<string>();
  const visit = (block: NotionImportBlock): void => {
    if (block.type === "page_ref") result.add(block.notionId);
    if (block.type === "rich_markdown") {
      for (const segment of block.segments) {
        if (segment.type === "page_ref") result.add(segment.notionId);
      }
    } else if (block.type === "columns") {
      for (const column of block.columns) for (const child of column) visit(child);
    } else if (block.type === "callout" || block.type === "toggle") {
      for (const child of block.children) visit(child);
    }
  };
  for (const block of blocks) visit(block);
  return result;
}

function requiredBinding(bindings: NotionBindings, notionId: string): NotionBinding {
  const binding = bindings.entryByNotionId.get(notionId);
  if (!binding) throw new Error("Notion binding is missing");
  return binding;
}

function requiredNode(
  nodes: ReadonlyMap<string, NotionSnapshotV2Node>,
  notionId: string,
): NotionSnapshotV2Node {
  const node = nodes.get(notionId);
  if (!node) throw new Error("Notion snapshot v2 node is missing");
  return node;
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
