import { createHash } from "node:crypto";
import { canonicalPageMarkdown } from "../page-markdown.ts";
import { canonicalAttachmentMimeType } from "../attachments.ts";
import {
  collectionDefinitionSchema,
  collectionRowSchema,
  type CollectionDefinition,
  type CollectionRow,
} from "../collections/model.ts";

export const NOTION_CONVERTER_VERSION = 2;
const RASTER_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const SVG_EXTENSION_RE = /\.svgz?$/i;

export interface NotionConversionTarget {
  sourceHash: string;
  parentId: string | null;
  beforeId: string | null;
  title: string;
  icon?: string;
  cover?: string;
  markdown: string;
  collection?: CollectionDefinition | null;
  collectionRow?: CollectionRow | null;
}

/** Brain page icons are text/emoji. Notion file, custom, and external URL icons
 * need a future first-class representation and must not be imported as broken
 * text metadata. */
export function isBrainCompatibleNotionIcon(icon: string | undefined): boolean {
  const value = icon?.trim();
  return !value || !/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value);
}

/** Notion covers are downloaded and content-addressed before reserve. Signed
 *  CDN URLs are short-lived and must never become durable Brain metadata. */
export function isBrainCompatibleNotionCover(
  cover: string | undefined,
): boolean {
  const value = cover?.trim();
  return (
    !value ||
    /^\/_attachments-v2\/[a-f0-9]{64}\.(?:png|jpe?g|gif|webp|avif)$/.test(
      value,
    )
  );
}

/** Images rendered in the editor must have an explicitly raster MIME. Source
 *  names ending in .svg/.svgz are blocked even under a misleading alias, and
 *  octet-stream never becomes an image merely because its extension looks OK. */
export function isNotionRasterRenderableImage(
  name: string,
  mimeType: string,
): boolean {
  const normalizedMime = canonicalAttachmentMimeType(mimeType);
  if (SVG_EXTENSION_RE.test(name) || normalizedMime === "image/svg+xml") {
    return false;
  }
  return RASTER_IMAGE_MIMES.has(normalizedMime);
}

/** Canonical target shape produced by an import. This mirrors Store finalize:
 *  titles are trimmed/defaulted, empty optional metadata is removed, and file
 *  serialization does not treat outer blank lines as page content. */
export function canonicalizeNotionImportTarget(
  target: NotionConversionTarget,
): NotionConversionTarget {
  return {
    sourceHash: target.sourceHash.toLowerCase(),
    parentId: target.parentId,
    beforeId: target.beforeId,
    title: target.title.trim() || "Untitled",
    icon: target.icon || undefined,
    cover: target.cover || undefined,
    markdown: canonicalPageMarkdown(target.markdown),
    ...(target.collection
      ? {
          collection: collectionDefinitionSchema.parse(target.collection),
        }
      : {}),
    ...(target.collectionRow
      ? {
          collectionRow: collectionRowSchema.parse(target.collectionRow),
        }
      : {}),
  };
}

/**
 * Hash only values that the Store can verify at finalize/adoption time. The
 * source hash already commits to the complete source IR (including attachment
 * descriptors); this second hash commits to the exact, already-canonical Brain
 * target. Never accept a caller-supplied conversion hash without recomputing
 * this value server-side.
 */
export function notionConversionHash(target: NotionConversionTarget): string {
  return createHash("sha256")
    .update(
      stableJson({
        converterVersion: NOTION_CONVERTER_VERSION,
        sourceHash: target.sourceHash,
        parentId: target.parentId,
        beforeId: target.beforeId,
        title: target.title,
        icon: target.icon ?? null,
        cover: target.cover ?? null,
        markdown: target.markdown,
        ...(target.collection
          ? { collection: target.collection }
          : {}),
        ...(target.collectionRow
          ? { collectionRow: target.collectionRow }
          : {}),
      }),
    )
    .digest("hex");
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
