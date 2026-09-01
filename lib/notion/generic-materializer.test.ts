import { describe, expect, it } from "vitest";
import {
  convertDeclaredExternalNotionReferences,
  materializeGenericNotionSnapshotNode,
  materializeGenericNotionSnapshotNodeWithExternalReferences,
} from "./generic-materializer";
import type {
  NotionSnapshotV2Collection,
  NotionSnapshotV2Row,
} from "./snapshot-v2";

const DATABASE = "1".repeat(32);
const ROW = "2".repeat(32);
const INTERNAL = "3".repeat(32);
const EXTERNAL = "4".repeat(32);

describe("generic Notion typed materializer", () => {
  it("materializes collection prose and keeps an empty row title visible", () => {
    const collection: NotionSnapshotV2Collection = {
      type: "node",
      kind: "collection",
      notionId: DATABASE,
      parentNotionId: null,
      position: 0,
      title: "Collection",
      enhancedMarkdown: "Collection notes",
      assets: [],
      collection: {
        version: 1,
        source: "notion",
        databaseId: DATABASE,
        dataSourceId: "3".repeat(32),
        titlePropertyId: "title",
        properties: [
          { id: "title", name: "Name", type: "title", position: 0 },
        ],
        views: [{ id: "all", type: "table", rowNotionIds: [ROW] }],
        initialViewId: "all",
      },
    };
    const row: NotionSnapshotV2Row = {
      type: "node",
      kind: "row",
      notionId: ROW,
      parentNotionId: DATABASE,
      position: 0,
      title: "Untitled",
      enhancedMarkdown: "Row notes",
      assets: [],
      collectionRow: {
        version: 1,
        source: "notion",
        databaseId: DATABASE,
        values: { title: { type: "title", value: "" } },
      },
    };

    expect(
      materializeGenericNotionSnapshotNode(collection, new Map()).document,
    ).toMatchObject({ title: "Collection" });
    expect(
      materializeGenericNotionSnapshotNode(row, new Map()).document,
    ).toMatchObject({ title: "Untitled" });
  });

  it("converts only declared external refs and adjusts occurrence stats", () => {
    const source = {
      type: "node" as const,
      kind: "page" as const,
      notionId: DATABASE,
      parentNotionId: null,
      position: 0,
      title: "External refs",
      enhancedMarkdown: [
        `inline [outside](https://app.notion.com/p/Outside-${EXTERNAL})`,
        `[internal](https://www.notion.so/${INTERNAL})`,
        `[outside again](https://www.notion.so/${EXTERNAL})`,
      ].join("\n"),
      assets: [],
    };

    const result = materializeGenericNotionSnapshotNodeWithExternalReferences(
      source,
      new Map(),
      new Set([EXTERNAL]),
    );

    expect(result.stats).toMatchObject({ pageRefs: 1, externalLinks: 2 });
    expect(result.document.blocks).toEqual([
      {
        type: "rich_markdown",
        segments: expect.arrayContaining([
          {
            type: "text",
            text: `[outside](https://www.notion.so/${EXTERNAL})`,
          },
          { type: "page_ref", notionId: INTERNAL, title: "internal" },
          {
            type: "text",
            text: `[outside again](https://www.notion.so/${EXTERNAL})`,
          },
        ]),
      },
    ]);
  });

  it("converts a declared standalone page_ref with canonical escaping", () => {
    const result = convertDeclaredExternalNotionReferences(
      {
        document: {
          notionId: DATABASE,
          title: "Synthetic",
          blocks: [
            {
              type: "page_ref",
              notionId: EXTERNAL,
              title: "A [label] \\ path",
              icon: "🧭",
              sourceUrl: "https://untrusted.example/not-used",
            },
            {
              type: "page_ref",
              notionId: INTERNAL,
              title: "Preserved internal",
            },
          ],
        },
        issues: [],
        stats: {
          emptyBlocks: 0,
          hardBreaks: 0,
          externalLinks: 0,
          pageRefs: 2,
          assets: 0,
        },
      },
      new Set([EXTERNAL]),
    );

    expect(result.stats).toMatchObject({ pageRefs: 1, externalLinks: 1 });
    expect(result.document.blocks[0]).toEqual({
      type: "markdown",
      markdown: `[🧭 A \\[label\\] \\\\ path](https://www.notion.so/${EXTERNAL})`,
    });
    expect(result.document.blocks[1]).toMatchObject({
      type: "page_ref",
      notionId: INTERNAL,
    });
  });

  it("rejects control characters in an external reference label", () => {
    expect(() =>
      convertDeclaredExternalNotionReferences(
        {
          document: {
            notionId: DATABASE,
            title: "Synthetic",
            blocks: [
              {
                type: "page_ref",
                notionId: EXTERNAL,
                title: "unsafe\nlabel",
              },
            ],
          },
          issues: [],
          stats: {
            emptyBlocks: 0,
            hardBreaks: 0,
            externalLinks: 0,
            pageRefs: 1,
            assets: 0,
          },
        },
        new Set([EXTERNAL]),
      ),
    ).toThrow(/control character/);
  });
});
