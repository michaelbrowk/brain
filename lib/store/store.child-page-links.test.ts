import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store";
import { beginGitSnapshotBarrier, commitSnapshot } from "./git";
import { brainEvents } from "./events";
import { RevConflictError } from "./types";
import { standalonePageRefOccurrences } from "../page-ref-nesting";
import { canonicalizeNotionImportTarget, notionConversionHash } from "../notion/protocol";

const exec = promisify(execFile);
let root: string;
let state: string;
let store: Store;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-child-links-"));
  state = await fs.mkdtemp(path.join(os.tmpdir(), "brain-child-links-state-"));
  store = new Store(root, { childLinksStateDirectory: state });
  await store.init();
});
afterEach(async () => {
  const release = await beginGitSnapshotBarrier(root);
  await commitSnapshot(root, "test cleanup");
  release();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(state, { recursive: true, force: true });
});
const body = async (id: string) => (await store.readPage(id)).markdown;
const refs = async (parent: string, child: string) =>
  standalonePageRefOccurrences(await body(parent), child);

describe("child page links", () => {
  it("creates a normal attributed parent save and refuses an old editor revision", async () => {
    const parent = await store.createPage(null, "Parent", { markdown: "Intro" });
    const before = await store.readPage(parent.id);
    const writes: unknown[] = [];
    const listener = (event: { type: string }) => {
      if (event.type === "write") writes.push(event);
    };
    brainEvents.on("change", listener);
    try {
      const child = await store.createPage(parent.id, "A [draft]", {
        icon: "📄", by: "claude", src: "initiating-tab",
      });
      expect(await body(parent.id)).toBe(`Intro\n\n[📄 A \\[draft\\]](/p/${child.id})`);
      const after = await store.readPage(parent.id);
      expect(after.meta.updatedBy).toBe("claude");
      expect(writes).toEqual([expect.objectContaining({ id: parent.id, rev: after.rev, src: undefined })]);
      await expect(store.writePage(parent.id, "stale", before.rev)).rejects.toBeInstanceOf(RevConflictError);
      const copy = await store.duplicatePage(child.id);
      expect(await refs(parent.id, copy.id)).toHaveLength(1);
    } finally {
      brainEvents.off("change", listener);
    }
  });

  it("moves all standalone rows, preserves prose and does nothing to bodies on reorder", async () => {
    const old = await store.createPage(null, "Old");
    const next = await store.createPage(null, "Next");
    const child = await store.createPage(old.id, "Child");
    const prose = `Mention [Child](/p/${child.id}) here.\n\n\`[Child](/p/${child.id})\``;
    await store.writePage(old.id, `[one](/p/${child.id})\n\n${prose}\n\n[two](/p/${child.id})`);
    await store.movePage(child.id, next.id, null, "tab", "claude");
    expect(await body(old.id)).toBe(prose);
    expect(await refs(next.id, child.id)).toHaveLength(1);
    const before = await store.readPage(next.id);
    await store.movePage(child.id, next.id);
    expect(await store.readPage(next.id)).toEqual(before);
    await store.movePage(child.id, null);
    expect(await body(next.id)).toBe("");
  });

  it("never duplicates an inline mention on move, restore or reconciliation", async () => {
    const parent = await store.createPage(null, "Parent");
    const child = await store.createPage(null, "Child");
    const mention = `See [Child](/p/${child.id}) here.`;
    await store.writePage(parent.id, mention);
    await store.movePage(child.id, parent.id);
    await store.deletePage(child.id, undefined, "claude");
    expect(await body(parent.id)).toBe(mention);
    await store.restorePage(child.id);
    await store.fileChildPages([parent.id]);
    expect(await body(parent.id)).toBe(mention);
  });

  it("trashes and restores once, including a restored deleted ancestor", async () => {
    const grand = await store.createPage(null, "Grand");
    const parent = await store.createPage(grand.id, "Parent");
    const child = await store.createPage(parent.id, "Child");
    await store.deletePage(parent.id, "tab", "claude");
    expect(await body(grand.id)).toBe("");
    expect((await store.readPage(grand.id)).meta.updatedBy).toBe("claude");
    expect(await refs(parent.id, child.id)).toHaveLength(1);
    await store.restorePage(child.id);
    await store.restorePage(child.id);
    expect(await refs(grand.id, parent.id)).toHaveLength(1);
    expect(await refs(parent.id, child.id)).toHaveLength(1);
  });

  it("files legacy restored descendants once per parent and leaves unrelated siblings alone", async () => {
    const outside = await store.createPage(null, "Outside");
    const unrelated = await store.createPage(outside.id, "Unlinked sibling");
    const parent = await store.createPage(outside.id, "Restored");
    const child = await store.createPage(parent.id, "Child");
    const grandchild = await store.createPage(child.id, "Grandchild");
    await store.writePage(outside.id, "Outside prose");
    await store.writePage(parent.id, "Parent prose");
    await store.writePage(child.id, "Child prose");
    await store.deletePage(parent.id);
    const written: string[] = [];
    const listener = (event: { type: string; id: string }) => {
      if (event.type === "write") written.push(event.id);
    };
    brainEvents.on("change", listener);
    try {
      await store.restorePage(parent.id);
    } finally {
      brainEvents.off("change", listener);
    }
    expect(written.sort()).toEqual([outside.id, parent.id, child.id].sort());
    expect(await refs(outside.id, unrelated.id)).toHaveLength(0);
    expect(await refs(outside.id, parent.id)).toHaveLength(1);
    expect(await refs(parent.id, child.id)).toHaveLength(1);
    expect(await refs(child.id, grandchild.id)).toHaveLength(1);
  });

  it("excludes board, collection, collection-row and app parents on every lifecycle edit", async () => {
    const definition = {
      version: 1, source: "notion", databaseId: "1".repeat(32), dataSourceId: "2".repeat(32),
      titlePropertyId: "title", properties: [{ id: "title", name: "Name", type: "title", position: 0 }],
      views: [{ id: "all", type: "table", rowNotionIds: [] }], initialViewId: "all",
    };
    const collection = await store.createPage(null, "Collection", { markdown: "Keep" });
    const row = await store.createPage(collection.id, "Row", { markdown: "Keep" });
    await store.writePage(collection.id, "Keep");
    await store.applyPortableCollectionMeta(collection.id, definition);
    await store.applyPortableCollectionMeta(row.id, undefined, {
      version: 1, source: "notion", databaseId: "1".repeat(32), values: { title: { type: "title", value: "Row" } },
    });
    const board = await store.createPage(null, "Board", { markdown: "Keep" });
    await store.updateMeta(board.id, { view: "board" });
    const app = await store.createAppPage(null, "App", {
      description: "Keep", entryHtml: "<html><body>App</body></html>", builtBy: "test",
    });
    for (const parent of [row, board, app.meta]) {
      const child = await store.createPage(parent.id, "Child");
      expect(await body(parent.id)).toBe("Keep");
      const excludedBody = `Keep\n\n[Manual link](/p/${child.id})`;
      await store.writePage(parent.id, excludedBody);
      await store.deletePage(child.id);
      await store.restorePage(child.id);
      await store.movePage(child.id, null);
      await store.movePage(child.id, parent.id);
      expect(await body(parent.id)).toBe(excludedBody);
    }
    await store.deletePage(row.id);
    await store.restorePage(row.id);
    expect(await body(collection.id)).toBe("Keep");
  });

  it("files visitor-created children with visitor attribution", async () => {
    store = new Store(root, { childLinksStateDirectory: state, publicOrigin: "https://brain.test" });
    await store.init();
    const parent = await store.createPage(null, "Shared");
    await store.configureShare(parent.id, { enabled: true, canEdit: true, expectedScopeToken: (await store.readShareScope(parent.id)).scopeToken });
    const shareVersion = (await store.readShareScope(parent.id)).shareVersion;
    const child = await store.createSharedSubpage({ rootId: parent.id, parentId: parent.id, shareVersion, title: "Visitor child", visitorName: "Sam", src: "visitor-session" });
    expect(await refs(parent.id, child.id)).toHaveLength(1);
    expect((await store.readPage(parent.id)).meta).toMatchObject({ updatedBy: "visitor", updatedByName: "Sam" });
  });

  it("files finalized Notion children and preserves an intact parent import baseline", async () => {
    const finalize = async (notionId: string, parentId: string | null, title: string, markdown: string, sourceHash = "a".repeat(64)) => {
      const reservationToken = `child_links_test_${notionId}`;
      const reserved = await store.reserveNotionImport({ notionId, sourceHash, parentId, beforeId: null, title, reservationToken });
      if (reserved.status !== "reserved") throw new Error("expected reservation");
      const input = { notionId, sourceHash, reservationToken, title, markdown, conversionHash: notionConversionHash(canonicalizeNotionImportTarget({ sourceHash, parentId, beforeId: null, title, markdown })) };
      await store.finalizeNotionImport(input);
      return { id: reserved.page.id, input };
    };
    const destination = await store.createPage(null, "Destination");
    const parent = await finalize("1".repeat(32), null, "Imported parent", "Intro");
    const child = await finalize("2".repeat(32), parent.id, "Imported child", "Child body");
    expect(await refs(parent.id, child.id)).toHaveLength(1);
    await expect(store.finalizeNotionImport(parent.input)).resolves.toMatchObject({ status: "unchanged" });
    await expect(store.finalizeNotionImport(child.input)).resolves.toMatchObject({ status: "unchanged" });
    expect(await refs(parent.id, child.id)).toHaveLength(1);
    const moved = await finalize("2".repeat(32), destination.id, "Imported child", "Child body", "b".repeat(64));
    expect(moved.id).toBe(child.id);
    expect(await refs(parent.id, child.id)).toHaveLength(0);
    expect(await refs(destination.id, child.id)).toHaveLength(1);
    await expect(store.finalizeNotionImport(parent.input)).resolves.toMatchObject({ status: "unchanged" });
  });

  it("files an aborted import placeholder when it becomes an ordinary child, including receipt replay", async () => {
    const parent = await store.createPage(null, "Parent", { markdown: "Intro" });
    const input = { notionId: "3".repeat(32), sourceHash: "a".repeat(64), reservationToken: "child_links_abort_token_0001" };
    const reserved = await store.reserveNotionImport({ ...input, parentId: parent.id, beforeId: null, title: "Kept draft" });
    expect(await body(parent.id)).toBe("Intro");
    await expect(store.abortNotionImport(input)).resolves.toMatchObject({ status: "detached" });
    expect(await refs(parent.id, reserved.page.id)).toHaveLength(1);
    await store.abortNotionImport(input);
    expect(await refs(parent.id, reserved.page.id)).toHaveLength(1);
    expect((await store.readPage(parent.id)).meta.updatedBy).toBe("claude");
  });

  it("refuses an unappendable body before creating a child", async () => {
    const parent = await store.createPage(null, "Parent", { markdown: "<!-- unclosed" });
    await expect(store.createPage(parent.id, "Child")).rejects.toThrow("cannot be appended");
    expect(store.getTree()[0].children).toHaveLength(0);
    expect(await fs.readdir(path.join(root, "parent"))).toEqual(["index.md"]);
  });

  it("marks a fresh notebook without creating a notes repository or rerunning", async () => {
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(state)).toHaveLength(1);
    await store.init();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("links an app under an ordinary parent but never writes owned child links into the app", async () => {
    const parent = await store.createPage(null, "Parent");
    const app = await store.createAppPage(parent.id, "App", {
      description: "Description", entryHtml: "<!doctype html><html><body>App</body></html>",
      builtBy: "test", owns: [{ title: "Data" }],
    });
    expect(await refs(parent.id, app.meta.id)).toHaveLength(1);
    expect(await body(app.meta.id)).toBe("Description");
  });

  it("retries a failed migration commit without losing its named single snapshot", async () => {
    const parent = await store.createPage(null, "Parent");
    const child = await store.createPage(parent.id, "Child");
    await store.writePage(parent.id, "Intro");
    const release = await beginGitSnapshotBarrier(root);
    await commitSnapshot(root, "before");
    release();
    await fs.rm(state, { recursive: true, force: true });
    const hook = path.join(root, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    try {
      store = new Store(root, { childLinksStateDirectory: state });
      await expect(store.init()).rejects.toThrow("git commit failed");
      const marker = path.join(state, (await fs.readdir(state))[0]);
      expect(JSON.parse(await fs.readFile(marker, "utf8")).complete).toBe(false);
    } finally {
      await fs.rm(hook);
    }
    store = new Store(root, { childLinksStateDirectory: state });
    await store.init();
    expect(await refs(parent.id, child.id)).toHaveLength(1);
    expect((await exec("git", ["log", "--format=%s"], { cwd: root })).stdout.trim().split("\n"))
      .toEqual(["migrate: file child pages in their parents", "before"]);
  });

  it("backfills once in tree order, one git commit, and leaves exclusions alone", async () => {
    const parent = await store.createPage(null, "Parent", { markdown: "Intro" });
    const one = await store.createPage(parent.id, "One");
    const two = await store.createPage(parent.id, "Two");
    await store.movePage(two.id, parent.id, one.id);
    const board = await store.createPage(null, "Board", { markdown: "Board body" });
    await store.updateMeta(board.id, { view: "board" });
    await store.createPage(board.id, "Card");
    await store.writePage(parent.id, "Intro");
    await exec("git", ["init", "-q"], { cwd: root });
    await exec("git", ["add", "."], { cwd: root });
    await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "before"], { cwd: root });
    await fs.rm(state, { recursive: true, force: true });
    store = new Store(root, { childLinksStateDirectory: state });
    await store.init();
    expect(await body(parent.id)).toBe(`Intro\n\n[📄 Two](/p/${two.id})\n\n[📄 One](/p/${one.id})`);
    expect(await body(board.id)).toBe("Board body");
    const log = (await exec("git", ["log", "--format=%s"], { cwd: root })).stdout.trim().split("\n");
    expect(log).toEqual(["migrate: file child pages in their parents", "before"]);
    await store.writePage(parent.id, "Deliberately removed");
    store = new Store(root, { childLinksStateDirectory: state });
    await store.init();
    expect(await body(parent.id)).toBe("Deliberately removed");
    expect((await fs.readdir(state)).filter((name) => name.startsWith("child-page-links-v1-"))).toHaveLength(1);
  });
});
