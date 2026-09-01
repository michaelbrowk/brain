import { describe, expect, it } from "vitest";
import {
  assertCollectionRowMatchesDefinition,
  collectionDefinitionSchema,
  collectionRowSchema,
  type CollectionDefinition,
} from "./model";

const DATABASE_ID = "11111111111111111111111111111111";
const DATA_SOURCE_ID = "22222222222222222222222222222222";
const ROW_ID = "33333333333333333333333333333333";

function definition(): CollectionDefinition {
  return collectionDefinitionSchema.parse({
    version: 1,
    source: "notion",
    databaseId: "11111111-1111-1111-1111-111111111111",
    dataSourceId: "22222222-2222-2222-2222-222222222222",
    titlePropertyId: "title",
    properties: [
      { id: "title", name: "Name", type: "title", position: 0 },
      {
        id: "kind",
        name: "Kind",
        type: "select",
        position: 1,
        options: [
          { id: "kind-a", name: "A", color: "blue" },
          { id: "kind-b", name: "B", color: "gray" },
        ],
      },
      { id: "date", name: "Date", type: "date", position: 2 },
    ],
    views: [
      {
        id: "all",
        name: "All",
        type: "board",
        rowNotionIds: [ROW_ID],
        visiblePropertyIds: ["title", "date"],
        groupBy: {
          propertyId: "kind",
          manualOptionIds: ["kind-a", "kind-b"],
        },
      },
    ],
    initialViewId: "all",
  });
}

describe("collection metadata", () => {
  it("normalizes durable Notion ids and preserves source view order", () => {
    const parsed = definition();

    expect(parsed.databaseId).toBe(DATABASE_ID);
    expect(parsed.dataSourceId).toBe(DATA_SOURCE_ID);
    expect(parsed.views[0].rowNotionIds).toEqual([ROW_ID]);
    expect(parsed.views[0].groupBy?.manualOptionIds).toEqual([
      "kind-a",
      "kind-b",
    ]);
  });

  it("rejects ambiguous schemas and dangling view references", () => {
    const valid = definition();

    expect(
      collectionDefinitionSchema.safeParse({
        ...valid,
        properties: [...valid.properties, valid.properties[0]],
      }).success,
    ).toBe(false);
    expect(
      collectionDefinitionSchema.safeParse({
        ...valid,
        views: [
          {
            ...valid.views[0],
            visiblePropertyIds: ["missing"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      collectionDefinitionSchema.safeParse({
        ...valid,
        initialViewId: "missing",
      }).success,
    ).toBe(false);
    const select = valid.properties.find((property) => property.type === "select");
    expect(select?.type).toBe("select");
    if (!select || select.type !== "select") throw new Error("missing select fixture");
    expect(
      collectionDefinitionSchema.safeParse({
        ...valid,
        properties: valid.properties.map((property) =>
          property.id === select.id
            ? { ...select, options: [...select.options, select.options[0]] }
            : property,
        ),
      }).success,
    ).toBe(false);
  });

  it("keeps an empty source title distinct from Brain's Untitled fallback", () => {
    const parsed = collectionRowSchema.parse({
      version: 1,
      source: "notion",
      databaseId: DATABASE_ID,
      values: {
        title: { type: "title", value: "" },
        kind: {
          type: "select",
          value: { id: "kind-a", name: "A", color: "blue" },
        },
        date: {
          type: "date",
          value: { start: "2026-07-12", end: "2026-07-13" },
        },
      },
    });

    expect(() =>
      assertCollectionRowMatchesDefinition(definition(), parsed),
    ).not.toThrow();
    expect(parsed.values.title).toEqual({ type: "title", value: "" });
  });

  it("rejects rows for another collection, unknown fields, and type drift", () => {
    const base = {
      version: 1 as const,
      source: "notion" as const,
      databaseId: DATABASE_ID,
      values: {
        title: { type: "title" as const, value: "Synthetic row" },
      },
    };

    expect(() =>
      assertCollectionRowMatchesDefinition(
        definition(),
        collectionRowSchema.parse({
          ...base,
          databaseId: "44444444444444444444444444444444",
        }),
      ),
    ).toThrow(/database/);
    expect(() =>
      assertCollectionRowMatchesDefinition(
        definition(),
        collectionRowSchema.parse({
          ...base,
          values: {
            ...base.values,
            unknown: { type: "title", value: "No" },
          },
        }),
      ),
    ).toThrow(/unknown property/);
    expect(() =>
      assertCollectionRowMatchesDefinition(
        definition(),
        collectionRowSchema.parse({
          ...base,
          values: {
            title: { type: "title", value: "Synthetic row" },
            date: { type: "select", value: null },
          },
        }),
      ),
    ).toThrow(/type mismatch/);
  });

  it("requires every schema property and exact select option membership", () => {
    const complete = {
      version: 1 as const,
      source: "notion" as const,
      databaseId: DATABASE_ID,
      values: {
        title: { type: "title" as const, value: "Synthetic row" },
        kind: {
          type: "select" as const,
          value: { id: "kind-a", name: "A", color: "blue" as const },
        },
        date: { type: "date" as const, value: null },
      },
    };

    const missing = collectionRowSchema.parse({
      ...complete,
      values: { title: complete.values.title, kind: complete.values.kind },
    });
    expect(() =>
      assertCollectionRowMatchesDefinition(definition(), missing),
    ).toThrow(/missing property: date/);

    const unknownOption = collectionRowSchema.parse({
      ...complete,
      values: {
        ...complete.values,
        kind: {
          type: "select",
          value: { id: "kind-unknown", name: "Unknown", color: "red" },
        },
      },
    });
    expect(() =>
      assertCollectionRowMatchesDefinition(definition(), unknownOption),
    ).toThrow(/unknown or changed option/);

    const changedOption = collectionRowSchema.parse({
      ...complete,
      values: {
        ...complete.values,
        kind: {
          type: "select",
          value: { id: "kind-a", name: "Renamed", color: "blue" },
        },
      },
    });
    expect(() =>
      assertCollectionRowMatchesDefinition(definition(), changedOption),
    ).toThrow(/unknown or changed option/);
  });

  it("rejects duplicate or non-schema multi-select options", () => {
    const multiDefinition = collectionDefinitionSchema.parse({
      ...definition(),
      properties: [
        ...definition().properties,
        {
          id: "labels",
          name: "Labels",
          type: "multi_select",
          position: 3,
          options: [
            { id: "label-a", name: "A", color: "green" },
            { id: "label-b", name: "B", color: "gray" },
          ],
        },
      ],
    });
    const rowWithLabels = (labels: unknown[]) =>
      collectionRowSchema.parse({
        version: 1,
        source: "notion",
        databaseId: DATABASE_ID,
        values: {
          title: { type: "title", value: "Synthetic row" },
          kind: { type: "select", value: null },
          date: { type: "date", value: null },
          labels: { type: "multi_select", value: labels },
        },
      });

    expect(() =>
      assertCollectionRowMatchesDefinition(
        multiDefinition,
        rowWithLabels([
          { id: "label-a", name: "A", color: "green" },
          { id: "label-a", name: "A", color: "green" },
        ]),
      ),
    ).toThrow(/repeats option/);
    expect(() =>
      assertCollectionRowMatchesDefinition(
        multiDefinition,
        rowWithLabels([{ id: "label-x", name: "X", color: "red" }]),
      ),
    ).toThrow(/unknown or changed option/);
  });
});
