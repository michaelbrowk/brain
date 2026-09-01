import fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";
import { nanoid } from "nanoid";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { parsePage, serializePage } from "./frontmatter";
import { atomicWrite, hashRev, syncDirectory } from "./atomic";
import { slugify, assertInRoot, isReservedDir } from "./paths";
import {
  assertGitReady,
  assertGitSnapshotHealthy,
  beginGitSnapshotBarrier,
  resumeGitSnapshotsAfterRecovery,
  scheduleDirtyCommit,
  scheduleCommit,
  logForPath,
  showPageAtRevision,
  type Version,
} from "./git";
import { emitStore } from "./events";
import {
  canonicalAttachmentMimeType,
  canonicalAttachmentExtension,
  localAttachmentName,
  normalizeAttachmentDisplayName,
  referencedAttachmentNames,
  referencedAttachmentUrls,
} from "../attachments";
import {
  isBrainCompatibleNotionCover,
  isBrainCompatibleNotionIcon,
  notionConversionHash,
} from "../notion/protocol";
import { canonicalPageMarkdown } from "../page-markdown";
import {
  removeStandalonePageRefOccurrence,
  appendStandalonePageRef,
  removeStandalonePageRefs,
  standalonePageRefOccurrences,
} from "../page-ref-nesting";
import { referencedPageIds } from "../derived-page-refs";
import {
  assertCollectionRowMatchesDefinition,
  collectionDefinitionSchema,
  collectionRowSchema,
} from "../collections/model";
import {
  type AbortNotionImportInput,
  type AbortNotionImportResult,
  type AdoptNotionImportInput,
  type AdoptNotionImportResult,
  type AttachmentInput,
  type BoardMutationInput,
  type FinalizeNotionImportInput,
  type FinalizeNotionImportResult,
  type NotionCandidateBaseline,
  type NotionImportStatus,
  type NotionAttachmentInput,
  type Page,
  type PageMeta,
  type MetadataExpected,
  type ReserveNotionImportInput,
  type ReserveNotionImportResult,
  type SavedAttachment,
  type ShareScopeSnapshot,
  type TreeNode,
  type VerifiedNotionAttachment,
  type VerifyFinalizedNotionAttachmentInput,
  type VerifyNotionAttachmentInput,
  AttachmentValidationError,
  NotFoundError,
  MetadataConflictError,
  ShareScopeConflictError,
  NotionImportConflictError,
  PageRefNestValidationError,
  QuickCaptureConflictError,
  RevConflictError,
} from "./types";

interface Entry {
  dir: string;
  parentId: string | null;
  meta: PageMeta;
}

export interface PageMoveResult {
  meta: PageMeta;
  /** The old parent whose body stopped listing this page, when the move made
   * a standalone reference there untrue. Null when nothing was rewritten. */
  unlinkedFrom: string | null;
}

interface MoveIntent {
  version: 1;
  pageId: string;
  originalDir: string;
  targetDir: string;
  originalParentId: string | null;
  targetParentId: string | null;
  nextOrder: string;
  updated: string;
  /** The old parent's body, before and after it stopped listing the page that
   * left it. Carried in the same durable intent as the rename so a restart can
   * never leave a document claiming a child it no longer has. */
  originPageRef?: {
    pageId: string;
    indexFile: string;
    beforeRaw: string;
    beforeRev: string;
    afterRaw: string;
    afterRev: string;
  };
  destinationPageRef?: {
    pageId: string;
    indexFile: string;
    beforeRaw: string;
    beforeRev: string;
    afterRaw: string;
    afterRev: string;
  };
  pageRefNest?: {
    parentPageId: string;
    parentIndex: string;
    originalParentRaw: string;
    originalParentRev: string;
    nextParentRaw: string;
    nextParentRev: string;
    removed: boolean;
    targetPage?: {
      pageId: string;
      indexFile: string;
      beforeRaw: string;
      beforeRev: string;
      afterRaw: string;
      afterRev: string;
    };
  };
}

function isCompositeMoveIntent(intent: MoveIntent | undefined): boolean {
  return Boolean(
    intent?.pageRefNest ||
      intent?.destinationPageRef ||
      intent?.originPageRef,
  );
}

interface BoardMutationIntent {
  version: 1;
  operation: "board" | "page-ref-cleanup";
  boardId: string;
  pages: Array<{
    pageId: string;
    indexFile: string;
    beforeRaw: string;
    beforeRev: string;
    afterRaw: string;
    afterRev: string;
  }>;
}

interface AbortIndexIntent {
  version: 1;
  operation: "notion-abort";
  nonce: string;
  pageId: string;
  notionId: string;
  sourceHash: string;
  reservationToken: string;
  pageDirectory: string;
  beforeFile: string;
  beforeSha256: string;
  beforeSize: number;
  transactionDirectory: string;
  capturedFile: string;
  nextFile: string;
  nextSha256: string;
  nextSize: number;
}

interface NotionAbortReceipt {
  notionId: string;
  sourceHash: string;
  tokenSha256: string;
  status: "detached" | "aborted";
  stagingRemoved: boolean;
  completedAt: string;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

const now = () => new Date().toISOString();
const PAGE_ID_RE = /^[A-Za-z0-9_-]+$/;
const REV_TOKEN_RE = /^[0-9a-f]{12}$/;
const NOTION_ID_RE = /^[a-f0-9]{32}$/;
const SOURCE_HASH_RE = /^[a-f0-9]{64}$/;
const NOTION_RESERVATION_TTL_MS = 15 * 60 * 1000;
const MOVE_INTENT_FILE = ".brain-move-intent.json";
const BOARD_INTENT_FILE = ".brain-board-intent.json";
const MAX_BOARD_INTENT_BYTES = 64 * 1024 * 1024;
const MAX_BOARD_INTENT_PAGES = 1_000;
const ABORT_INTENT_RE = /^\.brain-abort-intent-([A-Za-z0-9_-]{24})\.json$/;
const ABORT_NONCE_RE = /^[A-Za-z0-9_-]{24}$/;
const MAX_ABORT_INTENT_BYTES = 64 * 1024;

function metadataValue(
  meta: PageMeta,
  field: keyof MetadataExpected,
): unknown {
  if (field === "shareLocked") return Boolean(meta.sharePass);
  const value = meta[field as keyof PageMeta];
  return value === undefined ? null : value;
}

function metadataValuesEqual(current: unknown, expected: unknown): boolean {
  if (Array.isArray(current) || Array.isArray(expected)) {
    return JSON.stringify(current) === JSON.stringify(expected);
  }
  return Object.is(current, expected);
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
// A fresh upload is unreferenced until its markdown save lands; the sweep
// never touches files younger than this.
const ATTACHMENT_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;
const MAX_NOTION_STAGE_FILES = 200;
const MAX_NOTION_STAGE_BYTES = 256 * 1024 * 1024;
const DEFAULT_NOTION_STAGE_LIMITS: NotionStagingLimits = {
  maxFiles: 1_000,
  maxBytes: 512 * 1024 * 1024,
  minFreeBytes: 512 * 1024 * 1024,
};
const NOTION_IMPORT_META_FIELDS: ReadonlyArray<keyof PageMeta> = [
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
];
const NOTION_ABORT_META_FIELDS: ReadonlyArray<keyof PageMeta> = [
  "notionAbortId",
  "notionAbortSourceHash",
  "notionAbortTokenSha256",
  "notionAbortStatus",
  "notionAbortStagingRemoved",
  "notionAbortCompletedAt",
];

export interface NotionStagingLimits {
  maxFiles: number;
  maxBytes: number;
  minFreeBytes: number;
}

export interface StoreOptions {
  notionStagingLimits?: Partial<NotionStagingLimits>;
  /** The origin page links are classified against — the browser's
   *  `window.location.origin`, as the same rule. A body's rows have to count
   *  the same on both sides of an API call, or "row n" of a request names a
   *  different row on the disk. Null means only `/p/<id>` is a page link. */
  publicOrigin?: string | null;
}

/** Fractional-index keys MUST be compared by code point (ASCII), never
 *  localeCompare — locale collation is case-insensitive ('Zz' > 'a0') and
 *  breaks the ordering invariant of generateKeyBetween. */
const byOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

async function ensurePrivateOwnedDirectory(
  directory: string,
): Promise<DirectoryIdentity> {
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = await assertPrivateOwnedDirectory(directory);
  if (created) await syncDirectory(path.dirname(directory));
  return identity;
}

async function assertPrivateOwnedDirectory(
  directory: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const effectiveUid = process.geteuid?.();
  if (effectiveUid === undefined) {
    throw new Error("notion staging requires an effective uid");
  }
  const before = await fs.lstat(directory);
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    before.uid !== effectiveUid ||
    (before.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "notion staging directory must be a real euid-owned 0700 directory",
    );
  }
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(directory);
    const identity = { dev: opened.dev, ino: opened.ino };
    if (
      !opened.isDirectory() ||
      opened.uid !== effectiveUid ||
      (opened.mode & 0o777) !== 0o700 ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (expected &&
        (expected.dev !== identity.dev || expected.ino !== identity.ino))
    ) {
      throw new Error("notion staging directory identity changed");
    }
    return identity;
  } finally {
    await handle.close();
  }
}

function rethrowStagingFailure(error: unknown): never {
  if (
    error instanceof AttachmentValidationError ||
    error instanceof NotionImportConflictError
  ) {
    throw error;
  }
  throw new NotionImportConflictError(
    "staging_unavailable",
    "Notion attachment staging is unavailable",
  );
}

async function ensureRealDirectory(
  directory: string,
): Promise<DirectoryIdentity> {
  try {
    await fs.mkdir(directory);
    await syncDirectory(path.dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return assertRealDirectory(directory);
}

async function assertRealDirectory(
  directory: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> {
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("attachment store must be a real directory");
  }
  const handle = await fs.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    const after = await fs.lstat(directory);
    const identity = { dev: opened.dev, ino: opened.ino };
    if (
      !opened.isDirectory() ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (expected &&
        (expected.dev !== identity.dev || expected.ino !== identity.ino))
    ) {
      throw new Error("attachment store directory identity changed");
    }
    return identity;
  } finally {
    await handle.close();
  }
}

function rethrowAttachmentStoreFailure(error: unknown): never {
  if (
    error instanceof AttachmentValidationError ||
    error instanceof NotionImportConflictError
  ) {
    throw error;
  }
  throw new NotionImportConflictError(
    "attachment_store_unavailable",
    "Attachment store is unavailable",
  );
}

export class Store {
  readonly root: string;
  private readonly publicOrigin: string | null;
  private readonly notionStagingRoot: string;
  private readonly notionStagingLimits: NotionStagingLimits;
  private index = new Map<string, Entry>();
  private notionIndex = new Map<string, string>();
  private abortReceiptIndex = new Map<string, string>();
  private mutationPoison: Error | undefined;
  private mutationGeneration = 0;
  private mutationActive = false;

  // Serialize every mutation. The store is the single writer, but MCP, the web
  // UI, and the Notion importer all fire create/move/delete concurrently, and
  // each mutator does a read-then-write on the in-memory index (last-sibling
  // order key, parent dir). Unserialized, two concurrent createPage() under one
  // parent both read the same `last` sibling and mint the SAME fractional-index
  // order key, and a child create can race its parent's index.set() and throw
  // NotFoundError (surfaced to MCP as id=null → page lands at root). A plain
  // promise-chain queue fixes the whole class. NB: NOT reentrant — a mutator
  // wrapped in mutate() must never call another mutate()-wrapped method, or it
  // deadlocks waiting on itself. Composites that delegate to wrapped leaves
  // (duplicatePage, renamePage, restoreVersion) deliberately stay unwrapped;
  // emptyTrash instead owns one lock and calls its private unwrapped purge leaf.
  private mutationTail: Promise<unknown> = Promise.resolve();

  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      this.mutationActive = true;
      this.mutationGeneration += 1;
      try {
        if (this.mutationPoison) throw this.mutationPoison;
        return await fn();
      } finally {
        // Stay active through the complete mutator, including every rollback
        // and reconciliation await. Public readers can therefore distinguish a
        // stable tree from a transient move that is about to be rolled back.
        this.mutationGeneration += 1;
        this.mutationActive = false;
      }
    };
    const run = this.mutationTail.then(guarded, guarded);
    // keep the queue alive whether this op resolves or rejects
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Synchronous seqlock-style snapshot for public authorization reads.
   * An unchanged inactive generation brackets one stable Store view. */
  readMutationState(): { generation: number; active: boolean } {
    return {
      generation: this.mutationGeneration,
      active: this.mutationActive,
    };
  }

  /** Wait for the writer queue snapshot that was already present at call time.
   * This never acquires the writer lock and does not include mutations queued
   * after the snapshot. */
  waitForMutationIdle(timeoutMs: number): Promise<boolean> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve(false);
    }
    const tail = this.mutationTail;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(completed);
      };
      const timer = setTimeout(() => finish(false), Math.ceil(timeoutMs));
      timer.unref?.();
      void tail.then(() => finish(true));
    });
  }

  constructor(root: string, options: StoreOptions = {}) {
    this.root = path.resolve(/* turbopackIgnore: true */ root);
    this.publicOrigin = options.publicOrigin ?? null;
    const rootKey = createHash("sha256").update(this.root).digest("hex").slice(0, 20);
    this.notionStagingRoot = path.join(
      os.tmpdir(),
      "brain-notion-imports",
      rootKey,
    );
    this.notionStagingLimits = normalizeNotionStagingLimits(
      options.notionStagingLimits,
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await this.ensureNotionStagingRoot().catch(rethrowStagingFailure);
    await this.reconcileMoveIntent();
    await this.reconcileBoardIntent();
    await reconcileAbortIntents(this.root);
    await this.rebuild();
    await this.mutate(() =>
      this.reconcileNotionStaging().catch(rethrowStagingFailure),
    );
    resumeGitSnapshotsAfterRecovery(this.root);
    await scheduleDirtyCommit(this.root);
  }

  /** Walk the folder tree from disk, self-heal missing metadata. */
  async rebuild(): Promise<void> {
    this.index.clear();
    this.notionIndex.clear();
    this.abortReceiptIndex.clear();
    await this.walk(this.root, null);
    await this.normalizeOrders();
  }

  private async walk(dir: string, parentId: string | null): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A container can disappear only when an external filesystem writer races
      // startup. Permission and I/O failures must fail closed: silently omitting
      // a branch makes the app look healthy while notes have disappeared.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // read + recurse the children of this directory concurrently — cold start
    // used to be one blocking readFile at a time down the whole tree
    await Promise.all(
      entries.map(async (e) => {
        if (!e.isDirectory() || isReservedDir(e.name)) return;
        const pageDir = path.join(dir, e.name);
        const indexPath = path.join(pageDir, "index.md");
        let raw: string;
        try {
          raw = await fs.readFile(indexPath, "utf8");
        } catch (error) {
          // folder without index.md: transparent container, recurse with same parent
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.walk(pageDir, parentId);
          return;
        }
        const { meta: partial, markdown } = parsePage(raw);
        let id: string;
        if (partial.id === undefined) {
          id = nanoid();
        } else {
          if (typeof partial.id !== "string" || !PAGE_ID_RE.test(partial.id)) {
            throw new Error(`invalid page id in ${indexPath}`);
          }
          id = partial.id;
        }
        const existing = this.index.get(id);
        if (existing) {
          throw new Error(
            `duplicate page id "${id}" in ${path.join(existing.dir, "index.md")} and ${indexPath}`,
          );
        }
        // spread partial so every persisted field survives a rebuild (deleted,
        // tags, …) — only the load-bearing ones get self-healed defaults
        const meta: PageMeta = {
          ...partial,
          id,
          title: partial.title || deslug(e.name),
          order: partial.order || "",
          created: partial.created || now(),
          updated: partial.updated || now(),
        } as PageMeta;
        // Reserve the identity before any self-heal await. Sibling reads run in
        // parallel, and delaying index.set would let two incomplete files with
        // the same id both pass the duplicate check.
        this.index.set(meta.id, { dir: pageDir, parentId, meta });
        if (meta.notionId) {
          const notionId = normalizeNotionId(meta.notionId);
          const existingNotionPage = this.notionIndex.get(notionId);
          if (existingNotionPage) {
            throw new Error(
              `duplicate notionId "${notionId}" on pages "${existingNotionPage}" and "${meta.id}"`,
            );
          }
          const receiptPage = this.abortReceiptIndex.get(notionId);
          if (receiptPage && receiptPage !== meta.id) {
            throw new Error(
              `notionId "${notionId}" conflicts with pending abort receipt on page "${receiptPage}"`,
            );
          }
          this.notionIndex.set(notionId, meta.id);
        }
        const receipt = notionAbortReceipt(meta);
        if (receipt) {
          const existingReceiptPage = this.abortReceiptIndex.get(
            receipt.notionId,
          );
          if (existingReceiptPage) {
            throw new Error(
              `duplicate notion abort receipt "${receipt.notionId}" on pages "${existingReceiptPage}" and "${meta.id}"`,
            );
          }
          const boundPage = this.notionIndex.get(receipt.notionId);
          if (boundPage && boundPage !== meta.id) {
            throw new Error(
              `notion abort receipt "${receipt.notionId}" conflicts with bound page "${boundPage}"`,
            );
          }
          this.abortReceiptIndex.set(receipt.notionId, meta.id);
        }
        // self-heal id/title/created if they were missing
        if (partial.id === undefined || !partial.title || !partial.created) {
          await atomicWrite(indexPath, serializePage(meta, markdown));
        }
        await this.walk(pageDir, meta.id);
      }),
    );
  }

  /** Give every sibling group valid, distinct fractional orders. */
  private async normalizeOrders(): Promise<void> {
    const groups = new Map<string | null, Entry[]>();
    for (const entry of this.index.values()) {
      const arr = groups.get(entry.parentId) || [];
      arr.push(entry);
      groups.set(entry.parentId, arr);
    }
    for (const arr of groups.values()) {
      const orders = arr.map((e) => e.meta.order);
      const ok =
        orders.every(Boolean) && new Set(orders).size === orders.length;
      if (ok) continue;
      arr.sort(
        (a, b) =>
          byOrder(a.meta.order || "~", b.meta.order || "~") ||
          a.meta.title.localeCompare(b.meta.title),
      );
      const keys = generateNKeysBetween(null, null, arr.length);
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].meta.order === keys[i]) continue;
        arr[i].meta.order = keys[i];
        await this.persist(arr[i]);
      }
    }
  }

  private async persist(entry: Entry): Promise<void> {
    const indexPath = path.join(entry.dir, "index.md");
    const { markdown } = parsePage(await fs.readFile(indexPath, "utf8"));
    await atomicWrite(indexPath, serializePage(entry.meta, markdown));
  }

  private moveIntentPath(): string {
    return assertInRoot(this.root, path.join(this.root, MOVE_INTENT_FILE));
  }

  private async writeMoveIntent(intent: MoveIntent): Promise<void> {
    try {
      await fs.stat(this.moveIntentPath());
      throw new Error("an unresolved cross-parent move intent already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(this.moveIntentPath(), `${JSON.stringify(intent)}\n`);
  }

  private async clearMoveIntent(): Promise<void> {
    await fs.rm(this.moveIntentPath(), { force: true });
    await syncDirectory(this.root);
  }

  private boardIntentPath(): string {
    return assertInRoot(this.root, path.join(this.root, BOARD_INTENT_FILE));
  }

  private async writeBoardIntent(intent: BoardMutationIntent): Promise<void> {
    if (
      intent.pages.length === 0 ||
      intent.pages.length > MAX_BOARD_INTENT_PAGES
    ) {
      throw new Error("board mutation intent has too many pages");
    }
    const serialized = `${JSON.stringify(intent)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_BOARD_INTENT_BYTES) {
      throw new Error("board mutation intent is too large");
    }
    try {
      await fs.stat(this.boardIntentPath());
      throw new Error("an unresolved board mutation intent already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWrite(this.boardIntentPath(), serialized);
  }

  private async clearBoardIntent(): Promise<void> {
    await fs.rm(this.boardIntentPath(), { force: true });
    await syncDirectory(this.root);
  }

  /** Finish an interrupted multi-page board mutation before rebuilding the
   * in-memory tree. Each page may be either at the exact before bytes or the
   * exact after bytes; any third state fails closed instead of guessing. */
  private async reconcileBoardIntent(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.boardIntentPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_BOARD_INTENT_BYTES) {
      throw new Error("board mutation intent is too large");
    }
    const intent = parseBoardMutationIntent(raw);
    for (const page of intent.pages) {
      const indexFile = moveIntentFile(this.root, page.indexFile);
      const currentRaw = await fs.readFile(indexFile, "utf8");
      const currentRev = hashRev(currentRaw);
      if (currentRaw === page.afterRaw && currentRev === page.afterRev) {
        continue;
      }
      if (currentRaw !== page.beforeRaw || currentRev !== page.beforeRev) {
        throw new Error(
          `board mutation page revision mismatch: ${page.pageId}`,
        );
      }
      await atomicWrite(indexFile, page.afterRaw);
    }
    await this.clearBoardIntent();
  }

  /** Complete or abandon one cross-parent move that was interrupted between
   *  the directory rename and order persistence. Runs before index rebuild so
   *  the in-memory hierarchy is always derived from a reconciled disk state. */
  private async reconcileMoveIntent(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.moveIntentPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const intent = parseMoveIntent(raw);
    const originalDir = moveIntentDirectory(this.root, intent.originalDir);
    const targetDir = moveIntentDirectory(this.root, intent.targetDir);
    if (originalDir === targetDir) {
      throw new Error("cross-parent move intent has identical directories");
    }
    const originalIndex = path.join(originalDir, "index.md");
    const targetIndex = path.join(targetDir, "index.md");
    const nest = intent.pageRefNest;
    const destinationPage = nest?.targetPage ?? intent.destinationPageRef;
    const originPage = intent.originPageRef;
    let parentIndex: string | undefined;
    let parentRaw: string | null = null;
    let destinationPageIndex: string | undefined;
    let destinationPageRaw: string | null = null;
    let originPageIndex: string | undefined;
    let originPageRaw: string | null = null;
    if (nest) {
      parentIndex = moveIntentFile(this.root, nest.parentIndex);
      if (parentIndex === originalIndex || parentIndex === targetIndex) {
        throw new Error("page-ref move intent parent overlaps its source page");
      }
      parentRaw = await readOptionalFile(parentIndex);
      const parentRev = parentRaw === null ? null : hashRev(parentRaw);
      const parentIsOriginal =
        parentRaw === nest.originalParentRaw &&
        parentRev === nest.originalParentRev;
      const parentIsNext =
        parentRaw === nest.nextParentRaw && parentRev === nest.nextParentRev;
      if (parentRaw === null || (!parentIsOriginal && !parentIsNext)) {
        throw new Error(
          `page-ref move intent parent revision mismatch: ${nest.parentPageId}`,
        );
      }
    }
    if (destinationPage) {
      destinationPageIndex = moveIntentFile(
        this.root,
        destinationPage.indexFile,
      );
      if (
        destinationPageIndex === originalIndex ||
        destinationPageIndex === targetIndex ||
        destinationPageIndex === parentIndex
      ) {
        throw new Error(
          "move intent destination page overlaps another participant",
        );
      }
      destinationPageRaw = await readOptionalFile(destinationPageIndex);
      const destinationPageRev =
        destinationPageRaw === null ? null : hashRev(destinationPageRaw);
      const destinationPageIsBefore =
        destinationPageRaw === destinationPage.beforeRaw &&
        destinationPageRev === destinationPage.beforeRev;
      const destinationPageIsAfter =
        destinationPageRaw === destinationPage.afterRaw &&
        destinationPageRev === destinationPage.afterRev;
      if (
        destinationPageRaw === null ||
        (!destinationPageIsBefore && !destinationPageIsAfter)
      ) {
        throw new Error(
          `move intent destination revision mismatch: ${destinationPage.pageId}`,
        );
      }
    }
    if (originPage) {
      originPageIndex = moveIntentFile(this.root, originPage.indexFile);
      if (
        originPageIndex === originalIndex ||
        originPageIndex === targetIndex ||
        originPageIndex === parentIndex ||
        originPageIndex === destinationPageIndex
      ) {
        throw new Error(
          "move intent origin page overlaps another participant",
        );
      }
      originPageRaw = await readOptionalFile(originPageIndex);
      const originPageRev =
        originPageRaw === null ? null : hashRev(originPageRaw);
      const originPageIsBefore =
        originPageRaw === originPage.beforeRaw &&
        originPageRev === originPage.beforeRev;
      const originPageIsAfter =
        originPageRaw === originPage.afterRaw &&
        originPageRev === originPage.afterRev;
      if (
        originPageRaw === null ||
        (!originPageIsBefore && !originPageIsAfter)
      ) {
        throw new Error(
          `move intent origin revision mismatch: ${originPage.pageId}`,
        );
      }
    }
    const [originalRaw, targetRaw] = await Promise.all([
      readOptionalFile(originalIndex),
      readOptionalFile(targetIndex),
    ]);
    if (originalRaw !== null && targetRaw !== null) {
      throw new Error(`ambiguous move intent for page ${intent.pageId}`);
    }
    if (targetRaw !== null) {
      const current = parsePage(targetRaw);
      if (current.meta.id !== intent.pageId) {
        throw new Error(`move intent target id mismatch: ${intent.pageId}`);
      }
      const nextMeta = {
        ...current.meta,
        order: intent.nextOrder,
        updated: intent.updated,
      } as PageMeta;
      await atomicWrite(targetIndex, serializePage(nextMeta, current.markdown));
      if (nest && parentIndex && parentRaw !== nest.nextParentRaw) {
        await atomicWrite(parentIndex, nest.nextParentRaw);
      }
      if (
        destinationPage &&
        destinationPageIndex &&
        destinationPageRaw !== destinationPage.afterRaw
      ) {
        await atomicWrite(destinationPageIndex, destinationPage.afterRaw);
      }
      if (
        originPage &&
        originPageIndex &&
        originPageRaw !== originPage.afterRaw
      ) {
        await atomicWrite(originPageIndex, originPage.afterRaw);
      }
      await syncDirectory(path.dirname(originalDir));
      if (path.dirname(targetDir) !== path.dirname(originalDir)) {
        await syncDirectory(path.dirname(targetDir));
      }
      await this.clearMoveIntent();
      return;
    }
    if (originalRaw !== null) {
      const current = parsePage(originalRaw);
      if (current.meta.id !== intent.pageId) {
        throw new Error(`move intent source id mismatch: ${intent.pageId}`);
      }
      if (nest && parentIndex && parentRaw !== nest.originalParentRaw) {
        await atomicWrite(parentIndex, nest.originalParentRaw);
      }
      if (
        destinationPage &&
        destinationPageIndex &&
        destinationPageRaw !== destinationPage.beforeRaw
      ) {
        await atomicWrite(destinationPageIndex, destinationPage.beforeRaw);
      }
      if (
        originPage &&
        originPageIndex &&
        originPageRaw !== originPage.beforeRaw
      ) {
        await atomicWrite(originPageIndex, originPage.beforeRaw);
      }
      try {
        await fs.rmdir(targetDir);
        await syncDirectory(path.dirname(targetDir));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.clearMoveIntent();
      return;
    }
    throw new Error(`move intent lost both page locations: ${intent.pageId}`);
  }

  /** A rename is atomic on disk but there is a tiny await boundary before the
   *  in-memory paths are swapped. A concurrent read that hits that boundary
   *  retries after the active mutation queue settles instead of surfacing a
   *  transient ENOENT as a 500. */
  private async readRaw(id: string): Promise<{ entry: Entry; raw: string }> {
    let entry = this.get(id);
    const read = (e: Entry) =>
      fs.readFile(
        assertInRoot(this.root, path.join(e.dir, "index.md")),
        "utf8",
      );
    try {
      return { entry, raw: await read(entry) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const pending = this.mutationTail;
      await pending;
      entry = this.get(id);
      return { entry, raw: await read(entry) };
    }
  }

  private get(id: string): Entry {
    const e = this.index.get(id);
    if (!e) throw new NotFoundError(id);
    return e;
  }

  private notionEntry(notionId: string): Entry | undefined {
    const pageId = this.notionIndex.get(notionId);
    return pageId ? this.index.get(pageId) : undefined;
  }

  private abortReceiptEntry(notionId: string): Entry | undefined {
    const pageId = this.abortReceiptIndex.get(notionId);
    return pageId ? this.index.get(pageId) : undefined;
  }

  /** Reconcile one entry after a no-overwrite abort rollback/race. The canonical
   * regular index is the only authority; stale in-memory Notion mappings are
   * removed before the exact visible binding is reinstalled. */
  private async refreshEntryFromCanonical(entry: Entry): Promise<void> {
    const indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
    const canonical = await readRegularTextNoFollow(indexPath);
    if (!canonical) throw new Error("notion abort canonical index is missing");
    const parsed = parsePage(canonical.text);
    const meta = {
      ...parsed.meta,
      id: parsed.meta.id || entry.meta.id,
      title: parsed.meta.title || entry.meta.title,
      order: parsed.meta.order || entry.meta.order,
      created: parsed.meta.created || entry.meta.created,
      updated: parsed.meta.updated || entry.meta.updated,
    } as PageMeta;
    if (meta.id !== entry.meta.id) {
      throw new Error("notion abort canonical page id changed");
    }
    for (const [candidateNotionId, pageId] of this.notionIndex) {
      if (pageId === entry.meta.id) this.notionIndex.delete(candidateNotionId);
    }
    for (const [candidateNotionId, pageId] of this.abortReceiptIndex) {
      if (pageId === entry.meta.id) {
        this.abortReceiptIndex.delete(candidateNotionId);
      }
    }
    entry.meta = meta;
    if (meta.notionId) {
      const notionId = normalizeNotionId(meta.notionId);
      const existing = this.notionIndex.get(notionId);
      if (existing && existing !== entry.meta.id) {
        throw new Error(`duplicate notionId after abort reconciliation: ${notionId}`);
      }
      this.notionIndex.set(notionId, entry.meta.id);
    }
    const receipt = notionAbortReceipt(meta);
    if (receipt) {
      const existing = this.abortReceiptIndex.get(receipt.notionId);
      if (existing && existing !== entry.meta.id) {
        throw new Error(
          `duplicate notion abort receipt after reconciliation: ${receipt.notionId}`,
        );
      }
      const bound = this.notionIndex.get(receipt.notionId);
      if (bound && bound !== entry.meta.id) {
        throw new Error(
          `notion abort receipt conflicts after reconciliation: ${receipt.notionId}`,
        );
      }
      this.abortReceiptIndex.set(receipt.notionId, entry.meta.id);
    }
  }

  private async abortTransactionIsReleaseSafe(entry: Entry): Promise<boolean> {
    try {
      await fs.lstat(this.moveIntentPath());
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const entries = await fs.readdir(entry.dir, { withFileTypes: true });
    if (entries.some((candidate) => candidate.name.startsWith(".brain-abort-intent-"))) {
      return false;
    }
    const canonical = await readRegularTextNoFollow(
      assertInRoot(this.root, path.join(entry.dir, "index.md")),
    );
    if (!canonical || parsePage(canonical.text).meta.id !== entry.meta.id) return false;
    await this.refreshEntryFromCanonical(entry);
    return true;
  }

  private notionStatus(entry: Entry): NotionImportStatus {
    const receipt = notionAbortReceipt(entry.meta);
    const notionId = entry.meta.notionId ?? receipt?.notionId;
    if (!notionId) {
      throw new Error(`page is not bound to Notion: ${entry.meta.id}`);
    }
    return {
      id: entry.meta.id,
      title: entry.meta.title,
      icon: entry.meta.icon,
      notionId,
      sourceHash: entry.meta.notionSourceHash,
      conversionHash: entry.meta.notionConversionHash,
      current: {
        parentId: entry.parentId,
        beforeId: this.beforeIdFor(entry),
      },
      trackedBaseline:
        entry.meta.notionTargetParentId !== undefined &&
        entry.meta.notionTargetBeforeId !== undefined &&
        entry.meta.notionTargetOrder
          ? {
              parentId: entry.meta.notionTargetParentId,
              beforeId: entry.meta.notionTargetBeforeId,
              order: entry.meta.notionTargetOrder,
            }
          : undefined,
      importing:
        entry.meta.notionImportHash && entry.meta.notionImportStarted
          ? (() => {
              const retryAfterMs = notionLeaseRemainingMs(
                entry.meta.notionImportStarted,
              );
              return {
                sourceHash: entry.meta.notionImportHash,
                started: entry.meta.notionImportStarted,
                leaseFresh: retryAfterMs > 0,
                retryAfterMs,
              };
            })()
          : undefined,
      pendingAbort: receipt
        ? {
            pageId: entry.meta.id,
            sourceHash: receipt.sourceHash,
            status: receipt.status,
            cleanup: {
              stagingRemoved: receipt.stagingRemoved,
              notionBindingRemoved: receipt.status === "detached",
              placeholderPreserved: true,
            },
          }
        : undefined,
      deleted: this.isDeleted(entry.meta.id),
    };
  }

  /** Caller owns mutate(). Refreshes the lease only after disk state and the
   *  target baseline still match the token. */
  private async renewNotionReservation(
    entry: Entry,
    sourceHash: string,
    reservationToken: string,
    src?: string,
  ): Promise<void> {
    if (this.isDeleted(entry.meta.id)) {
      throw new NotionImportConflictError(
        "page_deleted",
        `notion page is in trash: ${entry.meta.notionId ?? entry.meta.id}`,
      );
    }
    const indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
    const raw = await fs.readFile(indexPath, "utf8");
    const current = parsePage(raw);
    const loadedMeta = {
      ...current.meta,
      id: current.meta.id || entry.meta.id,
      title: current.meta.title || entry.meta.title,
      order: current.meta.order || entry.meta.order,
      created: current.meta.created || entry.meta.created,
      updated: current.meta.updated || entry.meta.updated,
    } as PageMeta;
    if (
      loadedMeta.notionImportHash !== sourceHash ||
      loadedMeta.notionImportToken !== reservationToken
    ) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `notion reservation does not match: ${loadedMeta.notionId ?? entry.meta.id}`,
      );
    }
    if (
      notionImportBaseRev(loadedMeta, current.markdown) !==
      loadedMeta.notionImportBaseRev
    ) {
      throw new NotionImportConflictError(
        "source_changed",
        `page changed after notion reservation: ${entry.meta.id}`,
      );
    }
    const atBaseline = this.notionBaselinePlacementIntact(entry, loadedMeta);
    const atDesired =
      entry.parentId === loadedMeta.notionImportParentId &&
      this.beforeIdFor(entry) === loadedMeta.notionImportBeforeId;
    if (!atBaseline && !atDesired) {
      throw new NotionImportConflictError(
        "source_changed",
        `page hierarchy changed after notion reservation: ${entry.meta.id}`,
      );
    }
    const nextMeta: PageMeta = {
      ...loadedMeta,
      notionImportStarted: now(),
    };
    const content = serializePage(nextMeta, current.markdown);
    let durabilityError: unknown;
    try {
      await atomicWrite(indexPath, content);
    } catch (error) {
      // A post-rename directory fsync failure can leave the renewed lease fully
      // visible. Keep memory aligned with that exact disk state so another token
      // cannot take over based on the expired pre-renewal timestamp.
      if (!(await fileHasExactContent(indexPath, content))) throw error;
      durabilityError = error;
    }
    entry.meta = nextMeta;
    scheduleCommit(this.root);
    if (durabilityError) throw durabilityError;
    emitStore({ type: "meta", id: entry.meta.id, src });
  }

  private notionStageDir(reservationToken: string): string {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(reservationToken)) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        "invalid notion reservation token",
      );
    }
    return assertInRoot(
      this.notionStagingRoot,
      path.join(this.notionStagingRoot, reservationToken),
    );
  }

  private async ensureNotionStagingRoot(): Promise<void> {
    const base = path.dirname(this.notionStagingRoot);
    const baseIdentity = await ensurePrivateOwnedDirectory(base);
    await ensurePrivateOwnedDirectory(this.notionStagingRoot);
    await assertPrivateOwnedDirectory(base, baseIdentity);
  }

  private async ensureNotionStageDirectory(
    reservationToken: string,
  ): Promise<{ dir: string; identity: DirectoryIdentity }> {
    await this.ensureNotionStagingRoot();
    const rootIdentity = await assertPrivateOwnedDirectory(
      this.notionStagingRoot,
    );
    const dir = this.notionStageDir(reservationToken);
    const identity = await ensurePrivateOwnedDirectory(dir);
    await assertPrivateOwnedDirectory(this.notionStagingRoot, rootIdentity);
    return { dir, identity };
  }

  private async stageNotionAttachment(
    reservationToken: string,
    input: NotionAttachmentInput,
  ): Promise<SavedAttachment> {
    // Notion may contain HTML/JS/XML downloads. They are preserved only in the
    // importer path and receive a .bin canonical name, so media serves them as
    // octet-stream + attachment + nosniff instead of active same-origin data.
    const mimeType = validateAttachment(input, { allowActive: true });
    const displayName = normalizeAttachmentDisplayName(input.originalName);
    const extension = canonicalAttachmentExtension(displayName, mimeType);
    const contentHash = createHash("sha256").update(input.data).digest("hex");
    const expectedSha256 = input.expectedSha256.toLowerCase();
    if (!SOURCE_HASH_RE.test(expectedSha256) || contentHash !== expectedSha256) {
      throw new AttachmentValidationError(
        "hash_mismatch",
        "notion attachment bytes do not match expectedSha256",
      );
    }
    const savedName = `${contentHash}${extension}`;
    const { dir, identity: stageIdentity } =
      await this.ensureNotionStageDirectory(reservationToken);
    const file = assertInRoot(dir, path.join(dir, savedName));
    // The Store mutation queue serializes cleanup, accounting, and the write,
    // so concurrent reservations cannot both observe the same remaining quota.
    await this.reconcileNotionStaging();
    const existing = await regularFileDigestNoFollow(file);
    if (existing) {
      if (existing.sha256 !== contentHash) {
        throw new Error("staged attachment hash mismatch");
      }
    } else {
      try {
        await fs.lstat(file);
        throw new Error("staged attachment is not a stable regular file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const reservationUsage = await this.scanNotionStageDirectory(dir);
      if (reservationUsage.files >= MAX_NOTION_STAGE_FILES) {
        throw new AttachmentValidationError(
          "quota_exceeded",
          `notion reservation exceeds ${MAX_NOTION_STAGE_FILES} staged files`,
        );
      }
      if (
        reservationUsage.bytes + input.data.byteLength >
        MAX_NOTION_STAGE_BYTES
      ) {
        throw new AttachmentValidationError(
          "quota_exceeded",
          `notion reservation exceeds ${MAX_NOTION_STAGE_BYTES} staged bytes`,
        );
      }
      const globalUsage = await this.scanNotionStagingUsage();
      if (globalUsage.files + 1 > this.notionStagingLimits.maxFiles) {
        throw new AttachmentValidationError(
          "quota_exceeded",
          `notion staging exceeds ${this.notionStagingLimits.maxFiles} total files`,
        );
      }
      if (
        globalUsage.bytes + input.data.byteLength >
        this.notionStagingLimits.maxBytes
      ) {
        throw new AttachmentValidationError(
          "quota_exceeded",
          `notion staging exceeds ${this.notionStagingLimits.maxBytes} total bytes`,
        );
      }
      const disk = await fs.statfs(dir);
      const freeBytes = disk.bavail * disk.bsize;
      if (
        freeBytes - input.data.byteLength <
        this.notionStagingLimits.minFreeBytes
      ) {
        throw new AttachmentValidationError(
          "quota_exceeded",
          "not enough disk headroom for notion attachment staging",
        );
      }
      await atomicWrite(file, input.data);
      await assertPrivateOwnedDirectory(dir, stageIdentity);
    }
    return {
      url: `/_attachments-v2/${savedName}`,
      name: displayName,
      size: input.data.byteLength,
      type: mimeType,
    };
  }

  /** Copy only files referenced by the finalized Markdown into the canonical
   *  notes tree. Staged extras remain ephemeral and are removed after success. */
  private async promoteNotionAttachments(
    reservationToken: string,
    markdown: string,
    extraUrls: Array<string | undefined> = [],
  ): Promise<void> {
    const names = referencedAttachmentNames(markdown);
    for (const url of extraUrls) {
      if (!url) continue;
      const name = localAttachmentName(url);
      if (name) names.add(name);
    }
    if (names.size === 0) return;
    const stageDir = this.notionStageDir(reservationToken);
    await assertPrivateOwnedDirectory(stageDir).catch(rethrowStagingFailure);
    const attachmentDir = assertInRoot(
      this.root,
      path.join(this.root, "_attachments"),
    );
    const attachmentIdentity = await ensureRealDirectory(attachmentDir).catch(
      rethrowAttachmentStoreFailure,
    );
    const plan: Array<{
      canonical: string;
      staged: string;
      expectedHash: string;
      size: number;
    }> = [];
    for (const name of names) {
      const expectedHash = name.split(".", 1)[0];
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
        throw new NotionImportConflictError(
          "missing_attachment",
          "notion attachment is not content-addressed",
        );
      }
      const canonical = assertInRoot(
        attachmentDir,
        path.join(attachmentDir, name),
      );
      const canonicalDigest = await regularFileDigestNoFollow(canonical).catch(
        rethrowAttachmentStoreFailure,
      );
      const canonicalHealthy = canonicalDigest?.sha256 === expectedHash;
      if (canonicalHealthy) continue;
      const staged = assertInRoot(stageDir, path.join(stageDir, name));
      const stagedDigest = await regularFileDigestNoFollow(staged).catch(
        rethrowStagingFailure,
      );
      if (!stagedDigest) {
        throw new NotionImportConflictError(
          "missing_attachment",
          "attachment was not uploaded for this reservation",
        );
      }
      if (stagedDigest.sha256 !== expectedHash) {
        throw new NotionImportConflictError(
          "missing_attachment",
          "attachment content hash mismatch",
        );
      }
      plan.push({ canonical, staged, expectedHash, size: stagedDigest.size });
    }
    if (plan.length === 0) return;
    const disk = await fs.statfs(attachmentDir).catch(
      rethrowAttachmentStoreFailure,
    );
    const promotionBytes = plan.reduce(
      (total, item) => total + item.size,
      0,
    );
    if (
      disk.bavail * disk.bsize - promotionBytes <
      this.notionStagingLimits.minFreeBytes
    ) {
      throw new AttachmentValidationError(
        "quota_exceeded",
        "not enough disk headroom to promote notion attachments",
      );
    }
    for (const item of plan) {
      await atomicCopyFileVerified(
        item.staged,
        item.canonical,
        item.expectedHash,
        attachmentIdentity,
      ).catch(rethrowAttachmentStoreFailure);
    }
    await assertRealDirectory(attachmentDir, attachmentIdentity).catch(
      rethrowAttachmentStoreFailure,
    );
  }

  private async canonicalAttachmentsHealthy(
    markdown: string,
    extraUrls: Array<string | undefined> = [],
  ): Promise<boolean> {
    const attachmentDir = assertInRoot(
      this.root,
      path.join(this.root, "_attachments"),
    );
    const names = referencedAttachmentNames(markdown);
    for (const url of extraUrls) {
      if (!url) continue;
      const name = localAttachmentName(url);
      if (name) names.add(name);
    }
    if (names.size === 0) return true;
    let attachmentIdentity: DirectoryIdentity;
    try {
      attachmentIdentity = await assertRealDirectory(attachmentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      rethrowAttachmentStoreFailure(error);
    }
    for (const name of names) {
      const expectedHash = name.split(".", 1)[0];
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
      const digest = await regularFileDigestNoFollow(
        assertInRoot(attachmentDir, path.join(attachmentDir, name)),
      );
      if (digest?.sha256 !== expectedHash) return false;
    }
    await assertRealDirectory(attachmentDir, attachmentIdentity).catch(
      rethrowAttachmentStoreFailure,
    );
    return true;
  }

  private async removeNotionStaging(reservationToken: string): Promise<void> {
    try {
      await this.ensureNotionStagingRoot();
      const dir = this.notionStageDir(reservationToken);
      try {
        await assertPrivateOwnedDirectory(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await fs.rm(dir, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      rethrowStagingFailure(error);
    }
  }

  private async tryRemoveNotionStaging(
    reservationToken: string,
  ): Promise<boolean> {
    try {
      await this.removeNotionStaging(reservationToken);
      return true;
    } catch {
      return false;
    }
  }

  private assertNotionCleanupTokenUnowned(
    reservationToken: string,
    finalizedPageId: string,
  ): void {
    const owner = [...this.index.values()].find(
      (candidate) => candidate.meta.notionImportToken === reservationToken,
    );
    if (owner && owner.meta.id !== finalizedPageId) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        "notion reservation token belongs to another page",
      );
    }
  }

  /** Remove orphan/stale staging while leaving the reservation frontmatter in
   *  place. A stale owner can therefore resume with the same journal token and
   *  re-upload, or a new token can take over through the normal reserve path. */
  private async reconcileNotionStaging(): Promise<void> {
    await this.ensureNotionStagingRoot();
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.notionStagingRoot, {
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const activeTokens = new Map<string, boolean>();
    const timestamp = Date.now();
    for (const entry of this.index.values()) {
      const token = entry.meta.notionImportToken;
      if (!token) continue;
      normalizeReservationToken(token);
      if (activeTokens.has(token)) {
        throw new Error("duplicate notion reservation token");
      }
      activeTokens.set(
        token,
        isNotionLeaseFresh(entry.meta.notionImportStarted, timestamp),
      );
    }
    for (const entry of entries) {
      const dir = assertInRoot(
        this.notionStagingRoot,
        path.join(this.notionStagingRoot, entry.name),
      );
      if (activeTokens.get(entry.name) === true) {
        if (!entry.isDirectory()) {
          throw new Error("active notion staging entry is not a directory");
        }
        await assertPrivateOwnedDirectory(dir);
      } else {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  }

  /** Fail closed on nested directories, symlinks, sockets, or disappearing
   *  entries. Only regular staged files participate in quota accounting. */
  private async scanNotionStageDirectory(
    dir: string,
  ): Promise<{ files: number; bytes: number }> {
    const identity = await assertPrivateOwnedDirectory(dir);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error("unexpected notion staging entry");
      }
      const digest = await regularFileDigestNoFollow(
        assertInRoot(dir, path.join(dir, entry.name)),
      );
      if (!digest) {
        throw new Error("unexpected notion staging entry");
      }
      bytes += digest.size;
    }
    await assertPrivateOwnedDirectory(dir, identity);
    return { files: entries.length, bytes };
  }

  private async scanNotionStagingUsage(): Promise<{
    files: number;
    bytes: number;
  }> {
    await this.ensureNotionStagingRoot();
    const rootIdentity = await assertPrivateOwnedDirectory(
      this.notionStagingRoot,
    );
    const entries = await fs.readdir(this.notionStagingRoot, {
      withFileTypes: true,
    });
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        throw new Error("unexpected notion staging entry");
      }
      await assertPrivateOwnedDirectory(
        assertInRoot(
          this.notionStagingRoot,
          path.join(this.notionStagingRoot, entry.name),
        ),
      );
      const usage = await this.scanNotionStageDirectory(
        assertInRoot(
          this.notionStagingRoot,
          path.join(this.notionStagingRoot, entry.name),
        ),
      );
      files += usage.files;
      bytes += usage.bytes;
    }
    await assertPrivateOwnedDirectory(this.notionStagingRoot, rootIdentity);
    return { files, bytes };
  }

  private siblings(parentId: string | null): Entry[] {
    return [...this.index.values()]
      .filter((e) => e.parentId === parentId && !e.meta.deleted)
      .sort((a, b) => byOrder(a.meta.order, b.meta.order));
  }

  private beforeIdFor(entry: Entry): string | null {
    const siblings = this.siblings(entry.parentId);
    const index = siblings.findIndex((candidate) => candidate.meta.id === entry.meta.id);
    return index >= 0 ? siblings[index + 1]?.meta.id ?? null : null;
  }

  /** Import pass one may append more fresh placeholders after this entry. They
   *  are an importer-owned extension of the original slot, not a manual
   *  hierarchy edit. All ordinary intervening pages still invalidate the base. */
  private notionBaselinePlacementIntact(
    entry: Entry,
    meta: PageMeta,
  ): boolean {
    if (
      entry.parentId !== meta.notionImportBaseParentId ||
      meta.order !== meta.notionImportBaseOrder
    ) {
      return false;
    }
    const baselineBeforeId = meta.notionImportBaseBeforeId;
    if (this.beforeIdFor(entry) === baselineBeforeId) return true;
    const siblings = this.siblings(entry.parentId);
    const entryIndex = siblings.findIndex(
      (candidate) => candidate.meta.id === entry.meta.id,
    );
    const boundaryIndex = baselineBeforeId
      ? siblings.findIndex((candidate) => candidate.meta.id === baselineBeforeId)
      : siblings.length;
    if (entryIndex < 0 || boundaryIndex <= entryIndex) return false;
    const intervening = siblings.slice(entryIndex + 1, boundaryIndex);
    return (
      intervening.length > 0 &&
      intervening.every(
        (candidate) =>
          candidate.meta.notionImportCreated === true &&
          Boolean(candidate.meta.notionImportHash) &&
          Boolean(candidate.meta.notionImportToken),
      )
    );
  }

  private orderForPlacement(
    parentId: string | null,
    beforeId: string | null,
    excludeId?: string,
  ): string {
    const siblings = this.siblings(parentId).filter(
      (candidate) => candidate.meta.id !== excludeId,
    );
    const index = beforeId
      ? siblings.findIndex((candidate) => candidate.meta.id === beforeId)
      : siblings.length;
    if (beforeId && index < 0) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `before page is not an active sibling: ${beforeId}`,
      );
    }
    const previous = index > 0 ? siblings[index - 1] : null;
    const next = index < siblings.length ? siblings[index] : null;
    return generateKeyBetween(
      previous ? previous.meta.order : null,
      next ? next.meta.order : null,
    );
  }

  /** Validate a desired import slot without requiring the next sibling to have
   *  moved there yet. Pass two can therefore reserve a whole cross-parent
   *  reorder; finalize still enforces next-sibling-first before the real move. */
  private validateNotionPlacement(
    parentId: string | null,
    beforeId: string | null,
    excludeId?: string,
  ): boolean {
    if (!beforeId) return false;
    if (beforeId === excludeId) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        "a notion page cannot be placed before itself",
      );
    }
    const before = this.get(beforeId);
    if (this.isDeleted(beforeId)) {
      throw new NotionImportConflictError(
        "page_deleted",
        `next notion sibling is in trash: ${beforeId}`,
      );
    }
    const futureParent =
      before.meta.notionImportHash &&
      before.meta.notionImportParentId !== undefined
        ? before.meta.notionImportParentId
        : before.parentId;
    if (futureParent !== parentId) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `before page is not reserved for the target parent: ${beforeId}`,
      );
    }
    return before.parentId === parentId;
  }

  // ── public API ──────────────────────────────────────────────

  resolve(id: string): string {
    return assertInRoot(this.root, this.get(id).dir);
  }

  /** Deep production readiness check. It runs through the same mutation queue
   *  as page writes, verifies the Git-backed source of truth, and performs a
   *  durable write/read/unlink cycle without creating a note or Git commit. */
  async readiness(): Promise<void> {
    return this.mutate(async () => {
      await assertGitReady(this.root);
      await assertGitSnapshotHealthy(this.root);
      const probe = assertInRoot(
        this.root,
        path.join(
          /* turbopackIgnore: true */ this.root,
          `.brain-readiness-${process.pid}-${nanoid(12)}`,
        ),
      );
      const expected = `brain-readiness ${now()}\n`;
      let written = false;
      try {
        await atomicWrite(probe, expected);
        written = true;
        const actual = await fs.readFile(probe, "utf8");
        if (actual !== expected) throw new Error("readiness probe mismatch");
      } finally {
        if (written) {
          await fs.rm(probe);
          await syncDirectory(this.root);
        } else {
          await fs.rm(probe, { force: true }).catch(() => undefined);
        }
      }
    });
  }

  readDirectChildren(
    parentId: string,
  ): readonly Readonly<{ id: string; title: string; icon?: string }>[] {
    this.get(parentId);
    return Object.freeze(
      this.siblings(parentId)
        .filter((entry) => !entry.meta.collectionRow)
        .map((entry) =>
          Object.freeze({
            id: entry.meta.id,
            title: entry.meta.title,
            ...(entry.meta.icon === undefined
              ? {}
              : { icon: entry.meta.icon }),
          }),
        ),
    );
  }

  getTree(): TreeNode[] {
    const build = (parentId: string | null): TreeNode[] =>
      this.siblings(parentId).map((e) => {
        const children = build(e.meta.id);
        return {
          id: e.meta.id,
          parentId,
          title: e.meta.title,
          icon: e.meta.icon,
          cover: e.meta.cover,
          order: e.meta.order,
          public: e.meta.public,
          shareLocked: e.meta.sharePass ? true : undefined,
          shareExpiresAt: e.meta.shareExpiresAt,
          category: e.meta.category,
          pinned: e.meta.pinned,
          created: e.meta.created,
          updated: e.meta.updated,
          updatedBy: e.meta.updatedBy,
          status: e.meta.status,
          tags: e.meta.tags,
          view: e.meta.view,
          font: e.meta.font,
          smallText: e.meta.smallText,
          fullWidth: e.meta.fullWidth,
          sections: e.meta.sections,
          notionId: e.meta.notionId,
          collection: e.meta.collection,
          collectionRow: e.meta.collectionRow,
          hasChildren: children.length > 0,
          children,
        };
      });
    return build(null);
  }

  /** True when this page or any ancestor is soft-deleted. Shared routes use
   *  this in addition to public metadata so old/partial trash state stays safe. */
  isDeleted(id: string): boolean {
    let current: Entry | undefined = this.get(id);
    while (current) {
      if (current.meta.deleted) return true;
      current = current.parentId ? this.index.get(current.parentId) : undefined;
    }
    return false;
  }

  /** Read-only ancestry check for public surfaces. The root contains itself.
   * Missing ids fail closed instead of exposing Store internals or throwing
   * different errors to a public caller. */
  isWithinSubtree(rootId: string, targetId: string): boolean {
    if (!this.index.has(rootId)) return false;
    let current = this.index.get(targetId);
    const seen = new Set<string>();
    while (current && !seen.has(current.meta.id)) {
      if (current.meta.id === rootId) return true;
      seen.add(current.meta.id);
      current = current.parentId
        ? this.index.get(current.parentId)
        : undefined;
    }
    return false;
  }

  private shareScopeSnapshot(id: string): ShareScopeSnapshot {
    const root = this.get(id);
    if (this.isDeleted(id)) throw new NotFoundError(id);
    const descendants = [...this.index.values()]
      .filter(
        (entry) =>
          entry.meta.id !== id &&
          this.isWithinSubtree(id, entry.meta.id) &&
          !this.isDeleted(entry.meta.id),
      )
      .map((entry) => `${entry.meta.id}:${entry.parentId ?? ""}`)
      .sort();
    const overlappingRoots = [...this.index.values()]
      .filter(
        (entry) =>
          entry.meta.id !== id &&
          !!entry.meta.public &&
          (this.isWithinSubtree(entry.meta.id, id) ||
            this.isWithinSubtree(id, entry.meta.id)),
      )
      .map((entry) => ({
        rootId: entry.meta.id,
        title: entry.meta.title,
        relation: (this.isWithinSubtree(entry.meta.id, id)
          ? "ancestor"
          : "descendant") as "ancestor" | "descendant",
        shareExpiresAt:
          typeof entry.meta.shareExpiresAt === "string"
            ? entry.meta.shareExpiresAt
            : null,
      }))
      .sort((a, b) => {
        if (a.relation !== b.relation) {
          return a.relation === "ancestor" ? -1 : 1;
        }
        return a.rootId < b.rootId ? -1 : a.rootId > b.rootId ? 1 : 0;
      });
    const scopeToken = createHash("sha256")
      .update(
        JSON.stringify({
          rootId: id,
          descendants,
          overlappingRoots,
          public: !!root.meta.public,
          sharePass: root.meta.sharePass ?? null,
          shareExpiresAt: root.meta.shareExpiresAt ?? null,
          shareVersion: root.meta.shareVersion ?? 0,
        }),
      )
      .digest("hex");
    return {
      rootId: id,
      descendantCount: descendants.length,
      overlappingRoots,
      scopeToken,
      public: !!root.meta.public,
      shareLocked: !!root.meta.sharePass,
      shareExpiresAt: root.meta.shareExpiresAt ?? null,
      shareVersion: root.meta.shareVersion ?? 0,
    };
  }

  /** Stable owner disclosure read. A synchronous snapshot bracketed by the
   * seqlock cannot overlap an in-flight writer; queued writers may proceed
   * afterward and are detected by configureShare's token check. */
  async readShareScope(id: string): Promise<ShareScopeSnapshot> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const before = this.readMutationState();
      if (before.active) {
        await this.waitForMutationIdle(250);
        continue;
      }
      const snapshot = this.shareScopeSnapshot(id);
      const after = this.readMutationState();
      if (!after.active && after.generation === before.generation) {
        return snapshot;
      }
    }
    throw new Error("share scope is busy");
  }

  async readPage(id: string): Promise<Page> {
    const { entry, raw } = await this.readRaw(id);
    const { meta: fresh, markdown } = parsePage(raw);
    // Do not assign disk state back into the shared Entry from a read. A read
    // can overlap an updateMeta() await and would otherwise clobber its pending
    // in-memory patch with the previous on-disk metadata.
    const meta = {
      ...fresh,
      id: fresh.id || entry.meta.id,
      title: fresh.title || entry.meta.title,
      order: fresh.order || entry.meta.order,
      created: fresh.created || entry.meta.created,
      updated: fresh.updated || entry.meta.updated,
    } as PageMeta;
    return { meta, markdown, rev: hashRev(raw) };
  }

  /** Return the one page bound to a Notion id without exposing reservation
   *  tokens or unrelated private metadata. */
  findNotionPage(rawNotionId: string): NotionImportStatus | null {
    const notionId = normalizeNotionId(rawNotionId);
    const entry =
      this.notionEntry(notionId) ?? this.abortReceiptEntry(notionId);
    return entry ? this.notionStatus(entry) : null;
  }

  /** Read the page and calculate import-baseline integrity without exposing
   * reservation ownership. The importer uses this for a complete destination
   * preflight before it issues any mutating reserve request. */
  async inspectNotionPage(
    rawNotionId: string,
    candidateReservationToken?: string,
  ): Promise<NotionImportStatus | null> {
    const notionId = normalizeNotionId(rawNotionId);
    const indexed =
      this.notionEntry(notionId) ?? this.abortReceiptEntry(notionId);
    if (!indexed) return null;
    const { entry, raw } = await this.readRaw(indexed.meta.id);
    const current = parsePage(raw);
    const loadedMeta = {
      ...current.meta,
      id: current.meta.id || entry.meta.id,
      title: current.meta.title || entry.meta.title,
      order: current.meta.order || entry.meta.order,
      created: current.meta.created || entry.meta.created,
      updated: current.meta.updated || entry.meta.updated,
    } as PageMeta;
    const snapshot: Entry = { ...entry, meta: loadedMeta };
    const status = this.notionStatus(snapshot);
    const currentTargetRev = notionImportBaseRev(loadedMeta, current.markdown);
    const trackedTargetIntact = loadedMeta.notionSourceHash
      ? Boolean(
          loadedMeta.notionTargetRev &&
            loadedMeta.notionTargetParentId !== undefined &&
            loadedMeta.notionTargetBeforeId !== undefined &&
            loadedMeta.notionTargetOrder &&
            currentTargetRev === loadedMeta.notionTargetRev &&
            entry.parentId === loadedMeta.notionTargetParentId &&
            this.beforeIdFor(entry) === loadedMeta.notionTargetBeforeId &&
            loadedMeta.order === loadedMeta.notionTargetOrder,
        )
      : undefined;
    const trackedAttachmentIntact = loadedMeta.notionSourceHash
      ? await this.canonicalAttachmentsHealthy(current.markdown, [
          loadedMeta.cover,
        ])
      : undefined;
    const importBaselineIntact = loadedMeta.notionImportHash
      ? Boolean(
          loadedMeta.notionImportBaseRev &&
            currentTargetRev === loadedMeta.notionImportBaseRev &&
            (this.notionBaselinePlacementIntact(entry, loadedMeta) ||
              (entry.parentId === loadedMeta.notionImportParentId &&
                this.beforeIdFor(entry) === loadedMeta.notionImportBeforeId)),
        )
      : undefined;
    const receipt = notionAbortReceipt(loadedMeta);
    const abortBaselineIntact = receipt
      ? Boolean(
          loadedMeta.notionTargetRev &&
            loadedMeta.notionTargetParentId !== undefined &&
            loadedMeta.notionTargetBeforeId !== undefined &&
            loadedMeta.notionTargetOrder &&
            currentTargetRev === loadedMeta.notionTargetRev &&
            entry.parentId === loadedMeta.notionTargetParentId &&
            this.beforeIdFor(entry) === loadedMeta.notionTargetBeforeId &&
            loadedMeta.order === loadedMeta.notionTargetOrder,
        )
      : undefined;
    const normalizedCandidate = candidateReservationToken
      ? normalizeReservationToken(candidateReservationToken)
      : undefined;
    const reservationOwned = loadedMeta.notionImportHash
      ? Boolean(
          normalizedCandidate &&
            loadedMeta.notionImportToken &&
            reservationTokenMatches(
              normalizedCandidate,
              loadedMeta.notionImportToken,
            ),
        )
      : receipt
        ? Boolean(
            normalizedCandidate &&
              reservationTokenHashMatches(
                normalizedCandidate,
                receipt.tokenSha256,
              ),
          )
        : undefined;
    return {
      ...status,
      integrity: {
        trackedTargetIntact,
        trackedAttachmentIntact,
        importBaselineIntact,
        abortBaselineIntact,
        reservationOwned,
      },
    };
  }

  /** Inspect one explicitly selected Brain page as a preserve/adopt candidate.
   * This returns only identity, revision, placement, and coarse binding state.
   * Bodies, titles, order keys, and reservation capabilities never cross this
   * boundary. */
  async inspectNotionCandidate(
    pageId: string,
  ): Promise<NotionCandidateBaseline> {
    const { entry, raw } = await this.readRaw(pageId);
    const current = parsePage(raw);
    const loadedMeta = {
      ...current.meta,
      id: current.meta.id || entry.meta.id,
      title: current.meta.title || entry.meta.title,
      order: current.meta.order || entry.meta.order,
      created: current.meta.created || entry.meta.created,
      updated: current.meta.updated || entry.meta.updated,
    } as PageMeta;
    const receipt = notionAbortReceipt(loadedMeta);
    const hasReservationState = NOTION_IMPORT_META_FIELDS.slice(7).some(
      (field) => loadedMeta[field] !== undefined,
    );
    const hasNonIdImportState = NOTION_IMPORT_META_FIELDS.slice(1).some(
      (field) => loadedMeta[field] !== undefined,
    );
    const notionId = receipt?.notionId ?? normalizeOptionalNotionId(loadedMeta.notionId);
    const hasTrackedBaseline = Boolean(
      notionId &&
        loadedMeta.notionSourceHash &&
        loadedMeta.notionConversionHash &&
        loadedMeta.notionTargetRev &&
        loadedMeta.notionTargetParentId !== undefined &&
        loadedMeta.notionTargetBeforeId !== undefined &&
        loadedMeta.notionTargetOrder,
    );
    const bindingState: NotionCandidateBaseline["bindingState"] = receipt
      ? "abort_pending"
      : hasReservationState
        ? "import_pending"
        : notionId
          ? hasTrackedBaseline
            ? "tracked"
            : "bound_untracked"
          : NOTION_IMPORT_META_FIELDS.some(
                (field) => loadedMeta[field] !== undefined,
              )
            ? "bound_untracked"
            : "unbound";
    let trackedTargetIntact: boolean | undefined;
    let trackedAttachmentIntact: boolean | undefined;
    const legacyBindingUpgradeable = Boolean(
      bindingState === "bound_untracked" &&
        notionId &&
        !hasNonIdImportState &&
        !receipt,
    );
    if (bindingState === "tracked") {
      const currentTargetRev = notionImportBaseRev(loadedMeta, current.markdown);
      trackedTargetIntact = Boolean(
        loadedMeta.notionTargetRev === currentTargetRev &&
          entry.parentId === loadedMeta.notionTargetParentId &&
          this.beforeIdFor(entry) === loadedMeta.notionTargetBeforeId &&
          loadedMeta.order === loadedMeta.notionTargetOrder,
      );
      trackedAttachmentIntact = await this.canonicalAttachmentsHealthy(
        current.markdown,
        [loadedMeta.cover],
      );
    }
    return {
      id: loadedMeta.id,
      rev: hashRev(raw),
      current: {
        parentId: entry.parentId,
        beforeId: this.beforeIdFor(entry),
      },
      deleted: this.isDeleted(entry.meta.id),
      bindingState,
      notionId,
      sourceHash: loadedMeta.notionSourceHash,
      conversionHash: loadedMeta.notionConversionHash,
      trackedTargetIntact,
      trackedAttachmentIntact,
      legacyBindingUpgradeable,
    };
  }

  /** Explicitly bind a reviewed existing Brain page to a Notion source.
   *  Adoption never changes visible content or hierarchy and is guarded by the
   *  raw page rev plus a server-verifiable conversion hash. */
  async adoptNotionImport(
    input: AdoptNotionImportInput,
  ): Promise<AdoptNotionImportResult> {
    return this.mutate(async () => {
      const notionId = normalizeNotionId(input.notionId);
      const sourceHash = normalizeSourceHash(input.sourceHash);
      const conversionHash = normalizeSourceHash(input.conversionHash);
      const entry = this.get(input.pageId);
      if (this.abortReceiptEntry(notionId)) {
        throw new NotionImportConflictError(
          "abort_ack_required",
          `Notion abort must be acknowledged before adoption: ${notionId}`,
        );
      }
      if (this.isDeleted(entry.meta.id)) {
        throw new NotionImportConflictError(
          "page_deleted",
          `cannot adopt a page in trash: ${entry.meta.id}`,
        );
      }
      const alreadyBound = this.notionIndex.get(notionId);
      if (alreadyBound && alreadyBound !== entry.meta.id) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          `notion page is already bound to another Brain page: ${notionId}`,
        );
      }
      if (
        entry.meta.notionId &&
        normalizeNotionId(entry.meta.notionId) !== notionId
      ) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          `Brain page is already bound to another Notion page: ${entry.meta.id}`,
        );
      }
      const indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
      const raw = await fs.readFile(indexPath, "utf8");
      const currentRev = hashRev(raw);
      if (
        entry.parentId !== input.expectedParentId ||
        this.beforeIdFor(entry) !== input.expectedBeforeId
      ) {
        throw new NotionImportConflictError(
          "source_changed",
          `page hierarchy changed before adoption: ${entry.meta.id}`,
        );
      }
      const current = parsePage(raw);
      const loadedMeta = {
        ...current.meta,
        id: current.meta.id || entry.meta.id,
        title: current.meta.title || entry.meta.title,
        order: current.meta.order || entry.meta.order,
        created: current.meta.created || entry.meta.created,
        updated: current.meta.updated || entry.meta.updated,
      } as PageMeta;
      if (notionAbortReceipt(loadedMeta)) {
        throw new NotionImportConflictError(
          "abort_ack_required",
          `Brain page has an unacknowledged Notion abort: ${entry.meta.id}`,
        );
      }
      const alreadyExact =
        loadedMeta.notionId !== undefined &&
        normalizeNotionId(loadedMeta.notionId) === notionId &&
        loadedMeta.notionSourceHash === sourceHash &&
        loadedMeta.notionConversionHash === conversionHash &&
        !loadedMeta.notionImportHash &&
        loadedMeta.notionTargetRev ===
          notionImportBaseRev(loadedMeta, current.markdown) &&
        loadedMeta.notionTargetParentId === entry.parentId &&
        loadedMeta.notionTargetBeforeId === this.beforeIdFor(entry) &&
        loadedMeta.notionTargetOrder === loadedMeta.order;
      if (alreadyExact) {
        entry.meta = loadedMeta;
        this.notionIndex.set(notionId, entry.meta.id);
        return {
          status: "adopted",
          page: this.notionStatus(entry),
          rev: currentRev,
        };
      }
      if (currentRev !== input.expectedRev) {
        throw new RevConflictError(currentRev, input.expectedRev);
      }
      const legacyBindingUpgradeable = Boolean(
        loadedMeta.notionId &&
          normalizeNotionId(loadedMeta.notionId) === notionId &&
          NOTION_IMPORT_META_FIELDS.slice(1).every(
            (field) => loadedMeta[field] === undefined,
          ),
      );
      if (
        NOTION_IMPORT_META_FIELDS.some(
          (field) => loadedMeta[field] !== undefined,
        ) &&
        !legacyBindingUpgradeable
      ) {
        throw new NotionImportConflictError(
          "already_imported",
          `Brain page already has Notion import state: ${entry.meta.id}`,
        );
      }
      assertNotionIconCompatible(loadedMeta.icon);
      assertNotionCoverCompatible(loadedMeta.cover);
      const canonicalMarkdown = parsePage(
        serializePage(loadedMeta, current.markdown),
      ).markdown;
      const expectedConversionHash = notionConversionHash({
        sourceHash,
        parentId: entry.parentId,
        beforeId: this.beforeIdFor(entry),
        title: loadedMeta.title,
        icon: loadedMeta.icon,
        cover: loadedMeta.cover,
        markdown: canonicalMarkdown,
        collection: loadedMeta.collection,
        collectionRow: loadedMeta.collectionRow,
      });
      if (conversionHash !== expectedConversionHash) {
        throw new NotionImportConflictError(
          "conversion_mismatch",
          "conversion hash does not match the existing Brain target",
        );
      }
      const nextMeta: PageMeta = {
        ...loadedMeta,
        notionId,
        notionSourceHash: sourceHash,
        notionConversionHash: conversionHash,
        notionTargetRev: notionImportBaseRev(loadedMeta, canonicalMarkdown),
        notionTargetParentId: entry.parentId,
        notionTargetBeforeId: this.beforeIdFor(entry),
        notionTargetOrder: loadedMeta.order,
      };
      const content = serializePage(nextMeta, canonicalMarkdown);
      let durabilityError: unknown;
      try {
        await atomicWrite(indexPath, content);
      } catch (error) {
        if (!(await fileHasExactContent(indexPath, content))) throw error;
        durabilityError = error;
      }
      entry.meta = nextMeta;
      this.notionIndex.set(notionId, entry.meta.id);
      scheduleCommit(this.root);
      const rev = hashRev(content);
      emitStore({ type: "meta", id: entry.meta.id });
      if (durabilityError) throw durabilityError;
      return {
        status: "adopted",
        page: this.notionStatus(entry),
        rev,
      };
    });
  }

  /** Atomically find-or-create a placeholder and reserve its next source
   *  version. This is phase one of the importer: every page id can be mapped
   *  before any body is written, so internal links never need a root fallback. */
  async reserveNotionImport(
    input: ReserveNotionImportInput,
  ): Promise<ReserveNotionImportResult> {
    return this.mutate(async () => {
      const notionId = normalizeNotionId(input.notionId);
      const sourceHash = normalizeSourceHash(input.sourceHash);
      const conversionHash = input.conversionHash
        ? normalizeSourceHash(input.conversionHash)
        : undefined;
      if (input.parentId === undefined || input.beforeId === undefined) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          "parentId and beforeId must be explicit (null is allowed)",
        );
      }
      assertNotionPlacementId(input.parentId, "parentId");
      assertNotionPlacementId(input.beforeId, "beforeId");
      const reservationToken = normalizeReservationToken(
        input.reservationToken,
      );
      const provisionalIcon = input.icon || undefined;
      const provisionalCover = input.cover || undefined;
      assertNotionIconCompatible(provisionalIcon);
      assertNotionCoverCompatible(provisionalCover);
      const desiredBeforeId = input.beforeId;
      const receiptEntry = this.abortReceiptEntry(notionId);
      if (receiptEntry) {
        return this.reserveAfterAcknowledgedAbort(
          receiptEntry,
          input,
          notionId,
          sourceHash,
          reservationToken,
        );
      }
      let entry = this.notionEntry(notionId);
      let created = false;

      if (!entry) {
        if (input.parentId) {
          this.get(input.parentId);
          if (this.isDeleted(input.parentId)) {
            throw new NotionImportConflictError(
              "page_deleted",
              `notion parent is in trash: ${input.parentId}`,
            );
          }
        }
        const parentDir = input.parentId
          ? this.get(input.parentId).dir
          : this.root;
        const title = input.title.trim() || "Untitled";
        const beforeIsCurrent = this.validateNotionPlacement(
          input.parentId,
          desiredBeforeId,
        );
        const order = this.orderForPlacement(
          input.parentId,
          beforeIsCurrent ? desiredBeforeId : null,
        );
        const dir = await uniqueDir(parentDir, slugify(title));
        const started = now();
        const token = reservationToken;
        if (
          [...this.index.values()].some(
            (candidate) => candidate.meta.notionImportToken === token,
          )
        ) {
          throw new NotionImportConflictError(
            "reservation_mismatch",
            "notion reservation token is already active",
          );
        }
        const meta: PageMeta = {
          id: nanoid(),
          title,
          icon: provisionalIcon,
          cover: provisionalCover,
          order,
          created: started,
          updated: started,
          updatedBy: "claude",
          notionId,
          notionImportHash: sourceHash,
          notionImportToken: token,
          notionImportStarted: started,
          notionImportCreated: true,
          notionImportOwnedCover: provisionalCover,
          notionImportParentId: input.parentId,
          notionImportBeforeId: desiredBeforeId,
          notionImportBaseParentId: input.parentId,
          notionImportBaseBeforeId: beforeIsCurrent ? desiredBeforeId : null,
          notionImportBaseOrder: order,
        };
        meta.notionImportBaseRev = notionImportBaseRev(meta, "");
        const indexPath = path.join(dir, "index.md");
        const serialized = serializePage(meta, "");
        let durabilityError: unknown;
        try {
          await atomicWrite(indexPath, serialized);
        } catch (error) {
          // atomicWrite may have completed its rename before directory fsync
          // failed. Reconcile that exact postcondition so an immediate retry
          // cannot create a duplicate notionId in the same process.
          let committed = false;
          try {
            committed = (await fs.readFile(indexPath, "utf8")) === serialized;
          } catch {
            // The final path was never installed; preserve the original error.
          }
          if (!committed) {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
          // The rename is visible but the directory entry is still not known
          // durable after atomicWrite's retry. Index the exact postcondition so
          // the same journal token can recover idempotently, but never report a
          // successful reservation for a write that may disappear on crash.
          durabilityError = error;
        }
        entry = { dir, parentId: input.parentId, meta };
        this.index.set(meta.id, entry);
        this.notionIndex.set(notionId, meta.id);
        scheduleCommit(this.root);
        if (durabilityError) throw durabilityError;
        emitStore({ type: "create", id: meta.id });
        created = true;
        return {
          status: "reserved",
          page: this.notionStatus(entry),
          reservationToken: token,
          created,
        };
      }

      if (this.isDeleted(entry.meta.id)) {
        throw new NotionImportConflictError(
          "page_deleted",
          `notion page is in trash: ${notionId}`,
        );
      }
      if (input.parentId) {
        this.get(input.parentId);
        if (this.isDeleted(input.parentId)) {
          throw new NotionImportConflictError(
            "page_deleted",
            `notion parent is in trash: ${input.parentId}`,
          );
        }
        if (
          input.parentId === entry.meta.id ||
          this.isDescendant(input.parentId, entry.meta.id)
        ) {
          throw new NotionImportConflictError(
            "reservation_mismatch",
            "cannot import a page into itself or its descendant",
          );
        }
      }
      this.validateNotionPlacement(
        input.parentId,
        desiredBeforeId,
        entry.meta.id,
      );

      if (
        entry.meta.notionSourceHash === sourceHash &&
        !entry.meta.notionImportHash
      ) {
        if (!conversionHash) {
          return {
            status: "conversion_required",
            page: this.notionStatus(entry),
          };
        }
      }

      const pending = entry.meta.notionImportHash;
      if (pending) {
        const ownsReservation =
          reservationToken === entry.meta.notionImportToken &&
          pending === sourceHash;
        if (ownsReservation) {
          await this.renewNotionReservation(entry, sourceHash, reservationToken);
          if (
            entry.meta.notionImportParentId !== input.parentId ||
            entry.meta.notionImportBeforeId !== desiredBeforeId
          ) {
            // Pass two now knows every sibling id. Updating the desired slot is
            // safe while the immutable base parent/order still matches.
            this.validateNotionPlacement(
              input.parentId,
              desiredBeforeId,
              entry.meta.id,
            );
            const nextMeta: PageMeta = {
              ...entry.meta,
              notionImportParentId: input.parentId,
              notionImportBeforeId: desiredBeforeId,
              notionImportStarted: now(),
            };
            const currentMarkdown = parsePage(
              await fs.readFile(path.join(entry.dir, "index.md"), "utf8"),
            ).markdown;
            await atomicWrite(
              path.join(entry.dir, "index.md"),
              serializePage(nextMeta, currentMarkdown),
            );
            entry.meta = nextMeta;
            scheduleCommit(this.root);
          }
          return {
            status: "reserved",
            page: this.notionStatus(entry),
            reservationToken,
            created,
          };
        }
        const leaseRemainingMs = notionLeaseRemainingMs(
          entry.meta.notionImportStarted,
        );
        if (leaseRemainingMs > 0) {
          return {
            status: "busy",
            page: this.notionStatus(entry),
            retryAfterMs: Math.max(
              1_000,
              leaseRemainingMs,
            ),
          };
        }
      }

      const raw = await fs.readFile(path.join(entry.dir, "index.md"), "utf8");
      const { meta: fresh, markdown } = parsePage(raw);
      const loadedMeta = {
        ...fresh,
        id: fresh.id || entry.meta.id,
        title: fresh.title || entry.meta.title,
        order: fresh.order || entry.meta.order,
        created: fresh.created || entry.meta.created,
        updated: fresh.updated || entry.meta.updated,
      } as PageMeta;
      const currentTargetRev = notionImportBaseRev(loadedMeta, markdown);
      if (pending) {
        if (
          !loadedMeta.notionImportBaseRev ||
          currentTargetRev !== loadedMeta.notionImportBaseRev
        ) {
          throw new NotionImportConflictError(
            "source_changed",
            `page changed after stale notion reservation: ${entry.meta.id}`,
          );
        }
        const atBaseHierarchy = this.notionBaselinePlacementIntact(
          entry,
          loadedMeta,
        );
        const atDesiredHierarchy =
          entry.parentId === loadedMeta.notionImportParentId &&
          this.beforeIdFor(entry) === loadedMeta.notionImportBeforeId;
        if (!atBaseHierarchy && !atDesiredHierarchy) {
          throw new NotionImportConflictError(
            "source_changed",
            `page hierarchy changed after stale notion reservation: ${entry.meta.id}`,
          );
        }
      } else {
        if (
          !loadedMeta.notionSourceHash ||
          !loadedMeta.notionTargetRev ||
          loadedMeta.notionTargetParentId === undefined ||
          loadedMeta.notionTargetBeforeId === undefined ||
          !loadedMeta.notionTargetOrder
        ) {
          throw new NotionImportConflictError(
            "untracked_existing",
            `existing notion page has no trusted import baseline: ${entry.meta.id}`,
          );
        }
        if (currentTargetRev !== loadedMeta.notionTargetRev) {
          throw new NotionImportConflictError(
            "source_changed",
            `page changed since the last notion finalize: ${entry.meta.id}`,
          );
        }
        if (
          entry.parentId !== loadedMeta.notionTargetParentId ||
          loadedMeta.order !== loadedMeta.notionTargetOrder ||
          this.beforeIdFor(entry) !== loadedMeta.notionTargetBeforeId
        ) {
          throw new NotionImportConflictError(
            "source_changed",
            `page hierarchy changed since the last notion finalize: ${entry.meta.id}`,
          );
        }
        if (
          loadedMeta.notionSourceHash === sourceHash &&
          conversionHash !== undefined &&
          loadedMeta.notionConversionHash === conversionHash &&
          entry.parentId === input.parentId &&
          this.beforeIdFor(entry) === desiredBeforeId &&
          (await this.canonicalAttachmentsHealthy(markdown, [loadedMeta.cover]))
        ) {
          entry.meta = loadedMeta;
          return { status: "unchanged", page: this.notionStatus(entry) };
        }
      }
      const supersededToken = pending ? loadedMeta.notionImportToken : undefined;
      const token = reservationToken;
      if (
        [...this.index.values()].some(
          (candidate) =>
            candidate.meta.id !== entry!.meta.id &&
            candidate.meta.notionImportToken === token,
        )
      ) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          "notion reservation token is already active",
        );
      }
      const nextMeta: PageMeta = {
        ...loadedMeta,
        notionId,
        notionImportHash: sourceHash,
        notionImportToken: token,
        notionImportStarted: now(),
        notionImportBaseRev: currentTargetRev,
        notionImportParentId: input.parentId,
        notionImportBeforeId: desiredBeforeId,
        notionImportBaseParentId: entry.parentId,
        notionImportBaseBeforeId: this.beforeIdFor(entry),
        notionImportBaseOrder: loadedMeta.order,
        updated: now(),
      };
      if (supersededToken) {
        // A stale source's files cannot be reused for a new reservation. Delete
        // them before persisting the takeover, and fail closed on any I/O error.
        await this.removeNotionStaging(supersededToken);
      }
      const indexPath = path.join(entry.dir, "index.md");
      const content = serializePage(nextMeta, markdown);
      let durabilityError: unknown;
      try {
        await atomicWrite(indexPath, content);
      } catch (error) {
        // atomicWrite can install the exact reservation before a repeated
        // directory fsync failure is reported. Treat that visible lease as
        // authoritative in this process so a competing token cannot bypass it.
        if (!(await fileHasExactContent(indexPath, content))) throw error;
        durabilityError = error;
      }
      entry.meta = nextMeta;
      scheduleCommit(this.root);
      if (durabilityError) throw durabilityError;
      emitStore({ type: "meta", id: entry.meta.id });
      return {
        status: "reserved",
        page: this.notionStatus(entry),
        reservationToken: token,
        created,
      };
    });
  }

  /** Clear a durable abort receipt and install the next reservation in the
   * same canonical write. Missing or wrong acknowledgement performs no write. */
  private async reserveAfterAcknowledgedAbort(
    entry: Entry,
    input: ReserveNotionImportInput,
    notionId: string,
    sourceHash: string,
    reservationToken: string,
  ): Promise<ReserveNotionImportResult> {
    if (!input.acknowledgedAbort) {
      throw new NotionImportConflictError(
        "abort_ack_required",
        `notion abort must be journaled before reserving again: ${notionId}`,
      );
    }
    const acknowledgedSourceHash = normalizeSourceHash(
      input.acknowledgedAbort.sourceHash,
    );
    const acknowledgedToken = normalizeReservationToken(
      input.acknowledgedAbort.reservationToken,
    );
    if (this.isDeleted(entry.meta.id)) {
      throw new NotionImportConflictError(
        "page_deleted",
        `notion abort receipt page is in trash: ${notionId}`,
      );
    }
    if (input.parentId) {
      this.get(input.parentId);
      if (this.isDeleted(input.parentId)) {
        throw new NotionImportConflictError(
          "page_deleted",
          `notion parent is in trash: ${input.parentId}`,
        );
      }
      if (
        input.parentId === entry.meta.id ||
        this.isDescendant(input.parentId, entry.meta.id)
      ) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          "cannot import a page into itself or its descendant",
        );
      }
    }
    this.validateNotionPlacement(input.parentId, input.beforeId, entry.meta.id);
    if (
      [...this.index.values()].some(
        (candidate) =>
          candidate.meta.id !== entry.meta.id &&
          candidate.meta.notionImportToken === reservationToken,
      )
    ) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        "notion reservation token is already active",
      );
    }

    const indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
    const raw = await fs.readFile(indexPath, "utf8");
    const current = parsePage(raw);
    const loadedMeta = {
      ...current.meta,
      id: current.meta.id || entry.meta.id,
      title: current.meta.title || entry.meta.title,
      order: current.meta.order || entry.meta.order,
      created: current.meta.created || entry.meta.created,
      updated: current.meta.updated || entry.meta.updated,
    } as PageMeta;
    const receipt = notionAbortReceipt(loadedMeta);
    if (
      !receipt ||
      receipt.notionId !== notionId ||
      receipt.sourceHash !== acknowledgedSourceHash ||
      !reservationTokenHashMatches(
        acknowledgedToken,
        receipt.tokenSha256,
      )
    ) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `notion abort acknowledgement does not match: ${notionId}`,
      );
    }
    const detached = receipt.status === "detached";
    const baseRev = notionImportBaseRev(loadedMeta, current.markdown);
    if (
      !loadedMeta.notionTargetRev ||
      baseRev !== loadedMeta.notionTargetRev ||
      loadedMeta.notionTargetParentId === undefined ||
      loadedMeta.notionTargetBeforeId === undefined ||
      !loadedMeta.notionTargetOrder ||
      entry.parentId !== loadedMeta.notionTargetParentId ||
      this.beforeIdFor(entry) !== loadedMeta.notionTargetBeforeId ||
      loadedMeta.order !== loadedMeta.notionTargetOrder
    ) {
      throw new NotionImportConflictError(
        "source_changed",
        `page changed after completed notion abort: ${entry.meta.id}`,
      );
    }

    const clearedMeta = clearNotionAbortReceipt(loadedMeta);
    const started = now();
    const nextMeta: PageMeta = {
      ...clearedMeta,
      title: clearedMeta.title,
      icon: clearedMeta.icon,
      cover: clearedMeta.cover,
      notionId,
      notionImportHash: sourceHash,
      notionImportToken: reservationToken,
      notionImportStarted: started,
      notionImportBaseRev: baseRev,
      notionImportCreated: detached || undefined,
      notionImportOwnedCover: undefined,
      notionImportParentId: input.parentId,
      notionImportBeforeId: input.beforeId,
      notionImportBaseParentId: entry.parentId,
      notionImportBaseBeforeId: this.beforeIdFor(entry),
      notionImportBaseOrder: loadedMeta.order,
      updated: started,
    };
    const content = serializePage(nextMeta, current.markdown);
    let durabilityError: unknown;
    try {
      await atomicWrite(indexPath, content);
    } catch (error) {
      if (!(await fileHasExactContent(indexPath, content))) throw error;
      durabilityError = error;
    }
    entry.meta = nextMeta;
    this.abortReceiptIndex.delete(notionId);
    this.notionIndex.set(notionId, entry.meta.id);
    scheduleCommit(this.root);
    emitStore({ type: "meta", id: entry.meta.id });
    if (durabilityError) throw durabilityError;
    return {
      status: "reserved",
      page: this.notionStatus(entry),
      reservationToken,
      created: detached,
    };
  }

  /** Finalize only the reservation owner and refuse to overwrite any body edit
   *  made after reserve. Repeating a completed finalize is idempotent. */
  async finalizeNotionImport(
    input: FinalizeNotionImportInput,
  ): Promise<FinalizeNotionImportResult> {
    return this.mutate(async () => {
      const notionId = normalizeNotionId(input.notionId);
      const sourceHash = normalizeSourceHash(input.sourceHash);
      const conversionHash = normalizeSourceHash(input.conversionHash);
      const reservationToken = normalizeReservationToken(
        input.reservationToken,
      );
      if (containsNotionUnsupportedMarker(input.markdown)) {
        throw new NotionImportConflictError(
          "conversion_issues",
          "notion conversion contains unsupported or unresolved blocks",
        );
      }
      const entry = this.notionEntry(notionId);
      if (!entry) throw new NotFoundError(notionId);
      if (this.isDeleted(entry.meta.id)) {
        throw new NotionImportConflictError(
          "page_deleted",
          `notion page is in trash: ${notionId}`,
        );
      }
      let indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
      const raw = await fs.readFile(indexPath, "utf8");
      const current = parsePage(raw);
      const loadedMeta = {
        ...current.meta,
        id: current.meta.id || entry.meta.id,
        title: current.meta.title || entry.meta.title,
        order: current.meta.order || entry.meta.order,
        created: current.meta.created || entry.meta.created,
        updated: current.meta.updated || entry.meta.updated,
      } as PageMeta;

      if (
        loadedMeta.notionSourceHash === sourceHash &&
        loadedMeta.notionConversionHash === conversionHash &&
        !loadedMeta.notionImportHash
      ) {
        const currentTargetRev = notionImportBaseRev(
          loadedMeta,
          current.markdown,
        );
        if (
          !loadedMeta.notionTargetRev ||
          currentTargetRev !== loadedMeta.notionTargetRev ||
          loadedMeta.notionTargetParentId === undefined ||
          loadedMeta.notionTargetBeforeId === undefined ||
          !loadedMeta.notionTargetOrder ||
          entry.parentId !== loadedMeta.notionTargetParentId ||
          loadedMeta.order !== loadedMeta.notionTargetOrder ||
          this.beforeIdFor(entry) !== loadedMeta.notionTargetBeforeId
        ) {
          throw new NotionImportConflictError(
            "source_changed",
            `page changed since the last notion finalize: ${entry.meta.id}`,
          );
        }
        if (
          !(await this.canonicalAttachmentsHealthy(current.markdown, [
            loadedMeta.cover,
          ]))
        ) {
          throw new NotionImportConflictError(
            "missing_attachment",
            "finalized attachment is missing or corrupt; reserve a repair",
          );
        }
        entry.meta = loadedMeta;
        this.assertNotionCleanupTokenUnowned(
          reservationToken,
          entry.meta.id,
        );
        const stagingRemoved = await this.tryRemoveNotionStaging(
          reservationToken,
        );
        return {
          status: "unchanged",
          page: this.notionStatus(entry),
          rev: hashRev(raw),
          cleanup: { stagingRemoved },
        };
      }

      if (
        loadedMeta.notionImportHash !== sourceHash ||
        loadedMeta.notionImportToken !== reservationToken
      ) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          `notion reservation does not match: ${notionId}`,
        );
      }
      if (
        notionImportBaseRev(loadedMeta, current.markdown) !==
        loadedMeta.notionImportBaseRev
      ) {
        throw new NotionImportConflictError(
          "source_changed",
          `page changed after notion reservation: ${entry.meta.id}`,
        );
      }

      const desiredParentId = loadedMeta.notionImportParentId;
      const desiredBeforeId = loadedMeta.notionImportBeforeId;
      if (desiredParentId === undefined || desiredBeforeId === undefined) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          "notion reservation has no hierarchy target",
        );
      }
      if (desiredParentId) {
        let desiredParent: Entry;
        try {
          desiredParent = this.get(desiredParentId);
        } catch (error) {
          if (error instanceof Error && error.name === "NotFoundError") {
            throw new NotionImportConflictError(
              "parent_not_found",
              `notion target parent no longer exists: ${desiredParentId}`,
            );
          }
          throw error;
        }
        if (this.isDeleted(desiredParent.meta.id)) {
          throw new NotionImportConflictError(
            "page_deleted",
            `notion target parent is in trash: ${desiredParentId}`,
          );
        }
        if (
          desiredParentId === entry.meta.id ||
          this.isDescendant(desiredParentId, entry.meta.id)
        ) {
          throw new NotionImportConflictError(
            "reservation_mismatch",
            "cannot import a page into itself or its descendant",
          );
        }
      }
      let ancestorId: string | null = desiredParentId;
      while (ancestorId) {
        const ancestor = this.get(ancestorId);
        if (ancestor.meta.notionImportCreated && ancestor.meta.notionImportHash) {
          throw new NotionImportConflictError(
            "parent_import_pending",
            `finalize notion parent before child: ${ancestorId}`,
          );
        }
        ancestorId = ancestor.parentId;
      }
      if (desiredBeforeId) {
        let nextSibling: Entry;
        try {
          nextSibling = this.get(desiredBeforeId);
        } catch (error) {
          if (error instanceof Error && error.name === "NotFoundError") {
            throw new NotionImportConflictError(
              "reservation_mismatch",
              `next notion sibling no longer exists: ${desiredBeforeId}`,
            );
          }
          throw error;
        }
        if (this.isDeleted(nextSibling.meta.id)) {
          throw new NotionImportConflictError(
            "page_deleted",
            `next notion sibling is in trash: ${desiredBeforeId}`,
          );
        }
        if (nextSibling.meta.notionImportHash) {
          throw new NotionImportConflictError(
            "sibling_import_pending",
            `finalize the next notion sibling first: ${desiredBeforeId}`,
          );
        }
        if (nextSibling.parentId !== desiredParentId) {
          throw new NotionImportConflictError(
            "reservation_mismatch",
            `next notion sibling is not under the target parent: ${desiredBeforeId}`,
          );
        }
      }
      const currentBeforeId = this.beforeIdFor(entry);
      const atBaseline = this.notionBaselinePlacementIntact(entry, loadedMeta);
      const atDesired =
        entry.parentId === desiredParentId && currentBeforeId === desiredBeforeId;
      if (!atBaseline && !atDesired) {
        throw new NotionImportConflictError(
          "source_changed",
          `page hierarchy changed after notion reservation: ${entry.meta.id}`,
        );
      }

      // Validate the exact target and every referenced attachment before a
      // visible hierarchy mutation. Content-addressed attachment promotion may
      // leave an unreachable duplicate on a later I/O failure, but a rejected
      // payload never moves or overwrites the page.
      const targetMeta: PageMeta = { ...loadedMeta };
      if (input.title !== undefined)
        targetMeta.title = input.title.trim() || "Untitled";
      if (input.icon !== undefined) targetMeta.icon = input.icon || undefined;
      if (input.cover !== undefined) targetMeta.cover = input.cover || undefined;
      try {
        if (input.collection !== undefined) {
          targetMeta.collection = input.collection
            ? collectionDefinitionSchema.parse(input.collection)
            : undefined;
        }
        if (input.collectionRow !== undefined) {
          targetMeta.collectionRow = input.collectionRow
            ? collectionRowSchema.parse(input.collectionRow)
            : undefined;
        }
      } catch {
        throw new NotionImportConflictError(
          "conversion_issues",
          "notion collection metadata is invalid",
        );
      }
      if (targetMeta.collection && targetMeta.collectionRow) {
        throw new NotionImportConflictError(
          "conversion_issues",
          "a notion page cannot be both a collection and a collection row",
        );
      }
      if (targetMeta.collection?.databaseId !== undefined) {
        if (normalizeNotionId(targetMeta.collection.databaseId) !== notionId) {
          throw new NotionImportConflictError(
            "conversion_issues",
            "collection database id does not match the notion page",
          );
        }
      }
      if (targetMeta.collectionRow) {
        if (!desiredParentId) {
          throw new NotionImportConflictError(
            "conversion_issues",
            "a collection row requires a collection parent",
          );
        }
        const parentCollection = this.get(desiredParentId).meta.collection;
        if (!parentCollection) {
          throw new NotionImportConflictError(
            "conversion_issues",
            "collection row parent has no collection metadata",
          );
        }
        try {
          assertCollectionRowMatchesDefinition(
            parentCollection,
            targetMeta.collectionRow,
          );
        } catch {
          throw new NotionImportConflictError(
            "conversion_issues",
            "collection row does not match its parent schema",
          );
        }
      } else if (desiredParentId && this.get(desiredParentId).meta.collection) {
        throw new NotionImportConflictError(
          "conversion_issues",
          "a direct collection child must preserve row metadata",
        );
      }
      assertNotionIconCompatible(targetMeta.icon);
      assertNotionCoverCompatible(targetMeta.cover);
      const finalizedMarkdown = parsePage(
        serializePage(targetMeta, input.markdown),
      ).markdown;
      const expectedConversionHash = notionConversionHash({
        sourceHash,
        parentId: desiredParentId,
        beforeId: desiredBeforeId,
        title: targetMeta.title,
        icon: targetMeta.icon,
        cover: targetMeta.cover,
        markdown: finalizedMarkdown,
        collection: targetMeta.collection,
        collectionRow: targetMeta.collectionRow,
      });
      if (conversionHash !== expectedConversionHash) {
        throw new NotionImportConflictError(
          "conversion_mismatch",
          "conversion hash does not match the finalized Brain target",
        );
      }
      await this.promoteNotionAttachments(
        reservationToken,
        finalizedMarkdown,
        [targetMeta.cover],
      );

      entry.meta = loadedMeta;
      if (!atDesired) {
        await this.movePageUnlocked(
          entry.meta.id,
          desiredParentId,
          desiredBeforeId,
          "notion-import",
        );
        indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
      }

      const nextMeta: PageMeta = {
        ...entry.meta,
        title: targetMeta.title,
        icon: targetMeta.icon,
        cover: targetMeta.cover,
        collection: targetMeta.collection,
        collectionRow: targetMeta.collectionRow,
      };
      nextMeta.notionSourceHash = sourceHash;
      nextMeta.notionConversionHash = conversionHash;
      nextMeta.notionImportHash = undefined;
      nextMeta.notionImportToken = undefined;
      nextMeta.notionImportStarted = undefined;
      nextMeta.notionImportBaseRev = undefined;
      nextMeta.notionImportCreated = undefined;
      nextMeta.notionImportOwnedCover = undefined;
      nextMeta.notionImportParentId = undefined;
      nextMeta.notionImportBeforeId = undefined;
      nextMeta.notionImportBaseParentId = undefined;
      nextMeta.notionImportBaseBeforeId = undefined;
      nextMeta.notionImportBaseOrder = undefined;
      nextMeta.notionTargetParentId = entry.parentId;
      nextMeta.notionTargetBeforeId = this.beforeIdFor(entry);
      nextMeta.notionTargetOrder = entry.meta.order;
      nextMeta.updated = now();
      nextMeta.updatedBy = "claude";
      nextMeta.notionTargetRev = notionImportBaseRev(
        nextMeta,
        finalizedMarkdown,
      );
      const content = serializePage(nextMeta, finalizedMarkdown);
      let durabilityError: unknown;
      try {
        await atomicWrite(indexPath, content);
      } catch (error) {
        if (!(await fileHasExactContent(indexPath, content))) throw error;
        durabilityError = error;
      }
      entry.meta = nextMeta;
      const stagingRemoved = await this.tryRemoveNotionStaging(
        reservationToken,
      );
      scheduleCommit(this.root);
      const rev = hashRev(content);
      emitStore({ type: "write", id: entry.meta.id, rev });
      if (durabilityError) throw durabilityError;
      return {
        status: "finalized",
        page: this.notionStatus(entry),
        rev,
        cleanup: { stagingRemoved },
      };
    });
  }

  /** Release a token-owned reservation without losing raced filesystem edits.
   * Created placeholders are detached, never hard-deleted. Before importer
   * metadata changes, the exact prior index is retained as a hidden recovery
   * file and the new canonical index is installed without overwrite. */
  async abortNotionImport(
    input: AbortNotionImportInput,
  ): Promise<AbortNotionImportResult> {
    return this.mutate(async () => {
      const notionId = normalizeNotionId(input.notionId);
      const sourceHash = normalizeSourceHash(input.sourceHash);
      const reservationToken = normalizeReservationToken(
        input.reservationToken,
      );
      const receiptEntry = this.abortReceiptEntry(notionId);
      if (receiptEntry) {
        return this.replayNotionAbortReceipt(
          receiptEntry,
          notionId,
          sourceHash,
          reservationToken,
        );
      }
      const entry = this.notionEntry(notionId);
      if (!entry) throw new NotFoundError(notionId);
      let indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
      const raw = await fs.readFile(indexPath, "utf8");
      const current = parsePage(raw);
      const loadedMeta = {
        ...current.meta,
        id: current.meta.id || entry.meta.id,
        title: current.meta.title || entry.meta.title,
        order: current.meta.order || entry.meta.order,
        created: current.meta.created || entry.meta.created,
        updated: current.meta.updated || entry.meta.updated,
      } as PageMeta;
      if (
        loadedMeta.notionImportHash !== sourceHash ||
        loadedMeta.notionImportToken !== reservationToken
      ) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          `notion reservation does not match: ${notionId}`,
        );
      }

      const detached = Boolean(loadedMeta.notionImportCreated);
      if (
        detached &&
        [...this.index.values()].some(
          (candidate) =>
            candidate.meta.id !== entry.meta.id &&
            candidate.dir.startsWith(entry.dir + path.sep) &&
            Boolean(candidate.meta.notionId),
        )
      ) {
        throw new NotionImportConflictError(
          "has_import_children",
          `abort notion children before their placeholder parent: ${entry.meta.id}`,
        );
      }
      const atBaseHierarchy = this.notionBaselinePlacementIntact(
        entry,
        loadedMeta,
      );
      const atDesiredHierarchy =
        entry.parentId === loadedMeta.notionImportParentId &&
        this.beforeIdFor(entry) === loadedMeta.notionImportBeforeId;
      if (!detached && !atBaseHierarchy && !atDesiredHierarchy) {
        throw new NotionImportConflictError(
          "source_changed",
          `page hierarchy changed after notion reservation: ${entry.meta.id}`,
        );
      }
      const releaseGitBarrier = await beginGitSnapshotBarrier(this.root);
      let releaseSafe = false;
      try {
        let stagingRemoved = true;
        await this.removeNotionStaging(reservationToken).catch(() => {
          stagingRemoved = false;
        });
        entry.meta = loadedMeta;
        if (
          !detached &&
          loadedMeta.notionTargetParentId !== undefined &&
          loadedMeta.notionTargetBeforeId !== undefined &&
          (entry.parentId !== loadedMeta.notionTargetParentId ||
            this.beforeIdFor(entry) !== loadedMeta.notionTargetBeforeId)
        ) {
          await this.movePageUnlocked(
            entry.meta.id,
            loadedMeta.notionTargetParentId,
            loadedMeta.notionTargetBeforeId,
            "notion-import-abort",
          );
          indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
        }
        const preserved = await preservingIndexUpdate(
          this.root,
          indexPath,
          {
            pageId: entry.meta.id,
            notionId,
            sourceHash,
            reservationToken,
          },
          (latestRaw) => {
            const latest = parsePage(latestRaw);
            const latestMeta = {
              ...latest.meta,
              id: latest.meta.id || entry.meta.id,
              title: latest.meta.title || entry.meta.title,
              order: latest.meta.order || entry.meta.order,
              created: latest.meta.created || entry.meta.created,
              updated: latest.meta.updated || entry.meta.updated,
            } as PageMeta;
            if (
              latestMeta.notionImportHash !== sourceHash ||
              latestMeta.notionImportToken !== reservationToken ||
              Boolean(latestMeta.notionImportCreated) !== detached
            ) {
              throw new NotionImportConflictError(
                "reservation_mismatch",
                `notion reservation changed during abort: ${notionId}`,
              );
            }
            const nextMeta: PageMeta = {
              ...latestMeta,
              cover:
                detached &&
                latestMeta.notionImportOwnedCover !== undefined &&
                latestMeta.cover === latestMeta.notionImportOwnedCover
                  ? undefined
                  : latestMeta.cover,
              notionId: detached ? undefined : latestMeta.notionId,
              notionSourceHash: detached
                ? undefined
                : latestMeta.notionSourceHash,
              notionConversionHash: detached
                ? undefined
                : latestMeta.notionConversionHash,
              notionTargetRev: latestMeta.notionTargetRev,
              notionTargetParentId: latestMeta.notionTargetParentId,
              notionTargetBeforeId: latestMeta.notionTargetBeforeId,
              notionTargetOrder: latestMeta.notionTargetOrder,
              notionImportHash: undefined,
              notionImportToken: undefined,
              notionImportStarted: undefined,
              notionImportBaseRev: undefined,
              notionImportCreated: undefined,
              notionImportOwnedCover: undefined,
              notionImportParentId: undefined,
              notionImportBeforeId: undefined,
              notionImportBaseParentId: undefined,
              notionImportBaseBeforeId: undefined,
              notionImportBaseOrder: undefined,
              notionAbortId: notionId,
              notionAbortSourceHash: sourceHash,
              notionAbortTokenSha256: reservationTokenSha256(
                reservationToken,
              ),
              notionAbortStatus: detached ? "detached" : "aborted",
              notionAbortStagingRemoved: stagingRemoved,
              notionAbortCompletedAt: now(),
              updated: now(),
            };
            if (detached) {
              const exactBaseHierarchy =
                entry.parentId === latestMeta.notionImportBaseParentId &&
                this.beforeIdFor(entry) ===
                  latestMeta.notionImportBaseBeforeId &&
                latestMeta.order === latestMeta.notionImportBaseOrder;
              const exactBaseBody =
                Boolean(latestMeta.notionImportBaseRev) &&
                notionImportBaseRev(latestMeta, latest.markdown) ===
                  latestMeta.notionImportBaseRev;
              if (exactBaseHierarchy && exactBaseBody) {
                nextMeta.notionTargetParentId = entry.parentId;
                nextMeta.notionTargetBeforeId = this.beforeIdFor(entry);
                nextMeta.notionTargetOrder = latestMeta.order;
                nextMeta.notionTargetRev = notionImportBaseRev(
                  nextMeta,
                  latest.markdown,
                );
              } else {
                // Preserve the original reservation baseline as negative proof:
                // abort keeps the user's edit, but a later journal ack cannot
                // silently bless and overwrite it.
                nextMeta.notionTargetParentId =
                  latestMeta.notionImportBaseParentId;
                nextMeta.notionTargetBeforeId =
                  latestMeta.notionImportBaseBeforeId;
                nextMeta.notionTargetOrder = latestMeta.notionImportBaseOrder;
                nextMeta.notionTargetRev = latestMeta.notionImportBaseRev;
              }
            }
            return {
              content: serializePage(nextMeta, latest.markdown),
              value: nextMeta,
            };
          },
        ).catch(async (error: unknown) => {
          try {
            await this.refreshEntryFromCanonical(entry);
          } catch (refreshError) {
            throw new AggregateError(
              [error, refreshError],
              "notion abort failed and canonical in-memory reconciliation failed",
            );
          }
          throw error;
        });
        if (preserved.state !== "next" || !preserved.value) {
          await this.refreshEntryFromCanonical(entry);
          throw new NotionImportConflictError(
            "source_changed",
            `page changed while completing notion abort: ${notionId}`,
          );
        }
        const nextMeta = preserved.value;
        entry.meta = nextMeta;
        if (detached) this.notionIndex.delete(notionId);
        this.abortReceiptIndex.set(notionId, entry.meta.id);
        emitStore({ type: "meta", id: entry.meta.id });
        if (preserved.durabilityError) throw preserved.durabilityError;
        releaseSafe = true;
        return detached
          ? {
              status: "detached",
              pageId: entry.meta.id,
              cleanup: {
                stagingRemoved,
                notionBindingRemoved: true,
                placeholderPreserved: true,
              },
            }
          : {
              status: "aborted",
              pageId: entry.meta.id,
              cleanup: {
                stagingRemoved,
                notionBindingRemoved: false,
                placeholderPreserved: true,
              },
            };
      } catch (error) {
        try {
          releaseSafe = await this.abortTransactionIsReleaseSafe(entry);
        } catch {
          releaseSafe = false;
        }
        if (!releaseSafe) {
          this.mutationPoison = new Error(
            "Store mutations are blocked by an unresolved Notion abort intent",
          );
        }
        throw error;
      } finally {
        if (releaseSafe) {
          // Arm a snapshot on both success and reconciled failure. The barrier
          // defers it until canonical index + recovery/intent state is stable.
          scheduleCommit(this.root);
          releaseGitBarrier();
        }
      }
    });
  }

  /** Replay a completed abort after its response was lost. The raw token is
   * compared only through the receipt hash and is never returned or logged. */
  private async replayNotionAbortReceipt(
    entry: Entry,
    notionId: string,
    sourceHash: string,
    reservationToken: string,
  ): Promise<AbortNotionImportResult> {
    const indexPath = assertInRoot(this.root, path.join(entry.dir, "index.md"));
    const canonical = await readRegularTextNoFollow(indexPath);
    if (!canonical) throw new NotFoundError(notionId);
    const parsed = parsePage(canonical.text);
    const loadedMeta = {
      ...parsed.meta,
      id: parsed.meta.id || entry.meta.id,
      title: parsed.meta.title || entry.meta.title,
      order: parsed.meta.order || entry.meta.order,
      created: parsed.meta.created || entry.meta.created,
      updated: parsed.meta.updated || entry.meta.updated,
    } as PageMeta;
    const receipt = notionAbortReceipt(loadedMeta);
    if (
      !receipt ||
      receipt.notionId !== notionId ||
      receipt.sourceHash !== sourceHash ||
      !reservationTokenHashMatches(reservationToken, receipt.tokenSha256)
    ) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `notion reservation does not match: ${notionId}`,
      );
    }

    if (!receipt.stagingRemoved) {
      const stagingRemoved = await this.tryRemoveNotionStaging(
        reservationToken,
      );
      if (stagingRemoved) {
        const releaseGitBarrier = await beginGitSnapshotBarrier(this.root);
        let releaseSafe = false;
        try {
          const preserved = await preservingIndexUpdate(
            this.root,
            indexPath,
            {
              pageId: entry.meta.id,
              notionId,
              sourceHash,
              reservationToken,
            },
            (latestRaw) => {
              const latest = parsePage(latestRaw);
              const nextMeta = {
                ...latest.meta,
                id: latest.meta.id || entry.meta.id,
                title: latest.meta.title || entry.meta.title,
                order: latest.meta.order || entry.meta.order,
                created: latest.meta.created || entry.meta.created,
                updated: latest.meta.updated || entry.meta.updated,
                notionAbortStagingRemoved: true,
              } as PageMeta;
              const latestReceipt = notionAbortReceipt(nextMeta);
              if (
                !latestReceipt ||
                latestReceipt.notionId !== notionId ||
                latestReceipt.sourceHash !== sourceHash ||
                !reservationTokenHashMatches(
                  reservationToken,
                  latestReceipt.tokenSha256,
                )
              ) {
                throw new NotionImportConflictError(
                  "reservation_mismatch",
                  `notion abort receipt changed: ${notionId}`,
                );
              }
              return {
                content: serializePage(nextMeta, latest.markdown),
                value: nextMeta,
              };
            },
          );
          if (preserved.state !== "next" || !preserved.value) {
            await this.refreshEntryFromCanonical(entry);
            throw new NotionImportConflictError(
              "source_changed",
              `page changed while acknowledging notion abort: ${notionId}`,
            );
          }
          entry.meta = preserved.value;
          releaseSafe = true;
          if (preserved.durabilityError) throw preserved.durabilityError;
        } catch (error) {
          try {
            releaseSafe = await this.abortTransactionIsReleaseSafe(entry);
          } catch {
            releaseSafe = false;
          }
          if (!releaseSafe) {
            this.mutationPoison = new Error(
              "Store mutations are blocked by an unresolved Notion abort intent",
            );
          }
          throw error;
        } finally {
          if (releaseSafe) {
            scheduleCommit(this.root);
            releaseGitBarrier();
          }
        }
      }
    }
    await this.refreshEntryFromCanonical(entry);
    const finalReceipt = notionAbortReceipt(entry.meta);
    if (!finalReceipt) {
      throw new Error("notion abort receipt disappeared during replay");
    }
    return finalReceipt.status === "detached"
      ? {
          status: "detached",
          pageId: entry.meta.id,
          cleanup: {
            stagingRemoved: finalReceipt.stagingRemoved,
            notionBindingRemoved: true,
            placeholderPreserved: true,
          },
        }
      : {
          status: "aborted",
          pageId: entry.meta.id,
          cleanup: {
            stagingRemoved: finalReceipt.stagingRemoved,
            notionBindingRemoved: false,
            placeholderPreserved: true,
          },
        };
  }

  async writePage(
    id: string,
    markdown: string,
    expectedRev?: string,
    by?: "me" | "claude",
    src?: string,
    expectedMarkdown?: string,
  ): Promise<Page> {
    return this.mutate(async () => {
      const e = this.get(id);
      const indexPath = assertInRoot(this.root, path.join(e.dir, "index.md"));
      const currentRaw = await fs.readFile(indexPath, "utf8");
      const currentRev = hashRev(currentRaw);
      const parsed = parsePage(currentRaw);
      const bodyStillMatches =
        parsed.meta.structureWriteBarrier !== true &&
        expectedMarkdown !== undefined &&
        parsed.markdown === canonicalPageMarkdown(expectedMarkdown);
      if (
        expectedRev !== undefined &&
        expectedRev !== currentRev &&
        !bodyStillMatches
      ) {
        throw new RevConflictError(currentRev, expectedRev);
      }
      const fresh = parsed.meta;
      e.meta = {
        ...fresh,
        id: fresh.id || e.meta.id,
        title: fresh.title || e.meta.title,
        order: fresh.order || e.meta.order,
        created: fresh.created || e.meta.created,
        updated: fresh.updated || e.meta.updated,
      } as PageMeta;
      const bodyChanged = canonicalPageMarkdown(markdown) !== parsed.markdown;
      // An unchanged body is not an edit: no `updated` stamp, no disk write,
      // no event, no Git commit. Opening a page must not read as editing it.
      if (!bodyChanged) {
        return { meta: e.meta, markdown: parsed.markdown, rev: currentRev };
      }
      e.meta.updated = now();
      if (by) e.meta.updatedBy = by;
      delete e.meta.structureWriteBarrier;
      const content = serializePage(e.meta, markdown);
      await atomicWrite(indexPath, content);
      scheduleCommit(this.root);
      const rev = hashRev(content);
      emitStore({ type: "write", id, rev, src });
      return { meta: e.meta, markdown: markdown.trimEnd(), rev };
    });
  }

  /** Append inside the mutation queue. Keeping read + join + atomic write in
   *  one critical section prevents concurrent MCP calls losing a fragment. */
  async appendPage(
    id: string,
    markdown: string,
    by?: "me" | "claude",
    src?: string,
  ): Promise<Page> {
    return this.mutate(async () => {
      const e = this.get(id);
      const indexPath = assertInRoot(this.root, path.join(e.dir, "index.md"));
      const currentRaw = await fs.readFile(indexPath, "utf8");
      const { meta: fresh, markdown: currentMarkdown } = parsePage(currentRaw);
      e.meta = {
        ...fresh,
        id: fresh.id || e.meta.id,
        title: fresh.title || e.meta.title,
        order: fresh.order || e.meta.order,
        created: fresh.created || e.meta.created,
        updated: fresh.updated || e.meta.updated,
      } as PageMeta;
      e.meta.updated = now();
      if (by) e.meta.updatedBy = by;
      const base = currentMarkdown.trimEnd();
      const addition = markdown.trimStart();
      const joined = base ? `${base}\n\n${addition}` : addition;
      const content = serializePage(e.meta, joined);
      await atomicWrite(indexPath, content);
      scheduleCommit(this.root);
      const rev = hashRev(content);
      emitStore({ type: "write", id, rev, src });
      return { meta: e.meta, markdown: joined.trimEnd(), rev };
    });
  }

  async createPage(
    parentId: string | null,
    title = "Untitled",
    opts: {
      /** Server-derived identity for idempotent create operations. Never pass a
       * raw client-supplied page id. */
      id?: string;
      quickCaptureFingerprint?: string;
      markdown?: string;
      notionId?: string;
      icon?: string;
      cover?: string;
      status?: string;
      font?: PageMeta["font"];
      smallText?: boolean;
      fullWidth?: boolean;
      by?: "me" | "claude";
      src?: string;
    } = {},
  ): Promise<PageMeta> {
    return this.mutate(async () => {
      if (
        opts.id !== undefined &&
        (!PAGE_ID_RE.test(opts.id) || opts.id.length > 128)
      ) {
        throw new Error("invalid deterministic page id");
      }
      if (
        (opts.id === undefined) !==
          (opts.quickCaptureFingerprint === undefined) ||
        (opts.quickCaptureFingerprint !== undefined &&
          !SOURCE_HASH_RE.test(opts.quickCaptureFingerprint))
      ) {
        throw new Error("invalid deterministic page fingerprint");
      }
      if (opts.id) {
        const existing = this.index.get(opts.id);
        if (existing) {
          if (
            existing.meta.quickCaptureFingerprint !==
            opts.quickCaptureFingerprint
          ) {
            throw new QuickCaptureConflictError();
          }
          return existing.meta;
        }
      }
      if (parentId) {
        const parent = this.get(parentId); // validate parent exists
        if (this.isDeleted(parentId)) throw new NotFoundError(parentId);
        if (parent.meta.collection) {
          throw new Error("collection rows can only be created by a source import");
        }
      }
      const notionId = opts.notionId
        ? normalizeNotionId(opts.notionId)
        : undefined;
      if (
        notionId &&
        (this.notionIndex.has(notionId) ||
          this.abortReceiptIndex.has(notionId))
      ) {
        throw new NotionImportConflictError(
          this.abortReceiptIndex.has(notionId)
            ? "abort_ack_required"
            : "reservation_mismatch",
          "notion page already has an active binding or abort receipt",
        );
      }
      const parentDir = parentId ? this.get(parentId).dir : this.root;
      const dir = await uniqueDir(parentDir, slugify(title));
      const last = this.siblings(parentId).at(-1);
      const meta: PageMeta = {
        id: opts.id ?? nanoid(),
        title,
        icon: opts.icon,
        cover: opts.cover,
        order: generateKeyBetween(last ? last.meta.order : null, null),
        created: now(),
        updated: now(),
        updatedBy: opts.by,
        status: opts.status,
        font: opts.font,
        smallText: opts.smallText,
        fullWidth: opts.fullWidth,
        quickCaptureFingerprint: opts.quickCaptureFingerprint,
        notionId,
      };
      await atomicWrite(
        path.join(dir, "index.md"),
        serializePage(meta, opts.markdown || ""),
      );
      this.index.set(meta.id, { dir, parentId, meta });
      if (notionId) this.notionIndex.set(notionId, meta.id);
      scheduleCommit(this.root);
      emitStore({ type: "create", id: meta.id, src: opts.src });
      return meta;
    });
  }

  /** Attachments share the same one-writer queue and atomic write primitive as
   *  notes. Routes pass bytes and untrusted display metadata, never a path. */
  async saveAttachment(
    input: AttachmentInput,
    src?: string,
  ): Promise<SavedAttachment> {
    return this.mutate(() =>
      this.saveAttachmentUnlocked(input, src).catch(
        rethrowAttachmentStoreFailure,
      ),
    );
  }

  /** Read one exact private attachment for an owner-requested portable export.
   * The final component is never followed, and identity is rechecked after the
   * bounded read so a path swap cannot smuggle different bytes into a backup. */
  async readPortableAttachment(name: string): Promise<Uint8Array> {
    if (localAttachmentName(`/_attachments-v2/${name}`) !== name) {
      throw new Error("portable export attachment name is invalid");
    }
    const directory = assertInRoot(
      this.root,
      path.join(/* turbopackIgnore: true */ this.root, "_attachments"),
    );
    const file = assertInRoot(directory, path.join(directory, name));
    const directoryIdentity = await assertRealDirectory(directory);
    const opened = await openRegularFileNoFollow(file);
    if (
      !opened ||
      !Number.isSafeInteger(opened.stat.size) ||
      opened.stat.size < 0 ||
      opened.stat.size > MAX_ATTACHMENT_BYTES
    ) {
      await opened?.handle.close().catch(() => undefined);
      throw new Error(`portable export attachment is missing or too large: ${name}`);
    }
    try {
      const bytes = Buffer.alloc(opened.stat.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await opened.handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesRead === 0) {
          throw new Error(`portable export attachment changed while reading: ${name}`);
        }
        offset += bytesRead;
      }
      const probe = Buffer.alloc(1);
      const extra = await opened.handle.read(probe, 0, 1, offset);
      const final = await opened.handle.stat();
      if (
        extra.bytesRead !== 0 ||
        !sameFileVersion(opened.stat, final) ||
        !(await pathStillReferencesRegularFile(file, opened.stat))
      ) {
        throw new Error(`portable export attachment changed while reading: ${name}`);
      }
      await assertRealDirectory(directory, directoryIdentity);
      return new Uint8Array(bytes);
    } finally {
      await opened.handle.close();
    }
  }

  /** The dry-run import path uses the same MIME and signature policy as the
   * eventual Store write, without creating a file. */
  validatePortableAttachment(input: AttachmentInput): string {
    return validateAttachment(input);
  }

  /** Import uploads are accepted only while the caller owns the matching page
   *  reservation. This keeps the MCP surface from becoming a generic blob
   *  endpoint and keeps every filesystem write inside Store's one-writer lock. */
  async saveNotionAttachment(
    notionIdInput: string,
    sourceHashInput: string,
    reservationToken: string,
    input: NotionAttachmentInput,
    src?: string,
  ): Promise<SavedAttachment> {
    return this.mutate(async () => {
      const notionId = normalizeNotionId(notionIdInput);
      const sourceHash = normalizeSourceHash(sourceHashInput);
      const entry = this.notionEntry(notionId);
      if (!entry) {
        throw new NotionImportConflictError(
          "reservation_mismatch",
          `notion reservation does not match: ${notionId}`,
        );
      }
      await this.renewNotionReservation(
        entry,
        sourceHash,
        reservationToken,
        src,
      );
      const saved = await this.stageNotionAttachment(
        reservationToken,
        input,
      ).catch(rethrowStagingFailure);
      return saved;
    });
  }

  /** Hash the exact staged bytes under a live reservation. This is intentionally
   * narrower than a generic attachment read endpoint: callers must own the
   * matching page reservation and can address only a content-addressed v2 URL. */
  async verifyNotionAttachment(
    input: VerifyNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment> {
    const notionId = normalizeNotionId(input.notionId);
    const sourceHash = normalizeSourceHash(input.sourceHash);
    const reservationToken = normalizeReservationToken(input.reservationToken);
    const entry = this.notionEntry(notionId);
    if (!entry) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `notion reservation does not match: ${notionId}`,
      );
    }
    const raw = await fs.readFile(
      assertInRoot(this.root, path.join(entry.dir, "index.md")),
      "utf8",
    );
    const loadedMeta = parsePage(raw).meta;
    if (
      loadedMeta.notionImportHash !== sourceHash ||
      loadedMeta.notionImportToken !== reservationToken
    ) {
      throw new NotionImportConflictError(
        "reservation_mismatch",
        `notion reservation does not match: ${notionId}`,
      );
    }
    const match = /^\/_attachments-v2\/([a-f0-9]{64}\.[A-Za-z0-9_-]{1,32})$/.exec(
      input.url,
    );
    if (!match) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "notion verification requires an exact content-addressed v2 URL",
      );
    }
    const expectedSha256 = match[1].split(".", 1)[0];
    const stageDir = this.notionStageDir(reservationToken);
    const stageIdentity = await assertPrivateOwnedDirectory(stageDir).catch(
      rethrowStagingFailure,
    );
    const file = assertInRoot(
      stageDir,
      path.join(stageDir, match[1]),
    );
    const digest = await regularFileDigestNoFollow(file).catch(
      rethrowStagingFailure,
    );
    if (!digest) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "notion staged attachment is not a regular file",
      );
    }
    if (digest.sha256 !== expectedSha256) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "notion staged attachment failed byte hash verification",
      );
    }
    await assertPrivateOwnedDirectory(stageDir, stageIdentity).catch(
      rethrowStagingFailure,
    );
    return { url: input.url, size: digest.size, sha256: digest.sha256 };
  }

  /** Read back a finalized imported attachment from the permanent store. The
   * page must still match its tracked body/meta/hierarchy baseline, and the
   * exact v2 URL must be an actual Markdown destination or the tracked cover. */
  async verifyFinalizedNotionAttachment(
    input: VerifyFinalizedNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment> {
    const notionId = normalizeNotionId(input.notionId);
    const sourceHash = normalizeSourceHash(input.sourceHash);
    const conversionHash = normalizeSourceHash(input.conversionHash);
    const entry = this.notionEntry(notionId);
    if (!entry) throw new NotFoundError(notionId);
    if (this.isDeleted(entry.meta.id)) {
      throw new NotionImportConflictError(
        "page_deleted",
        `notion page is in trash: ${notionId}`,
      );
    }
    const raw = await fs.readFile(
      assertInRoot(this.root, path.join(entry.dir, "index.md")),
      "utf8",
    );
    const current = parsePage(raw);
    const loadedMeta = {
      ...current.meta,
      id: current.meta.id || entry.meta.id,
      title: current.meta.title || entry.meta.title,
      order: current.meta.order || entry.meta.order,
      created: current.meta.created || entry.meta.created,
      updated: current.meta.updated || entry.meta.updated,
    } as PageMeta;
    const targetIntact = Boolean(
      !loadedMeta.notionImportHash &&
        loadedMeta.notionSourceHash === sourceHash &&
        loadedMeta.notionConversionHash === conversionHash &&
        loadedMeta.notionTargetRev &&
        notionImportBaseRev(loadedMeta, current.markdown) ===
          loadedMeta.notionTargetRev &&
        loadedMeta.notionTargetParentId !== undefined &&
        loadedMeta.notionTargetBeforeId !== undefined &&
        loadedMeta.notionTargetOrder &&
        entry.parentId === loadedMeta.notionTargetParentId &&
        this.beforeIdFor(entry) === loadedMeta.notionTargetBeforeId &&
        loadedMeta.order === loadedMeta.notionTargetOrder,
    );
    if (!targetIntact) {
      throw new NotionImportConflictError(
        "source_changed",
        `finalized notion target has drifted: ${entry.meta.id}`,
      );
    }
    const match = /^\/_attachments-v2\/([a-f0-9]{64}\.[A-Za-z0-9_-]{1,32})$/.exec(
      input.url,
    );
    if (!match) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "finalized notion verification requires an exact content-addressed v2 URL",
      );
    }
    if (
      loadedMeta.cover !== input.url &&
      !referencedAttachmentUrls(current.markdown).has(input.url)
    ) {
      throw new NotionImportConflictError(
        "attachment_not_owned",
        "attachment URL is not owned by the finalized notion page",
      );
    }
    const expectedSha256 = match[1].split(".", 1)[0];
    const file = assertInRoot(
      this.root,
      path.join(this.root, "_attachments", match[1]),
    );
    const attachmentDir = assertInRoot(
      this.root,
      path.join(this.root, "_attachments"),
    );
    const attachmentIdentity = await assertRealDirectory(
      attachmentDir,
    ).catch(rethrowAttachmentStoreFailure);
    const digest = await regularFileDigestNoFollow(file).catch(
      rethrowAttachmentStoreFailure,
    );
    if (!digest) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "finalized notion attachment is not a regular file",
      );
    }
    if (digest.sha256 !== expectedSha256) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "finalized notion attachment failed byte hash verification",
      );
    }
    await assertRealDirectory(attachmentDir, attachmentIdentity).catch(
      rethrowAttachmentStoreFailure,
    );
    return { url: input.url, size: digest.size, sha256: digest.sha256 };
  }

  /** Caller owns mutate(). */
  private async saveAttachmentUnlocked(
    input: AttachmentInput,
    src?: string,
  ): Promise<SavedAttachment> {
    const mimeType = validateAttachment(input);
    const displayName = normalizeAttachmentDisplayName(input.originalName);
    const extension = canonicalAttachmentExtension(displayName, mimeType);
    const savedName = `${nanoid(12)}${extension}`;
    const dir = assertInRoot(
      this.root,
      path.join(/* turbopackIgnore: true */ this.root, "_attachments"),
    );
    const file = assertInRoot(
      this.root,
      path.join(/* turbopackIgnore: true */ dir, savedName),
    );
    const identity = await ensureRealDirectory(dir);
    await atomicWrite(file, input.data);
    await assertRealDirectory(dir, identity);
    scheduleCommit(this.root);
    // Existing event vocabulary is intentionally reused: clients refresh
    // their tree, while no open page id can match this generated filename.
    emitStore({ type: "write", id: savedName, src });
    return {
      url: `/_attachments-v2/${savedName}`,
      name: displayName,
      size: input.data.byteLength,
      type: mimeType,
    };
  }

  async renamePage(id: string, title: string): Promise<PageMeta> {
    return this.updateMeta(id, { title });
  }

  /** Copy a single page (not its children) as a sibling; fresh id, no share/notion. */
  async duplicatePage(id: string): Promise<PageMeta> {
    const e = this.get(id);
    const src = await this.readPage(id);
    const meta = await this.createPage(e.parentId, `${e.meta.title} (copy)`, {
      markdown: src.markdown,
      icon: e.meta.icon,
      cover: e.meta.cover,
      font: e.meta.font,
      smallText: e.meta.smallText,
      fullWidth: e.meta.fullWidth,
      by: "me",
    });
    return meta;
  }

  async updateMeta(
    id: string,
    patch: {
      title?: string;
      icon?: string;
      cover?: string;
      public?: boolean;
      sharePass?: string | null;
      shareExpiresAt?: string | null;
      category?: string;
      pinned?: boolean;
      status?: string;
      view?: "board" | "sections" | null;
      font?: PageMeta["font"] | null;
      smallText?: boolean;
      fullWidth?: boolean;
      sections?: string[];
      tags?: string[];
      stickers?: import("./types").Sticker[];
      expected?: MetadataExpected;
      by?: "me" | "claude";
      src?: string;
    },
  ): Promise<PageMeta> {
    return this.mutate(async () => {
      const e = this.get(id);
      const conflicts = Object.entries(patch.expected ?? {})
        .filter(([field, expected]) =>
          !metadataValuesEqual(
            metadataValue(e.meta, field as keyof MetadataExpected),
            expected,
          ),
        )
        .map(([field]) => field);
      if (conflicts.length) throw new MetadataConflictError(conflicts);
      const before = JSON.stringify(e.meta);
      const nextPublic =
        patch.public === undefined ? e.meta.public : patch.public || undefined;
      const nextSharePass =
        patch.sharePass === undefined
          ? e.meta.sharePass
          : patch.sharePass || undefined;
      const nextShareExpiresAt =
        patch.shareExpiresAt === undefined
          ? e.meta.shareExpiresAt
          : patch.shareExpiresAt || undefined;
      const rotateShare =
        nextPublic !== e.meta.public ||
        nextSharePass !== e.meta.sharePass ||
        nextShareExpiresAt !== e.meta.shareExpiresAt;
      if (patch.title !== undefined) e.meta.title = patch.title;
      if (patch.icon !== undefined) e.meta.icon = patch.icon || undefined;
      if (patch.cover !== undefined) e.meta.cover = patch.cover || undefined;
      if (patch.public !== undefined) e.meta.public = patch.public || undefined;
      if (patch.sharePass !== undefined)
        e.meta.sharePass = patch.sharePass || undefined;
      if (patch.shareExpiresAt !== undefined)
        e.meta.shareExpiresAt = patch.shareExpiresAt || undefined;
      if (rotateShare)
        e.meta.shareVersion = (e.meta.shareVersion ?? 0) + 1;
      if (patch.category !== undefined)
        e.meta.category = patch.category || undefined;
      if (patch.pinned !== undefined) e.meta.pinned = patch.pinned || undefined;
      if (patch.status !== undefined) e.meta.status = patch.status || undefined;
      if (patch.view !== undefined) e.meta.view = patch.view || undefined;
      if (patch.font !== undefined)
        e.meta.font = patch.font || undefined;
      if (patch.smallText !== undefined)
        e.meta.smallText = patch.smallText || undefined;
      if (patch.fullWidth !== undefined)
        e.meta.fullWidth = patch.fullWidth || undefined;
      if (patch.sections !== undefined)
        e.meta.sections = patch.sections.length ? patch.sections : undefined;
      if (patch.tags !== undefined)
        e.meta.tags = patch.tags.length ? patch.tags : undefined;
      if (patch.stickers !== undefined)
        e.meta.stickers = patch.stickers.length ? patch.stickers : undefined;
      // A patch that changes nothing is not an edit: skip the `updated` stamp,
      // the disk write, the event, and the Git commit.
      if (JSON.stringify(e.meta) === before) return e.meta;
      if (patch.by) e.meta.updatedBy = patch.by;
      e.meta.updated = now();
      await this.persist(e);
      scheduleCommit(this.root);
      emitStore({ type: "meta", id, src: patch.src });
      return e.meta;
    });
  }

  /** Atomically establishes or revokes root-owned share authority. Enabling
   * requires the exact disclosure token shown to the owner; password, expiry,
   * and public visibility are persisted together so no unprotected public gap
   * can exist. Revocation deliberately does not depend on subtree shape. */
  async configureShare(
    id: string,
    input:
      | {
          enabled: true;
          expectedScopeToken: string;
          /** undefined preserves the disabled root's existing credential. */
          sharePass?: string | null;
          /** undefined preserves the disabled root's existing deadline. */
          shareExpiresAt?: string | null;
          src?: string;
        }
      | {
          enabled: false;
          src?: string;
        },
  ): Promise<void> {
    return this.mutate(async () => {
      const before = this.shareScopeSnapshot(id);
      if (
        input.enabled &&
        input.expectedScopeToken !== before.scopeToken
      ) {
        throw new ShareScopeConflictError(before);
      }
      const entry = this.get(id);
      if (
        input.enabled &&
        !entry.meta.public &&
        before.overlappingRoots.length > 0
      ) {
        throw new ShareScopeConflictError(before);
      }
      const nextPublic = input.enabled ? true : undefined;
      const nextSharePass = input.enabled
        ? input.sharePass === undefined
          ? entry.meta.sharePass
          : input.sharePass || undefined
        : entry.meta.sharePass;
      const nextShareExpiresAt = input.enabled
        ? input.shareExpiresAt === undefined
          ? entry.meta.shareExpiresAt
          : input.shareExpiresAt || undefined
        : entry.meta.shareExpiresAt;
      const rotateShare =
        nextPublic !== entry.meta.public ||
        nextSharePass !== entry.meta.sharePass ||
        nextShareExpiresAt !== entry.meta.shareExpiresAt;
      entry.meta.public = nextPublic;
      entry.meta.sharePass = nextSharePass;
      entry.meta.shareExpiresAt = nextShareExpiresAt;
      if (rotateShare) {
        entry.meta.shareVersion = (entry.meta.shareVersion ?? 0) + 1;
      }
      entry.meta.updatedBy = "me";
      entry.meta.updated = now();
      await this.persist(entry);
      scheduleCommit(this.root);
      emitStore({ type: "meta", id, src: input.src });
    });
  }

  /** Import-only collection metadata restore. Ordinary UI/MCP mutations keep
   * collection ownership closed; a fully validated portable bundle may restore
   * the existing narrow collection model after all page folders exist. */
  async applyPortableCollectionMeta(
    id: string,
    collectionInput?: unknown,
    rowInput?: unknown,
    src?: string,
  ): Promise<PageMeta> {
    const collection =
      collectionInput === undefined
        ? undefined
        : collectionDefinitionSchema.parse(collectionInput);
    const collectionRow =
      rowInput === undefined ? undefined : collectionRowSchema.parse(rowInput);
    if (collection && collectionRow) {
      throw new Error("a portable page cannot be both a collection and a row");
    }
    return this.mutate(async () => {
      const entry = this.get(id);
      if (collectionRow) {
        const parent = entry.parentId ? this.get(entry.parentId) : null;
        if (
          !parent?.meta.collection ||
          parent.meta.collection.databaseId !== collectionRow.databaseId
        ) {
          throw new Error("portable collection row has an invalid parent");
        }
      }
      if (collection !== undefined) entry.meta.collection = collection;
      if (collectionRow !== undefined) entry.meta.collectionRow = collectionRow;
      entry.meta.updated = now();
      entry.meta.updatedBy = "me";
      await this.persist(entry);
      scheduleCommit(this.root);
      emitStore({ type: "meta", id, src });
      return entry.meta;
    });
  }

  private validateManualMove(id: string, newParentId: string | null): void {
    // Collection membership is imported source metadata, not ordinary page
    // hierarchy. Manual UI/MCP moves must not silently turn a database row
    // into a normal page or place an unrelated page inside a collection.
    // The importer owns the mutation lock and calls movePageUnlocked while
    // applying its validated target metadata, so its placeholder phase stays
    // possible without weakening the public boundary.
    const entry = this.get(id);
    const targetCollection = newParentId
      ? this.get(newParentId).meta.collection
      : undefined;
    if (entry.meta.collectionRow) {
      if (
        !targetCollection ||
        targetCollection.databaseId !== entry.meta.collectionRow.databaseId
      ) {
        throw new Error("collection rows must stay inside their source collection");
      }
    } else if (targetCollection) {
      throw new Error("only source collection rows can be moved into a collection");
    }
  }

  /** Caller owns mutate(). Reject before any move intent or page file is read:
   * a configured public root may not gain a different configured public
   * ancestor. Existing legacy overlap can move within or out of that ancestor.
   * Deadlines are deliberately irrelevant because expired and malformed grants
   * remain configured authority until explicitly revoked. */
  private validateShareRootMove(id: string, newParentId: string | null): void {
    const source = this.get(id);
    if (source.parentId === newParentId || newParentId === null) return;

    const movingPublicRoots = [...this.index.values()]
      .filter(
        (entry) =>
          !!entry.meta.public && this.isWithinSubtree(id, entry.meta.id),
      )
      .map((entry) => ({
        rootId: entry.meta.id,
        existingPublicAncestors: (() => {
          const ids = new Set<string>();
          let ancestorId = entry.parentId;
          while (ancestorId) {
            const ancestor = this.get(ancestorId);
            if (ancestor.meta.public) ids.add(ancestorId);
            ancestorId = ancestor.parentId;
          }
          return ids;
        })(),
      }));
    if (movingPublicRoots.length === 0) return;

    let ancestorId: string | null = newParentId;
    while (ancestorId) {
      const candidateAncestorId = ancestorId;
      const ancestor = this.get(candidateAncestorId);
      if (
        ancestor.meta.public &&
        movingPublicRoots.some(
          ({ rootId, existingPublicAncestors }) =>
            rootId !== candidateAncestorId &&
            !existingPublicAncestors.has(candidateAncestorId),
        )
      ) {
        throw new Error("public share roots cannot overlap");
      }
      ancestorId = ancestor.parentId;
    }
  }

  /** Apply one board gesture as a crash-recoverable multi-page transaction.
   * The durable intent is written before the first page replacement and
   * removed only after every exact after-image is installed. */
  async mutateBoard(input: BoardMutationInput, src?: string): Promise<void> {
    return this.mutate(async () => {
      const board = this.get(input.boardId);
      if (this.isDeleted(input.boardId)) {
        throw new Error("cannot mutate a board in trash");
      }
      if (board.meta.view !== "board") {
        throw new Error("page is not a board");
      }
      const defaultColumns = ["Backlog", "In progress", "Done"];
      const columns = board.meta.sections?.length
        ? [...board.meta.sections]
        : defaultColumns;
      const patches = new Map<string, Partial<PageMeta>>();
      const columnName = (value: string, label: string) => {
        const normalized = value.trim();
        if (
          !normalized ||
          normalized.length > 120 ||
          /[\r\n]/.test(normalized)
        ) {
          throw new Error(`invalid ${label}`);
        }
        return normalized;
      };

      if (input.operation === "move-card") {
        const status = columnName(input.status, "board status");
        if (!columns.includes(status)) {
          throw new Error("target board column does not exist");
        }
        const card = this.get(input.cardId);
        if (card.parentId !== input.boardId || this.isDeleted(input.cardId)) {
          throw new Error("board card is not an active direct child");
        }
        if (input.beforeId === input.cardId) {
          throw new Error("board card cannot be placed before itself");
        }
        if (input.beforeId) {
          const before = this.get(input.beforeId);
          if (
            before.parentId !== input.boardId ||
            this.isDeleted(input.beforeId) ||
            (before.meta.status ?? columns[0]) !== status
          ) {
            throw new Error("before card is not in the target board column");
          }
        }
        patches.set(input.cardId, {
          status,
          order: this.orderForPlacement(
            input.boardId,
            input.beforeId,
            input.cardId,
          ),
        });
      } else if (input.operation === "rename-column") {
        const from = columnName(input.from, "source board column");
        const to = columnName(input.to, "target board column");
        if (!columns.includes(from)) {
          throw new Error("source board column does not exist");
        }
        if (from !== to && columns.includes(to)) {
          throw new Error("target board column already exists");
        }
        if (from === to) return;
        patches.set(input.boardId, {
          sections: columns.map((column) => (column === from ? to : column)),
        });
        for (const child of this.siblings(input.boardId)) {
          if ((child.meta.status ?? columns[0]) === from) {
            patches.set(child.meta.id, { status: to });
          }
        }
      } else {
        const name = columnName(input.name, "board column");
        const fallback = columnName(input.fallback, "fallback board column");
        if (!columns.includes(name)) {
          throw new Error("board column does not exist");
        }
        const rest = columns.filter((column) => column !== name);
        if (rest.length > 0 && !rest.includes(fallback)) {
          throw new Error("fallback board column does not exist");
        }
        if (rest.length === 0 && fallback !== defaultColumns[0]) {
          throw new Error("invalid fallback for the last board column");
        }
        patches.set(input.boardId, {
          sections: rest.length ? rest : undefined,
        });
        for (const child of this.siblings(input.boardId)) {
          if ((child.meta.status ?? columns[0]) === name) {
            patches.set(child.meta.id, { status: fallback });
          }
        }
      }

      const timestamp = now();
      const pages: BoardMutationIntent["pages"] = [];
      for (const [pageId, patch] of patches) {
        const entry = this.get(pageId);
        const indexFile = assertInRoot(
          this.root,
          path.join(entry.dir, "index.md"),
        );
        const beforeRaw = await fs.readFile(indexFile, "utf8");
        const parsed = parsePage(beforeRaw);
        if (parsed.meta.id !== pageId) {
          throw new Error(`board mutation page id mismatch: ${pageId}`);
        }
        const freshMeta = {
          ...entry.meta,
          ...parsed.meta,
          id: pageId,
          title: parsed.meta.title || entry.meta.title,
          order: parsed.meta.order || entry.meta.order,
          created: parsed.meta.created || entry.meta.created,
          updated: parsed.meta.updated || entry.meta.updated,
        } as PageMeta;
        const afterMeta = {
          ...freshMeta,
          ...patch,
          updated: timestamp,
          updatedBy: "me",
        } as PageMeta;
        if (patch.sections === undefined && pageId === input.boardId) {
          delete afterMeta.sections;
        }
        const afterRaw = serializePage(afterMeta, parsed.markdown);
        pages.push({
          pageId,
          indexFile: path.relative(this.root, indexFile),
          beforeRaw,
          beforeRev: hashRev(beforeRaw),
          afterRaw,
          afterRev: hashRev(afterRaw),
        });
      }
      const intent: BoardMutationIntent = {
        version: 1,
        operation: "board",
        boardId: input.boardId,
        pages,
      };
      const releaseGitBarrier = await beginGitSnapshotBarrier(this.root);
      let releaseSafe = false;
      try {
        try {
          await this.writeBoardIntent(intent);
          for (const page of pages) {
            await atomicWrite(
              moveIntentFile(this.root, page.indexFile),
              page.afterRaw,
            );
          }
          await this.clearBoardIntent();
        } catch (operationError) {
          try {
            await fs.stat(this.boardIntentPath());
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
              releaseSafe = true;
              throw operationError;
            }
            throw statError;
          }
          try {
            await this.reconcileBoardIntent();
            const completed = await Promise.all(
              pages.map(async (page) => {
                const current = await fs.readFile(
                  moveIntentFile(this.root, page.indexFile),
                  "utf8",
                );
                return current === page.afterRaw;
              }),
            );
            if (completed.some((value) => !value)) throw operationError;
          } catch (reconcileError) {
            this.mutationPoison = new Error(
              "Store mutations are blocked after board reconciliation failed",
            );
            throw new AggregateError(
              [operationError, reconcileError],
              "board mutation failed and could not be reconciled",
            );
          }
        }

        for (const page of pages) {
          const entry = this.get(page.pageId);
          entry.meta = parsePage(page.afterRaw).meta as PageMeta;
          emitStore({ type: "meta", id: page.pageId, src });
        }
        scheduleCommit(this.root);
        releaseSafe = true;
      } finally {
        if (releaseSafe) releaseGitBarrier();
      }
    });
  }

  async movePage(
    id: string,
    newParentId: string | null,
    beforeId?: string | null,
    src?: string,
    by: "me" | "claude" = "me",
  ): Promise<PageMeta> {
    return (
      await this.movePageWithBodyReport(id, newParentId, beforeId, src, by)
    ).meta;
  }

  /** `movePage` for the callers that have to tell a reader what the move did
   * to the old parent's document. Every other caller keeps the plain-meta
   * signature above. `by` is who asked: a cross-parent move rewrites up to
   * two other pages' bodies, and those pages carry it as their last editor. */
  async movePageWithBodyReport(
    id: string,
    newParentId: string | null,
    beforeId?: string | null,
    src?: string,
    by: "me" | "claude" = "me",
  ): Promise<PageMoveResult> {
    return this.mutate(async () => {
      this.validateManualMove(id, newParentId);
      this.validateShareRootMove(id, newParentId);
      const source = this.get(id);
      if (source.parentId !== newParentId) {
        return this.movePageWithBodyRefsUnlocked(
          id,
          newParentId,
          beforeId ?? null,
          src,
          by,
        );
      }
      // A reorder inside one parent changes no document. Where a page sits
      // among its siblings is the tree's business; the order of blocks in a
      // body is the author's.
      return {
        meta: await this.movePageUnlocked(
          id,
          newParentId,
          beforeId ?? null,
          src,
        ),
        unlinkedFrom: null,
      };
    });
  }

  /** Caller owns mutate(). A manual cross-parent move is one logical operation
   * over as many as three files: the hierarchy, the destination's visible
   * child block, and the old parent's body, which stops listing a page it no
   * longer has. Either all of them remain before the move or all of them
   * finish after it.
   *
   * Only a standalone reference paragraph leaves the old parent. A reference
   * written inside a sentence is prose, not structure, and no move edits a
   * sentence — `removeStandalonePageRefs` cannot match one. */
  private async movePageWithBodyRefsUnlocked(
    id: string,
    newParentId: string | null,
    beforeId: string | null,
    src: string | undefined,
    by: "me" | "claude",
  ): Promise<PageMoveResult> {
    const source = this.get(id);
    const originParentId = source.parentId;

    const destinationPage = newParentId === null ? null : this.get(newParentId);
    const destinationIndex = destinationPage
      ? assertInRoot(this.root, path.join(destinationPage.dir, "index.md"))
      : null;
    const destinationBeforeRaw = destinationIndex
      ? await fs.readFile(destinationIndex, "utf8")
      : null;
    const parsedDestination =
      destinationBeforeRaw === null ? null : parsePage(destinationBeforeRaw);
    // Existing references are user data. A retry or a deliberately duplicated
    // page block must not rewrite or deduplicate the destination body. And a
    // body that links the page anywhere — in a sentence as much as in a row —
    // already has it: the derived tail hides such a child and the editor
    // refuses to file it, so a move does not add a second reference either.
    const writesDestination =
      parsedDestination !== null &&
      !referencedPageIds(parsedDestination.markdown, this.publicOrigin).has(id);

    const originPage = originParentId ? this.get(originParentId) : null;
    const originIndex = originPage
      ? assertInRoot(this.root, path.join(originPage.dir, "index.md"))
      : null;
    const originBeforeRaw = originIndex
      ? await fs.readFile(originIndex, "utf8")
      : null;
    const parsedOrigin =
      originBeforeRaw === null ? null : parsePage(originBeforeRaw);
    const originSweep = parsedOrigin
      ? removeStandalonePageRefs(parsedOrigin.markdown, id, this.publicOrigin)
      : null;
    const writesOrigin = originSweep !== null && originSweep.removed > 0;

    if (!writesDestination && !writesOrigin) {
      return {
        meta: await this.movePageUnlocked(
          id,
          newParentId,
          beforeId,
          src,
        ),
        unlinkedFrom: null,
      };
    }

    const nextOrder = this.orderForPlacement(newParentId, beforeId, id);
    const targetDir = await availableUniqueDir(
      destinationPage ? destinationPage.dir : this.root,
      path.basename(source.dir),
    );
    const participantUpdated = [
      source.meta.updated,
      destinationPage?.meta.updated,
      originPage?.meta.updated,
    ]
      .map((value) => (value ? Date.parse(value) : Number.NaN))
      .filter((value) => Number.isFinite(value))
      .map((value) => value + 1);
    const operationUpdated = new Date(
      Math.max(Date.now(), ...participantUpdated),
    ).toISOString();

    const freshMeta = (
      parsed: { meta: Partial<PageMeta> },
      entry: Entry,
    ): PageMeta => ({
      ...parsed.meta,
      id: parsed.meta.id || entry.meta.id,
      title: parsed.meta.title || entry.meta.title,
      order: parsed.meta.order || entry.meta.order,
      created: parsed.meta.created || entry.meta.created,
      updated: operationUpdated,
      updatedBy: by,
    });

    let destinationRef: MoveIntent["destinationPageRef"];
    let nextDestinationMeta: PageMeta | null = null;
    if (writesDestination && destinationPage && destinationIndex) {
      const nextMarkdown = appendStandalonePageRef(
        parsedDestination!.markdown,
        `${source.meta.icon ? `${source.meta.icon} ` : ""}${source.meta.title}`,
        id,
        this.publicOrigin,
      );
      nextDestinationMeta = freshMeta(parsedDestination!, destinationPage);
      const afterRaw = serializePage(nextDestinationMeta, nextMarkdown);
      destinationRef = {
        pageId: newParentId!,
        indexFile: path.relative(this.root, destinationIndex),
        beforeRaw: destinationBeforeRaw!,
        beforeRev: hashRev(destinationBeforeRaw!),
        afterRaw,
        afterRev: hashRev(afterRaw),
      };
    }

    let originRef: MoveIntent["originPageRef"];
    let nextOriginMeta: PageMeta | null = null;
    if (writesOrigin && originPage && originIndex) {
      nextOriginMeta = freshMeta(parsedOrigin!, originPage);
      const afterRaw = serializePage(nextOriginMeta, originSweep!.markdown);
      originRef = {
        pageId: originParentId!,
        indexFile: path.relative(this.root, originIndex),
        beforeRaw: originBeforeRaw!,
        beforeRev: hashRev(originBeforeRaw!),
        afterRaw,
        afterRev: hashRev(afterRaw),
      };
    }

    const moveIntent: MoveIntent = {
      version: 1,
      pageId: id,
      originalDir: path.relative(this.root, source.dir),
      targetDir: path.relative(this.root, targetDir),
      originalParentId: originParentId,
      targetParentId: newParentId,
      nextOrder,
      updated: operationUpdated,
      ...(originRef ? { originPageRef: originRef } : {}),
      ...(destinationRef ? { destinationPageRef: destinationRef } : {}),
    };

    const releaseGitBarrier = await beginGitSnapshotBarrier(this.root);
    let releaseSafe = false;
    try {
      let moved: PageMeta;
      try {
        await this.writeMoveIntent(moveIntent);
        moved = await this.movePageUnlocked(
          id,
          newParentId,
          beforeId,
          src,
          moveIntent,
        );
        if (destinationRef && destinationIndex) {
          await atomicWrite(destinationIndex, destinationRef.afterRaw);
        }
        if (originRef && originIndex) {
          await atomicWrite(originIndex, originRef.afterRaw);
        }
        await this.clearMoveIntent();
      } catch (operationError) {
        let reconciledSource: Entry;
        try {
          await this.reconcileMoveIntent();
          await this.rebuild();
          reconciledSource = this.get(id);
        } catch (reconcileError) {
          this.mutationPoison = new Error(
            "Store mutations are blocked after move body reconciliation failed",
          );
          throw new AggregateError(
            [operationError, reconcileError],
            "move failed and its page bodies could not be reconciled",
          );
        }

        if (reconciledSource.parentId === newParentId) {
          moved = reconciledSource.meta;
        } else if (reconciledSource.parentId === moveIntent.originalParentId) {
          releaseSafe = true;
          throw operationError;
        } else {
          this.mutationPoison = new Error(
            "Store mutations are blocked by an unknown destination move state",
          );
          throw new AggregateError(
            [
              operationError,
              new Error(
                `page reconciled under unexpected parent: ${String(
                  reconciledSource.parentId,
                )}`,
              ),
            ],
            "move failed with an unknown hierarchy state",
          );
        }
      }

      if (nextDestinationMeta && newParentId) {
        this.get(newParentId).meta = nextDestinationMeta;
      }
      if (nextOriginMeta && originParentId) {
        this.get(originParentId).meta = nextOriginMeta;
      }
      emitStore({ type: "move", id, src });
      if (destinationRef && newParentId) {
        emitStore({
          type: "write",
          id: newParentId,
          rev: destinationRef.afterRev,
          src,
        });
      }
      if (originRef && originParentId) {
        emitStore({
          type: "write",
          id: originParentId,
          rev: originRef.afterRev,
          src,
        });
      }
      scheduleCommit(this.root);
      releaseSafe = true;
      return { meta: moved, unlinkedFrom: originRef ? originParentId : null };
    } finally {
      if (releaseSafe) releaseGitBarrier();
    }
  }

  /** Reflect an editor page-ref nesting gesture in body + hierarchy under one
   * durable intent, so restart can deterministically roll back or finish it. */
  async nestPageRef(
    sourceId: string,
    targetId: string,
    parentPageId: string,
    expectedParentRev: string,
    sourceOccurrence: number | null,
    sourceFingerprint: string | null,
    src?: string,
    scope: "sibling" | "tree" = "sibling",
  ): Promise<{ moved: PageMeta; parent: Page; removed: boolean }> {
    return this.mutate(async () => {
      const source = this.get(sourceId);
      const target = this.get(targetId);
      const parent = this.get(parentPageId);

      if (sourceId === targetId) {
        throw new PageRefNestValidationError("cannot nest a page into itself");
      }
      if (sourceId === parentPageId || targetId === parentPageId) {
        throw new PageRefNestValidationError(
          "nesting pages must be children of the current page",
        );
      }
      if (
        this.isDeleted(sourceId) ||
        this.isDeleted(targetId) ||
        this.isDeleted(parentPageId)
      ) {
        throw new PageRefNestValidationError("cannot nest pages in trash");
      }
      const movesSource =
        source.parentId === parentPageId && target.parentId === parentPageId;
      const cleansAlreadyNestedSource =
        source.parentId === targetId && target.parentId === parentPageId;
      const cleansAlreadyTreeTargetSource =
        scope === "tree" && source.parentId === targetId;
      const cleanupOnly =
        scope === "tree"
          ? cleansAlreadyTreeTargetSource
          : cleansAlreadyNestedSource;
      const movesSourceToTreeTarget =
        scope === "tree" &&
        targetId !== source.parentId;
      if (
        scope === "tree" &&
        this.isDescendant(targetId, sourceId)
      ) {
        throw new PageRefNestValidationError(
          "cannot nest a page into its own descendant",
        );
      }
      if (
        scope === "tree" &&
        this.isDescendant(parentPageId, sourceId)
      ) {
        throw new PageRefNestValidationError(
          "cannot move a page using a reference owned by its own descendant",
        );
      }
      if (
        scope === "sibling"
          ? !movesSource && !cleansAlreadyNestedSource
          : !movesSourceToTreeTarget && !cleansAlreadyTreeTargetSource
      ) {
        throw new PageRefNestValidationError(
          scope === "tree"
            ? "the moved page cannot stay under its current parent"
            : "nesting pages must be direct siblings or already nested",
        );
      }
      if (source.meta.collectionRow) {
        throw new PageRefNestValidationError(
          "collection rows must stay inside their source collection",
        );
      }
      if (target.meta.collection || target.meta.collectionRow) {
        throw new PageRefNestValidationError(
          "pages cannot be nested into a collection",
        );
      }
      const synthesized =
        sourceOccurrence === null && sourceFingerprint === null;
      if (
        scope === "tree" &&
        source.parentId !== parentPageId &&
        synthesized
      ) {
        throw new PageRefNestValidationError(
          "moving a page from another branch requires an exact source page reference selection",
        );
      }
      if (cleanupOnly && synthesized) {
        throw new PageRefNestValidationError(
          "already nested cleanup requires an exact source page reference selection",
        );
      }
      if (
        !synthesized &&
        (!Number.isSafeInteger(sourceOccurrence) ||
          sourceOccurrence === null ||
          sourceOccurrence < 0 ||
          typeof sourceFingerprint !== "string" ||
          !sourceFingerprint)
      ) {
        throw new PageRefNestValidationError(
          "invalid source page reference selection",
        );
      }

      if (!cleanupOnly) {
        this.validateShareRootMove(sourceId, targetId);
      }

      const parentIndex = assertInRoot(
        this.root,
        path.join(parent.dir, "index.md"),
      );
      const originalRaw = await fs.readFile(parentIndex, "utf8");
      const currentRev = hashRev(originalRaw);
      if (currentRev !== expectedParentRev) {
        throw new RevConflictError(currentRev, expectedParentRev);
      }

      const parsed = parsePage(originalRaw);
      const originalParentMeta = parent.meta;
      const freshParentMeta = {
        ...parsed.meta,
        id: parsed.meta.id || originalParentMeta.id,
        title: parsed.meta.title || originalParentMeta.title,
        order: parsed.meta.order || originalParentMeta.order,
        created: parsed.meta.created || originalParentMeta.created,
        updated: parsed.meta.updated || originalParentMeta.updated,
      } as PageMeta;
      const fingerprints = standalonePageRefOccurrences(
        parsed.markdown,
        sourceId,
        this.publicOrigin,
      );
      if (synthesized && fingerprints.length > 0) {
        throw new PageRefNestValidationError(
          "source page reference selection does not match the parent revision",
        );
      }
      if (
        !synthesized &&
        fingerprints[sourceOccurrence!] !== sourceFingerprint
      ) {
        throw new PageRefNestValidationError(
          "source page reference selection does not match the parent revision",
        );
      }
      const removal = synthesized
        ? { markdown: parsed.markdown, removed: false }
        : removeStandalonePageRefOccurrence(
            parsed.markdown,
            sourceId,
            sourceOccurrence!,
            sourceFingerprint!,
            this.publicOrigin,
          );
      if (!synthesized && !removal.removed) {
        throw new PageRefNestValidationError(
          "source page reference selection does not match the parent revision",
        );
      }

      // A child page is a real block in Brain, not just a filesystem/tree
      // relationship. Moving a page onto another page must therefore install
      // the page block in the destination body in the same durable intent.
      // Existing blocks are preserved so retries remain idempotent.
      const targetIndex = assertInRoot(
        this.root,
        path.join(target.dir, "index.md"),
      );
      const originalTargetRaw = await fs.readFile(targetIndex, "utf8");
      const parsedTarget = parsePage(originalTargetRaw);
      const freshTargetMeta = {
        ...parsedTarget.meta,
        id: parsedTarget.meta.id || target.meta.id,
        title: parsedTarget.meta.title || target.meta.title,
        order: parsedTarget.meta.order || target.meta.order,
        created: parsedTarget.meta.created || target.meta.created,
        updated: parsedTarget.meta.updated || target.meta.updated,
      } as PageMeta;
      // The same rule as a move: a body that links the page anywhere has it.
      const targetAlreadyReferencesSource = referencedPageIds(
        parsedTarget.markdown,
        this.publicOrigin,
      ).has(sourceId);
      const nextTargetMarkdown = targetAlreadyReferencesSource
        ? parsedTarget.markdown
        : appendStandalonePageRef(
            parsedTarget.markdown,
            `${source.meta.icon ? `${source.meta.icon} ` : ""}${source.meta.title}`,
            sourceId,
            this.publicOrigin,
          );

      const previousUpdated = Date.parse(freshParentMeta.updated);
      const operationUpdated = new Date(
        Math.max(
          Date.now(),
          Number.isFinite(previousUpdated) ? previousUpdated + 1 : Date.now(),
        ),
      ).toISOString();
      const nextParentMeta: PageMeta = {
        ...freshParentMeta,
        updated: operationUpdated,
        updatedBy: "me",
        structureWriteBarrier: removal.removed ? undefined : true,
      };
      const nextParentRaw = serializePage(nextParentMeta, removal.markdown);
      const nextParentRev = hashRev(nextParentRaw);
      const originalTargetRev = hashRev(originalTargetRaw);
      const nextTargetMeta: PageMeta = targetAlreadyReferencesSource
        ? freshTargetMeta
        : {
            ...freshTargetMeta,
            updated: operationUpdated,
            updatedBy: "me",
          };
      const nextTargetRaw = targetAlreadyReferencesSource
        ? originalTargetRaw
        : serializePage(nextTargetMeta, nextTargetMarkdown);
      const nextTargetRev = hashRev(nextTargetRaw);
      if (nextParentRev === currentRev) {
        throw new Error("page-ref nesting did not advance the parent revision");
      }
      if (cleanupOnly) {
        const releaseGitBarrier = await beginGitSnapshotBarrier(this.root);
        let releaseSafe = false;
        try {
          if (targetAlreadyReferencesSource) {
            // The destination already owns a visible child block, so cleanup
            // touches only the stale reference owner and remains one atomic
            // page replacement.
            await atomicWrite(parentIndex, nextParentRaw);
          } else {
            // The hierarchy may already have moved while the destination body
            // did not. Persist one two-page intent before removing the stale
            // source block so a crash can only finish both page writes, never
            // expose a tree/body split.
            const pages: BoardMutationIntent["pages"] = [
              {
                pageId: parentPageId,
                indexFile: path.relative(this.root, parentIndex),
                beforeRaw: originalRaw,
                beforeRev: currentRev,
                afterRaw: nextParentRaw,
                afterRev: nextParentRev,
              },
              {
                pageId: targetId,
                indexFile: path.relative(this.root, targetIndex),
                beforeRaw: originalTargetRaw,
                beforeRev: originalTargetRev,
                afterRaw: nextTargetRaw,
                afterRev: nextTargetRev,
              },
            ];
            const intent: BoardMutationIntent = {
              version: 1,
              operation: "page-ref-cleanup",
              boardId: targetId,
              pages,
            };
            try {
              await this.writeBoardIntent(intent);
              for (const page of pages) {
                await atomicWrite(
                  moveIntentFile(this.root, page.indexFile),
                  page.afterRaw,
                );
              }
              await this.clearBoardIntent();
            } catch (operationError) {
              try {
                await fs.stat(this.boardIntentPath());
              } catch (statError) {
                if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
                  releaseSafe = true;
                  throw operationError;
                }
                throw statError;
              }
              try {
                await this.reconcileBoardIntent();
                const completed = await Promise.all(
                  pages.map(async (page) => {
                    const current = await fs.readFile(
                      moveIntentFile(this.root, page.indexFile),
                      "utf8",
                    );
                    return current === page.afterRaw;
                  }),
                );
                if (completed.some((value) => !value)) throw operationError;
              } catch (reconcileError) {
                this.mutationPoison = new Error(
                  "Store mutations are blocked after page-ref cleanup reconciliation failed",
                );
                throw new AggregateError(
                  [operationError, reconcileError],
                  "page-ref cleanup failed and could not be reconciled",
                );
              }
            }
          }

          parent.meta = nextParentMeta;
          if (!targetAlreadyReferencesSource) {
            target.meta = nextTargetMeta;
          }
          releaseSafe = true;
          scheduleCommit(this.root);
          emitStore({
            type: "write",
            id: parentPageId,
            rev: nextParentRev,
            src,
          });
          if (!targetAlreadyReferencesSource) {
            emitStore({
              type: "write",
              id: targetId,
              rev: nextTargetRev,
              src,
            });
          }
          return {
            moved: source.meta,
            removed: removal.removed,
            parent: {
              meta: nextParentMeta,
              markdown: removal.markdown.trimEnd(),
              rev: nextParentRev,
            },
          };
        } finally {
          if (releaseSafe) {
            releaseGitBarrier();
          }
        }
      }
      const nextOrder = this.orderForPlacement(targetId, null, sourceId);
      const originalDir = source.dir;
      const targetParentDir = target.dir;
      const destination = await availableUniqueDir(
        targetParentDir,
        path.basename(originalDir),
      );
      const moveIntent: MoveIntent = {
        version: 1,
        pageId: sourceId,
        originalDir: path.relative(this.root, originalDir),
        targetDir: path.relative(this.root, destination),
        originalParentId: source.parentId,
        targetParentId: targetId,
        nextOrder,
        updated: operationUpdated,
        pageRefNest: {
          parentPageId,
          parentIndex: path.relative(this.root, parentIndex),
          originalParentRaw: originalRaw,
          originalParentRev: currentRev,
          nextParentRaw,
          nextParentRev,
          removed: removal.removed,
          ...(!targetAlreadyReferencesSource
            ? {
                targetPage: {
                  pageId: targetId,
                  indexFile: path.relative(this.root, targetIndex),
                  beforeRaw: originalTargetRaw,
                  beforeRev: originalTargetRev,
                  afterRaw: nextTargetRaw,
                  afterRev: nextTargetRev,
                },
              }
            : {}),
        },
      };
      const releaseGitBarrier = await beginGitSnapshotBarrier(this.root);
      let releaseSafe = false;
      try {
        let moved: PageMeta;
        try {
          await this.writeMoveIntent(moveIntent);
          // The durable combined intent comes first. Child placement commits
          // second, the exact parent body third, and intent removal is the final
          // acknowledgement. Startup can therefore roll back an original-dir
          // state or finish a target-dir state without guessing.
          moved = await this.movePageUnlocked(
            sourceId,
            targetId,
            null,
            src,
            moveIntent,
          );
          await atomicWrite(parentIndex, nextParentRaw);
          if (!targetAlreadyReferencesSource) {
            await atomicWrite(targetIndex, nextTargetRaw);
          }
          await this.clearMoveIntent();
        } catch (operationError) {
          let reconciledSource: Entry;
          try {
            await this.reconcileMoveIntent();
            await this.rebuild();
            reconciledSource = this.get(sourceId);
          } catch (reconcileError) {
            this.mutationPoison = new Error(
              "Store mutations are blocked after page-ref nesting reconciliation failed",
            );
            throw new AggregateError(
              [operationError, reconcileError],
              "page-ref nesting failed and its move state could not be reconciled",
            );
          }

          if (reconciledSource.parentId === targetId) {
            moved = reconciledSource.meta;
          } else if (
            reconciledSource.parentId === moveIntent.originalParentId
          ) {
            releaseSafe = true;
            throw operationError;
          } else {
            this.mutationPoison = new Error(
              "Store mutations are blocked by an unknown page-ref nesting state",
            );
            throw new AggregateError(
              [
                operationError,
                new Error(
                  `page-ref source reconciled under unexpected parent: ${String(
                    reconciledSource.parentId,
                  )}`,
                ),
              ],
              "page-ref nesting failed with an unknown hierarchy state",
            );
          }
        }

        releaseSafe = true;
        const authoritativeParentMeta = nextParentMeta;
        this.get(parentPageId).meta = authoritativeParentMeta;
        if (!targetAlreadyReferencesSource) {
          this.get(targetId).meta = nextTargetMeta;
        }
        const parentRev = nextParentRev;
        emitStore({ type: "move", id: sourceId, src });
        emitStore({ type: "write", id: parentPageId, rev: parentRev, src });
        if (!targetAlreadyReferencesSource) {
          emitStore({ type: "write", id: targetId, rev: nextTargetRev, src });
        }
        return {
          moved,
          removed: removal.removed,
          parent: {
            meta: authoritativeParentMeta,
            markdown: removal.markdown.trimEnd(),
            rev: parentRev,
          },
        };
      } finally {
        if (releaseSafe) {
          // Queue one coherent Git snapshot only after the child hierarchy,
          // exact parent body, and recovery intent agree on the outcome.
          scheduleCommit(this.root);
          releaseGitBarrier();
        }
      }
    });
  }

  /** Caller owns mutate(). */
  private async movePageUnlocked(
    id: string,
    newParentId: string | null,
    beforeId: string | null,
    src?: string,
    preparedIntent?: MoveIntent,
  ): Promise<PageMeta> {
    const e = this.get(id);
    if (newParentId === id) throw new Error("cannot move a page into itself");
    if (newParentId && this.isDescendant(newParentId, id)) {
      throw new Error("cannot move a page into its own descendant");
    }
    if (newParentId && this.isDeleted(newParentId)) {
      throw new Error("cannot move a page into trash");
    }
    // Validate beforeId before any filesystem mutation.
    const nextOrder =
      preparedIntent?.nextOrder ??
      this.orderForPlacement(newParentId, beforeId, id);
    const originalParentId = e.parentId;
    const originalDir = e.dir;
    const originalMeta = { ...e.meta };
    const originalRaw = await fs.readFile(
      assertInRoot(this.root, path.join(originalDir, "index.md")),
      "utf8",
    );
    const moveUpdated = preparedIntent?.updated ?? now();
    let moved = false;
    let targetParentDirectory: string | undefined;
    let oldParentDir: string | undefined;
    let moveIntent: MoveIntent | undefined;
    const remapDirectories = (from: string, to: string) => {
      for (const entry of this.index.values()) {
        if (entry.dir === from) entry.dir = to;
        else if (entry.dir.startsWith(from + path.sep)) {
          entry.dir = to + entry.dir.slice(from.length);
        }
      }
    };
    if (originalParentId !== newParentId) {
      const targetParentDir = newParentId
        ? this.get(newParentId).dir
        : this.root;
      const sourceParentDir = path.dirname(originalDir);
      const dest = preparedIntent
        ? moveIntentDirectory(this.root, preparedIntent.targetDir)
        : await uniqueDir(targetParentDir, path.basename(originalDir));
      if (preparedIntent) {
        if (
          preparedIntent.pageId !== id ||
          moveIntentDirectory(this.root, preparedIntent.originalDir) !==
            originalDir ||
          path.dirname(dest) !== targetParentDir ||
          preparedIntent.originalParentId !== originalParentId ||
          preparedIntent.targetParentId !== newParentId ||
          preparedIntent.nextOrder !== nextOrder
        ) {
          throw new Error("prepared move intent does not match the requested move");
        }
        moveIntent = preparedIntent;
      } else {
        moveIntent = {
          version: 1,
          pageId: id,
          originalDir: path.relative(this.root, originalDir),
          targetDir: path.relative(this.root, dest),
          originalParentId,
          targetParentId: newParentId,
          nextOrder,
          updated: moveUpdated,
        };
        try {
          await this.writeMoveIntent(moveIntent);
        } catch (error) {
          await fs.rmdir(dest).catch(() => undefined);
          await syncDirectory(targetParentDir).catch(() => undefined);
          throw error;
        }
      }
      try {
        await fs.rename(originalDir, dest);
      } catch (error) {
        const [sourceVisible, targetVisible] = await Promise.all([
          readOptionalFile(path.join(originalDir, "index.md")),
          readOptionalFile(path.join(dest, "index.md")),
        ]);
        if (sourceVisible !== null && targetVisible === null) {
          if (!isCompositeMoveIntent(moveIntent)) {
            await fs.rmdir(dest).catch(() => undefined);
            await syncDirectory(targetParentDir).catch(() => undefined);
            await this.clearMoveIntent().catch(() => undefined);
          }
        }
        // If targetVisible is present, the rename happened despite the error.
        // Leave the durable intent for startup instead of guessing or claiming
        // success. Ambiguous/missing locations also remain fail-closed.
        throw error;
      }
      remapDirectories(originalDir, dest);
      e.parentId = newParentId;
      moved = true;
      // Assign outer-scope values only after the rename has installed dest.
      targetParentDirectory = targetParentDir;
      oldParentDir = sourceParentDir;
    }
    const nextMeta: PageMeta = {
      ...originalMeta,
      order: nextOrder,
      updated: moveUpdated,
    };
    const nextContent = serializePage(nextMeta, parsePage(originalRaw).markdown);
    try {
      if (moved) {
        await syncDirectory(oldParentDir!);
        if (targetParentDirectory !== oldParentDir) {
          await syncDirectory(targetParentDirectory!);
        }
      }
      await atomicWrite(
        assertInRoot(this.root, path.join(e.dir, "index.md")),
        nextContent,
      );
    } catch (error) {
      let rollbackHealthy = true;
      try {
        await atomicWrite(
          assertInRoot(this.root, path.join(e.dir, "index.md")),
          originalRaw,
        );
      } catch {
        rollbackHealthy = false;
      }
      if (moved) {
        const movedDir = e.dir;
        try {
          await fs.rename(movedDir, originalDir);
          remapDirectories(movedDir, originalDir);
          e.parentId = originalParentId;
          await syncDirectory(path.dirname(originalDir));
          if (path.dirname(movedDir) !== path.dirname(originalDir)) {
            await syncDirectory(path.dirname(movedDir));
          }
        } catch {
          rollbackHealthy = false;
        }
      }
      e.meta = originalMeta;
      if (rollbackHealthy && moveIntent && !isCompositeMoveIntent(moveIntent)) {
        try {
          await this.clearMoveIntent();
        } catch {
          rollbackHealthy = false;
        }
      }
      if (!rollbackHealthy) {
        // Never leave the in-memory writer pointing at a path/order different
        // from disk, even when rollback itself encounters an I/O failure.
        try {
          if (moveIntent) await this.reconcileMoveIntent();
          await this.rebuild();
        } catch (recoveryError) {
          throw new AggregateError(
            [error, recoveryError],
            "move failed and Store reconciliation also failed",
          );
        }
      }
      throw error;
    }
    e.meta = nextMeta;
    if (moveIntent && !isCompositeMoveIntent(moveIntent)) {
      await this.clearMoveIntent();
    }
    if (!isCompositeMoveIntent(moveIntent)) {
      scheduleCommit(this.root);
      emitStore({ type: "move", id, src });
    }
    return e.meta;
  }

  /** Soft delete — mark the page (and thus its subtree) as trashed. Hidden from
   *  the tree via siblings(), recoverable until purged. */
  async deletePage(id: string, src?: string): Promise<void> {
    return this.mutate(async () => {
      const e = this.get(id);
      const deletedAt = now();
      const subtree = [...this.index.values()]
        .filter(
          (entry) =>
            entry.dir === e.dir || entry.dir.startsWith(e.dir + path.sep),
        );
      for (const entry of subtree) {
        if (entry.meta.notionImportToken) {
          await this.removeNotionStaging(entry.meta.notionImportToken);
        }
      }
      // Sharing is disabled and persisted before the root receives its trash
      // marker. If any write fails, delete fails visibly and no still-public
      // page is hidden under a deleted ancestor.
      for (const entry of subtree) {
        const hadSharing = Boolean(
          entry.meta.public ||
            entry.meta.sharePass ||
            entry.meta.shareExpiresAt,
        );
        if (hadSharing) {
          entry.meta.public = undefined;
          entry.meta.sharePass = undefined;
          entry.meta.shareExpiresAt = undefined;
          entry.meta.shareVersion = (entry.meta.shareVersion ?? 0) + 1;
          entry.meta.updated = deletedAt;
          await this.persist(entry);
        }
      }
      e.meta.deleted = deletedAt;
      e.meta.updated = deletedAt;
      await this.persist(e);
      scheduleCommit(this.root);
      emitStore({ type: "delete", id, src });
    });
  }

  async restorePage(id: string, src?: string): Promise<void> {
    return this.mutate(async () => {
      const e = this.get(id);
      // Deletion marks only the subtree root; descendants are trashed through
      // the ancestor walk in isDeleted(). Clearing one flag under a still-
      // deleted ancestor used to "succeed" while the page stayed invisible —
      // and Empty Trash then destroyed it with the ancestor. Restore therefore
      // clears every deleted ancestor too: restoring means the page is
      // visible again, exactly where it was (the Notion model).
      const restoredIds: string[] = [];
      let current: Entry | undefined = e;
      while (current) {
        if (current.meta.deleted) {
          current.meta.deleted = undefined;
          current.meta.updated = now();
          await this.persist(current);
          restoredIds.push(current.meta.id);
        }
        current = current.parentId
          ? this.index.get(current.parentId)
          : undefined;
      }
      scheduleCommit(this.root);
      emitStore({ type: "create", id, src });
      for (const restoredId of restoredIds) {
        if (restoredId !== id) {
          emitStore({ type: "create", id: restoredId, src });
        }
      }
    });
  }

  /** Permanent removal — delete the folder + subtree from disk and index. */
  async purgePage(id: string): Promise<void> {
    return this.mutate(async () => {
      const e = this.get(id);
      // A Trash dialog can be stale, or another tab can restore between listing
      // and confirmation. Permanent deletion is legal only while the mutation
      // lock still observes this exact page as deleted.
      if (!e.meta.deleted) {
        throw new Error(`cannot purge active page: ${id}`);
      }
      await this.purgeEntry(e);
      await this.sweepUnreferencedAttachmentsUnlocked();
    });
  }

  /** Permanently remove an already-validated trash root. Caller owns mutate(). */
  private async purgeEntry(e: Entry): Promise<void> {
    const id = e.meta.id;
    const dir = assertInRoot(this.root, e.dir);
    const subtree = [...this.index.values()].filter(
      (entry) => entry.dir === dir || entry.dir.startsWith(dir + path.sep),
    );
    for (const entry of subtree) {
      if (entry.meta.notionAbortId) {
        notionAbortReceipt(entry.meta);
        throw new NotionImportConflictError(
          "abort_ack_required",
          `cannot purge a page with an unacknowledged notion abort: ${entry.meta.id}`,
        );
      }
    }
    for (const entry of subtree) {
      if (entry.meta.notionImportToken) {
        await this.removeNotionStaging(entry.meta.notionImportToken);
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
    for (const [key, entry] of this.index) {
      if (entry.dir === dir || entry.dir.startsWith(dir + path.sep)) {
        if (entry.meta.notionId) {
          this.notionIndex.delete(normalizeNotionId(entry.meta.notionId));
        }
        if (entry.meta.notionAbortId) {
          this.abortReceiptIndex.delete(
            normalizeNotionId(entry.meta.notionAbortId),
          );
        }
        this.index.delete(key);
      }
    }
    await syncDirectory(path.dirname(dir));
    scheduleCommit(this.root);
    emitStore({ type: "delete", id });
  }

  /** Roots of trashed subtrees (a deleted page under a deleted parent isn't
   *  listed separately). Most-recently-deleted first. */
  trashList(): { id: string; title: string; icon?: string; deleted: string }[] {
    // Root detection walks the whole ancestor chain, not just the immediate
    // parent: a flagged page inside another trashed subtree is not separately
    // restorable, so listing it implied an operation that could not work.
    // It surfaces as its own root once the outer subtree is restored.
    return [...this.index.values()]
      .filter(
        (e) =>
          e.meta.deleted && !(e.parentId && this.isDeleted(e.parentId)),
      )
      .sort((a, b) => (a.meta.deleted! > b.meta.deleted! ? -1 : 1))
      .map((e) => ({
        id: e.meta.id,
        title: e.meta.title,
        icon: e.meta.icon,
        deleted: e.meta.deleted!,
      }));
  }

  async emptyTrash(): Promise<void> {
    return this.mutate(async () => {
      // Snapshot and purge under one lock. A restore queued before this operation
      // runs first and disappears from trashList; a later restore sees NotFound.
      // There is no ordering in which restore succeeds and a stale purge follows.
      const items = this.trashList();
      const selected = items
        .map((item) => this.index.get(item.id))
        .filter((entry): entry is Entry => Boolean(entry?.meta.deleted));
      for (const root of selected) {
        for (const entry of this.index.values()) {
          if (
            (entry.dir === root.dir ||
              entry.dir.startsWith(root.dir + path.sep)) &&
            entry.meta.notionAbortId
          ) {
            notionAbortReceipt(entry.meta);
            throw new NotionImportConflictError(
              "abort_ack_required",
              "cannot empty trash while a Notion abort is unacknowledged",
            );
          }
        }
      }
      for (const item of items) {
        const entry = this.index.get(item.id);
        if (entry?.meta.deleted) await this.purgeEntry(entry);
      }
      await this.sweepUnreferencedAttachmentsUnlocked();
    });
  }

  /** Attachments are shared files in one directory; pages only reference
   *  them, and purging a page folder never touched the files, so every
   *  deletion left its attachments behind and nothing ever collected them.
   *  After every permanent deletion, remove files no page — live or
   *  trashed — references any more. The reference tokenizer is the same one that authorizes
   *  /api/media reads, so a file outside this set cannot be served at all
   *  and deleting it cannot break a rendered page. Caller owns mutate(). */
  private async sweepUnreferencedAttachmentsUnlocked(
    graceMs = ATTACHMENT_SWEEP_GRACE_MS,
  ): Promise<number> {
    const directory = path.join(this.root, "_attachments");
    let names: string[];
    try {
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    const referenced = new Set<string>();
    const addUrl = (url: string | undefined) => {
      if (!url) return;
      const name = localAttachmentName(url);
      if (name) referenced.add(name);
    };
    for (const entry of this.index.values()) {
      // Trashed pages keep their attachments — restore must stay lossless.
      addUrl(entry.meta.cover);
      addUrl(entry.meta.notionImportOwnedCover);
      let raw: string;
      try {
        raw = await fs.readFile(path.join(entry.dir, "index.md"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of referencedAttachmentNames(parsePage(raw).markdown)) {
        referenced.add(name);
      }
    }
    const cutoff = Date.now() - graceMs;
    let removed = 0;
    for (const name of names) {
      if (referenced.has(name)) continue;
      // Only well-formed attachment names are ever considered.
      if (localAttachmentName(`/_attachments-v2/${name}`) !== name) continue;
      const file = path.join(directory, name);
      let stat: Stats;
      try {
        stat = await fs.lstat(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.mtimeMs > cutoff) continue;
      await fs.rm(file, { force: true });
      removed += 1;
    }
    if (removed > 0) {
      await syncDirectory(directory);
      scheduleCommit(this.root);
    }
    return removed;
  }

  // ── version history (git) ───────────────────────────
  private relIndex(id: string): string {
    const e = this.get(id);
    return path.relative(this.root, path.join(e.dir, "index.md"));
  }

  /** Commit history of this page's index.md, newest first. */
  history(id: string): Promise<Version[]> {
    return logForPath(this.root, this.relIndex(id));
  }

  /** Resolve an optimistic-concurrency token to a trusted historical body.
   * The search is deliberately limited to the same capped history used by the
   * version UI. `showPageAtRevision` also verifies the immutable page id, so a
   * moved page or a path later reused by another page cannot supply the base. */
  async historicalMarkdownForRev(
    id: string,
    revision: string,
  ): Promise<string | null> {
    if (!REV_TOKEN_RE.test(revision)) return null;
    const currentRel = this.relIndex(id);
    const versions = await logForPath(this.root, currentRel);
    for (const version of versions) {
      const raw = await showPageAtRevision(
        this.root,
        version.sha,
        currentRel,
        id,
      );
      if (raw && hashRev(raw) === revision) return parsePage(raw).markdown;
    }
    return null;
  }

  /** The page's markdown body as it was at a given commit. */
  async markdownAt(id: string, sha: string): Promise<string | null> {
    const raw = await showPageAtRevision(
      this.root,
      sha,
      this.relIndex(id),
      id,
    );
    if (!raw) return null;
    return parsePage(raw).markdown;
  }

  /** Roll the page body back to a past version (writes it as the current one). */
  async restoreVersion(
    id: string,
    sha: string,
    expectedRev: string,
    src?: string,
  ): Promise<Page> {
    const md = await this.markdownAt(id, sha);
    if (md === null) throw new NotFoundError(id);
    return this.writePage(id, md, expectedRev, "me", src);
  }

  private isDescendant(id: string, ancestorId: string): boolean {
    let cur: string | null = id;
    while (cur) {
      if (cur === ancestorId) return true;
      cur = this.index.get(cur)?.parentId ?? null;
    }
    return false;
  }
}

function deslug(name: string): string {
  return name
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

async function uniqueDir(parentDir: string, base: string): Promise<string> {
  let name = base;
  let n = 1;
  for (;;) {
    const dir = path.join(parentDir, name);
    try {
      await fs.mkdir(dir, { recursive: false });
      try {
        await syncDirectory(parentDir);
      } catch (error) {
        await fs.rmdir(dir).catch(() => undefined);
        throw error;
      }
      return dir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      name = `${base}-${++n}`;
    }
  }
}

/** Pick a free destination without touching the tree. The combined page-ref
 * intent must be durable before its first filesystem mutation; the Store mutex
 * is the only supported writer, so the read-only reservation stays stable. */
async function availableUniqueDir(
  parentDir: string,
  base: string,
): Promise<string> {
  let name = base;
  let n = 1;
  for (;;) {
    const dir = path.join(parentDir, name);
    try {
      await fs.lstat(dir);
      name = `${base}-${++n}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return dir;
      throw error;
    }
  }
}

const BLOCKED_ATTACHMENT_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
  "application/xml",
  "text/xml",
  "image/svg+xml",
]);

function normalizeNotionId(input: string): string {
  const notionId = input.replace(/-/g, "").toLowerCase();
  if (!NOTION_ID_RE.test(notionId)) {
    throw new NotionImportConflictError(
      "invalid_notion_id",
      "notionId must be a 32-character hexadecimal id",
    );
  }
  return notionId;
}

function normalizeOptionalNotionId(input: unknown): string | undefined {
  return typeof input === "string" ? normalizeNotionId(input) : undefined;
}

function normalizeSourceHash(input: string): string {
  const sourceHash = input.toLowerCase();
  if (!SOURCE_HASH_RE.test(sourceHash)) {
    throw new NotionImportConflictError(
      "invalid_source_hash",
      "sourceHash must be a 64-character sha256 hex digest",
    );
  }
  return sourceHash;
}

function normalizeReservationToken(input: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input)) {
    throw new NotionImportConflictError(
      "reservation_mismatch",
      "invalid notion reservation token",
    );
  }
  return input;
}

function assertNotionPlacementId(
  value: string | null,
  field: "parentId" | "beforeId",
): void {
  if (
    value !== null &&
    (!PAGE_ID_RE.test(value) || value.length < 1 || value.length > 128)
  ) {
    throw new NotionImportConflictError(
      "reservation_mismatch",
      `${field} must be null or a valid Brain page id`,
    );
  }
}

function reservationTokenMatches(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function reservationTokenSha256(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function reservationTokenHashMatches(token: string, expectedHash: string): boolean {
  if (!SOURCE_HASH_RE.test(expectedHash)) return false;
  return timingSafeEqual(
    Buffer.from(reservationTokenSha256(token), "hex"),
    Buffer.from(expectedHash, "hex"),
  );
}

function notionAbortReceipt(meta: Partial<PageMeta>): NotionAbortReceipt | undefined {
  const hasAny = NOTION_ABORT_META_FIELDS.some(
    (field) => meta[field] !== undefined,
  );
  if (!hasAny) return undefined;
  if (
    typeof meta.notionAbortId !== "string" ||
    typeof meta.notionAbortSourceHash !== "string" ||
    typeof meta.notionAbortTokenSha256 !== "string" ||
    (meta.notionAbortStatus !== "detached" &&
      meta.notionAbortStatus !== "aborted") ||
    typeof meta.notionAbortStagingRemoved !== "boolean" ||
    typeof meta.notionAbortCompletedAt !== "string" ||
    !Number.isFinite(Date.parse(meta.notionAbortCompletedAt))
  ) {
    throw new Error("invalid notion abort receipt fields");
  }
  const notionId = normalizeNotionId(meta.notionAbortId);
  const sourceHash = normalizeSourceHash(meta.notionAbortSourceHash);
  if (!SOURCE_HASH_RE.test(meta.notionAbortTokenSha256)) {
    throw new Error("invalid notion abort receipt token hash");
  }
  for (const field of NOTION_IMPORT_META_FIELDS.slice(7)) {
    if (meta[field] !== undefined) {
      throw new Error("notion abort receipt still contains reservation state");
    }
  }
  const boundNotionId = normalizeOptionalNotionId(meta.notionId);
  if (
    (meta.notionAbortStatus === "detached" && boundNotionId !== undefined) ||
    (meta.notionAbortStatus === "aborted" && boundNotionId !== notionId)
  ) {
    throw new Error("notion abort receipt binding does not match its status");
  }
  return {
    notionId,
    sourceHash,
    tokenSha256: meta.notionAbortTokenSha256,
    status: meta.notionAbortStatus,
    stagingRemoved: meta.notionAbortStagingRemoved,
    completedAt: meta.notionAbortCompletedAt,
  };
}

function clearNotionAbortReceipt(meta: PageMeta): PageMeta {
  const next = { ...meta };
  next.notionAbortId = undefined;
  next.notionAbortSourceHash = undefined;
  next.notionAbortTokenSha256 = undefined;
  next.notionAbortStatus = undefined;
  next.notionAbortStagingRemoved = undefined;
  next.notionAbortCompletedAt = undefined;
  return next;
}

function notionLeaseRemainingMs(
  startedInput: string | undefined,
  timestamp = Date.now(),
): number {
  const started = Date.parse(startedInput ?? "");
  const age = timestamp - started;
  if (!Number.isFinite(started) || age < 0 || age >= NOTION_RESERVATION_TTL_MS) {
    return 0;
  }
  return NOTION_RESERVATION_TTL_MS - age;
}

function isNotionLeaseFresh(
  startedInput: string | undefined,
  timestamp = Date.now(),
): boolean {
  return notionLeaseRemainingMs(startedInput, timestamp) > 0;
}

function normalizeNotionStagingLimits(
  input: Partial<NotionStagingLimits> | undefined,
): NotionStagingLimits {
  const limits = { ...DEFAULT_NOTION_STAGE_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles <= 0) {
    throw new Error("notion staging maxFiles must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new Error("notion staging maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(limits.minFreeBytes) || limits.minFreeBytes < 0) {
    throw new Error("notion staging minFreeBytes must be a non-negative safe integer");
  }
  return limits;
}

function parseMoveIntent(raw: string): MoveIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid cross-parent move intent JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("invalid cross-parent move intent");
  }
  const candidate = value as Partial<MoveIntent>;
  const validParent = (parentId: unknown) =>
    parentId === null ||
    (typeof parentId === "string" && PAGE_ID_RE.test(parentId));
  const nest = candidate.pageRefNest as
    | Partial<NonNullable<MoveIntent["pageRefNest"]>>
    | undefined;
  const targetPage = nest?.targetPage as
    | Partial<NonNullable<NonNullable<MoveIntent["pageRefNest"]>["targetPage"]>>
    | undefined;
  const destinationPageRef = candidate.destinationPageRef as
    | Partial<NonNullable<MoveIntent["destinationPageRef"]>>
    | undefined;
  const originPageRef = candidate.originPageRef as
    | Partial<NonNullable<MoveIntent["originPageRef"]>>
    | undefined;
  const validTargetPage =
    targetPage === undefined ||
    (targetPage !== null &&
      typeof targetPage === "object" &&
      typeof targetPage.pageId === "string" &&
      PAGE_ID_RE.test(targetPage.pageId) &&
      targetPage.pageId === candidate.targetParentId &&
      typeof targetPage.indexFile === "string" &&
      Boolean(targetPage.indexFile) &&
      !path.isAbsolute(targetPage.indexFile) &&
      path.basename(targetPage.indexFile) === "index.md" &&
      typeof targetPage.beforeRaw === "string" &&
      typeof targetPage.beforeRev === "string" &&
      REV_TOKEN_RE.test(targetPage.beforeRev) &&
      hashRev(targetPage.beforeRaw) === targetPage.beforeRev &&
      typeof targetPage.afterRaw === "string" &&
      typeof targetPage.afterRev === "string" &&
      REV_TOKEN_RE.test(targetPage.afterRev) &&
      hashRev(targetPage.afterRaw) === targetPage.afterRev &&
      targetPage.beforeRev !== targetPage.afterRev &&
      parsePage(targetPage.beforeRaw).meta.id === targetPage.pageId &&
      parsePage(targetPage.afterRaw).meta.id === targetPage.pageId);
  const validDestinationPageRef =
    destinationPageRef === undefined ||
    (destinationPageRef !== null &&
      typeof destinationPageRef === "object" &&
      typeof destinationPageRef.pageId === "string" &&
      PAGE_ID_RE.test(destinationPageRef.pageId) &&
      destinationPageRef.pageId === candidate.targetParentId &&
      typeof destinationPageRef.indexFile === "string" &&
      Boolean(destinationPageRef.indexFile) &&
      !path.isAbsolute(destinationPageRef.indexFile) &&
      path.basename(destinationPageRef.indexFile) === "index.md" &&
      typeof destinationPageRef.beforeRaw === "string" &&
      typeof destinationPageRef.beforeRev === "string" &&
      REV_TOKEN_RE.test(destinationPageRef.beforeRev) &&
      hashRev(destinationPageRef.beforeRaw) === destinationPageRef.beforeRev &&
      typeof destinationPageRef.afterRaw === "string" &&
      typeof destinationPageRef.afterRev === "string" &&
      REV_TOKEN_RE.test(destinationPageRef.afterRev) &&
      hashRev(destinationPageRef.afterRaw) === destinationPageRef.afterRev &&
      destinationPageRef.beforeRev !== destinationPageRef.afterRev &&
      parsePage(destinationPageRef.beforeRaw).meta.id ===
        destinationPageRef.pageId &&
      parsePage(destinationPageRef.afterRaw).meta.id ===
        destinationPageRef.pageId);
  const validOriginPageRef =
    originPageRef === undefined ||
    (originPageRef !== null &&
      typeof originPageRef === "object" &&
      typeof originPageRef.pageId === "string" &&
      PAGE_ID_RE.test(originPageRef.pageId) &&
      originPageRef.pageId === candidate.originalParentId &&
      typeof originPageRef.indexFile === "string" &&
      Boolean(originPageRef.indexFile) &&
      !path.isAbsolute(originPageRef.indexFile) &&
      path.basename(originPageRef.indexFile) === "index.md" &&
      typeof originPageRef.beforeRaw === "string" &&
      typeof originPageRef.beforeRev === "string" &&
      REV_TOKEN_RE.test(originPageRef.beforeRev) &&
      hashRev(originPageRef.beforeRaw) === originPageRef.beforeRev &&
      typeof originPageRef.afterRaw === "string" &&
      typeof originPageRef.afterRev === "string" &&
      REV_TOKEN_RE.test(originPageRef.afterRev) &&
      hashRev(originPageRef.afterRaw) === originPageRef.afterRev &&
      originPageRef.beforeRev !== originPageRef.afterRev &&
      parsePage(originPageRef.beforeRaw).meta.id === originPageRef.pageId &&
      parsePage(originPageRef.afterRaw).meta.id === originPageRef.pageId);
  const validNest =
    nest === undefined ||
    (nest !== null &&
      typeof nest === "object" &&
      typeof nest.parentPageId === "string" &&
      PAGE_ID_RE.test(nest.parentPageId) &&
      typeof nest.parentIndex === "string" &&
      Boolean(nest.parentIndex) &&
      !path.isAbsolute(nest.parentIndex) &&
      path.basename(nest.parentIndex) === "index.md" &&
      typeof nest.originalParentRaw === "string" &&
      typeof nest.originalParentRev === "string" &&
      REV_TOKEN_RE.test(nest.originalParentRev) &&
      hashRev(nest.originalParentRaw) === nest.originalParentRev &&
      typeof nest.nextParentRaw === "string" &&
      typeof nest.nextParentRev === "string" &&
      REV_TOKEN_RE.test(nest.nextParentRev) &&
      hashRev(nest.nextParentRaw) === nest.nextParentRev &&
      nest.originalParentRev !== nest.nextParentRev &&
      typeof nest.removed === "boolean" &&
      (nest.removed ||
        (parsePage(nest.originalParentRaw).markdown ===
          parsePage(nest.nextParentRaw).markdown &&
          parsePage(nest.nextParentRaw).meta.structureWriteBarrier === true)) &&
      parsePage(nest.originalParentRaw).meta.id === nest.parentPageId &&
      parsePage(nest.nextParentRaw).meta.id === nest.parentPageId &&
      validTargetPage);
  if (
    candidate.version !== 1 ||
    typeof candidate.pageId !== "string" ||
    !PAGE_ID_RE.test(candidate.pageId) ||
    typeof candidate.originalDir !== "string" ||
    !candidate.originalDir ||
    typeof candidate.targetDir !== "string" ||
    !candidate.targetDir ||
    !validParent(candidate.originalParentId) ||
    !validParent(candidate.targetParentId) ||
    typeof candidate.nextOrder !== "string" ||
    !candidate.nextOrder ||
    typeof candidate.updated !== "string" ||
    !Number.isFinite(Date.parse(candidate.updated)) ||
    !validNest ||
    !validDestinationPageRef ||
    !validOriginPageRef ||
    (destinationPageRef !== undefined && nest !== undefined) ||
    // `pageRefNest` already owns the old parent's body for the editor gesture.
    // Two participants rewriting the same file would race their own images.
    (originPageRef !== undefined && nest !== undefined)
  ) {
    throw new Error("invalid cross-parent move intent fields");
  }
  return candidate as MoveIntent;
}

function parseBoardMutationIntent(raw: string): BoardMutationIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid board mutation intent JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("invalid board mutation intent");
  }
  const candidate = value as Partial<BoardMutationIntent>;
  if (
    candidate.version !== 1 ||
    (candidate.operation !== "board" &&
      candidate.operation !== "page-ref-cleanup") ||
    typeof candidate.boardId !== "string" ||
    !PAGE_ID_RE.test(candidate.boardId) ||
    !Array.isArray(candidate.pages) ||
    candidate.pages.length === 0 ||
    candidate.pages.length > MAX_BOARD_INTENT_PAGES
  ) {
    throw new Error("invalid board mutation intent fields");
  }
  const ids = new Set<string>();
  for (const page of candidate.pages) {
    if (
      !page ||
      typeof page !== "object" ||
      typeof page.pageId !== "string" ||
      !PAGE_ID_RE.test(page.pageId) ||
      ids.has(page.pageId) ||
      typeof page.indexFile !== "string" ||
      !page.indexFile ||
      path.isAbsolute(page.indexFile) ||
      path.basename(page.indexFile) !== "index.md" ||
      typeof page.beforeRaw !== "string" ||
      typeof page.beforeRev !== "string" ||
      !REV_TOKEN_RE.test(page.beforeRev) ||
      hashRev(page.beforeRaw) !== page.beforeRev ||
      parsePage(page.beforeRaw).meta.id !== page.pageId ||
      typeof page.afterRaw !== "string" ||
      typeof page.afterRev !== "string" ||
      !REV_TOKEN_RE.test(page.afterRev) ||
      hashRev(page.afterRaw) !== page.afterRev ||
      parsePage(page.afterRaw).meta.id !== page.pageId ||
      page.beforeRev === page.afterRev
    ) {
      throw new Error("invalid board mutation intent page");
    }
    ids.add(page.pageId);
  }
  return candidate as BoardMutationIntent;
}

function moveIntentDirectory(root: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new Error("move intent directory must be relative");
  }
  return assertInRoot(root, path.join(root, relative));
}

function moveIntentFile(root: string, relative: string): string {
  if (path.isAbsolute(relative) || path.basename(relative) !== "index.md") {
    throw new Error("move intent page file must be a relative index.md");
  }
  return assertInRoot(root, path.join(root, relative));
}

async function readOptionalFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function containsNotionUnsupportedMarker(markdown: string): boolean {
  return /^(?:`{3,}|~{3,})notion-unsupported(?:[ \t].*)?$/m.test(markdown);
}

function assertNotionIconCompatible(icon: string | undefined): void {
  if (!isBrainCompatibleNotionIcon(icon)) {
    throw new NotionImportConflictError(
      "incompatible_icon",
      "Notion file or URL icons are not representable as Brain page icons",
    );
  }
}

function assertNotionCoverCompatible(cover: string | undefined): void {
  if (!isBrainCompatibleNotionCover(cover)) {
    throw new NotionImportConflictError(
      "incompatible_cover",
      "Notion covers must be deterministic local content-addressed attachments",
    );
  }
}

function validateAttachment(
  input: AttachmentInput,
  options: { allowActive?: boolean } = {},
): string {
  if (input.data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentValidationError(
      "too_large",
      `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
    );
  }
  const mimeType = canonicalAttachmentMimeType(
    input.mimeType || "application/octet-stream",
  );
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) {
    throw new AttachmentValidationError("invalid_mime", "invalid attachment MIME type");
  }
  if (BLOCKED_ATTACHMENT_MIME.has(mimeType) && !options.allowActive) {
    throw new AttachmentValidationError(
      "blocked_mime",
      `active attachment MIME type is blocked: ${mimeType}`,
    );
  }
  if (!matchesKnownSignature(mimeType, input.data)) {
    throw new AttachmentValidationError(
      "mime_mismatch",
      `attachment bytes do not match ${mimeType}`,
    );
  }
  return mimeType;
}

function matchesKnownSignature(mimeType: string, data: Uint8Array): boolean {
  const starts = (...bytes: number[]) =>
    data.byteLength >= bytes.length && bytes.every((byte, index) => data[index] === byte);
  switch (mimeType) {
    case "image/png":
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return starts(0xff, 0xd8, 0xff);
    case "image/gif":
      return starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) ||
        starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    case "image/webp":
      return (
        starts(0x52, 0x49, 0x46, 0x46) &&
        data.byteLength >= 12 &&
        data[8] === 0x57 &&
        data[9] === 0x45 &&
        data[10] === 0x42 &&
        data[11] === 0x50
      );
    case "application/pdf":
      return indexOfBytes(
        data.slice(0, 1_024),
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      ) >= 0;
    case "application/zip":
      return (
        starts(0x50, 0x4b, 0x03, 0x04) ||
        starts(0x50, 0x4b, 0x05, 0x06) ||
        starts(0x50, 0x4b, 0x07, 0x08)
      );
    case "image/svg+xml": {
      let head = new TextDecoder()
        .decode(data.slice(0, 16_384))
        .replace(/^\uFEFF/, "")
        .trimStart();
      head = head.replace(/^<\?xml[\s\S]*?\?>\s*/i, "");
      for (;;) {
        const next = head
          .replace(/^<!--[\s\S]*?-->\s*/, "")
          .replace(/^<!doctype\s+svg[\s\S]*?>\s*/i, "")
          .replace(/^<\?[\s\S]*?\?>\s*/, "");
        if (next === head) break;
        head = next;
      }
      return /^<svg[\s>]/i.test(head);
    }
    default:
      return true;
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let index = 0; index < needle.length; index++) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

async function openRegularFileNoFollow(
  file: string,
): Promise<{ handle: FileHandle; stat: Stats } | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENXIO"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return null;
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function pathStillReferencesRegularFile(
  file: string,
  opened: Stats,
): Promise<boolean> {
  try {
    const current = await fs.lstat(file);
    return (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === opened.dev &&
      current.ino === opened.ino
    );
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      return false;
    }
    throw error;
  }
}

async function digestOpenedRegularFile(
  handle: FileHandle,
  initial: Stats,
): Promise<{ sha256: string; size: number } | null> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < initial.size) {
    const length = Math.min(buffer.byteLength, initial.size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) return null;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const probe = await handle.read(buffer, 0, 1, position);
  const final = await handle.stat();
  if (probe.bytesRead !== 0 || !sameFileVersion(initial, final)) return null;
  return { sha256: hash.digest("hex"), size: position };
}

async function regularFileDigestNoFollow(
  file: string,
): Promise<{ sha256: string; size: number } | null> {
  const opened = await openRegularFileNoFollow(file);
  if (!opened) return null;
  try {
    const digest = await digestOpenedRegularFile(opened.handle, opened.stat);
    if (!digest || !(await pathStillReferencesRegularFile(file, opened.stat))) {
      return null;
    }
    return digest;
  } finally {
    await opened.handle.close();
  }
}

/** Kernel-stream a staged file into one temporary canonical file, verify the
 *  copied bytes, fsync, and rename. No promotion batch is retained in memory. */
async function atomicCopyFileVerified(
  source: string,
  destination: string,
  expectedHash: string,
  directoryIdentity: DirectoryIdentity,
): Promise<void> {
  const dir = path.dirname(destination);
  await assertRealDirectory(dir, directoryIdentity);
  const temporary = assertInRoot(
    dir,
    path.join(dir, `.tmp-notion-${process.pid}-${nanoid(12)}`),
  );
  let sourceHandle: FileHandle | undefined;
  let temporaryHandle: FileHandle | undefined;
  try {
    const opened = await openRegularFileNoFollow(source);
    if (!opened) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "attachment is not a regular staged file",
      );
    }
    sourceHandle = opened.handle;
    temporaryHandle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let sourcePosition = 0;
    let destinationPosition = 0;
    while (sourcePosition < opened.stat.size) {
      const length = Math.min(
        buffer.byteLength,
        opened.stat.size - sourcePosition,
      );
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        length,
        sourcePosition,
      );
      if (bytesRead === 0) {
        throw new NotionImportConflictError(
          "missing_attachment",
          "attachment changed during promotion",
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const result = await temporaryHandle.write(
          buffer,
          offset,
          bytesRead - offset,
          destinationPosition + offset,
        );
        if (result.bytesWritten === 0) {
          throw new Error("notion attachment copy made no progress");
        }
        offset += result.bytesWritten;
      }
      sourcePosition += bytesRead;
      destinationPosition += bytesRead;
    }
    const probe = await sourceHandle.read(buffer, 0, 1, sourcePosition);
    const finalSourceStat = await sourceHandle.stat();
    const copiedHash = hash.digest("hex");
    if (
      probe.bytesRead !== 0 ||
      !sameFileVersion(opened.stat, finalSourceStat) ||
      !(await pathStillReferencesRegularFile(source, opened.stat)) ||
      copiedHash !== expectedHash
    ) {
      throw new NotionImportConflictError(
        "missing_attachment",
        "attachment changed during promotion",
      );
    }
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    await fs.rename(temporary, destination);
    await syncDirectory(dir);
    await assertRealDirectory(dir, directoryIdentity);
  } catch (error) {
    await temporaryHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    // As with atomicWrite, a post-rename fsync error is recoverable only when
    // the exact content-addressed destination is visible and a retry fsyncs it.
    try {
      if ((await regularFileDigestNoFollow(destination))?.sha256 === expectedHash) {
        await syncDirectory(dir);
        await assertRealDirectory(dir, directoryIdentity);
        return;
      }
    } catch {
      // Preserve the original copy/hash/rename error.
    }
    throw error;
  }
}

async function fileHasExactContent(file: string, content: string): Promise<boolean> {
  try {
    return (await fs.readFile(file, "utf8")) === content;
  } catch {
    return false;
  }
}

interface RegularTextDigest {
  text: string;
  sha256: string;
  size: number;
}

function textDigest(text: string): Omit<RegularTextDigest, "text"> {
  const bytes = Buffer.from(text, "utf8");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

function sameDigest(
  left: Pick<RegularTextDigest, "sha256" | "size">,
  right: Pick<RegularTextDigest, "sha256" | "size">,
): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

async function readRegularTextNoFollow(
  file: string,
  syncData = false,
  maxBytes?: number,
): Promise<RegularTextDigest | null> {
  const opened = await openRegularFileNoFollow(file);
  if (!opened) {
    try {
      await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    throw new Error(`notion abort state is not a regular file: ${file}`);
  }
  try {
    if (!Number.isSafeInteger(opened.stat.size) || opened.stat.size < 0) {
      throw new Error("notion abort file size is invalid");
    }
    if (maxBytes !== undefined && opened.stat.size > maxBytes) {
      throw new Error("notion abort intent exceeds the maximum size");
    }
    const bytes = Buffer.alloc(opened.stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await opened.handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        throw new Error("notion abort file changed while reading");
      }
      offset += result.bytesRead;
    }
    const probe = Buffer.alloc(1);
    const extra = await opened.handle.read(probe, 0, 1, offset);
    if (syncData) await opened.handle.sync();
    const final = await opened.handle.stat();
    if (
      extra.bytesRead !== 0 ||
      !sameFileVersion(opened.stat, final) ||
      !(await pathStillReferencesRegularFile(file, opened.stat))
    ) {
      throw new Error("notion abort file changed while reading");
    }
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  } finally {
    await opened.handle.close();
  }
}

function relativePageDirectory(root: string, directory: string): string {
  const relative = path.relative(root, directory);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + path.sep)
  ) {
    throw new Error("notion abort page directory is outside the notes tree");
  }
  return relative.split(path.sep).join("/");
}

function abortIntentDirectory(root: string, relative: string): string {
  if (
    !relative ||
    relative.includes("\\") ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("notion abort intent page directory is invalid");
  }
  const directory = assertInRoot(root, path.join(root, ...relative.split("/")));
  if (relativePageDirectory(root, directory) !== relative) {
    throw new Error("notion abort intent page directory is not canonical");
  }
  return directory;
}

async function assertPrivateAbortTransactionDirectory(
  directory: string,
  capturedFile: string,
): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("notion abort transaction path must be a real directory");
  }
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined || stat.uid !== effectiveUserId) {
    throw new Error("notion abort transaction directory has the wrong owner");
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error("notion abort transaction directory mode must be 0700");
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        entry.name !== capturedFile || !entry.isFile(),
    ) ||
    entries.length > 1
  ) {
    throw new Error("notion abort transaction directory has unexpected entries");
  }
  return true;
}

function parseAbortIndexIntent(
  raw: string,
  intentPath: string,
  root: string,
): AbortIndexIntent {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("notion abort intent is not valid JSON");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("notion abort intent must be an object");
  }
  const value = input as Record<string, unknown>;
  const expectedKeys = [
    "beforeFile",
    "beforeSha256",
    "beforeSize",
    "capturedFile",
    "nextFile",
    "nextSha256",
    "nextSize",
    "nonce",
    "notionId",
    "operation",
    "pageDirectory",
    "pageId",
    "reservationToken",
    "sourceHash",
    "transactionDirectory",
    "version",
  ].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expectedKeys) {
    throw new Error("notion abort intent has unknown or missing fields");
  }
  if (
    value.version !== 1 ||
    value.operation !== "notion-abort" ||
    typeof value.nonce !== "string" ||
    !ABORT_NONCE_RE.test(value.nonce) ||
    typeof value.pageId !== "string" ||
    !PAGE_ID_RE.test(value.pageId) ||
    typeof value.notionId !== "string" ||
    !NOTION_ID_RE.test(value.notionId) ||
    typeof value.sourceHash !== "string" ||
    !SOURCE_HASH_RE.test(value.sourceHash) ||
    typeof value.reservationToken !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(value.reservationToken) ||
    typeof value.pageDirectory !== "string" ||
    typeof value.beforeFile !== "string" ||
    value.beforeFile !== `.brain-abort-recovery-${value.nonce}.md` ||
    typeof value.transactionDirectory !== "string" ||
    value.transactionDirectory !== `.brain-abort-txn-${value.nonce}` ||
    typeof value.capturedFile !== "string" ||
    value.capturedFile !== "captured.md" ||
    typeof value.nextFile !== "string" ||
    value.nextFile !== `.brain-abort-next-${value.nonce}.md` ||
    typeof value.beforeSha256 !== "string" ||
    !SOURCE_HASH_RE.test(value.beforeSha256) ||
    !Number.isSafeInteger(value.beforeSize) ||
    (value.beforeSize as number) < 1 ||
    typeof value.nextSha256 !== "string" ||
    !SOURCE_HASH_RE.test(value.nextSha256) ||
    !Number.isSafeInteger(value.nextSize) ||
    (value.nextSize as number) < 1
  ) {
    throw new Error("notion abort intent is invalid");
  }
  const nonceFromName = ABORT_INTENT_RE.exec(path.basename(intentPath))?.[1];
  if (nonceFromName !== value.nonce) {
    throw new Error("notion abort intent nonce does not match its filename");
  }
  const directory = abortIntentDirectory(root, value.pageDirectory);
  if (directory !== path.dirname(intentPath)) {
    throw new Error("notion abort intent is in the wrong page directory");
  }
  return value as unknown as AbortIndexIntent;
}

function assertAbortPageIdentity(
  raw: string,
  identity: AbortPreservationIdentity,
  requireReservation: boolean,
): void {
  const parsed = parsePage(raw).meta;
  const activeReservationMatches =
    normalizeOptionalNotionId(parsed.notionId) === identity.notionId &&
    parsed.notionImportHash === identity.sourceHash &&
    parsed.notionImportToken === identity.reservationToken;
  const receiptMatches =
    parsed.notionAbortId === identity.notionId &&
    parsed.notionAbortSourceHash === identity.sourceHash &&
    typeof parsed.notionAbortTokenSha256 === "string" &&
    reservationTokenHashMatches(
      identity.reservationToken,
      parsed.notionAbortTokenSha256,
    );
  if (
    parsed.id !== identity.pageId ||
    (requireReservation && !activeReservationMatches && !receiptMatches)
  ) {
    throw new Error("notion abort page identity does not match its intent");
  }
}

function assertAbortIntentFiles(
  intent: AbortIndexIntent,
  before: RegularTextDigest | null,
  next: RegularTextDigest | null,
): void {
  const identity: AbortPreservationIdentity = intent;
  if (before) {
    if (!sameDigest(before, { sha256: intent.beforeSha256, size: intent.beforeSize })) {
      throw new Error("notion abort recovery file hash or size is invalid");
    }
    assertAbortPageIdentity(before.text, identity, true);
  }
  if (next) {
    if (!before) {
      throw new Error("notion abort next file exists without its recovery file");
    }
    if (!sameDigest(next, { sha256: intent.nextSha256, size: intent.nextSize })) {
      throw new Error("notion abort next file hash or size is invalid");
    }
    assertAbortPageIdentity(next.text, identity, false);
    const meta = parsePage(next.text).meta;
    for (const field of NOTION_IMPORT_META_FIELDS.slice(7)) {
      if (meta[field] !== undefined) {
        throw new Error("notion abort next file still contains reservation state");
      }
    }
    const beforeMeta = parsePage(before.text).meta;
    const detached =
      Boolean(beforeMeta.notionImportCreated) ||
      beforeMeta.notionAbortStatus === "detached";
    if (
      detached
        ? meta.notionId !== undefined
        : normalizeNotionId(String(meta.notionId ?? "")) !== intent.notionId
    ) {
      throw new Error("notion abort next file has an invalid Notion binding");
    }
  }
}

async function removeExactRegularFile(
  file: string,
  expected: Pick<RegularTextDigest, "sha256" | "size">,
): Promise<void> {
  const current = await readRegularTextNoFollow(file);
  if (!current || !sameDigest(current, expected)) {
    throw new Error(`refusing to remove changed notion abort state: ${file}`);
  }
  await fs.unlink(file);
}

async function reconcileAbortIntent(
  intentPath: string,
  root: string,
): Promise<"before" | "next" | "external"> {
  const intentRead = await readRegularTextNoFollow(
    intentPath,
    false,
    MAX_ABORT_INTENT_BYTES,
  );
  if (!intentRead) {
    const error = new Error("notion abort intent is missing") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  const intent = parseAbortIndexIntent(intentRead.text, intentPath, root);
  const dir = path.dirname(intentPath);
  const indexPath = path.join(dir, "index.md");
  const beforePath = path.join(dir, intent.beforeFile);
  const transactionPath = path.join(dir, intent.transactionDirectory);
  const transactionExists = await assertPrivateAbortTransactionDirectory(
    transactionPath,
    intent.capturedFile,
  );
  const capturedPath = path.join(transactionPath, intent.capturedFile);
  const nextPath = path.join(dir, intent.nextFile);
  const [canonical, before, captured, next] = await Promise.all([
    readRegularTextNoFollow(indexPath),
    readRegularTextNoFollow(beforePath),
    transactionExists
      ? readRegularTextNoFollow(capturedPath)
      : Promise.resolve(null),
    readRegularTextNoFollow(nextPath),
  ]);
  assertAbortIntentFiles(intent, before, next);
  const beforeExpected = {
    sha256: intent.beforeSha256,
    size: intent.beforeSize,
  };
  const nextExpected = { sha256: intent.nextSha256, size: intent.nextSize };
  const capturedIsBefore = Boolean(
    captured && sameDigest(captured, beforeExpected),
  );
  if (captured) {
    assertAbortPageIdentity(captured.text, intent, capturedIsBefore);
  }

  let state: "before" | "next" | "external";
  let externalExpected: RegularTextDigest | undefined;
  if (canonical && sameDigest(canonical, beforeExpected)) {
    assertAbortPageIdentity(canonical.text, intent, true);
    state = "before";
  } else if (canonical && sameDigest(canonical, nextExpected)) {
    if (!before) {
      throw new Error("notion abort completed without its recovery file");
    }
    assertAbortPageIdentity(canonical.text, intent, false);
    state = "next";
  } else if (!canonical && captured && !capturedIsBefore) {
    // `capturedPath` is the atomically moved actual canonical entry. Even when
    // its hash differs from the pre-intent snapshot, it is unambiguous external
    // truth and wins on both runtime recovery and startup.
    await fs.link(capturedPath, indexPath);
    await syncDirectory(dir);
    state = "external";
    externalExpected = captured;
  } else if (!canonical) {
    // A digest-matching captured inode may still have failed its own data
    // fsync. The separately written recovery file was fsynced before detach,
    // so it is the only safe rollback source for the reserved `before` state.
    if (!before) {
      throw new Error("notion abort canonical and recovery files are missing");
    }
    await fs.link(beforePath, indexPath);
    await syncDirectory(dir);
    state = "before";
  } else {
    assertAbortPageIdentity(canonical.text, intent, false);
    if (
      !captured ||
      capturedIsBefore ||
      sameDigest(canonical, captured)
    ) {
      state = "external";
      externalExpected = canonical;
    } else {
      throw new Error(
        "notion abort has two distinct external canonical candidates",
      );
    }
  }

  const authoritativeExpected =
    state === "before"
      ? beforeExpected
      : state === "next"
        ? nextExpected
        : externalExpected;
  const durableCanonical = await readRegularTextNoFollow(indexPath, true);
  if (
    !authoritativeExpected ||
    !durableCanonical ||
    !sameDigest(durableCanonical, authoritativeExpected)
  ) {
    throw new Error("notion abort canonical changed before fsync");
  }
  await syncDirectory(dir);

  if (next) {
    await removeExactRegularFile(nextPath, nextExpected);
    await syncDirectory(dir);
  }
  if (captured) {
    const canonicalAfter = await readRegularTextNoFollow(indexPath);
    if (!canonicalAfter || !sameDigest(canonicalAfter, captured)) {
      if (
        capturedIsBefore &&
        before &&
        (state === "next" || state === "external")
      ) {
        // Successful abort or a raced canonical: beforePath retains the exact
        // pre-abort bytes while index.md retains the authoritative visible state.
      } else {
        throw new Error("refusing to remove the only captured notion abort bytes");
      }
    }
    await removeExactRegularFile(capturedPath, captured);
    await syncDirectory(transactionPath);
  }
  if (transactionExists) {
    await fs.rmdir(transactionPath);
    await syncDirectory(dir);
  }
  await removeExactRegularFile(intentPath, intentRead);
  await syncDirectory(dir);
  return state;
}

async function reconcileAbortIntents(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const intentEntries = entries.filter((entry) =>
      entry.name.startsWith(".brain-abort-intent-"),
    );
    if (intentEntries.length > 1) {
      throw new Error(`multiple notion abort intents in ${directory}`);
    }
    if (intentEntries.length === 1) {
      const intentEntry = intentEntries[0];
      if (!intentEntry.isFile() || !ABORT_INTENT_RE.test(intentEntry.name)) {
        throw new Error(`invalid notion abort intent entry in ${directory}`);
      }
      await reconcileAbortIntent(
        assertInRoot(root, path.join(directory, intentEntry.name)),
        root,
      );
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || isReservedDir(entry.name)) continue;
      await visit(assertInRoot(root, path.join(directory, entry.name)));
    }
  };
  await visit(root);
}

interface AbortPreservationIdentity {
  pageId: string;
  notionId: string;
  sourceHash: string;
  reservationToken: string;
}

/** Preserve the exact canonical file under a hidden recovery name before an
 * abort changes importer metadata. A nonce-bound intent is fsynced before
 * `index.md` is removed, and startup reconciles every possible durable state
 * before it builds the page tree. The replacement is installed with a kernel
 * no-overwrite hard link, so a raced external save always wins. */
async function preservingIndexUpdate<T>(
  root: string,
  indexPath: string,
  identity: AbortPreservationIdentity,
  transform: (latestRaw: string) => { content: string; value: T },
): Promise<{
  state: "before" | "next" | "external";
  canonical: string;
  value?: T;
  durabilityError?: unknown;
}> {
  const dir = path.dirname(indexPath);
  const before = await readRegularTextNoFollow(indexPath);
  if (!before) throw new Error("notion abort canonical index is missing");
  assertAbortPageIdentity(before.text, identity, true);
  const next = transform(before.text);
  const nextDigest = textDigest(next.content);
  const nonce = nanoid(24);
  if (!ABORT_NONCE_RE.test(nonce)) throw new Error("invalid notion abort nonce");
  const relativeDirectory = relativePageDirectory(root, dir);
  const beforeFile = `.brain-abort-recovery-${nonce}.md`;
  const transactionDirectory = `.brain-abort-txn-${nonce}`;
  const capturedFile = "captured.md";
  const nextFile = `.brain-abort-next-${nonce}.md`;
  const intentFile = `.brain-abort-intent-${nonce}.json`;
  const beforePath = path.join(dir, beforeFile);
  const transactionPath = path.join(dir, transactionDirectory);
  const capturedPath = path.join(transactionPath, capturedFile);
  const nextPath = path.join(dir, nextFile);
  const intentPath = path.join(dir, intentFile);
  const intent: AbortIndexIntent = {
    version: 1,
    operation: "notion-abort",
    nonce,
    pageId: identity.pageId,
    notionId: identity.notionId,
    sourceHash: identity.sourceHash,
    reservationToken: identity.reservationToken,
    pageDirectory: relativeDirectory,
    beforeFile,
    beforeSha256: before.sha256,
    beforeSize: before.size,
    transactionDirectory,
    capturedFile,
    nextFile,
    nextSha256: nextDigest.sha256,
    nextSize: nextDigest.size,
  };
  const intentContent = `${JSON.stringify(intent)}\n`;

  try {
    // The intent is the authority for every later missing-index state. It is
    // durable before either helper file or the canonical path is touched.
    await writeFileNoReplaceDurable(intentPath, intentContent);
    await fs.mkdir(transactionPath, { mode: 0o700 });
    await syncDirectory(dir);
    await assertPrivateAbortTransactionDirectory(transactionPath, capturedFile);
    await writeFileNoReplaceDurable(beforePath, before.text);
    await writeFileNoReplaceDurable(nextPath, next.content);
    const current = await readRegularTextNoFollow(indexPath);
    if (!current || !sameDigest(current, before)) {
      throw new Error("notion abort canonical index changed before detach");
    }
    // Rename the actual directory entry rather than unlinking after a digest
    // check. If an external atomic save wins the final race, its bytes move to
    // `capturedPath`, are detected below, and are never deleted or overwritten.
    await fs.rename(indexPath, capturedPath);
    // The renamed directory entry can contain an external writer's still-dirty
    // in-place bytes. Make those exact bytes durable on the same no-follow fd
    // used for hash/inode verification before making the namespace durable.
    const captured = await readRegularTextNoFollow(capturedPath, true);
    const capturedExpected = Boolean(captured && sameDigest(captured, before));
    await syncDirectory(transactionPath);
    await syncDirectory(dir);
    if (!capturedExpected) {
      throw new Error("notion abort captured a raced canonical save");
    }
    const [durableBefore, durableNext] = await Promise.all([
      readRegularTextNoFollow(beforePath),
      readRegularTextNoFollow(nextPath),
    ]);
    if (!durableBefore || !sameDigest(durableBefore, before)) {
      throw new Error("notion abort recovery file changed before publish");
    }
    if (!durableNext || !sameDigest(durableNext, nextDigest)) {
      throw new Error("notion abort next file changed before publish");
    }
    await fs.link(nextPath, indexPath);
    await syncDirectory(dir);
    // Re-enter the same reconciler used after crashes before claiming success.
    // An external atomic save can replace index.md immediately after publish.
    await reconcileAbortIntent(intentPath, root);
    const canonical = await readRegularTextNoFollow(indexPath);
    if (!canonical) throw new Error("notion abort canonical vanished after publish");
    const finalState = sameDigest(canonical, nextDigest)
      ? "next"
      : sameDigest(canonical, before)
        ? "before"
        : "external";
    return {
      state: finalState,
      canonical: canonical.text,
      value: finalState === "next" ? next.value : undefined,
    };
  } catch (error) {
    try {
      await reconcileAbortIntent(intentPath, root);
      const canonical = await readRegularTextNoFollow(indexPath);
      if (canonical) {
        const finalState = sameDigest(canonical, nextDigest)
          ? "next"
          : sameDigest(canonical, before)
            ? "before"
            : "external";
        return {
          state: finalState,
          canonical: canonical.text,
          value: finalState === "next" ? next.value : undefined,
          durabilityError: error,
        };
      }
    } catch (recoveryError) {
      if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") {
        const current = await readRegularTextNoFollow(indexPath);
        if (current && sameDigest(current, nextDigest)) {
          return {
            state: "next",
            canonical: current.text,
            value: next.value,
            durabilityError: error,
          };
        }
      }
      throw new AggregateError(
        [error, recoveryError],
        "notion abort failed and intent reconciliation also failed",
      );
    }
    throw error;
  }
}

async function writeFileNoReplaceDurable(
  destination: string,
  content: string,
): Promise<void> {
  const dir = path.dirname(destination);
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      destination,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(dir);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Partial files remain under an exact intent-bound name. Startup either
    // validates their full hash/size or fails closed; no anonymous temp orphan
    // can be committed after a crash.
    throw error;
  }
}

function notionImportBaseRev(meta: PageMeta, markdown: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: meta.title,
        icon: meta.icon ?? null,
        cover: meta.cover ?? null,
        ...(meta.collection !== undefined
          ? { collection: meta.collection }
          : {}),
        ...(meta.collectionRow !== undefined
          ? { collectionRow: meta.collectionRow }
          : {}),
        markdown,
      }),
    )
    .digest("hex");
}
