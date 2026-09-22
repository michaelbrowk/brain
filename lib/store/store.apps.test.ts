import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ENTRY_MAX_BYTES, APP_ENTRY_PATH, APP_STATE_MAX_BYTES } from "../apps/model";
import { Store } from "./store";
import { isAppSize } from "./types";

let root: string;
let store: Store;

const ENTRY = '<!doctype html><meta name="color-scheme" content="light dark"><p>hi</p>';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-apps-store-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("app pages in the store", () => {
  it("creates the page, its files and the children it owns", async () => {
    const spanish = await store.createPage(null, "Spanish");
    const { meta, owned } = await store.createAppPage(spanish.id, "Trainer", {
      icon: "🃏",
      description: "Trainer for the words under Spanish.",
      entryHtml: ENTRY,
      assets: [{ name: "card.png", data: new Uint8Array([0x89, 0x50]) }],
      owns: [{ title: "Words", markdown: "| word | status |\n| - | - |" }],
      state: { seen: 0 },
      builtBy: "Claude",
    });

    expect(meta.kind).toBe("app");
    expect(meta.app?.entry).toBe(APP_ENTRY_PATH);
    expect(meta.app?.version).toBe(1);
    expect(meta.app?.builtBy).toBe("Claude");
    expect(meta.app?.state).toBe(true);
    expect(owned).toHaveLength(1);
    expect(owned[0].title).toBe("Words");
    // owns is resolved to ids on save, never kept as titles
    expect(meta.app?.owns).toEqual([owned[0].id]);

    const read = await store.readPage(meta.id);
    expect(read.markdown).toBe("Trainer for the words under Spanish.");

    const entry = await store.readAppFile(meta.id, APP_ENTRY_PATH);
    expect(entry.kind).toBe("file");
    expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
    expect(entry.kind === "file" && entry.mimeType).toBe("text/html; charset=utf-8");

    const asset = await store.readAppFile(meta.id, "app/assets/card.png");
    expect(asset.kind === "file" && asset.mimeType).toBe("image/png");
    expect(await store.readAppState(meta.id)).toEqual({ seen: 0 });
  });

  it("puts the files inside the page's own folder", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    const dir = store.resolve(meta.id);
    expect(await readFile(path.join(dir, APP_ENTRY_PATH), "utf8")).toBe(ENTRY);
  });

  it("refuses an entry over the cap and writes nothing", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    const huge = "x".repeat(APP_ENTRY_MAX_BYTES + 1);
    await expect(store.writeAppFiles(meta.id, { entryHtml: huge })).rejects.toSatisfy(isAppSize);
    const entry = await store.readAppFile(meta.id, APP_ENTRY_PATH);
    expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
  });

  it("refuses a file outside the app folder however it is addressed", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    for (const attempt of [
      "index.md",
      "app/../index.md",
      "../index.md",
      "app/assets/../../index.md",
    ]) {
      expect((await store.readAppFile(meta.id, attempt)).kind).toBe("missing");
    }
  });

  it("answers appMayWrite only for a page in owns", async () => {
    const other = await store.createPage(null, "Other");
    const { meta, owned } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      owns: [{ title: "Words" }],
      builtBy: "Claude",
    });
    expect(store.appMayWrite(meta.id, owned[0].id)).toBe(true);
    expect(store.appMayWrite(meta.id, other.id)).toBe(false);
    expect(store.appMayWrite(meta.id, meta.id)).toBe(false);
  });

  it("bumps the version and keeps owns and state across a rewrite", async () => {
    const { meta, owned } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      owns: [{ title: "Words" }],
      state: { seen: 3 },
      builtBy: "Claude",
    });
    const next = { ...meta.app!, version: meta.app!.version + 1 };
    await store.writeAppFiles(meta.id, { entryHtml: ENTRY + "<!-- v2 -->" });
    const after = await store.setAppMeta(meta.id, next, "claude");

    expect(after.app?.version).toBe(2);
    expect(after.app?.owns).toEqual([owned[0].id]);
    expect(await store.readAppState(meta.id)).toEqual({ seen: 3 });
  });

  it("survives a rebuild from disk", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    const reopened = new Store(root);
    await reopened.init();
    expect(reopened.readAppMeta(meta.id)?.entry).toBe(APP_ENTRY_PATH);
    expect(reopened.getTree().find((node) => node.id === meta.id)?.kind).toBe("app");
  });

  it("grows no phantom child from its own files", async () => {
    // The whole of C2 in one assertion: an app with a full set of legitimate
    // assets, reopened from disk, is one page with no children. Before
    // `isReservedDir` reserved `app`, the walk recursed into `app/` and
    // `app/assets/` looking for an index.md in each.
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      assets: [
        { name: "card.png", data: new Uint8Array([0x89, 0x50]) },
        { name: "cards/front.png", data: new Uint8Array([0x89, 0x50]) },
        { name: "words.json", data: new TextEncoder().encode("[]") },
      ],
      state: { seen: 0 },
      builtBy: "Claude",
    });
    const reopened = new Store(root);
    await reopened.init();
    const tree = reopened.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(meta.id);
    expect(tree[0].children).toEqual([]);
    expect(tree[0].hasChildren).toBe(false);
  });

  it("refuses an asset the page walk would read as a page", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      builtBy: "Claude",
    });
    for (const name of ["index.md", "cards/index.md", "notes.md"]) {
      await expect(
        store.writeAppFiles(meta.id, { assets: [{ name, data: new Uint8Array([1]) }] }),
      ).rejects.toMatchObject({ code: "bad_type" });
    }
    // and the refusal left the app it already had alone
    expect((await store.readAppFile(meta.id, APP_ENTRY_PATH)).kind).toBe("file");
  });

  it("replaces the whole file set or none of it", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      assets: [{ name: "old.png", data: new Uint8Array([1]) }],
      builtBy: "Claude",
    });
    // The second asset is refused, so the write throws part way through the
    // set. The app that was running must still be the app that is there.
    await expect(
      store.writeAppFiles(meta.id, {
        entryHtml: "<!doctype html><p>new</p>",
        assets: [
          { name: "new.png", data: new Uint8Array([2]) },
          { name: "bad.md", data: new Uint8Array([3]) },
        ],
      }),
    ).rejects.toBeTruthy();

    const entry = await store.readAppFile(meta.id, APP_ENTRY_PATH);
    expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
    expect((await store.readAppFile(meta.id, "app/assets/old.png")).kind).toBe("file");
    expect((await store.readAppFile(meta.id, "app/assets/new.png")).kind).toBe("missing");
  });

  it("keeps the assets a partial rewrite did not name", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      assets: [{ name: "card.png", data: new Uint8Array([1]) }],
      builtBy: "Claude",
    });
    await store.writeAppFiles(meta.id, { entryHtml: "<!doctype html><p>v2</p>" });
    expect((await store.readAppFile(meta.id, "app/assets/card.png")).kind).toBe("file");
  });

  /** A STATE WRITE IS NOT A REWRITE.
   *
   *  It used to delegate to `writeAppFiles`, which stages a whole new `app/`
   *  folder and swaps it in: up to 12 MiB copied and a git commit scheduled
   *  per card an app answers, through a rename pair whose window destroys the
   *  entry if a crash lands in it. The state is one small file and it has its
   *  own leaf now. */
  describe("an app's state", () => {
    const appPage = async () =>
      (
        await store.createAppPage(null, "Trainer", {
          description: "d",
          entryHtml: ENTRY,
          assets: [{ name: "card.png", data: new Uint8Array([1, 2, 3]) }],
          builtBy: "Claude",
        })
      ).meta;

    it("leaves the entry and the assets untouched, and stages nothing", async () => {
      const meta = await appPage();
      const dir = path.join(root, "trainer");
      const before = await stat(path.join(dir, "app", "index.html"));

      await store.writeAppState(meta.id, { seen: 1 });

      const entry = await store.readAppFile(meta.id, APP_ENTRY_PATH);
      expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
      const asset = await store.readAppFile(meta.id, "app/assets/card.png");
      expect(asset.kind === "file" && Array.from(asset.data)).toEqual([1, 2, 3]);
      // The same file, not a copy of it. A staged rewrite replaces the entry
      // with a new inode even when the bytes come out the same.
      const after = await stat(path.join(dir, "app", "index.html"));
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect((await readdir(dir)).filter((name) => name.startsWith(".app-next"))).toEqual([]);
    });

    it("lands the file and the frontmatter flag in one write", async () => {
      const meta = await appPage();
      expect(meta.app?.state).toBe(false);

      await store.writeAppState(meta.id, { seen: 1 });

      expect(store.readAppMeta(meta.id)?.state).toBe(true);
      expect(await store.readAppState(meta.id)).toEqual({ seen: 1 });
      // On disk too, so a reader of `index.md` alone knows the file is there.
      const front = await readFile(path.join(root, "trainer", "index.md"), "utf8");
      expect(front).toContain("state: true");
    });

    it("refuses state over the cap and writes nothing", async () => {
      const meta = await appPage();
      await expect(
        store.writeAppState(meta.id, { pad: "x".repeat(APP_STATE_MAX_BYTES) }),
      ).rejects.toSatisfy(isAppSize);
      expect(store.readAppMeta(meta.id)?.state).toBe(false);
      expect(await store.readAppState(meta.id)).toBeNull();
    });

    it("does not destroy the entry an interrupted rewrite left behind", async () => {
      // The crash window `writeAppFiles` admits to: `app/` renamed out to
      // `.app-next-old`, `.app-next/` still on disk. A state write used to go
      // straight back through that swap, `rm -rf` the retired folder and take
      // the only surviving copy of the entry with it. It writes its own file
      // now and touches neither folder, so the copy is still there for a
      // recovery to find.
      const meta = await appPage();
      const dir = path.join(root, "trainer");
      await rename(path.join(dir, "app"), path.join(dir, ".app-next-old"));
      await mkdir(path.join(dir, ".app-next"), { recursive: true });

      await store.writeAppState(meta.id, { seen: 2 });

      expect(await readFile(path.join(dir, ".app-next-old", "index.html"), "utf8")).toBe(ENTRY);
    });
  });

  it("still reads a page whose folder was already called app", async () => {
    // `slugify("App")` is `app`, so a notebook written before this release can
    // hold a perfectly ordinary page in a folder the walk now skips. A page
    // that disappears on upgrade is data loss with a clean exit code, so the
    // walk keeps one exception: a folder named `app` that holds its own
    // `index.md` is a page, and one that does not is an app's file set.
    await mkdir(path.join(root, "app"), { recursive: true });
    await writeFile(
      path.join(root, "app", "index.md"),
      [
        "---",
        "id: legacy-app-page",
        "title: App",
        "order: a0",
        "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "My notes about apps.",
        "",
      ].join("\n"),
    );
    const reopened = new Store(root);
    await reopened.init();
    expect(reopened.getTree().find((node) => node.id === "legacy-app-page")?.title).toBe("App");
  });
});
