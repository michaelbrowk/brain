import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPortableBundle,
  buildPortableArchive,
  validatePortableArchive,
} from "../portable/model";
import { Store } from "./store";

/** A PAGE WHOSE `app` MAP THIS RELEASE CANNOT READ.
 *
 *  Three ways it happens, all reachable without a bug here: an older Brain
 *  wrote a shape this one does not know, another clone or an editor plugin
 *  touched the file, or a create died between the files and the metadata. The
 *  page is then a page with `kind: app` and no usable app, and the one thing
 *  it must never be is unwritable: a title somebody cannot change is data
 *  loss with a clean exit code. */

let root: string;
let store: Store;

const ENTRY = "<!doctype html><p>hi</p>";

const FRONTMATTER = (id: string, app: string) =>
  [
    "---",
    `id: ${id}`,
    "title: Trainer",
    "kind: app",
    ...(app ? [app] : []),
    "order: a0",
    "created: 2026-01-01T00:00:00.000Z",
    "updated: 2026-01-01T00:00:00.000Z",
    "---",
    "",
    "A description.",
    "",
  ].join("\n");

const JUNK_MAP = [
  "app:",
  "  entry: app/index.html",
  '  version: "notanumber"',
  "  bogus: 1",
  '  owns: "notalist"',
].join("\n");

async function seedPage(id: string, app: string): Promise<void> {
  const dir = path.join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.md"), FRONTMATTER(id, app));
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-apps-malformed-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CASES: ReadonlyArray<readonly [name: string, app: string]> = [
  ["a map whose fields are the wrong types", JUNK_MAP],
  ["a map that is not a map at all", "app: nonsense"],
  ["no map at all beside the kind", ""],
];

describe("a page whose app map does not validate", () => {
  for (const [name, app] of CASES) {
    it(`is still writable: ${name}`, async () => {
      await seedPage("broken-app", app);
      const reopened = new Store(root);
      await reopened.init();

      // No usable app, and the two readers say so rather than handing a
      // caller a shape typed as AppMeta that it is not.
      expect(reopened.readAppMeta("broken-app")).toBeNull();
      expect(reopened.appMayWrite("broken-app", "anything")).toBe(false);

      // The page itself is untouched: `kind` stays, and a rename lands.
      const renamed = await reopened.updateMeta("broken-app", {
        title: "Renamed",
      });
      expect(renamed.title).toBe("Renamed");
      expect(reopened.getTree()[0].kind).toBe("app");
    });

    it(`is a tree node with no app on it: ${name}`, async () => {
      // The tree is the projection the whole client reads, and it used to
      // hand `meta.app` straight out, typed as `AppMeta`. `validAppMeta`
      // guarded the store's own readers and not this one, so a map off
      // somebody's disk reached React as a shape it is not. The node keeps
      // its `kind`, because the page IS an app page: what it does not keep is
      // a map nothing can use.
      await seedPage("broken-app", app);
      const reopened = new Store(root);
      await reopened.init();

      const node = reopened.getTree()[0];
      expect(node.kind).toBe("app");
      expect(node.app).toBeUndefined();
    });

    it(`keeps the map on disk byte for byte: ${name}`, async () => {
      await seedPage("broken-app", app);
      const reopened = new Store(root);
      await reopened.init();
      await reopened.updateMeta("broken-app", { title: "Renamed" });
      const raw = await readFile(
        path.join(reopened.resolve("broken-app"), "index.md"),
        "utf8",
      );
      expect(raw).toContain("kind: app");
      if (app === "app: nonsense") expect(raw).toContain("nonsense");
      if (app === JUNK_MAP) {
        expect(raw).toContain("notanumber");
        expect(raw).toContain("notalist");
      }
      if (app === "") expect(raw).not.toContain("app:");
    });

    it(`exports and imports as an ordinary page: ${name}`, async () => {
      await seedPage("broken-app", app);
      const reopened = new Store(root);
      await reopened.init();

      const { bytes, manifest, skippedApps } = await buildPortableArchive(reopened);
      expect(manifest.pages[0].app).toBeUndefined();
      expect(skippedApps).toContain("broken-app");

      const otherRoot = await mkdtemp(path.join(tmpdir(), "brain-apps-malformed-in-"));
      const other = new Store(otherRoot);
      await other.init();
      try {
        const { bundle } = validatePortableArchive(bytes);
        const { rootIds } = await applyPortableBundle(other, bundle);
        expect(other.getTree()).toHaveLength(1);
        expect(other.readAppMeta(rootIds[0])).toBeNull();
      } finally {
        await rm(otherRoot, { recursive: true, force: true });
      }
    });
  }

  it("serves no app file for a page whose map does not validate", async () => {
    await seedPage("broken-app", JUNK_MAP);
    const dir = path.join(root, "broken-app", "app");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), ENTRY);
    const reopened = new Store(root);
    await reopened.init();
    expect((await reopened.readAppFile("broken-app", "app/index.html")).kind).toBe(
      "missing",
    );
    expect(await reopened.readAppState("broken-app")).toBeNull();
  });

  it("never treats a string owns as a list of page ids", async () => {
    // `String.prototype.includes` is why this matters: an `owns` that is the
    // string "notalist" would answer true for the page id "ali".
    await seedPage("broken-app", JUNK_MAP);
    const reopened = new Store(root);
    await reopened.init();
    expect(reopened.appMayWrite("broken-app", "ali")).toBe(false);
    expect(reopened.appMayWrite("broken-app", "notalist")).toBe(false);
  });
});
