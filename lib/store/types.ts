import type {
  CollectionDefinition,
  CollectionRow,
} from "../collections/model";

export interface Sticker {
  id: string;
  x: number; // px from the article's left edge (desktop layout)
  y: number; // px from the article's top edge
  text: string;
}

export type MetadataExpected = Partial<{
  title: string | null;
  icon: string | null;
  cover: string | null;
  public: boolean | null;
  shareLocked: boolean;
  shareExpiresAt: string | null;
  category: string | null;
  pinned: boolean | null;
  status: string | null;
  view: "board" | "sections" | null;
  font: "sans" | "serif" | "mono" | null;
  smallText: boolean | null;
  fullWidth: boolean | null;
  sections: string[] | null;
  stickers: Sticker[] | null;
  tags: string[] | null;
}>;

export type BoardMutationInput =
  | {
      operation: "move-card";
      boardId: string;
      cardId: string;
      status: string;
      beforeId: string | null;
    }
  | {
      operation: "rename-column";
      boardId: string;
      from: string;
      to: string;
    }
  | {
      operation: "delete-column";
      boardId: string;
      name: string;
      fallback: string;
    };

export interface PageMeta {
  id: string; // nanoid — canonical, immutable handle
  title: string; // display, mutable
  icon?: string;
  cover?: string;
  order: string; // fractional-index key among siblings
  created: string; // ISO
  updated: string; // ISO
  public?: boolean; // shared read-only at /share/[id]
  sharePass?: string; // bcrypt hash — the shared page asks for this password
  shareVersion?: number; // invalidates already-issued share cookies on rotation
  shareExpiresAt?: string; // optional ISO deadline; elapsed/malformed fails closed
  category?: string; // free-text label, suggested from existing ones
  pinned?: boolean; // shown in the sidebar's Pinned section
  updatedBy?: "me" | "claude"; // who wrote last (hub feed); absent on old pages
  /** Internal stale-write fence. A synthesized structural move does not change
   *  Markdown, so body-only conflict merging stays disabled until a real body
   *  write establishes a new textual baseline. */
  structureWriteBarrier?: boolean;
  status?: string; // kanban column (pages that are cards on a board)
  view?: "board" | "sections"; // board = kanban; sections = AI/manual grouped doc
  font?: "sans" | "serif" | "mono"; // page-scoped reading/editor typeface
  smallText?: boolean; // compact page typography; absent means default sizing
  fullWidth?: boolean; // expand the page canvas; absent means default width
  sections?: string[]; // ordered section labels (for view:sections)
  collection?: CollectionDefinition; // source-backed database schema + views
  collectionRow?: CollectionRow; // typed values for a child row page
  stickers?: Sticker[]; // post-its pinned on the page
  /** Internal payload binding for a server-derived quick-capture page id. */
  quickCaptureFingerprint?: string;
  notionId?: string; // only on imported pages (idempotency)
  notionSourceHash?: string; // sha256 of the last finalized Notion source
  notionConversionHash?: string; // source + resolved page/attachment dependencies
  notionTargetRev?: string; // last-finalized title/icon/cover/body hash
  notionTargetParentId?: string | null; // last-finalized Brain hierarchy
  notionTargetBeforeId?: string | null; // next sibling at last finalize
  notionTargetOrder?: string; // last-finalized fractional order key
  notionImportHash?: string; // source hash currently reserved for import
  notionImportToken?: string; // short-lived ownership token for finalize/upload
  notionImportStarted?: string; // ISO timestamp for stale reservation takeover
  notionImportBaseRev?: string; // body hash at reserve time (prevents clobbering edits)
  notionImportCreated?: boolean; // reservation created this placeholder page
  notionImportOwnedCover?: string; // provisional cover to clear on placeholder abort
  notionImportParentId?: string | null; // desired parent for finalize
  notionImportBeforeId?: string | null; // desired next sibling for finalize
  notionImportBaseParentId?: string | null; // hierarchy at reserve time
  notionImportBaseBeforeId?: string | null; // next sibling at reserve time
  notionImportBaseOrder?: string; // order at reserve time
  notionAbortId?: string; // durable lost-ack receipt, keyed by normalized Notion id
  notionAbortSourceHash?: string;
  notionAbortTokenSha256?: string; // raw reservation tokens are never persisted here
  notionAbortStatus?: "detached" | "aborted";
  notionAbortStagingRemoved?: boolean;
  notionAbortCompletedAt?: string;
  deleted?: string; // ISO — soft-deleted (in trash), hidden from the tree
  tags?: string[]; // labels shown on kanban cards
}

export interface Page {
  meta: PageMeta;
  markdown: string;
  rev: string; // content hash — optimistic concurrency token (derived, not stored)
}

/** Secrets and importer lease internals never cross an API/MCP boundary. Server
 *  routes that enforce sharing still use Store.readPage() directly. */
export function redactPageMeta(meta: PageMeta): PageMeta {
  const safe = { ...meta };
  delete safe.sharePass;
  delete safe.notionImportToken;
  delete safe.notionImportHash;
  delete safe.notionImportStarted;
  delete safe.notionImportBaseRev;
  delete safe.notionImportCreated;
  delete safe.notionImportOwnedCover;
  delete safe.notionImportParentId;
  delete safe.notionImportBeforeId;
  delete safe.notionImportBaseParentId;
  delete safe.notionImportBaseBeforeId;
  delete safe.notionImportBaseOrder;
  delete safe.notionAbortId;
  delete safe.notionAbortSourceHash;
  delete safe.notionAbortTokenSha256;
  delete safe.notionAbortStatus;
  delete safe.notionAbortStagingRemoved;
  delete safe.notionAbortCompletedAt;
  delete safe.quickCaptureFingerprint;
  delete safe.structureWriteBarrier;
  return safe;
}

export function redactPage(page: Page): Page {
  return { ...page, meta: redactPageMeta(page.meta) };
}

export interface AttachmentInput {
  data: Uint8Array;
  originalName: string;
  mimeType: string;
}

export interface NotionAttachmentInput extends AttachmentInput {
  /** Hash captured from the source descriptor before reserve. */
  expectedSha256: string;
}

export interface SavedAttachment {
  url: string;
  name: string;
  size: number;
  type: string;
}

export interface NotionImportStatus {
  id: string;
  title: string;
  icon?: string;
  notionId: string;
  sourceHash?: string;
  conversionHash?: string;
  current: {
    parentId: string | null;
    beforeId: string | null;
  };
  trackedBaseline?: {
    parentId: string | null;
    beforeId: string | null;
    order: string;
  };
  importing?: {
    sourceHash: string;
    started: string;
    leaseFresh: boolean;
    retryAfterMs: number;
  };
  /** Server-computed integrity flags. They expose no reservation secret and
   * let an external importer finish a complete read-only destination preflight
   * before its first reserve call. */
  integrity?: {
    trackedTargetIntact?: boolean;
    trackedAttachmentIntact?: boolean;
    importBaselineIntact?: boolean;
    abortBaselineIntact?: boolean;
    reservationOwned?: boolean;
  };
  pendingAbort?: {
    pageId: string;
    sourceHash: string;
    status: "detached" | "aborted";
    cleanup: {
      stagingRemoved: boolean;
      notionBindingRemoved: boolean;
      placeholderPreserved: true;
    };
  };
  deleted: boolean;
}

/** Metadata-only baseline used to review an existing Brain page before a
 * preserve/adopt decision. It deliberately omits title, body, order, and every
 * raw reservation capability. */
export interface NotionCandidateBaseline {
  id: string;
  rev: string;
  current: {
    parentId: string | null;
    beforeId: string | null;
  };
  deleted: boolean;
  bindingState:
    | "unbound"
    | "tracked"
    | "bound_untracked"
    | "import_pending"
    | "abort_pending";
  notionId?: string;
  sourceHash?: string;
  conversionHash?: string;
  trackedTargetIntact?: boolean;
  trackedAttachmentIntact?: boolean;
  /** True only for a legacy page whose sole Notion field is the matching
   * notionId. Partial tracking/reservation metadata is never upgradeable. */
  legacyBindingUpgradeable?: boolean;
}

export interface ReserveNotionImportInput {
  notionId: string;
  sourceHash: string;
  conversionHash?: string;
  parentId: string | null;
  beforeId: string | null;
  title: string;
  icon?: string;
  cover?: string;
  reservationToken: string;
  acknowledgedAbort?: {
    sourceHash: string;
    reservationToken: string;
  };
}

export type ReserveNotionImportResult =
  | {
      status: "unchanged";
      page: NotionImportStatus;
    }
  | {
      status: "conversion_required";
      page: NotionImportStatus;
    }
  | {
      status: "busy";
      page: NotionImportStatus;
      retryAfterMs: number;
    }
  | {
      status: "reserved";
      page: NotionImportStatus;
      reservationToken: string;
      created: boolean;
    };

export interface FinalizeNotionImportInput {
  notionId: string;
  sourceHash: string;
  conversionHash: string;
  reservationToken: string;
  markdown: string;
  title?: string;
  icon?: string;
  cover?: string;
  collection?: CollectionDefinition | null;
  collectionRow?: CollectionRow | null;
}

export interface AdoptNotionImportInput {
  pageId: string;
  notionId: string;
  sourceHash: string;
  conversionHash: string;
  expectedRev: string;
  expectedParentId: string | null;
  expectedBeforeId: string | null;
}

export interface AdoptNotionImportResult {
  status: "adopted";
  page: NotionImportStatus;
  rev: string;
}

export interface VerifyNotionAttachmentInput {
  notionId: string;
  sourceHash: string;
  reservationToken: string;
  url: string;
}

export interface VerifiedNotionAttachment {
  url: string;
  size: number;
  sha256: string;
}

export interface VerifyFinalizedNotionAttachmentInput {
  notionId: string;
  sourceHash: string;
  conversionHash: string;
  url: string;
}

export interface AbortNotionImportInput {
  notionId: string;
  sourceHash: string;
  reservationToken: string;
}

export type AbortNotionImportResult =
  | {
      status: "detached";
      pageId: string;
      cleanup: {
        stagingRemoved: boolean;
        notionBindingRemoved: true;
        placeholderPreserved: true;
      };
    }
  | {
      status: "aborted";
      pageId: string;
      cleanup: {
        stagingRemoved: boolean;
        notionBindingRemoved: false;
        placeholderPreserved: true;
      };
    };

export type FinalizeNotionImportResult =
  | {
      status: "unchanged";
      page: NotionImportStatus;
      rev: string;
      cleanup: {
        stagingRemoved: boolean;
      };
    }
  | {
      status: "finalized";
      page: NotionImportStatus;
      rev: string;
      cleanup: {
        stagingRemoved: boolean;
      };
    };

export interface TreeNode {
  id: string;
  parentId: string | null;
  title: string;
  icon?: string;
  cover?: string;
  order: string;
  public?: boolean;
  shareLocked?: boolean; // sharePass is set (the hash itself never leaves the server)
  shareExpiresAt?: string;
  category?: string;
  pinned?: boolean;
  created: string;
  updated: string;
  updatedBy?: "me" | "claude";
  status?: string;
  view?: "board" | "sections";
  font?: "sans" | "serif" | "mono";
  smallText?: boolean;
  fullWidth?: boolean;
  sections?: string[];
  notionId?: string;
  collection?: CollectionDefinition;
  collectionRow?: CollectionRow;
  tags?: string[];
  hasChildren: boolean;
  children: TreeNode[];
}

/** Owner-only disclosure snapshot for enabling a subtree share. The opaque
 * token binds the confirmation to both the current live descendants and the
 * root's current share authority without exposing password material. */
export interface ShareScopeSnapshot {
  rootId: string;
  descendantCount: number;
  overlappingRoots: Array<{
    rootId: string;
    title: string;
    relation: "ancestor" | "descendant";
    shareExpiresAt: string | null;
  }>;
  scopeToken: string;
  public: boolean;
  shareLocked: boolean;
  shareExpiresAt: string | null;
  shareVersion: number;
}

export class RevConflictError extends Error {
  constructor(
    public currentRev: string,
    public expectedRev: string,
  ) {
    super("rev conflict");
    this.name = "RevConflictError";
  }
}

export class MetadataConflictError extends Error {
  constructor(public fields: string[]) {
    super("metadata conflict");
    this.name = "MetadataConflictError";
  }
}

export class ShareScopeConflictError extends Error {
  constructor(public snapshot: ShareScopeSnapshot) {
    super("share scope conflict");
    this.name = "ShareScopeConflictError";
  }
}

export class QuickCaptureConflictError extends Error {
  constructor() {
    super("quick capture payload conflict");
    this.name = "QuickCaptureConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(public id: string) {
    super(`page not found: ${id}`);
    this.name = "NotFoundError";
  }
}

export class PageRefNestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageRefNestValidationError";
  }
}

export class NotionImportConflictError extends Error {
  constructor(
    public code:
      | "invalid_notion_id"
      | "invalid_source_hash"
      | "conversion_mismatch"
      | "conversion_issues"
      | "reservation_mismatch"
      | "source_changed"
      | "untracked_existing"
      | "already_imported"
      | "missing_attachment"
      | "attachment_not_owned"
      | "incompatible_icon"
      | "incompatible_cover"
      | "has_import_children"
      | "parent_not_found"
      | "parent_import_pending"
      | "sibling_import_pending"
      | "abort_ack_required"
      | "staging_unavailable"
      | "attachment_store_unavailable"
      | "page_deleted",
    message: string,
  ) {
    super(message);
    this.name = "NotionImportConflictError";
  }
}

export class AttachmentValidationError extends Error {
  constructor(
    public code:
      | "too_large"
      | "invalid_mime"
      | "blocked_mime"
      | "mime_mismatch"
      | "hash_mismatch"
      | "quota_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentValidationError";
  }
}

/** Match store errors by NAME, never `instanceof`. Next bundles route handlers
 *  and RSC pages into separate module layers, each with its own copy of these
 *  classes — an error thrown by the (shared, globalThis-pinned) Store fails
 *  `instanceof` against another layer's class. That silently turned 409s into
 *  raw 500s: the client retried with the same stale rev forever (the
 *  RevConflictError storm in the service error log), and MCP clients read the 500
 *  as id=null. */
export function isRevConflict(e: unknown): e is RevConflictError {
  return e instanceof Error && e.name === "RevConflictError";
}

export function isMetadataConflict(
  e: unknown,
): e is MetadataConflictError {
  return e instanceof Error && e.name === "MetadataConflictError";
}

export function isShareScopeConflict(
  e: unknown,
): e is ShareScopeConflictError {
  return e instanceof Error && e.name === "ShareScopeConflictError";
}

export function isQuickCaptureConflict(
  e: unknown,
): e is QuickCaptureConflictError {
  return e instanceof Error && e.name === "QuickCaptureConflictError";
}

export function isNotFound(e: unknown): e is NotFoundError {
  return e instanceof Error && e.name === "NotFoundError";
}

export function isPageRefNestValidation(
  e: unknown,
): e is PageRefNestValidationError {
  return e instanceof Error && e.name === "PageRefNestValidationError";
}

export function isNotionImportConflict(
  e: unknown,
): e is NotionImportConflictError {
  return e instanceof Error && e.name === "NotionImportConflictError";
}

export function isAttachmentValidation(
  e: unknown,
): e is AttachmentValidationError {
  return e instanceof Error && e.name === "AttachmentValidationError";
}
