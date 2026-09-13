import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localAttachmentName } from "@/lib/attachments";
import { Store } from "@/lib/store";
import { hashTaskText, normalizeTaskText } from "@/lib/tasks/task-lines";
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

const EXPORTED_AT = new Date("2026-09-13T10:00:00.000Z");
const TODAY = "2026-09-13";

function anchorFor(text: string, line: number) {
  const normalized = normalizeTaskText(text);
  return { text: normalized, hash: hashTaskText(normalized), ordinal: 0, line };
}

/** One page holding one checkbox, plus four tasks: one scheduled, one
 *  repeating, one with a deadline, and one linked to the checkbox. */
async function notebookWithTasks(): Promise<{
  source: Store;
  pageId: string;
  anchor: ReturnType<typeof anchorFor>;
}> {
  const source = await temporaryStore();
  const page = await source.createPage(null, "Planning");
  await source.writePage(page.id, "- [ ] Draft the plan");
  const anchor = anchorFor("Draft the plan", 0);
  await source.createTask({
    title: "Water the plants",
    when: "2026-09-14",
    category: "Home",
  });
  await source.createTask({
    title: "Weekly review",
    repeat: { freq: "weekly", byWeekday: ["mon"] },
  });
  await source.createTask({
    title: "Renew the passport",
    when: "someday",
    deadline: "2026-10-01",
  });
  await source.createTask({
    title: "Draft the plan",
    page: page.id,
    anchor,
  });
  return { source, pageId: page.id, anchor };
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

  it("exports every task and imports them back with when, deadline, category and repeat intact", async () => {
    const { source } = await notebookWithTasks();
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    expect(exported.manifest.tasks).toHaveLength(4);

    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    expect(checked.summary).toMatchObject({ pages: 1, tasks: 4 });
    const applied = await applyPortableBundle(destination, checked.bundle);
    expect(applied).toMatchObject({ tasks: 4 });

    const imported = destination.listTasks(TODAY, { offsetMinutes: 0 });
    expect(imported.map((task) => task.title).sort()).toEqual([
      "Draft the plan",
      "Renew the passport",
      "Water the plants",
      "Weekly review",
    ]);
    const byTitle = new Map(imported.map((task) => [task.title, task]));
    expect(byTitle.get("Water the plants")).toMatchObject({
      when: "2026-09-14",
      category: "Home",
    });
    expect(byTitle.get("Renew the passport")).toMatchObject({
      when: "someday",
      deadline: "2026-10-01",
    });
    expect(byTitle.get("Weekly review")?.repeat).toEqual({
      freq: "weekly",
      byWeekday: ["mon"],
    });
  });

  it("remaps a linked task's page id to the imported page's new id", async () => {
    const { source, pageId, anchor } = await notebookWithTasks();
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });

    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    const applied = await applyPortableBundle(destination, checked.bundle);
    const importedPageId = applied.rootIds[0];

    const linked = destination
      .listTasks(TODAY, { offsetMinutes: 0 })
      .find((task) => task.title === "Draft the plan");
    expect(linked?.page).toBe(importedPageId);
    expect(linked?.page).not.toBe(pageId);
    expect(linked?.anchor).toEqual(anchor);
    expect(destination.tasksForPage(importedPageId)).toHaveLength(1);
  });

  it("imports a task whose page id is absent as detached, keeping its schedule and title", async () => {
    const { source } = await notebookWithTasks();
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const orphaned = repack(exported.bytes, (manifest) => {
      for (const task of manifest.tasks as Array<Record<string, unknown>>) {
        if (task.pageSourceId === undefined) continue;
        task.pageSourceId = "a-page-this-archive-never-carried";
        task.when = "2026-09-20";
      }
    });

    const destination = await temporaryStore();
    const checked = validatePortableArchive(orphaned, destination);
    const applied = await applyPortableBundle(destination, checked.bundle);
    expect(applied).toMatchObject({ tasks: 4 });

    const detached = destination
      .listTasks(TODAY, { offsetMinutes: 0 })
      .find((task) => task.title === "Draft the plan");
    expect(detached).toBeDefined();
    expect(detached?.page).toBeUndefined();
    expect(detached?.anchor).toBeUndefined();
    expect(detached?.when).toBe("2026-09-20");
    expect(detached?.done).toBe(false);
  });

  it("exports no tasks key at all when the notebook has none", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Nothing To Do");
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    expect(exported.manifest.tasks).toBeUndefined();
    expect(
      Object.keys(exported.manifest).includes("tasks"),
    ).toBe(false);
    const destination = await temporaryStore();
    expect(
      validatePortableArchive(exported.bytes, destination).summary,
    ).toMatchObject({ tasks: 0 });
  });

  it("carries a completed unlinked task back as completed", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Anything");
    const done = await source.createTask({ title: "Book the flight" });
    await source.updateTask(done.id, { done: true });
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });

    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    await applyPortableBundle(destination, checked.bundle);
    const imported = destination.listTasks(TODAY, { offsetMinutes: 0 });
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ title: "Book the flight", done: true });
  });

  it("refuses a version 1 archive that carries a tasks key", async () => {
    const { source } = await notebookWithTasks();
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const mixed = repack(exported.bytes, (manifest) => {
      manifest.version = 1;
    });
    expect(() => validatePortableArchive(mixed)).toThrow(/version 1/);
  });
});
