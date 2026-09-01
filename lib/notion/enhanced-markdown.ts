import { canonicalPageMarkdown } from "../page-markdown.ts";
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  NotionImportBlock,
  NotionImportDocument,
} from "./converter.ts";
import type { ResolvedNotionAsset } from "./notion-assets.ts";
import { stableNotionAssetId } from "./notion-assets.ts";
import type { SnapshotPageRecord } from "./snapshot.ts";
import { normalizeNotionId } from "./snapshot.ts";
import { maskReviewedEscapedLiteralsForValidation } from "./reviewed-markup.ts";

export interface EnhancedMarkdownIssue {
  type: string;
  detail: string;
}

export interface EnhancedMarkdownStats {
  emptyBlocks: number;
  hardBreaks: number;
  externalLinks: number;
  pageRefs: number;
  assets: number;
}

export interface EnhancedMarkdownResult {
  document: NotionImportDocument;
  issues: EnhancedMarkdownIssue[];
  stats: EnhancedMarkdownStats;
}

export function buildNotionDocumentFromEnhancedMarkdown(
  page: SnapshotPageRecord,
  resolvedAssets: ReadonlyMap<string, ResolvedNotionAsset>,
): EnhancedMarkdownResult {
  const issues: EnhancedMarkdownIssue[] = [];
  const stats: EnhancedMarkdownStats = {
    emptyBlocks: 0,
    hardBreaks: 0,
    externalLinks: 0,
    pageRefs: 0,
    assets: 0,
  };
  const markdown = page.enhancedMarkdown.replace(/\r\n?/g, "\n");

  const blocks: NotionImportBlock[] = [];
  const referencedAssets = new Set<string>();
  const textLines: string[] = [];
  const flushText = () => {
    const text = canonicalPageMarkdown(textLines.join("\n"));
    textLines.length = 0;
    if (!text) return;
    blocks.push({ type: "rich_markdown", segments: parseRichSegments(text, issues, stats) });
  };
  const assetByUrl = new Map(page.assets.map((asset) => [asset.url, asset]));
  const codeRanges = markdownCodeRanges(markdown);
  let lineOffset = 0;
  for (const sourceLine of markdown.split("\n")) {
    const lineEnd = lineOffset + sourceLine.length;
    const protectedOnLine = overlappingRanges(codeRanges, lineOffset, lineEnd);
    const fullyProtected = rangeContainsLine(
      protectedOnLine,
      lineOffset,
      lineEnd,
    );
    if (fullyProtected) {
      textLines.push(sourceLine);
      lineOffset = lineEnd + 1;
      continue;
    }
    if (
      protectedOnLine.length === 0 &&
      /^\s*(?:<empty-block\s*\/>|<!--\s*notion-empty-block\s*-->)\s*$/i.test(
        sourceLine,
      )
    ) {
      stats.emptyBlocks += 1;
      flushText();
      blocks.push({ type: "empty_block" });
      lineOffset = lineEnd + 1;
      continue;
    }
    const directiveOffset = literalEmptyBlockDirectiveOffset(sourceLine);
    const shouldEscapeDirective =
      directiveOffset !== null &&
      !offsetIsProtected(lineOffset + directiveOffset, codeRanges);
    const hasUnsupportedMarkup = unprotectedSegments(
      sourceLine,
      lineOffset,
      protectedOnLine,
    ).some((segment) => {
      const withoutReviewedLiterals = maskReviewedEscapedLiteralsForValidation(
        normalizeNotionId(page.notionId),
        segment,
      );
      const withoutSupportedTags = withoutReviewedLiterals
        .replace(/<br\s*\/?\s*>/gi, "")
        .replace(
          /<mention-page\s+url="[^"]+">[^<]*<\/mention-page>/gi,
          "",
        );
      return /```notion-unsupported|<\/?[A-Za-z][^>]*>/.test(
        withoutSupportedTags,
      );
    });
    if (hasUnsupportedMarkup) {
      issues.push({
        type: "unsupported_enhanced_markdown",
        detail: "unknown enhanced-markdown tag or unsupported marker",
      });
    }
    let line = mapUnprotectedSegments(
      sourceLine,
      lineOffset,
      protectedOnLine,
      (segment) =>
        segment
          .replace(/<br\s*\/?\s*>/gi, () => {
            stats.hardBreaks += 1;
            return "\\\n";
          })
          .replace(
            /<mention-page\s+url="([^"]+)">([^<]*)<\/mention-page>/gi,
            (_match, url: string, label: string) => `[${label}](${url})`,
          ),
    );
    // Enhanced Markdown is source prose, not Brain Markdown. Escape the one
    // public leaf-directive spelling so a literal Notion line remains visible
    // text and cannot be confused with the typed empty_block IR above.
    if (shouldEscapeDirective) line = escapeLiteralEmptyBlockDirective(line);
    const image =
      protectedOnLine.length === 0
        ? /^!\[([^\]]*)\]\((https:[^)]+)\)\s*$/.exec(line.trim())
        : null;
    const file =
      protectedOnLine.length === 0
        ? /^\[([^\]]*)\]\((https:[^)]+)\)\s*$/.exec(line.trim())
        : null;
    const source = image
      ? assetByUrl.get(image[2])
      : file
        ? assetByUrl.get(file[2])
        : undefined;
    if ((!image && !file) || !source) {
      if (image) {
        issues.push({
          type: "image_not_declared",
          detail: "standalone image is missing from the frozen asset inventory",
        });
      }
      textLines.push(line);
      lineOffset = lineEnd + 1;
      continue;
    }
    flushText();
    const sourceId = stableNotionAssetId(source.url);
    const resolved = resolvedAssets.get(sourceId);
    referencedAssets.add(sourceId);
    if (!resolved) {
      issues.push({ type: "asset_not_resolved", detail: sourceId });
      lineOffset = lineEnd + 1;
      continue;
    }
    if (
      (source.kind === "image" && !image) ||
      (source.kind === "file" && !file) ||
      source.kind === "cover"
    ) {
      issues.push({ type: "asset_kind_mismatch", detail: sourceId });
      lineOffset = lineEnd + 1;
      continue;
    }
    stats.assets += 1;
    blocks.push({
      type: "attachment",
      sourceId,
      sha256: resolved.sha256,
      name: resolved.name,
      mimeType: resolved.mimeType,
      kind: source.kind,
      ...(source.kind === "image" && image ? { alt: image[1] } : {}),
    });
    lineOffset = lineEnd + 1;
  }
  flushText();

  let cover: NotionImportDocument["cover"];
  for (const source of page.assets) {
    const sourceId = stableNotionAssetId(source.url);
    if (source.kind === "cover") {
      const resolved = resolvedAssets.get(sourceId);
      referencedAssets.add(sourceId);
      if (!resolved) {
        issues.push({ type: "asset_not_resolved", detail: sourceId });
      } else if (cover) {
        issues.push({ type: "multiple_covers", detail: sourceId });
      } else {
        cover = {
          sourceId,
          sha256: resolved.sha256,
          name: resolved.name,
          mimeType: resolved.mimeType,
        };
      }
    }
  }
  for (const source of page.assets) {
    const sourceId = stableNotionAssetId(source.url);
    if (!referencedAssets.has(sourceId)) {
      issues.push({ type: "asset_not_referenced", detail: sourceId });
    }
  }
  return {
    document: {
      notionId: normalizeNotionId(page.notionId),
      title: page.title,
      icon: page.icon,
      cover,
      blocks,
    },
    issues,
    stats,
  };
}

/** Enhanced Markdown is source prose, so even directive-looking text nested in
 * a quote or list stays text. Typed `<empty-block/>` records are handled above. */
function escapeLiteralEmptyBlockDirective(line: string): string {
  const cursor = literalEmptyBlockDirectiveOffset(line);
  if (cursor === null) return line;
  return `${line.slice(0, cursor)}\\${line.slice(cursor)}`;
}

function literalEmptyBlockDirectiveOffset(line: string): number | null {
  let cursor = 0;
  let hasContainer = false;
  for (;;) {
    const rest = line.slice(cursor);
    const quote = /^[ ]{0,3}>[ \t]?/.exec(rest);
    if (quote) {
      cursor += quote[0].length;
      hasContainer = true;
      continue;
    }
    const list = /^[ ]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(rest);
    if (list) {
      cursor += list[0].length;
      hasContainer = true;
      continue;
    }
    break;
  }
  const leading = /^[ ]{0,3}/.exec(line.slice(cursor))?.[0] ?? "";
  cursor += leading.length;
  if (!/^::empty-block(?:\b|$)/.test(line.slice(cursor))) return null;
  if (!hasContainer && cursor > 3) return null;
  return cursor;
}

interface MarkdownCodeRange {
  start: number;
  end: number;
}

interface PositionedMarkdownNode {
  type?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  children?: PositionedMarkdownNode[];
}

/** Parse CommonMark once and protect exact source offsets for every fenced,
 * indented, and inline code node. Enhanced-Markdown sentinels are meaningful
 * only in prose; code bytes pass through untouched and contribute no stats. */
function markdownCodeRanges(markdown: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  const visit = (node: PositionedMarkdownNode) => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        start >= 0 &&
        end >= start &&
        end <= markdown.length
      ) {
        ranges.push({ start, end });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(markdown) as PositionedMarkdownNode);
  return ranges.sort((left, right) => left.start - right.start || left.end - right.end);
}

function overlappingRanges(
  ranges: readonly MarkdownCodeRange[],
  lineStart: number,
  lineEnd: number,
): MarkdownCodeRange[] {
  return ranges.filter(
    (range) =>
      (lineStart === lineEnd
        ? range.start <= lineStart && range.end >= lineEnd
        : range.start < lineEnd && range.end > lineStart),
  );
}

function rangeContainsLine(
  ranges: readonly MarkdownCodeRange[],
  lineStart: number,
  lineEnd: number,
): boolean {
  return ranges.some(
    (range) => range.start <= lineStart && range.end >= lineEnd,
  );
}

function offsetIsProtected(
  offset: number,
  ranges: readonly MarkdownCodeRange[],
): boolean {
  return ranges.some((range) => range.start <= offset && offset < range.end);
}

function unprotectedSegments(
  line: string,
  lineStart: number,
  protectedRanges: readonly MarkdownCodeRange[],
): string[] {
  const segments: string[] = [];
  let cursor = 0;
  for (const range of protectedRanges) {
    const start = Math.max(0, range.start - lineStart);
    const end = Math.min(line.length, range.end - lineStart);
    if (start > cursor) segments.push(line.slice(cursor, start));
    cursor = Math.max(cursor, end);
  }
  if (cursor < line.length) segments.push(line.slice(cursor));
  return segments;
}

function mapUnprotectedSegments(
  line: string,
  lineStart: number,
  protectedRanges: readonly MarkdownCodeRange[],
  transform: (segment: string) => string,
): string {
  let result = "";
  let cursor = 0;
  for (const range of protectedRanges) {
    const start = Math.max(0, range.start - lineStart);
    const end = Math.min(line.length, range.end - lineStart);
    if (start > cursor) result += transform(line.slice(cursor, start));
    if (end > cursor) result += line.slice(Math.max(cursor, start), end);
    cursor = Math.max(cursor, end);
  }
  if (cursor < line.length) result += transform(line.slice(cursor));
  return result;
}

export function assertEnhancedMarkdownReady(result: EnhancedMarkdownResult): void {
  if (result.issues.length === 0) return;
  const error = new Error(
    `enhanced Markdown has ${result.issues.length} unsupported item(s)`,
  );
  error.name = "EnhancedMarkdownIssuesError";
  throw error;
}

function parseRichSegments(
  markdown: string,
  issues: EnhancedMarkdownIssue[],
  stats: EnhancedMarkdownStats,
): Extract<NotionImportBlock, { type: "rich_markdown" }>["segments"] {
  const segments: Extract<NotionImportBlock, { type: "rich_markdown" }>["segments"] = [];
  const codeRanges = markdownCodeRanges(markdown);
  const pageReferenceRanges: MarkdownCodeRange[] = [];
  const link = /(?<!!)\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/gi;
  let cursor = 0;
  for (const match of markdown.matchAll(link)) {
    const index = match.index ?? 0;
    const end = index + match[0].length;
    if (rangeOverlaps(codeRanges, index, end)) continue;
    if (index > cursor) segments.push({ type: "text", text: markdown.slice(cursor, index) });
    const notionId = notionPageIdFromUrl(match[2]);
    if (notionId) {
      stats.pageRefs += 1;
      segments.push({ type: "page_ref", notionId, title: match[1] });
      pageReferenceRanges.push({ start: index, end });
    } else {
      stats.externalLinks += 1;
      segments.push({ type: "text", text: match[0] });
    }
    cursor = end;
  }
  if (cursor < markdown.length) {
    segments.push({ type: "text", text: markdown.slice(cursor) });
  }
  const proseText = textOutsideRanges(markdown, codeRanges);
  if (/!\[[^\]]*\]\(https:\/\/[^)]+\)/i.test(proseText)) {
    issues.push({
      type: "inline_image_unsupported",
      detail: "pilot images must be standalone frozen asset blocks",
    });
  }
  if (
    /https:\/\/(?:(?:app|www)\.)?notion\.(?:so|com)\/|https:\/\/[a-z0-9-]+\.notion\.site\//i.test(
      textOutsideRanges(proseText, pageReferenceRanges),
    )
  ) {
    issues.push({
      type: "raw_notion_url",
      detail: "Notion page URL was not represented as a Markdown link",
    });
  }
  return segments;
}

function rangeOverlaps(
  ranges: readonly MarkdownCodeRange[],
  start: number,
  end: number,
): boolean {
  return ranges.some((range) => range.start < end && range.end > start);
}

function textOutsideRanges(
  input: string,
  ranges: readonly MarkdownCodeRange[],
): string {
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) result += input.slice(cursor, range.start);
    if (range.end > cursor) {
      result += input
        .slice(Math.max(cursor, range.start), range.end)
        .replace(/[^\n]/g, " ");
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < input.length) result += input.slice(cursor);
  return result;
}

function notionPageIdFromUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    ![
      "notion.so",
      "www.notion.so",
      "notion.com",
      "www.notion.com",
      "app.notion.com",
    ].includes(url.hostname) &&
    !url.hostname.endsWith(".notion.site")
  ) {
    return null;
  }
  const compact = decodeURIComponent(url.pathname).replace(/-/g, "");
  const match = /([a-f0-9]{32})(?:\/|$)/i.exec(compact);
  return match ? normalizeNotionId(match[1]) : null;
}
