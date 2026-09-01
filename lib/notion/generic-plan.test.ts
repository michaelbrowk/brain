import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { parseNotionBindingsJson } from "./bindings";
import type { BrainImportClient } from "./brain-mcp-client";
import type { NotionExecutionPlan } from "./execution-plan";
import { executeNotionExecution } from "./executor";
import {
  brainTitleForNotionSnapshotNode,
  buildGenericNotionImportPlan,
  prepareGenericCreateOnlyExecution,
  prepareGenericNotionExecution,
} from "./generic-plan";
import type { PilotJournal } from "./journal";
import type { ResolvedNotionAsset } from "./notion-assets";
import { stableNotionAssetId } from "./notion-assets";
import {
  readNotionSnapshotV2Jsonl,
  type NotionSnapshotV2,
} from "./snapshot-v2";

const ROOT = "1".repeat(32);
const CREATE = "2".repeat(32);
const SKIP = "3".repeat(32);
const SKIP_CHILD = "4".repeat(32);
const ADOPT = "5".repeat(32);

function snapshotJson(assetQuery = "received", createMarkdown?: string): string {
  const asset = `https://file.notion.so/f/synthetic/generic.png?token=${assetQuery}`;
  const markdown = createMarkdown ??
    `![asset](${asset})\n[existing](https://www.notion.so/Existing-${ADOPT})`;
  const records = [
    {
      type: "manifest",
      version: 2,
      source: "notion",
      rootNotionIds: [ROOT],
      counts: {
        nodes: 5,
        pages: 5,
        collections: 0,
        rows: 0,
        assets: 1,
        emptyBlocks: 0,
        hardBreaks: 0,
        externalLinks: 0,
        tables: 0,
        columns: 0,
        callouts: 0,
        toggles: 0,
      },
    },
    node(ROOT, null, 0, "Preserved root"),
    node(
      CREATE,
      ROOT,
      0,
      "Create me",
      markdown,
      [{ url: asset, name: "generic.png", kind: "image" }],
    ),
    node(SKIP, ROOT, 1, "Skipped subtree"),
    node(SKIP_CHILD, SKIP, 0, "Skipped child"),
    node(ADOPT, ROOT, 2, "Adopt me", "Existing body"),
    { type: "end", nodeCount: 5, assetCount: 1 },
  ];
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function node(
  notionId: string,
  parentNotionId: string | null,
  position: number,
  title: string,
  enhancedMarkdown = "",
  assets: Array<{ url: string; name: string; kind: "image" }> = [],
) {
  return {
    type: "node",
    kind: "page",
    notionId,
    parentNotionId,
    position,
    title,
    enhancedMarkdown,
    assets,
  };
}

function bindingObject(snapshotFingerprint: string) {
  return {
    version: 1,
    snapshotFingerprint,
    entries: [
      {
        notionId: ROOT,
        disposition: "preserve",
        brainPageId: "brain-root",
        expectedRev: "a".repeat(64),
        expectedParentId: null,
        expectedBeforeId: null,
      },
      { notionId: CREATE, disposition: "create" },
      { notionId: SKIP, disposition: "skip", reason: "Already migrated" },
      { notionId: SKIP_CHILD, disposition: "skip", reason: "Parent skipped" },
      {
        notionId: ADOPT,
        disposition: "adopt",
        brainPageId: "brain-adopt",
        expectedRev: "b".repeat(64),
        expectedParentId: "brain-root",
        expectedBeforeId: null,
      },
    ],
  };
}

function resolvedAssets(
  snapshot: NotionSnapshotV2,
  bytes = new TextEncoder().encode("synthetic generic image"),
): Map<string, ResolvedNotionAsset> {
  const source = snapshot.nodes.flatMap((node) => node.assets)[0];
  if (!source) throw new Error("synthetic fixture is missing its asset");
  const sourceId = stableNotionAssetId(source.url);
  return new Map([
    [
      sourceId,
      {
        sourceId,
        name: source.name,
        mimeType: "image/png" as const,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      },
    ],
  ]);
}

describe("generic Notion import v2 plan", () => {
  it("builds a stable reverse-sibling plan with explicit preserve/adopt anchors", async () => {
    const received = await readNotionSnapshotV2Jsonl(snapshotJson("received"));
    const fresh = await readNotionSnapshotV2Jsonl(snapshotJson("fresh"));
    const bindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(received.fingerprint)),
    );
    const receivedPlan = buildGenericNotionImportPlan(
      received,
      bindings,
      resolvedAssets(received),
    );
    const freshPlan = buildGenericNotionImportPlan(
      fresh,
      bindings,
      resolvedAssets(fresh),
    );

    const reusableExecutorShape: NotionExecutionPlan = receivedPlan;
    expect(reusableExecutorShape.pages.map((page) => page.notionId)).toEqual([
      ADOPT,
      CREATE,
    ]);
    expect(receivedPlan.pageByNotionId.get(CREATE)?.beforeNotionId).toBe(ADOPT);
    expect(receivedPlan.pageByNotionId.get(ADOPT)?.beforeNotionId).toBeNull();
    expect(receivedPlan.fixedPageIds).toEqual(
      new Map([
        [ROOT, "brain-root"],
        [ADOPT, "brain-adopt"],
      ]),
    );
    expect(receivedPlan.counts).toMatchObject({
      sourceNodes: 5,
      pages: 2,
      create: 1,
      adopt: 1,
      preserve: 1,
      skip: 2,
      assets: 1,
    });
    expect(receivedPlan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(freshPlan.fingerprint).toBe(receivedPlan.fingerprint);
  });

  it("commits resolved asset bytes and dispositions into the plan fingerprint", async () => {
    const snapshot = await readNotionSnapshotV2Jsonl(snapshotJson());
    const bindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(snapshot.fingerprint)),
    );
    const first = buildGenericNotionImportPlan(
      snapshot,
      bindings,
      resolvedAssets(snapshot, new TextEncoder().encode("first")),
    );
    const second = buildGenericNotionImportPlan(
      snapshot,
      bindings,
      resolvedAssets(snapshot, new TextEncoder().encode("second")),
    );
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.pageByNotionId.get(CREATE)?.sourceHash).not.toBe(
      first.pageByNotionId.get(CREATE)?.sourceHash,
    );

    const changedBindings = bindingObject(snapshot.fingerprint);
    changedBindings.entries[1] = {
      notionId: CREATE,
      disposition: "skip",
      reason: "Reviewed exclusion",
    };
    changedBindings.entries[2] = {
      notionId: SKIP,
      disposition: "skip",
      reason: "Already migrated",
    };
    const changed = parseNotionBindingsJson(JSON.stringify(changedBindings));
    expect(changed.fingerprint).not.toBe(bindings.fingerprint);

    const firstBoundary = buildGenericNotionImportPlan(
      snapshot,
      bindings,
      resolvedAssets(snapshot),
      { sourceBoundaryFingerprint: "a".repeat(64) },
    );
    const secondBoundary = buildGenericNotionImportPlan(
      snapshot,
      bindings,
      resolvedAssets(snapshot),
      { sourceBoundaryFingerprint: "b".repeat(64) },
    );
    expect(firstBoundary.sourceBoundaryFingerprint).toBe("a".repeat(64));
    expect(secondBoundary.fingerprint).not.toBe(firstBoundary.fingerprint);
    expect(() =>
      buildGenericNotionImportPlan(
        snapshot,
        bindings,
        resolvedAssets(snapshot),
        { sourceBoundaryFingerprint: "invalid" },
      ),
    ).toThrow(/source-boundary fingerprint/);
  });

  it("fails closed on stale, incomplete, or hierarchy-inconsistent bindings", async () => {
    const snapshot = await readNotionSnapshotV2Jsonl(snapshotJson());
    const stale = bindingObject("f".repeat(64));
    expect(() =>
      buildGenericNotionImportPlan(
        snapshot,
        parseNotionBindingsJson(JSON.stringify(stale)),
        resolvedAssets(snapshot),
      ),
    ).toThrow(/do not match/);

    const incomplete = bindingObject(snapshot.fingerprint);
    incomplete.entries.pop();
    expect(() =>
      buildGenericNotionImportPlan(
        snapshot,
        parseNotionBindingsJson(JSON.stringify(incomplete)),
        resolvedAssets(snapshot),
      ),
    ).toThrow(/cover every.*exactly once/);

    const brokenSkip = bindingObject(snapshot.fingerprint);
    brokenSkip.entries[3] = { notionId: SKIP_CHILD, disposition: "create" };
    expect(() =>
      buildGenericNotionImportPlan(
        snapshot,
        parseNotionBindingsJson(JSON.stringify(brokenSkip)),
        resolvedAssets(snapshot),
      ),
    ).toThrow(/skip disposition must cover the complete subtree/);
  });

  it("rejects active references to skipped nodes and any extra resolved asset", async () => {
    const asset = "https://file.notion.so/f/synthetic/generic.png?token=received";
    const snapshot = await readNotionSnapshotV2Jsonl(
      snapshotJson(
        "received",
        `![asset](${asset})\n[skip](https://www.notion.so/Skip-${SKIP})`,
      ),
    );
    const bindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(snapshot.fingerprint)),
    );
    expect(() =>
      buildGenericNotionImportPlan(snapshot, bindings, resolvedAssets(snapshot)),
    ).toThrow(/page reference to a skipped node/);

    const outside = "9".repeat(32);
    const missing = await readNotionSnapshotV2Jsonl(
      snapshotJson(
        "received",
        `![asset](${asset})\n[outside](https://www.notion.so/${outside})`,
      ),
    );
    const missingBindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(missing.fingerprint)),
    );
    expect(() =>
      buildGenericNotionImportPlan(
        missing,
        missingBindings,
        resolvedAssets(missing),
      ),
    ).toThrow(/page reference outside the frozen set/);

    const normal = await readNotionSnapshotV2Jsonl(snapshotJson());
    const normalBindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(normal.fingerprint)),
    );
    const extra = resolvedAssets(normal);
    extra.set("asset_" + "f".repeat(32), {
      sourceId: "asset_" + "f".repeat(32),
      name: "extra.png",
      mimeType: "image/png",
      sha256: "f".repeat(64),
      bytes: new Uint8Array(),
    });
    expect(() => buildGenericNotionImportPlan(normal, normalBindings, extra)).toThrow(
      /resolved assets do not match/,
    );
  });

  it("requires a collection-aware materializer before a collection can mutate", async () => {
    const records = [
      {
        type: "manifest",
        version: 2,
        source: "notion",
        rootNotionIds: [ROOT],
        counts: {
          nodes: 1,
          pages: 0,
          collections: 1,
          rows: 0,
          assets: 0,
          emptyBlocks: 0,
          hardBreaks: 0,
          externalLinks: 0,
          tables: 0,
          columns: 0,
          callouts: 0,
          toggles: 0,
        },
      },
      {
        type: "node",
        kind: "collection",
        notionId: ROOT,
        parentNotionId: null,
        position: 0,
        title: "Typed collection",
        enhancedMarkdown: "",
        assets: [],
        collection: {
          version: 1,
          source: "notion",
          databaseId: ROOT,
          dataSourceId: "6".repeat(32),
          titlePropertyId: "title",
          properties: [
            { id: "title", name: "Name", type: "title", position: 0 },
          ],
          views: [{ id: "all", type: "table", rowNotionIds: [] }],
          initialViewId: "all",
        },
      },
      { type: "end", nodeCount: 1, assetCount: 0 },
    ];
    const snapshot = await readNotionSnapshotV2Jsonl(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const bindings = parseNotionBindingsJson(
      JSON.stringify({
        version: 1,
        snapshotFingerprint: snapshot.fingerprint,
        entries: [{ notionId: ROOT, disposition: "create" }],
      }),
    );
    expect(() => buildGenericNotionImportPlan(snapshot, bindings, new Map())).toThrow(
      /collection and row mutations require an explicit typed materializer/,
    );

    const typedPlan = buildGenericNotionImportPlan(
      snapshot,
      bindings,
      new Map(),
      {
        materializeNode: (source) => ({
          document: {
            notionId: source.notionId,
            title: source.title,
            icon: source.icon,
            blocks: [],
          },
          issues: [],
          stats: {
            emptyBlocks: 0,
            hardBreaks: 0,
            externalLinks: 0,
            pageRefs: 0,
            assets: 0,
          },
        }),
      },
    );
    expect(typedPlan.pages[0].collection).toEqual(
      snapshot.nodes[0].kind === "collection"
        ? snapshot.nodes[0].collection
        : undefined,
    );
    expect(typedPlan.pages[0].collectionRow).toBeNull();
    expect(() => prepareGenericCreateOnlyExecution(typedPlan, new Map())).not.toThrow();
  });

  it("keeps an empty source row title while materializing Brain's Untitled fallback", async () => {
    const emptyRowId = "7".repeat(32);
    const records = [
      {
        type: "manifest",
        version: 2,
        source: "notion",
        rootNotionIds: [ROOT],
        counts: {
          nodes: 2,
          pages: 0,
          collections: 1,
          rows: 1,
          assets: 0,
          emptyBlocks: 0,
          hardBreaks: 0,
          externalLinks: 0,
          tables: 0,
          columns: 0,
          callouts: 0,
          toggles: 0,
        },
      },
      {
        type: "node",
        kind: "collection",
        notionId: ROOT,
        parentNotionId: null,
        position: 0,
        title: "Rows",
        enhancedMarkdown: "",
        assets: [],
        collection: {
          version: 1,
          source: "notion",
          databaseId: ROOT,
          dataSourceId: "8".repeat(32),
          titlePropertyId: "title",
          properties: [
            { id: "title", name: "Name", type: "title", position: 0 },
            {
              id: "state",
              name: "State",
              type: "select",
              position: 1,
              options: [],
            },
          ],
          views: [{ id: "all", type: "table", rowNotionIds: [emptyRowId] }],
          initialViewId: "all",
        },
      },
      {
        type: "node",
        kind: "row",
        notionId: emptyRowId,
        parentNotionId: ROOT,
        position: 0,
        title: "Untitled",
        enhancedMarkdown: "",
        assets: [],
        collectionRow: {
          version: 1,
          source: "notion",
          databaseId: ROOT,
          values: {
            title: { type: "title", value: "" },
            state: { type: "select", value: null },
          },
        },
      },
      { type: "end", nodeCount: 2, assetCount: 0 },
    ];
    const snapshot = await readNotionSnapshotV2Jsonl(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    const sourceRow = snapshot.nodes[1];
    expect(sourceRow.kind).toBe("row");
    expect(sourceRow.title).toBe("Untitled");
    if (sourceRow.kind !== "row") throw new Error("expected a row fixture");
    expect(sourceRow.collectionRow.values.title).toEqual({
      type: "title",
      value: "",
    });
    expect(sourceRow.collectionRow.values.state).toEqual({
      type: "select",
      value: null,
    });

    const bindings = parseNotionBindingsJson(
      JSON.stringify({
        version: 1,
        snapshotFingerprint: snapshot.fingerprint,
        entries: [
          { notionId: ROOT, disposition: "create" },
          { notionId: emptyRowId, disposition: "create" },
        ],
      }),
    );
    const plan = buildGenericNotionImportPlan(
      snapshot,
      bindings,
      new Map(),
      {
        materializeNode: (source) => ({
          document: {
            notionId: source.notionId,
            title: brainTitleForNotionSnapshotNode(source),
            icon: source.icon,
            blocks: [],
          },
          issues: [],
          stats: {
            emptyBlocks: 0,
            hardBreaks: 0,
            externalLinks: 0,
            pageRefs: 0,
            assets: 0,
          },
        }),
      },
    );
    const plannedRow = plan.pageByNotionId.get(emptyRowId);
    expect(plannedRow?.title).toBe("Untitled");
    expect(plannedRow?.document.title).toBe("Untitled");
    expect(plannedRow?.collectionRow?.values.title).toEqual({
      type: "title",
      value: "",
    });
  });

  it("keeps the create-only gate while preparing reviewed anchored plans", async () => {
    const snapshot = await readNotionSnapshotV2Jsonl(snapshotJson());
    const anchoredBindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(snapshot.fingerprint)),
    );
    const anchoredPlan = buildGenericNotionImportPlan(
      snapshot,
      anchoredBindings,
      resolvedAssets(snapshot),
    );
    expect(() =>
      prepareGenericCreateOnlyExecution(anchoredPlan, resolvedAssets(snapshot)),
    ).toThrow(/baseline preflight phase/);
    expect(
      prepareGenericNotionExecution(anchoredPlan, resolvedAssets(snapshot)).plan,
    ).toBe(anchoredPlan);

    const allCreate = bindingObject(snapshot.fingerprint);
    allCreate.entries[0] = { notionId: ROOT, disposition: "create" };
    allCreate.entries[4] = { notionId: ADOPT, disposition: "create" };
    const createBindings = parseNotionBindingsJson(JSON.stringify(allCreate));
    const createPlan = buildGenericNotionImportPlan(
      snapshot,
      createBindings,
      resolvedAssets(snapshot),
    );
    const prepared = prepareGenericCreateOnlyExecution(
      createPlan,
      resolvedAssets(snapshot),
    );
    expect(prepared.plan).toBe(createPlan);
    expect(createPlan.pages.every((page) => page.disposition === "create")).toBe(true);
  });

  it("rejects a missing fixed candidate before journal or destination access", async () => {
    const snapshot = await readNotionSnapshotV2Jsonl(snapshotJson());
    const bindings = parseNotionBindingsJson(
      JSON.stringify(bindingObject(snapshot.fingerprint)),
    );
    const assets = resolvedAssets(snapshot);
    const plan = buildGenericNotionImportPlan(snapshot, bindings, assets);
    const findPage = vi.fn();
    const inspectCandidate = vi.fn().mockResolvedValue(null);
    const append = vi.fn();
    await expect(
      executeNotionExecution({
        prepared: { plan, assets },
        client: { findPage, inspectCandidate } as unknown as BrainImportClient,
        journal: { append } as unknown as PilotJournal,
        mode: "verify",
      }),
    ).rejects.toThrow(/candidate is missing/);
    expect(inspectCandidate).toHaveBeenCalledTimes(1);
    expect(findPage).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });
});
