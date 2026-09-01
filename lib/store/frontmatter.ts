import matter from "gray-matter";
import type { PageMeta } from "./types";
import { canonicalPageMarkdown } from "../page-markdown";

/** Parse an index.md into (partial) metadata + body markdown. */
export function parsePage(raw: string): {
  meta: Partial<PageMeta>;
  markdown: string;
} {
  // The options object is required: gray-matter caches every distinct input
  // string forever when called without options, which leaks one entry per
  // saved revision for the life of the process (audit 2026-08-19).
  const { data, content } = matter(raw, { language: "yaml" });
  return {
    meta: data as Partial<PageMeta>,
    // strip only leading/trailing blank lines — the trailing file newline is a
    // serialization detail, not content (keeps read↔write round-trips stable)
    markdown: canonicalPageMarkdown(content),
  };
}

/** Every key serializePage manages explicitly. Anything else found on the
 *  metadata object came from outside this application — an Obsidian plugin,
 *  a hand edit, another clone of the notes, a removed feature — and is carried
 *  through verbatim. Notes captured before the Inbox was removed still carry
 *  `inbox: true`; it rides along untouched and nothing reads it. */
const MANAGED_PAGE_META_KEYS = new Set([
  "id",
  "title",
  "icon",
  "cover",
  "order",
  "created",
  "updated",
  "updatedBy",
  "structureWriteBarrier",
  "status",
  "view",
  "font",
  "smallText",
  "fullWidth",
  "sections",
  "collection",
  "collectionRow",
  "tags",
  "stickers",
  "public",
  "sharePass",
  "shareVersion",
  "shareExpiresAt",
  "category",
  "pinned",
  "quickCaptureFingerprint",
  "notionId",
  "notionSourceHash",
  "notionConversionHash",
  "notionTargetRev",
  "notionTargetParentId",
  "notionTargetBeforeId",
  "notionTargetOrder",
  "notionImportHash",
  "notionImportToken",
  "notionImportStarted",
  "notionImportBaseRev",
  "notionImportCreated",
  "notionImportOwnedCover",
  "notionImportParentId",
  "notionImportBeforeId",
  "notionImportBaseParentId",
  "notionImportBaseBeforeId",
  "notionImportBaseOrder",
  "notionAbortId",
  "notionAbortSourceHash",
  "notionAbortTokenSha256",
  "notionAbortStatus",
  "notionAbortStagingRemoved",
  "notionAbortCompletedAt",
  "deleted",
]);

/** Serialize metadata + markdown into an index.md with a stable key order
 *  (stable order keeps git diffs clean). */
export function serializePage(meta: PageMeta, markdown: string): string {
  const ordered: Record<string, unknown> = { id: meta.id, title: meta.title };
  if (meta.icon) ordered.icon = meta.icon;
  if (meta.cover) ordered.cover = meta.cover;
  ordered.order = meta.order;
  ordered.created = meta.created;
  ordered.updated = meta.updated;
  if (meta.updatedBy) ordered.updatedBy = meta.updatedBy;
  if (meta.structureWriteBarrier) ordered.structureWriteBarrier = true;
  if (meta.status) ordered.status = meta.status;
  if (meta.view) ordered.view = meta.view;
  // A missing font inherits the global default; an explicit `sans` must stay
  // distinguishable so a page can override a serif/mono global preference.
  if (meta.font) ordered.font = meta.font;
  if (meta.smallText) ordered.smallText = true;
  if (meta.fullWidth) ordered.fullWidth = true;
  if (meta.sections?.length) ordered.sections = meta.sections;
  if (meta.collection) ordered.collection = meta.collection;
  if (meta.collectionRow) ordered.collectionRow = meta.collectionRow;
  if (meta.tags?.length) ordered.tags = meta.tags;
  if (meta.stickers?.length) ordered.stickers = meta.stickers;
  if (meta.public) ordered.public = true;
  if (meta.sharePass) ordered.sharePass = meta.sharePass;
  if (meta.shareVersion !== undefined) ordered.shareVersion = meta.shareVersion;
  if (meta.shareExpiresAt) ordered.shareExpiresAt = meta.shareExpiresAt;
  if (meta.category) ordered.category = meta.category;
  if (meta.pinned) ordered.pinned = true;
  if (meta.quickCaptureFingerprint)
    ordered.quickCaptureFingerprint = meta.quickCaptureFingerprint;
  if (meta.notionId) ordered.notionId = meta.notionId;
  if (meta.notionSourceHash) ordered.notionSourceHash = meta.notionSourceHash;
  if (meta.notionConversionHash)
    ordered.notionConversionHash = meta.notionConversionHash;
  if (meta.notionTargetRev) ordered.notionTargetRev = meta.notionTargetRev;
  if (meta.notionTargetParentId !== undefined)
    ordered.notionTargetParentId = meta.notionTargetParentId;
  if (meta.notionTargetBeforeId !== undefined)
    ordered.notionTargetBeforeId = meta.notionTargetBeforeId;
  if (meta.notionTargetOrder) ordered.notionTargetOrder = meta.notionTargetOrder;
  if (meta.notionImportHash) ordered.notionImportHash = meta.notionImportHash;
  if (meta.notionImportToken) ordered.notionImportToken = meta.notionImportToken;
  if (meta.notionImportStarted)
    ordered.notionImportStarted = meta.notionImportStarted;
  if (meta.notionImportBaseRev)
    ordered.notionImportBaseRev = meta.notionImportBaseRev;
  if (meta.notionImportCreated) ordered.notionImportCreated = true;
  if (meta.notionImportOwnedCover)
    ordered.notionImportOwnedCover = meta.notionImportOwnedCover;
  if (meta.notionImportParentId !== undefined)
    ordered.notionImportParentId = meta.notionImportParentId;
  if (meta.notionImportBeforeId !== undefined)
    ordered.notionImportBeforeId = meta.notionImportBeforeId;
  if (meta.notionImportBaseParentId !== undefined)
    ordered.notionImportBaseParentId = meta.notionImportBaseParentId;
  if (meta.notionImportBaseBeforeId !== undefined)
    ordered.notionImportBaseBeforeId = meta.notionImportBaseBeforeId;
  if (meta.notionImportBaseOrder)
    ordered.notionImportBaseOrder = meta.notionImportBaseOrder;
  if (meta.notionAbortId) ordered.notionAbortId = meta.notionAbortId;
  if (meta.notionAbortSourceHash)
    ordered.notionAbortSourceHash = meta.notionAbortSourceHash;
  if (meta.notionAbortTokenSha256)
    ordered.notionAbortTokenSha256 = meta.notionAbortTokenSha256;
  if (meta.notionAbortStatus)
    ordered.notionAbortStatus = meta.notionAbortStatus;
  if (meta.notionAbortStagingRemoved !== undefined)
    ordered.notionAbortStagingRemoved = meta.notionAbortStagingRemoved;
  if (meta.notionAbortCompletedAt)
    ordered.notionAbortCompletedAt = meta.notionAbortCompletedAt;
  if (meta.deleted) ordered.deleted = meta.deleted;
  // Files outlive the application: a foreign frontmatter key used to be
  // erased on the first save because this function rebuilt the mapping from
  // an explicit allowlist (audit 2026-08-19). Unknown keys ride along after
  // the managed block, so the stable order of managed keys is unchanged.
  for (const [key, value] of Object.entries(
    meta as unknown as Record<string, unknown>,
  )) {
    if (MANAGED_PAGE_META_KEYS.has(key) || value === undefined) continue;
    ordered[key] = value;
  }
  const body = canonicalPageMarkdown(markdown);
  return matter.stringify(body ? body + "\n" : "", ordered);
}
