import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store";
import { isNotApp } from "./types";

/** WHOSE FOLDER `app/` IS.
 *
 *  A page titled "App" slugifies to `app`, so `<parent>/app/` is a child
 *  page's folder in some notebooks and an app's file set in others. The file
 *  writer used to rename whichever it found out of the way and drop it: one
 *  `writeAppFiles` on the parent deleted the child page and everything under
 *  it, with a clean exit code, and portable import reached that path on every
 *  restore. The page's own `kind` is the answer, checked before the rename. */

let root: string;
let store: Store;

const ENTRY = "<!doctype html><p>hi</p>";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-apps-not-app-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a write to a page that is not an app", () => {
  it("does not delete a child page whose folder is called app", async () => {
    const parent = await store.createPage(null, "Trainer");
    const child = await store.createPage(parent.id, "App");
    expect(path.basename(store.resolve(child.id))).toBe("app");

    await expect(
      store.writeAppFiles(parent.id, { entryHtml: ENTRY }),
    ).rejects.toSatisfy(isNotApp);

    const reopened = new Store(root);
    await reopened.init();
    const tree = reopened.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.title)).toEqual(["App"]);
    expect((await reopened.readPage(child.id)).meta.title).toBe("App");
  });

  it("refuses every file write on an ordinary page", async () => {
    const page = await store.createPage(null, "Spanish");
    await expect(
      store.writeAppFiles(page.id, { entryHtml: ENTRY }),
    ).rejects.toSatisfy(isNotApp);
    await expect(store.writeAppState(page.id, { a: 1 })).rejects.toSatisfy(isNotApp);
  });

  it("refuses a file write on a page whose app map does not validate", async () => {
    const dir = path.join(root, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "index.md"),
      [
        "---",
        "id: broken",
        "title: Broken",
        "kind: app",
        "app: nonsense",
        "order: a0",
        "created: 2026-01-01T00:00:00.000Z",
        "updated: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "d",
        "",
      ].join("\n"),
    );
    const reopened = new Store(root);
    await reopened.init();
    await expect(
      reopened.writeAppFiles("broken", { entryHtml: ENTRY }),
    ).rejects.toSatisfy(isNotApp);
  });

  it("refuses to make a page an app when its app folder is a child page", async () => {
    const parent = await store.createPage(null, "Trainer");
    await store.createPage(parent.id, "App");
    await expect(
      store.createAppPage(null, "Ignored", {
        description: "d",
        entryHtml: ENTRY,
        builtBy: "Claude",
      }),
    ).resolves.toBeTruthy(); // a fresh page is fine, it has no app/ folder

    await expect(
      store.setAppMeta(parent.id, {
        entry: "app/index.html",
        version: 1,
        builtBy: "Claude",
        builtAt: "2026-09-22T10:00:00.000Z",
        owns: [],
        state: false,
      }),
    ).rejects.toSatisfy(isNotApp);
  });

  it("still lets a real app rewrite its own files", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", {
      description: "d",
      entryHtml: ENTRY,
      assets: [{ name: "card.png", data: new Uint8Array([1]) }],
      builtBy: "Claude",
    });
    await store.writeAppFiles(meta.id, { entryHtml: `${ENTRY}<!-- v2 -->` });
    await store.writeAppState(meta.id, { seen: 1 });
    expect(await store.readAppState(meta.id)).toEqual({ seen: 1 });
    expect((await store.readAppFile(meta.id, "app/assets/card.png")).kind).toBe("file");
  });
});
