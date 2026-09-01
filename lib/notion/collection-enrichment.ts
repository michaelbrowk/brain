import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertCollectionRowMatchesDefinition,
  collectionDefinitionSchema,
  collectionRowSchema,
} from "../collections/model.ts";
import { readPrivateOperatorText } from "./private-operator-file.ts";

const MAX_ENRICHMENT_BYTES = 4 * 1024 * 1024;
const notionIdSchema = z
  .string()
  .regex(
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i,
  )
  .transform((value) => value.replaceAll("-", "").toLowerCase());

const enrichedRowSchema = z
  .object({
    notionId: notionIdSchema,
    title: z.string().min(1).max(500),
    collectionRow: collectionRowSchema,
  })
  .strict();

const enrichedCollectionSchema = z
  .object({
    notionId: notionIdSchema,
    parentNotionId: notionIdSchema,
    title: z.string().min(1).max(500),
    icon: z.string().min(1).max(64).optional(),
    definition: collectionDefinitionSchema,
    rows: z.array(enrichedRowSchema).max(10_000),
  })
  .strict()
  .superRefine((collection, ctx) => {
    if (collection.notionId !== collection.definition.databaseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "collection node id must match its database id",
        path: ["notionId"],
      });
    }
    if (collection.parentNotionId === collection.notionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "collection cannot parent itself",
        path: ["parentNotionId"],
      });
    }
    const rows = new Set<string>();
    for (const [index, row] of collection.rows.entries()) {
      if (rows.has(row.notionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate enriched collection row id",
          path: ["rows", index, "notionId"],
        });
      }
      rows.add(row.notionId);
      try {
        assertCollectionRowMatchesDefinition(
          collection.definition,
          row.collectionRow,
        );
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "enriched row does not match its collection definition",
          path: ["rows", index, "collectionRow"],
        });
      }
      const sourceTitle =
        row.collectionRow.values[collection.definition.titlePropertyId];
      const expectedTitle =
        sourceTitle?.type === "title" && sourceTitle.value
          ? sourceTitle.value
          : "Untitled";
      if (row.title !== expectedTitle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "enriched row Brain title does not match its source title",
          path: ["rows", index, "title"],
        });
      }
    }
    const listed = new Set<string>();
    for (const [viewIndex, view] of collection.definition.views.entries()) {
      for (const rowNotionId of view.rowNotionIds) {
        if (!rows.has(rowNotionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "collection view references an unknown enriched row",
            path: ["definition", "views", viewIndex, "rowNotionIds"],
          });
        }
        listed.add(rowNotionId);
      }
    }
    for (const rowNotionId of rows) {
      if (!listed.has(rowNotionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "enriched row is unreachable from every source view",
          path: ["rows"],
        });
      }
    }
  });

const enrichmentManifestSchema = z
  .object({
    version: z.literal(1),
    source: z.literal("notion-mcp-reviewed"),
    capturedAt: z.string().datetime({ offset: true }),
    stableConsecutiveCaptures: z.literal(true),
    collections: z.array(enrichedCollectionSchema).min(1).max(16),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const databaseIds = new Set<string>();
    const dataSourceIds = new Set<string>();
    for (const [index, collection] of manifest.collections.entries()) {
      if (databaseIds.has(collection.notionId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate enriched collection database id",
          path: ["collections", index, "notionId"],
        });
      }
      if (dataSourceIds.has(collection.definition.dataSourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate enriched collection data source id",
          path: ["collections", index, "definition", "dataSourceId"],
        });
      }
      databaseIds.add(collection.notionId);
      dataSourceIds.add(collection.definition.dataSourceId);
    }
  });

export type EnrichedCollection = z.infer<typeof enrichedCollectionSchema>;

export interface CollectionEnrichmentManifest
  extends z.infer<typeof enrichmentManifestSchema> {
  fingerprint: string;
  collectionByNotionId: ReadonlyMap<string, EnrichedCollection>;
}

export function parseCollectionEnrichmentManifest(
  input: string,
): CollectionEnrichmentManifest {
  if (Buffer.byteLength(input, "utf8") > MAX_ENRICHMENT_BYTES) {
    throw new Error("collection enrichment manifest exceeds byte limit");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("collection enrichment manifest contains invalid JSON");
  }
  const parsed = enrichmentManifestSchema.parse(raw);
  const collectionByNotionId = new Map(
    parsed.collections.map((collection) => [collection.notionId, collection]),
  );
  return {
    ...parsed,
    collectionByNotionId,
    fingerprint: createHash("sha256")
      .update(stableJson(parsed))
      .digest("hex"),
  };
}

/** This reviewed manifest contains personal source topology and properties.
 * Keep it out of both application Git and the notes tree, with the same
 * owner-only boundary as import bindings. */
export async function readPrivateCollectionEnrichmentFile(
  filePath: string,
  forbiddenRoots: readonly string[] = [],
): Promise<CollectionEnrichmentManifest> {
  const text = await readPrivateOperatorText(filePath, {
    label: "collection enrichment",
    maxBytes: MAX_ENRICHMENT_BYTES,
    forbiddenRoots,
  });
  return parseCollectionEnrichmentManifest(text);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
