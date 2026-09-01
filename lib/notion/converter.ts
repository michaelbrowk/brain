import { createHash } from "node:crypto";
import { notionAttachmentUrl } from "../attachments.ts";
import type {
  CollectionDefinition,
  CollectionRow,
} from "../collections/model.ts";
import {
  canonicalizeNotionImportTarget,
  isNotionRasterRenderableImage,
  notionConversionHash,
} from "./protocol.ts";

export type NotionImportBlock =
  | { type: "markdown"; markdown: string }
  | { type: "empty_block" }
  | {
      type: "rich_markdown";
      segments: Array<
        | { type: "text"; text: string }
        | {
            type: "page_ref";
            notionId: string;
            title: string;
          }
      >;
    }
  | { type: "columns"; columns: NotionImportBlock[][] }
  | { type: "callout"; icon?: string; children: NotionImportBlock[] }
  | { type: "toggle"; summary: string; children: NotionImportBlock[] }
  | {
      type: "page_ref";
      notionId: string;
      title: string;
      icon?: string;
      sourceUrl?: string;
    }
  | {
      type: "attachment";
      sourceId: string;
      sha256: string;
      name: string;
      mimeType: string;
      kind: "image" | "file";
      alt?: string;
    }
  | { type: "unknown"; notionType: string; raw: string };

export interface NotionImportDocument {
  notionId: string;
  title: string;
  icon?: string;
  cover?: {
    sourceId: string;
    sha256: string;
    name: string;
    mimeType: string;
  };
  blocks: NotionImportBlock[];
}

export interface ConvertNotionOptions {
  /** Immutable Brain hierarchy plan committed into the conversion hash. */
  parentId: string | null;
  beforeId: string | null;
  /** Complete after reserve pass one. Keys may be UUIDs with or without dashes. */
  pageIdByNotionId:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
  /** URLs returned by notion_upload_attachment, keyed by stable source block id. */
  attachmentUrlBySourceId?:
    | ReadonlyMap<string, string>
    | Readonly<Record<string, string>>;
}

export interface NotionConversionMetadata {
  collection?: CollectionDefinition | null;
  collectionRow?: CollectionRow | null;
}

interface ConversionContext {
  pageIds: ReadonlyMap<string, string>;
  attachmentUrls: ReadonlyMap<string, string>;
  issues: NotionConversionIssue[];
}

export interface NotionConversionIssue {
  type: string;
  raw: string;
}

export interface NotionConversionResult {
  markdown: string;
  issues: NotionConversionIssue[];
}

/**
 * Convert a connector/export adapter's small intermediate tree into Brain's
 * canonical Markdown. Adapters are deliberately separate: this function has
 * no Notion network access and never writes files.
 */
export function convertNotionDocument(
  document: NotionImportDocument,
  options: ConvertNotionOptions,
): string {
  return convertNotionDocumentWithIssues(document, options).markdown;
}

export function convertNotionDocumentWithIssues(
  document: NotionImportDocument,
  options: ConvertNotionOptions,
): NotionConversionResult {
  const context = conversionContext(options);
  recordCoverIssue(document, context);
  const markdown = canonicalizeNotionImportTarget({
    sourceHash: sourceHashForNotionDocument(document),
    parentId: options.parentId,
    beforeId: options.beforeId,
    title: document.title,
    icon: document.icon,
    markdown: renderBlocks(document.blocks, context),
  }).markdown;
  return { markdown, issues: [...context.issues] };
}

/** Execution must stop until an adapter has represented every source block. */
export function assertNotionConversionReady(
  result: NotionConversionResult,
): void {
  if (result.issues.length === 0) return;
  const error = new Error(
    `notion conversion has ${result.issues.length} unsupported or unresolved block(s)`,
  );
  error.name = "NotionConversionIssuesError";
  throw error;
}

/** Stable source-only sha256. It can be computed before pass-one reservations,
 *  including for cyclic A ↔ B page references. Attachment descriptors include
 *  their precomputed byte hash, never a temporary signed URL. */
export function sourceHashForNotionDocument(
  document: NotionImportDocument,
): string {
  return createHash("sha256")
    .update(stableJson(canonicalizeNotionIds(document)))
    .digest("hex");
}

/** Hash of conversion dependencies available after pass one. A changed page-id
 *  mapping or uploaded content-addressed URL can repair output even when the
 *  source-only hash did not change. */
export function conversionHashForNotionDocument(
  document: NotionImportDocument,
  options: ConvertNotionOptions,
  metadata: NotionConversionMetadata = {},
): string {
  const context = conversionContext(options);
  recordCoverIssue(document, context);
  const markdown = renderBlocks(document.blocks, context);
  let cover: string | undefined;
  if (document.cover) {
    const planned = notionAttachmentUrl(
      document.cover.sha256,
      document.cover.name,
      document.cover.mimeType,
    );
    const resolved = context.attachmentUrls.get(document.cover.sourceId);
    if (resolved !== undefined && resolved !== planned) {
      throw new Error(
        `cover attachment URL does not match its content hash: ${document.cover.sourceId}`,
      );
    }
    cover = resolved ?? planned;
  }
  return notionConversionHash(canonicalizeNotionImportTarget({
    sourceHash: sourceHashForNotionDocument(document),
    parentId: options.parentId,
    beforeId: options.beforeId,
    title: document.title,
    icon: document.icon,
    cover,
    markdown,
    ...(metadata.collection
      ? { collection: metadata.collection }
      : {}),
    ...(metadata.collectionRow
      ? { collectionRow: metadata.collectionRow }
      : {}),
  }));
}

function renderBlocks(
  blocks: NotionImportBlock[],
  context: ConversionContext,
): string {
  return blocks
    .map((block) => renderBlock(block, context))
    .filter(Boolean)
    .join("\n\n");
}

function renderBlock(
  block: NotionImportBlock,
  context: ConversionContext,
): string {
  switch (block.type) {
    case "markdown":
      return block.markdown.trim().length > 0
        ? block.markdown
        : renderUnsupported(context, "empty_block", "");
    case "empty_block":
      return "::empty-block";
    case "rich_markdown": {
      let rendered = "";
      for (const segment of block.segments) {
        if (segment.type === "text") {
          rendered += segment.text;
          continue;
        }
        const notionId = normalizeNotionId(segment.notionId);
        const pageId = context.pageIds.get(notionId);
        const label = escapeLinkLabel(segment.title.trim() || notionId);
        if (pageId && /^[A-Za-z0-9_-]+$/.test(pageId)) {
          rendered += `[${label}](/p/${pageId})`;
        } else {
          rendered += `\n\n${renderUnsupported(context, "unresolved_page_ref", notionId)}\n\n`;
        }
      }
      return rendered;
    }
    case "columns": {
      if (block.columns.length === 0) {
        return renderUnsupported(context, "empty_columns", "");
      }
      const columns = block.columns.map((column) => {
        const body =
          renderBlocks(column, context) ||
          renderUnsupported(context, "empty_column", "");
        return wrapDirective("col", "", body);
      });
      return wrapDirective("cols", "", columns.join("\n\n"));
    }
    case "callout": {
      const icon = escapeDirectiveAttribute(block.icon?.trim() || "💡");
      const body =
        renderBlocks(block.children, context) ||
        renderUnsupported(context, "empty_callout", "");
      return wrapDirective("callout", `{icon="${icon}"}`, body);
    }
    case "toggle": {
      if (/&(?:#[0-9]+|#x[a-f0-9]+|[a-z][a-z0-9]+);/i.test(block.summary)) {
        return renderUnsupported(
          context,
          "toggle_unsafe_summary",
          stableJson(block),
        );
      }
      const summary = escapeDirectiveAttribute(block.summary.trim() || "Toggle");
      const body =
        renderBlocks(block.children, context) ||
        renderUnsupported(context, "empty_toggle", "");
      return wrapDirective("toggle", `{summary="${summary}"}`, body);
    }
    case "page_ref": {
      const notionId = normalizeNotionId(block.notionId);
      const pageId = context.pageIds.get(notionId);
      const label = escapeLinkLabel(
        `${block.icon ? `${block.icon} ` : ""}${block.title}`.trim() ||
          notionId,
      );
      if (pageId && /^[A-Za-z0-9_-]+$/.test(pageId)) {
        return `[${label}](/p/${pageId})`;
      }
      const link = block.sourceUrl
        ? `[${label}](${block.sourceUrl})\n\n`
        : "";
      return `${link}${renderUnsupported(context, "unresolved_page_ref", block.notionId)}`;
    }
    case "attachment": {
      if (
        block.kind === "image" &&
        !isNotionRasterRenderableImage(block.name, block.mimeType)
      ) {
        return renderUnsupported(
          context,
          "non_raster_image_unsupported",
          block.sourceId,
        );
      }
      let plannedUrl: string;
      try {
        plannedUrl = notionAttachmentUrl(
          block.sha256,
          block.name,
          block.mimeType,
        );
      } catch {
        return renderUnsupported(context, "attachment_invalid_hash", block.sourceId);
      }
      const url = context.attachmentUrls.get(block.sourceId) ?? plannedUrl;
      const expectedHash = block.sha256.toLowerCase();
      const actualName = url
        ? /^\/_attachments-v2\/([a-f0-9]{64})(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,31})?$/.exec(
            url,
          )
        : null;
      if (!actualName || actualName[1] !== expectedHash || url !== plannedUrl) {
        return renderUnsupported(context, "attachment_not_uploaded", block.sourceId);
      }
      if (block.kind === "image") {
        return `![${escapeLinkLabel(block.alt ?? block.name)}](${url})`;
      }
      return `[${escapeLinkLabel(block.name)}](${url})`;
    }
    case "unknown":
      return renderUnsupported(context, block.notionType, block.raw);
    default: {
      // The IR normally wraps unsupported Notion blocks as type=unknown, but
      // adapters and future connector versions are runtime JSON. Never let an
      // unrecognized discriminant fall through to undefined and disappear.
      const runtime = block as unknown as Record<string, unknown>;
      const runtimeType =
        typeof runtime.type === "string" ? runtime.type : "invalid_ir_block";
      return renderUnsupported(context, runtimeType, stableJson(runtime));
    }
  }
}

function renderUnsupported(
  context: ConversionContext,
  type: string,
  raw: string,
): string {
  context.issues.push({ type, raw });
  const payload = JSON.stringify({ type, raw });
  const longestTicks = Math.max(
    0,
    ...[...payload.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestTicks + 1));
  return `${fence}notion-unsupported\n${payload}\n${fence}`;
}

function recordCoverIssue(
  document: NotionImportDocument,
  context: ConversionContext,
): void {
  if (
    document.cover &&
    !isNotionRasterRenderableImage(
      document.cover.name,
      document.cover.mimeType,
    )
  ) {
    context.issues.push({
      type: "non_raster_cover_unsupported",
      raw: document.cover.sourceId,
    });
  }
}

function wrapDirective(name: string, attributes: string, body: string): string {
  const longestFence = Math.max(
    0,
    ...body
      .split("\n")
      .map((line) => /^(:{3,})/.exec(line)?.[1].length ?? 0),
  );
  const fence = ":".repeat(Math.max(3, longestFence + 1));
  return `${fence}${name}${attributes}\n${body}\n${fence}`;
}

function normalizePageMap(
  input: ConvertNotionOptions["pageIdByNotionId"],
): ReadonlyMap<string, string> {
  const entries = input instanceof Map ? input.entries() : Object.entries(input);
  return new Map(
    [...entries].map(([notionId, pageId]) => [normalizeNotionId(notionId), pageId]),
  );
}

function conversionContext(options: ConvertNotionOptions): ConversionContext {
  return {
    pageIds: normalizePageMap(options.pageIdByNotionId),
    attachmentUrls: normalizeStringMap(options.attachmentUrlBySourceId ?? {}),
    issues: [],
  };
}

function normalizeStringMap(
  input: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  return new Map(input instanceof Map ? input.entries() : Object.entries(input));
}

function normalizeNotionId(input: string): string {
  return input.replace(/-/g, "").toLowerCase();
}

function escapeDirectiveAttribute(input: string): string {
  return input
    // Protect text that already looks like a character reference. A plain
    // ampersand is canonical in remark-directive's serializer.
    .replace(/&(?=(?:#[0-9]+|#x[a-f0-9]+|[a-z][a-z0-9]+);)/gi, "&amp;")
    .replace(/"/g, "&#x22;")
    .replace(/\r/g, "&#xD;")
    .replace(/\n/g, "&#xA;");
}

function escapeLinkLabel(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalizeNotionIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeNotionIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        key === "notionId" && typeof child === "string"
          ? normalizeNotionId(child)
          : canonicalizeNotionIds(child),
      ]),
    );
  }
  return value;
}
