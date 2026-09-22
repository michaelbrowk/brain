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

  it("names an asset's type from the one extension list", async () => {
    // The manifest's `mimeType` is what `store.saveAttachment` is handed on
    // import, and the store turns some types down. Nothing asserted it, so a
    // change to the shared list could have made an exported file
    // unimportable without a red test anywhere.
    const source = await temporaryStore();
    const page = await source.createPage(null, "With an asset");
    const attachment = await source.saveAttachment({
      data: new TextEncoder().encode("portable attachment"),
      originalName: "evidence.txt",
      mimeType: "text/plain",
    });
    await source.writePage(page.id, `[Evidence](${attachment.url})`);

    const exported = await buildPortableArchive(source, { rootId: page.id });
    expect(exported.manifest.attachments).toEqual([
      expect.objectContaining({ mimeType: "text/plain" }),
    ]);
  });

  it("stamps version 3 on a new export", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Only Page");
    const exported = await buildPortableArchive(source);
    expect(exported.manifest.version).toBe(3);
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

  it("refuses a version 4 archive", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "From The Future");
    const exported = await buildPortableArchive(source);
    const newer = repack(exported.bytes, (manifest) => {
      manifest.version = 4;
    });
    expect(() => validatePortableArchive(newer)).toThrow(/manifest is invalid/);
  });

  it("exports every task under tasks/ and imports them back with when, deadline, category and repeat intact", async () => {
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

  it("carries a detached record out and back, field for field", async () => {
    const { source, pageId, anchor } = await notebookWithTasks();
    // The shape Task 3b's detach writes: the mark, the page kept so the row
    // can say which note the line left, the anchor kept as the last place it
    // was, and a completion the record owns again.
    const linked = source
      .allTasks()
      .find((task) => task.title === "Draft the plan");
    if (!linked) throw new Error("the linked task is missing from the fixture");
    await source.importTask(
      {
        ...linked,
        id: "task-detached",
        detachedAt: "2026-09-13T09:30:00.000Z",
        done: true,
        doneAt: "2026-09-13T09:29:00.000Z",
      },
      "",
    );

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    const applied = await applyPortableBundle(destination, checked.bundle);
    const importedPageId = applied.rootIds[0];

    // The manifest schema is strict over the live record schema, so the field
    // rides with no archive code of its own. This is what proves it.
    const landed = destination
      .allTasks()
      .find((task) => task.id === "task-detached");
    expect(landed).toBeDefined();
    expect(landed?.detachedAt).toBe("2026-09-13T09:30:00.000Z");
    expect(landed?.done).toBe(true);
    expect(landed?.doneAt).toBe("2026-09-13T09:29:00.000Z");
    expect(landed?.anchor).toEqual(anchor);
    // The page id is remapped like any other, because the row still names it.
    expect(landed?.page).toBe(importedPageId);
    expect(landed?.page).not.toBe(pageId);
    // And a detached record owns its completion, so it reads as done on the
    // far side rather than waiting for a checkbox nobody will tick.
    expect(destination.getTask("task-detached")?.done).toBe(true);
  });

  it("imports a task whose page id is absent as detached, keeping its schedule and title", async () => {
    const { source } = await notebookWithTasks();
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const orphaned = repack(exported.bytes, (manifest) => {
      for (const task of manifest.tasks as Array<{
        record: Record<string, unknown>;
      }>) {
        if (task.record.page === undefined) continue;
        task.record.page = "a-page-this-archive-never-carried";
        task.record.when = "2026-09-20";
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

  it("brings a linked completion across, without waiting for the next save of its page", async () => {
    // The note owns a linked task's `done`, so the record carries none and the
    // checkbox in the markdown is the whole answer. The import writes the
    // pages before it lands the records, so the reconcile each page write runs
    // finds no records to reconcile and the index is never told. Without a
    // sweep afterwards every imported completion reads as open, in Today, with
    // a ticked box on its own line.
    const source = await temporaryStore();
    const page = await source.createPage(null, "Planning");
    await source.writePage(page.id, "- [ ] Draft the plan", undefined, "me");
    await source.createTask({
      title: "Draft the plan",
      page: page.id,
      anchor: anchorFor("Draft the plan", 0),
    });
    await source.writePage(page.id, "- [x] Draft the plan", undefined, "me");

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    const applied = await applyPortableBundle(destination, checked.bundle);
    const importedPageId = applied.rootIds[0];

    const landed = destination
      .allTasks()
      .find((task) => task.title === "Draft the plan");
    expect(landed?.page).toBe(importedPageId);
    // Through the view, because a linked record stores no `done` at all: the
    // index is where the checkbox's answer lives.
    expect(destination.getTask(landed!.id)?.done).toBe(true);
    expect(
      destination
        .listTasks(TODAY, { offsetMinutes: 0, list: "logbook" })
        .map((task) => task.title),
    ).toContain("Draft the plan");
    expect(
      destination
        .listTasks(TODAY, { offsetMinutes: 0, list: "today" })
        .map((task) => task.title),
    ).not.toContain("Draft the plan");
  });

  it("imports a notebook whose trash was emptied on a page holding a finished task", async () => {
    // The shape the spec's own purge rule mints (row 149): the done record is
    // kept, detached, with `page` naming a page no export can carry. The
    // archive has no page to remap it to, so the link goes, and `detachedAt`
    // has to go with it, or the record is refused on the way in and the whole
    // import rolls back into the Trash.
    const source = await temporaryStore();
    const kept = await source.createPage(null, "Still here");
    await source.writePage(kept.id, "Nothing to do here.", undefined, "me");
    const doomed = await source.createPage(null, "Old plans");
    await source.writePage(doomed.id, "- [ ] Draft the plan", undefined, "me");
    await source.createTask({
      title: "Draft the plan",
      page: doomed.id,
      anchor: anchorFor("Draft the plan", 0),
    });
    await source.writePage(doomed.id, "- [x] Draft the plan", undefined, "me");
    await source.deletePage(doomed.id);
    await source.purgePage(doomed.id);

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    const applied = await applyPortableBundle(destination, checked.bundle);

    // Every page lands: the rollback would have moved this one to the Trash.
    expect(applied.created).toBe(1);
    expect(destination.getTree().map((page) => page.title)).toEqual([
      "Still here",
    ]);
    expect(kept.id).toBeDefined();

    const landed = destination
      .allTasks()
      .find((task) => task.title === "Draft the plan");
    expect(landed).toBeDefined();
    expect(landed?.page).toBeUndefined();
    expect(landed?.anchor).toBeUndefined();
    expect(landed?.detachedAt).toBeUndefined();
    // It owns its completion, so it reads in the Logbook rather than coming
    // back open in the Inbox.
    expect(landed?.done).toBe(true);
    expect(
      destination
        .listTasks(TODAY, { offsetMinutes: 0, list: "logbook" })
        .map((task) => task.title),
    ).toContain("Draft the plan");
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

  it("preserves the file body after the frontmatter byte for byte through export and import", async () => {
    // The shapes a person writes into a task file by hand. The first is the
    // one that used to lose its whole leading block, the second the one that
    // used to gain a newline it never had.
    const bodies = [
      "---\nkey: value\n---\n\npara\n",
      "no trailing newline",
      "a\n---\nb\n",
      "The consulate wants two photos.\n\n  Indented, and kept.\n",
    ];
    const source = await temporaryStore();
    await source.createPage(null, "Anything");
    for (const [index, body] of bodies.entries()) {
      await source.importTask(
        {
          id: `task-noted-${index}`,
          title: "Renew the visa",
          done: false,
          created: "2026-06-01T09:00:00.000Z",
          updated: "2026-06-01T09:00:00.000Z",
        },
        body,
      );
    }
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    expect(
      exported.manifest.tasks?.map((task) => task.bodyPath),
    ).toEqual([
      "tasks/t000001.md",
      "tasks/t000002.md",
      "tasks/t000003.md",
      "tasks/t000004.md",
    ]);

    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    await applyPortableBundle(destination, checked.bundle);
    for (const [index, body] of bodies.entries()) {
      expect(await destination.readTaskBody(`task-noted-${index}`)).toBe(body);
    }
    // A fence in the body is not a second frontmatter block: the records came
    // back whole.
    expect(destination.allTasks()).toHaveLength(bodies.length);
    expect(
      destination.allTasks().every((task) => task.title === "Renew the visa"),
    ).toBe(true);
  });

  it("writes no body file for a task that has no body", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Anything");
    await source.createTask({ title: "Water the plants" });
    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });

    expect(exported.manifest.tasks?.[0].bodyPath).toBeUndefined();
    expect(
      [...readPortableArchive(exported.bytes).keys()].filter((entry) =>
        entry.startsWith("tasks/"),
      ),
    ).toEqual([]);
  });

  it("carries a task whose page is in the Trash", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Still here");
    const page = await source.createPage(null, "Cancelled trip");
    const linked = await source.createTask({
      title: "Book the flight",
      page: page.id,
      anchor: anchorFor("Book the flight", 0),
    });
    await source.deletePage(page.id);
    // The list view cannot see it. The archive still has to.
    expect(source.listTasks(TODAY, { offsetMinutes: 0 })).toEqual([]);

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    await applyPortableBundle(destination, checked.bundle);

    const before = source.allTasks().find((task) => task.id === linked.id)!;
    const after = destination.allTasks();
    expect(after).toHaveLength(1);
    // Its page did not come with it, so it lands detached. Everything else is
    // the record it left with, id and timestamps included.
    const detached = { ...before };
    delete detached.page;
    delete detached.anchor;
    expect(after[0]).toEqual(detached);
  });

  it("carries a completion 45 days old", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Anything");
    const record = {
      id: "task-old",
      title: "Renew the visa",
      done: true,
      doneAt: "2026-07-30T09:00:00.000Z",
      created: "2026-06-01T09:00:00.000Z",
      updated: "2026-07-30T09:00:00.000Z",
    };
    await source.importTask(record, "");
    expect(source.listTasks(TODAY, { offsetMinutes: 0 })).toEqual([]);

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    await applyPortableBundle(destination, checked.bundle);
    expect(destination.allTasks()).toEqual([record]);
  });

  it("carries a repeating task with two log entries", async () => {
    const source = await temporaryStore();
    await source.createPage(null, "Anything");
    const record = {
      id: "task-weekly",
      title: "Weekly review",
      when: "2026-09-14",
      category: "Work",
      done: false,
      repeat: { freq: "weekly" as const, byWeekday: ["mon" as const] },
      log: [
        { scheduled: "2026-08-31", completedAt: "2026-08-31T18:00:00.000Z" },
        { scheduled: "2026-09-07", completedAt: "2026-09-07T18:00:00.000Z" },
      ],
      created: "2026-08-24T09:00:00.000Z",
      updated: "2026-09-07T18:00:00.000Z",
    };
    await source.importTask(record, "");

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    await applyPortableBundle(destination, checked.bundle);
    expect(destination.allTasks()).toEqual([record]);
  });

  it("keeps a linked task's record byte for byte apart from the page it points at", async () => {
    const { source, pageId } = await notebookWithTasks();
    const before = source
      .allTasks()
      .find((task) => task.page === pageId)!;

    const exported = await buildPortableArchive(source, { now: EXPORTED_AT });
    const destination = await temporaryStore();
    const checked = validatePortableArchive(exported.bytes, destination);
    const applied = await applyPortableBundle(destination, checked.bundle);

    const after = destination.allTasks().find((task) => task.id === before.id)!;
    expect(after).toEqual({ ...before, page: applied.rootIds[0] });
  });
});
