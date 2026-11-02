import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store";
import { commitSnapshot, headCommit, showAttachmentAtRevision } from "./git";
import { RevConflictError } from "./types";

let root: string;
let store: Store;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-history-attachments-"));
  store = new Store(root);
  await store.init();
  await store.whenChildLinksBackfilled();
});

afterEach(async () => {
  await commitSnapshot(root, "test cleanup").catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

async function attachmentHistory() {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x80, 0x00]);
  const saved = await store.saveAttachment({ data: bytes, originalName: "picture.png", mimeType: "image/png" });
  const name = saved.url.split("/").at(-1)!;
  const file = path.join(root, "_attachments", name);
  const legacyName = "legacy-upload-123456.txt";
  await fs.writeFile(path.join(root, "_attachments", legacyName), "old upload bytes");
  const body = `![Picture](${saved.url}?download=1#preview)\n\n[Old](/_attachments/${legacyName})`;
  const page = await store.createPage(null, "History", { markdown: body });
  await commitSnapshot(root, "with attachments");
  const sha = (await headCommit(root))!.hash;
  await store.writePage(page.id, "Current body");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(file, old, old);
  await fs.utimes(path.join(root, "_attachments", legacyName), old, old);
  const trash = await store.createPage(null, "Trash");
  await store.deletePage(trash.id);
  await store.purgePage(trash.id);
  expect(await fs.stat(file).then(() => true, () => false)).toBe(false);
  return { page, sha, body, file, bytes, legacyName };
}

describe("history restores the files its Markdown refers to", () => {
  it("restores binary and legacy-named uploads after GC, including a moved page", async () => {
    const h = await attachmentHistory();
    const parent = await store.createPage(null, "New parent");
    await store.movePage(h.page.id, parent.id);
    await store.restoreVersion(h.page.id, h.sha, (await store.readPage(h.page.id)).rev);
    expect((await store.readPage(h.page.id)).markdown).toBe(h.body);
    expect(new Uint8Array(await fs.readFile(h.file))).toEqual(h.bytes);
    expect(await fs.readFile(path.join(root, "_attachments", h.legacyName), "utf8")).toBe("old upload bytes");
  });

  it("refuses a stale revision before restoring any file", async () => {
    const h = await attachmentHistory();
    const stale = (await store.readPage(h.page.id)).rev;
    await store.writePage(h.page.id, "Newer text", stale);
    await expect(store.restoreVersion(h.page.id, h.sha, stale)).rejects.toBeInstanceOf(RevConflictError);
    expect((await store.readPage(h.page.id)).markdown).toBe("Newer text");
    expect(await fs.stat(h.file).then(() => true, () => false)).toBe(false);
  });

  it("refuses historical symlinks, invalid names and oversized binary reads", async () => {
    const h = await attachmentHistory();
    const name = path.basename(h.file);
    await expect(showAttachmentAtRevision(root, h.sha, name, h.bytes.byteLength - 1)).resolves.toBeNull();
    await expect(showAttachmentAtRevision(root, h.sha, "../index.md", 100)).resolves.toBeNull();
    await expect(showAttachmentAtRevision(root, "HEAD", name, 100)).resolves.toBeNull();
    const linkName = "legacy-symlink-123.txt";
    await fs.symlink("../history/index.md", path.join(root, "_attachments", linkName));
    await commitSnapshot(root, "historical symlink");
    const sha = (await headCommit(root))!.hash;
    await expect(showAttachmentAtRevision(root, sha, linkName, 1000)).resolves.toBeNull();
  });

  it("does not replace the current body when the historical file is unavailable", async () => {
    const page = await store.createPage(null, "Broken old link", { markdown: "[Missing](/_attachments-v2/missing-file.txt)" });
    await commitSnapshot(root, "broken historical link");
    const sha = (await headCommit(root))!.hash;
    const current = await store.writePage(page.id, "Current text");
    await expect(store.restoreVersion(page.id, sha, current.rev)).rejects.toThrow();
    expect((await store.readPage(page.id)).markdown).toBe("Current text");
  });

  it("refuses a symlinked attachment directory without writing outside the root", async () => {
    const h = await attachmentHistory();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "brain-history-outside-"));
    try {
      await fs.rm(path.join(root, "_attachments"), { recursive: true });
      await fs.symlink(outside, path.join(root, "_attachments"));
      await expect(store.restoreVersion(h.page.id, h.sha, (await store.readPage(h.page.id)).rev)).rejects.toThrow();
      expect(await fs.readdir(outside)).toEqual([]);
      expect((await store.readPage(h.page.id)).markdown).toBe("Current body");
    } finally {
      await fs.rm(path.join(root, "_attachments"));
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
