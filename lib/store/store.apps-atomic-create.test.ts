import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_ENTRY_MAX_BYTES,
  APP_ENTRY_PATH,
  APP_MAX_OWNED,
} from "../apps/model";
import { Store } from "./store";
import type { CreateAppPageInput } from "./types";

/** A REFUSED CREATE LEAVES NO PAGE.
 *
 *  `createAppPage` mints the page, then a child per `owns`, then the files,
 *  then the metadata. Every one of those is a separate write, so a refusal
 *  that arrives late leaves an orphan: a page in the tree with no `kind`, no
 *  files, and children nobody asked for. `applyPortableBundle` sets the house
 *  standard by rolling its own creates back, and the cheaper answer here is
 *  to ask every question before the first write. */

let root: string;
let store: Store;

const ENTRY = "<!doctype html><p>hi</p>";

const base: CreateAppPageInput = {
  description: "d",
  entryHtml: ENTRY,
  builtBy: "Claude",
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-apps-atomic-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const REFUSED: ReadonlyArray<readonly [name: string, input: CreateAppPageInput]> = [
  [
    "a reason that collapses to nothing",
    { ...base, reason: "   ", owns: [{ title: "Words" }] },
  ],
  [
    "an asset the page walk would read as a page",
    { ...base, assets: [{ name: "readme.md", data: new Uint8Array([1]) }] },
  ],
  [
    "an asset whose name is not one an app may hold",
    { ...base, assets: [{ name: "../escape.png", data: new Uint8Array([1]) }] },
  ],
  [
    "an entry over the cap",
    { ...base, entryHtml: "x".repeat(APP_ENTRY_MAX_BYTES + 1) },
  ],
  [
    "more owned pages than one app may have",
    {
      ...base,
      owns: Array.from({ length: APP_MAX_OWNED + 1 }, (_, i) => ({
        title: `Page ${i}`,
      })),
    },
  ],
  ["an owned page with no title", { ...base, owns: [{ title: "   " }] }],
];

describe("a create that is going to be refused", () => {
  for (const [name, input] of REFUSED) {
    it(`writes nothing: ${name}`, async () => {
      const before = await store.createPage(null, "Spanish");
      await expect(store.createAppPage(before.id, "Trainer", input)).rejects.toBeTruthy();

      // The tree is what it was: one page, no children, no orphan.
      const tree = store.getTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe(before.id);
      expect(tree[0].children).toEqual([]);

      const reopened = new Store(root);
      await reopened.init();
      expect(reopened.getTree()).toHaveLength(1);
      expect(reopened.getTree()[0].children).toEqual([]);
    });
  }

  it("still creates an app when every answer is yes", async () => {
    const { meta, owned } = await store.createAppPage(null, "Trainer", {
      ...base,
      reason: "build me a trainer",
      owns: [{ title: "Words" }],
      assets: [{ name: "card.png", data: new Uint8Array([1]) }],
    });
    expect(meta.app?.reason).toBe("build me a trainer");
    expect(owned).toHaveLength(1);
    expect(store.getTree()).toHaveLength(1);
  });
});

/** A CHILD OF AN APP PAGE NEVER TAKES THE FOLDER NAME `app`.
 *
 *  `slugify("App")` is `app`, which under an app page is the name of the
 *  app's OWN file set: the walk skips it, and `writeAppFiles` renames it out
 *  of the way on every write. A child that took it would be invisible after a
 *  reopen and carried off on the next rewrite, so the app's folder is spoken
 *  for from the first child, and a child called "App" becomes `app-2`
 *  exactly as a second one already does. */
describe("an owned page somebody called App", () => {
  it("is owned like any other, and leaves the app's folder alone", async () => {
    const { meta, owned } = await store.createAppPage(null, "Trainer", {
      ...base,
      owns: [{ title: "App", markdown: "| word |" }],
      assets: [{ name: "card.png", data: new Uint8Array([1]) }],
    });

    expect(owned).toHaveLength(1);
    expect(owned[0].title).toBe("App");
    expect(store.appMayWrite(meta.id, owned[0].id)).toBe(true);
    expect(path.basename(store.resolve(owned[0].id))).not.toBe("app");

    // The app itself runs: its entry and its asset are where they belong.
    expect((await store.readAppFile(meta.id, APP_ENTRY_PATH)).kind).toBe("file");
    expect((await store.readAppFile(meta.id, "app/assets/card.png")).kind).toBe(
      "file",
    );

    // And the child is still a page after a rebuild from disk, rather than a
    // folder the walk reads as somebody's app.
    const reopened = new Store(root);
    await reopened.init();
    const tree = reopened.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((node) => node.title)).toEqual(["App"]);
    expect(reopened.readAppMeta(meta.id)?.owns).toEqual([owned[0].id]);
  });

  it("takes no app folder when it is added to an app page later", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", base);
    const child = await store.createPage(meta.id, "App");
    expect(path.basename(store.resolve(child.id))).not.toBe("app");

    // The rewrite that follows is the one that used to carry a child away.
    await store.writeAppFiles(meta.id, { entryHtml: `${ENTRY}<!-- v2 -->` });
    const reopened = new Store(root);
    await reopened.init();
    expect(reopened.getTree()[0].children.map((node) => node.title)).toEqual([
      "App",
    ]);
  });

  it("takes no app folder when it is moved under an app page", async () => {
    const { meta } = await store.createAppPage(null, "Trainer", base);
    const child = await store.createPage(null, "App");
    expect(path.basename(store.resolve(child.id))).toBe("app");

    await store.movePage(child.id, meta.id, null);
    expect(path.basename(store.resolve(child.id))).not.toBe("app");
    expect((await store.readAppFile(meta.id, APP_ENTRY_PATH)).kind).toBe("file");
  });
});
