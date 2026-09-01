import { describe, expect, it } from "vitest";
import {
  assertNotionSnapshotV2Match,
  deriveNotionSnapshotV2Counts,
  readNotionSnapshotV2Jsonl,
  readNotionSnapshotV2SequenceJsonl,
  type NotionSnapshotV2,
} from "./snapshot-v2";

const ROOT = "1".repeat(32);
const COLLECTION = "2".repeat(32);
const ROW = "3".repeat(32);
const PAGE = "4".repeat(32);
const DATA_SOURCE = "5".repeat(32);

function snapshotRecords(assetQuery = "one", externalQuery = "one"): unknown[] {
  const asset = `https://file.notion.so/f/synthetic/v2.png?token=${assetQuery}`;
  return [
    {
      type: "manifest",
      version: 2,
      source: "notion",
      rootNotionIds: [ROOT],
      counts: {
        nodes: 4,
        pages: 2,
        collections: 1,
        rows: 1,
        assets: 1,
        emptyBlocks: 1,
        hardBreaks: 1,
        externalLinks: 1,
        tables: 0,
        columns: 0,
        callouts: 0,
        toggles: 0,
      },
    },
    {
      type: "node",
      kind: "page",
      notionId: ROOT,
      parentNotionId: null,
      position: 0,
      title: "Synthetic root",
      enhancedMarkdown: `[external](https://example.test/?q=${externalQuery})`,
      assets: [],
    },
    {
      type: "node",
      kind: "collection",
      notionId: COLLECTION,
      parentNotionId: ROOT,
      position: 0,
      title: "Synthetic collection",
      enhancedMarkdown: "",
      assets: [],
      collection: {
        version: 1,
        source: "notion",
        databaseId: COLLECTION,
        dataSourceId: DATA_SOURCE,
        titlePropertyId: "title",
        properties: [
          { id: "title", name: "Name", type: "title", position: 0 },
          {
            id: "state",
            name: "State",
            type: "select",
            position: 1,
            options: [
              { id: "open", name: "Open" },
              { id: "done", name: "Done" },
            ],
          },
        ],
        views: [
          {
            id: "all",
            name: "All",
            type: "table",
            rowNotionIds: [ROW],
          },
        ],
        initialViewId: "all",
      },
    },
    {
      type: "node",
      kind: "row",
      notionId: ROW,
      parentNotionId: COLLECTION,
      position: 0,
      title: "Synthetic row",
      enhancedMarkdown: "Row body",
      assets: [],
      collectionRow: {
        version: 1,
        source: "notion",
        databaseId: COLLECTION,
        values: {
          title: { type: "title", value: "Synthetic row" },
          state: {
            type: "select",
            value: { id: "open", name: "Open" },
          },
        },
      },
    },
    {
      type: "node",
      kind: "page",
      notionId: PAGE,
      parentNotionId: ROOT,
      position: 1,
      title: "Synthetic page",
      enhancedMarkdown: `<empty-block/>\ntext<br>next\n![asset](${asset})`,
      assets: [{ url: asset, name: "v2.png", kind: "image" }],
    },
    { type: "end", nodeCount: 4, assetCount: 1 },
  ];
}

function snapshotJson(assetQuery = "one", externalQuery = "one"): string {
  return snapshotRecords(assetQuery, externalQuery)
    .map((record) => JSON.stringify(record))
    .join("\n") + "\n";
}

function serializeParsed(snapshot: NotionSnapshotV2): string {
  return [
    snapshot.manifest,
    ...snapshot.nodes,
    {
      type: "end",
      nodeCount: snapshot.nodes.length,
      assetCount: snapshot.nodes.reduce((sum, node) => sum + node.assets.length, 0),
    },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

describe("strict generic Notion snapshot v2", () => {
  it("round-trips typed pages, a collection, rows, and stable signed assets", async () => {
    const received = await readNotionSnapshotV2Jsonl(snapshotJson("received"));
    const fresh = await readNotionSnapshotV2Jsonl(snapshotJson("fresh"));
    expect(received.nodes.map((node) => node.kind)).toEqual([
      "page",
      "collection",
      "row",
      "page",
    ]);
    expect(received.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fresh.fingerprint).toBe(received.fingerprint);
    expect(() => assertNotionSnapshotV2Match(received, fresh)).not.toThrow();
    expect(deriveNotionSnapshotV2Counts(received.nodes)).toEqual(
      received.manifest.counts,
    );

    const reparsed = await readNotionSnapshotV2Jsonl(serializeParsed(received));
    expect(reparsed).toEqual(received);
  });

  it("keeps meaningful source and typed property changes in the fingerprint", async () => {
    const received = await readNotionSnapshotV2Jsonl(snapshotJson("one", "one"));
    const linkChanged = await readNotionSnapshotV2Jsonl(snapshotJson("two", "two"));
    expect(() => assertNotionSnapshotV2Match(received, linkChanged)).toThrow(
      /does not match/,
    );

    const records = snapshotRecords();
    const row = records[3] as {
      collectionRow: {
        values: { state: { value: { id: string; name: string } } };
      };
    };
    row.collectionRow.values.state.value = { id: "done", name: "Done" };
    const propertyChanged = await readNotionSnapshotV2Jsonl(
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    expect(propertyChanged.fingerprint).not.toBe(received.fingerprint);
  });

  it("reads an exact two-capture sequence", async () => {
    const snapshots = await readNotionSnapshotV2SequenceJsonl(
      snapshotJson("received") + snapshotJson("fresh"),
      { expectedSnapshots: 2 },
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].fingerprint).toBe(snapshots[1].fingerprint);
  });

  it("rejects unknown fields, bad counts, roots, topology, and limits", async () => {
    const unknown = snapshotJson().replace(
      '"source":"notion"',
      '"source":"notion","private":"no"',
    );
    await expect(readNotionSnapshotV2Jsonl(unknown)).rejects.toThrow(
      /unknown fields/,
    );

    const badCount = snapshotJson().replace('"nodeCount":4', '"nodeCount":5');
    await expect(readNotionSnapshotV2Jsonl(badCount)).rejects.toThrow(
      /node count mismatch/,
    );

    const badRoot = snapshotJson().replace(
      `"rootNotionIds":["${ROOT}"]`,
      `"rootNotionIds":["${PAGE}"]`,
    );
    await expect(readNotionSnapshotV2Jsonl(badRoot)).rejects.toThrow(/roots/);

    const badParent = snapshotJson().replace(
      `"kind":"row","notionId":"${ROW}","parentNotionId":"${COLLECTION}"`,
      `"kind":"row","notionId":"${ROW}","parentNotionId":"${ROOT}"`,
    );
    await expect(readNotionSnapshotV2Jsonl(badParent)).rejects.toThrow(
      /row parent must be a collection|view references a missing row/,
    );

    const badPosition = snapshotJson().replace(
      `"notionId":"${PAGE}","parentNotionId":"${ROOT}","position":1`,
      `"notionId":"${PAGE}","parentNotionId":"${ROOT}","position":3`,
    );
    await expect(readNotionSnapshotV2Jsonl(badPosition)).rejects.toThrow(
      /positions must be contiguous/,
    );

    await expect(
      readNotionSnapshotV2Jsonl(snapshotJson(), { maxBytes: 32, maxLineBytes: 32 }),
    ).rejects.toThrow(/byte limit/);
  });

  it("rejects incomplete or mistyped collection rows without coercion", async () => {
    const incomplete = snapshotRecords();
    delete (incomplete[3] as {
      collectionRow: { values: { title?: unknown } };
    }).collectionRow.values.title;
    await expect(
      readNotionSnapshotV2Jsonl(
        incomplete.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    ).rejects.toThrow(/does not match collection definition/);

    const missingNonTitle = snapshotRecords();
    delete (missingNonTitle[3] as {
      collectionRow: { values: { state?: unknown } };
    }).collectionRow.values.state;
    await expect(
      readNotionSnapshotV2Jsonl(
        missingNonTitle.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    ).rejects.toThrow(/does not match collection definition/);

    const mistyped = snapshotRecords();
    const property = (mistyped[3] as {
      collectionRow: {
        values: { state: { type: string; value: unknown } };
      };
    }).collectionRow.values.state;
    property.type = "date";
    property.value = null;
    await expect(
      readNotionSnapshotV2Jsonl(
        mistyped.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    ).rejects.toThrow(/does not match collection definition/);

    const unknownOption = snapshotRecords();
    (unknownOption[3] as {
      collectionRow: {
        values: { state: { value: { id: string; name: string } } };
      };
    }).collectionRow.values.state.value = { id: "blocked", name: "Blocked" };
    await expect(
      readNotionSnapshotV2Jsonl(
        unknownOption.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    ).rejects.toThrow(/does not match collection definition/);

    const mismatchedTitle = snapshotRecords();
    (mismatchedTitle[3] as {
      collectionRow: { values: { title: { value: string } } };
    }).collectionRow.values.title.value = "Another title";
    await expect(
      readNotionSnapshotV2Jsonl(
        mismatchedTitle.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    ).rejects.toThrow(/row title does not match/);

    const wrongEmptyFallback = snapshotRecords();
    (wrongEmptyFallback[3] as {
      title: string;
      collectionRow: { values: { title: { value: string } } };
    }).title = "";
    (wrongEmptyFallback[3] as {
      collectionRow: { values: { title: { value: string } } };
    }).collectionRow.values.title.value = "";
    await expect(
      readNotionSnapshotV2Jsonl(
        wrongEmptyFallback.map((record) => JSON.stringify(record)).join("\n") + "\n",
      ),
    ).rejects.toThrow(/row title does not match/);
  });

  it("still rejects empty page and collection titles", async () => {
    const emptyPage = snapshotJson().replace(
      `"notionId":"${ROOT}","parentNotionId":null,"position":0,"title":"Synthetic root"`,
      `"notionId":"${ROOT}","parentNotionId":null,"position":0,"title":""`,
    );
    await expect(readNotionSnapshotV2Jsonl(emptyPage)).rejects.toThrow(
      /node text/,
    );

    const emptyCollection = snapshotJson().replace(
      `"notionId":"${COLLECTION}","parentNotionId":"${ROOT}","position":0,"title":"Synthetic collection"`,
      `"notionId":"${COLLECTION}","parentNotionId":"${ROOT}","position":0,"title":""`,
    );
    await expect(readNotionSnapshotV2Jsonl(emptyCollection)).rejects.toThrow(
      /node text/,
    );
  });
});
