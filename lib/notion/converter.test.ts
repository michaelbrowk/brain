import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertNotionConversionReady,
  convertNotionDocument,
  convertNotionDocumentWithIssues,
  conversionHashForNotionDocument,
  sourceHashForNotionDocument,
  type NotionImportDocument,
} from "./converter";
import {
  canonicalizeNotionImportTarget,
  notionConversionHash,
} from "./protocol";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const ROOT_PLACEMENT = { parentId: null, beforeId: null } as const;

describe("Notion converter", () => {
  it("matches the structured golden fixture without dropping unknown blocks", async () => {
    const input = JSON.parse(
      await fs.readFile(path.join(fixtures, "structured.json"), "utf8"),
    ) as NotionImportDocument;
    const expected = (
      await fs.readFile(path.join(fixtures, "structured.md"), "utf8")
    ).trim();

    expect(
      convertNotionDocument(input, {
        ...ROOT_PLACEMENT,
        pageIdByNotionId: {
          ["3".repeat(32)]: "health-page",
        },
      }),
    ).toBe(expected);
  });

  it("marks unresolved page references and keeps their source URL", () => {
    const result = convertNotionDocumentWithIssues(
      {
        notionId: "a".repeat(32),
        title: "Root",
        blocks: [
          {
            type: "page_ref",
            notionId: "b".repeat(32),
            title: "Missing",
            sourceUrl: "https://www.notion.so/missing",
          },
        ],
      },
      { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} },
    );

    expect(result.markdown).toContain("[Missing](https://www.notion.so/missing)");
    expect(result.markdown).toContain('"type":"unresolved_page_ref"');
    expect(result.markdown).toContain('"raw":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
    expect(result.issues).toEqual([
      { type: "unresolved_page_ref", raw: "b".repeat(32) },
    ]);
    expect(() => assertNotionConversionReady(result)).toThrowError(
      expect.objectContaining({ name: "NotionConversionIssuesError" }),
    );
  });

  it("never silently drops an unrecognized runtime IR block", () => {
    const markdown = convertNotionDocument(
      {
        notionId: "a".repeat(32),
        title: "Future block",
        blocks: [
          {
            type: "synced_block",
            id: "future-1",
            children: [{ type: "paragraph", text: "preserve me" }],
          } as unknown as NotionImportDocument["blocks"][number],
        ],
      },
      { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} },
    );

    expect(markdown).toContain('"type":"synced_block"');
    expect(markdown).toContain("preserve me");
  });

  it("passes the execution gate only when conversion has no issues", () => {
    const result = convertNotionDocumentWithIssues(
      {
        notionId: "a".repeat(32),
        title: "Ready",
        blocks: [{ type: "markdown", markdown: "Body" }],
      },
      { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} },
    );

    expect(result).toEqual({ markdown: "Body", issues: [] });
    expect(() => assertNotionConversionReady(result)).not.toThrow();
  });

  it("produces a stable sha256 independent of object key insertion order", () => {
    const left: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "Page",
      blocks: [{ type: "markdown", markdown: "Body" }],
    };
    const right = {
      blocks: [{ markdown: "Body", type: "markdown" }],
      title: "Page",
      notionId: "a".repeat(32),
    } as NotionImportDocument;

    expect(sourceHashForNotionDocument(left)).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceHashForNotionDocument(left)).toBe(
      sourceHashForNotionDocument(right),
    );
  });

  it("canonicalizes dashed and undashed Notion ids before source hashing", () => {
    const undashed: NotionImportDocument = {
      notionId: "11111111111111111111111111111111",
      title: "Root",
      blocks: [
        {
          type: "page_ref",
          notionId: "22222222222222222222222222222222",
          title: "Child",
        },
      ],
    };
    const dashed: NotionImportDocument = {
      ...undashed,
      notionId: "11111111-1111-1111-1111-111111111111",
      blocks: [
        {
          type: "page_ref",
          notionId: "22222222-2222-2222-2222-222222222222",
          title: "Child",
        },
      ],
    };

    expect(sourceHashForNotionDocument(dashed)).toBe(
      sourceHashForNotionDocument(undashed),
    );
  });

  it("changes the source hash when a page-reference dependency resolves", () => {
    const document: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "Root",
      blocks: [
        { type: "page_ref", notionId: "b".repeat(32), title: "Child" },
      ],
    };

    const unresolved = conversionHashForNotionDocument(document, {
      ...ROOT_PLACEMENT,
      pageIdByNotionId: {},
    });
    const resolved = conversionHashForNotionDocument(document, {
      ...ROOT_PLACEMENT,
      pageIdByNotionId: { ["b".repeat(32)]: "brain-child" },
    });

    expect(resolved).not.toBe(unresolved);
  });

  it("binds the immutable hierarchy plan into the conversion hash", () => {
    const document: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "Page",
      blocks: [{ type: "markdown", markdown: "Body" }],
    };
    const root = conversionHashForNotionDocument(document, {
      ...ROOT_PLACEMENT,
      pageIdByNotionId: {},
    });
    const nested = conversionHashForNotionDocument(document, {
      parentId: "brain-parent",
      beforeId: "brain-sibling",
      pageIdByNotionId: {},
    });

    expect(nested).not.toBe(root);
  });

  it("preserves indented code and represents empty blocks explicitly", () => {
    const markdown = convertNotionDocument(
      {
        notionId: "a".repeat(32),
        title: "Whitespace",
        blocks: [
          { type: "markdown", markdown: "    first\n    second" },
          { type: "markdown", markdown: "" },
        ],
      },
      { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} },
    );

    expect(markdown).toMatch(/^    first\n    second/);
    expect(markdown).toContain('"type":"empty_block"');
  });

  it("serializes reviewed empty blocks as a lossless editor directive", () => {
    const markdown = convertNotionDocument(
      {
        notionId: "a".repeat(32),
        title: "Explicit whitespace",
        blocks: [{ type: "empty_block" }, { type: "empty_block" }],
      },
      { ...ROOT_PLACEMENT, pageIdByNotionId: {} },
    );
    expect(markdown).toBe("::empty-block\n\n::empty-block");
  });

  it("hashes attachment bytes before reserve and resolves only matching local uploads", () => {
    const sha256 = "c".repeat(64);
    const document: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "Image",
      blocks: [
        {
          type: "attachment",
          sourceId: "image-block-1",
          sha256,
          name: "photo.png",
          mimeType: "image/png",
          kind: "image",
          alt: "Photo",
        },
      ],
    };
    const planned = convertNotionDocument(document, {
      ...ROOT_PLACEMENT,
      pageIdByNotionId: {},
    });
    const resolved = convertNotionDocument(document, {
      ...ROOT_PLACEMENT,
      pageIdByNotionId: {},
      attachmentUrlBySourceId: {
        "image-block-1": `/_attachments-v2/${sha256}.png`,
      },
    });
    const changedBytes: NotionImportDocument = {
      ...document,
      blocks: [
        {
          ...document.blocks[0],
          type: "attachment",
          sha256: "d".repeat(64),
        } as Extract<NotionImportDocument["blocks"][number], { type: "attachment" }>,
      ],
    };

    expect(planned).toBe(`![Photo](/_attachments-v2/${sha256}.png)`);
    expect(resolved).toBe(`![Photo](/_attachments-v2/${sha256}.png)`);
    expect(sourceHashForNotionDocument(changedBytes)).not.toBe(
      sourceHashForNotionDocument(document),
    );
  });

  it.each([
    { name: "misleading.png", mimeType: "image/jpg", extension: "jpg" },
    { name: "extensionless", mimeType: "image/x-png", extension: "png" },
    { name: "photo.jpeg", mimeType: "image/pjpeg", extension: "jpg" },
  ])(
    "uses canonical MIME for image alias $mimeType",
    ({ name, mimeType, extension }) => {
      const sha256 = "9".repeat(64);
      const result = convertNotionDocumentWithIssues(
        {
          notionId: "a".repeat(32),
          title: "Alias",
          blocks: [
            {
              type: "attachment",
              sourceId: "alias-image",
              sha256,
              name,
              mimeType,
              kind: "image",
              alt: "Alias",
            },
          ],
        },
        { ...ROOT_PLACEMENT, pageIdByNotionId: {} },
      );
      expect(result.issues).toEqual([]);
      expect(result.markdown).toBe(
        `![Alias](/_attachments-v2/${sha256}.${extension})`,
      );
    },
  );

  it("blocks SVG image rendering until it is converted or imported as a file", () => {
    const result = convertNotionDocumentWithIssues(
      {
        notionId: "a".repeat(32),
        title: "SVG",
        blocks: [
          {
            type: "attachment",
            sourceId: "svg-1",
            sha256: "c".repeat(64),
            name: "drawing.svg",
            mimeType: "image/svg+xml",
            kind: "image",
          },
        ],
      },
      { ...ROOT_PLACEMENT, pageIdByNotionId: {} },
    );

    expect(result.issues).toEqual([
      { type: "non_raster_image_unsupported", raw: "svg-1" },
    ]);
    expect(() => assertNotionConversionReady(result)).toThrow();
  });

  it.each([
    { name: "drawing.svg", mimeType: "application/octet-stream" },
    { name: "drawing.png", mimeType: "image/x-svg+xml" },
    { name: "drawing.svg", mimeType: "image/png" },
  ])(
    "blocks disguised SVG image descriptors ($name, $mimeType)",
    ({ name, mimeType }) => {
      const result = convertNotionDocumentWithIssues(
        {
          notionId: "a".repeat(32),
          title: "SVG",
          blocks: [
            {
              type: "attachment",
              sourceId: "svg-disguised",
              sha256: "c".repeat(64),
              name,
              mimeType,
              kind: "image",
            },
          ],
        },
        { ...ROOT_PLACEMENT, pageIdByNotionId: {} },
      );
      expect(result.issues).toContainEqual({
        type: "non_raster_image_unsupported",
        raw: "svg-disguised",
      });
    },
  );

  it("applies the same raster-only gate to covers", () => {
    const result = convertNotionDocumentWithIssues(
      {
        notionId: "a".repeat(32),
        title: "SVG cover",
        cover: {
          sourceId: "cover-svg",
          sha256: "d".repeat(64),
          name: "cover.svg",
          mimeType: "application/octet-stream",
        },
        blocks: [{ type: "markdown", markdown: "Body" }],
      },
      { ...ROOT_PLACEMENT, pageIdByNotionId: {} },
    );
    expect(result.issues).toContainEqual({
      type: "non_raster_cover_unsupported",
      raw: "cover-svg",
    });
    expect(() => assertNotionConversionReady(result)).toThrow();
  });

  it("allows SVG only as a downloadable file block", () => {
    const result = convertNotionDocumentWithIssues(
      {
        notionId: "a".repeat(32),
        title: "SVG file",
        blocks: [
          {
            type: "attachment",
            sourceId: "svg-file",
            sha256: "e".repeat(64),
            name: "drawing.svg",
            mimeType: "image/svg+xml",
            kind: "file",
          },
        ],
      },
      { ...ROOT_PLACEMENT, pageIdByNotionId: {} },
    );
    expect(result.issues).toEqual([]);
    expect(result.markdown).toBe(
      `[drawing.svg](/_attachments-v2/${"e".repeat(64)}.svg)`,
    );
  });

  it("preserves entity-looking toggle summaries as an unsupported marker", () => {
    const markdown = convertNotionDocument(
      {
        notionId: "a".repeat(32),
        title: "Entities",
        blocks: [
          {
            type: "toggle",
            summary: "literal &amp; &#34; &#x22;",
            children: [{ type: "markdown", markdown: "Body" }],
          },
        ],
      },
      { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} },
    );

    expect(markdown).toContain('"type":"toggle_unsafe_summary"');
    expect(markdown).toContain("&amp; &#34; &#x22;");
    expect(markdown).not.toContain(":::toggle");
  });

  it("changes source and conversion hashes for a cover-only byte update", () => {
    const base: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "Cover",
      cover: {
        sourceId: "cover-1",
        sha256: "e".repeat(64),
        name: "cover.jpg",
        mimeType: "image/jpeg",
      },
      blocks: [{ type: "markdown", markdown: "Body" }],
    };
    const changed: NotionImportDocument = {
      ...base,
      cover: { ...base.cover!, sha256: "f".repeat(64) },
    };

    expect(sourceHashForNotionDocument(changed)).not.toBe(
      sourceHashForNotionDocument(base),
    );
    expect(
      conversionHashForNotionDocument(changed, { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} }),
    ).not.toBe(
      conversionHashForNotionDocument(base, { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} }),
    );
  });

  it("hashes the exact canonical target for trailing whitespace and empty metadata", () => {
    const document: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "   ",
      icon: "",
      blocks: [{ type: "markdown", markdown: "Body  \n\n" }],
    };
    const sourceHash = sourceHashForNotionDocument(document);
    const markdown = convertNotionDocument(document, { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} });

    expect(markdown).toBe("Body");
    expect(
      conversionHashForNotionDocument(document, { ...ROOT_PLACEMENT,
 pageIdByNotionId: {} }),
    ).toBe(
      notionConversionHash(
        canonicalizeNotionImportTarget({
          sourceHash,
          ...ROOT_PLACEMENT,
          title: document.title,
          icon: document.icon,
          markdown: "Body  \n\n",
        }),
      ),
    );
  });

  it("keeps legacy page hashes stable and commits collection metadata when present", () => {
    const target = canonicalizeNotionImportTarget({
      sourceHash: "a".repeat(64),
      parentId: null,
      beforeId: null,
      title: "T",
      markdown: "Body",
    });
    const legacyHash = notionConversionHash(target);

    expect(legacyHash).toBe(
      "27d095b98cb250299d280418c7e5f22b945ee84671bfda361edda9d7a7c90460",
    );
    expect(
      notionConversionHash({
        ...target,
        collection: {
          version: 1,
          source: "notion",
          databaseId: "a".repeat(32),
          dataSourceId: "b".repeat(32),
          titlePropertyId: "title",
          properties: [
            { id: "title", name: "Name", type: "title", position: 0 },
          ],
          views: [
            { id: "all", type: "table", rowNotionIds: [] },
          ],
          initialViewId: "all",
        },
      }),
    ).not.toBe(legacyHash);
  });

  it("rejects a cover URL that does not match the source attachment hash", () => {
    const document: NotionImportDocument = {
      notionId: "a".repeat(32),
      title: "Cover",
      cover: {
        sourceId: "cover-1",
        sha256: "a".repeat(64),
        name: "cover.png",
        mimeType: "image/png",
      },
      blocks: [],
    };

    expect(() =>
      conversionHashForNotionDocument(document, {
        ...ROOT_PLACEMENT,
        pageIdByNotionId: {},
        attachmentUrlBySourceId: {
          "cover-1": `/_attachments-v2/${"b".repeat(64)}.png`,
        },
      }),
    ).toThrow(/cover attachment URL does not match/);
  });
});
