import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectionDefinitionSchema,
  collectionRowSchema,
} from "../collections/model";
import {
  canonicalizeNotionImportTarget,
  notionConversionHash,
} from "../notion/protocol";
import { Store } from "./store";

const COLLECTION_ID = "1".repeat(32);
const DATA_SOURCE_ID = "2".repeat(32);
const ROW_ID = "3".repeat(32);
const SECOND_ROW_ID = "4".repeat(32);
const SOURCE_COLLECTION = "a".repeat(64);
const SOURCE_ROW = "b".repeat(64);

const definition = collectionDefinitionSchema.parse({
  version: 1,
  source: "notion",
  databaseId: COLLECTION_ID,
  dataSourceId: DATA_SOURCE_ID,
  titlePropertyId: "title",
  properties: [
    { id: "title", name: "Name", type: "title", position: 0 },
    {
      id: "kind",
      name: "Kind",
      type: "select",
      position: 1,
      options: [
        { id: "good", name: "Good", color: "gray" },
        { id: "bad", name: "Bad", color: "pink" },
      ],
    },
  ],
  views: [
    {
      id: "all",
      name: "All",
      type: "board",
      rowNotionIds: [ROW_ID],
      groupBy: {
        propertyId: "kind",
        manualOptionIds: ["good", "bad"],
      },
    },
  ],
  initialViewId: "all",
});

const row = collectionRowSchema.parse({
  version: 1,
  source: "notion",
  databaseId: COLLECTION_ID,
  values: {
    title: { type: "title", value: "" },
    kind: {
      type: "select",
      value: { id: "good", name: "Good", color: "gray" },
    },
  },
});

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-collections-"));
  const store = new Store(root);
  await store.init();
  return store;
}

function targetHash(input: Parameters<typeof canonicalizeNotionImportTarget>[0]) {
  return notionConversionHash(canonicalizeNotionImportTarget(input));
}

describe("Store notion collections", () => {
  it("finalizes a collection parent and a typed child row without flattening either", async () => {
    const store = await tmpStore();
    const parent = await store.reserveNotionImport({
      notionId: COLLECTION_ID,
      sourceHash: SOURCE_COLLECTION,
      parentId: null,
      beforeId: null,
      title: "Synthetic collection",
      reservationToken: "collection_parent_token_0001",
    });
    expect(parent.status).toBe("reserved");
    if (parent.status !== "reserved") throw new Error("parent was not reserved");

    const parentHash = targetHash({
      sourceHash: SOURCE_COLLECTION,
      parentId: null,
      beforeId: null,
      title: "Synthetic collection",
      markdown: "",
      collection: definition,
    });
    await expect(
      store.finalizeNotionImport({
        notionId: COLLECTION_ID,
        sourceHash: SOURCE_COLLECTION,
        conversionHash: parentHash,
        reservationToken: parent.reservationToken,
        title: "Synthetic collection",
        markdown: "",
        collection: definition,
      }),
    ).resolves.toMatchObject({ status: "finalized" });

    const child = await store.reserveNotionImport({
      notionId: ROW_ID,
      sourceHash: SOURCE_ROW,
      parentId: parent.page.id,
      beforeId: null,
      title: "Untitled",
      reservationToken: "collection_child_token_0001",
    });
    expect(child.status).toBe("reserved");
    if (child.status !== "reserved") throw new Error("child was not reserved");

    const childHash = targetHash({
      sourceHash: SOURCE_ROW,
      parentId: parent.page.id,
      beforeId: null,
      title: "Untitled",
      markdown: "Row body",
      collectionRow: row,
    });
    await expect(
      store.finalizeNotionImport({
        notionId: ROW_ID,
        sourceHash: SOURCE_ROW,
        conversionHash: childHash,
        reservationToken: child.reservationToken,
        title: "Untitled",
        markdown: "Row body",
        collectionRow: row,
      }),
    ).resolves.toMatchObject({ status: "finalized" });

    await expect(store.readPage(parent.page.id)).resolves.toMatchObject({
      meta: { collection: definition },
    });
    await expect(store.readPage(child.page.id)).resolves.toMatchObject({
      markdown: "Row body",
      meta: {
        collectionRow: {
          databaseId: COLLECTION_ID,
          values: { title: { type: "title", value: "" } },
        },
      },
    });
    expect(store.getTree()).toMatchObject([
      {
        id: parent.page.id,
        notionId: COLLECTION_ID,
        collection: definition,
        children: [
          {
            id: child.page.id,
            notionId: ROW_ID,
            collectionRow: row,
          },
        ],
      },
    ]);

    const ordinary = await store.createPage(null, "Ordinary page");
    await expect(
      store.createPage(parent.page.id, "Manual child"),
    ).rejects.toThrow("only be created by a source import");
    await expect(
      store.movePage(ordinary.id, parent.page.id),
    ).rejects.toThrow("only source collection rows");
    await expect(
      store.movePage(child.page.id, ordinary.id),
    ).rejects.toThrow("collection rows must stay");
    await expect(
      store.movePage(child.page.id, null),
    ).rejects.toThrow("collection rows must stay");
    await expect(
      store.movePage(child.page.id, parent.page.id, null),
    ).resolves.toMatchObject({ id: child.page.id });
    await expect(
      store.movePage(parent.page.id, ordinary.id),
    ).resolves.toMatchObject({ id: parent.page.id });
  });

  it("fails closed when a collection child omits or contradicts row metadata", async () => {
    const store = await tmpStore();
    const parent = await store.reserveNotionImport({
      notionId: COLLECTION_ID,
      sourceHash: SOURCE_COLLECTION,
      parentId: null,
      beforeId: null,
      title: "Synthetic collection",
      reservationToken: "collection_parent_token_0002",
    });
    if (parent.status !== "reserved") throw new Error("parent was not reserved");
    await store.finalizeNotionImport({
      notionId: COLLECTION_ID,
      sourceHash: SOURCE_COLLECTION,
      conversionHash: targetHash({
        sourceHash: SOURCE_COLLECTION,
        parentId: null,
        beforeId: null,
        title: "Synthetic collection",
        markdown: "",
        collection: definition,
      }),
      reservationToken: parent.reservationToken,
      markdown: "",
      collection: definition,
    });

    const missing = await store.reserveNotionImport({
      notionId: SECOND_ROW_ID,
      sourceHash: SOURCE_ROW,
      parentId: parent.page.id,
      beforeId: null,
      title: "Missing row metadata",
      reservationToken: "collection_child_token_0002",
    });
    if (missing.status !== "reserved") throw new Error("child was not reserved");
    await expect(
      store.finalizeNotionImport({
        notionId: SECOND_ROW_ID,
        sourceHash: SOURCE_ROW,
        conversionHash: targetHash({
          sourceHash: SOURCE_ROW,
          parentId: parent.page.id,
          beforeId: null,
          title: "Missing row metadata",
          markdown: "",
        }),
        reservationToken: missing.reservationToken,
        markdown: "",
      }),
    ).rejects.toMatchObject({ code: "conversion_issues" });

    const missingProperty = collectionRowSchema.parse({
      ...row,
      values: { title: row.values.title },
    });
    await expect(
      store.finalizeNotionImport({
        notionId: SECOND_ROW_ID,
        sourceHash: SOURCE_ROW,
        conversionHash: targetHash({
          sourceHash: SOURCE_ROW,
          parentId: parent.page.id,
          beforeId: null,
          title: "Missing row metadata",
          markdown: "",
          collectionRow: missingProperty,
        }),
        reservationToken: missing.reservationToken,
        markdown: "",
        collectionRow: missingProperty,
      }),
    ).rejects.toMatchObject({ code: "conversion_issues" });

    const wrongDatabase = collectionRowSchema.parse({
      ...row,
      databaseId: "5".repeat(32),
    });
    await expect(
      store.finalizeNotionImport({
        notionId: SECOND_ROW_ID,
        sourceHash: SOURCE_ROW,
        conversionHash: targetHash({
          sourceHash: SOURCE_ROW,
          parentId: parent.page.id,
          beforeId: null,
          title: "Missing row metadata",
          markdown: "",
          collectionRow: wrongDatabase,
        }),
        reservationToken: missing.reservationToken,
        markdown: "",
        collectionRow: wrongDatabase,
      }),
    ).rejects.toMatchObject({ code: "conversion_issues" });
  });
});
