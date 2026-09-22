import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_ENTRY_PATH } from "@/lib/apps/model";
import { Store } from "@/lib/store/store";
import { createPortableArchive, readPortableArchive } from "./archive";
import {
  applyPortableBundle,
  buildPortableArchive,
  PORTABLE_VERSION,
  validatePortableArchive,
} from "./model";

const ENTRY = '<!doctype html><meta name="color-scheme" content="light dark"><p>hola</p>';
const CARD = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let root: string;
let store: Store;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "brain-portable-apps-"));
  store = new Store(root);
  await store.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedApp() {
  return store.createAppPage(null, "Trainer", {
    icon: "🃏",
    description: "Trainer for the words under Spanish.",
    entryHtml: ENTRY,
    assets: [{ name: "cards/front.png", data: CARD }],
    owns: [{ title: "Words", markdown: "| word |" }],
    state: { seen: 3 },
    builtBy: "Claude",
    reason: "build me a trainer",
  });
}

/** The archive module reads to a map and writes from a list, so a helper that
 *  edits one manifest inside a finished archive has to go through both. */
function rewriteManifest(
  bytes: Uint8Array,
  change: (manifest: Record<string, unknown>) => void,
): Uint8Array {
  const entries = readPortableArchive(bytes);
  const manifest = JSON.parse(
    new TextDecoder().decode(entries.get("manifest.json")!),
  ) as Record<string, unknown>;
  change(manifest);
  return createPortableArchive(
    [...entries].map(([entryPath, data]) =>
      entryPath === "manifest.json"
        ? {
            path: entryPath,
            data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
          }
        : { path: entryPath, data },
    ),
  );
}

const downgradeManifest = (bytes: Uint8Array) =>
  rewriteManifest(bytes, (manifest) => {
    manifest.version = 2;
  });

const retargetEntry = (bytes: Uint8Array, entryPath: string) =>
  rewriteManifest(bytes, (manifest) => {
    const pages = manifest.pages as { app?: { entryPath: string } }[];
    const page = pages.find((candidate) => candidate.app !== undefined)!;
    page.app!.entryPath = entryPath;
  });

describe("an app page in a portable archive", () => {
  it("writes the version the new key needs", async () => {
    expect(PORTABLE_VERSION).toBe(3);
  });

  it("carries the entry, the assets and the state", async () => {
    const { meta } = await seedApp();
    const { manifest } = await buildPortableArchive(store);
    const page = manifest.pages.find((candidate) => candidate.sourceId === meta.id);

    expect(page?.app).toBeDefined();
    expect(page?.app?.entryPath).toMatch(/^app\/p\d{6}\/index\.html$/);
    expect(page?.app?.assets).toEqual([
      {
        name: "cards/front.png",
        archivePath: expect.stringMatching(/^app\/p\d{6}\/assets\/cards\/front\.png$/),
      },
    ]);
    expect(page?.app?.statePath).toMatch(/^app\/p\d{6}\/state\.json$/);
  });

  it("leaves an ordinary page's entry absent, so a plain notebook is unchanged", async () => {
    await store.createPage(null, "Spanish", { markdown: "hola" });
    const { manifest } = await buildPortableArchive(store);
    expect(manifest.pages.every((page) => page.app === undefined)).toBe(true);
  });

  it("round-trips into a second notebook, files and all", async () => {
    const { meta, owned } = await seedApp();
    const { bytes } = await buildPortableArchive(store);

    const otherRoot = await mkdtemp(path.join(tmpdir(), "brain-portable-apps-in-"));
    const other = new Store(otherRoot);
    await other.init();
    try {
      const { bundle } = validatePortableArchive(bytes);
      const { rootIds } = await applyPortableBundle(other, bundle);
      const restored = rootIds[0];

      expect(other.readAppMeta(restored)?.builtBy).toBe("Claude");
      expect(other.readAppMeta(restored)?.reason).toBe("build me a trainer");
      expect(other.readAppMeta(restored)?.state).toBe(true);

      const entry = await other.readAppFile(restored, APP_ENTRY_PATH);
      expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(ENTRY);
      const asset = await other.readAppFile(restored, "app/assets/cards/front.png");
      expect(asset.kind === "file" && Buffer.from(asset.data)).toEqual(Buffer.from(CARD));
      expect(await other.readAppState(restored)).toEqual({ seen: 3 });

      // owns is remapped onto the ids the restore minted, never the ids the
      // export came from: a stale id there is a write the app cannot make.
      const words = other.getTree()[0].children[0];
      expect(words.title).toBe("Words");
      expect(other.readAppMeta(restored)?.owns).toEqual([words.id]);
      expect(other.readAppMeta(restored)?.owns).not.toContain(owned[0].id);
      expect(other.appMayWrite(restored, words.id)).toBe(true);
      expect(meta.id).not.toBe(restored);
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("round-trips an app page whose own child is called App", async () => {
    // `slugify("App")` is `app`, the name of the app's own file set. In the
    // exporting notebook the child was pushed to `app-2` because the app's
    // folder was already there. A restore creates the pages first, into a
    // notebook where nothing holds `app/` yet, so the child took it and the
    // metadata write that followed refused the WHOLE archive: a notebook that
    // cannot be restored from its own backup. The app page says what it is
    // before its children exist, so the child lands beside `app/` here too.
    const { meta, owned } = await store.createAppPage(null, "Trainer", {
      icon: "🃏",
      description: "Trainer for the words under Spanish.",
      entryHtml: ENTRY,
      assets: [{ name: "cards/front.png", data: CARD }],
      owns: [{ title: "App", markdown: "| word |" }],
      state: { seen: 3 },
      builtBy: "Claude",
    });
    expect(path.basename(store.resolve(owned[0].id))).not.toBe("app");
    const { bytes } = await buildPortableArchive(store);

    const otherRoot = await mkdtemp(path.join(tmpdir(), "brain-portable-apps-in-"));
    const other = new Store(otherRoot);
    await other.init();
    try {
      const { bundle } = validatePortableArchive(bytes);
      const { rootIds } = await applyPortableBundle(other, bundle);
      const restored = rootIds[0];

      // The child survived, as a page, with a folder of its own.
      const child = other.getTree()[0].children[0];
      expect(other.getTree()[0].children).toHaveLength(1);
      expect(child.title).toBe("App");
      expect(path.basename(other.resolve(child.id))).not.toBe("app");

      // And the app runs: its files are there and its map validates.
      expect(other.readAppMeta(restored)?.builtBy).toBe("Claude");
      expect(other.readAppMeta(restored)?.owns).toEqual([child.id]);
      const entry = await other.readAppFile(restored, APP_ENTRY_PATH);
      expect(entry.kind === "file" && Buffer.from(entry.data).toString("utf8")).toBe(
        ENTRY,
      );
      expect(
        (await other.readAppFile(restored, "app/assets/cards/front.png")).kind,
      ).toBe("file");
      expect(await other.readAppState(restored)).toEqual({ seen: 3 });
      expect(meta.id).not.toBe(restored);

      // A reopen reads the same tree back off disk.
      const again = new Store(otherRoot);
      await again.init();
      expect(again.getTree()[0].children.map((node) => node.title)).toEqual(["App"]);
      expect(again.readAppMeta(restored)).not.toBeNull();
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("still reads a version 2 archive, which has no app key at all", async () => {
    await store.createPage(null, "Spanish", { markdown: "hola" });
    const { bytes, manifest } = await buildPortableArchive(store);
    expect(manifest.version).toBe(3);
    // A version 2 manifest is this one with the number changed, because a
    // notebook of ordinary pages writes the same bytes either way.
    const legacy = downgradeManifest(bytes);
    expect(() => validatePortableArchive(legacy)).not.toThrow();
  });

  it("refuses an archive whose app entry points outside its own folder", async () => {
    await seedApp();
    const { bytes } = await buildPortableArchive(store);
    const tampered = retargetEntry(bytes, "../../pages/p000001.md");
    expect(() => validatePortableArchive(tampered)).toThrow();
  });

  it("refuses a version 2 archive that carries app files anyway", async () => {
    await seedApp();
    const { bytes } = await buildPortableArchive(store);
    expect(() => validatePortableArchive(downgradeManifest(bytes))).toThrow();
  });

  it("refuses a state file that is not JSON, before anything is created", async () => {
    // The refusal belongs to validation, where every other malformed archive
    // is caught and named. Left to the restore it arrived as a bare
    // SyntaxError out of `applyPortableBundle`, after the import had begun,
    // and the owner read a parser's words about a file they never saw.
    await seedApp();
    const { bytes } = await buildPortableArchive(store);
    const entries = readPortableArchive(bytes);
    const statePath = [...entries.keys()].find((key) => key.endsWith("/state.json"))!;
    const broken = createPortableArchive(
      [...entries].map(([entryPath, data]) => ({
        path: entryPath,
        data: entryPath === statePath ? new TextEncoder().encode("not json{") : data,
      })),
    );

    expect(() => validatePortableArchive(broken)).toThrow(/state/i);
  });

  it("refuses one app page that claims another app page's asset", async () => {
    // The case the same-folder check exists for, and the only one that
    // reaches it. A traversal in a path is refused by the schema's regex
    // first, so a path that is perfectly well formed but names a DIFFERENT
    // page's folder is what shows the check doing work of its own: page A
    // claiming page B's asset would restore B's file under A.
    await seedApp();
    await store.createAppPage(null, "Second", {
      description: "d",
      entryHtml: ENTRY,
      assets: [{ name: "b.png", data: CARD }],
      builtBy: "Claude",
    });
    const { bytes } = await buildPortableArchive(store);

    const crossClaimed = rewriteManifest(bytes, (manifest) => {
      const pages = manifest.pages as {
        app?: {
          entryPath: string;
          assets: { name: string; archivePath: string }[];
        };
      }[];
      const apps = pages.filter((page) => page.app !== undefined);
      expect(apps).toHaveLength(2);
      const [first, second] = apps;
      // Well formed, matches the schema, and names the other page's folder.
      first.app!.assets = [
        { name: "stolen.png", archivePath: second.app!.assets[0].archivePath },
      ];
    });

    expect(() => validatePortableArchive(crossClaimed)).toThrow(
      /outside its own folder/,
    );
  });
});
