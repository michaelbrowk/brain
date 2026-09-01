import { z } from "zod";

export const COLLECTION_META_VERSION = 1 as const;

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/, "control characters are not allowed");

const sourceIdSchema = boundedText(256);
const notionIdSchema = z
  .string()
  .regex(
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i,
  )
  .transform((value) => value.replaceAll("-", "").toLowerCase());

export const notionColorSchema = z.enum([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
]);

export const collectionOptionSchema = z
  .object({
    id: sourceIdSchema,
    name: boundedText(200),
    color: notionColorSchema.optional(),
  })
  .strict();

const propertyBase = {
  id: sourceIdSchema,
  name: boundedText(200),
  position: z.number().int().min(0).max(63),
  readOnly: z.boolean().optional(),
} satisfies z.ZodRawShape;

export const collectionPropertySchema = z.discriminatedUnion("type", [
  z.object({ ...propertyBase, type: z.literal("title") }).strict(),
  z.object({ ...propertyBase, type: z.literal("date") }).strict(),
  z
    .object({
      ...propertyBase,
      type: z.literal("select"),
      options: z.array(collectionOptionSchema).max(128),
    })
    .strict(),
  z
    .object({
      ...propertyBase,
      type: z.literal("multi_select"),
      options: z.array(collectionOptionSchema).max(128),
    })
    .strict(),
  z.object({ ...propertyBase, type: z.literal("people") }).strict(),
  z.object({ ...propertyBase, type: z.literal("verification") }).strict(),
  z.object({ ...propertyBase, type: z.literal("last_edited_time") }).strict(),
]);

const collectionSortSchema = z
  .object({
    propertyId: sourceIdSchema,
    direction: z.enum(["ascending", "descending"]),
  })
  .strict();

const collectionGroupSchema = z
  .object({
    propertyId: sourceIdSchema,
    manualOptionIds: z.array(sourceIdSchema).max(128).optional(),
    hideEmptyGroups: z.boolean().optional(),
  })
  .strict();

const collectionFilterSchema = z
  .object({
    kind: z.enum(["all", "today", "source"]),
    propertyId: sourceIdSchema.optional(),
  })
  .strict();

export const collectionViewSchema = z
  .object({
    id: sourceIdSchema,
    name: z.string().max(200).optional(),
    type: z.enum(["table", "board", "list", "timeline"]),
    rowNotionIds: z.array(notionIdSchema).max(10_000),
    visiblePropertyIds: z.array(sourceIdSchema).max(64).optional(),
    sorts: z.array(collectionSortSchema).max(16).optional(),
    groupBy: collectionGroupSchema.optional(),
    datePropertyId: sourceIdSchema.optional(),
    filter: collectionFilterSchema.optional(),
    queryMode: z.enum(["view", "sql-fallback"]).optional(),
  })
  .strict();

export const collectionDefinitionSchema = z
  .object({
    version: z.literal(COLLECTION_META_VERSION),
    source: z.literal("notion"),
    databaseId: notionIdSchema,
    dataSourceId: notionIdSchema,
    titlePropertyId: sourceIdSchema,
    properties: z.array(collectionPropertySchema).min(1).max(64),
    views: z.array(collectionViewSchema).min(1).max(16),
    initialViewId: sourceIdSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const propertyIds = new Set<string>();
    for (const property of value.properties) {
      if (propertyIds.has(property.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate collection property id: ${property.id}`,
          path: ["properties"],
        });
      }
      propertyIds.add(property.id);
      if (property.type === "select" || property.type === "multi_select") {
        const optionIds = new Set<string>();
        for (const option of property.options) {
          if (optionIds.has(option.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `duplicate collection option id: ${option.id}`,
              path: ["properties"],
            });
          }
          optionIds.add(option.id);
        }
      }
    }
    const title = value.properties.find(
      (property) => property.id === value.titlePropertyId,
    );
    if (title?.type !== "title") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "titlePropertyId must reference a title property",
        path: ["titlePropertyId"],
      });
    }

    const viewIds = new Set<string>();
    for (const [index, view] of value.views.entries()) {
      if (viewIds.has(view.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate collection view id: ${view.id}`,
          path: ["views", index, "id"],
        });
      }
      viewIds.add(view.id);
      const references = [
        ...(view.visiblePropertyIds ?? []),
        ...(view.sorts ?? []).map((sort) => sort.propertyId),
        ...(view.groupBy ? [view.groupBy.propertyId] : []),
        ...(view.datePropertyId ? [view.datePropertyId] : []),
        ...(view.filter?.propertyId ? [view.filter.propertyId] : []),
      ];
      for (const reference of references) {
        if (!propertyIds.has(reference)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `view references unknown property: ${reference}`,
            path: ["views", index],
          });
        }
      }
    }
    if (!viewIds.has(value.initialViewId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "initialViewId must reference a collection view",
        path: ["initialViewId"],
      });
    }
  });

const isoDateSchema = z
  .string()
  .max(64)
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/);

const collectionDateSchema = z
  .object({
    start: isoDateSchema,
    end: isoDateSchema.optional(),
    timeZone: z.string().min(1).max(100).optional(),
  })
  .strict();

const collectionPersonSchema = z
  .object({
    id: sourceIdSchema,
    name: z.string().max(200).optional(),
  })
  .strict();

const collectionVerificationSchema = z
  .object({
    state: z.enum(["verified", "unverified", "expired"]),
    verifiedBy: collectionPersonSchema.optional(),
    date: isoDateSchema.optional(),
  })
  .strict();

export const collectionPropertyValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("title"), value: z.string().max(10_000) }).strict(),
  z
    .object({ type: z.literal("date"), value: collectionDateSchema.nullable() })
    .strict(),
  z
    .object({ type: z.literal("select"), value: collectionOptionSchema.nullable() })
    .strict(),
  z
    .object({
      type: z.literal("multi_select"),
      value: z.array(collectionOptionSchema).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("people"),
      value: z.array(collectionPersonSchema).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("verification"),
      value: collectionVerificationSchema.nullable(),
    })
    .strict(),
  z
    .object({ type: z.literal("last_edited_time"), value: isoDateSchema.nullable() })
    .strict(),
]);

export const collectionRowSchema = z
  .object({
    version: z.literal(COLLECTION_META_VERSION),
    source: z.literal("notion"),
    databaseId: notionIdSchema,
    values: z.record(sourceIdSchema, collectionPropertyValueSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value.values).length > 64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "collection row has too many values",
        path: ["values"],
      });
    }
  });

export type NotionColor = z.infer<typeof notionColorSchema>;
export type CollectionOption = z.infer<typeof collectionOptionSchema>;
export type CollectionProperty = z.infer<typeof collectionPropertySchema>;
export type CollectionView = z.infer<typeof collectionViewSchema>;
export type CollectionDefinition = z.infer<typeof collectionDefinitionSchema>;
export type CollectionPropertyValue = z.infer<
  typeof collectionPropertyValueSchema
>;
export type CollectionRow = z.infer<typeof collectionRowSchema>;

export function assertCollectionRowMatchesDefinition(
  definition: CollectionDefinition,
  row: CollectionRow,
): void {
  if (row.databaseId !== definition.databaseId) {
    throw new Error("collection row database does not match its parent");
  }
  const properties = new Map(
    definition.properties.map((property) => [property.id, property]),
  );
  for (const [propertyId, value] of Object.entries(row.values)) {
    const property = properties.get(propertyId);
    if (!property) {
      throw new Error(`collection row references unknown property: ${propertyId}`);
    }
    if (property.type !== value.type) {
      throw new Error(`collection row value type mismatch: ${propertyId}`);
    }
    if (property.type === "select" && value.type === "select" && value.value) {
      assertCollectionOptionMatches(property.options, value.value, propertyId);
    }
    if (
      property.type === "multi_select" &&
      value.type === "multi_select"
    ) {
      const selectedIds = new Set<string>();
      for (const option of value.value) {
        if (selectedIds.has(option.id)) {
          throw new Error(`collection row repeats option: ${propertyId}`);
        }
        selectedIds.add(option.id);
        assertCollectionOptionMatches(property.options, option, propertyId);
      }
    }
  }
  for (const property of definition.properties) {
    if (row.values[property.id] === undefined) {
      throw new Error(`collection row is missing property: ${property.id}`);
    }
  }
  const title = row.values[definition.titlePropertyId];
  if (!title || title.type !== "title") {
    throw new Error("collection row must preserve its title value");
  }
}

function assertCollectionOptionMatches(
  options: readonly CollectionOption[],
  actual: CollectionOption,
  propertyId: string,
): void {
  const expected = options.find((option) => option.id === actual.id);
  if (
    !expected ||
    expected.name !== actual.name ||
    expected.color !== actual.color
  ) {
    throw new Error(`collection row uses an unknown or changed option: ${propertyId}`);
  }
}
