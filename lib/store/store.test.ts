import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store } from "./store";
import { serializePage } from "./frontmatter";
import {
  RevConflictError,
  type AttachmentInput,
  type ReserveNotionImportInput,
  type PageMeta,
  type TreeNode,
} from "./types";
import {
  canonicalizeNotionImportTarget,
  notionConversionHash,
} from "../notion/protocol";
import { notionAttachmentUrl } from "../attachments";
import {
  beginGitSnapshotBarrier,
  scheduleCommit,
  scheduleDirtyCommit,
} from "./git";
import { standalonePageRefOccurrences } from "../page-ref-nesting";
import { latestStoreEventSequence } from "./events";

const execFileAsync = promisify(execFile);
const SOURCE_A = "a".repeat(64);
const SOURCE_B = "b".repeat(64);
// Synthetic source ids only. Real workspace ids must never enter fixtures or
// a repository that may later be published.
const NOTION_PAGE = "8".repeat(32);
const NOTION_PAGE_B = "9".repeat(32);
const NOTION_PAGE_C = "f".repeat(32);
let reservationSequence = 0;

type TestReserveInput = Omit<
  ReserveNotionImportInput,
  "beforeId" | "reservationToken"
> & {
  beforeId?: string | null;
  reservationToken?: string;
};

async function reserveNotionImport(store: Store, input: TestReserveInput) {
  reservationSequence += 1;
  return store.reserveNotionImport({
    ...input,
    beforeId: input.beforeId ?? null,
    reservationToken:
      input.reservationToken ??
      `test_reservation_${String(reservationSequence).padStart(8, "0")}`,
  });
}

async function saveNotionAttachment(
  store: Store,
  notionId: string,
  sourceHash: string,
  reservationToken: string,
  input: AttachmentInput,
) {
  return store.saveNotionAttachment(
    notionId,
    sourceHash,
    reservationToken,
    {
      ...input,
      expectedSha256: createHash("sha256").update(input.data).digest("hex"),
    },
  );
}

function conversionHash(
  sourceHash: string,
  title: string,
  markdown: string,
  icon?: string,
  cover?: string,
  parentId: string | null = null,
  beforeId: string | null = null,
): string {
  return notionConversionHash(
    canonicalizeNotionImportTarget({
      sourceHash,
      parentId,
      beforeId,
      title,
      icon,
      cover,
      markdown,
    }),
  );
}

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Brain Test",
      "-c",
      "user.email=brain-test@local",
      ...args,
    ],
    { cwd: root, encoding: "utf8" },
  );
  return stdout;
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", message);
  return (await git(root, "rev-parse", "HEAD")).trim();
}

async function waitForHeadChange(
  root: string,
  baselineHead: string,
): Promise<string> {
  let currentHead = baselineHead;
  await vi.waitFor(
    async () => {
      currentHead = (await git(root, "rev-parse", "HEAD")).trim();
      expect(currentHead).not.toBe(baselineHead);
    },
    { timeout: 5_000, interval: 25 },
  );
  return currentHead;
}

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-"));
  const s = new Store(root);
  await s.init();
  return { s, root };
}

interface AbortCrashFixture {
  root: string;
  dir: string;
  pageId: string;
  notionId: string;
  sourceHash: string;
  reservationToken: string;
  beforeRaw: string;
  nextRaw: string;
}

interface SeedAbortCrashOptions {
  canonical: string | null;
  captured?: string | null;
  transaction?: "directory" | "missing" | "symlink";
  before?: string | null;
  next?: string | null;
  intentPatch?: Record<string, unknown>;
  extraIntent?: boolean;
}

function textFixtureDigest(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

async function prepareAbortCrashFixture(
  configure?: (store: Store, pageId: string) => Promise<void>,
): Promise<AbortCrashFixture> {
  const { s, root } = await tmpStore();
  const reserved = await reserveNotionImport(s, {
    notionId: NOTION_PAGE,
    sourceHash: SOURCE_A,
    parentId: null,
    title: "Crash-safe placeholder",
  });
  if (reserved.status !== "reserved") throw new Error("expected reservation");
  await configure?.(s, reserved.page.id);
  const dir = s.resolve(reserved.page.id);
  const indexPath = path.join(dir, "index.md");
  const beforeRaw = await fs.readFile(indexPath, "utf8");
  await s.abortNotionImport({
    notionId: NOTION_PAGE,
    sourceHash: SOURCE_A,
    reservationToken: reserved.reservationToken,
  });
  const nextRaw = await fs.readFile(indexPath, "utf8");
  for (const name of await fs.readdir(dir)) {
    if (name.startsWith(".brain-abort-recovery-")) {
      await fs.unlink(path.join(dir, name));
    }
  }
  // The fixture now impersonates an interrupted process. Cancel the snapshot
  // armed by the successful reference abort before seeding transient helpers.
  await beginGitSnapshotBarrier(root);
  return {
    root,
    dir,
    pageId: reserved.page.id,
    notionId: NOTION_PAGE,
    sourceHash: SOURCE_A,
    reservationToken: reserved.reservationToken,
    beforeRaw,
    nextRaw,
  };
}

async function prepareAdoptedAbortCrashFixture(): Promise<AbortCrashFixture> {
  const { s, root } = await tmpStore();
  const page = await s.createPage(null, "Crash-safe adopted", {
    markdown: "adopted body",
  });
  await adoptExisting(s, page.id, NOTION_PAGE, SOURCE_A);
  const reserved = await reserveNotionImport(s, {
    notionId: NOTION_PAGE,
    sourceHash: SOURCE_B,
    parentId: null,
    title: "Crash-safe adopted",
  });
  if (reserved.status !== "reserved") throw new Error("expected reservation");
  const dir = s.resolve(page.id);
  const indexPath = path.join(dir, "index.md");
  const beforeRaw = await fs.readFile(indexPath, "utf8");
  await s.abortNotionImport({
    notionId: NOTION_PAGE,
    sourceHash: SOURCE_B,
    reservationToken: reserved.reservationToken,
  });
  const nextRaw = await fs.readFile(indexPath, "utf8");
  for (const name of await fs.readdir(dir)) {
    if (name.startsWith(".brain-abort-recovery-")) {
      await fs.unlink(path.join(dir, name));
    }
  }
  await beginGitSnapshotBarrier(root);
  return {
    root,
    dir,
    pageId: page.id,
    notionId: NOTION_PAGE,
    sourceHash: SOURCE_B,
    reservationToken: reserved.reservationToken,
    beforeRaw,
    nextRaw,
  };
}

async function seedAbortCrashState(
  fixture: AbortCrashFixture,
  options: SeedAbortCrashOptions,
) {
  const nonce = "n".repeat(24);
  const beforeFile = `.brain-abort-recovery-${nonce}.md`;
  const transactionDirectory = `.brain-abort-txn-${nonce}`;
  const nextFile = `.brain-abort-next-${nonce}.md`;
  const intentFile = `.brain-abort-intent-${nonce}.json`;
  const beforeRaw = options.before === undefined ? fixture.beforeRaw : options.before;
  const nextRaw = options.next === undefined ? fixture.nextRaw : options.next;
  const beforeDigest = textFixtureDigest(fixture.beforeRaw);
  const nextDigest = textFixtureDigest(fixture.nextRaw);
  const intent = {
    version: 1,
    operation: "notion-abort",
    nonce,
    pageId: fixture.pageId,
    notionId: fixture.notionId,
    sourceHash: fixture.sourceHash,
    reservationToken: fixture.reservationToken,
    pageDirectory: path
      .relative(fixture.root, fixture.dir)
      .split(path.sep)
      .join("/"),
    beforeFile,
    beforeSha256: beforeDigest.sha256,
    beforeSize: beforeDigest.size,
    transactionDirectory,
    capturedFile: "captured.md",
    nextFile,
    nextSha256: nextDigest.sha256,
    nextSize: nextDigest.size,
    ...options.intentPatch,
  };
  const indexPath = path.join(fixture.dir, "index.md");
  await fs.rm(indexPath, { force: true });
  if (options.canonical !== null) {
    await fs.writeFile(indexPath, options.canonical, { flag: "wx" });
  }
  if (beforeRaw !== null) {
    await fs.writeFile(path.join(fixture.dir, beforeFile), beforeRaw, { flag: "wx" });
  }
  if (nextRaw !== null) {
    await fs.writeFile(path.join(fixture.dir, nextFile), nextRaw, { flag: "wx" });
  }
  const transactionPath = path.join(fixture.dir, transactionDirectory);
  const transaction = options.transaction ?? "directory";
  if (transaction === "directory") {
    await fs.mkdir(transactionPath, { mode: 0o700 });
    if (options.captured !== undefined && options.captured !== null) {
      await fs.writeFile(
        path.join(transactionPath, "captured.md"),
        options.captured,
        { flag: "wx" },
      );
    }
  } else if (transaction === "symlink") {
    const target = path.join(fixture.root, "synthetic-abort-transaction-target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, transactionPath);
  }
  const intentPath = path.join(fixture.dir, intentFile);
  const intentRaw = `${JSON.stringify(intent)}\n`;
  await fs.writeFile(intentPath, intentRaw, { flag: "wx" });
  if (options.extraIntent) {
    await fs.writeFile(
      path.join(fixture.dir, `.brain-abort-intent-${"m".repeat(24)}.json`),
      intentRaw,
      { flag: "wx" },
    );
  }
  return {
    ...intent,
    intentPath,
    intentRaw,
    indexPath,
    beforePath: path.join(fixture.dir, beforeFile),
    nextPath: path.join(fixture.dir, nextFile),
    transactionPath,
    capturedPath: path.join(transactionPath, "captured.md"),
  };
}

async function expectAbortCrashHelpersClean(
  fixture: AbortCrashFixture,
  seeded: Awaited<ReturnType<typeof seedAbortCrashState>>,
) {
  await expect(fs.lstat(seeded.intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(seeded.nextPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.lstat(seeded.transactionPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(seeded.beforePath, "utf8")).resolves.toBe(
    fixture.beforeRaw,
  );
}

function notionStagingRoot(root: string): string {
  const rootKey = createHash("sha256")
    .update(path.resolve(root))
    .digest("hex")
    .slice(0, 20);
  return path.join(os.tmpdir(), "brain-notion-imports", rootKey);
}

async function adoptExisting(
  s: Store,
  pageId: string,
  notionId: string,
  sourceHash = SOURCE_A,
) {
  const page = await s.readPage(pageId);
  const placement = findPlacement(s.getTree(), pageId);
  if (!placement) throw new Error(`page is missing from tree: ${pageId}`);
  const targetHash = conversionHash(
    sourceHash,
    page.meta.title,
    page.markdown,
    page.meta.icon,
    page.meta.cover,
    placement.parentId,
    placement.beforeId,
  );
  const adopted = await s.adoptNotionImport({
    pageId,
    notionId,
    sourceHash,
    conversionHash: targetHash,
    expectedRev: page.rev,
    expectedParentId: placement.parentId,
    expectedBeforeId: placement.beforeId,
  });
  return { adopted, targetHash };
}

async function writeRawPageMeta(
  store: Store,
  pageId: string,
  patch: Partial<PageMeta>,
): Promise<void> {
  const page = await store.readPage(pageId);
  await fs.writeFile(
    path.join(store.resolve(pageId), "index.md"),
    serializePage({ ...page.meta, ...patch }, page.markdown),
  );
}

function findPlacement(
  nodes: TreeNode[],
  pageId: string,
  parentId: string | null = null,
): { parentId: string | null; beforeId: string | null } | null {
  for (const [index, node] of nodes.entries()) {
    if (node.id === pageId) {
      return { parentId, beforeId: nodes[index + 1]?.id ?? null };
    }
    const nested = findPlacement(node.children, pageId, node.id);
    if (nested) return nested;
  }
  return null;
}

/** Simulate process death after a durable move intent was written by preventing
 * the live Store from reconciling its own injected failure. A fresh Store then
 * exercises the real startup recovery path. */
function blockMoveIntentReconciliation(store: Store): () => void {
  const internal = store as unknown as {
    reconcileMoveIntent: () => Promise<void>;
  };
  const original = internal.reconcileMoveIntent;
  internal.reconcileMoveIntent = async () => {
    throw new Error("simulated process stop before reconciliation");
  };
  return () => {
    internal.reconcileMoveIntent = original;
  };
}

function blockBoardIntentReconciliation(store: Store): () => void {
  const internal = store as unknown as {
    reconcileBoardIntent: () => Promise<void>;
  };
  const original = internal.reconcileBoardIntent;
  internal.reconcileBoardIntent = async () => {
    throw new Error("simulated process stop before board reconciliation");
  };
  return () => {
    internal.reconcileBoardIntent = original;
  };
}

async function writePageFixture(
  root: string,
  dirName: string,
  idYaml: string,
): Promise<string> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir);
  const indexPath = path.join(dir, "index.md");
  await fs.writeFile(
    indexPath,
    `---\nid: ${idYaml}\ntitle: Fixture\norder: a0\ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\nbody\n`,
  );
  return indexPath;
}

describe("Store", () => {
  it("creates, reads, and lists pages", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "Alpha", { markdown: "# hi" });
    const page = await s.readPage(a.id);
    expect(page.markdown).toContain("hi");
    const tree = s.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].title).toBe("Alpha");
  });

  it("does not stamp, write, or emit when writePage receives the unchanged body", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createPage(null, "Quiet", { markdown: "# hi" });
    await writeRawPageMeta(s, created.id, {
      updated: "2026-01-01T00:00:00.000Z",
      updatedBy: "claude",
    });
    const reloaded = new Store(root);
    await reloaded.init();
    const indexPath = path.join(reloaded.resolve(created.id), "index.md");
    const rawBefore = await fs.readFile(indexPath, "utf8");
    const before = await reloaded.readPage(created.id);
    const sequenceBefore = latestStoreEventSequence();

    const result = await reloaded.writePage(
      created.id,
      "# hi\n\n",
      before.rev,
      "me",
    );

    expect(result.rev).toBe(before.rev);
    expect(result.markdown).toBe("# hi");
    expect(result.meta.updated).toBe("2026-01-01T00:00:00.000Z");
    expect(result.meta.updatedBy).toBe("claude");
    expect(await fs.readFile(indexPath, "utf8")).toBe(rawBefore);
    expect(latestStoreEventSequence()).toBe(sequenceBefore);

    const changed = await reloaded.writePage(
      created.id,
      "# hi there",
      before.rev,
      "me",
    );
    expect(changed.rev).not.toBe(before.rev);
    expect(changed.meta.updated).not.toBe("2026-01-01T00:00:00.000Z");
    expect(changed.meta.updatedBy).toBe("me");
    expect(latestStoreEventSequence()).toBe(sequenceBefore + 1);
  });

  it("does not stamp, persist, or emit on a no-op metadata patch", async () => {
    const { s, root } = await tmpStore();
    const created = await s.createPage(null, "Quiet", { icon: "🌱" });
    const stickers = [{ id: "s1", x: 10, y: 20, text: "note" }];
    await s.updateMeta(created.id, { stickers, pinned: true });
    await writeRawPageMeta(s, created.id, {
      updated: "2026-01-01T00:00:00.000Z",
      updatedBy: "claude",
    });
    const reloaded = new Store(root);
    await reloaded.init();
    const indexPath = path.join(reloaded.resolve(created.id), "index.md");
    const rawBefore = await fs.readFile(indexPath, "utf8");
    const sequenceBefore = latestStoreEventSequence();

    const same = await reloaded.updateMeta(created.id, {
      stickers: stickers.map((sticker) => ({ ...sticker })),
      pinned: true,
      icon: "🌱",
      tags: [],
      expected: { stickers },
      by: "me",
    });

    expect(same.updated).toBe("2026-01-01T00:00:00.000Z");
    expect(same.updatedBy).toBe("claude");
    expect(await fs.readFile(indexPath, "utf8")).toBe(rawBefore);
    expect(latestStoreEventSequence()).toBe(sequenceBefore);

    const changed = await reloaded.updateMeta(created.id, {
      pinned: false,
      by: "me",
    });
    expect(changed.updated).not.toBe("2026-01-01T00:00:00.000Z");
    expect(changed.updatedBy).toBe("me");
    expect(changed.pinned).toBeUndefined();
    expect(latestStoreEventSequence()).toBe(sequenceBefore + 1);
    expect(await fs.readFile(indexPath, "utf8")).not.toBe(rawBefore);
  });

  it("projects only ordered ordinary direct children for public sharing", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const first = await s.createPage(parent.id, "First", { icon: "🌱" });
    const collectionRow = await s.createPage(parent.id, "Collection row");
    const deleted = await s.createPage(parent.id, "Deleted");
    const second = await s.createPage(parent.id, "Second");
    await writeRawPageMeta(s, collectionRow.id, {
      collectionRow: {
        source: "notion",
        version: 1,
        databaseId: "synthetic-database",
        values: {},
      },
    });

    const reloaded = new Store(root);
    await reloaded.init();
    await reloaded.deletePage(deleted.id);
    const children = reloaded.readDirectChildren(parent.id);

    expect(children).toEqual([
      { id: first.id, title: "First", icon: "🌱" },
      { id: second.id, title: "Second" },
    ]);
    expect(Object.keys(children[0]).sort()).toEqual(["icon", "id", "title"]);
    expect(Object.keys(children[1]).sort()).toEqual(["id", "title"]);
    expect(Object.isFrozen(children)).toBe(true);
    expect(children.every(Object.isFrozen)).toBe(true);
  });

  it("returns an existing deterministic page id instead of creating a duplicate", async () => {
    const { s, root } = await tmpStore();
    const id = "quickcapture_abcdefghijklmnopqrstuvwxyz123456";
    const fingerprint = "a".repeat(64);
    const first = await s.createPage(null, "Captured thought", {
      id,
      quickCaptureFingerprint: fingerprint,
    });
    const parent = await s.createPage(null, "Filed home");
    await s.renamePage(id, "Renamed thought");
    await s.movePage(id, parent.id);
    const reloaded = new Store(root);
    await reloaded.init();
    const retry = await reloaded.createPage(null, "Captured thought", {
      id,
      quickCaptureFingerprint: fingerprint,
    });

    expect(retry.id).toBe(first.id);
    expect(retry.title).toBe("Renamed thought");
    expect(
      reloaded.getTree()[0].children.filter((page) => page.id === id),
    ).toHaveLength(1);
    await expect(
      reloaded.createPage(null, "Different thought", {
        id,
        quickCaptureFingerprint: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ name: "QuickCaptureConflictError" });
    expect(
      reloaded.getTree()[0].children.filter((page) => page.id === id),
    ).toHaveLength(1);
  });

  it("probes a committed Git notes root without leaving readiness files", async () => {
    const { s, root } = await tmpStore();
    await expect(s.readiness()).rejects.toThrow();

    await git(root, "init", "-q");
    await git(root, "commit", "--allow-empty", "-q", "-m", "initial notes");
    await expect(s.readiness()).resolves.toBeUndefined();

    const entries = await fs.readdir(root);
    expect(
      entries.some((entry) => entry.startsWith(".brain-readiness-")),
    ).toBe(false);
    const gitEntries = await fs.readdir(path.join(root, ".git"));
    expect(
      gitEntries.some((entry) => entry.startsWith(".brain-readiness-")),
    ).toBe(false);

    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      await fs.chmod(path.join(root, ".git"), 0o555);
      try {
        await expect(s.readiness()).rejects.toThrow();
      } finally {
        await fs.chmod(path.join(root, ".git"), 0o755);
      }
    }
  });

  it("snapshots a dirty Git worktree left behind by an interrupted debounce", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-dirty-start-"));
    await git(root, "init", "-q");
    await fs.writeFile(path.join(root, "seed.txt"), "seed\n");
    await commitAll(root, "initial notes");
    await fs.writeFile(path.join(root, "interrupted.txt"), "durable save\n");

    vi.useFakeTimers();
    try {
      const store = new Store(root);
      await store.init();
      await vi.advanceTimersByTimeAsync(4_100);
    } finally {
      vi.useRealTimers();
    }

    // Poll the committed object, not `git status`: status may refresh the
    // index and briefly own index.lock while the background `git add` starts,
    // turning the test itself into the competing Git process it is observing.
    await vi.waitFor(
      async () => {
        expect(await git(root, "show", "HEAD:interrupted.txt")).toBe(
          "durable save\n",
        );
      },
      { timeout: 2_000, interval: 25 },
    );
    expect((await git(root, "status", "--porcelain")).trim()).toBe("");
  });

  it("makes a background Git snapshot failure visible until a later snapshot heals it", async () => {
    const { s, root } = await tmpStore();
    await git(root, "init", "-q");
    await git(root, "commit", "--allow-empty", "-q", "-m", "initial notes");
    await fs.writeFile(path.join(root, "durable.txt"), "saved body\n");
    const lockPath = path.join(root, ".git", "index.lock");
    await fs.writeFile(lockPath, "held by another writer\n");

    vi.useFakeTimers();
    try {
      scheduleCommit(root);
      await vi.advanceTimersByTimeAsync(4_100);
      await expect(s.readiness()).rejects.toThrow(
        "Git history snapshot is unhealthy",
      );

      await fs.rm(lockPath);
      scheduleCommit(root);
      await vi.advanceTimersByTimeAsync(4_100);
      await expect(s.readiness()).resolves.toBeUndefined();
      expect(await git(root, "show", "HEAD:durable.txt")).toBe("saved body\n");
    } finally {
      vi.useRealTimers();
      await fs.rm(lockPath, { force: true });
    }
  });

  it("never reports green before a dirty startup snapshot is attempted", async () => {
    const { root } = await tmpStore();
    await git(root, "init", "-q");
    await git(root, "commit", "--allow-empty", "-q", "-m", "initial notes");
    await fs.writeFile(path.join(root, "durable.txt"), "saved before restart\n");
    const lockPath = path.join(root, ".git", "index.lock");
    await fs.writeFile(lockPath, "held across restart\n");

    const restarted = new Store(root);
    await restarted.init();
    await expect(restarted.readiness()).rejects.toThrow(
      "Git history snapshot is unhealthy",
    );

    await fs.rm(lockPath);
    await scheduleDirtyCommit(root);
    await expect(restarted.readiness()).resolves.toBeUndefined();
    expect(await git(root, "show", "HEAD:durable.txt")).toBe(
      "saved before restart\n",
    );
  });

  it("nests children", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    await s.createPage(parent.id, "Child");
    const tree = s.getTree();
    expect(tree[0].hasChildren).toBe(true);
    expect(tree[0].children[0].title).toBe("Child");
  });

  it("keeps sibling order stable and distinct", async () => {
    const { s } = await tmpStore();
    await s.createPage(null, "One");
    await s.createPage(null, "Two");
    await s.createPage(null, "Three");
    const tree = s.getTree();
    expect(tree.map((n) => n.title)).toEqual(["One", "Two", "Three"]);
    expect(new Set(tree.map((n) => n.order)).size).toBe(3);
  });

  it("serializes concurrent creates: distinct order keys, none dropped", async () => {
    // Fired in parallel (Promise.all) this is exactly the MCP-under-load case
    // that used to mint duplicate order keys — the mutation mutex must give
    // every sibling a distinct fractional index.
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const metas = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        s.createPage(parent.id, `Child ${i}`),
      ),
    );
    expect(metas.every((m) => typeof m.id === "string" && m.id)).toBe(true);
    const orders = metas.map((m) => m.order);
    expect(new Set(orders).size).toBe(orders.length); // all distinct
    const kids = s.getTree()[0].children;
    expect(kids).toHaveLength(12);
    expect(new Set(kids.map((k) => k.order)).size).toBe(12);
  });

  it("writes with rev, rejects a stale rev", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A", { markdown: "v1" });
    const p1 = await s.readPage(a.id);
    const p2 = await s.writePage(a.id, "v2", p1.rev);
    expect(p2.markdown).toBe("v2");
    await expect(s.writePage(a.id, "v3", p1.rev)).rejects.toBeInstanceOf(
      RevConflictError,
    );
    expect((await s.readPage(a.id)).markdown).toBe("v2");
  });

  it("merges a body write over metadata-only revision changes", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Before", { markdown: "body v1" });
    const stale = await s.readPage(page.id);

    await s.updateMeta(page.id, { title: "After", icon: "🧠" });
    const written = await s.writePage(
      page.id,
      "body v2",
      stale.rev,
      "me",
      undefined,
      stale.markdown,
    );

    expect(written.markdown).toBe("body v2");
    expect(written.meta).toMatchObject({ title: "After", icon: "🧠" });
  });

  it("persists page appearance and removes false toggles from frontmatter", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Appearance", { markdown: "body" });

    await s.updateMeta(page.id, {
      font: "serif",
      smallText: true,
      fullWidth: true,
      src: "appearance-test",
    });
    expect(s.getTree()[0]).toMatchObject({
      font: "serif",
      smallText: true,
      fullWidth: true,
    });

    const reloaded = new Store(root);
    await reloaded.init();
    expect((await reloaded.readPage(page.id)).meta).toMatchObject({
      font: "serif",
      smallText: true,
      fullWidth: true,
    });

    const cleared = await reloaded.updateMeta(page.id, {
      font: "sans",
      smallText: false,
      fullWidth: false,
    });
    expect(cleared.font).toBe("sans");
    expect(cleared.smallText).toBeUndefined();
    expect(cleared.fullWidth).toBeUndefined();

    const afterClear = new Store(root);
    await afterClear.init();
    const persisted = await afterClear.readPage(page.id);
    expect(persisted.meta.font).toBe("sans");
    expect(persisted.meta.smallText).toBeUndefined();
    expect(persisted.meta.fullWidth).toBeUndefined();
    const raw = await fs.readFile(
      path.join(afterClear.resolve(page.id), "index.md"),
      "utf8",
    );
    expect(raw).toMatch(/^font: sans$/m);
    expect(raw).not.toMatch(/^(smallText|fullWidth):/m);
  });

  it("keeps page appearance when duplicating a page", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Styled", { markdown: "body" });
    await s.updateMeta(page.id, {
      font: "mono",
      smallText: true,
      fullWidth: true,
    });

    const copy = await s.duplicatePage(page.id);

    expect(copy).toMatchObject({
      title: "Styled (copy)",
      font: "mono",
      smallText: true,
      fullWidth: true,
    });
    await expect(s.readPage(copy.id)).resolves.toMatchObject({ markdown: "body" });
  });

  it("rejects stale writes to the same metadata field", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Before");

    await s.updateMeta(page.id, {
      title: "First",
      expected: { title: "Before" },
    });
    await expect(
      s.updateMeta(page.id, {
        title: "Second",
        expected: { title: "Before" },
      }),
    ).rejects.toMatchObject({
      name: "MetadataConflictError",
      fields: ["title"],
    });
    await expect(s.readPage(page.id)).resolves.toMatchObject({
      meta: { title: "First" },
    });
  });

  it("allows concurrent metadata writes to different fields", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Before");

    await Promise.all([
      s.updateMeta(page.id, {
        title: "After",
        expected: { title: "Before" },
      }),
      s.updateMeta(page.id, {
        icon: "🧠",
        expected: { icon: null },
      }),
    ]);

    await expect(s.readPage(page.id)).resolves.toMatchObject({
      meta: { title: "After", icon: "🧠" },
    });
  });

  it("checks share password state without exposing its hash", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Shared");
    await s.updateMeta(page.id, {
      sharePass: "hash-one",
      expected: { shareLocked: false },
    });

    await expect(
      s.updateMeta(page.id, {
        sharePass: "hash-two",
        expected: { shareLocked: false },
      }),
    ).rejects.toMatchObject({
      fields: ["shareLocked"],
    });
  });

  it("moves a board card status and position in one Store mutation", async () => {
    const { s, root } = await tmpStore();
    const board = await s.createPage(null, "Board");
    await s.updateMeta(board.id, {
      view: "board",
      sections: ["Todo", "Done"],
    });
    const todo = await s.createPage(board.id, "Todo card", { status: "Todo" });
    const done = await s.createPage(board.id, "Done card", { status: "Done" });

    await s.mutateBoard({
      operation: "move-card",
      boardId: board.id,
      cardId: todo.id,
      status: "Done",
      beforeId: done.id,
    });

    const restarted = new Store(root);
    await restarted.init();
    const boardNode = restarted.getTree()[0];
    expect(boardNode.children.map((card) => card.id)).toEqual([
      todo.id,
      done.id,
    ]);
    await expect(restarted.readPage(todo.id)).resolves.toMatchObject({
      meta: { status: "Done" },
    });
    await expect(
      fs.stat(path.join(root, ".brain-board-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renames a populated board column atomically across restart", async () => {
    const { s, root } = await tmpStore();
    const board = await s.createPage(null, "Board");
    await s.updateMeta(board.id, {
      view: "board",
      sections: ["Todo", "Done"],
    });
    const first = await s.createPage(board.id, "First", { status: "Todo" });
    const second = await s.createPage(board.id, "Second", { status: "Todo" });

    await s.mutateBoard({
      operation: "rename-column",
      boardId: board.id,
      from: "Todo",
      to: "Next",
    });

    const restarted = new Store(root);
    await restarted.init();
    await expect(restarted.readPage(board.id)).resolves.toMatchObject({
      meta: { sections: ["Next", "Done"] },
    });
    await expect(restarted.readPage(first.id)).resolves.toMatchObject({
      meta: { status: "Next" },
    });
    await expect(restarted.readPage(second.id)).resolves.toMatchObject({
      meta: { status: "Next" },
    });
  });

  it("keeps board journal writer and recovery page-count limits identical", async () => {
    const { s, root } = await tmpStore();
    const internal = s as unknown as {
      writeBoardIntent: (intent: unknown) => Promise<void>;
      reconcileBoardIntent: () => Promise<void>;
    };
    const intent = (count: number) => ({
      version: 1,
      operation: "board",
      boardId: "board",
      pages: Array.from({ length: count }, (_, index) => {
        const pageId = `page-${index}`;
        const beforeRaw = serializePage(
          {
            id: pageId,
            title: "Before",
            order: `order-${index}`,
            created: "2026-01-01T00:00:00.000Z",
            updated: "2026-01-01T00:00:00.000Z",
          },
          "",
        );
        const afterRaw = serializePage(
          {
            id: pageId,
            title: "After",
            order: `order-${index}`,
            created: "2026-01-01T00:00:00.000Z",
            updated: "2026-01-01T00:00:01.000Z",
          },
          "",
        );
        return {
          pageId,
          indexFile: `missing-${index}/index.md`,
          beforeRaw,
          beforeRev: createHash("sha1")
            .update(beforeRaw)
            .digest("hex")
            .slice(0, 12),
          afterRaw,
          afterRev: createHash("sha1")
            .update(afterRaw)
            .digest("hex")
            .slice(0, 12),
        };
      }),
    });

    await internal.writeBoardIntent(intent(1_000));
    await expect(internal.reconcileBoardIntent()).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.rm(path.join(root, ".brain-board-intent.json"));

    await expect(internal.writeBoardIntent(intent(1_001))).rejects.toThrow(
      "too many pages",
    );
    await expect(
      fs.stat(path.join(root, ".brain-board-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["board", "first-card", "second-card"] as const)(
    "finishes every page after a crash before writing %s",
    async (crashAt) => {
    const { s, root } = await tmpStore();
    const board = await s.createPage(null, "Board");
    await s.updateMeta(board.id, {
      view: "board",
      sections: ["Todo", "Done"],
    });
    const first = await s.createPage(board.id, "First", { status: "Todo" });
    const second = await s.createPage(board.id, "Second", { status: "Todo" });
    const crashIndex = path.join(
      s.resolve(
        crashAt === "board"
          ? board.id
          : crashAt === "first-card"
            ? first.id
            : second.id,
      ),
      "index.md",
    );
    const restoreReconciliation = blockBoardIntentReconciliation(s);
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!injected && String(args[1]) === crashIndex) {
        injected = true;
        throw new Error(`simulated stop before ${crashAt}`);
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.mutateBoard({
          operation: "rename-column",
          boardId: board.id,
          from: "Todo",
          to: "Next",
        }),
      ).rejects.toThrow("could not be reconciled");
    } finally {
      rename.mockRestore();
      restoreReconciliation();
    }
    expect(injected).toBe(true);
    await expect(
      fs.stat(path.join(root, ".brain-board-intent.json")),
    ).resolves.toBeDefined();

    const restarted = new Store(root);
    await restarted.init();
    await expect(restarted.readPage(board.id)).resolves.toMatchObject({
      meta: { sections: ["Next", "Done"] },
    });
    await expect(restarted.readPage(first.id)).resolves.toMatchObject({
      meta: { status: "Next" },
    });
    await expect(restarted.readPage(second.id)).resolves.toMatchObject({
      meta: { status: "Next" },
    });
    await expect(
      fs.stat(path.join(root, ".brain-board-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects a stale body baseline after a real text change", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Conflict", { markdown: "body v1" });
    const stale = await s.readPage(page.id);
    await s.writePage(page.id, "remote body", stale.rev);

    await expect(
      s.writePage(
        page.id,
        "local body",
        stale.rev,
        "me",
        undefined,
        stale.markdown,
      ),
    ).rejects.toBeInstanceOf(RevConflictError);
    await expect(s.readPage(page.id)).resolves.toMatchObject({
      markdown: "remote body",
    });
  });

  it("serializes concurrent appends without losing fragments", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Log", { markdown: "start" });
    const fragments = Array.from({ length: 16 }, (_, i) => `fragment-${i}`);

    await Promise.all(fragments.map((fragment) => s.appendPage(page.id, fragment)));

    const markdown = (await s.readPage(page.id)).markdown;
    expect(markdown.split("\n\n")).toEqual(["start", ...fragments]);
  });

  it("persists share credentials and rotates their token version", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Shared");
    const first = await s.updateMeta(page.id, {
      public: true,
      sharePass: "hash-one",
      shareExpiresAt: "2026-08-03T12:00:00.000Z",
    });
    expect(first.shareVersion).toBeGreaterThan(0);

    const reloaded = new Store(root);
    await reloaded.init();
    const persisted = await reloaded.readPage(page.id);
    expect(persisted.meta.sharePass).toBe("hash-one");
    expect(persisted.meta.shareExpiresAt).toBe("2026-08-03T12:00:00.000Z");
    expect(persisted.meta.shareVersion).toBe(first.shareVersion);

    const expiryRotated = await reloaded.updateMeta(page.id, {
      shareExpiresAt: "2026-08-10T12:00:00.000Z",
    });
    expect(expiryRotated.shareVersion).toBe(first.shareVersion! + 1);
    const expiryVersion = expiryRotated.shareVersion!;

    const rotated = await reloaded.updateMeta(page.id, { sharePass: "hash-two" });
    expect(rotated.shareVersion).toBe(expiryVersion + 1);
  });

  it("counts the exact live subtree and binds enablement to that disclosure", async () => {
    const { s } = await tmpStore();
    const root = await s.createPage(null, "Root");
    const child = await s.createPage(root.id, "Child");
    await s.createPage(child.id, "Grandchild");
    await s.createPage(null, "Unrelated");

    const disclosed = await s.readShareScope(root.id);
    expect(disclosed).toMatchObject({
      rootId: root.id,
      descendantCount: 2,
      public: false,
      shareLocked: false,
    });

    await s.createPage(root.id, "Future child");
    await expect(
      s.configureShare(root.id, {
        enabled: true,
        expectedScopeToken: disclosed.scopeToken,
        sharePass: "hash",
        shareExpiresAt: "2026-08-03T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "ShareScopeConflictError",
      snapshot: { descendantCount: 3, public: false },
    });
    const unchanged = await s.readPage(root.id);
    expect(unchanged.meta.public).toBeUndefined();
    expect(unchanged.meta.sharePass).toBeUndefined();
    expect(unchanged.meta.shareExpiresAt).toBeUndefined();
  });

  it("discloses every configured overlapping root in stable token-bound order", async () => {
    const { s } = await tmpStore();
    const ancestor = await s.createPage(null, "Ancestor");
    const root = await s.createPage(ancestor.id, "Root");
    const descendantB = await s.createPage(root.id, "Descendant B");
    const descendantA = await s.createPage(root.id, "Descendant A");
    const unrelated = await s.createPage(null, "Unrelated");
    await s.updateMeta(ancestor.id, {
      public: true,
      shareExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    await s.updateMeta(descendantB.id, {
      public: true,
      shareExpiresAt: "not-an-iso-date",
    });
    await s.updateMeta(descendantA.id, { public: true });
    await s.updateMeta(unrelated.id, { public: true });

    const snapshot = await s.readShareScope(root.id);
    const descendants = [
      {
        rootId: descendantA.id,
        title: "Descendant A",
        relation: "descendant" as const,
        shareExpiresAt: null,
      },
      {
        rootId: descendantB.id,
        title: "Descendant B",
        relation: "descendant" as const,
        shareExpiresAt: "not-an-iso-date",
      },
    ].sort((a, b) => (a.rootId < b.rootId ? -1 : 1));
    expect(snapshot.overlappingRoots).toEqual([
      {
        rootId: ancestor.id,
        title: "Ancestor",
        relation: "ancestor",
        shareExpiresAt: "2020-01-01T00:00:00.000Z",
      },
      ...descendants,
    ]);

    await s.updateMeta(descendantA.id, { public: false });
    const changed = await s.readShareScope(root.id);
    expect(changed.scopeToken).not.toBe(snapshot.scopeToken);
    expect(changed.overlappingRoots.map((entry) => entry.rootId)).not.toContain(
      descendantA.id,
    );
    await expect(
      s.configureShare(root.id, {
        enabled: true,
        expectedScopeToken: snapshot.scopeToken,
      }),
    ).rejects.toMatchObject({
      name: "ShareScopeConflictError",
      snapshot: { scopeToken: changed.scopeToken },
    });
    expect((await s.readPage(root.id)).meta.public).toBeUndefined();
  });

  it("blocks a fresh nested grant but lets an existing overlapping root edit and revoke", async () => {
    const { s } = await tmpStore();
    const ancestor = await s.createPage(null, "Ancestor");
    const root = await s.createPage(ancestor.id, "Root");
    await s.updateMeta(ancestor.id, { public: true });

    const blocked = await s.readShareScope(root.id);
    await expect(
      s.configureShare(root.id, {
        enabled: true,
        expectedScopeToken: blocked.scopeToken,
      }),
    ).rejects.toMatchObject({
      name: "ShareScopeConflictError",
      snapshot: {
        overlappingRoots: [
          expect.objectContaining({
            rootId: ancestor.id,
            relation: "ancestor",
          }),
        ],
      },
    });
    expect((await s.readPage(root.id)).meta.public).toBeUndefined();

    // A legacy overlap is not migrated or frozen: management and revocation
    // remain available until the owner removes it explicitly.
    await s.updateMeta(root.id, { public: true });
    const existing = await s.readShareScope(root.id);
    await expect(
      s.configureShare(root.id, {
        enabled: true,
        expectedScopeToken: existing.scopeToken,
        sharePass: "replacement-hash",
      }),
    ).resolves.toBeUndefined();
    expect((await s.readPage(root.id)).meta.sharePass).toBe("replacement-hash");
    await expect(
      s.configureShare(root.id, { enabled: false }),
    ).resolves.toBeUndefined();
    expect((await s.readPage(root.id)).meta.public).toBeUndefined();
  });

  it("serializes concurrent ancestor and descendant grants so only one wins", async () => {
    const { s } = await tmpStore();
    const ancestor = await s.createPage(null, "Ancestor");
    const descendant = await s.createPage(ancestor.id, "Descendant");
    const [ancestorScope, descendantScope] = await Promise.all([
      s.readShareScope(ancestor.id),
      s.readShareScope(descendant.id),
    ]);

    const results = await Promise.allSettled([
      s.configureShare(ancestor.id, {
        enabled: true,
        expectedScopeToken: ancestorScope.scopeToken,
      }),
      s.configureShare(descendant.id, {
        enabled: true,
        expectedScopeToken: descendantScope.scopeToken,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: {
        name: "ShareScopeConflictError",
        snapshot: { overlappingRoots: [expect.any(Object)] },
      },
    });
    const publicRoots = (
      await Promise.all([s.readPage(ancestor.id), s.readPage(descendant.id)])
    ).filter((page) => page.meta.public);
    expect(publicRoots).toHaveLength(1);
  });

  it("persists public authority, password, and expiry in one share mutation", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Shared");
    const disclosed = await s.readShareScope(page.id);
    const persist = vi.spyOn(
      s as unknown as { persist: (entry: unknown) => Promise<void> },
      "persist",
    );

    await s.configureShare(page.id, {
      enabled: true,
      expectedScopeToken: disclosed.scopeToken,
      sharePass: "protected-hash",
      shareExpiresAt: "2026-08-03T12:00:00.000Z",
    });

    expect(persist).toHaveBeenCalledTimes(1);
    const reloaded = new Store(root);
    await reloaded.init();
    await expect(reloaded.readPage(page.id)).resolves.toMatchObject({
      meta: {
        public: true,
        sharePass: "protected-hash",
        shareExpiresAt: "2026-08-03T12:00:00.000Z",
        shareVersion: 1,
      },
    });
  });

  it("preserves disabled share credentials when re-enabling without replacements", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Shared");
    await s.updateMeta(page.id, {
      sharePass: "existing-hash",
      shareExpiresAt: "2026-08-03T12:00:00.000Z",
    });
    const disclosed = await s.readShareScope(page.id);

    await s.configureShare(page.id, {
      enabled: true,
      expectedScopeToken: disclosed.scopeToken,
    });

    await expect(s.readPage(page.id)).resolves.toMatchObject({
      meta: {
        public: true,
        sharePass: "existing-hash",
        shareExpiresAt: "2026-08-03T12:00:00.000Z",
      },
    });
  });

  it("revokes sharing without a stale subtree precondition", async () => {
    const { s } = await tmpStore();
    const root = await s.createPage(null, "Root");
    const disclosed = await s.readShareScope(root.id);
    await s.configureShare(root.id, {
      enabled: true,
      expectedScopeToken: disclosed.scopeToken,
      sharePass: null,
      shareExpiresAt: null,
    });
    await s.createPage(root.id, "New child");

    await s.configureShare(root.id, { enabled: false });

    const readBack = await s.readShareScope(root.id);
    expect(readBack).toMatchObject({
      descendantCount: 1,
      public: false,
    });
  });

  it("turns off sharing for a deleted subtree", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const child = await s.createPage(parent.id, "Child");
    await s.updateMeta(parent.id, {
      public: true,
      sharePass: "parent-hash",
      shareExpiresAt: "2026-08-03T12:00:00.000Z",
    });
    await s.updateMeta(child.id, {
      public: true,
      sharePass: "child-hash",
      shareExpiresAt: "2026-08-03T12:00:00.000Z",
    });

    await s.deletePage(parent.id);

    expect(s.isDeleted(parent.id)).toBe(true);
    expect(s.isDeleted(child.id)).toBe(true);
    expect((await s.readPage(parent.id)).meta.public).toBeUndefined();
    expect((await s.readPage(parent.id)).meta.sharePass).toBeUndefined();
    expect((await s.readPage(parent.id)).meta.shareExpiresAt).toBeUndefined();
    expect((await s.readPage(child.id)).meta.public).toBeUndefined();
    expect((await s.readPage(child.id)).meta.sharePass).toBeUndefined();
    expect((await s.readPage(child.id)).meta.shareExpiresAt).toBeUndefined();
  });

  it("checks subtree membership without exposing mutable tree state", async () => {
    const { s } = await tmpStore();
    const root = await s.createPage(null, "Root");
    const child = await s.createPage(root.id, "Child");
    const grandchild = await s.createPage(child.id, "Grandchild");
    const sibling = await s.createPage(null, "Sibling");

    expect(s.isWithinSubtree(root.id, root.id)).toBe(true);
    expect(s.isWithinSubtree(root.id, child.id)).toBe(true);
    expect(s.isWithinSubtree(root.id, grandchild.id)).toBe(true);
    expect(s.isWithinSubtree(child.id, grandchild.id)).toBe(true);
    expect(s.isWithinSubtree(child.id, root.id)).toBe(false);
    expect(s.isWithinSubtree(root.id, sibling.id)).toBe(false);
    expect(s.isWithinSubtree(root.id, "missing-page")).toBe(false);
    expect(s.isWithinSubtree("missing-root", child.id)).toBe(false);
  });

  it("writes attachments atomically through the store", async () => {
    const { s, root } = await tmpStore();
    const saved = await s.saveAttachment({
      data: new TextEncoder().encode("hello"),
      originalName: "notes.txt",
      mimeType: "text/plain",
    });

    expect(saved.name).toBe("notes.txt");
    expect(saved.url).toMatch(/^\/_attachments-v2\/[A-Za-z0-9_-]{12}\.txt$/);
    const fileName = saved.url.slice("/_attachments-v2/".length);
    await expect(
      fs.readFile(path.join(root, "_attachments", fileName), "utf8"),
    ).resolves.toBe("hello");
  });

  it.each(["generic", "notion"] as const)(
    "rejects a permanent attachment parent symlink for %s writes without touching its target",
    async (kind) => {
      const { s, root } = await tmpStore();
      const outside = await fs.mkdtemp(
        path.join(os.tmpdir(), "brain-attachment-outside-"),
      );
      await fs.symlink(outside, path.join(root, "_attachments"));
      let reservationToken = "";
      let sha256 = "";
      let failure: unknown;
      try {
        if (kind === "generic") {
          await s.saveAttachment({
            data: new TextEncoder().encode("must stay inside"),
            originalName: "blocked.txt",
            mimeType: "text/plain",
          });
        } else {
          const reserved = await reserveNotionImport(s, {
            notionId: NOTION_PAGE,
            sourceHash: SOURCE_A,
            parentId: null,
            title: "Blocked promotion",
          });
          if (reserved.status !== "reserved") {
            throw new Error("expected reservation");
          }
          reservationToken = reserved.reservationToken;
          const bytes = new TextEncoder().encode("staged only");
          const saved = await saveNotionAttachment(
            s,
            NOTION_PAGE,
            SOURCE_A,
            reservationToken,
            {
              data: bytes,
              originalName: "blocked.txt",
              mimeType: "text/plain",
            },
          );
          sha256 = createHash("sha256").update(bytes).digest("hex");
          const markdown = `[blocked](${saved.url})`;
          await s.finalizeNotionImport({
            notionId: NOTION_PAGE,
            sourceHash: SOURCE_A,
            conversionHash: conversionHash(
              SOURCE_A,
              "Blocked promotion",
              markdown,
            ),
            reservationToken,
            markdown,
          });
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "attachment_store_unavailable",
        message: "Attachment store is unavailable",
      });
      const message = failure instanceof Error ? failure.message : String(failure);
      if (reservationToken) expect(message).not.toContain(reservationToken);
      if (sha256) expect(message).not.toContain(sha256);
      await expect(fs.readdir(outside)).resolves.toEqual([]);
      await fs.rm(outside, { recursive: true, force: true });
    },
  );

  it("validates attachment size, active MIME, and known signatures in Store", async () => {
    const { s } = await tmpStore();

    await expect(
      s.saveAttachment({
        data: new Uint8Array(25 * 1024 * 1024 + 1),
        originalName: "large.bin",
        mimeType: "application/octet-stream",
      }),
    ).rejects.toMatchObject({
      name: "AttachmentValidationError",
      code: "too_large",
    });
    await expect(
      s.saveAttachment({
        data: new TextEncoder().encode("<script>alert(1)</script>"),
        originalName: "active.html",
        mimeType: "text/html",
      }),
    ).rejects.toMatchObject({
      code: "blocked_mime",
    });
    await expect(
      s.saveAttachment({
        data: new TextEncoder().encode("not a png"),
        originalName: "fake.png",
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({
      code: "mime_mismatch",
    });
  });

  it("derives a safe stored extension from MIME instead of an active filename", async () => {
    const { s } = await tmpStore();
    const text = await s.saveAttachment({
      data: new TextEncoder().encode("safe"),
      originalName: "renamed.html",
      mimeType: "text/plain; charset=utf-8",
    });
    const binary = await s.saveAttachment({
      data: new Uint8Array([1, 2, 3]),
      originalName: "unknown.html",
      mimeType: "application/octet-stream",
    });

    expect(text.url).toMatch(/\.txt$/);
    expect(text.type).toBe("text/plain");
    expect(binary.url).toMatch(/\.bin$/);
  });

  it("uses canonical raster MIME for signatures, URLs, and returned types", async () => {
    const { s } = await tmpStore();
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const misleadingJpg = await s.saveAttachment({
      data: jpeg,
      originalName: "photo.png",
      mimeType: "image/jpg",
    });
    const progressiveJpg = await s.saveAttachment({
      data: jpeg,
      originalName: "extensionless",
      mimeType: "image/pjpeg",
    });
    const extensionlessPng = await s.saveAttachment({
      data: png,
      originalName: "extensionless",
      mimeType: "image/x-png",
    });

    expect(misleadingJpg).toMatchObject({ type: "image/jpeg" });
    expect(misleadingJpg.url).toMatch(/\.jpg$/);
    expect(progressiveJpg).toMatchObject({ type: "image/jpeg" });
    expect(progressiveJpg.url).toMatch(/\.jpg$/);
    expect(extensionlessPng).toMatchObject({ type: "image/png" });
    expect(extensionlessPng.url).toMatch(/\.png$/);
    await expect(
      s.saveAttachment({
        data: png,
        originalName: "misleading.png",
        mimeType: "image/jpg",
      }),
    ).rejects.toMatchObject({ code: "mime_mismatch" });
  });

  it.each(["image/x-svg+xml", "application/svg+xml"])(
    "blocks canonical SVG alias %s from generic attachment upload",
    async (mimeType) => {
      const { s } = await tmpStore();
      await expect(
        s.saveAttachment({
          data: new TextEncoder().encode(
            '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
          ),
          originalName: "misleading.png",
          mimeType,
        }),
      ).rejects.toMatchObject({ code: "blocked_mime" });
    },
  );

  it("allows canonical SVG aliases only in Notion staging as downloadable files", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "SVG file",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const bytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    );
    const saved = await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: bytes,
        originalName: "misleading.png",
        mimeType: "image/x-svg+xml",
      },
    );
    expect(saved.type).toBe("image/svg+xml");
    expect(saved.url).toMatch(/\.svg$/);
    const markdown = `[download SVG](${saved.url})`;
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "SVG file", markdown),
      reservationToken: reserved.reservationToken,
      markdown,
    });
    expect(
      new Uint8Array(
        await fs.readFile(
          path.join(
            root,
            "_attachments",
            saved.url.slice("/_attachments-v2/".length),
          ),
        ),
      ),
    ).toEqual(bytes);
  });

  it("keeps aliased Notion cover URL, bytes, and type canonical", async () => {
    const { s, root } = await tmpStore();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const cover = notionAttachmentUrl(hash, "misleading.png", "image/jpg");
    expect(cover).toBe(`/_attachments-v2/${hash}.jpg`);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Aliased cover",
      cover,
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const saved = await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: bytes,
        originalName: "misleading.png",
        mimeType: "image/jpg",
      },
    );
    expect(saved).toMatchObject({ url: cover, type: "image/jpeg" });
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "Aliased cover",
        "body",
        undefined,
        cover,
      ),
      reservationToken: reserved.reservationToken,
      cover,
      markdown: "body",
    });
    expect(
      new Uint8Array(await fs.readFile(path.join(root, "_attachments", `${hash}.jpg`))),
    ).toEqual(bytes);
  });

  it("atomically reserves one page for concurrent calls with the same notionId", async () => {
    const { s } = await tmpStore();
    const attempts = await Promise.all(
      Array.from({ length: 12 }, () =>
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Harvest Log",
        }),
      ),
    );

    expect(attempts.filter((result) => result.status === "reserved")).toHaveLength(1);
    const busy = attempts.filter((result) => result.status === "busy");
    expect(busy).toHaveLength(11);
    expect(busy[0]).toMatchObject({
      retryAfterMs: expect.any(Number),
    });
    if (busy[0]?.status === "busy") {
      expect(busy[0].retryAfterMs).toBeGreaterThan(14 * 60 * 1_000);
      expect(busy[0].retryAfterMs).toBeLessThanOrEqual(15 * 60 * 1_000);
    }
    expect(new Set(attempts.map((result) => result.page.id)).size).toBe(1);
    expect(s.getTree()).toHaveLength(1);
  });

  it("reconciles a completed reserve rename after a transient directory fsync failure", async () => {
    const { s, root } = await tmpStore();
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const [file, flags] = args;
      if (
        !injected &&
        flags === "r" &&
        path.dirname(String(file)) === root &&
        path.basename(String(file)) === "page"
      ) {
        injected = true;
        vi.spyOn(handle, "sync").mockRejectedValueOnce(
          new Error("transient directory fsync failure"),
        );
      }
      return handle;
    });
    try {
      const token = "client_saved_token_1234567890";
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
        reservationToken: token,
      });

      expect(injected).toBe(true);
      expect(reserved).toMatchObject({
        status: "reserved",
        reservationToken: token,
      });
      expect(s.getTree()).toHaveLength(1);
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Page",
          reservationToken: token,
        }),
      ).resolves.toMatchObject({
        status: "reserved",
        page: { id: reserved.page.id },
      });
      expect(s.getTree()).toHaveLength(1);
    } finally {
      open.mockRestore();
    }
  });

  it("does not acknowledge reserve while post-rename directory fsync keeps failing", async () => {
    const { s } = await tmpStore();
    const realOpen = fs.open.bind(fs);
    const token = "persistent_fsync_token_1234";
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const [file, flags] = args;
      if (flags === "r" && path.basename(String(file)) === "page") {
        vi.spyOn(handle, "sync").mockRejectedValue(
          new Error("persistent directory fsync failure"),
        );
      }
      return handle;
    });
    try {
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Page",
          reservationToken: token,
        }),
      ).rejects.toThrow("persistent directory fsync failure");
      expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
        notionId: NOTION_PAGE,
        importing: { sourceHash: SOURCE_A },
      });
      expect(s.getTree()).toHaveLength(1);
    } finally {
      open.mockRestore();
    }

    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
        reservationToken: token,
      }),
    ).resolves.toMatchObject({
      status: "reserved",
      reservationToken: token,
      created: false,
    });
    expect(s.getTree()).toHaveLength(1);
  });

  it.each(["adopted", "finalized"] as const)(
    "keeps a visible %s-page reservation owned after persistent post-rename fsync failure",
    async (kind) => {
      const { s } = await tmpStore();
      let pageId: string;
      if (kind === "adopted") {
        const page = await s.createPage(null, "Existing", { markdown: "old" });
        await adoptExisting(s, page.id, NOTION_PAGE, SOURCE_A);
        pageId = page.id;
      } else {
        const first = await reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Existing",
        });
        if (first.status !== "reserved") throw new Error("expected reservation");
        await s.finalizeNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          conversionHash: conversionHash(SOURCE_A, "Existing", "old"),
          reservationToken: first.reservationToken,
          markdown: "old",
        });
        pageId = first.page.id;
      }

      const pageDir = s.resolve(pageId);
      const indexPath = path.join(pageDir, "index.md");
      const ownerToken = `visible_${kind}_owner_token_0001`;
      const competitorToken = `visible_${kind}_competitor_0001`;
      const realOpen = fs.open.bind(fs);
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const [file, flags] = args;
        if (flags === "r" && String(file) === pageDir) {
          vi.spyOn(handle, "sync").mockRejectedValue(
            new Error("persistent existing reserve directory fsync failure"),
          );
        }
        return handle;
      });
      try {
        await expect(
          reserveNotionImport(s, {
            notionId: NOTION_PAGE,
            sourceHash: SOURCE_B,
            parentId: null,
            title: "Existing",
            reservationToken: ownerToken,
          }),
        ).rejects.toThrow("persistent existing reserve directory fsync failure");
      } finally {
        open.mockRestore();
      }

      expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: pageId,
        importing: { sourceHash: SOURCE_B, leaseFresh: true },
      });
      expect((await s.readPage(pageId)).meta.notionImportToken).toBe(ownerToken);

      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          parentId: null,
          title: "Existing",
          reservationToken: competitorToken,
        }),
      ).resolves.toMatchObject({ status: "busy", page: { id: pageId } });
      expect(await fs.readFile(indexPath, "utf8")).not.toContain(competitorToken);

      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          parentId: null,
          title: "Existing",
          reservationToken: ownerToken,
        }),
      ).resolves.toMatchObject({
        status: "reserved",
        page: { id: pageId },
        reservationToken: ownerToken,
      });
    },
  );

  it("does not fall back to root when a notion parent is missing", async () => {
    const { s } = await tmpStore();

    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: "missing-parent",
        title: "Child",
      }),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    expect(s.getTree()).toHaveLength(0);
    expect(s.findNotionPage(NOTION_PAGE)).toBeNull();
  });

  it("enforces one page per notionId even through the generic Store API", async () => {
    const { s } = await tmpStore();
    const first = await s.createPage(null, "First", { notionId: NOTION_PAGE });

    await expect(
      s.createPage(null, "Duplicate", { notionId: NOTION_PAGE }),
    ).rejects.toMatchObject({
      name: "NotionImportConflictError",
      code: "reservation_mismatch",
    });
    expect(s.getTree().map((page) => page.id)).toEqual([first.id]);
  });

  it("persists reservation ownership across a Store restart", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");

    const reloaded = new Store(root);
    await reloaded.init();
    const resumed = await reserveNotionImport(reloaded, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
      reservationToken: reserved.reservationToken,
    });

    expect(resumed).toMatchObject({
      status: "reserved",
      page: { id: reserved.page.id },
      reservationToken: reserved.reservationToken,
      created: false,
    });
  });

  it("takes over an abandoned reservation only after its TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-11T10:00:00.000Z"));
      const { s } = await tmpStore();
      const first = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
      });
      if (first.status !== "reserved") throw new Error("expected reservation");

      vi.setSystemTime(new Date("2026-07-11T10:16:00.000Z"));
      const takeover = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        parentId: null,
        title: "Page",
      });

      expect(takeover.status).toBe("reserved");
      if (takeover.status !== "reserved") throw new Error("expected takeover");
      expect(takeover.reservationToken).not.toBe(first.reservationToken);
      expect(takeover.created).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the reservation lease when an attachment upload makes progress", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-11T10:00:00.000Z"));
      const { s } = await tmpStore();
      const first = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
      });
      if (first.status !== "reserved") throw new Error("expected reservation");

      vi.setSystemTime(new Date("2026-07-11T10:14:00.000Z"));
      await saveNotionAttachment(s,
        NOTION_PAGE,
        SOURCE_A,
        first.reservationToken,
        {
          data: new TextEncoder().encode("progress"),
          originalName: "progress.txt",
          mimeType: "text/plain",
        },
      );
      vi.setSystemTime(new Date("2026-07-11T10:16:00.000Z"));
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          parentId: null,
          title: "Page",
        }),
      ).resolves.toMatchObject({ status: "busy" });

      vi.setSystemTime(new Date("2026-07-11T10:31:00.000Z"));
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          parentId: null,
          title: "Page",
        }),
      ).resolves.toMatchObject({ status: "reserved" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a visibly renewed near-expiry lease owned after post-rename fsync failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-11T10:00:00.000Z"));
      const { s } = await tmpStore();
      const ownerToken = "near_expiry_owner_token_0001";
      const competitorToken = "near_expiry_competitor_0001";
      const first = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
        reservationToken: ownerToken,
      });
      if (first.status !== "reserved") throw new Error("expected reservation");

      const pageDir = s.resolve(first.page.id);
      const indexPath = path.join(pageDir, "index.md");
      vi.setSystemTime(new Date("2026-07-11T10:14:59.000Z"));
      const realOpen = fs.open.bind(fs);
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const [file, flags] = args;
        if (flags === "r" && String(file) === pageDir) {
          vi.spyOn(handle, "sync").mockRejectedValue(
            new Error("persistent renewal directory fsync failure"),
          );
        }
        return handle;
      });
      try {
        await expect(
          reserveNotionImport(s, {
            notionId: NOTION_PAGE,
            sourceHash: SOURCE_A,
            parentId: null,
            title: "Page",
            reservationToken: ownerToken,
          }),
        ).rejects.toThrow("persistent renewal directory fsync failure");
      } finally {
        open.mockRestore();
      }

      vi.setSystemTime(new Date("2026-07-11T10:15:01.000Z"));
      expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
        importing: { sourceHash: SOURCE_A, leaseFresh: true },
      });
      expect((await s.readPage(first.page.id)).meta.notionImportToken).toBe(
        ownerToken,
      );
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          parentId: null,
          title: "Page",
          reservationToken: competitorToken,
        }),
      ).resolves.toMatchObject({ status: "busy", page: { id: first.page.id } });
      expect(await fs.readFile(indexPath, "utf8")).not.toContain(competitorToken);

      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Page",
          reservationToken: ownerToken,
        }),
      ).resolves.toMatchObject({
        status: "reserved",
        page: { id: first.page.id },
        reservationToken: ownerToken,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes a notion reservation once and makes retries idempotent", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Harvest Log",
    });
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") throw new Error("expected reservation");

    const finalized = await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "🧺 Harvest Log",
        "Imported body",
      ),
      reservationToken: reserved.reservationToken,
      title: "🧺 Harvest Log",
      markdown: "Imported body",
    });
    const repeated = await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "🧺 Harvest Log",
        "Imported body",
      ),
      reservationToken: reserved.reservationToken,
      markdown: "must not overwrite",
    });
    const skipped = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "🧺 Harvest Log",
        "Imported body",
      ),
      parentId: null,
      title: "ignored",
    });

    expect(finalized.status).toBe("finalized");
    expect(repeated.status).toBe("unchanged");
    expect(skipped.status).toBe("unchanged");
    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          "🧺 Harvest Log",
          "Imported body",
        ),
        reservationToken: "short",
        markdown: "Imported body",
      }),
    ).rejects.toMatchObject({ code: "reservation_mismatch" });
    await expect(s.readPage(reserved.page.id)).resolves.toMatchObject({
      markdown: "Imported body",
      meta: {
        title: "🧺 Harvest Log",
        notionId: NOTION_PAGE,
        notionSourceHash: SOURCE_A,
        notionTargetRev: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const reloaded = new Store(root);
    await reloaded.init();
    expect(reloaded.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: reserved.page.id,
      sourceHash: SOURCE_A,
    });
  });

  it("reconciles a finalized page after persistent post-rename directory fsync failure", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Durable finalize",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const pageDir = s.resolve(reserved.page.id);
    const input = {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "Durable finalize",
        "finalized despite the durability error",
      ),
      reservationToken: reserved.reservationToken,
      markdown: "finalized despite the durability error",
    };
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const [file, flags] = args;
      if (flags === "r" && String(file) === pageDir) {
        vi.spyOn(handle, "sync").mockRejectedValue(
          new Error("persistent finalize directory fsync failure"),
        );
      }
      return handle;
    });
    try {
      await expect(s.finalizeNotionImport(input)).rejects.toThrow(
        "persistent finalize directory fsync failure",
      );
    } finally {
      open.mockRestore();
    }

    const reloaded = new Store(root);
    await reloaded.init();
    const reloadedPage = await reloaded.readPage(reserved.page.id);
    expect(reloadedPage).toMatchObject({
      markdown: "finalized despite the durability error",
      meta: {
        notionId: NOTION_PAGE,
        notionSourceHash: SOURCE_A,
      },
    });
    expect(reloadedPage.meta.notionImportHash).toBeUndefined();
    await expect(reloaded.finalizeNotionImport(input)).resolves.toMatchObject({
      status: "unchanged",
      page: { id: reserved.page.id },
    });
  });

  it("performs a complete unchanged second run without rewriting notes", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      beforeId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const targetHash = conversionHash(SOURCE_A, "Page", "body");
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: targetHash,
      reservationToken: reserved.reservationToken,
      markdown: "body",
    });
    const indexPath = path.join(s.resolve(reserved.page.id), "index.md");
    const before = await fs.readFile(indexPath, "utf8");
    const realRename = fs.rename.bind(fs);
    const noteRenames: string[] = [];
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === indexPath) noteRenames.push(String(args[1]));
      return realRename(...args);
    });
    try {
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          conversionHash: targetHash,
          parentId: null,
          beforeId: null,
          title: "Page",
        }),
      ).resolves.toMatchObject({ status: "unchanged" });
      await expect(
        s.finalizeNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          conversionHash: targetHash,
          reservationToken: reserved.reservationToken,
          markdown: "body",
        }),
      ).resolves.toMatchObject({ status: "unchanged" });
    } finally {
      rename.mockRestore();
    }
    expect(noteRenames).toEqual([]);
    expect(await fs.readFile(indexPath, "utf8")).toBe(before);
  });

  it("rejects a manual reorder without an importer write", async () => {
    const { s } = await tmpStore();
    const next = await s.createPage(null, "Next");
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      beforeId: next.id,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const targetHash = conversionHash(
      SOURCE_A,
      "Page",
      "body",
      undefined,
      undefined,
      null,
      next.id,
    );
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: targetHash,
      reservationToken: reserved.reservationToken,
      markdown: "body",
    });
    await s.movePage(reserved.page.id, null, null, "manual-test");
    const indexPath = path.join(s.resolve(reserved.page.id), "index.md");
    const before = await fs.readFile(indexPath, "utf8");
    const realRename = fs.rename.bind(fs);
    const noteRenames: string[] = [];
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[1]) === indexPath) noteRenames.push(String(args[1]));
      return realRename(...args);
    });
    try {
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          conversionHash: targetHash,
          parentId: null,
          beforeId: next.id,
          title: "Page",
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
    } finally {
      rename.mockRestore();
    }
    expect(noteRenames).toEqual([]);
    expect(await fs.readFile(indexPath, "utf8")).toBe(before);
  });

  it("updates an imported page in place when its source hash changes", async () => {
    const { s } = await tmpStore();
    const first = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (first.status !== "reserved") throw new Error("expected reservation");
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Page", "v1"),
      reservationToken: first.reservationToken,
      markdown: "v1",
    });

    const second = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: null,
      title: "Page",
    });
    expect(second.status).toBe("reserved");
    if (second.status !== "reserved") throw new Error("expected reservation");
    expect(second.page.id).toBe(first.page.id);
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      conversionHash: conversionHash(SOURCE_B, "Page", "v2"),
      reservationToken: second.reservationToken,
      markdown: "v2",
    });
    await expect(s.readPage(first.page.id)).resolves.toMatchObject({
      markdown: "v2",
      meta: { notionSourceHash: SOURCE_B },
    });
  });

  it("refuses changed-source import after a manual edit since the last finalize", async () => {
    const { s } = await tmpStore();
    const first = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (first.status !== "reserved") throw new Error("expected reservation");
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Page", "source v1"),
      reservationToken: first.reservationToken,
      markdown: "source v1",
    });
    await s.writePage(first.page.id, "manual edit after import", undefined, "me");

    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        parentId: null,
        title: "Page",
      }),
    ).rejects.toMatchObject({
      name: "NotionImportConflictError",
      code: "source_changed",
    });
    await expect(s.readPage(first.page.id)).resolves.toMatchObject({
      markdown: "manual edit after import",
      meta: { notionSourceHash: SOURCE_A },
    });
    expect(s.findNotionPage(NOTION_PAGE)?.importing).toBeUndefined();
  });

  it("tracks finalized title, icon, and cover when guarding a later source update", async () => {
    const { s } = await tmpStore();
    const coverBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const cover = `/_attachments-v2/${createHash("sha256").update(coverBytes).digest("hex")}.png`;
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
      icon: "📄",
      cover,
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: coverBytes,
        originalName: "cover.png",
        mimeType: "image/png",
      },
    );
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "Page",
        "source v1",
        "📄",
        cover,
      ),
      reservationToken: reserved.reservationToken,
      title: "Page",
      icon: "📄",
      cover,
      markdown: "source v1",
    });
    await s.updateMeta(reserved.page.id, { title: "Manual title", by: "me" });

    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        parentId: null,
        title: "Page from Notion",
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect((await s.readPage(reserved.page.id)).meta.title).toBe("Manual title");
  });

  it("fails safe for an existing notionId without a trusted target baseline", async () => {
    const { s } = await tmpStore();
    const existing = await s.createPage(null, "Previously imported", {
      notionId: NOTION_PAGE,
      markdown: "manual or legacy content",
    });

    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Previously imported",
      }),
    ).rejects.toMatchObject({
      name: "NotionImportConflictError",
      code: "untracked_existing",
    });
    const preserved = await s.readPage(existing.id);
    expect(preserved.markdown).toBe("manual or legacy content");
    expect(preserved.meta.notionSourceHash).toBeUndefined();
  });

  it("refuses to finalize over a body edit made after reservation", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.writePage(reserved.page.id, "manual edit", undefined, "me");

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Page", "imported"),
        reservationToken: reserved.reservationToken,
        markdown: "imported",
      }),
    ).rejects.toMatchObject({
      name: "NotionImportConflictError",
      code: "source_changed",
    });
    await expect(s.readPage(reserved.page.id)).resolves.toMatchObject({
      markdown: "manual edit",
    });
  });

  it("refuses to finalize over a title edit made after reservation", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Source title",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.updateMeta(reserved.page.id, { title: "Manual title", by: "me" });

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          "Imported title",
          "imported",
        ),
        reservationToken: reserved.reservationToken,
        title: "Imported title",
        markdown: "imported",
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect((await s.readPage(reserved.page.id)).meta.title).toBe("Manual title");
  });

  it("allows attachment uploads only for the matching notion reservation", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const input = {
      data: new TextEncoder().encode("attachment"),
      originalName: "note.txt",
      mimeType: "text/plain",
    };

    await expect(
      saveNotionAttachment(s, NOTION_PAGE, SOURCE_A, "wrong-token", input),
    ).rejects.toMatchObject({
      code: "reservation_mismatch",
    });
    const first = await saveNotionAttachment(s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      input,
    );
    const repeated = await saveNotionAttachment(s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      input,
    );
    expect(first).toMatchObject({ name: "note.txt", type: "text/plain" });
    expect(repeated.url).toBe(first.url);
  });

  it("adopts a reviewed existing page without changing content or hierarchy", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Field Guide");
    const page = await s.createPage(parent.id, "Family", {
      markdown: "Existing reviewed body",
      icon: "👨‍👩‍👧‍👦",
    });
    const beforePath = s.resolve(page.id);
    const before = await s.readPage(page.id);
    const { adopted, targetHash } = await adoptExisting(
      s,
      page.id,
      NOTION_PAGE,
    );

    expect(adopted).toMatchObject({
      status: "adopted",
      page: {
        id: page.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        current: { parentId: parent.id, beforeId: null },
        trackedBaseline: {
          parentId: parent.id,
          beforeId: null,
          order: expect.any(String),
        },
      },
    });
    expect(s.resolve(page.id)).toBe(beforePath);
    expect(await s.readPage(page.id)).toMatchObject({
      markdown: before.markdown,
      meta: { title: "Family", icon: "👨‍👩‍👧‍👦" },
    });
    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: targetHash,
        parentId: parent.id,
        beforeId: null,
        title: "Family",
      }),
    ).resolves.toMatchObject({ status: "unchanged", page: { id: page.id } });
  });

  it("inspects adoption candidates without returning bodies or reservation capabilities", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Root");
    const unbound = await s.createPage(parent.id, "Private candidate", {
      markdown: "body must not cross the candidate boundary",
    });
    const unboundRead = await s.readPage(unbound.id);
    const unboundPlacement = findPlacement(s.getTree(), unbound.id);
    if (!unboundPlacement) throw new Error("candidate placement is missing");
    const inspected = await s.inspectNotionCandidate(unbound.id);
    expect(inspected).toEqual({
      id: unbound.id,
      rev: unboundRead.rev,
      current: unboundPlacement,
      deleted: false,
      bindingState: "unbound",
      notionId: undefined,
      sourceHash: undefined,
      conversionHash: undefined,
      trackedTargetIntact: undefined,
      trackedAttachmentIntact: undefined,
      legacyBindingUpgradeable: false,
    });
    expect(inspected).not.toHaveProperty("title");
    expect(inspected).not.toHaveProperty("markdown");
    expect(inspected).not.toHaveProperty("order");
    expect(JSON.stringify(inspected)).not.toContain("Token");

    const tracked = await s.createPage(parent.id, "Tracked", {
      markdown: "tracked body",
    });
    await adoptExisting(s, tracked.id, NOTION_PAGE);
    await expect(s.inspectNotionCandidate(tracked.id)).resolves.toMatchObject({
      id: tracked.id,
      bindingState: "tracked",
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      trackedTargetIntact: true,
      trackedAttachmentIntact: true,
    });
    await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: parent.id,
      beforeId: null,
      title: "Tracked",
    });
    const pending = await s.inspectNotionCandidate(tracked.id);
    expect(pending).toMatchObject({
      id: tracked.id,
      bindingState: "import_pending",
      notionId: NOTION_PAGE,
    });
    expect(JSON.stringify(pending)).not.toContain("reservationToken");

    const deleted = await s.createPage(null, "Deleted candidate");
    await s.deletePage(deleted.id);
    await expect(s.inspectNotionCandidate(deleted.id)).resolves.toMatchObject({
      id: deleted.id,
      deleted: true,
      bindingState: "unbound",
    });
  });

  it("upgrades only an exact notionId-only legacy binding", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Root");
    const legacy = await s.createPage(parent.id, "Spanish", {
      markdown: "legacy body",
    });
    await writeRawPageMeta(s, legacy.id, { notionId: NOTION_PAGE });

    const reloaded = new Store(root);
    await reloaded.init();
    const candidate = await reloaded.inspectNotionCandidate(legacy.id);
    expect(candidate).toMatchObject({
      bindingState: "bound_untracked",
      notionId: NOTION_PAGE,
      legacyBindingUpgradeable: true,
    });
    const before = await reloaded.readPage(legacy.id);
    const placement = findPlacement(reloaded.getTree(), legacy.id);
    if (!placement) throw new Error("legacy page is missing from tree");
    await expect(
      reloaded.adoptNotionImport({
        pageId: legacy.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          before.meta.title,
          before.markdown,
          before.meta.icon,
          before.meta.cover,
          placement.parentId,
          placement.beforeId,
        ),
        expectedRev: before.rev,
        expectedParentId: placement.parentId,
        expectedBeforeId: placement.beforeId,
      }),
    ).resolves.toMatchObject({
      status: "adopted",
      page: { id: legacy.id, notionId: NOTION_PAGE },
    });
    await expect(reloaded.readPage(legacy.id)).resolves.toMatchObject({
      markdown: before.markdown,
      meta: { title: before.meta.title },
    });

    const partial = await reloaded.createPage(parent.id, "Partial", {
      markdown: "partial body",
    });
    await writeRawPageMeta(reloaded, partial.id, {
      notionId: NOTION_PAGE_B,
      notionSourceHash: SOURCE_A,
    });
    const partialReloaded = new Store(root);
    await partialReloaded.init();
    await expect(
      partialReloaded.inspectNotionCandidate(partial.id),
    ).resolves.toMatchObject({
      bindingState: "bound_untracked",
      notionId: NOTION_PAGE_B,
      legacyBindingUpgradeable: false,
    });
    const partialRead = await partialReloaded.readPage(partial.id);
    const partialPlacement = findPlacement(partialReloaded.getTree(), partial.id);
    if (!partialPlacement) throw new Error("partial page is missing from tree");
    await expect(
      partialReloaded.adoptNotionImport({
        pageId: partial.id,
        notionId: NOTION_PAGE_B,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          partialRead.meta.title,
          partialRead.markdown,
          partialRead.meta.icon,
          partialRead.meta.cover,
          partialPlacement.parentId,
          partialPlacement.beforeId,
        ),
        expectedRev: partialRead.rev,
        expectedParentId: partialPlacement.parentId,
        expectedBeforeId: partialPlacement.beforeId,
      }),
    ).rejects.toMatchObject({ code: "already_imported" });
  });

  it("reconciles adoption after persistent post-rename directory fsync failure", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Durable adoption", {
      markdown: "reviewed body",
    });
    const read = await s.readPage(page.id);
    const placement = findPlacement(s.getTree(), page.id);
    if (!placement) throw new Error("page is missing from tree");
    const input = {
      pageId: page.id,
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "Durable adoption",
        "reviewed body",
        undefined,
        undefined,
        placement.parentId,
        placement.beforeId,
      ),
      expectedRev: read.rev,
      expectedParentId: placement.parentId,
      expectedBeforeId: placement.beforeId,
    };
    const pageDir = s.resolve(page.id);
    const realOpen = fs.open.bind(fs);
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const [file, flags] = args;
      if (flags === "r" && String(file) === pageDir) {
        vi.spyOn(handle, "sync").mockRejectedValue(
          new Error("persistent adoption directory fsync failure"),
        );
      }
      return handle;
    });
    try {
      await expect(s.adoptNotionImport(input)).rejects.toThrow(
        "persistent adoption directory fsync failure",
      );
    } finally {
      open.mockRestore();
    }

    const reloaded = new Store(root);
    await reloaded.init();
    expect(reloaded.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: page.id,
      sourceHash: SOURCE_A,
    });
    await expect(reloaded.adoptNotionImport(input)).resolves.toMatchObject({
      status: "adopted",
      page: { id: page.id },
    });
    expect((await reloaded.readPage(page.id)).markdown).toBe("reviewed body");
  });

  it("rejects stale or duplicate adoption without changing either page", async () => {
    const { s } = await tmpStore();
    const first = await s.createPage(null, "First", { markdown: "one" });
    const second = await s.createPage(null, "Second", { markdown: "two" });
    const stale = await s.readPage(first.id);
    const firstPlacement = findPlacement(s.getTree(), first.id);
    if (!firstPlacement) throw new Error("first page is missing from tree");
    await s.writePage(first.id, "edited", stale.rev, "me");

    await expect(
      s.adoptNotionImport({
        pageId: first.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "First", "one"),
        expectedRev: stale.rev,
        expectedParentId: firstPlacement.parentId,
        expectedBeforeId: firstPlacement.beforeId,
      }),
    ).rejects.toBeInstanceOf(RevConflictError);
    expect(s.findNotionPage(NOTION_PAGE)).toBeNull();

    await adoptExisting(s, first.id, NOTION_PAGE);
    const secondRead = await s.readPage(second.id);
    const secondPlacement = findPlacement(s.getTree(), second.id);
    if (!secondPlacement) throw new Error("second page is missing from tree");
    await expect(
      s.adoptNotionImport({
        pageId: second.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Second", "two"),
        expectedRev: secondRead.rev,
        expectedParentId: secondPlacement.parentId,
        expectedBeforeId: secondPlacement.beforeId,
      }),
    ).rejects.toMatchObject({ code: "reservation_mismatch" });
    expect((await s.readPage(second.id)).meta.notionId).toBeUndefined();
  });

  it("rejects adoption when an unchanged page gains a different next sibling", async () => {
    const { s } = await tmpStore();
    const first = await s.createPage(null, "First", { markdown: "one" });
    const second = await s.createPage(null, "Second", { markdown: "two" });
    const read = await s.readPage(first.id);
    const placement = findPlacement(s.getTree(), first.id);
    if (!placement) throw new Error("first page is missing from tree");
    const inserted = await s.createPage(null, "Inserted");
    await s.movePage(inserted.id, null, second.id);

    await expect(
      s.adoptNotionImport({
        pageId: first.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "First", "one"),
        expectedRev: read.rev,
        expectedParentId: placement.parentId,
        expectedBeforeId: placement.beforeId,
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(s.findNotionPage(NOTION_PAGE)).toBeNull();
  });

  it("rejects a mismatched target hash before moving or overwriting the page", async () => {
    const { s } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const page = await s.createPage(p1.id, "Child", { markdown: "old" });
    await adoptExisting(s, page.id, NOTION_PAGE);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: p2.id,
      beforeId: null,
      title: "Child",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const completeHash = conversionHash(SOURCE_B, "Child", "complete body");

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        conversionHash: completeHash,
        reservationToken: reserved.reservationToken,
        markdown: "truncated",
      }),
    ).rejects.toMatchObject({ code: "conversion_mismatch" });
    expect(s.getTree().find((node) => node.id === p1.id)?.children).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: page.id })]),
    );
    expect((await s.readPage(page.id)).markdown).toBe("old");
    expect(s.findNotionPage(NOTION_PAGE)?.importing).toMatchObject({
      sourceHash: SOURCE_B,
    });
  });

  it("rejects a file or URL page icon before moving or overwriting the page", async () => {
    const { s } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const page = await s.createPage(p1.id, "Child", { markdown: "old" });
    await adoptExisting(s, page.id, NOTION_PAGE);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: p2.id,
      beforeId: null,
      title: "Child",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const icon = "https://notion.test/custom-icon.png";

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        conversionHash: conversionHash(SOURCE_B, "Child", "new", icon),
        reservationToken: reserved.reservationToken,
        icon,
        markdown: "new",
      }),
    ).rejects.toMatchObject({ code: "incompatible_icon" });
    expect((await s.readPage(page.id)).markdown).toBe("old");
    expect(s.getTree().find((node) => node.id === p1.id)?.children[0]?.id).toBe(
      page.id,
    );
  });

  it("stops when a sibling is inserted after reserve without touching the page rev", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "A", { markdown: "a" });
    const next = await s.createPage(null, "B", { markdown: "b" });
    await adoptExisting(s, page.id, NOTION_PAGE);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: null,
      beforeId: next.id,
      title: "A",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const inserted = await s.createPage(null, "Inserted");
    await s.movePage(inserted.id, null, next.id);

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        conversionHash: conversionHash(SOURCE_B, "A", "a"),
        reservationToken: reserved.reservationToken,
        markdown: "a",
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(s.getTree().map((node) => node.title)).toEqual([
      "A",
      "Inserted",
      "B",
    ]);
  });

  it("does not certify an idempotent finalize after a manual target edit", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const targetHash = conversionHash(SOURCE_A, "Page", "imported");
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: targetHash,
      reservationToken: reserved.reservationToken,
      markdown: "imported",
    });
    await s.writePage(reserved.page.id, "manual edit", undefined, "me");

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: targetHash,
        reservationToken: reserved.reservationToken,
        markdown: "imported",
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect((await s.readPage(reserved.page.id)).markdown).toBe("manual edit");
  });

  it("fails closed when the reserved target parent is deleted before finalize", async () => {
    const { s } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const page = await s.createPage(p1.id, "Child", { markdown: "old" });
    await adoptExisting(s, page.id, NOTION_PAGE);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: p2.id,
      title: "Child",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.deletePage(p2.id);

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        conversionHash: conversionHash(SOURCE_B, "Child", "new"),
        reservationToken: reserved.reservationToken,
        markdown: "new",
      }),
    ).rejects.toMatchObject({ code: "page_deleted" });
    expect((await s.readPage(page.id)).markdown).toBe("old");
    expect(s.getTree().find((node) => node.id === p1.id)?.children[0]?.id).toBe(
      page.id,
    );
  });

  it("enforces parent-first and next-sibling-first finalization for exact order", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A", { markdown: "a" });
    const b = await s.createPage(null, "B", { markdown: "b" });
    const c = await s.createPage(null, "C", { markdown: "c" });
    await adoptExisting(s, a.id, NOTION_PAGE);
    await adoptExisting(s, b.id, NOTION_PAGE_B);
    await adoptExisting(s, c.id, NOTION_PAGE_C);

    const reservations = new Map<string, string>();
    const desiredBefore = new Map<string, string | null>();
    for (const input of [
      { notionId: NOTION_PAGE, title: "A", beforeId: null },
      { notionId: NOTION_PAGE_B, title: "B", beforeId: a.id },
      { notionId: NOTION_PAGE_C, title: "C", beforeId: b.id },
    ]) {
      const result = await reserveNotionImport(s, {
        ...input,
        sourceHash: SOURCE_B,
        parentId: null,
      });
      if (result.status !== "reserved") throw new Error("expected reservation");
      reservations.set(input.notionId, result.reservationToken);
      desiredBefore.set(input.notionId, input.beforeId);
    }

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE_C,
        sourceHash: SOURCE_B,
        conversionHash: conversionHash(SOURCE_B, "C", "c"),
        reservationToken: reservations.get(NOTION_PAGE_C)!,
        markdown: "c",
      }),
    ).rejects.toMatchObject({ code: "sibling_import_pending" });

    for (const input of [
      { notionId: NOTION_PAGE, title: "A", markdown: "a" },
      { notionId: NOTION_PAGE_B, title: "B", markdown: "b" },
      { notionId: NOTION_PAGE_C, title: "C", markdown: "c" },
    ]) {
      await s.finalizeNotionImport({
        ...input,
        sourceHash: SOURCE_B,
        conversionHash: conversionHash(
          SOURCE_B,
          input.title,
          input.markdown,
          undefined,
          undefined,
          null,
          desiredBefore.get(input.notionId) ?? null,
        ),
        reservationToken: reservations.get(input.notionId)!,
      });
    }
    expect(s.getTree().map((node) => node.title)).toEqual(["C", "B", "A"]);

    const parentReservation = await reserveNotionImport(s, {
      notionId: "3".repeat(32),
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Parent",
    });
    if (parentReservation.status !== "reserved")
      throw new Error("expected parent reservation");
    const childReservation = await reserveNotionImport(s, {
      notionId: "4".repeat(32),
      sourceHash: SOURCE_A,
      parentId: parentReservation.page.id,
      title: "Child",
    });
    if (childReservation.status !== "reserved")
      throw new Error("expected child reservation");
    await expect(
      s.finalizeNotionImport({
        notionId: "4".repeat(32),
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          "Child",
          "child",
          undefined,
          undefined,
          parentReservation.page.id,
          null,
        ),
        reservationToken: childReservation.reservationToken,
        markdown: "child",
      }),
    ).rejects.toMatchObject({ code: "parent_import_pending" });
    await s.finalizeNotionImport({
      notionId: "3".repeat(32),
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Parent", "parent"),
      reservationToken: parentReservation.reservationToken,
      markdown: "parent",
    });
    await s.finalizeNotionImport({
      notionId: "4".repeat(32),
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "Child",
        "child",
        undefined,
        undefined,
        parentReservation.page.id,
        null,
      ),
      reservationToken: childReservation.reservationToken,
      markdown: "child",
    });
    expect(
      s.getTree().find((node) => node.id === parentReservation.page.id)
        ?.children[0]?.id,
    ).toBe(childReservation.page.id);
  });

  it("does not let abort roll back a manual hierarchy move", async () => {
    const { s } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const p3 = await s.createPage(null, "P3");
    const page = await s.createPage(p1.id, "Child", { markdown: "body" });
    await adoptExisting(s, page.id, NOTION_PAGE);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: p2.id,
      title: "Child",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.movePage(page.id, p3.id);

    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        reservationToken: reserved.reservationToken,
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(s.getTree().find((node) => node.id === p3.id)?.children[0]?.id).toBe(
      page.id,
    );
  });

  it("preserves a pristine placeholder and detaches its Notion binding", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Placeholder",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: new TextEncoder().encode("staged"),
        originalName: "staged.txt",
        mimeType: "text/plain",
      },
    );

    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      }),
    ).resolves.toMatchObject({
      status: "detached",
      pageId: reserved.page.id,
      cleanup: {
        stagingRemoved: true,
        notionBindingRemoved: true,
        placeholderPreserved: true,
      },
    });
    expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: reserved.page.id,
      pendingAbort: {
        sourceHash: SOURCE_A,
        status: "detached",
        cleanup: { stagingRemoved: true, notionBindingRemoved: true },
      },
    });
    expect(s.getTree().map((node) => node.id)).toContain(reserved.page.id);
    const preservedPage = await s.readPage(reserved.page.id);
    expect(preservedPage.meta.id).toBe(reserved.page.id);
    expect(preservedPage.meta.notionId).toBeUndefined();
    expect(
      (await fs.readdir(s.resolve(reserved.page.id))).some((name) =>
        name.startsWith(".brain-abort-recovery-"),
      ),
    ).toBe(true);
  });

  it("replays a detached abort across restart and reuses it only after durable acknowledgement", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Placeholder",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const first = await s.abortNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      reservationToken: reserved.reservationToken,
    });
    const reloaded = new Store(root);
    await reloaded.init();
    const owned = await reloaded.inspectNotionPage(
      NOTION_PAGE,
      reserved.reservationToken,
    );
    expect(owned).toMatchObject({
      id: reserved.page.id,
      pendingAbort: { status: "detached", sourceHash: SOURCE_A },
      integrity: { reservationOwned: true, abortBaselineIntact: true },
    });
    expect(JSON.stringify(owned)).not.toContain(reserved.reservationToken);
    expect(JSON.stringify(owned)).not.toContain(
      createHash("sha256").update(reserved.reservationToken).digest("hex"),
    );
    await expect(
      reloaded.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        reservationToken: reserved.reservationToken,
      }),
    ).rejects.toMatchObject({ code: "reservation_mismatch" });
    await expect(
      reloaded.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: "wrong_receipt_token_0001",
      }),
    ).rejects.toMatchObject({ code: "reservation_mismatch" });
    await expect(
      reloaded.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      }),
    ).resolves.toEqual(first);

    const beforeMissingAck = await fs.readFile(
      path.join(reloaded.resolve(reserved.page.id), "index.md"),
      "utf8",
    );
    await expect(
      reserveNotionImport(reloaded, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Imported",
      }),
    ).rejects.toMatchObject({ code: "abort_ack_required" });
    expect(
      await fs.readFile(
        path.join(reloaded.resolve(reserved.page.id), "index.md"),
        "utf8",
      ),
    ).toBe(beforeMissingAck);

    const resumed = await reserveNotionImport(reloaded, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Imported",
      acknowledgedAbort: {
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      },
    });
    expect(resumed).toMatchObject({
      status: "reserved",
      page: { id: reserved.page.id },
    });
    if (resumed.status !== "reserved") throw new Error("expected resumed reservation");
    await expect(
      reloaded.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Imported", "body"),
        reservationToken: resumed.reservationToken,
        title: "Imported",
        icon: "",
        cover: "",
        markdown: "body",
      }),
    ).resolves.toMatchObject({ status: "finalized" });
    expect(await reloaded.readPage(reserved.page.id)).toMatchObject({
      meta: { title: "Imported" },
      markdown: "body",
    });
  });

  it.each(["title", "body", "hierarchy"] as const)(
    "rejects acknowledged detached reuse after a manual %s change without another write",
    async (change) => {
      const { s } = await tmpStore();
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Placeholder",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      await s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      });
      if (change === "title") {
        await s.updateMeta(reserved.page.id, { title: "Manual title", by: "me" });
      } else if (change === "body") {
        await s.writePage(reserved.page.id, "manual body", undefined, "me");
      } else {
        const parent = await s.createPage(null, "Manual parent");
        await s.movePage(reserved.page.id, parent.id, null, "manual");
      }
      const indexPath = path.join(s.resolve(reserved.page.id), "index.md");
      const before = await fs.readFile(indexPath, "utf8");
      const treeBefore = JSON.stringify(s.getTree());
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Imported",
          acknowledgedAbort: {
            sourceHash: SOURCE_A,
            reservationToken: reserved.reservationToken,
          },
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
      expect(await fs.readFile(indexPath, "utf8")).toBe(before);
      expect(JSON.stringify(s.getTree())).toBe(treeBefore);
    },
  );

  it.each(["title", "icon", "cover", "body", "hierarchy"] as const)(
    "preserves a pre-abort manual %s change but refuses to bless it on acknowledgement",
    async (change) => {
      const { s, root } = await tmpStore();
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Placeholder",
        icon: "📄",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      if (change === "title") {
        await s.updateMeta(reserved.page.id, { title: "Manual title", by: "me" });
      } else if (change === "icon") {
        await s.updateMeta(reserved.page.id, { icon: "🧑", by: "me" });
      } else if (change === "cover") {
        await s.updateMeta(reserved.page.id, {
          cover: `/_attachments-v2/${"c".repeat(64)}.jpg`,
          by: "me",
        });
      } else if (change === "body") {
        const current = await s.readPage(reserved.page.id);
        await s.writePage(reserved.page.id, "manual body", current.rev, "me");
      } else {
        const parent = await s.createPage(null, "Manual parent");
        await s.movePage(reserved.page.id, parent.id, null, "manual");
      }

      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          reservationToken: reserved.reservationToken,
        }),
      ).resolves.toMatchObject({ status: "detached" });
      const reloaded = new Store(root);
      await reloaded.init();
      const indexPath = path.join(
        reloaded.resolve(reserved.page.id),
        "index.md",
      );
      const afterAbort = await fs.readFile(indexPath, "utf8");
      const treeAfterAbort = JSON.stringify(reloaded.getTree());
      await expect(
        reserveNotionImport(reloaded, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Imported",
          acknowledgedAbort: {
            sourceHash: SOURCE_A,
            reservationToken: reserved.reservationToken,
          },
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
      expect(await fs.readFile(indexPath, "utf8")).toBe(afterAbort);
      expect(JSON.stringify(reloaded.getTree())).toBe(treeAfterAbort);
    },
  );

  it("replays an adopted abort and durably advances staging cleanup false to true", async () => {
    const { s, root } = await tmpStore();
    const existing = await s.createPage(null, "Existing", { markdown: "body" });
    await adoptExisting(s, existing.id, NOTION_PAGE);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: null,
      title: "Existing",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_B,
      reserved.reservationToken,
      {
        data: new TextEncoder().encode("staged receipt bytes"),
        originalName: "receipt.txt",
        mimeType: "text/plain",
      },
    );
    const realRm = fs.rm.bind(fs);
    let blocked = true;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (
        blocked &&
        path.basename(String(args[0])) === reserved.reservationToken
      ) {
        throw new Error("synthetic abort cleanup failure");
      }
      return realRm(...args);
    });
    try {
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          reservationToken: reserved.reservationToken,
        }),
      ).resolves.toMatchObject({
        status: "aborted",
        cleanup: { stagingRemoved: false, notionBindingRemoved: false },
      });
      blocked = false;
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          reservationToken: reserved.reservationToken,
        }),
      ).resolves.toMatchObject({
        status: "aborted",
        cleanup: { stagingRemoved: true, notionBindingRemoved: false },
      });
    } finally {
      rm.mockRestore();
    }
    const reloaded = new Store(root);
    await reloaded.init();
    expect(reloaded.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: existing.id,
      pendingAbort: {
        status: "aborted",
        cleanup: { stagingRemoved: true, notionBindingRemoved: false },
      },
    });
  });

  it("blocks adoption and purge while an abort receipt is unacknowledged", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Receipt",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.abortNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      reservationToken: reserved.reservationToken,
    });
    const page = await s.readPage(reserved.page.id);
    const placement = findPlacement(s.getTree(), reserved.page.id);
    if (!placement) throw new Error("receipt page is missing");
    await expect(
      s.adoptNotionImport({
        pageId: reserved.page.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          page.meta.title,
          page.markdown,
          page.meta.icon,
          page.meta.cover,
          placement.parentId,
          placement.beforeId,
        ),
        expectedRev: page.rev,
        expectedParentId: placement.parentId,
        expectedBeforeId: placement.beforeId,
      }),
    ).rejects.toMatchObject({ code: "abort_ack_required" });
    const directory = s.resolve(reserved.page.id);
    await s.deletePage(reserved.page.id);
    await expect(s.purgePage(reserved.page.id)).rejects.toMatchObject({
      code: "abort_ack_required",
    });
    await expect(fs.stat(directory)).resolves.toBeDefined();
  });

  it("blocks a receipt notion id from adoption or direct creation on another page", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Receipt",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.abortNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      reservationToken: reserved.reservationToken,
    });
    const other = await s.createPage(null, "Other", { markdown: "keep" });
    const receiptRaw = await fs.readFile(
      path.join(s.resolve(reserved.page.id), "index.md"),
      "utf8",
    );
    const otherRaw = await fs.readFile(
      path.join(s.resolve(other.id), "index.md"),
      "utf8",
    );

    await expect(
      adoptExisting(s, other.id, NOTION_PAGE),
    ).rejects.toMatchObject({ code: "abort_ack_required" });
    await expect(
      s.createPage(null, "Conflicting", { notionId: NOTION_PAGE }),
    ).rejects.toMatchObject({ code: "abort_ack_required" });
    expect(
      await fs.readFile(
        path.join(s.resolve(reserved.page.id), "index.md"),
        "utf8",
      ),
    ).toBe(receiptRaw);
    expect(
      await fs.readFile(path.join(s.resolve(other.id), "index.md"), "utf8"),
    ).toBe(otherRaw);

    const reloaded = new Store(root);
    await expect(reloaded.init()).resolves.toBeUndefined();
    expect(reloaded.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: reserved.page.id,
      pendingAbort: { status: "detached" },
    });
  });

  it("preflights a mixed receipt subtree before removing any active staging", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Trash root");
    const receipt = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: parent.id,
      title: "Receipt child",
    });
    const active = await reserveNotionImport(s, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: parent.id,
      title: "Active child",
    });
    if (receipt.status !== "reserved" || active.status !== "reserved") {
      throw new Error("expected reservations");
    }
    await s.abortNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      reservationToken: receipt.reservationToken,
    });
    await s.deletePage(parent.id);
    const activeStage = path.join(
      notionStagingRoot(root),
      active.reservationToken,
    );
    await fs.mkdir(activeStage, { mode: 0o700 });
    const sentinel = path.join(activeStage, "sentinel.bin");
    await fs.writeFile(sentinel, "keep");
    const parentDirectory = s.resolve(parent.id);

    await expect(s.purgePage(parent.id)).rejects.toMatchObject({
      code: "abort_ack_required",
    });
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep");
    await expect(fs.stat(parentDirectory)).resolves.toBeDefined();
  });

  it("preflights every trash root before purging an earlier active subtree", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-07-12T00:00:00.000Z"));
      const { s, root } = await tmpStore();
      const activeRoot = await s.createPage(null, "Active root");
      const receiptRoot = await s.createPage(null, "Receipt root");
      const active = await reserveNotionImport(s, {
        notionId: NOTION_PAGE_B,
        sourceHash: SOURCE_A,
        parentId: activeRoot.id,
        title: "Active child",
      });
      const receipt = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: receiptRoot.id,
        title: "Receipt child",
      });
      if (active.status !== "reserved" || receipt.status !== "reserved") {
        throw new Error("expected reservations");
      }
      await s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: receipt.reservationToken,
      });
      await s.deletePage(receiptRoot.id);
      vi.setSystemTime(new Date("2026-07-12T00:00:01.000Z"));
      await s.deletePage(activeRoot.id);
      const activeStage = path.join(
        notionStagingRoot(root),
        active.reservationToken,
      );
      await fs.mkdir(activeStage, { recursive: true, mode: 0o700 });
      const sentinel = path.join(activeStage, "sentinel.bin");
      await fs.writeFile(sentinel, "keep");
      const activeDirectory = s.resolve(activeRoot.id);
      const receiptDirectory = s.resolve(receiptRoot.id);

      expect(s.trashList().map((item) => item.id).slice(0, 2)).toEqual([
        activeRoot.id,
        receiptRoot.id,
      ]);
      await expect(s.emptyTrash()).rejects.toMatchObject({
        code: "abort_ack_required",
      });
      await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("keep");
      await expect(fs.stat(activeDirectory)).resolves.toBeDefined();
      await expect(fs.stat(receiptDirectory)).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears only the importer-owned cover when detaching a fresh placeholder", async () => {
    const { s } = await tmpStore();
    const importedCover = `/_attachments-v2/${"a".repeat(64)}.png`;
    const manualCover = `/_attachments-v2/${"b".repeat(64)}.jpg`;
    const untouched = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Untouched",
      cover: importedCover,
    });
    const edited = await reserveNotionImport(s, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Edited",
      cover: importedCover,
    });
    if (untouched.status !== "reserved" || edited.status !== "reserved") {
      throw new Error("expected reservations");
    }
    await s.updateMeta(edited.page.id, { cover: manualCover, by: "me" });

    const untouchedAbort = await s.abortNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      reservationToken: untouched.reservationToken,
    });
    const editedAbort = await s.abortNotionImport({
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      reservationToken: edited.reservationToken,
    });

    expect(untouchedAbort).toMatchObject({
      status: "detached",
      cleanup: { placeholderPreserved: true },
    });
    expect(editedAbort).toMatchObject({
      status: "detached",
      cleanup: { placeholderPreserved: true },
    });
    expect((await s.readPage(untouched.page.id)).meta.cover).toBeUndefined();
    expect((await s.readPage(edited.page.id)).meta.cover).toBe(manualCover);
  });

  it("preserves edited and child-bearing placeholders without masking cleanup", async () => {
    const { s } = await tmpStore();
    const edited = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Edited",
    });
    const parent = await reserveNotionImport(s, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Parent",
    });
    if (edited.status !== "reserved" || parent.status !== "reserved") {
      throw new Error("expected reservations");
    }
    const editedPage = await s.readPage(edited.page.id);
    await s.writePage(edited.page.id, "manual note", editedPage.rev, "me");
    const child = await s.createPage(parent.page.id, "Manual child", {
      markdown: "keep me",
    });

    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: edited.reservationToken,
      }),
    ).resolves.toMatchObject({
      status: "detached",
      cleanup: { placeholderPreserved: true },
    });
    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE_B,
        sourceHash: SOURCE_A,
        reservationToken: parent.reservationToken,
      }),
    ).resolves.toMatchObject({
      status: "detached",
      cleanup: { placeholderPreserved: true },
    });
    expect((await s.readPage(edited.page.id)).markdown).toBe("manual note");
    expect((await s.readPage(child.id)).markdown).toBe("keep me");
  });

  it.each([1, 2])(
    "blocks parent detach until a depth-%i Notion descendant is aborted leaf-first",
    async (depth) => {
      const { s, root } = await tmpStore();
      const parent = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Reserved parent",
      });
      if (parent.status !== "reserved") throw new Error("expected parent reservation");
      const child = await reserveNotionImport(s, {
        notionId: NOTION_PAGE_B,
        sourceHash: SOURCE_A,
        parentId: parent.page.id,
        title: "Reserved child",
      });
      if (child.status !== "reserved") throw new Error("expected child reservation");
      const grandchild =
        depth === 2
          ? await reserveNotionImport(s, {
              notionId: NOTION_PAGE_C,
              sourceHash: SOURCE_A,
              parentId: child.page.id,
              title: "Reserved grandchild",
            })
          : undefined;
      if (grandchild && grandchild.status !== "reserved") {
        throw new Error("expected grandchild reservation");
      }
      const parentIndex = path.join(s.resolve(parent.page.id), "index.md");
      const parentBefore = await fs.readFile(parentIndex, "utf8");

      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          reservationToken: parent.reservationToken,
        }),
      ).rejects.toMatchObject({ code: "has_import_children" });
      expect(await fs.readFile(parentIndex, "utf8")).toBe(parentBefore);
      expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: parent.page.id,
        importing: { sourceHash: SOURCE_A },
      });
      expect((await s.readPage(parent.page.id)).meta.notionImportToken).toBe(
        parent.reservationToken,
      );

      if (grandchild?.status === "reserved") {
        await s.abortNotionImport({
          notionId: NOTION_PAGE_C,
          sourceHash: SOURCE_A,
          reservationToken: grandchild.reservationToken,
        });
      }
      await s.abortNotionImport({
        notionId: NOTION_PAGE_B,
        sourceHash: SOURCE_A,
        reservationToken: child.reservationToken,
      });
      await s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: parent.reservationToken,
      });
      expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: parent.page.id,
        pendingAbort: { sourceHash: SOURCE_A, status: "detached" },
      });

      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Reserved parent retry",
        }),
      ).rejects.toMatchObject({ code: "abort_ack_required" });
      const retried = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Reserved parent retry",
        acknowledgedAbort: {
          sourceHash: SOURCE_A,
          reservationToken: parent.reservationToken,
        },
      });
      expect(retried).toMatchObject({ status: "reserved" });
      expect(retried.page.id).toBe(parent.page.id);
      const reloaded = new Store(root);
      await reloaded.init();
      expect(reloaded.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: retried.page.id,
      });
    },
  );

  it.each(["manual file", "symlink", "hidden directory"])(
    "never recursively deletes a pristine placeholder containing %s",
    async (kind) => {
      const { s, root } = await tmpStore();
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Preserve inventory",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      const dir = s.resolve(reserved.page.id);
      let unknownPath: string;
      if (kind === "manual file") {
        unknownPath = path.join(dir, "manual.txt");
        await fs.writeFile(unknownPath, "keep");
      } else if (kind === "symlink") {
        const target = path.join(root, "manual-target.txt");
        await fs.writeFile(target, "keep");
        unknownPath = path.join(dir, "manual-link");
        await fs.symlink(target, unknownPath);
      } else {
        unknownPath = path.join(dir, ".manual");
        await fs.mkdir(unknownPath);
        await fs.writeFile(path.join(unknownPath, "keep.txt"), "keep");
      }

      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          reservationToken: reserved.reservationToken,
        }),
      ).resolves.toMatchObject({
        status: "detached",
        cleanup: { placeholderPreserved: true },
      });
      await expect(fs.lstat(unknownPath)).resolves.toBeDefined();
      expect((await s.readPage(reserved.page.id)).meta.notionId).toBeUndefined();
    },
  );

  it("captures an external index replacement before abort and preserves its body", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Raced placeholder",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const dir = s.resolve(reserved.page.id);
    const indexPath = path.join(dir, "index.md");
    const externalRaw =
      (await fs.readFile(indexPath, "utf8")) + "manual external edit\n";
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (
        !injected &&
        String(args[0]) === indexPath &&
        path.basename(String(args[1])) === "captured.md" &&
        path.basename(path.dirname(String(args[1]))).startsWith(
          ".brain-abort-txn-",
        )
      ) {
        injected = true;
        await fs.writeFile(indexPath, externalRaw);
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          reservationToken: reserved.reservationToken,
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
    } finally {
      rename.mockRestore();
    }
    expect(injected).toBe(true);
    expect((await s.readPage(reserved.page.id)).markdown).toContain(
      "manual external edit",
    );
    const recovery = (await fs.readdir(dir)).find((name) =>
      name.startsWith(".brain-abort-recovery-"),
    );
    expect(recovery).toBeDefined();
    expect(await fs.readFile(path.join(dir, recovery!), "utf8")).toContain(
      "notionImportToken",
    );
    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      }),
    ).resolves.toMatchObject({ status: "detached" });
  });

  it("never overwrites a raced canonical save and can retry from it", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "No-overwrite abort",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const dir = s.resolve(reserved.page.id);
    const indexPath = path.join(dir, "index.md");
    const externalRaw =
      (await fs.readFile(indexPath, "utf8")) + "manual retry edit\n";
    const realLink = fs.link.bind(fs);
    let injected = false;
    const link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
      if (
        !injected &&
        path.basename(String(args[0])).startsWith(".brain-abort-next-") &&
        String(args[1]) === indexPath
      ) {
        injected = true;
        await fs.writeFile(indexPath, externalRaw, { flag: "wx" });
      }
      return realLink(...args);
    });
    try {
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          reservationToken: reserved.reservationToken,
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
    } finally {
      link.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await fs.readFile(indexPath, "utf8")).toBe(externalRaw);

    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      }),
    ).resolves.toMatchObject({
      status: "detached",
      cleanup: { placeholderPreserved: true },
    });
    expect((await s.readPage(reserved.page.id)).markdown).toContain(
      "manual retry edit",
    );
  });

  it.each(["created", "adopted"] as const)(
    "keeps an external atomic save immediately after successful abort publish for %s pages",
    async (kind) => {
      const { s } = await tmpStore();
      let pageId: string;
      let sourceHash: string;
      let reservationToken: string;
      if (kind === "created") {
        const reserved = await reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Created race",
        });
        if (reserved.status !== "reserved") throw new Error("expected reservation");
        pageId = reserved.page.id;
        sourceHash = SOURCE_A;
        reservationToken = reserved.reservationToken;
      } else {
        const page = await s.createPage(null, "Adopted race", {
          markdown: "adopted body",
        });
        await adoptExisting(s, page.id, NOTION_PAGE, SOURCE_A);
        const reserved = await reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          parentId: null,
          title: "Adopted race",
        });
        if (reserved.status !== "reserved") throw new Error("expected reservation");
        pageId = page.id;
        sourceHash = SOURCE_B;
        reservationToken = reserved.reservationToken;
      }
      const indexPath = path.join(s.resolve(pageId), "index.md");
      const externalRaw =
        (await fs.readFile(indexPath, "utf8")) + "manual post-link save\n";
      const realLink = fs.link.bind(fs);
      let injected = false;
      const link = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        const result = await realLink(...args);
        if (
          !injected &&
          path.basename(String(args[0])).startsWith(".brain-abort-next-") &&
          String(args[1]) === indexPath
        ) {
          injected = true;
          const externalTemp = path.join(
            path.dirname(indexPath),
            ".synthetic-external-save",
          );
          await fs.writeFile(externalTemp, externalRaw, { flag: "wx" });
          await fs.rename(externalTemp, indexPath);
        }
        return result;
      });
      try {
        await expect(
          s.abortNotionImport({
            notionId: NOTION_PAGE,
            sourceHash,
            reservationToken,
          }),
        ).rejects.toMatchObject({ code: "source_changed" });
      } finally {
        link.mockRestore();
      }
      expect(injected).toBe(true);
      expect(await fs.readFile(indexPath, "utf8")).toBe(externalRaw);
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash,
          reservationToken,
        }),
      ).resolves.toMatchObject({
        status: kind === "created" ? "detached" : "aborted",
      });
      expect((await s.readPage(pageId)).markdown).toContain(
        "manual post-link save",
      );
    },
  );

  it.each(["before-detach", "after-detach", "after-publish"] as const)(
    "recovers the durable abort crash point %s and remains idempotent",
    async (crashPoint) => {
      const fixture = await prepareAbortCrashFixture();
      const seeded = await seedAbortCrashState(fixture, {
        canonical:
          crashPoint === "after-detach"
            ? null
            : crashPoint === "after-publish"
              ? fixture.nextRaw
              : fixture.beforeRaw,
        captured:
          crashPoint === "before-detach" ? undefined : fixture.beforeRaw,
      });
      const recovered = new Store(fixture.root);
      await recovered.init();
      await expectAbortCrashHelpersClean(fixture, seeded);
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(
        crashPoint === "after-publish" ? fixture.nextRaw : fixture.beforeRaw,
      );
      if (crashPoint === "after-publish") {
        expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
          pendingAbort: { status: "detached", sourceHash: SOURCE_A },
        });
      } else {
        expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
          id: fixture.pageId,
          importing: { sourceHash: SOURCE_A },
        });
      }

      const reloaded = new Store(fixture.root);
      await reloaded.init();
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(
        crashPoint === "after-publish" ? fixture.nextRaw : fixture.beforeRaw,
      );
      if (crashPoint !== "after-publish") {
        await expect(
          reloaded.abortNotionImport({
            notionId: NOTION_PAGE,
            sourceHash: SOURCE_A,
            reservationToken: fixture.reservationToken,
          }),
        ).resolves.toMatchObject({ status: "detached" });
      }
    },
  );

  it.each(["created", "adopted"] as const)(
    "keeps an external atomic save after reconciler intent cleanup for %s pages",
    async (kind) => {
      const fixture =
        kind === "created"
          ? await prepareAbortCrashFixture()
          : await prepareAdoptedAbortCrashFixture();
      const seeded = await seedAbortCrashState(fixture, {
        canonical: fixture.nextRaw,
        captured: fixture.beforeRaw,
      });
      const externalRaw = fixture.nextRaw + "manual post-intent save\n";
      const realUnlink = fs.unlink.bind(fs);
      let injected = false;
      const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (...args) => {
        const result = await realUnlink(...args);
        if (!injected && String(args[0]) === seeded.intentPath) {
          injected = true;
          const externalTemp = path.join(
            fixture.dir,
            ".synthetic-post-intent-save",
          );
          await fs.writeFile(externalTemp, externalRaw, { flag: "wx" });
          await fs.rename(externalTemp, seeded.indexPath);
        }
        return result;
      });
      const recovered = new Store(fixture.root);
      try {
        await recovered.init();
      } finally {
        unlink.mockRestore();
      }
      expect(injected).toBe(true);
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(externalRaw);
      expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: fixture.pageId,
        pendingAbort: {
          status: kind === "created" ? "detached" : "aborted",
        },
      });
      await expect(
        recovered.inspectNotionPage(
          NOTION_PAGE,
          fixture.reservationToken,
        ),
      ).resolves.toMatchObject({
        integrity: {
          abortBaselineIntact: false,
          reservationOwned: true,
        },
      });

      const reloaded = new Store(fixture.root);
      await expect(reloaded.init()).resolves.toBeUndefined();
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(externalRaw);
    },
  );

  it.each(["intent-only", "intent-and-empty-transaction"] as const)(
    "recovers the earliest abort crash point %s",
    async (crashPoint) => {
      const fixture = await prepareAbortCrashFixture();
      const seeded = await seedAbortCrashState(fixture, {
        canonical: fixture.beforeRaw,
        before: null,
        next: null,
        transaction:
          crashPoint === "intent-only" ? "missing" : "directory",
      });
      const recovered = new Store(fixture.root);
      await recovered.init();
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(
        fixture.beforeRaw,
      );
      expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: fixture.pageId,
        importing: { sourceHash: SOURCE_A },
      });
      await expect(fs.lstat(seeded.intentPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(seeded.transactionPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(seeded.beforePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(seeded.nextPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const reloaded = new Store(fixture.root);
      await reloaded.init();
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(
        fixture.beforeRaw,
      );
    },
  );

  it("restores an after-detach placeholder with its manual child intact", async () => {
    let childId = "";
    const fixture = await prepareAbortCrashFixture(async (store, parentId) => {
      const child = await store.createPage(parentId, "Manual child", {
        markdown: "manual child body",
      });
      childId = child.id;
    });
    const seeded = await seedAbortCrashState(fixture, {
      canonical: null,
      captured: fixture.beforeRaw,
    });
    const recovered = new Store(fixture.root);
    await recovered.init();
    expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(fixture.beforeRaw);
    expect((await recovered.readPage(childId)).markdown).toBe(
      "manual child body",
    );
    expect(
      recovered
        .getTree()
        .find((node) => node.id === fixture.pageId)
        ?.children.map((node) => node.id),
    ).toContain(childId);
    await expectAbortCrashHelpersClean(fixture, seeded);
  });

  it("recovers an adopted page abort with binding, body, and tracked hierarchy intact", async () => {
    const { s, root } = await tmpStore();
    const trackedParent = await s.createPage(null, "Tracked parent");
    const desiredParent = await s.createPage(null, "Desired parent");
    const page = await s.createPage(trackedParent.id, "Adopted", {
      markdown: "adopted manual body",
    });
    await adoptExisting(s, page.id, NOTION_PAGE, SOURCE_A);
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      parentId: desiredParent.id,
      title: "Adopted",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.movePage(page.id, desiredParent.id);

    let beforeRaw: string | undefined;
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (
        path.basename(String(args[0])) === "index.md" &&
        path.basename(String(args[1])) === "captured.md" &&
        path.basename(path.dirname(String(args[1]))).startsWith(
          ".brain-abort-txn-",
        )
      ) {
        beforeRaw = await fs.readFile(String(args[0]), "utf8");
      }
      return realRename(...args);
    });
    try {
      await s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        reservationToken: reserved.reservationToken,
      });
    } finally {
      rename.mockRestore();
    }
    if (!beforeRaw) throw new Error("failed to capture adopted abort bytes");
    const dir = s.resolve(page.id);
    const indexPath = path.join(dir, "index.md");
    const nextRaw = await fs.readFile(indexPath, "utf8");
    for (const name of await fs.readdir(dir)) {
      if (name.startsWith(".brain-abort-recovery-")) {
        await fs.unlink(path.join(dir, name));
      }
    }
    await beginGitSnapshotBarrier(root);
    const fixture: AbortCrashFixture = {
      root,
      dir,
      pageId: page.id,
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      reservationToken: reserved.reservationToken,
      beforeRaw,
      nextRaw,
    };
    const seeded = await seedAbortCrashState(fixture, {
      canonical: null,
      captured: beforeRaw,
    });

    const recovered = new Store(root);
    await recovered.init();
    expect((await recovered.readPage(page.id)).markdown).toBe(
      "adopted manual body",
    );
    expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: page.id,
      importing: { sourceHash: SOURCE_B },
    });
    expect(findPlacement(recovered.getTree(), page.id)?.parentId).toBe(
      trackedParent.id,
    );
    await expectAbortCrashHelpersClean(fixture, seeded);

    const reloaded = new Store(root);
    await reloaded.init();
    expect(findPlacement(reloaded.getTree(), page.id)?.parentId).toBe(
      trackedParent.id,
    );
    await expect(
      reloaded.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        reservationToken: reserved.reservationToken,
      }),
    ).resolves.toMatchObject({
      status: "aborted",
      cleanup: { notionBindingRemoved: false },
    });
    expect(reloaded.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: page.id,
      importing: undefined,
    });
    expect(findPlacement(reloaded.getTree(), page.id)?.parentId).toBe(
      trackedParent.id,
    );
  });

  it("restores the atomically captured external writer bytes and permits retry", async () => {
    const fixture = await prepareAbortCrashFixture();
    const externalRaw = fixture.beforeRaw + "manual captured edit\n";
    const seeded = await seedAbortCrashState(fixture, {
      canonical: null,
      captured: externalRaw,
    });
    const recovered = new Store(fixture.root);
    await recovered.init();
    expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(externalRaw);
    expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: fixture.pageId,
      importing: { sourceHash: SOURCE_A },
    });
    await expectAbortCrashHelpersClean(fixture, seeded);
    await expect(
      recovered.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: fixture.reservationToken,
      }),
    ).resolves.toMatchObject({ status: "detached" });
    expect((await recovered.readPage(fixture.pageId)).markdown).toContain(
      "manual captured edit",
    );
  });

  it.each(["absent", "before", "same-external"] as const)(
    "keeps an external canonical when captured is %s",
    async (capturedState) => {
      const fixture = await prepareAbortCrashFixture();
      const externalRaw = fixture.nextRaw + `manual ${capturedState} edit\n`;
      const seeded = await seedAbortCrashState(fixture, {
        canonical: externalRaw,
        captured:
          capturedState === "before"
            ? fixture.beforeRaw
            : capturedState === "same-external"
              ? externalRaw
              : undefined,
      });
      const recovered = new Store(fixture.root);
      await recovered.init();
      expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(externalRaw);
      expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
        pendingAbort: { status: "detached", sourceHash: SOURCE_A },
      });
      await expectAbortCrashHelpersClean(fixture, seeded);
    },
  );

  it("fails closed with two distinct external candidates and preserves both", async () => {
    const fixture = await prepareAbortCrashFixture();
    const canonicalExternal = fixture.nextRaw + "canonical external\n";
    const capturedExternal = fixture.beforeRaw + "captured external\n";
    const seeded = await seedAbortCrashState(fixture, {
      canonical: canonicalExternal,
      captured: capturedExternal,
    });
    await expect(new Store(fixture.root).init()).rejects.toThrow(
      /two distinct external canonical candidates/,
    );
    await expect(fs.readFile(seeded.indexPath, "utf8")).resolves.toBe(
      canonicalExternal,
    );
    await expect(fs.readFile(seeded.capturedPath, "utf8")).resolves.toBe(
      capturedExternal,
    );
    await expect(fs.readFile(seeded.intentPath, "utf8")).resolves.toBe(
      seeded.intentRaw,
    );
  });

  it.each([
    "corrupt-before",
    "corrupt-next",
    "traversal",
    "symlink-transaction",
    "symlink-intent",
    "symlink-canonical",
    "symlink-before",
    "symlink-next",
    "symlink-captured",
    "multiple-intents",
  ] as const)("fails closed on invalid abort state: %s", async (kind) => {
    const fixture = await prepareAbortCrashFixture();
    const seeded = await seedAbortCrashState(fixture, {
      canonical: fixture.beforeRaw,
      captured: kind === "symlink-captured" ? fixture.beforeRaw : undefined,
      before:
        kind === "corrupt-before"
          ? fixture.beforeRaw + "corrupt\n"
          : undefined,
      next:
        kind === "corrupt-next" ? fixture.nextRaw + "corrupt\n" : undefined,
      transaction:
        kind === "symlink-transaction" ? "symlink" : "directory",
      intentPatch: kind === "traversal" ? { pageDirectory: "../escape" } : undefined,
      extraIntent: kind === "multiple-intents",
    });
    const symlinkTargets = {
      "symlink-intent": [seeded.intentPath, seeded.intentRaw],
      "symlink-canonical": [seeded.indexPath, fixture.beforeRaw],
      "symlink-before": [seeded.beforePath, fixture.beforeRaw],
      "symlink-next": [seeded.nextPath, fixture.nextRaw],
      "symlink-captured": [seeded.capturedPath, fixture.beforeRaw],
    } as const;
    if (kind in symlinkTargets) {
      const [linkPath, content] = symlinkTargets[
        kind as keyof typeof symlinkTargets
      ];
      const target = path.join(
        fixture.root,
        `synthetic-${kind.replace("symlink-", "")}-target`,
      );
      await fs.writeFile(target, content);
      await fs.rm(linkPath);
      await fs.symlink(target, linkPath);
    }
    await expect(new Store(fixture.root).init()).rejects.toThrow();
    await expect(fs.readFile(seeded.indexPath, "utf8")).resolves.toBe(
      fixture.beforeRaw,
    );
    await expect(fs.readFile(seeded.intentPath, "utf8")).resolves.toBe(
      seeded.intentRaw,
    );
    if (kind.startsWith("symlink-") && kind !== "symlink-transaction") {
      const linkPath = symlinkTargets[
        kind as keyof typeof symlinkTargets
      ][0];
      expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    }
  });

  it("rejects an oversized sparse abort intent before allocating its body", async () => {
    const fixture = await prepareAbortCrashFixture();
    const seeded = await seedAbortCrashState(fixture, {
      canonical: fixture.beforeRaw,
    });
    await fs.truncate(seeded.intentPath, 64 * 1024 + 1);
    await expect(new Store(fixture.root).init()).rejects.toThrow(
      /intent exceeds the maximum size/,
    );
    expect((await fs.stat(seeded.intentPath)).size).toBe(64 * 1024 + 1);
    expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(
      fixture.beforeRaw,
    );
  });

  it("keeps the external intent durable when canonical file fsync fails", async () => {
    const fixture = await prepareAbortCrashFixture();
    const externalRaw = fixture.nextRaw + "external fsync edit\n";
    const seeded = await seedAbortCrashState(fixture, {
      canonical: externalRaw,
      captured: fixture.beforeRaw,
    });
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === seeded.indexPath) {
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          injected = true;
          throw new Error("synthetic external canonical fsync failure");
        });
      }
      return handle;
    });
    try {
      await expect(new Store(fixture.root).init()).rejects.toThrow(
        /synthetic external canonical fsync failure/,
      );
    } finally {
      open.mockRestore();
    }
    expect(injected).toBe(true);
    await expect(fs.readFile(seeded.intentPath, "utf8")).resolves.toBe(
      seeded.intentRaw,
    );
    await expect(fs.readFile(seeded.indexPath, "utf8")).resolves.toBe(
      externalRaw,
    );

    const recovered = new Store(fixture.root);
    await recovered.init();
    await expectAbortCrashHelpersClean(fixture, seeded);
    expect(await fs.readFile(seeded.indexPath, "utf8")).toBe(externalRaw);
  });

  it("rolls back to the durable recovery copy when captured-file fsync fails", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Captured fsync failure",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const dir = s.resolve(reserved.page.id);
    const indexPath = path.join(dir, "index.md");
    const beforeRaw = await fs.readFile(indexPath, "utf8");
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (
        !injected &&
        path.basename(String(args[0])) === "captured.md" &&
        path.basename(path.dirname(String(args[0]))).startsWith(
          ".brain-abort-txn-",
        )
      ) {
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          injected = true;
          throw new Error("synthetic captured file fsync failure");
        });
      }
      return handle;
    });
    try {
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          reservationToken: reserved.reservationToken,
        }),
      ).rejects.toMatchObject({ code: "source_changed" });
    } finally {
      open.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await fs.readFile(indexPath, "utf8")).toBe(beforeRaw);
    expect(s.findNotionPage(NOTION_PAGE)).toMatchObject({
      id: reserved.page.id,
      importing: { sourceHash: SOURCE_A },
    });
    expect(
      (await fs.readdir(dir)).some((name) =>
        name.startsWith(".brain-abort-intent-"),
      ),
    ).toBe(false);
    const recoveryName = (await fs.readdir(dir)).find((name) =>
      name.startsWith(".brain-abort-recovery-"),
    );
    expect(recoveryName).toBeDefined();
    const [canonicalStat, recoveryStat] = await Promise.all([
      fs.stat(indexPath),
      fs.stat(path.join(dir, recoveryName!)),
    ]);
    expect({ dev: canonicalStat.dev, ino: canonicalStat.ino }).toEqual({
      dev: recoveryStat.dev,
      ino: recoveryStat.ino,
    });
    await expect(
      s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      }),
    ).resolves.toMatchObject({ status: "detached" });
  });

  it("keeps Git snapshots behind the abort barrier until one stable commit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let releaseLink: (() => void) | undefined;
    let abortPromise: Promise<unknown> | undefined;
    let linkSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { s, root } = await tmpStore();
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Git abort barrier",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      await git(root, "init", "-q");
      const baselineHead = await commitAll(root, "baseline before abort");
      const dir = s.resolve(reserved.page.id);
      const indexPath = path.join(dir, "index.md");
      const baselineRaw = await fs.readFile(indexPath, "utf8");
      const relativeIndex = path.relative(root, indexPath);
      scheduleCommit(root);

      let reachedResolve!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedResolve = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        releaseLink = resolve;
      });
      const realLink = fs.link.bind(fs);
      linkSpy = vi.spyOn(fs, "link").mockImplementation(async (...args) => {
        if (
          path.basename(String(args[0])).startsWith(".brain-abort-next-") &&
          String(args[1]) === indexPath
        ) {
          reachedResolve();
          await gate;
        }
        return realLink(...args);
      });
      abortPromise = s.abortNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
      });
      await reached;
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(baselineHead);
      expect(await git(root, "show", `HEAD:${relativeIndex}`)).toBe(
        baselineRaw,
      );
      expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(
        /\.brain-abort-(?:intent|next|txn)/,
      );

      releaseLink!();
      releaseLink = undefined;
      await abortPromise;
      abortPromise = undefined;
      await vi.advanceTimersByTimeAsync(5_000);
      const stableHead = await waitForHeadChange(root, baselineHead);
      expect(Number((await git(root, "rev-list", "--count", `${baselineHead}..${stableHead}`)).trim())).toBe(1);
      const committed = await git(root, "show", `${stableHead}:${relativeIndex}`);
      expect(committed).not.toContain("notionImportToken");
      expect(await git(root, "ls-tree", "-r", "--name-only", stableHead)).not.toMatch(
        /\.brain-abort-(?:intent|next|txn)/,
      );
    } finally {
      releaseLink?.();
      await abortPromise?.catch(() => undefined);
      linkSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

  it("holds the barrier and poisons writes until an abort MOVE_INTENT is recovered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rmSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { s, root } = await tmpStore();
      const trackedParent = await s.createPage(null, "Tracked parent");
      const desiredParent = await s.createPage(null, "Desired parent");
      const page = await s.createPage(trackedParent.id, "Moved adopted page", {
        markdown: "manual adopted body",
      });
      await adoptExisting(s, page.id, NOTION_PAGE, SOURCE_A);
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        parentId: desiredParent.id,
        title: "Moved adopted page",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      await s.movePage(page.id, desiredParent.id);
      await git(root, "init", "-q");
      const baselineHead = await commitAll(root, "baseline before move recovery");
      scheduleCommit(root);

      const realRm = fs.rm.bind(fs);
      let injected = false;
      rmSpy = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (
          !injected &&
          String(args[0]) === path.join(root, ".brain-move-intent.json")
        ) {
          injected = true;
          throw new Error("synthetic clearMoveIntent failure");
        }
        return realRm(...args);
      });
      await expect(
        s.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          reservationToken: reserved.reservationToken,
        }),
      ).rejects.toThrow(/synthetic clearMoveIntent failure/);
      expect(injected).toBe(true);
      await expect(
        fs.readFile(path.join(root, ".brain-move-intent.json"), "utf8"),
      ).resolves.toContain(page.id);
      await expect(s.createPage(null, "Blocked after move intent")).rejects.toThrow(
        /mutations are blocked by an unresolved Notion abort intent/,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(baselineHead);

      rmSpy.mockRestore();
      rmSpy = undefined;
      const recovered = new Store(root);
      await recovered.init();
      await expect(
        fs.lstat(path.join(root, ".brain-move-intent.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(findPlacement(recovered.getTree(), page.id)?.parentId).toBe(
        trackedParent.id,
      );
      expect(recovered.findNotionPage(NOTION_PAGE)).toMatchObject({
        id: page.id,
        importing: { sourceHash: SOURCE_B },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const stableHead = await waitForHeadChange(root, baselineHead);
      expect(Number((await git(root, "rev-list", "--count", `${baselineHead}..${stableHead}`)).trim())).toBe(1);
      expect(await git(root, "ls-tree", "-r", "--name-only", stableHead)).not.toContain(
        ".brain-move-intent.json",
      );
      await expect(
        recovered.abortNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_B,
          reservationToken: reserved.reservationToken,
        }),
      ).resolves.toMatchObject({ status: "aborted" });
    } finally {
      rmSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["occupied-directory", "symlink"] as const)(
    "never reuses a raced abort transaction %s and poisons further writes",
    async (kind) => {
      const { s, root } = await tmpStore();
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Transaction collision",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      const realMkdir = fs.mkdir.bind(fs);
      let racedPath = "";
      const mkdir = vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
        const directory = String(args[0]);
        if (
          !racedPath &&
          path.basename(directory).startsWith(".brain-abort-txn-")
        ) {
          racedPath = directory;
          if (kind === "occupied-directory") {
            await realMkdir(directory, { mode: 0o700 });
            await fs.writeFile(path.join(directory, "attacker.txt"), "keep");
          } else {
            const target = path.join(root, "abort-transaction-race-target");
            await realMkdir(target, { mode: 0o700 });
            await fs.writeFile(path.join(target, "keep.txt"), "keep");
            await fs.symlink(target, directory);
          }
          throw Object.assign(new Error("synthetic transaction collision"), {
            code: "EEXIST",
          });
        }
        return realMkdir(...args);
      });
      try {
        await expect(
          s.abortNotionImport({
            notionId: NOTION_PAGE,
            sourceHash: SOURCE_A,
            reservationToken: reserved.reservationToken,
          }),
        ).rejects.toThrow(/intent reconciliation also failed/);
      } finally {
        mkdir.mockRestore();
      }
      expect(racedPath).not.toBe("");
      expect(
        (await fs.readdir(s.resolve(reserved.page.id))).some((name) =>
          name.startsWith(".brain-abort-intent-"),
        ),
      ).toBe(true);
      await expect(s.createPage(null, "Must remain blocked")).rejects.toThrow(
        /mutations are blocked by an unresolved Notion abort intent/,
      );
      if (kind === "occupied-directory") {
        await expect(
          fs.readFile(path.join(racedPath, "attacker.txt"), "utf8"),
        ).resolves.toBe("keep");
      } else {
        expect((await fs.lstat(racedPath)).isSymbolicLink()).toBe(true);
      }
    },
  );

  it("reports destination baseline integrity without exposing reservation tokens", async () => {
    const { s } = await tmpStore();
    const existing = await s.createPage(null, "Existing", { markdown: "body" });
    await adoptExisting(s, existing.id, NOTION_PAGE);
    await expect(s.inspectNotionPage(NOTION_PAGE)).resolves.toMatchObject({
      integrity: { trackedTargetIntact: true },
    });
    const read = await s.readPage(existing.id);
    await s.writePage(existing.id, "manual edit", read.rev, "me");
    await expect(s.inspectNotionPage(NOTION_PAGE)).resolves.toMatchObject({
      integrity: { trackedTargetIntact: false },
    });

    const pending = await reserveNotionImport(s, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Pending",
    });
    if (pending.status !== "reserved") throw new Error("expected reservation");
    const intact = await s.inspectNotionPage(NOTION_PAGE_B);
    expect(intact).toMatchObject({
      integrity: { importBaselineIntact: true },
    });
    expect(JSON.stringify(intact)).not.toContain(pending.reservationToken);
    const pendingRead = await s.readPage(pending.page.id);
    await s.writePage(pending.page.id, "manual pending edit", pendingRead.rev, "me");
    await expect(s.inspectNotionPage(NOTION_PAGE_B)).resolves.toMatchObject({
      integrity: { importBaselineIntact: false },
    });
  });

  it("reads back and hashes the exact staged attachment bytes", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Attachment",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const bytes = new TextEncoder().encode("verified staged bytes");
    const saved = await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      { data: bytes, originalName: "asset.txt", mimeType: "text/plain" },
    );
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    await expect(
      s.verifyNotionAttachment({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
        url: saved.url,
      }),
    ).resolves.toEqual({
      url: saved.url,
      size: bytes.byteLength,
      sha256: expectedSha256,
    });
    const staged = path.join(
      notionStagingRoot(root),
      reserved.reservationToken,
      saved.url.slice("/_attachments-v2/".length),
    );
    await fs.writeFile(staged, "corrupt");
    await expect(
      s.verifyNotionAttachment({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        reservationToken: reserved.reservationToken,
        url: saved.url,
      }),
    ).rejects.toMatchObject({ code: "missing_attachment" });
    await fs.writeFile(staged, bytes);
    await s.abortNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      reservationToken: reserved.reservationToken,
    });
  });

  it("verifies permanent bytes only for the intact finalized owning page", async () => {
    const { s, root } = await tmpStore();
    const firstParent = await s.createPage(null, "First parent");
    const secondParent = await s.createPage(null, "Second parent");
    const finalizeAttachment = async (
      notionId: string,
      title: string,
      body: string,
      parentId: string,
    ) => {
      const reserved = await reserveNotionImport(s, {
        notionId,
        sourceHash: SOURCE_A,
        parentId,
        title,
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      const bytes = new TextEncoder().encode(body + " bytes");
      const saved = await saveNotionAttachment(
        s,
        notionId,
        SOURCE_A,
        reserved.reservationToken,
        { data: bytes, originalName: title + ".txt", mimeType: "text/plain" },
      );
      const markdown = `[file](${saved.url})`;
      const targetHash = conversionHash(
        SOURCE_A,
        title,
        markdown,
        undefined,
        undefined,
        parentId,
      );
      await s.finalizeNotionImport({
        notionId,
        sourceHash: SOURCE_A,
        conversionHash: targetHash,
        reservationToken: reserved.reservationToken,
        markdown,
      });
      return { reserved, bytes, saved, targetHash };
    };
    const first = await finalizeAttachment(
      NOTION_PAGE,
      "First",
      "first",
      firstParent.id,
    );
    const second = await finalizeAttachment(
      NOTION_PAGE_B,
      "Second",
      "second",
      secondParent.id,
    );
    const verifyFirst = {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: first.targetHash,
      url: first.saved.url,
    };
    await expect(s.verifyFinalizedNotionAttachment(verifyFirst)).resolves.toEqual({
      url: first.saved.url,
      size: first.bytes.byteLength,
      sha256: createHash("sha256").update(first.bytes).digest("hex"),
    });
    await expect(
      s.verifyFinalizedNotionAttachment({
        ...verifyFirst,
        conversionHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
    await expect(
      s.verifyFinalizedNotionAttachment({
        ...verifyFirst,
        url: second.saved.url,
      }),
    ).rejects.toMatchObject({ code: "attachment_not_owned" });
    await expect(
      s.verifyFinalizedNotionAttachment({
        notionId: NOTION_PAGE_B,
        sourceHash: SOURCE_A,
        conversionHash: second.targetHash,
        url: first.saved.url,
      }),
    ).rejects.toMatchObject({ code: "attachment_not_owned" });

    const canonical = path.join(
      root,
      "_attachments",
      first.saved.url.slice("/_attachments-v2/".length),
    );
    await fs.rm(canonical);
    await expect(
      s.verifyFinalizedNotionAttachment(verifyFirst),
    ).rejects.toMatchObject({ code: "missing_attachment" });
    await fs.writeFile(canonical, first.bytes);
    await fs.writeFile(canonical, "tampered");
    await expect(
      s.verifyFinalizedNotionAttachment(verifyFirst),
    ).rejects.toMatchObject({ code: "missing_attachment" });
    await fs.writeFile(canonical, first.bytes);
    const symlinkTarget = path.join(root, "synthetic-attachment-target");
    await fs.writeFile(symlinkTarget, first.bytes);
    await fs.rm(canonical);
    await fs.symlink(symlinkTarget, canonical);
    await expect(
      s.verifyFinalizedNotionAttachment(verifyFirst),
    ).rejects.toMatchObject({ code: "missing_attachment" });
    await fs.rm(canonical);
    await fs.writeFile(canonical, first.bytes);

    const openedCanonical = canonical + ".opened";
    const realOpen = fs.open.bind(fs);
    let swappedAfterOpen = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (
        !swappedAfterOpen &&
        String(args[0]) === canonical &&
        typeof args[1] === "number"
      ) {
        swappedAfterOpen = true;
        await fs.rename(canonical, openedCanonical);
        await fs.symlink(symlinkTarget, canonical);
      }
      return handle;
    });
    try {
      await expect(
        s.verifyFinalizedNotionAttachment(verifyFirst),
      ).rejects.toMatchObject({ code: "missing_attachment" });
      expect(swappedAfterOpen).toBe(true);
    } finally {
      open.mockRestore();
      await fs.rm(canonical, { force: true });
      await fs.rename(openedCanonical, canonical);
    }

    const read = await s.readPage(first.reserved.page.id);
    await s.writePage(first.reserved.page.id, read.markdown + "\nmanual", read.rev, "me");
    await expect(
      s.verifyFinalizedNotionAttachment(verifyFirst),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("verifies a finalized cover from the permanent attachment store", async () => {
    const { s } = await tmpStore();
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const cover = notionAttachmentUrl(sha256, "cover.png", "image/png");
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Cover",
      cover,
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      { data: bytes, originalName: "cover.png", mimeType: "image/png" },
    );
    const targetHash = conversionHash(
      SOURCE_A,
      "Cover",
      "",
      undefined,
      cover,
    );
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: targetHash,
      reservationToken: reserved.reservationToken,
      cover,
      markdown: "",
    });
    await expect(
      s.verifyFinalizedNotionAttachment({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: targetHash,
        url: cover,
      }),
    ).resolves.toEqual({ url: cover, size: bytes.byteLength, sha256 });
  });

  it("repairs matching canonical symlinks on first finalize and unchanged reruns", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Files",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const bytes = new TextEncoder().encode("private attachment");
    const saved = await saveNotionAttachment(s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      { data: bytes, originalName: "привет.txt", mimeType: "text/plain" },
    );
    const name = saved.url.slice("/_attachments-v2/".length);
    const canonical = path.join(root, "_attachments", name);
    await expect(fs.readFile(canonical)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(path.dirname(canonical), { recursive: true });
    const symlinkTarget = path.join(root, "matching-attachment-target");
    await fs.writeFile(symlinkTarget, bytes);
    await fs.symlink(symlinkTarget, canonical);
    const markdown = `[привет](${saved.url})`;
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Files", markdown),
      reservationToken: reserved.reservationToken,
      markdown,
    });
    expect(new Uint8Array(await fs.readFile(canonical))).toEqual(bytes);
    expect((await fs.lstat(canonical)).isSymbolicLink()).toBe(false);

    await fs.rm(canonical);
    await fs.symlink(symlinkTarget, canonical);
    const repair = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Files", markdown),
      parentId: null,
      beforeId: null,
      title: "Files",
    });
    if (repair.status !== "reserved") throw new Error("expected repair reservation");
    await saveNotionAttachment(s, NOTION_PAGE, SOURCE_A, repair.reservationToken, {
      data: bytes,
      originalName: "привет.txt",
      mimeType: "text/plain",
    });
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Files", markdown),
      reservationToken: repair.reservationToken,
      markdown,
    });
    expect(new Uint8Array(await fs.readFile(canonical))).toEqual(bytes);
    expect((await fs.lstat(canonical)).isSymbolicLink()).toBe(false);

    await fs.writeFile(canonical, "corrupt");
    const corruptRepair = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Files", markdown),
      parentId: null,
      beforeId: null,
      title: "Files",
    });
    if (corruptRepair.status !== "reserved") {
      throw new Error("expected corrupt-byte repair reservation");
    }
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      corruptRepair.reservationToken,
      {
        data: bytes,
        originalName: "привет.txt",
        mimeType: "text/plain",
      },
    );
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Files", markdown),
      reservationToken: corruptRepair.reservationToken,
      markdown,
    });
    expect(new Uint8Array(await fs.readFile(canonical))).toEqual(bytes);
  });

  it("streams attachment promotion without reading a staged batch into memory", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Streamed files",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const firstBytes = new TextEncoder().encode("first streamed attachment");
    const secondBytes = new TextEncoder().encode("second streamed attachment");
    const first = await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: firstBytes,
        originalName: "first.txt",
        mimeType: "text/plain",
      },
    );
    const second = await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: secondBytes,
        originalName: "second.txt",
        mimeType: "text/plain",
      },
    );
    const markdown = `[first](${first.url})\n\n[second](${second.url})`;
    const stagingRoot = notionStagingRoot(root);
    const attachmentRoot = path.join(root, "_attachments");
    const realReadFile = fs.readFile.bind(fs);
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const file = String(args[0]);
      if (
        file.startsWith(stagingRoot + path.sep) ||
        file.startsWith(attachmentRoot + path.sep)
      ) {
        throw new Error("promotion attempted buffered readFile");
      }
      return realReadFile(...args);
    });
    try {
      await s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          "Streamed files",
          markdown,
        ),
        reservationToken: reserved.reservationToken,
        markdown,
      });
    } finally {
      readFile.mockRestore();
    }
    expect(
      new Uint8Array(
        await fs.readFile(
          path.join(attachmentRoot, first.url.slice("/_attachments-v2/".length)),
        ),
      ),
    ).toEqual(firstBytes);
    expect(
      new Uint8Array(
        await fs.readFile(
          path.join(attachmentRoot, second.url.slice("/_attachments-v2/".length)),
        ),
      ),
    ).toEqual(secondBytes);
  });

  it("fails missing attachment preflight without changing the page", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Missing",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const staged = await saveNotionAttachment(s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: new TextEncoder().encode("available"),
        originalName: "available.txt",
        mimeType: "text/plain",
      },
    );
    const missingUrl = `/_attachments-v2/${"f".repeat(64)}.txt`;
    const markdown = `[available](${staged.url})\n\n[missing](${missingUrl})`;

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Missing", markdown),
        reservationToken: reserved.reservationToken,
        markdown,
      }),
    ).rejects.toMatchObject({ code: "missing_attachment" });
    expect((await s.readPage(reserved.page.id)).markdown).toBe("");
    await expect(
      fs.readFile(
        path.join(
          root,
          "_attachments",
          staged.url.slice("/_attachments-v2/".length),
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(root, "_attachments", `${"f".repeat(64)}.txt`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves active Notion downloads under an inert binary attachment name", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Archive",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const bytes = new TextEncoder().encode("<script>alert(1)</script>");
    const saved = await saveNotionAttachment(s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: bytes,
        originalName: "snapshot.html",
        mimeType: "text/html",
      },
    );
    expect(saved.url).toMatch(/\.bin$/);
    expect(saved.type).toBe("text/html");
    const markdown = `[snapshot.html](${saved.url})`;
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Archive", markdown),
      reservationToken: reserved.reservationToken,
      markdown,
    });
    expect(
      new Uint8Array(
        await fs.readFile(
          path.join(
            root,
            "_attachments",
            saved.url.slice("/_attachments-v2/".length),
          ),
        ),
      ),
    ).toEqual(bytes);
  });

  it("enforces one aggregate staging quota across multiple reservations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-quota-"));
    const s = new Store(root, {
      notionStagingLimits: { maxFiles: 10, maxBytes: 7, minFreeBytes: 0 },
    });
    await s.init();
    const first = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "First",
    });
    const second = await reserveNotionImport(s, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Second",
    });
    if (first.status !== "reserved" || second.status !== "reserved") {
      throw new Error("expected reservations");
    }
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      first.reservationToken,
      {
        data: new TextEncoder().encode("1234"),
        originalName: "first.txt",
        mimeType: "text/plain",
      },
    );

    await expect(
      saveNotionAttachment(
        s,
        NOTION_PAGE_B,
        SOURCE_A,
        second.reservationToken,
        {
          data: new TextEncoder().encode("5678"),
          originalName: "second.txt",
          mimeType: "text/plain",
        },
      ),
    ).rejects.toMatchObject({ code: "quota_exceeded" });
  });

  it.each([
    ["parentId", ""],
    ["parentId", "bad/id"],
    ["parentId", "x".repeat(129)],
    ["beforeId", ""],
    ["beforeId", "bad/id"],
    ["beforeId", "x".repeat(129)],
  ] as const)(
    "rejects invalid Notion placement %s before any filesystem mutation",
    async (field, value) => {
      const { s, root } = await tmpStore();
      const filesBefore = (await fs.readdir(root)).sort();
      const treeBefore = JSON.stringify(s.getTree());
      await expect(
        s.reserveNotionImport({
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: field === "parentId" ? value : null,
          beforeId: field === "beforeId" ? value : null,
          title: "Invalid placement",
          reservationToken: "invalid_placement_token_0001",
        }),
      ).rejects.toMatchObject({ code: "reservation_mismatch" });
      expect(JSON.stringify(s.getTree())).toBe(treeBefore);
      expect((await fs.readdir(root)).sort()).toEqual(filesBefore);
    },
  );

  it.each([
    ["base symlink", "base", "symlink"],
    ["base mode", "base", "mode"],
    ["root symlink", "root", "symlink"],
    ["root mode", "root", "mode"],
  ] as const)("rejects hostile precreated notion staging %s", async (_name, level, kind) => {
    const sandbox = await fs.mkdtemp(path.join("/tmp", "brain-stage-hostile-"));
    await fs.chmod(sandbox, 0o700);
    const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(sandbox);
    try {
      const root = path.join(sandbox, "notes");
      const stagingRoot = notionStagingRoot(root);
      const base = path.dirname(stagingRoot);
      if (level === "root") await fs.mkdir(base, { mode: 0o700 });
      const hostile = level === "base" ? base : stagingRoot;
      if (kind === "symlink") {
        const target = path.join(sandbox, `${level}-target`);
        await fs.mkdir(target, { mode: 0o700 });
        await fs.symlink(target, hostile);
      } else {
        await fs.mkdir(hostile, { mode: 0o777 });
        await fs.chmod(hostile, 0o777);
      }
      await expect(new Store(root).init()).rejects.toMatchObject({
        code: "staging_unavailable",
        message: "Notion attachment staging is unavailable",
      });
    } finally {
      tmpdir.mockRestore();
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  it.each(["symlink", "mode"] as const)(
    "rejects a hostile active token %s before attachment upload",
    async (kind) => {
      const sandbox = await fs.mkdtemp(path.join("/tmp", "brain-stage-token-"));
      await fs.chmod(sandbox, 0o700);
      const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(sandbox);
      try {
        const root = path.join(sandbox, "notes");
        const s = new Store(root);
        await s.init();
        const reserved = await reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Hostile token",
        });
        if (reserved.status !== "reserved") throw new Error("expected reservation");
        const tokenDir = path.join(
          notionStagingRoot(root),
          reserved.reservationToken,
        );
        if (kind === "symlink") {
          const target = path.join(sandbox, "token-target");
          await fs.mkdir(target, { mode: 0o700 });
          await fs.symlink(target, tokenDir);
        } else {
          await fs.mkdir(tokenDir, { mode: 0o777 });
          await fs.chmod(tokenDir, 0o777);
        }
        await expect(
          saveNotionAttachment(
            s,
            NOTION_PAGE,
            SOURCE_A,
            reserved.reservationToken,
            {
              data: new TextEncoder().encode("must not be written"),
              originalName: "blocked.txt",
              mimeType: "text/plain",
            },
          ),
        ).rejects.toMatchObject({
          code: "staging_unavailable",
          message: "Notion attachment staging is unavailable",
        });
        if (kind === "symlink") {
          await expect(
            fs.readdir(path.join(sandbox, "token-target")),
          ).resolves.toEqual([]);
        } else {
          await expect(fs.readdir(tokenDir)).resolves.toEqual([]);
        }
      } finally {
        tmpdir.mockRestore();
        await fs.rm(sandbox, { recursive: true, force: true });
      }
    },
  );

  it("rejects staging ancestry not owned by the effective uid", async () => {
    const sandbox = await fs.mkdtemp(path.join("/tmp", "brain-stage-owner-"));
    await fs.chmod(sandbox, 0o700);
    const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(sandbox);
    const realEffectiveUid = process.geteuid?.();
    if (realEffectiveUid === undefined) throw new Error("POSIX uid is required");
    await fs.mkdir(path.join(sandbox, "brain-notion-imports"), { mode: 0o700 });
    const getEffectiveUid = vi
      .spyOn(process, "geteuid")
      .mockReturnValue(realEffectiveUid + 1);
    try {
      await expect(
        new Store(path.join(sandbox, "notes")).init(),
      ).rejects.toMatchObject({
        code: "staging_unavailable",
        message: "Notion attachment staging is unavailable",
      });
    } finally {
      getEffectiveUid.mockRestore();
      tmpdir.mockRestore();
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });

  it("reconciles fresh, orphan, and exact-TTL staging across restarts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const started = new Date("2026-07-11T10:00:00.000Z");
      vi.setSystemTime(started);
      const { s, root } = await tmpStore();
      const reserved = await reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
      });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      const saved = await saveNotionAttachment(
        s,
        NOTION_PAGE,
        SOURCE_A,
        reserved.reservationToken,
        {
          data: new TextEncoder().encode("staged"),
          originalName: "staged.txt",
          mimeType: "text/plain",
        },
      );
      const stagingRoot = notionStagingRoot(root);
      const stagedFile = path.join(
        stagingRoot,
        reserved.reservationToken,
        saved.url.slice("/_attachments-v2/".length),
      );
      const orphan = path.join(stagingRoot, "orphan_token_1234567890");
      await fs.mkdir(orphan, { recursive: true });
      await fs.writeFile(path.join(orphan, "orphan.bin"), "orphan");

      vi.setSystemTime(new Date(started.getTime() + 15 * 60 * 1_000 - 1));
      const freshReload = new Store(root);
      await freshReload.init();
      await expect(fs.stat(stagedFile)).resolves.toBeDefined();
      await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });

      vi.setSystemTime(new Date(started.getTime() + 15 * 60 * 1_000));
      const staleReload = new Store(root);
      await staleReload.init();
      await expect(fs.stat(stagedFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(staleReload.findNotionPage(NOTION_PAGE)?.importing).toBeDefined();

      const resumed = await reserveNotionImport(staleReload, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
        reservationToken: reserved.reservationToken,
      });
      expect(resumed).toMatchObject({
        status: "reserved",
        reservationToken: reserved.reservationToken,
      });
      await expect(
        saveNotionAttachment(
          staleReload,
          NOTION_PAGE,
          SOURCE_A,
          reserved.reservationToken,
          {
            data: new TextEncoder().encode("staged"),
            originalName: "staged.txt",
            mimeType: "text/plain",
          },
        ),
      ).resolves.toMatchObject({ url: saved.url });

      const indexPath = path.join(
        staleReload.resolve(reserved.page.id),
        "index.md",
      );
      const setStarted = async (value: string) => {
        const raw = await fs.readFile(indexPath, "utf8");
        await fs.writeFile(
          indexPath,
          raw.replace(/^notionImportStarted:.*$/m, `notionImportStarted: ${value}`),
        );
      };
      await setStarted("2099-01-01T00:00:00.000Z");
      const futureReload = new Store(root);
      await futureReload.init();
      await expect(fs.stat(stagedFile)).rejects.toMatchObject({ code: "ENOENT" });

      await reserveNotionImport(futureReload, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        parentId: null,
        title: "Page",
        reservationToken: reserved.reservationToken,
      });
      await saveNotionAttachment(
        futureReload,
        NOTION_PAGE,
        SOURCE_A,
        reserved.reservationToken,
        {
          data: new TextEncoder().encode("staged"),
          originalName: "staged.txt",
          mimeType: "text/plain",
        },
      );
      await setStarted("not-a-date");
      const invalidReload = new Store(root);
      await invalidReload.init();
      await expect(fs.stat(stagedFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when staging reconciliation cannot read the filesystem", async () => {
    const { s, root } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: new TextEncoder().encode("staged"),
        originalName: "staged.txt",
        mimeType: "text/plain",
      },
    );
    const denied = Object.assign(new Error("staging denied"), { code: "EACCES" });
    const realReaddir = fs.readdir.bind(fs);
    const stagingRoot = notionStagingRoot(root);
    const readdir = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      if (String(args[0]) === stagingRoot) throw denied;
      return realReaddir(...args);
    });
    try {
      await expect(new Store(root).init()).rejects.toMatchObject({
        code: "staging_unavailable",
        message: "Notion attachment staging is unavailable",
      });
    } finally {
      readdir.mockRestore();
    }
  });

  it("keeps adoption one-shot after a finalized page is manually edited", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "Page", "source"),
      reservationToken: reserved.reservationToken,
      markdown: "source",
    });
    await s.writePage(reserved.page.id, "manual", undefined, "me");
    const manual = await s.readPage(reserved.page.id);
    const placement = findPlacement(s.getTree(), reserved.page.id);
    if (!placement) throw new Error("page is missing from tree");

    await expect(
      s.adoptNotionImport({
        pageId: reserved.page.id,
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(
          SOURCE_A,
          "Page",
          "manual",
          undefined,
          undefined,
          placement.parentId,
          placement.beforeId,
        ),
        expectedRev: manual.rev,
        expectedParentId: placement.parentId,
        expectedBeforeId: placement.beforeId,
      }),
    ).rejects.toMatchObject({ code: "already_imported" });
    await expect(
      reserveNotionImport(s, {
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        parentId: null,
        title: "Page",
      }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });

  it("supports source-order sibling pass one, restart, and reverse finalize", async () => {
    const { s, root } = await tmpStore();
    const tokenA = "fresh_sibling_token_A_1234";
    const tokenB = "fresh_sibling_token_B_1234";
    const firstA = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      beforeId: null,
      title: "A",
      reservationToken: tokenA,
    });
    const firstB = await reserveNotionImport(s, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: null,
      beforeId: null,
      title: "B",
      reservationToken: tokenB,
    });
    if (firstA.status !== "reserved" || firstB.status !== "reserved") {
      throw new Error("expected reservations");
    }

    const reloaded = new Store(root);
    await reloaded.init();
    await reserveNotionImport(reloaded, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      beforeId: firstB.page.id,
      title: "A",
      reservationToken: tokenA,
    });
    await reserveNotionImport(reloaded, {
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      parentId: null,
      beforeId: null,
      title: "B",
      reservationToken: tokenB,
    });
    await reloaded.finalizeNotionImport({
      notionId: NOTION_PAGE_B,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(SOURCE_A, "B", "b"),
      reservationToken: tokenB,
      markdown: "b",
    });
    await reloaded.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "A",
        "a",
        undefined,
        undefined,
        null,
        firstB.page.id,
      ),
      reservationToken: tokenA,
      markdown: "a",
    });
    expect(reloaded.getTree().map((node) => node.id)).toEqual([
      firstA.page.id,
      firstB.page.id,
    ]);
  });

  it("reports finalize staging cleanup failure without rolling back the page", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      reserved.reservationToken,
      {
        data: new TextEncoder().encode("cleanup probe"),
        originalName: "cleanup.txt",
        mimeType: "text/plain",
      },
    );
    const realRm = fs.rm.bind(fs);
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === reserved.reservationToken) {
        throw new Error("cleanup failed");
      }
      return realRm(...args);
    });
    let finalized;
    try {
      finalized = await s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Page", "body"),
        reservationToken: reserved.reservationToken,
        markdown: "body",
      });
    } finally {
      rm.mockRestore();
    }
    expect(finalized).toMatchObject({
      status: "finalized",
      cleanup: { stagingRemoved: false },
    });
    expect((await s.readPage(reserved.page.id)).markdown).toBe("body");
    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Page", "body"),
        reservationToken: reserved.reservationToken,
        markdown: "body",
      }),
    ).resolves.toMatchObject({
      status: "unchanged",
      cleanup: { stagingRemoved: true },
    });
  });

  it("persists explicit empty icon and cover removal across reserve restart and finalize", async () => {
    const { s, root } = await tmpStore();
    const coverBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const cover = notionAttachmentUrl(
      createHash("sha256").update(coverBytes).digest("hex"),
      "cover.png",
      "image/png",
    );
    const first = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
      icon: "📄",
      cover,
    });
    if (first.status !== "reserved") throw new Error("expected reservation");
    await saveNotionAttachment(
      s,
      NOTION_PAGE,
      SOURCE_A,
      first.reservationToken,
      {
        data: coverBytes,
        originalName: "cover.png",
        mimeType: "image/png",
      },
    );
    await s.finalizeNotionImport({
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      conversionHash: conversionHash(
        SOURCE_A,
        "Page",
        "before",
        "📄",
        cover,
      ),
      reservationToken: first.reservationToken,
      title: "Page",
      icon: "📄",
      cover,
      markdown: "before",
    });

    const targetHash = conversionHash(SOURCE_B, "Page", "after");
    const second = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_B,
      conversionHash: targetHash,
      parentId: null,
      beforeId: null,
      title: "Page",
      icon: "",
      cover: "",
    });
    if (second.status !== "reserved") throw new Error("expected update reservation");
    const reloaded = new Store(root);
    await reloaded.init();
    await expect(
      reloaded.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_B,
        conversionHash: targetHash,
        reservationToken: second.reservationToken,
        title: "Page",
        icon: "",
        cover: "",
        markdown: "after",
      }),
    ).resolves.toMatchObject({ status: "finalized" });
    const finalized = await reloaded.readPage(first.page.id);
    expect(finalized.markdown).toBe("after");
    expect(finalized.meta.icon).toBeUndefined();
    expect(finalized.meta.cover).toBeUndefined();
  });

  it("rejects unsupported conversion markers before any page write", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");
    const markdown = [
      "```notion-unsupported",
      '{"type":"future","raw":"source"}',
      "```",
    ].join("\n");

    await expect(
      s.finalizeNotionImport({
        notionId: NOTION_PAGE,
        sourceHash: SOURCE_A,
        conversionHash: conversionHash(SOURCE_A, "Page", markdown),
        reservationToken: reserved.reservationToken,
        markdown,
      }),
    ).rejects.toMatchObject({ code: "conversion_issues" });
    expect((await s.readPage(reserved.page.id)).markdown).toBe("");
  });

  it("rejects attachment bytes that do not match the source descriptor hash", async () => {
    const { s } = await tmpStore();
    const reserved = await reserveNotionImport(s, {
      notionId: NOTION_PAGE,
      sourceHash: SOURCE_A,
      parentId: null,
      title: "Page",
    });
    if (reserved.status !== "reserved") throw new Error("expected reservation");

    await expect(
      s.saveNotionAttachment(
        NOTION_PAGE,
        SOURCE_A,
        reserved.reservationToken,
        {
          data: new TextEncoder().encode("wrong bytes"),
          originalName: "file.txt",
          mimeType: "text/plain",
          expectedSha256: "f".repeat(64),
        },
      ),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
  });

  it("rejects external and non-raster Notion cover URLs before reserve", async () => {
    const { s } = await tmpStore();
    for (const cover of [
      "https://notion.test/signed-cover.png",
      `/_attachments-v2/${"c".repeat(64)}.svg`,
      `/_attachments-v2/${"c".repeat(64)}.bin`,
    ]) {
      await expect(
        reserveNotionImport(s, {
          notionId: NOTION_PAGE,
          sourceHash: SOURCE_A,
          parentId: null,
          title: "Page",
          cover,
        }),
      ).rejects.toMatchObject({ code: "incompatible_cover" });
    }
    expect(s.findNotionPage(NOTION_PAGE)).toBeNull();
  });

  it("renames without moving the folder", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "Old");
    const before = s.resolve(a.id);
    await s.renamePage(a.id, "New");
    expect(s.resolve(a.id)).toBe(before);
    expect(s.getTree()[0].title).toBe("New");
  });

  it("moves a page under a new parent", async () => {
    const { s } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const child = await s.createPage(p1.id, "Child");
    await s.movePage(child.id, p2.id);
    const tree = s.getTree();
    expect(tree.find((n) => n.title === "P2")!.children.map((c) => c.title)).toContain(
      "Child",
    );
    expect(tree.find((n) => n.title === "P1")!.hasChildren).toBe(false);
  });

  it("nests one page reference and returns the authoritative parent", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent", {
      markdown: "Intro",
    });
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const markdown = [
      "Intro",
      `[Source](/p/${source.id})`,
      `Inline [Source](/p/${source.id}) stays`,
      `[Target](/p/${target.id})`,
    ].join("\n\n");
    const current = await s.writePage(parent.id, markdown);

    const result = await s.nestPageRef(
      source.id,
      target.id,
      parent.id,
      current.rev,
      0,
      `[Source](/p/${source.id})`,
      "nest-test",
    );

    const expectedMarkdown = [
      "Intro",
      `Inline [Source](/p/${source.id}) stays`,
      `[Target](/p/${target.id})`,
    ].join("\n\n");
    expect(result.removed).toBe(true);
    expect(result.moved.id).toBe(source.id);
    expect(result.parent).toMatchObject({
      meta: { id: parent.id, updatedBy: "me" },
      markdown: expectedMarkdown,
    });
    const authoritative = await s.readPage(parent.id);
    expect(result.parent).toEqual(authoritative);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
    await expect(s.readPage(target.id)).resolves.toMatchObject({
      markdown: `[Source](/p/${source.id})`,
    });
    expect(s.trashList()).toEqual([]);
  });

  it("rejects page-ref nesting that would create a new public-share overlap", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Shared source");
    const target = await s.createPage(parent.id, "Shared target");
    await s.updateMeta(source.id, { public: true });
    await s.updateMeta(target.id, {
      public: true,
      shareExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    const sourceRef = `[Shared source](/p/${source.id})`;
    const targetRef = `[Shared target](/p/${target.id})`;
    const current = await s.writePage(
      parent.id,
      `${sourceRef}\n\n${targetRef}`,
    );
    const targetBefore = await s.readPage(target.id);

    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        current.rev,
        0,
        sourceRef,
        "share-overlap-test",
      ),
    ).rejects.toThrow("public share roots cannot overlap");

    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(parent.id);
    await expect(s.readPage(parent.id)).resolves.toEqual(current);
    await expect(s.readPage(target.id)).resolves.toEqual(targetBefore);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("moves a referenced direct child onto an external tree target as its last child", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(null, "External target");
    const existing = await s.createPage(target.id, "Existing child");
    const sourceRef = `[Source](/p/${source.id})`;
    const current = await s.writePage(parent.id, `Intro\n\n${sourceRef}\n\nTail`);

    const result = await s.nestPageRef(
      source.id,
      target.id,
      parent.id,
      current.rev,
      0,
      sourceRef,
      "tree-drop-test",
      "tree",
    );

    expect(result.removed).toBe(true);
    expect(result.parent.markdown).toBe("Intro\n\nTail");
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
    await expect(s.readPage(target.id)).resolves.toMatchObject({
      markdown: `[Source](/p/${source.id})`,
    });
    expect(
      s.getTree().find((node) => node.id === target.id)?.children.map((child) => child.id),
    ).toEqual([existing.id, source.id]);
  });

  it("moves a referenced page from another branch onto a sidebar target", async () => {
    const { s } = await tmpStore();
    const originalParent = await s.createPage(null, "Original parent");
    const source = await s.createPage(originalParent.id, "Source");
    const refOwner = await s.createPage(null, "Reference owner");
    const target = await s.createPage(null, "Target");
    const sourceRef = `[Source](/p/${source.id})`;
    const current = await s.writePage(refOwner.id, `Before\n\n${sourceRef}\n\nAfter`);

    const result = await s.nestPageRef(
      source.id,
      target.id,
      refOwner.id,
      current.rev,
      0,
      sourceRef,
      "tree-drop-test",
      "tree",
    );

    expect(result.parent.markdown).toBe("Before\n\nAfter");
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
    await expect(s.readPage(target.id)).resolves.toMatchObject({
      markdown: `[Source](/p/${source.id})`,
    });
  });

  it("rejects an external tree target inside the source subtree without mutation", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const descendant = await s.createPage(source.id, "Descendant");
    const sourceRef = `[Source](/p/${source.id})`;
    const current = await s.writePage(parent.id, sourceRef);

    await expect(
      s.nestPageRef(
        source.id,
        descendant.id,
        parent.id,
        current.rev,
        0,
        sourceRef,
        "tree-drop-test",
        "tree",
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });

    await expect(s.readPage(parent.id)).resolves.toEqual(current);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(parent.id);
    expect(findPlacement(s.getTree(), descendant.id)?.parentId).toBe(source.id);
  });

  it("rejects a tree move whose exact reference is owned by the source subtree", async () => {
    const { s, root } = await tmpStore();
    const source = await s.createPage(null, "Source");
    const referenceOwner = await s.createPage(source.id, "Reference owner");
    const target = await s.createPage(null, "Target");
    const sourceRef = `[Source](/p/${source.id})`;
    const referenceBefore = await s.writePage(referenceOwner.id, sourceRef);

    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        referenceOwner.id,
        referenceBefore.rev,
        0,
        sourceRef,
        "tree-owner-cycle-test",
        "tree",
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });

    await expect(s.readPage(referenceOwner.id)).resolves.toEqual(referenceBefore);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBeNull();
    expect(findPlacement(s.getTree(), referenceOwner.id)?.parentId).toBe(source.id);
    const restarted = new Store(root);
    await expect(restarted.init()).resolves.toBeUndefined();
    expect(findPlacement(restarted.getTree(), referenceOwner.id)?.parentId).toBe(
      source.id,
    );
  });

  it("nests a synthesized direct-child reference and fences the old revision", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent", {
      markdown: "Body without persisted child references",
    });
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const before = await s.readPage(parent.id);
    const beforeRaw = await fs.readFile(
      path.join(s.resolve(parent.id), "index.md"),
      "utf8",
    );

    const result = await s.nestPageRef(
      source.id,
      target.id,
      parent.id,
      before.rev,
      null,
      null,
    );

    expect(result.removed).toBe(false);
    expect(result.parent.markdown).toBe(before.markdown);
    expect(result.parent.rev).not.toBe(before.rev);
    expect(result.parent.meta.structureWriteBarrier).toBe(true);
    await expect(s.readPage(parent.id)).resolves.toEqual(result.parent);
    await expect(
      fs.readFile(path.join(s.resolve(parent.id), "index.md"), "utf8"),
    ).resolves.not.toBe(beforeRaw);
    await expect(
      s.writePage(
        parent.id,
        `${before.markdown}\n\n[Stale source](/p/${source.id})`,
        before.rev,
        "me",
        undefined,
        before.markdown,
      ),
    ).rejects.toMatchObject({
      name: "RevConflictError",
      currentRev: result.parent.rev,
      expectedRev: before.rev,
    });

    const established = await s.writePage(
      parent.id,
      "Fresh body after nesting",
      result.parent.rev,
      "me",
      undefined,
      result.parent.markdown,
    );
    expect(established.meta.structureWriteBarrier).toBeUndefined();
    await s.updateMeta(parent.id, { title: "Renamed parent" });
    await expect(
      s.writePage(
        parent.id,
        "Fresh body after harmless metadata change",
        established.rev,
        "me",
        undefined,
        established.markdown,
      ),
    ).resolves.toMatchObject({
      markdown: "Fresh body after harmless metadata change",
      meta: { title: "Renamed parent" },
    });
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
  });

  it("removes only the exact selected page-ref occurrence", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const first = `[First label](/p/${source.id})`;
    const second = `[Second label](/p/${source.id})`;
    const current = await s.writePage(
      parent.id,
      `${first}\n\n${second}\n\n[Target](/p/${target.id})`,
    );

    const result = await s.nestPageRef(
      source.id,
      target.id,
      parent.id,
      current.rev,
      1,
      second,
    );

    expect(result.removed).toBe(true);
    expect(result.parent.markdown).toBe(
      `${first}\n\n[Target](/p/${target.id})`,
    );
  });

  it("cleans an exact stale grandparent ref when the source is already nested", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const target = await s.createPage(parent.id, "Target");
    const source = await s.createPage(target.id, "Source", {
      markdown: "Source body stays untouched",
    });
    const first = `[First stale label](/p/${source.id})`;
    const selected = `[Selected stale label](/p/${source.id})`;
    const targetRef = `[Target](/p/${target.id})`;
    const current = await s.writePage(
      parent.id,
      `${first}\n\n${selected}\n\n${targetRef}`,
    );
    const sourceBefore = await s.readPage(source.id);
    const targetBefore = await s.readPage(target.id);
    const sourceDir = s.resolve(source.id);

    const result = await s.nestPageRef(
      source.id,
      target.id,
      parent.id,
      current.rev,
      1,
      selected,
      "cleanup-test",
    );

    expect(result).toMatchObject({
      removed: true,
      moved: sourceBefore.meta,
      parent: {
        meta: {
          id: parent.id,
          updatedBy: "me",
          structureWriteBarrier: undefined,
        },
        markdown: `${first}\n\n${targetRef}`,
      },
    });
    expect(result.parent.rev).not.toBe(current.rev);
    await expect(s.readPage(parent.id)).resolves.toEqual(result.parent);
    await expect(s.readPage(source.id)).resolves.toEqual(sourceBefore);
    await expect(s.readPage(target.id)).resolves.toMatchObject({
      meta: { id: target.id, updatedBy: "me" },
      markdown: `[Source](/p/${source.id})`,
    });
    expect((await s.readPage(target.id)).rev).not.toBe(targetBefore.rev);
    expect(s.resolve(source.id)).toBe(sourceDir);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
    expect(findPlacement(s.getTree(), target.id)?.parentId).toBe(parent.id);
    expect(s.trashList()).toEqual([]);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans an exact stale tree-drop ref after the hierarchy move already committed", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const target = await s.createPage(null, "External target");
    const source = await s.createPage(target.id, "Source");
    const sourceRef = `[Stale source](/p/${source.id})`;
    const current = await s.writePage(parent.id, sourceRef);

    const result = await s.nestPageRef(
      source.id,
      target.id,
      parent.id,
      current.rev,
      0,
      sourceRef,
      "tree-cleanup-test",
      "tree",
    );

    expect(result.removed).toBe(true);
    expect(result.parent.markdown).toBe("");
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
    await expect(s.readPage(target.id)).resolves.toMatchObject({
      markdown: `[Source](/p/${source.id})`,
    });
    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        result.parent.rev,
        null,
        null,
        "tree-cleanup-test",
        "tree",
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });
  });

  it("keeps cleanup-only rev and exact-occurrence safeguards fail-closed", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const target = await s.createPage(parent.id, "Target");
    const source = await s.createPage(target.id, "Source");
    const sourceRef = `[Source](/p/${source.id})`;
    const targetRef = `[Target](/p/${target.id})`;
    const current = await s.writePage(
      parent.id,
      `${sourceRef}\n\n${targetRef}`,
    );

    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        current.rev,
        0,
        `[Wrong](/p/${source.id})`,
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });
    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        current.rev,
        null,
        null,
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });
    await expect(s.readPage(parent.id)).resolves.toEqual(current);

    const concurrent = await s.writePage(
      parent.id,
      `Concurrent edit\n\n${sourceRef}\n\n${targetRef}`,
      current.rev,
    );
    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        current.rev,
        0,
        sourceRef,
      ),
    ).rejects.toMatchObject({
      name: "RevConflictError",
      currentRev: concurrent.rev,
      expectedRev: current.rev,
    });

    await expect(s.readPage(parent.id)).resolves.toEqual(concurrent);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
    expect(s.trashList()).toEqual([]);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mismatched physical or synthesized page-ref selection", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const current = await s.writePage(
      parent.id,
      `[Source](/p/${source.id})\n\n[Target](/p/${target.id})`,
    );

    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        current.rev,
        0,
        `[Wrong](/p/${source.id})`,
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });
    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        current.rev,
        null,
        null,
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });

    await expect(s.readPage(parent.id)).resolves.toEqual(current);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(parent.id);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a synthesized arbitrary-tree move before changing body or hierarchy", async () => {
    const { s } = await tmpStore();
    const originalParent = await s.createPage(null, "Original parent");
    const source = await s.createPage(originalParent.id, "Source");
    const referenceOwner = await s.createPage(null, "Reference owner");
    const target = await s.createPage(null, "Target");
    const referenceBefore = await s.writePage(
      referenceOwner.id,
      "Body without a source reference",
    );
    const targetBefore = await s.readPage(target.id);

    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        referenceOwner.id,
        referenceBefore.rev,
        null,
        null,
        "tree-synthesized-test",
        "tree",
      ),
    ).rejects.toMatchObject({ name: "PageRefNestValidationError" });

    await expect(s.readPage(referenceOwner.id)).resolves.toEqual(
      referenceBefore,
    );
    await expect(s.readPage(target.id)).resolves.toEqual(targetBefore);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(
      originalParent.id,
    );
  });

  it("rejects stale page-ref nesting before changing body or hierarchy", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const linked = await s.writePage(
      parent.id,
      `[Source](/p/${source.id})\n\n[Target](/p/${target.id})`,
    );
    const concurrent = await s.writePage(
      parent.id,
      `Concurrent edit\n\n[Source](/p/${source.id})\n\n[Target](/p/${target.id})`,
      linked.rev,
    );

    await expect(
      s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        linked.rev,
        0,
        `[Source](/p/${source.id})`,
      ),
    ).rejects.toMatchObject({
      name: "RevConflictError",
      currentRev: concurrent.rev,
      expectedRev: linked.rev,
    });

    await expect(s.readPage(parent.id)).resolves.toEqual(concurrent);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(parent.id);
    expect(findPlacement(s.getTree(), target.id)?.parentId).toBe(parent.id);
  });

  it("restores the parent body and metadata when page-ref nesting move fails", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const original = await s.writePage(
      parent.id,
      `Before\n\n[Source](/p/${source.id})\n\n[Target](/p/${target.id})`,
    );
    const parentIndex = path.join(s.resolve(parent.id), "index.md");
    const originalRaw = await fs.readFile(parentIndex, "utf8");
    const originalSourceDir = s.resolve(source.id);
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === originalSourceDir) {
        throw new Error("nest move failed");
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          parent.id,
          original.rev,
          0,
          `[Source](/p/${source.id})`,
        ),
      ).rejects.toThrow("nest move failed");
    } finally {
      rename.mockRestore();
    }

    expect(await fs.readFile(parentIndex, "utf8")).toBe(originalRaw);
    await expect(s.readPage(parent.id)).resolves.toEqual(original);
    expect(s.resolve(source.id)).toBe(originalSourceDir);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(parent.id);
    expect(findPlacement(s.getTree(), target.id)?.parentId).toBe(parent.id);
    expect(s.trashList()).toEqual([]);
  });

  it("rolls an arbitrary tree reference back to its real original parent without poisoning mutations", async () => {
    const { s } = await tmpStore();
    const originalParent = await s.createPage(null, "Original parent");
    const source = await s.createPage(originalParent.id, "Source");
    const referenceOwner = await s.createPage(null, "Reference owner");
    const target = await s.createPage(null, "Target");
    const sourceRef = `[Source](/p/${source.id})`;
    const current = await s.writePage(referenceOwner.id, sourceRef);
    const referenceBefore = await s.readPage(referenceOwner.id);
    const targetBefore = await s.readPage(target.id);
    const originalSourceDir = s.resolve(source.id);
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === originalSourceDir) {
        throw new Error("tree move failed before rename");
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          referenceOwner.id,
          current.rev,
          0,
          sourceRef,
          "tree-rollback-test",
          "tree",
        ),
      ).rejects.toThrow("tree move failed before rename");
    } finally {
      rename.mockRestore();
    }

    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(
      originalParent.id,
    );
    await expect(s.readPage(referenceOwner.id)).resolves.toEqual(
      referenceBefore,
    );
    await expect(s.readPage(target.id)).resolves.toEqual(targetBefore);
    await expect(
      s.updateMeta(referenceOwner.id, { title: "Reference owner still writable" }),
    ).resolves.toMatchObject({ title: "Reference owner still writable" });
  });

  it("finishes stale-reference cleanup into the destination body after a crash", async () => {
    const { s, root } = await tmpStore();
    const referenceOwner = await s.createPage(null, "Reference owner");
    const target = await s.createPage(null, "Target");
    const source = await s.createPage(target.id, "Source");
    const sourceRef = `[Stale source](/p/${source.id})`;
    const current = await s.writePage(referenceOwner.id, sourceRef);
    const targetIndex = path.join(s.resolve(target.id), "index.md");
    const restoreReconciliation = blockBoardIntentReconciliation(s);
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!injected && String(args[1]) === targetIndex) {
        injected = true;
        throw new Error("simulated stop before destination body write");
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          referenceOwner.id,
          current.rev,
          0,
          sourceRef,
          "cleanup-crash-test",
          "tree",
        ),
      ).rejects.toThrow("could not be reconciled");
    } finally {
      rename.mockRestore();
      restoreReconciliation();
    }

    expect(injected).toBe(true);
    await expect(
      fs.stat(path.join(root, ".brain-board-intent.json")),
    ).resolves.toBeDefined();

    const restarted = new Store(root);
    await restarted.init();
    await expect(restarted.readPage(referenceOwner.id)).resolves.toMatchObject({
      markdown: "",
    });
    await expect(restarted.readPage(target.id)).resolves.toMatchObject({
      markdown: `[Source](/p/${source.id})`,
    });
    expect(findPlacement(restarted.getTree(), source.id)?.parentId).toBe(
      target.id,
    );
    await expect(
      fs.stat(path.join(root, ".brain-board-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Git snapshots behind page-ref reconciliation until one stable commit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rename: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { s, root } = await tmpStore();
      const parent = await s.createPage(null, "Parent");
      const source = await s.createPage(parent.id, "Source");
      const target = await s.createPage(parent.id, "Target");
      const original = await s.writePage(
        parent.id,
        `[Source](/p/${source.id})\n\n[Target](/p/${target.id})`,
      );
      await git(root, "init", "-q");
      const baselineHead = await commitAll(root, "baseline before page-ref nest");
      const parentIndex = path.join(s.resolve(parent.id), "index.md");
      const relativeParentIndex = path.relative(root, parentIndex);
      const baselineParentRaw = await fs.readFile(parentIndex, "utf8");
      const originalSourceDir = s.resolve(source.id);
      scheduleCommit(root);

      const realRename = fs.rename.bind(fs);
      let injected = false;
      rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (!injected && String(args[0]) === originalSourceDir) {
          injected = true;
          await realRename(...args);
          await vi.advanceTimersByTimeAsync(5_000);
          expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(
            baselineHead,
          );
          expect(await git(root, "show", `HEAD:${relativeParentIndex}`)).toBe(
            baselineParentRaw,
          );
          expect(
            await git(root, "ls-tree", "-r", "--name-only", "HEAD"),
          ).not.toContain(".brain-move-intent.json");
          throw new Error("simulated crash after directory rename");
        }
        return realRename(...args);
      });
      const result = await s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        original.rev,
        0,
        `[Source](/p/${source.id})`,
      );

      expect(injected).toBe(true);
      expect(result.removed).toBe(true);
      expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
      expect(result.parent.markdown).toBe(`[Target](/p/${target.id})`);
      await expect(s.readPage(parent.id)).resolves.toEqual(result.parent);
      await expect(
        fs.stat(path.join(root, ".brain-move-intent.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await vi.advanceTimersByTimeAsync(5_000);
      const stableHead = await waitForHeadChange(root, baselineHead);
      expect(
        Number(
          (
            await git(
              root,
              "rev-list",
              "--count",
              `${baselineHead}..${stableHead}`,
            )
          ).trim(),
        ),
      ).toBe(1);
      expect(await git(root, "show", `${stableHead}:${relativeParentIndex}`)).toBe(
        await fs.readFile(parentIndex, "utf8"),
      );
      const relativeMovedIndex = path.relative(
        root,
        path.join(s.resolve(source.id), "index.md"),
      );
      expect(
        await git(root, "ls-tree", "-r", "--name-only", stableHead),
      ).toContain(relativeMovedIndex);
      expect(
        await git(root, "ls-tree", "-r", "--name-only", stableHead),
      ).not.toContain(".brain-move-intent.json");
    } finally {
      rename?.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps cleanup-only parent replacement behind the Git snapshot barrier", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rename: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { s, root } = await tmpStore();
      const parent = await s.createPage(null, "Parent");
      const target = await s.createPage(parent.id, "Target");
      const source = await s.createPage(target.id, "Source");
      const sourceRef = `[Source](/p/${source.id})`;
      const targetRef = `[Target](/p/${target.id})`;
      const original = await s.writePage(
        parent.id,
        `${sourceRef}\n\n${targetRef}`,
      );
      const parentIndex = path.join(s.resolve(parent.id), "index.md");
      const relativeParentIndex = path.relative(root, parentIndex);
      const originalParentRaw = await fs.readFile(parentIndex, "utf8");
      const sourceDir = s.resolve(source.id);
      await git(root, "init", "-q");
      const baselineHead = await commitAll(
        root,
        "baseline before stale page-ref cleanup",
      );
      scheduleCommit(root);

      const realRename = fs.rename.bind(fs);
      let observedBarrier = false;
      rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (
          !observedBarrier &&
          path.dirname(String(args[0])) === path.dirname(parentIndex) &&
          path.basename(String(args[0])).startsWith(".tmp-") &&
          String(args[1]) === parentIndex
        ) {
          observedBarrier = true;
          await vi.advanceTimersByTimeAsync(5_000);
          expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(
            baselineHead,
          );
          expect(await git(root, "show", `HEAD:${relativeParentIndex}`)).toBe(
            originalParentRaw,
          );
        }
        return realRename(...args);
      });

      const result = await s.nestPageRef(
        source.id,
        target.id,
        parent.id,
        original.rev,
        0,
        sourceRef,
      );

      expect(observedBarrier).toBe(true);
      expect(result.parent.markdown).toBe(targetRef);
      expect(s.resolve(source.id)).toBe(sourceDir);
      expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
      await expect(
        fs.stat(path.join(root, ".brain-move-intent.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      await vi.advanceTimersByTimeAsync(5_000);
      const stableHead = await waitForHeadChange(root, baselineHead);
      expect(
        Number(
          (
            await git(
              root,
              "rev-list",
              "--count",
              `${baselineHead}..${stableHead}`,
            )
          ).trim(),
        ),
      ).toBe(1);
      expect(await git(root, "show", `${stableHead}:${relativeParentIndex}`)).toBe(
        await fs.readFile(parentIndex, "utf8"),
      );
      expect(
        await git(root, "ls-tree", "-r", "--name-only", stableHead),
      ).not.toContain(".brain-move-intent.json");
    } finally {
      rename?.mockRestore();
      vi.useRealTimers();
    }
  });

  it("rolls an intent-only synthesized nesting back on restart", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent", {
      markdown: "Parent body stays byte-identical",
    });
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const before = await s.readPage(parent.id);
    const beforeRaw = await fs.readFile(
      path.join(s.resolve(parent.id), "index.md"),
      "utf8",
    );
    const originalSourceDir = s.resolve(source.id);
    const restoreReconciliation = blockMoveIntentReconciliation(s);
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === originalSourceDir) {
        throw new Error("simulated stop before child rename");
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          parent.id,
          before.rev,
          null,
          null,
        ),
      ).rejects.toThrow("move state could not be reconciled");
    } finally {
      rename.mockRestore();
      restoreReconciliation();
    }

    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).resolves.toBeDefined();
    const restarted = new Store(root);
    await restarted.init();
    expect(findPlacement(restarted.getTree(), source.id)?.parentId).toBe(
      parent.id,
    );
    await expect(restarted.readPage(parent.id)).resolves.toEqual(before);
    await expect(
      fs.readFile(path.join(restarted.resolve(parent.id), "index.md"), "utf8"),
    ).resolves.toBe(beforeRaw);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds the Git barrier after poisoned nesting until restart recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rename: ReturnType<typeof vi.spyOn> | undefined;
    let restoreReconciliation: (() => void) | undefined;
    try {
      const { s, root } = await tmpStore();
      const parent = await s.createPage(null, "Parent", {
        markdown: "Stable parent body",
      });
      const source = await s.createPage(parent.id, "Source");
      const target = await s.createPage(parent.id, "Target");
      const before = await s.readPage(parent.id);
      const parentIndex = path.join(s.resolve(parent.id), "index.md");
      const relativeParentIndex = path.relative(root, parentIndex);
      const beforeRaw = await fs.readFile(parentIndex, "utf8");
      await git(root, "init", "-q");
      const baselineHead = await commitAll(
        root,
        "baseline before poisoned page-ref nest",
      );
      scheduleCommit(root);

      restoreReconciliation = blockMoveIntentReconciliation(s);
      const originalSourceDir = s.resolve(source.id);
      const realRename = fs.rename.bind(fs);
      rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
        if (String(args[0]) === originalSourceDir) {
          throw new Error("simulated stop before child rename");
        }
        return realRename(...args);
      });
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          parent.id,
          before.rev,
          null,
          null,
        ),
      ).rejects.toThrow("move state could not be reconciled");

      await vi.advanceTimersByTimeAsync(5_000);
      expect((await git(root, "rev-parse", "HEAD")).trim()).toBe(baselineHead);
      expect(await git(root, "show", `HEAD:${relativeParentIndex}`)).toBe(
        beforeRaw,
      );
      expect(
        await git(root, "ls-tree", "-r", "--name-only", "HEAD"),
      ).not.toContain(".brain-move-intent.json");
      await expect(
        fs.stat(path.join(root, ".brain-move-intent.json")),
      ).resolves.toBeDefined();

      rename.mockRestore();
      rename = undefined;
      restoreReconciliation();
      restoreReconciliation = undefined;
      const restarted = new Store(root);
      await restarted.init();
      expect(findPlacement(restarted.getTree(), source.id)?.parentId).toBe(
        parent.id,
      );
      await expect(restarted.readPage(parent.id)).resolves.toEqual(before);
      await expect(
        fs.stat(path.join(root, ".brain-move-intent.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      const recovered = await restarted.writePage(
        parent.id,
        "Write after restart recovery",
        before.rev,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const recoveredHead = await waitForHeadChange(root, baselineHead);
      expect(
        await git(root, "show", `${recoveredHead}:${relativeParentIndex}`),
      ).toBe(await fs.readFile(parentIndex, "utf8"));
      expect(recovered.markdown).toBe("Write after restart recovery");
      expect(
        await git(root, "ls-tree", "-r", "--name-only", recoveredHead),
      ).not.toContain(".brain-move-intent.json");
    } finally {
      rename?.mockRestore();
      restoreReconciliation?.();
      vi.useRealTimers();
    }
  });

  it("finishes child and parent after restart between rename and parent write", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const sourceRef = `[Source](/p/${source.id})`;
    const targetRef = `[Target](/p/${target.id})`;
    const before = await s.writePage(
      parent.id,
      `${sourceRef}\n\n${targetRef}`,
    );
    const originalSourceDir = s.resolve(source.id);
    const restoreReconciliation = blockMoveIntentReconciliation(s);
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!injected && String(args[0]) === originalSourceDir) {
        injected = true;
        await realRename(...args);
        throw new Error("simulated stop after child rename");
      }
      return realRename(...args);
    });
    try {
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          parent.id,
          before.rev,
          0,
          sourceRef,
        ),
      ).rejects.toThrow("move state could not be reconciled");
    } finally {
      rename.mockRestore();
      restoreReconciliation();
    }

    expect(injected).toBe(true);
    // The child rename committed, but the parent write had not started.
    await expect(fs.readFile(path.join(s.resolve(parent.id), "index.md"), "utf8"))
      .resolves.toContain(sourceRef);
    const restarted = new Store(root);
    await restarted.init();
    expect(findPlacement(restarted.getTree(), source.id)?.parentId).toBe(
      target.id,
    );
    await expect(restarted.readPage(parent.id)).resolves.toMatchObject({
      markdown: targetRef,
    });
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("idempotently clears a fully written nesting intent on restart", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const sourceRef = `[Source](/p/${source.id})`;
    const targetRef = `[Target](/p/${target.id})`;
    const before = await s.writePage(
      parent.id,
      `${sourceRef}\n\n${targetRef}`,
    );
    const intentPath = path.join(root, ".brain-move-intent.json");
    const restoreReconciliation = blockMoveIntentReconciliation(s);
    const realRm = fs.rm.bind(fs);
    let injected = false;
    const rm = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
      if (!injected && String(args[0]) === intentPath) {
        injected = true;
        throw new Error("simulated stop before intent clear");
      }
      return realRm(...args);
    });
    try {
      await expect(
        s.nestPageRef(
          source.id,
          target.id,
          parent.id,
          before.rev,
          0,
          sourceRef,
        ),
      ).rejects.toThrow("move state could not be reconciled");
    } finally {
      rm.mockRestore();
      restoreReconciliation();
    }

    expect(injected).toBe(true);
    await expect(fs.stat(intentPath)).resolves.toBeDefined();
    const restarted = new Store(root);
    await restarted.init();
    expect(findPlacement(restarted.getTree(), source.id)?.parentId).toBe(
      target.id,
    );
    await expect(restarted.readPage(parent.id)).resolves.toMatchObject({
      markdown: targetRef,
    });
    await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a move that would introduce nested public roots before filesystem access", async () => {
    const { s } = await tmpStore();
    const source = await s.createPage(null, "Source");
    const movingRoot = await s.createPage(source.id, "Moving public root");
    const destination = await s.createPage(null, "Destination", {
      markdown: "Destination body",
    });
    await s.updateMeta(movingRoot.id, {
      public: true,
      shareExpiresAt: "malformed-deadline",
    });
    await s.updateMeta(destination.id, {
      public: true,
      shareExpiresAt: "2020-01-01T00:00:00.000Z",
    });
    const originalDir = s.resolve(source.id);
    const readFile = vi.spyOn(fs, "readFile");
    try {
      await expect(s.movePage(source.id, destination.id)).rejects.toThrow(
        "public share roots cannot overlap",
      );
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }

    expect(s.resolve(source.id)).toBe(originalDir);
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBeNull();
    await expect(s.readPage(destination.id)).resolves.toMatchObject({
      markdown: "Destination body",
    });
  });

  it("allows unrelated moves and movement within the same legacy public root", async () => {
    const { s } = await tmpStore();
    const sharedAncestor = await s.createPage(null, "Shared ancestor");
    const left = await s.createPage(sharedAncestor.id, "Left");
    const right = await s.createPage(sharedAncestor.id, "Right");
    const legacyNestedRoot = await s.createPage(left.id, "Legacy nested root");
    const privateLeaf = await s.createPage(left.id, "Private leaf");
    const unrelatedPublic = await s.createPage(null, "Unrelated public");
    const privateDestination = await s.createPage(null, "Private destination");
    await s.updateMeta(sharedAncestor.id, { public: true });
    await s.updateMeta(legacyNestedRoot.id, { public: true });
    await s.updateMeta(unrelatedPublic.id, { public: true });

    await expect(
      s.movePage(legacyNestedRoot.id, right.id),
    ).resolves.toMatchObject({ id: legacyNestedRoot.id });
    await expect(
      s.movePage(legacyNestedRoot.id, null),
    ).resolves.toMatchObject({ id: legacyNestedRoot.id });
    await expect(s.movePage(privateLeaf.id, right.id)).resolves.toMatchObject({
      id: privateLeaf.id,
    });
    await expect(
      s.movePage(unrelatedPublic.id, privateDestination.id),
    ).resolves.toMatchObject({ id: unrelatedPublic.id });
  });

  it("moves under a page and appends one visible destination page ref", async () => {
    const { s } = await tmpStore();
    const origin = await s.createPage(null, "Origin");
    const destination = await s.createPage(null, "Destination", {
      markdown: "Destination notes",
    });
    const child = await s.createPage(origin.id, "Child", {
      icon: "🧩",
      markdown: "Child body",
    });

    await s.movePage(child.id, destination.id);

    expect(findPlacement(s.getTree(), child.id)?.parentId).toBe(destination.id);
    await expect(s.readPage(child.id)).resolves.toMatchObject({
      markdown: "Child body",
    });
    const destinationAfter = await s.readPage(destination.id);
    expect(destinationAfter.markdown).toBe(
      `Destination notes\n\n[🧩 Child](/p/${child.id})`,
    );
    expect(
      standalonePageRefOccurrences(destinationAfter.markdown, child.id),
    ).toHaveLength(1);
  });

  it("appends the moved source when the destination references another child", async () => {
    const { s } = await tmpStore();
    const destination = await s.createPage(null, "Destination");
    const existingChild = await s.createPage(destination.id, "Existing child");
    const moving = await s.createPage(null, "Moving", { icon: "🚚" });
    const existingRef = `[Existing child](/p/${existingChild.id})`;
    const before = await s.writePage(destination.id, existingRef);

    await s.movePage(moving.id, destination.id);

    expect(findPlacement(s.getTree(), moving.id)?.parentId).toBe(destination.id);
    const after = await s.readPage(destination.id);
    expect(after.markdown).toBe(
      `${before.markdown}\n\n[🚚 Moving](/p/${moving.id})`,
    );
    expect(
      standalonePageRefOccurrences(after.markdown, existingChild.id),
    ).toHaveLength(1);
    expect(
      standalonePageRefOccurrences(after.markdown, moving.id),
    ).toHaveLength(1);
  });

  it("preserves a destination body byte-for-byte when it already has refs", async () => {
    const { s } = await tmpStore();
    const origin = await s.createPage(null, "Origin");
    const destination = await s.createPage(null, "Destination");
    const child = await s.createPage(origin.id, "Child");
    const existing = `[First](/p/${child.id})\n\n[Second](/p/${child.id})\n`;
    const before = await s.writePage(destination.id, existing);

    await s.movePage(child.id, destination.id);

    const after = await s.readPage(destination.id);
    expect(after.markdown).toBe(existing.trimEnd());
    expect(after.rev).toBe(before.rev);
    expect(
      standalonePageRefOccurrences(after.markdown, child.id),
    ).toHaveLength(2);
  });

  it("leaves bodies alone for a reorder and takes the reference out when the page leaves", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent", {
      markdown: "Parent body",
    });
    const first = await s.createPage(parent.id, "First", {
      markdown: "First body",
    });
    const moving = await s.createPage(parent.id, "Moving", {
      markdown: "Moving body",
    });
    const parentBefore = await s.readPage(parent.id);

    await s.movePage(moving.id, parent.id, first.id);
    await expect(s.readPage(parent.id)).resolves.toMatchObject({
      markdown: parentBefore.markdown,
      rev: parentBefore.rev,
    });
    await expect(s.readPage(moving.id)).resolves.toMatchObject({
      markdown: "Moving body",
    });

    await s.movePage(moving.id, null);
    await expect(s.readPage(parent.id)).resolves.toMatchObject({
      markdown: parentBefore.markdown,
      rev: parentBefore.rev,
    });
    await expect(s.readPage(moving.id)).resolves.toMatchObject({
      markdown: "Moving body",
    });

    await s.movePage(moving.id, parent.id);
    const afterFirstReparent = await s.readPage(parent.id);
    expect(
      standalonePageRefOccurrences(afterFirstReparent.markdown, moving.id),
    ).toHaveLength(1);

    // The line the move wrote stops being true the moment the page leaves, so
    // the same operation takes it back out and the prose around it is exactly
    // where it was before any of this started.
    await s.movePage(moving.id, null);
    const afterLeaving = await s.readPage(parent.id);
    expect(
      standalonePageRefOccurrences(afterLeaving.markdown, moving.id),
    ).toHaveLength(0);
    expect(afterLeaving.markdown).toBe(parentBefore.markdown);

    // Coming back writes one reference, not a second one.
    await s.movePage(moving.id, parent.id);
    const afterReturn = await s.readPage(parent.id);
    expect(
      standalonePageRefOccurrences(afterReturn.markdown, moving.id),
    ).toHaveLength(1);
  });

  it("takes only the structural reference out, never a sentence", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Field Guide");
    const moving = await s.createPage(parent.id, "Tomato Trial Rows");
    const staying = await s.createPage(parent.id, "Other Child");
    const body = [
      "## Beds & Borders",
      `[Tomato Trial Rows](/p/${moving.id})`,
      `[Other Child](/p/${staying.id})`,
      "## Notes",
      `The brief for [Tomato Trial Rows](/p/${moving.id}) was written in March.`,
      "Tail prose stays in place.",
    ].join("\n\n");
    const current = await s.readPage(parent.id);
    await s.writePage(parent.id, body, current.rev);

    const moved = await s.movePageWithBodyReport(moving.id, null);
    expect(moved.unlinkedFrom).toBe(parent.id);

    const after = await s.readPage(parent.id);
    // The standalone line under the heading is gone: it claimed a structure
    // that stopped being true.
    expect(
      standalonePageRefOccurrences(after.markdown, moving.id),
    ).toHaveLength(0);
    // The same page id inside a sentence is prose. The sentence is intact,
    // word for word, and so is everything around it.
    expect(after.markdown).toContain(
      `The brief for [Tomato Trial Rows](/p/${moving.id}) was written in March.`,
    );
    expect(after.markdown).toContain("## Beds & Borders");
    expect(after.markdown).toContain("## Notes");
    expect(after.markdown).toContain("Tail prose stays in place.");
    expect(after.markdown).toContain(`[Other Child](/p/${staying.id})`);
    expect(findPlacement(s.getTree(), moving.id)?.parentId).toBe(null);
  });

  it("takes every standalone reference out, and reports nothing when there was none", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const destination = await s.createPage(null, "Destination");
    const moving = await s.createPage(parent.id, "Moving");
    const listed = [
      "Intro",
      `[Moving](/p/${moving.id})`,
      "## Again",
      `[Moving](/p/${moving.id})`,
      "Outro",
    ].join("\n\n");
    const current = await s.readPage(parent.id);
    await s.writePage(parent.id, listed, current.rev);

    const moved = await s.movePageWithBodyReport(moving.id, destination.id);
    expect(moved.unlinkedFrom).toBe(parent.id);
    expect(
      standalonePageRefOccurrences(
        (await s.readPage(parent.id)).markdown,
        moving.id,
      ),
    ).toHaveLength(0);
    expect((await s.readPage(parent.id)).markdown).toBe("Intro\n\n## Again\n\nOutro");
    // The destination gained the block in the same operation.
    expect(
      standalonePageRefOccurrences(
        (await s.readPage(destination.id)).markdown,
        moving.id,
      ),
    ).toHaveLength(1);

    // Nothing was listed in the destination's own body about a grandchild, so
    // moving that grandchild out reports no document change at all.
    const grandchild = await s.createPage(moving.id, "Grandchild");
    const back = await s.movePageWithBodyReport(grandchild.id, null);
    expect(back.unlinkedFrom).toBe(null);
  });

  it("removes the row the editor numbered, not another with the same text, past a foreign directive", async () => {
    // `:::toggle{title="T"}` came in through MCP write_page. The editor turns
    // it into literal prose and hoists its body, so the `[Source]` inside it
    // is row 0 and the one at the tail is row 1. The Store once parsed the
    // directive as one opaque block, called the tail row 0, and took the
    // tail off the disk when the reader dragged the first row — with a
    // fingerprint from the same wrong list agreeing all the way.
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const source = await s.createPage(parent.id, "Source");
    const target = await s.createPage(parent.id, "Target");
    const row = `[Source](/p/${source.id})`;
    const body = [
      "Intro",
      `:::toggle{title="T"}\n${row}\n:::`,
      `[Target](/p/${target.id})`,
      row,
    ].join("\n\n");
    const current = await s.writePage(parent.id, body);
    expect(standalonePageRefOccurrences(body, source.id)).toEqual([row, row]);

    await s.nestPageRef(source.id, target.id, parent.id, current.rev, 0, row);

    const after = await s.readPage(parent.id);
    expect(after.markdown).toBe(
      [
        "Intro",
        ':::toggle{title="T"}\n:::',
        `[Target](/p/${target.id})`,
        row,
      ].join("\n\n"),
    );
    expect(findPlacement(s.getTree(), source.id)?.parentId).toBe(target.id);
  });

  it("sweeps only exact page rows: a link with a fragment, a query or a slash is prose", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const moving = await s.createPage(parent.id, "Moving");
    const prose = [
      `[Раздел](/p/${moving.id}#section)`,
      `[Поиск](/p/${moving.id}?q=1)`,
      `[Слэш](/p/${moving.id}/)`,
    ];
    const body = ["Intro", `[Moving](/p/${moving.id})`, ...prose, "Tail"].join(
      "\n\n",
    );
    await s.writePage(parent.id, body, (await s.readPage(parent.id)).rev);

    const moved = await s.movePageWithBodyReport(moving.id, null);
    expect(moved.unlinkedFrom).toBe(parent.id);
    expect((await s.readPage(parent.id)).markdown).toBe(
      ["Intro", ...prose, "Tail"].join("\n\n"),
    );
  });

  it("does not add a row to a body that already mentions the page in a sentence", async () => {
    // One rule for "already linked", the derived tail's: a mention anywhere.
    // The tail hides such a child and the editor refuses to file it, so a
    // move adding a second reference left the reader with a row they never
    // wrote and no row to take back.
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const destination = await s.createPage(null, "Destination");
    const moving = await s.createPage(parent.id, "Moving");
    const destinationBody = `See [Moving](/p/${moving.id}) for the brief.`;
    await s.writePage(
      destination.id,
      destinationBody,
      (await s.readPage(destination.id)).rev,
    );
    await s.writePage(
      parent.id,
      `[Moving](/p/${moving.id})`,
      (await s.readPage(parent.id)).rev,
    );

    const moved = await s.movePageWithBodyReport(moving.id, destination.id);
    expect(moved.unlinkedFrom).toBe(parent.id);
    expect((await s.readPage(destination.id)).markdown).toBe(destinationBody);
    expect(findPlacement(s.getTree(), moving.id)?.parentId).toBe(destination.id);
  });

  it("appends the row at the top level, after what the destination left open", async () => {
    const { s } = await tmpStore();
    const fenced = await s.createPage(null, "Fenced", {
      markdown: "Intro\n\n```js\nconst x = 1;",
    });
    const columns = await s.createPage(null, "Columns", {
      markdown: "::::cols\n:::col\n## Left\n\n[Other](/p/other)",
    });
    const first = await s.createPage(null, "First");
    const second = await s.createPage(null, "Second");

    await s.movePage(first.id, fenced.id);
    expect((await s.readPage(fenced.id)).markdown).toBe(
      `Intro\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n[First](/p/${first.id})`,
    );

    await s.movePage(second.id, columns.id);
    expect((await s.readPage(columns.id)).markdown).toBe(
      `::::cols\n:::col\n## Left\n\n[Other](/p/other)\n:::\n::::\n\n[Second](/p/${second.id})`,
    );
  });

  it("stamps both rewritten bodies with who asked for the move", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const destination = await s.createPage(null, "Destination");
    const moving = await s.createPage(parent.id, "Moving");
    const seed = await s.readPage(parent.id);
    await s.writePage(
      parent.id,
      ["Intro", `[Moving](/p/${moving.id})`].join("\n\n"),
      seed.rev,
    );

    // Claude moved it through MCP: the old parent lost a paragraph and the
    // new one gained one, and both say so. The moved page itself is not
    // restamped — its body did not change.
    await s.movePageWithBodyReport(
      moving.id,
      destination.id,
      null,
      undefined,
      "claude",
    );
    expect((await s.readPage(parent.id)).meta.updatedBy).toBe("claude");
    expect((await s.readPage(destination.id)).meta.updatedBy).toBe("claude");
    expect(s.getTree().find((n) => n.id === parent.id)?.updatedBy).toBe(
      "claude",
    );

    // A human's move, the default, stamps the same two bodies with "me".
    await s.movePageWithBodyReport(moving.id, parent.id);
    expect((await s.readPage(parent.id)).meta.updatedBy).toBe("me");
    expect((await s.readPage(destination.id)).meta.updatedBy).toBe("me");
  });

  it("leaves the old parent's document untouched when the move fails", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const destination = await s.createPage(null, "Destination");
    const moving = await s.createPage(parent.id, "Moving");
    const body = ["Intro", `[Moving](/p/${moving.id})`, "Outro"].join("\n\n");
    const seedRev = (await s.readPage(parent.id)).rev;
    await s.writePage(parent.id, body, seedRev);
    const parentBefore = await s.readPage(parent.id);

    const movingDir = s.resolve(moving.id);
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === movingDir) {
        throw new Error("rename refused");
      }
      return realRename(...args);
    });
    try {
      await expect(s.movePage(moving.id, destination.id)).rejects.toThrow(
        "rename refused",
      );
    } finally {
      rename.mockRestore();
    }

    // Both surfaces are exactly as they were: the hierarchy and the document.
    expect(findPlacement(s.getTree(), moving.id)?.parentId).toBe(parent.id);
    await expect(s.readPage(parent.id)).resolves.toMatchObject({
      markdown: parentBefore.markdown,
      rev: parentBefore.rev,
    });
    expect(
      standalonePageRefOccurrences(
        (await s.readPage(destination.id)).markdown,
        moving.id,
      ),
    ).toHaveLength(0);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes the old parent's body after a recoverable write failure", async () => {
    const { s, root } = await tmpStore();
    const parent = await s.createPage(null, "Parent");
    const moving = await s.createPage(parent.id, "Moving");
    const body = ["Intro", `[Moving](/p/${moving.id})`, "Outro"].join("\n\n");
    const seedRev = (await s.readPage(parent.id)).rev;
    await s.writePage(parent.id, body, seedRev);

    const parentIndex = path.join(s.resolve(parent.id), "index.md");
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (
        !injected &&
        path.basename(String(args[0])).startsWith(".tmp-") &&
        String(args[1]) === parentIndex
      ) {
        injected = true;
        throw new Error("origin write failed once");
      }
      return realRename(...args);
    });
    try {
      await expect(s.movePage(moving.id, null)).resolves.toMatchObject({
        id: moving.id,
      });
    } finally {
      rename.mockRestore();
    }

    expect(injected).toBe(true);
    expect(findPlacement(s.getTree(), moving.id)?.parentId).toBe(null);
    expect(
      standalonePageRefOccurrences(
        (await s.readPage(parent.id)).markdown,
        moving.id,
      ),
    ).toHaveLength(0);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes destination body persistence after a recoverable write failure", async () => {
    const { s, root } = await tmpStore();
    const origin = await s.createPage(null, "Origin");
    const destination = await s.createPage(null, "Destination", {
      markdown: "Destination body",
    });
    const child = await s.createPage(origin.id, "Child");
    const destinationIndex = path.join(s.resolve(destination.id), "index.md");
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (
        !injected &&
        path.basename(String(args[0])).startsWith(".tmp-") &&
        String(args[1]) === destinationIndex
      ) {
        injected = true;
        throw new Error("destination write failed once");
      }
      return realRename(...args);
    });
    try {
      await expect(s.movePage(child.id, destination.id)).resolves.toMatchObject({
        id: child.id,
      });
    } finally {
      rename.mockRestore();
    }

    expect(injected).toBe(true);
    expect(findPlacement(s.getTree(), child.id)?.parentId).toBe(destination.id);
    expect(
      standalonePageRefOccurrences(
        (await s.readPage(destination.id)).markdown,
        child.id,
      ),
    ).toHaveLength(1);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves hierarchy unchanged when the directory move rename fails", async () => {
    const { s } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2", { markdown: "P2 body" });
    const child = await s.createPage(p1.id, "Child", { markdown: "safe" });
    const originalDir = s.resolve(child.id);
    const destinationBefore = await s.readPage(p2.id);
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (String(args[0]) === originalDir) throw new Error("move rename failed");
      return realRename(...args);
    });
    try {
      await expect(s.movePage(child.id, p2.id)).rejects.toThrow(
        "move rename failed",
      );
    } finally {
      rename.mockRestore();
    }

    expect(s.resolve(child.id)).toBe(originalDir);
    expect(s.getTree().find((node) => node.id === p1.id)?.children[0]?.id).toBe(
      child.id,
    );
    expect((await s.readPage(child.id)).markdown).toBe("safe");
    await expect(s.readPage(p2.id)).resolves.toMatchObject({
      markdown: destinationBefore.markdown,
      rev: destinationBefore.rev,
    });
  });

  it("reconciles a crash after cross-parent rename on Store restart", async () => {
    const { s, root } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const next = await s.createPage(p2.id, "Next");
    const child = await s.createPage(p1.id, "Child", { markdown: "safe" });
    const originalDir = s.resolve(child.id);
    const restoreReconciliation = blockMoveIntentReconciliation(s);
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!injected && String(args[0]) === originalDir) {
        injected = true;
        await realRename(...args);
        throw new Error("simulated crash after directory rename");
      }
      return realRename(...args);
    });
    try {
      await expect(s.movePage(child.id, p2.id, next.id)).rejects.toThrow(
        "page bodies could not be reconciled",
      );
    } finally {
      rename.mockRestore();
      restoreReconciliation();
    }
    expect(injected).toBe(true);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).resolves.toBeDefined();

    const restarted = new Store(root);
    await restarted.init();
    expect(
      restarted.getTree().find((node) => node.id === p1.id)?.children,
    ).toHaveLength(0);
    expect(
      restarted
        .getTree()
        .find((node) => node.id === p2.id)
        ?.children.map((node) => node.id),
    ).toEqual([child.id, next.id]);
    expect((await restarted.readPage(child.id)).markdown).toBe("safe");
    expect(
      standalonePageRefOccurrences(
        (await restarted.readPage(p2.id)).markdown,
        child.id,
      ),
    ).toHaveLength(1);
    await expect(
      fs.stat(path.join(root, ".brain-move-intent.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for the writer that was active when the stable reader arrived", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Shared");
    const indexPath = path.join(s.resolve(page.id), "index.md");
    const realReadFile = fs.readFile.bind(fs);
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let blocked = false;
    const readFile = vi.spyOn(fs, "readFile").mockImplementation(
      async (...args) => {
        if (!blocked && String(args[0]) === indexPath) {
          blocked = true;
          markReadStarted();
          await readGate;
        }
        return realReadFile(...args);
      },
    );

    try {
      const writing = s.writePage(page.id, "updated");
      await readStarted;
      expect(s.readMutationState().active).toBe(true);

      const waiting = s.waitForMutationIdle(1_000);
      releaseRead();

      await expect(waiting).resolves.toBe(true);
      await expect(writing).resolves.toMatchObject({ markdown: "updated" });
      expect(s.readMutationState().active).toBe(false);
    } finally {
      releaseRead();
      readFile.mockRestore();
    }
  });

  it("rolls a cross-parent move back when order persistence fails", async () => {
    const { s, root } = await tmpStore();
    const p1 = await s.createPage(null, "P1");
    const p2 = await s.createPage(null, "P2");
    const child = await s.createPage(p1.id, "Child", { markdown: "safe" });
    const originalDir = s.resolve(child.id);
    const original = await s.readPage(child.id);
    const targetParentDir = s.resolve(p2.id);
    const realRename = fs.rename.bind(fs);
    let directoryMoved = false;
    let injected = false;
    let rollbackStarted!: () => void;
    const duringRollback = new Promise<void>(
      (resolve) => (rollbackStarted = resolve),
    );
    let releaseRollback!: () => void;
    const rollbackGate = new Promise<void>(
      (resolve) => (releaseRollback = resolve),
    );
    const beforeMutation = s.readMutationState();
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      const from = String(args[0]);
      const to = String(args[1]);
      if (from === originalDir) directoryMoved = true;
      if (
        directoryMoved &&
        !injected &&
        path.basename(from).startsWith(".tmp-") &&
        to.startsWith(targetParentDir + path.sep) &&
        path.basename(to) === "index.md"
      ) {
        injected = true;
        throw new Error("order persist failed");
      }
      if (
        directoryMoved &&
        injected &&
        path.basename(from).startsWith(".tmp-") &&
        to.startsWith(targetParentDir + path.sep) &&
        path.basename(to) === "index.md"
      ) {
        rollbackStarted();
        await rollbackGate;
      }
      return realRename(...args);
    });
    try {
      const moving = s.movePage(child.id, p2.id);
      await duringRollback;
      expect(s.readMutationState()).toMatchObject({
        active: true,
      });
      expect(s.readMutationState().generation).toBeGreaterThan(
        beforeMutation.generation,
      );
      releaseRollback();
      await expect(moving).rejects.toThrow("order persist failed");
    } finally {
      releaseRollback();
      rename.mockRestore();
    }

    expect(injected).toBe(true);
    expect(s.readMutationState()).toMatchObject({ active: false });
    expect(s.readMutationState().generation).toBeGreaterThan(
      beforeMutation.generation,
    );
    expect(s.resolve(child.id)).toBe(originalDir);
    await expect(s.readPage(child.id)).resolves.toMatchObject({
      markdown: "safe",
      meta: { order: original.meta.order },
    });
    expect(s.getTree().find((node) => node.id === p1.id)?.children[0]?.id).toBe(
      child.id,
    );
    const restarted = new Store(root);
    await restarted.init();
    expect(
      restarted.getTree().find((node) => node.id === p1.id)?.children[0]?.id,
    ).toBe(child.id);
  });

  // The Inbox is gone, and with it store.fileInbox. Every mechanism its tests
  // covered — cross-parent filing, the visible destination ref, rollback on a
  // failed persist, crash recovery — is the same movePage machinery, already
  // pinned by the move tests above. What is new is what the removal promises:
  // a note captured now carries no marker, a note captured before it keeps
  // the key its file already holds, and a move intent journalled by the old
  // release still recovers.

  it("writes no inbox marker when a page is captured", async () => {
    const { s } = await tmpStore();
    const note = await s.createPage(null, "Captured thought", {
      id: "quickcapture_abcdefghijklmnopqrstuvwxyz123456",
      quickCaptureFingerprint: "a".repeat(64),
      markdown: "safe",
    });

    const raw = await fs.readFile(
      path.join(s.resolve(note.id), "index.md"),
      "utf8",
    );
    expect(raw).not.toContain("inbox");
    expect(findPlacement(s.getTree(), note.id)?.parentId).toBeNull();
  });

  it("carries a note captured before the Inbox was removed without reading it", async () => {
    const { s, root } = await tmpStore();
    const note = await s.createPage(null, "Legacy capture", { markdown: "safe" });
    const indexPath = path.join(s.resolve(note.id), "index.md");
    // exactly what the old release left on disk
    await fs.writeFile(
      indexPath,
      (await fs.readFile(indexPath, "utf8")).replace(
        "\norder:",
        "\ninbox: true\norder:",
      ),
    );

    const restarted = new Store(root);
    await restarted.init();
    // the tree no longer has anywhere to put it
    expect(restarted.getTree()[0]).not.toHaveProperty("inbox");
    // and a later metadata write leaves the key alone rather than erasing it
    await restarted.updateMeta(note.id, { pinned: true });
    const after = await fs.readFile(indexPath, "utf8");
    expect(after).toContain("inbox: true");
    expect(after).toContain("pinned: true");
    expect((await restarted.readPage(note.id)).markdown).toBe("safe");
  });

  it("reconciles a move intent journalled before clearInbox was removed", async () => {
    const { s, root } = await tmpStore();
    const source = await s.createPage(null, "Source");
    const destination = await s.createPage(null, "Destination");
    const note = await s.createPage(source.id, "Legacy capture", {
      markdown: "safe",
    });
    const originalDir = s.resolve(note.id);
    const restoreReconciliation = blockMoveIntentReconciliation(s);
    const realRename = fs.rename.bind(fs);
    let injected = false;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (!injected && String(args[0]) === originalDir) {
        injected = true;
        await realRename(...args);
        throw new Error("simulated crash after directory rename");
      }
      return realRename(...args);
    });
    try {
      await expect(s.movePage(note.id, destination.id)).rejects.toThrow(
        "page bodies could not be reconciled",
      );
    } finally {
      rename.mockRestore();
      restoreReconciliation();
    }
    expect(injected).toBe(true);

    // age the journal back to the old format: the field the old release wrote
    const intentPath = path.join(root, ".brain-move-intent.json");
    const intent = JSON.parse(await fs.readFile(intentPath, "utf8"));
    await fs.writeFile(
      intentPath,
      JSON.stringify({ ...intent, clearInbox: true }),
    );

    // recovery must accept the unknown key, not fail the whole Store open
    const restarted = new Store(root);
    await restarted.init();
    expect(findPlacement(restarted.getTree(), note.id)?.parentId).toBe(
      destination.id,
    );
    expect((await restarted.readPage(note.id)).markdown).toBe("safe");
    await expect(fs.stat(intentPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a read that lands between rename and index update", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A");
    const b = await s.createPage(null, "B");
    const child = await s.createPage(a.id, "Child", { markdown: "safe" });
    const realRename = fs.rename.bind(fs);
    let renamed!: () => void;
    const afterRename = new Promise<void>((resolve) => (renamed = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await realRename(from, to);
      renamed();
      await gate;
    });

    try {
      const moving = s.movePage(child.id, b.id);
      await afterRename;
      const reading = s.readPage(child.id);
      release();
      await moving;
      await expect(reading).resolves.toMatchObject({ markdown: "safe" });
    } finally {
      rename.mockRestore();
      release();
    }
  });

  it("does not spin forever when creating a directory fails for another reason", async () => {
    const { s } = await tmpStore();
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValueOnce(denied);
    try {
      await expect(s.createPage(null, "Nope")).rejects.toBe(denied);
    } finally {
      mkdir.mockRestore();
    }
  });

  it("fails initialization when the notes tree cannot be read", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-denied-"));
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(denied);
    try {
      await expect(new Store(root).init()).rejects.toBe(denied);
    } finally {
      readdir.mockRestore();
    }
  });

  it("does not treat an unreadable index.md as a transparent folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-denied-index-"));
    await writePageFixture(root, "page", "valid-id");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const readFile = vi.spyOn(fs, "readFile").mockRejectedValueOnce(denied);
    try {
      await expect(new Store(root).init()).rejects.toBe(denied);
    } finally {
      readFile.mockRestore();
    }
  });

  it("fails initialization on duplicate page ids and reports both paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-duplicate-"));
    const first = await writePageFixture(root, "first", "duplicate-id");
    const second = await writePageFixture(root, "second", "duplicate-id");

    let message = "";
    try {
      await new Store(root).init();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('duplicate page id "duplicate-id"');
    expect(message).toContain(first);
    expect(message).toContain(second);
  });

  it.each([
    ["a non-string id", "123"],
    ["an id outside the canonical alphabet", "bad.id"],
  ])("fails initialization on %s", async (_label, idYaml) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-invalid-id-"));
    const indexPath = await writePageFixture(root, "invalid", idYaml);

    await expect(new Store(root).init()).rejects.toThrow(
      `invalid page id in ${indexPath}`,
    );
  });

  it("keeps history and version reads after moving a page", async () => {
    const { s, root } = await tmpStore();
    await git(root, "init", "-q");
    const page = await s.createPage(null, "Moving", { markdown: "before" });
    const beforeSha = await commitAll(root, "before move");
    const parent = await s.createPage(null, "Parent");
    await s.movePage(page.id, parent.id);
    await s.writePage(page.id, "after");
    await commitAll(root, "move page");

    const versions = await s.history(page.id);
    expect(versions.map((version) => version.sha)).toContain(beforeSha);
    await expect(s.markdownAt(page.id, beforeSha)).resolves.toBe("before");
  });

  it("resolves an exact old rev to the id-bound historical body", async () => {
    const { s, root } = await tmpStore();
    await git(root, "init", "-q");
    const page = await s.createPage(null, "Historical base", {
      markdown: "body before metadata",
    });
    const stale = await s.readPage(page.id);
    await commitAll(root, "historical base");

    await s.updateMeta(page.id, { title: "Metadata changed", icon: "🧠" });

    await expect(
      s.historicalMarkdownForRev(page.id, stale.rev),
    ).resolves.toBe("body before metadata");
  });

  it("fails closed for malformed or uncommitted revision tokens", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "No Git history", {
      markdown: "uncommitted body",
    });
    const current = await s.readPage(page.id);

    for (const revision of [
      "",
      "a".repeat(11),
      "a".repeat(13),
      "A".repeat(12),
      "g".repeat(12),
    ]) {
      await expect(
        s.historicalMarkdownForRev(page.id, revision),
      ).resolves.toBeNull();
    }
    await expect(
      s.historicalMarkdownForRev(page.id, current.rev),
    ).resolves.toBeNull();
  });

  it("refuses to restore history over a concurrently changed page", async () => {
    const { s, root } = await tmpStore();
    await git(root, "init", "-q");
    const page = await s.createPage(null, "Restore conflict", {
      markdown: "historical body",
    });
    const historicalSha = await commitAll(root, "historical body");
    const staleRevision = (await s.readPage(page.id)).rev;

    await s.writePage(page.id, "external edit", staleRevision);

    await expect(
      s.restoreVersion(page.id, historicalSha, staleRevision),
    ).rejects.toBeInstanceOf(RevConflictError);
    await expect(s.readPage(page.id)).resolves.toMatchObject({
      markdown: "external edit",
    });
  });

  it("binds historical reads to page id when a current path was reused", async () => {
    const { s, root } = await tmpStore();
    await git(root, "init", "-q");
    const originalParent = await s.createPage(null, "Original parent");
    const pageA = await s.createPage(originalParent.id, "Same slug", {
      markdown: "body A",
    });
    const pageB = await s.createPage(null, "Same slug", {
      markdown: "body B",
    });
    const pageARevision = (await s.readPage(pageA.id)).rev;
    const pageBRevision = (await s.readPage(pageB.id)).rev;
    const destination = await s.createPage(null, "Destination");
    const beforeMoves = await commitAll(root, "before path reuse");

    await s.movePage(pageB.id, destination.id);
    await s.movePage(pageA.id, null);
    await commitAll(root, "reuse old path");

    await expect(s.markdownAt(pageA.id, beforeMoves)).resolves.toBe("body A");
    await expect(
      s.historicalMarkdownForRev(pageA.id, pageARevision),
    ).resolves.toBe("body A");
    // The current path contained page B at this commit. Its raw revision must
    // never be accepted as page A's recovery baseline.
    await expect(
      s.historicalMarkdownForRev(pageA.id, pageBRevision),
    ).resolves.toBeNull();
  });

  it("refuses to move a page into its own descendant", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A");
    const b = await s.createPage(a.id, "B");
    await expect(s.movePage(a.id, b.id)).rejects.toThrow();
  });

  it("deletes a page and its subtree", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A");
    await s.createPage(a.id, "B");
    await s.deletePage(a.id);
    expect(s.getTree()).toHaveLength(0);
  });

  it("rejects a new child under a soft-deleted parent as not found", async () => {
    const { s } = await tmpStore();
    const parent = await s.createPage(null, "Deleted parent");
    await s.deletePage(parent.id);

    await expect(
      s.createPage(parent.id, "Invisible child"),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    expect(s.getTree()).toHaveLength(0);
    expect(s.trashList()).toEqual([
      expect.objectContaining({ id: parent.id }),
    ]);
  });

  it("collects unreferenced attachments after a purge and keeps everything referenced", async () => {
    const { s, root } = await tmpStore();
    const attachmentsDir = path.join(root, "_attachments");
    const save = (name: string, body: string) =>
      s.saveAttachment({
        data: new TextEncoder().encode(body),
        originalName: name,
        mimeType: "text/plain",
      });
    const age = async (url: string) => {
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await fs.utimes(
        path.join(attachmentsDir, url.slice("/_attachments-v2/".length)),
        old,
        old,
      );
    };
    const fileFor = (url: string) =>
      path.join(attachmentsDir, url.slice("/_attachments-v2/".length));

    const doomed = await s.createPage(null, "Doomed");
    const keeper = await s.createPage(null, "Keeper");
    const trashed = await s.createPage(null, "Trashed but restorable");

    const onlyDoomed = await save("only-doomed.txt", "a");
    const shared = await save("shared.txt", "b");
    const inTrash = await save("in-trash.txt", "c");
    const orphan = await save("orphan.txt", "d");
    const freshOrphan = await save("fresh-orphan.txt", "e");
    const cover = await save("cover.txt", "f");

    await s.writePage(doomed.id, `![a](${onlyDoomed.url})\n\n![b](${shared.url})`);
    await s.writePage(keeper.id, `![b](${shared.url})`);
    await s.updateMeta(keeper.id, { cover: cover.url });
    await s.writePage(trashed.id, `![c](${inTrash.url})`);
    await s.deletePage(trashed.id);

    for (const saved of [onlyDoomed, shared, inTrash, orphan, cover]) {
      await age(saved.url);
    }

    await s.deletePage(doomed.id);
    await s.purgePage(doomed.id);

    // gone: the purged page's private file and the aged orphan
    await expect(fs.access(fileFor(onlyDoomed.url))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(fileFor(orphan.url))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // kept: still referenced by a live page, a cover, a trashed-but-restorable
    // page, and a fresh upload inside the grace window
    await expect(fs.access(fileFor(shared.url))).resolves.toBeUndefined();
    await expect(fs.access(fileFor(cover.url))).resolves.toBeUndefined();
    await expect(fs.access(fileFor(inTrash.url))).resolves.toBeUndefined();
    await expect(fs.access(fileFor(freshOrphan.url))).resolves.toBeUndefined();

    // restoring the trashed page still renders its attachment
    await s.restorePage(trashed.id);
    await expect(s.readPage(trashed.id)).resolves.toMatchObject({
      markdown: expect.stringContaining(inTrash.url),
    });
  });

  it("refuses to permanently purge a page that was restored", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Restore before purge");
    await s.deletePage(page.id);
    await s.restorePage(page.id);

    await expect(s.purgePage(page.id)).rejects.toThrow(
      "cannot purge active page",
    );
    await expect(s.readPage(page.id)).resolves.toMatchObject({
      meta: { id: page.id },
    });
  });

  it("restores a page whose ancestor is also in the trash, together with the chain", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A");
    const b = await s.createPage(a.id, "B");
    const c = await s.createPage(b.id, "C");
    await s.deletePage(c.id);
    await s.deletePage(a.id);

    // C sits inside A's trashed subtree — it is not separately restorable,
    // so it must not be listed as its own trash root.
    expect(s.trashList().map((item) => item.id)).toEqual([a.id]);

    await s.restorePage(c.id);

    // The old implementation cleared only C's flag: restore reported success,
    // C stayed invisible under deleted A, and Empty Trash then destroyed it.
    expect(s.isDeleted(a.id)).toBe(false);
    expect(s.isDeleted(b.id)).toBe(false);
    expect(s.isDeleted(c.id)).toBe(false);
    expect(s.trashList()).toEqual([]);

    await s.emptyTrash();
    await expect(s.readPage(c.id)).resolves.toMatchObject({
      meta: { id: c.id },
    });
    const ids = new Set<string>();
    const walk = (nodes: ReturnType<typeof s.getTree>) => {
      for (const node of nodes) {
        ids.add(node.id);
        walk(node.children);
      }
    };
    walk(s.getTree());
    expect(ids.has(a.id) && ids.has(b.id) && ids.has(c.id)).toBe(true);
  });

  it("surfaces a nested trash root once the outer subtree is restored", async () => {
    const { s } = await tmpStore();
    const a = await s.createPage(null, "A");
    const b = await s.createPage(a.id, "B");
    const c = await s.createPage(b.id, "C");
    await s.deletePage(c.id);
    await s.deletePage(a.id);

    // Restoring the outer root does not resurrect the separately deleted C —
    // its own flag survives and it becomes an independently restorable root.
    await s.restorePage(a.id);
    expect(s.isDeleted(a.id)).toBe(false);
    expect(s.isDeleted(b.id)).toBe(false);
    expect(s.isDeleted(c.id)).toBe(true);
    expect(s.trashList().map((item) => item.id)).toEqual([c.id]);

    await s.restorePage(c.id);
    expect(s.isDeleted(c.id)).toBe(false);
    expect(s.trashList()).toEqual([]);
  });

  it("does not let emptyTrash purge a concurrently restored page", async () => {
    const { s } = await tmpStore();
    const page = await s.createPage(null, "Restore wins");
    await s.deletePage(page.id);

    // Queue restore first, then emptyTrash in the same tick. The old composite
    // implementation captured a stale trashList before restore acquired the
    // mutation lock, then purged the now-active page after restore succeeded.
    const restoring = s.restorePage(page.id);
    const emptying = s.emptyTrash();
    await Promise.all([restoring, emptying]);

    const restored = await s.readPage(page.id);
    expect(restored.meta.id).toBe(page.id);
    expect(restored.meta.deleted).toBeUndefined();
    expect(s.getTree().map((node) => node.id)).toContain(page.id);
  });

  it("keeps foreign frontmatter keys through rebuild and metadata saves", async () => {
    const { s, root } = await tmpStore();
    const page = await s.createPage(null, "Handmade");
    // hand-edit the file the way an external tool would: add keys Brain
    // does not manage
    const files = await fs.readdir(root, { withFileTypes: true });
    const pageDir = files.find((f) => f.isDirectory() && f.name !== "_attachments");
    if (!pageDir) throw new Error("page folder missing");
    const file = path.join(root, pageDir.name, "index.md");
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(
      file,
      raw.replace(
        /^---\n/,
        "---\naliases:\n  - handmade-note\ncustomRank: 7\n",
      ),
    );
    await s.rebuild();

    // a metadata save used to rebuild the frontmatter from an allowlist and
    // erase both keys — they must survive verbatim
    await s.updateMeta(page.id, { title: "Handmade renamed" });
    const after = await fs.readFile(file, "utf8");
    expect(after).toContain("aliases:");
    expect(after).toContain("handmade-note");
    expect(after).toContain("customRank: 7");
    expect(after).toContain("title: Handmade renamed");
  });

  it("self-heals a hand-created folder on rebuild", async () => {
    const { s, root } = await tmpStore();
    await fs.mkdir(path.join(root, "manual"));
    await fs.writeFile(
      path.join(root, "manual", "index.md"),
      "just a body, no frontmatter\n",
    );
    await s.rebuild();
    expect(s.getTree().some((n) => n.title === "Manual")).toBe(true);
    const raw = await fs.readFile(path.join(root, "manual", "index.md"), "utf8");
    expect(raw).toMatch(/^id:/m);
  });

  it("survives a full reload from disk", async () => {
    const { root } = await tmpStore();
    const s1 = new Store(root);
    await s1.init();
    const a = await s1.createPage(null, "Persisted", { markdown: "body" });
    await s1.createPage(a.id, "Kid");
    const s2 = new Store(root); // fresh instance, same dir
    await s2.init();
    const tree = s2.getTree();
    expect(tree[0].title).toBe("Persisted");
    expect(tree[0].children[0].title).toBe("Kid");
    expect((await s2.readPage(a.id)).markdown).toBe("body");
  });
});

describe("order comparison (ASCII, not locale)", () => {
  it("keeps a page moved before the first sibling at the top", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-"));
    const s = new Store(root);
    await s.init();
    const a = await s.createPage(null, "A");
    await s.createPage(null, "B");
    const c = await s.createPage(null, "C");
    await s.movePage(c.id, null, a.id); // C before A -> key like 'Zz' (uppercase)
    expect(s.getTree().map((n) => n.title)).toEqual(["C", "A", "B"]);
  });
});

describe("move a page with children", () => {
  it("keeps descendant paths valid after reparenting a subtree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-"));
    const s = new Store(root);
    await s.init();
    const a = await s.createPage(null, "A");
    const child = await s.createPage(a.id, "Child");
    const grand = await s.createPage(child.id, "Grand");
    const b = await s.createPage(null, "B");
    await s.movePage(a.id, b.id); // A (with Child/Grand) under B
    expect((await s.readPage(grand.id)).meta.title).toBe("Grand");
    const tree = s.getTree();
    const bNode = tree.find((n) => n.title === "B")!;
    const aNode = bNode.children.find((c) => c.title === "A")!;
    expect(aNode.children[0].title).toBe("Child");
    expect(aNode.children[0].children[0].title).toBe("Grand");
  });
});
