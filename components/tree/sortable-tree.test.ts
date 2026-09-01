import { describe, expect, it } from "vitest";
import type { CollectionRow } from "@/lib/collections/model";
import type { TreeNode } from "@/lib/store/types";
import { flattenVisibleTree } from "./sortable-tree";

const base = (id: string, parentId: string | null): TreeNode => ({
  id,
  parentId,
  title: id,
  order: id,
  created: "2026-07-12T00:00:00.000Z",
  updated: "2026-07-12T00:00:00.000Z",
  hasChildren: false,
  children: [],
});

const row: CollectionRow = {
  version: 1,
  source: "notion",
  databaseId: "1".repeat(32),
  values: {
    title: { type: "title", value: "Imported row" },
  },
};

describe("collection rows in the page tree", () => {
  it("keeps imported rows out of the sidebar while preserving normal descendants", () => {
    const collection = base("collection", null);
    const importedRow = {
      ...base("row", collection.id),
      collectionRow: row,
    };
    const ordinaryChild = base("ordinary", collection.id);
    collection.children = [importedRow, ordinaryChild];
    collection.hasChildren = true;

    const flat = flattenVisibleTree(
      [collection],
      new Set([collection.id]),
    );

    expect(flat.map((entry) => entry.id)).toEqual([
      "collection",
      "ordinary",
    ]);
    expect(flat[0].node.hasChildren).toBe(true);
  });

  it("does not show an empty expander when a collection only has row pages", () => {
    const collection = base("collection", null);
    collection.children = [
      { ...base("row", collection.id), collectionRow: row },
    ];
    collection.hasChildren = true;

    const flat = flattenVisibleTree([collection], new Set());

    expect(flat).toHaveLength(1);
    expect(flat[0].node.hasChildren).toBe(false);
  });
});
