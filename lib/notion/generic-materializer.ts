import {
  buildNotionDocumentFromEnhancedMarkdown,
  type EnhancedMarkdownResult,
} from "./enhanced-markdown.ts";
import { brainTitleForNotionSnapshotNode } from "./generic-plan.ts";
import type { NotionImportBlock, NotionImportDocument } from "./converter.ts";
import type { ResolvedNotionAsset } from "./notion-assets.ts";
import type { SnapshotPageRecord } from "./snapshot.ts";
import { normalizeNotionId } from "./snapshot.ts";
import type { NotionSnapshotV2Node } from "./snapshot-v2.ts";

/**
 * Materialize every v2 node through the same Enhanced Markdown parser. Typed
 * collection definitions and row values remain on the execution page; this
 * function owns only the visible Brain document and its attachment blocks.
 */
export function materializeGenericNotionSnapshotNode(
  node: NotionSnapshotV2Node,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
): EnhancedMarkdownResult {
  const page: SnapshotPageRecord = {
    type: "page",
    notionId: node.notionId,
    parentNotionId: node.parentNotionId,
    position: node.position,
    title: brainTitleForNotionSnapshotNode(node),
    icon: node.icon,
    enhancedMarkdown: node.enhancedMarkdown,
    assets: node.assets,
  };
  return buildNotionDocumentFromEnhancedMarkdown(page, resolvedAssets);
}

/** Derive the exact normalized page-reference set using the same parser as the
 * operator materializer. Missing assets can add issues, but never change page
 * reference parsing, so the source-only report needs no file bytes. */
export function notionPageReferenceIdsForSnapshotNodes(
  nodes: readonly NotionSnapshotV2Node[],
): readonly string[] {
  const references = new Set<string>();
  for (const node of nodes) {
    const materialized = materializeGenericNotionSnapshotNode(node, new Map());
    for (const notionId of notionPageReferenceIds(materialized.document)) {
      references.add(notionId);
    }
  }
  return [...references].sort();
}

/** Operator-only downgrade for explicitly reviewed references outside the
 * frozen import set. Declared references remain clickable canonical Notion
 * links; every other page_ref stays typed for the generic plan's fail-closed
 * coverage check. */
export function materializeGenericNotionSnapshotNodeWithExternalReferences(
  node: NotionSnapshotV2Node,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
  externalNotionReferenceIds: ReadonlySet<string>,
): EnhancedMarkdownResult {
  return convertDeclaredExternalNotionReferences(
    materializeGenericNotionSnapshotNode(node, resolvedAssets),
    externalNotionReferenceIds,
  );
}

export function convertDeclaredExternalNotionReferences(
  result: EnhancedMarkdownResult,
  externalNotionReferenceIds: ReadonlySet<string>,
): EnhancedMarkdownResult {
  let converted = 0;
  const blocks = result.document.blocks.map((block) => {
    const transformed = convertExternalBlock(block, externalNotionReferenceIds);
    converted += transformed.converted;
    return transformed.block;
  });
  if (converted > result.stats.pageRefs) {
    throw new Error("external Notion reference stats are inconsistent");
  }
  return {
    ...result,
    document: { ...result.document, blocks },
    stats: {
      ...result.stats,
      pageRefs: result.stats.pageRefs - converted,
      externalLinks: result.stats.externalLinks + converted,
    },
  };
}

export function notionPageReferenceIds(
  document: NotionImportDocument,
): readonly string[] {
  const references = new Set<string>();
  const visit = (block: NotionImportBlock): void => {
    if (block.type === "page_ref") references.add(normalizeNotionId(block.notionId));
    if (block.type === "rich_markdown") {
      for (const segment of block.segments) {
        if (segment.type === "page_ref") {
          references.add(normalizeNotionId(segment.notionId));
        }
      }
    } else if (block.type === "columns") {
      for (const column of block.columns) for (const child of column) visit(child);
    } else if (block.type === "callout" || block.type === "toggle") {
      for (const child of block.children) visit(child);
    }
  };
  for (const block of document.blocks) visit(block);
  return [...references].sort();
}

function convertExternalBlock(
  block: NotionImportBlock,
  externalNotionReferenceIds: ReadonlySet<string>,
): { block: NotionImportBlock; converted: number } {
  if (block.type === "rich_markdown") {
    let converted = 0;
    const segments = block.segments.map((segment) => {
      if (
        segment.type !== "page_ref" ||
        !externalNotionReferenceIds.has(normalizeNotionId(segment.notionId))
      ) {
        return segment;
      }
      converted += 1;
      return {
        type: "text" as const,
        text: canonicalExternalNotionLink(segment.notionId, segment.title),
      };
    });
    return { block: { ...block, segments }, converted };
  }
  if (
    block.type === "page_ref" &&
    externalNotionReferenceIds.has(normalizeNotionId(block.notionId))
  ) {
    return {
      block: {
        type: "markdown",
        markdown: canonicalExternalNotionLink(
          block.notionId,
          `${block.icon ? `${block.icon} ` : ""}${block.title}`,
        ),
      },
      converted: 1,
    };
  }
  if (block.type === "columns") {
    let converted = 0;
    const columns = block.columns.map((column) =>
      column.map((child) => {
        const transformed = convertExternalBlock(child, externalNotionReferenceIds);
        converted += transformed.converted;
        return transformed.block;
      }),
    );
    return { block: { ...block, columns }, converted };
  }
  if (block.type === "callout" || block.type === "toggle") {
    let converted = 0;
    const children = block.children.map((child) => {
      const transformed = convertExternalBlock(child, externalNotionReferenceIds);
      converted += transformed.converted;
      return transformed.block;
    });
    return { block: { ...block, children }, converted };
  }
  return { block, converted: 0 };
}

function canonicalExternalNotionLink(notionIdInput: string, title: string): string {
  const notionId = normalizeNotionId(notionIdInput);
  const sourceLabel = title.trim() || notionId;
  if (/[\u0000-\u001f\u007f]/.test(sourceLabel)) {
    throw new Error("external Notion reference label contains a control character");
  }
  const label = escapeMarkdownLinkLabel(sourceLabel);
  return `[${label}](https://www.notion.so/${notionId})`;
}

function escapeMarkdownLinkLabel(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}
