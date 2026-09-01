import { describe, expect, it } from "vitest";
import {
  collectionDefinitionSchema,
  collectionRowSchema,
} from "../collections/model";
import { parsePage, serializePage } from "./frontmatter";
import type { PageMeta } from "./types";

const baseMeta: PageMeta = {
  id: "synthetic-page",
  title: "Synthetic",
  order: "a0",
  created: "2026-07-12T00:00:00.000Z",
  updated: "2026-07-12T00:00:00.000Z",
};

const definition = collectionDefinitionSchema.parse({
  version: 1,
  source: "notion",
  databaseId: "11111111111111111111111111111111",
  dataSourceId: "22222222222222222222222222222222",
  titlePropertyId: "title",
  properties: [
    { id: "title", name: "Name", type: "title", position: 0 },
    {
      id: "kind",
      name: "Kind",
      type: "select",
      position: 1,
      options: [{ id: "one", name: "One", color: "gray" }],
    },
  ],
  views: [
    {
      id: "all",
      name: "All",
      type: "table",
      rowNotionIds: ["33333333333333333333333333333333"],
    },
  ],
  initialViewId: "all",
});

describe("collection frontmatter", () => {
  it("round-trips a collection definition through stable YAML", () => {
    const meta = { ...baseMeta, collection: definition };
    const first = serializePage(meta, "Collection notes");
    const parsed = parsePage(first);

    expect(parsed.meta.collection).toEqual(definition);
    expect(parsed.markdown).toBe("Collection notes");
    expect(serializePage(parsed.meta as PageMeta, parsed.markdown)).toBe(first);
  });

  it("round-trips row values including an intentionally empty source title", () => {
    const collectionRow = collectionRowSchema.parse({
      version: 1,
      source: "notion",
      databaseId: definition.databaseId,
      values: {
        title: { type: "title", value: "" },
        kind: {
          type: "select",
          value: { id: "one", name: "One", color: "gray" },
        },
      },
    });
    const first = serializePage(
      { ...baseMeta, id: "synthetic-row", collectionRow },
      "",
    );
    const parsed = parsePage(first);

    expect(parsed.meta.collectionRow).toEqual(collectionRow);
    expect(parsed.meta.collectionRow?.values.title).toEqual({
      type: "title",
      value: "",
    });
    expect(serializePage(parsed.meta as PageMeta, parsed.markdown)).toBe(first);
  });
});
