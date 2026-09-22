import { createHash } from "node:crypto";
import { z } from "zod";
import {
  attachmentMimeTypeForName,
  localAttachmentName,
  referencedAttachmentUrls,
} from "@/lib/attachments";
import {
  APP_ENTRY_PATH,
  appAssetPath,
  appMetaSchema,
} from "@/lib/apps/model";
import {
  collectionDefinitionSchema,
  collectionRowSchema,
} from "@/lib/collections/model";
import type { Store, TreeNode } from "@/lib/store";
import { type TaskRecord, taskRecordSchema } from "@/lib/tasks/model";
import { createPortableArchive, readPortableArchive } from "./archive";

export const PORTABLE_FORMAT = "brain-portable" as const;
/** Version 2 is the first to carry tasks; version 3 the first to carry an app
 *  page's own files. Every version is read. A 1 or a 2 imports exactly as it
 *  did before its bump, because refusing the exports people already hold
 *  would cost them their data and buy nothing. The other direction does not
 *  hold and cannot: both schemas here are strict, so a Brain older than this
 *  release refuses a version 3 archive rather than dropping the key it does
 *  not know. That is the trade 0.10.0 made for tasks, in the same words. */
export const PORTABLE_VERSION = 3 as const;
const portableVersionSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const MAX_PORTABLE_PAGES = 5_000;
const MAX_PAGE_MARKDOWN_BYTES = 10 * 1024 * 1024;

const safeText = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
    );

const stickerSchema = z
  .object({
    id: safeText(128),
    x: z.number().finite(),
    y: z.number().finite(),
    text: safeText(10_000),
  })
  .strict();

const portableMetaSchema = z
  .object({
    title: safeText(1_000, 1),
    icon: safeText(64).optional(),
    coverAsset: z.string().regex(/^assets\/[A-Za-z0-9_.-]+$/).optional(),
    category: safeText(200).optional(),
    pinned: z.boolean().optional(),
    status: safeText(200).optional(),
    view: z.enum(["board", "sections"]).optional(),
    font: z.enum(["sans", "serif", "mono"]).optional(),
    smallText: z.boolean().optional(),
    fullWidth: z.boolean().optional(),
    sections: z.array(safeText(200)).max(128).optional(),
    tags: z.array(safeText(200)).max(128).optional(),
    // Accepted, never applied. The schema is strict, so an archive exported
    // before the Inbox was removed would fail to import without this key.
    // Nothing reads it and no export writes it — do not wire it to anything.
    inbox: z.boolean().optional(),
    stickers: z.array(stickerSchema).max(256).optional(),
    collection: z.unknown().optional(),
    collectionRow: z.unknown().optional(),
  })
  .strict();

/** AN APP PAGE'S FILES, BY THE PATHS THEY TAKE IN THE ZIP.
 *
 *  Under `app/<page index>/`, keyed by the same index the markdown path uses,
 *  so one page's files are one folder a person can open. Not under `assets/`,
 *  which is the attachment namespace: every entry there is handed to
 *  `store.saveAttachment` on import and would land as a loose file nothing
 *  references.
 *
 *  `meta` is the `app` map itself, carried as `unknown` and parsed through
 *  `appMetaSchema` on import, the way `collection` already is. `owns` inside
 *  it names ids from the EXPORTING notebook, which the import remaps, so it
 *  is never written through unchanged. */
const portableAppSchema = z
  .object({
    meta: z.unknown(),
    entryPath: z.string().regex(/^app\/p\d{6}\/index\.html$/),
    assets: z
      .array(
        z
          .object({
            name: z.string().max(512),
            archivePath: z
              .string()
              .regex(/^app\/p\d{6}\/assets\/[A-Za-z0-9_./-]{1,512}$/),
          })
          .strict(),
      )
      .max(256),
    statePath: z.string().regex(/^app\/p\d{6}\/state\.json$/).optional(),
  })
  .strict();

const portablePageSchema = z
  .object({
    sourceId: safeText(128, 1),
    parentSourceId: safeText(128, 1).nullable(),
    markdownPath: z.string().regex(/^pages\/p\d{6}\.md$/),
    meta: portableMetaSchema,
    app: portableAppSchema.optional(),
  })
  .strict();

const portableAttachmentSchema = z
  .object({
    archivePath: z
      .string()
      .regex(/^assets\/[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,31})?$/),
    originalName: safeText(256, 1),
    mimeType: z
      .string()
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/),
    size: z.number().int().min(0).max(25 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

/** One task, carried whole.
 *
 *  `record` is the task record itself, through the very schema the store
 *  writes to disk: every field, nothing picked and nothing renamed, so a
 *  notebook that travels arrives with its completions, its repeat logs and its
 *  hand-set timestamps intact. A field added to the record later rides with no
 *  change here, which is the point of carrying the schema rather than a copy
 *  of its field list.
 *
 *  `record.page` names the page by the id it had in the exporting notebook,
 *  the way `parentSourceId` names a parent, and the import maps it. `bodyPath`
 *  is there only when the file had a body under its frontmatter.
 */
const portableTaskSchema = z
  .object({
    record: taskRecordSchema,
    bodyPath: z.string().regex(/^tasks\/t\d{6}\.md$/).optional(),
  })
  .strict();

export const portableManifestSchema = z
  .object({
    format: z.literal(PORTABLE_FORMAT),
    version: portableVersionSchema,
    exportedAt: z.string().datetime(),
    scope: z.enum(["all", "subtree"]),
    title: safeText(1_000, 1),
    pages: z.array(portablePageSchema).min(1).max(MAX_PORTABLE_PAGES),
    attachments: z.array(portableAttachmentSchema).max(MAX_PORTABLE_PAGES * 4),
    tasks: z.array(portableTaskSchema).max(MAX_PORTABLE_PAGES * 4).optional(),
  })
  .strict();

export type PortableManifest = z.infer<typeof portableManifestSchema>;
export type PortablePage = PortableManifest["pages"][number];
export type PortableTask = z.infer<typeof portableTaskSchema>;

export interface PortableBundle {
  manifest: PortableManifest;
  markdown: Map<string, string>;
  attachments: Map<string, Uint8Array>;
  /** The body each `bodyPath` names, decoded and untrimmed. */
  taskBodies: Map<string, string>;
  /** Every entry under `app/`, by its archive path. Filled the way
   *  `attachments` is, so the restore looks each file up by the name the
   *  manifest gave it rather than by walking the archive again. */
  appFiles: Map<string, Uint8Array>;
  /** Each app's state, already parsed, by the same archive path. Parsed
   *  during validation rather than during the restore, so a state file that
   *  is not JSON is one refusal among the archive's others and not a bare
   *  SyntaxError half way through an import. */
  appState: Map<string, unknown>;
}

export interface PortableImportSummary {
  title: string;
  pages: number;
  rootPages: number;
  attachments: number;
  attachmentBytes: number;
  collections: number;
  tasks: number;
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (items: TreeNode[]) => {
    for (const item of items) {
      out.push(item);
      walk(item.children);
    }
  };
  walk(nodes);
  return out;
}

function findNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function replaceKnown(value: string, replacements: Map<string, string>): string {
  let result = value;
  for (const [source, target] of [...replacements].sort(
    ([left], [right]) => right.length - left.length,
  )) {
    result = result.replaceAll(source, target);
  }
  return result;
}

/** The tasks one export carries, each with the body its file holds.
 *
 *  A whole notebook export carries every record the index has, with nothing
 *  filtered: a task whose page is in the Trash and a completion older than the
 *  Logbook window are in no list, and an archive that dropped them would not
 *  be the notebook. A subtree export carries the tasks of the pages it is
 *  carrying, and leaves the rest of the notebook where it is.
 *
 *  Records are ordered by id so two exports of one notebook number their body
 *  files the same way.
 */
async function exportedTasks(
  store: Store,
  rootId: string | undefined,
  nodeIds: Set<string>,
): Promise<{ entries: PortableTask[]; bodies: string[] }> {
  const records = store
    .allTasks()
    .filter(
      (task) =>
        rootId === undefined ||
        (task.page !== undefined && nodeIds.has(task.page)),
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const bodies = await Promise.all(
    records.map((task) => store.readTaskBody(task.id)),
  );
  let files = 0;
  const entries = records.map((record, index) =>
    bodies[index]
      ? {
          record,
          bodyPath: `tasks/t${String(++files).padStart(6, "0")}.md`,
        }
      : { record },
  );
  return { entries, bodies };
}

export async function buildPortableArchive(
  store: Store,
  options: { rootId?: string; now?: Date } = {},
): Promise<{
  bytes: Uint8Array;
  manifest: PortableManifest;
  /** The ids of pages that say `kind: app` whose files this archive does not
   *  carry. Empty on every ordinary notebook. */
  skippedApps: string[];
}> {
  const tree = store.getTree();
  const selected = options.rootId
    ? (() => {
        const root = findNode(tree, options.rootId);
        if (!root) throw new Error("portable export root was not found");
        return [root];
      })()
    : tree;
  const nodes = flatten(selected);
  if (nodes.length === 0) throw new Error("there are no pages to export");
  const nodeIds = new Set(nodes.map((node) => node.id));
  const pagePaths = new Map(
    nodes.map((node, index) => [
      node.id,
      `pages/p${String(index + 1).padStart(6, "0")}.md`,
    ]),
  );
  const pages = await Promise.all(nodes.map((node) => store.readPage(node.id)));
  const attachmentUrls = new Map<string, Set<string>>();
  for (const page of pages) {
    for (const url of referencedAttachmentUrls(page.markdown)) {
      const name = localAttachmentName(url);
      if (!name) continue;
      const urls = attachmentUrls.get(name) ?? new Set<string>();
      urls.add(url);
      attachmentUrls.set(name, urls);
    }
    const coverName = page.meta.cover
      ? localAttachmentName(page.meta.cover)
      : null;
    if (coverName && page.meta.cover) {
      const urls = attachmentUrls.get(coverName) ?? new Set<string>();
      urls.add(page.meta.cover);
      attachmentUrls.set(coverName, urls);
    }
  }

  const attachmentEntries: Array<{
    archivePath: string;
    originalName: string;
    mimeType: string;
    data: Uint8Array;
    sha256: string;
  }> = [];
  for (const name of [...attachmentUrls.keys()].sort()) {
    const data = await store.readPortableAttachment(name);
    attachmentEntries.push({
      archivePath: `assets/${name}`,
      originalName: name,
      // The one extension-to-MIME list, in `lib/attachments.ts`. It holds the
      // same thirteen types this module used to keep its own copy of, so the
      // manifest an export writes is unchanged.
      mimeType: attachmentMimeTypeForName(name),
      data,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  }
  const assetReplacements = new Map<string, string>();
  for (const attachment of attachmentEntries) {
    const name = attachment.archivePath.slice("assets/".length);
    for (const url of attachmentUrls.get(name) ?? []) {
      assetReplacements.set(url, `../${attachment.archivePath}`);
    }
  }
  const pageReplacements = new Map<string, string>();
  for (const node of nodes) {
    pageReplacements.set(`/p/${node.id}`, `./${pagePaths.get(node.id)!.slice("pages/".length)}`);
  }

  // One folder per app page, named by the same index its markdown takes.
  const appEntries: Array<{ path: string; data: Uint8Array }> = [];
  const appManifests = new Map<string, NonNullable<PortablePage["app"]>>();
  // A page that says `kind: app` whose files this export could not carry,
  // because the map does not validate or the entry is gone. It travels as an
  // ordinary page and the caller is handed the list, rather than left to find
  // out on the next import.
  const skippedApps: string[] = [];
  for (const node of nodes) {
    const app = store.readAppMeta(node.id);
    if (app === null) {
      if (node.kind === "app") skippedApps.push(node.id);
      continue;
    }
    const prefix = `app/p${pagePaths
      .get(node.id)!
      .slice("pages/p".length, -".md".length)}`;
    const entry = await store.readAppFile(node.id, APP_ENTRY_PATH);
    // An app page whose entry has gone is exported as an ordinary page. The
    // archive is a copy of what is there, not a repair of what is not.
    if (entry.kind !== "file") {
      skippedApps.push(node.id);
      continue;
    }
    appEntries.push({ path: `${prefix}/index.html`, data: entry.data });
    const assets: { name: string; archivePath: string }[] = [];
    for (const name of await store.listAppAssets(node.id)) {
      const asset = await store.readAppFile(node.id, appAssetPath(name)!);
      if (asset.kind !== "file") continue;
      assets.push({ name, archivePath: `${prefix}/assets/${name}` });
      appEntries.push({ path: `${prefix}/assets/${name}`, data: asset.data });
    }
    const state = app.state ? await store.readAppState(node.id) : null;
    if (state !== null) {
      appEntries.push({
        path: `${prefix}/state.json`,
        data: new TextEncoder().encode(JSON.stringify(state)),
      });
    }
    appManifests.set(node.id, {
      meta: app,
      entryPath: `${prefix}/index.html`,
      assets,
      ...(state !== null ? { statePath: `${prefix}/state.json` } : {}),
    });
  }

  const manifestPages: PortableManifest["pages"] = pages.map((page) => {
    const node = nodes.find((candidate) => candidate.id === page.meta.id)!;
    const coverName = page.meta.cover
      ? localAttachmentName(page.meta.cover)
      : null;
    return {
      sourceId: page.meta.id,
      parentSourceId:
        node.parentId && nodeIds.has(node.parentId) ? node.parentId : null,
      markdownPath: pagePaths.get(page.meta.id)!,
      meta: {
        title: page.meta.title,
        ...(page.meta.icon ? { icon: page.meta.icon } : {}),
        ...(coverName ? { coverAsset: `assets/${coverName}` } : {}),
        ...(page.meta.category ? { category: page.meta.category } : {}),
        ...(page.meta.pinned ? { pinned: true } : {}),
        ...(page.meta.status ? { status: page.meta.status } : {}),
        ...(page.meta.view ? { view: page.meta.view } : {}),
        ...(page.meta.font ? { font: page.meta.font } : {}),
        ...(page.meta.smallText ? { smallText: true } : {}),
        ...(page.meta.fullWidth ? { fullWidth: true } : {}),
        ...(page.meta.sections ? { sections: page.meta.sections } : {}),
        ...(page.meta.tags ? { tags: page.meta.tags } : {}),
        ...(page.meta.stickers ? { stickers: page.meta.stickers } : {}),
        ...(page.meta.collection ? { collection: page.meta.collection } : {}),
        ...(page.meta.collectionRow
          ? { collectionRow: page.meta.collectionRow }
          : {}),
      },
      ...(appManifests.has(page.meta.id)
        ? { app: appManifests.get(page.meta.id) }
        : {}),
    };
  });
  const exportedAt = options.now ?? new Date();
  const tasks = await exportedTasks(store, options.rootId, nodeIds);
  const manifest = portableManifestSchema.parse({
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    exportedAt: exportedAt.toISOString(),
    scope: options.rootId ? "subtree" : "all",
    title: options.rootId ? nodes[0].title : "Brain",
    pages: manifestPages,
    attachments: attachmentEntries.map((entry) => ({
      archivePath: entry.archivePath,
      originalName: entry.originalName,
      mimeType: entry.mimeType,
      size: entry.data.byteLength,
      sha256: entry.sha256,
    })),
    // A notebook with no tasks writes a version 2 manifest with no `tasks`
    // key, which is byte for byte what a version 1 manifest carried.
    ...(tasks.entries.length > 0 ? { tasks: tasks.entries } : {}),
  });
  const entries = [
    {
      path: "manifest.json",
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
    },
    ...pages.map((page) => ({
      path: pagePaths.get(page.meta.id)!,
      data: new TextEncoder().encode(
        replaceKnown(
          replaceKnown(page.markdown, assetReplacements),
          pageReplacements,
        ).trimEnd() + "\n",
      ),
    })),
    ...attachmentEntries.map((entry) => ({
      path: entry.archivePath,
      data: entry.data,
    })),
    ...appEntries,
    // Only the tasks that have one. The body is written raw, with no trim,
    // because the promise the store's own writer makes about it is byte for
    // byte and an export is not the place to start editing somebody's file.
    ...tasks.entries.flatMap((task, index) =>
      task.bodyPath
        ? [
            {
              path: task.bodyPath,
              data: new TextEncoder().encode(tasks.bodies[index]),
            },
          ]
        : [],
    ),
  ];
  return { bytes: createPortableArchive(entries), manifest, skippedApps };
}

function orderedPages(pages: PortablePage[]): PortablePage[] {
  const byId = new Map(pages.map((page) => [page.sourceId, page]));
  if (byId.size !== pages.length) throw new Error("portable manifest has duplicate page ids");
  const ordered: PortablePage[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (page: PortablePage) => {
    if (visited.has(page.sourceId)) return;
    if (visiting.has(page.sourceId)) {
      throw new Error("portable manifest page hierarchy has a cycle");
    }
    visiting.add(page.sourceId);
    if (page.parentSourceId) {
      const parent = byId.get(page.parentSourceId);
      if (!parent) throw new Error("portable manifest references a missing parent");
      visit(parent);
    }
    visiting.delete(page.sourceId);
    visited.add(page.sourceId);
    ordered.push(page);
  };
  for (const page of pages) visit(page);
  return ordered;
}

export function validatePortableArchive(
  input: Uint8Array,
  store?: Pick<Store, "validatePortableAttachment">,
): { bundle: PortableBundle; summary: PortableImportSummary } {
  const entries = readPortableArchive(input);
  const manifestBytes = entries.get("manifest.json")!;
  if (manifestBytes.byteLength > 5 * 1024 * 1024) {
    throw new Error("portable manifest is too large");
  }
  let manifest: PortableManifest;
  try {
    manifest = portableManifestSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    );
  } catch {
    throw new Error("portable manifest is invalid");
  }
  if (manifest.version === 1 && manifest.tasks) {
    throw new Error("portable manifest is version 1 and cannot carry tasks");
  }
  if (manifest.version < 3 && manifest.pages.some((page) => page.app)) {
    throw new Error("portable manifest is older than version 3 and cannot carry app files");
  }
  orderedPages(manifest.pages);
  const expectedEntries = new Set(["manifest.json"]);
  const markdown = new Map<string, string>();
  const pagePaths = new Set<string>();
  for (const page of manifest.pages) {
    if (pagePaths.has(page.markdownPath)) {
      throw new Error("portable manifest has duplicate page files");
    }
    pagePaths.add(page.markdownPath);
    expectedEntries.add(page.markdownPath);
    const data = entries.get(page.markdownPath);
    if (!data || data.byteLength > MAX_PAGE_MARKDOWN_BYTES) {
      throw new Error(`portable page is missing or too large: ${page.markdownPath}`);
    }
    try {
      markdown.set(
        page.markdownPath,
        new TextDecoder("utf-8", { fatal: true }).decode(data).trimEnd(),
      );
    } catch {
      throw new Error(`portable page is not UTF-8: ${page.markdownPath}`);
    }
    if (page.meta.collection) collectionDefinitionSchema.parse(page.meta.collection);
    if (page.meta.collectionRow) collectionRowSchema.parse(page.meta.collectionRow);
    if (page.meta.collection && page.meta.collectionRow) {
      throw new Error("portable page cannot be both a collection and a row");
    }
  }
  const attachments = new Map<string, Uint8Array>();
  const attachmentPaths = new Set<string>();
  let attachmentBytes = 0;
  for (const attachment of manifest.attachments) {
    if (attachmentPaths.has(attachment.archivePath)) {
      throw new Error("portable manifest has duplicate attachments");
    }
    attachmentPaths.add(attachment.archivePath);
    expectedEntries.add(attachment.archivePath);
    const data = entries.get(attachment.archivePath);
    const digest = data
      ? createHash("sha256").update(data).digest("hex")
      : "";
    if (
      !data ||
      data.byteLength !== attachment.size ||
      digest !== attachment.sha256
    ) {
      throw new Error(`portable attachment failed verification: ${attachment.archivePath}`);
    }
    store?.validatePortableAttachment({
      data,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
    });
    attachments.set(attachment.archivePath, data);
    attachmentBytes += data.byteLength;
  }
  // An app's files get the presence check the markdown and the attachments
  // already get: every path the manifest names is an entry the archive holds,
  // and the unlisted-file sweep below then makes the converse true, so no
  // file rides under `app/` that no page claims.
  const appFiles = new Map<string, Uint8Array>();
  const appState = new Map<string, unknown>();
  for (const page of manifest.pages) {
    if (!page.app) continue;
    const prefix = page.app.entryPath.slice(0, -"/index.html".length);
    const paths = [
      page.app.entryPath,
      ...page.app.assets.map((asset) => asset.archivePath),
      ...(page.app.statePath ? [page.app.statePath] : []),
    ];
    for (const appPath of paths) {
      // Every one of the three keys carries its own page index in its regex,
      // and they have to be the SAME index: a page naming another page's
      // folder would restore one app's assets under a second app.
      if (!appPath.startsWith(`${prefix}/`)) {
        throw new Error(`portable app file is outside its own folder: ${appPath}`);
      }
      if (appFiles.has(appPath)) {
        throw new Error(`portable manifest has duplicate app files: ${appPath}`);
      }
      expectedEntries.add(appPath);
      const data = entries.get(appPath);
      if (!data) throw new Error(`portable app file is missing: ${appPath}`);
      appFiles.set(appPath, data);
    }
    // The state file is the one app entry with a shape, and the restore hands
    // it straight to `JSON.parse`. Read here, where every other malformed
    // archive is caught and named, it is one refusal among its peers; left to
    // the restore it arrives as a bare SyntaxError after the import has
    // begun, and the owner reads a parser's words about a file they never
    // saw.
    if (page.app.statePath) {
      try {
        appState.set(
          page.app.statePath,
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              appFiles.get(page.app.statePath)!,
            ),
          ),
        );
      } catch {
        throw new Error(`portable app state is not JSON: ${page.app.statePath}`);
      }
    }
  }
  const taskBodies = new Map<string, string>();
  for (const task of manifest.tasks ?? []) {
    if (!task.bodyPath) continue;
    if (taskBodies.has(task.bodyPath)) {
      throw new Error("portable manifest has duplicate task bodies");
    }
    expectedEntries.add(task.bodyPath);
    const data = entries.get(task.bodyPath);
    if (!data || data.byteLength > MAX_PAGE_MARKDOWN_BYTES) {
      throw new Error(`portable task body is missing or too large: ${task.bodyPath}`);
    }
    try {
      // No trim. The body is what the file held after its frontmatter and it
      // goes back exactly that way.
      taskBodies.set(
        task.bodyPath,
        new TextDecoder("utf-8", { fatal: true }).decode(data),
      );
    } catch {
      throw new Error(`portable task body is not UTF-8: ${task.bodyPath}`);
    }
  }
  for (const path of entries.keys()) {
    if (!expectedEntries.has(path)) {
      throw new Error(`portable archive contains an unlisted file: ${path}`);
    }
  }
  for (const page of manifest.pages) {
    if (page.meta.coverAsset && !attachments.has(page.meta.coverAsset)) {
      throw new Error("portable page cover is missing");
    }
    if (page.meta.collectionRow) {
      const parent = manifest.pages.find(
        (candidate) => candidate.sourceId === page.parentSourceId,
      );
      const row = collectionRowSchema.parse(page.meta.collectionRow);
      const collection = parent?.meta.collection
        ? collectionDefinitionSchema.parse(parent.meta.collection)
        : null;
      if (!collection || collection.databaseId !== row.databaseId) {
        throw new Error("portable collection row has an invalid parent");
      }
    }
  }
  return {
    bundle: { manifest, markdown, attachments, taskBodies, appFiles, appState },
    summary: {
      title: manifest.title,
      pages: manifest.pages.length,
      rootPages: manifest.pages.filter((page) => page.parentSourceId === null).length,
      attachments: manifest.attachments.length,
      attachmentBytes,
      collections: manifest.pages.filter((page) => page.meta.collection).length,
      tasks: manifest.tasks?.length ?? 0,
    },
  };
}

export async function applyPortableBundle(
  store: Store,
  bundle: PortableBundle,
  options: { parentId?: string | null; src?: string } = {},
): Promise<{ rootIds: string[]; created: number; tasks: number }> {
  const ordered = orderedPages(bundle.manifest.pages);
  const assetUrls = new Map<string, string>();
  for (const attachment of bundle.manifest.attachments) {
    const saved = await store.saveAttachment(
      {
        data: bundle.attachments.get(attachment.archivePath)!,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
      },
      options.src,
    );
    assetUrls.set(attachment.archivePath, saved.url);
  }
  const created = new Map<string, string>();
  const rootIds: string[] = [];
  const createdTasks: string[] = [];
  const landedPages = new Set<string>();
  try {
    for (const page of ordered) {
      const parentId = page.parentSourceId
        ? created.get(page.parentSourceId)!
        : (options.parentId ?? null);
      const meta = await store.createPage(parentId, page.meta.title, {
        icon: page.meta.icon,
        cover: page.meta.coverAsset
          ? assetUrls.get(page.meta.coverAsset)
          : undefined,
        status: page.meta.status,
        font: page.meta.font,
        smallText: page.meta.smallText,
        fullWidth: page.meta.fullWidth,
        by: "me",
        src: options.src,
      });
      created.set(page.sourceId, meta.id);
      if (page.parentSourceId === null) rootIds.push(meta.id);
      // AN APP PAGE SAYS SO BEFORE ITS CHILDREN EXIST.
      //
      // `ordered` puts a parent before its children, and `slugify("App")` is
      // `app`, the folder name an app's own file set uses. In the exporting
      // notebook such a child was pushed aside because the app's folder was
      // already on disk; here nothing holds it yet, so the child took it and
      // the metadata write below refused the WHOLE archive. A notebook that
      // cannot be restored from its own backup is worse than either.
      //
      // `owns` waits for the loop that remaps it: the ids this import mints
      // are not known until every page is created.
      if (page.app) {
        await store.setAppMeta(
          meta.id,
          appMetaSchema.parse({
            ...appMetaSchema.parse(page.app.meta),
            owns: [],
            state: page.app.statePath !== undefined,
          }),
          "me",
          options.src,
        );
      }
    }
    const pageLinks = new Map<string, string>();
    for (const page of ordered) {
      pageLinks.set(
        `./${page.markdownPath.slice("pages/".length)}`,
        `/p/${created.get(page.sourceId)!}`,
      );
    }
    const assetLinks = new Map(
      [...assetUrls].map(([archivePath, url]) => [`../${archivePath}`, url]),
    );
    for (const page of ordered) {
      const id = created.get(page.sourceId)!;
      const markdown = replaceKnown(
        replaceKnown(bundle.markdown.get(page.markdownPath)!, assetLinks),
        pageLinks,
      );
      await store.writePage(id, markdown, undefined, "me", options.src);
      await store.updateMeta(id, {
        category: page.meta.category,
        pinned: page.meta.pinned,
        status: page.meta.status,
        view: page.meta.view,
        font: page.meta.font,
        smallText: page.meta.smallText,
        fullWidth: page.meta.fullWidth,
        sections: page.meta.sections,
        tags: page.meta.tags,
        stickers: page.meta.stickers,
        by: "me",
        src: options.src,
      });
    }
    for (const page of ordered.filter((item) => item.meta.collection)) {
      await store.applyPortableCollectionMeta(
        created.get(page.sourceId)!,
        page.meta.collection,
        undefined,
        options.src,
      );
    }
    for (const page of ordered.filter((item) => item.meta.collectionRow)) {
      await store.applyPortableCollectionMeta(
        created.get(page.sourceId)!,
        undefined,
        page.meta.collectionRow,
        options.src,
      );
    }
    for (const page of ordered.filter((item) => item.app !== undefined)) {
      const id = created.get(page.sourceId)!;
      const app = page.app!;
      // The map again, this time with `owns`. It names ids from the exporting
      // notebook, so it is remapped onto the ids this import minted, and an
      // id the archive did not carry is dropped: an app that may write a page
      // it cannot see is a refusal waiting to confuse somebody. The rest of
      // the map is what the create loop already wrote, so a restore that dies
      // here leaves an app that runs and owns nothing rather than a page with
      // no `kind`.
      //
      // Still before the files: `writeAppFiles` refuses a page that is not an
      // app, which is what stops its rename pair carrying a child page whose
      // folder is `app/` out of the tree.
      const source = appMetaSchema.parse(app.meta);
      await store.setAppMeta(
        id,
        appMetaSchema.parse({
          ...source,
          owns: source.owns
            .map((owned) => created.get(owned))
            .filter((owned): owned is string => owned !== undefined),
          state: app.statePath !== undefined,
        }),
        "me",
        options.src,
      );
      await store.writeAppFiles(id, {
        entryHtml: new TextDecoder().decode(bundle.appFiles.get(app.entryPath)!),
        assets: app.assets.map((asset) => ({
          name: asset.name,
          data: bundle.appFiles.get(asset.archivePath)!,
        })),
        ...(app.statePath === undefined
          ? {}
          : { state: bundle.appState.get(app.statePath) }),
      });
    }
    // Every task goes in through the store's own leaf, so the task index is
    // right the moment this returns and the note edits and the task writes
    // land in one git commit together.
    for (const task of bundle.manifest.tasks ?? []) {
      const record: TaskRecord = { ...task.record };
      if (record.page !== undefined) {
        const pageId = created.get(record.page);
        if (pageId) {
          // The page it names was minted fresh a moment ago, the way every
          // other reference in the archive is remapped.
          record.page = pageId;
        } else {
          // A task naming a page this archive does not carry is imported
          // unlinked, keeping its schedule, its completion and its last known
          // title. Its anchor named a line in a note nobody here has, so it
          // goes with the link rather than pointing at a stranger's page.
          //
          // `detachedAt` goes too, and it is the one that matters: a detach
          // is a link that was broken, and the record schema refuses the mark
          // without the page it names. The purge rule mints exactly that
          // record, a finished linked task whose page is gone, so a
          // notebook that has ever emptied its trash exports an archive that
          // would throw on the way in and roll every imported page into the
          // Trash. Unlinked and done says the same thing to a reader, in a
          // shape the schema accepts.
          delete record.page;
          delete record.anchor;
          delete record.detachedAt;
        }
      }
      const landed = await store.importTask(
        record,
        task.bodyPath ? (bundle.taskBodies.get(task.bodyPath) ?? "") : "",
        options.src,
      );
      if (landed.page !== undefined) landedPages.add(landed.page);
      createdTasks.push(landed.id);
    }
    // The pages were written before the records existed, so every page write's
    // own reconcile found nothing to reconcile. A linked task stores no `done`
    // of its own, and until a reconcile reads the checkbox back the index
    // answers `false`: an imported notebook would show every finished linked
    // task as open, in Today, beside a ticked box in the note.
    for (const pageId of landedPages) {
      await store.reconcileTasksForPage(pageId, options.src);
    }
    return { rootIds, created: created.size, tasks: createdTasks.length };
  } catch (error) {
    for (const taskId of createdTasks) {
      await store.deleteTask(taskId).catch(() => undefined);
    }
    for (const rootId of rootIds) {
      await store.deletePage(rootId).catch(() => undefined);
    }
    throw error;
  }
}

export function portableFileName(title: string): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "brain";
  return `${slug}.brain.tar.gz`;
}
