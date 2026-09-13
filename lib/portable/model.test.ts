import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localAttachmentName } from "@/lib/attachments";
import { Store } from "@/lib/store";
import {
  createPortableArchive,
  readPortableArchive,
} from "./archive";
import {
  applyPortableBundle,
  buildPortableArchive,
  portableFileName,
  validatePortableArchive,
} from "./model";

const temporaryRoots: string[] = [];

async function temporaryStore(): Promise<Store> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-portable-"));
  temporaryRoots.push(root);
  const store = new Store(root);
  await store.init();
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

/** Repack an exported archive with an edited manifest, through the real
 *  reader and writer, so a hand-made archive still has to pass every tar
 *  rule a mailed one does. */
function repack(
  bytes: Uint8Array,
  edit: (manifest: Record<string, unknown>) => void,
): Uint8Array {
  const entries = readPortableArchive(bytes);
  const manifest = JSON.parse(
    new TextDecoder().decode(entries.get("manifest.json")!),
  ) as Record<string, unknown>;
  edit(manifest);
  return createPortableArchive(
    [...entries].map(([path, data]) =>
      path === "manifest.json"
        ? {
            path,
            data: new TextEncoder().encode(
              JSON.stringify(manifest, null, 2) + "\n",
            ),
          }
        : { path, data },
    ),
  );
}

describe("Brain portable packages", () => {
  it("exports and safely imports a subtree with links, assets, and metadata", async () => {
    const source = await temporaryStore();
    const root = await source.createPage(null, "Project Notes", {
      icon: "🧠",
    });
    const child = await source.createPage(root.id, "Research");
    const attachment = await source.saveAttachment({
      data: new TextEncoder().encode("portable attachment"),
      originalName: "evidence.txt",
      mimeType: "text/plain",
    });
    await source.writePage(
      root.id,
      `See [Research](/p/${child.id}).\n\n[Evidence](${attachment.url})`,
    );
    await source.updateMeta(root.id, {
      pinned: true,
      tags: ["portable", "reviewed"],
      font: "serif",
    });
    await source.writePage(child.id, "Child body");

    const exported = await buildPortableArchive(source, {
      rootId: root.id,
      now: new Date("2026-07-26T10:00:00.000Z"),
    });
    const destination = await temporaryStore();
    const existing = await destination.createPage(null, "Existing");
    const before = destination.getTree();
    const checked = validatePortableArchive(exported.bytes, destination);

    expect(destination.getTree()).toEqual(before);
    expect(checked.summary).toMatchObject({
      title: "Project Notes",
      pages: 2,
      rootPages: 1,
      attachments: 1,
    });

    const applied = await applyPortableBundle(destination, checked.bundle, {
      src: "portable-test",
    });
    expect(applied).toMatchObject({ created: 2 });
    const importedRoot = destination
      .getTree()
      .find((node) => node.id === applied.rootIds[0]);
    expect(importedRoot).toMatchObject({
      title: "Project Notes",
      icon: "🧠",
      pinned: true,
      tags: ["portable", "reviewed"],
      font: "serif",
    });
    expect(importedRoot?.children).toHaveLength(1);
    const imported = await destination.readPage(importedRoot!.id);
    expect(imported.markdown).toContain(
      `/p/${importedRoot!.children[0].id}`,
    );
    expect(imported.markdown).not.toContain(child.id);
    expect(imported.markdown).not.toContain(attachment.url);
    const importedAttachmentName = [...imported.markdown.matchAll(
      /\/_attachments-v2\/([A-Za-z0-9_.-]+)/g,
    )][0]?.[1];
    expect(importedAttachmentName).toBeTruthy();
    expect(
      new TextDecoder().decode(
        await destination.readPortableAttachment(importedAttachmentName!),
      ),
    ).toBe("portable attachment");
    expect(await destination.readPage(existing.id)).toMatchObject({
      meta: { title: "Existing" },
    });
  });

  it("uses a Finder-friendly deterministic extension", () => {
    expect(portableFileName("🧠 Project Notes")).toBe(
      "project-notes.brain.tar.gz",
    );
    expect(localAttachmentName("/_attachments-v2/ABCDEF.txt")).toBe(
      "ABCDEF.txt",
    );
  });

  it("stamps version 2 on a new export", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Only Page");
    const exported = await buildPortableArchive(source);
    expect(exported.manifest.version).toBe(2);
  });

  it("imports a version 1 archive with no tasks key exactly as it does today", async () => {
    const source = await temporaryStore();
    const page = await source.createPage(null, "Older Export");
    await source.writePage(page.id, "Written before the bump");
    const exported = await buildPortableArchive(source);
    const older = repack(exported.bytes, (manifest) => {
      manifest.version = 1;
      delete manifest.tasks;
    });

    const destination = await temporaryStore();
    const checked = validatePortableArchive(older, destination);
    expect(checked.bundle.manifest.version).toBe(1);
    const applied = await applyPortableBundle(destination, checked.bundle);
    expect(applied).toMatchObject({ created: 1 });
    const imported = await destination.readPage(applied.rootIds[0]);
    expect(imported.markdown).toContain("Written before the bump");
    expect(destination.listTasks("2026-09-13", { offsetMinutes: 0 })).toEqual(
      [],
    );
  });

  it("refuses a version 3 archive", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "From The Future");
    const exported = await buildPortableArchive(source);
    const newer = repack(exported.bytes, (manifest) => {
      manifest.version = 3;
    });
    expect(() => validatePortableArchive(newer)).toThrow(/manifest is invalid/);
  });
});
