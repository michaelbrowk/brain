import { describe, expect, it } from "vitest";
import {
  conversionHashForNotionDocument,
  type NotionImportDocument,
} from "./converter";
import {
  canonicalizeNotionImportTarget,
  notionConversionHash,
} from "./protocol";

describe("Notion collection hash compatibility", () => {
  it("treats explicit collection clears as an omitted final state", () => {
    const target = {
      sourceHash: "a".repeat(64),
      parentId: null,
      beforeId: null,
      title: "Synthetic page",
      markdown: "Body",
    };
    const legacy = canonicalizeNotionImportTarget(target);
    const cleared = canonicalizeNotionImportTarget({
      ...target,
      collection: null,
      collectionRow: null,
    });
    expect(cleared).not.toHaveProperty("collection");
    expect(cleared).not.toHaveProperty("collectionRow");
    expect(notionConversionHash(cleared)).toBe(notionConversionHash(legacy));
    expect(
      notionConversionHash({
        ...legacy,
        collection: null,
        collectionRow: null,
      }),
    ).toBe(notionConversionHash(legacy));

    const document: NotionImportDocument = {
      notionId: "b".repeat(32),
      title: "Synthetic page",
      blocks: [{ type: "markdown", markdown: "Body" }],
    };
    const options = {
      parentId: null,
      beforeId: null,
      pageIdByNotionId: new Map<string, string>(),
    };
    expect(
      conversionHashForNotionDocument(document, options, {
        collection: null,
        collectionRow: null,
      }),
    ).toBe(conversionHashForNotionDocument(document, options));
  });
});
