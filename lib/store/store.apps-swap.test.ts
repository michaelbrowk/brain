import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ENTRY_PATH, APP_STAGING_DIR } from "../apps/model";
import { Store } from "./store";

/** THE WINDOW BETWEEN THE TWO RENAMES.
 *
 *  `writeAppFiles` swaps a staged set in by renaming `app/` out to
 *  `.app-next-old/` and `.app-next/` in. That pair is not one operation on
 *  any filesystem, so a crash can land between them and leave the page with
 *  no `app/` at all and the only copy of its files sitting in
 *  `.app-next-old/`. The next write has to find it there. It used to delete
 *  it instead, and one ordinary state write then left an app with no entry
 *  and no assets. */

let root: string;
let store: Store;

const ENTRY = "<!doctype html><p>v1</p>";
const RETIRED = `${APP_STAGING_DIR}-old`;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-apps-swap-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedApp() {
  const { meta } = await store.createAppPage(null, "Trainer", {
    description: "d",
    entryHtml: ENTRY,
    assets: [{ name: "card.png", data: new Uint8Array([1, 2, 3]) }],
    builtBy: "Claude",
  });
  return meta;
}

/** The exact state a crash between the two renames leaves: `app/` renamed to
 *  `.app-next-old/`, and a staged set still on disk. */
async function crashBetweenRenames(dir: string) {
  await rename(path.join(dir, "app"), path.join(dir, RETIRED));
  await rm(path.join(dir, APP_STAGING_DIR), { recursive: true, force: true });
  await mkdir(path.join(dir, APP_STAGING_DIR), { recursive: true });
  await writeFile(path.join(dir, APP_STAGING_DIR, "index.html"), "<!doctype html><p>half</p>");
}

describe("a crash between the swap's two renames", () => {
  it("recovers the retired set on the next write", async () => {
    const meta = await seedApp();
    const dir = store.resolve(meta.id);
    await crashBetweenRenames(dir);
    expect(await readdir(dir)).toEqual(
      expect.arrayContaining([APP_STAGING_DIR, RETIRED, "index.md"]),
    );

    await store.writeAppState(meta.id, { a: 2 });

    const entry = await store.readAppFile(meta.id, APP_ENTRY_PATH);
    expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
    const asset = await store.readAppFile(meta.id, "app/assets/card.png");
    expect(asset.kind).toBe("file");
    expect(await store.readAppState(meta.id)).toEqual({ a: 2 });
    expect(await readdir(dir)).not.toContain(RETIRED);
    expect(await readdir(dir)).not.toContain(APP_STAGING_DIR);
  });

  it("prefers the live set when both are on disk", async () => {
    // A crash after the SECOND rename but before the cleanup: `app/` is the
    // new set and `.app-next-old/` is a stale copy of the old one. The live
    // folder wins and the stale one goes.
    const meta = await seedApp();
    const dir = store.resolve(meta.id);
    await mkdir(path.join(dir, RETIRED), { recursive: true });
    await writeFile(path.join(dir, RETIRED, "index.html"), "<!doctype html><p>stale</p>");

    await store.writeAppState(meta.id, { a: 3 });

    const entry = await store.readAppFile(meta.id, APP_ENTRY_PATH);
    expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
    expect(await readdir(dir)).not.toContain(RETIRED);
  });

  it("survives the recovery across a reopen", async () => {
    const meta = await seedApp();
    await crashBetweenRenames(store.resolve(meta.id));
    await store.writeAppState(meta.id, { a: 4 });

    const reopened = new Store(root);
    await reopened.init();
    expect(reopened.getTree()).toHaveLength(1);
    expect(reopened.getTree()[0].children).toEqual([]);
    const entry = await reopened.readAppFile(meta.id, APP_ENTRY_PATH);
    expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
  });
});
