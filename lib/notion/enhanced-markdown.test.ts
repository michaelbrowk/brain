import { describe, expect, it } from "vitest";
import { convertNotionDocumentWithIssues } from "./converter";
import {
  assertEnhancedMarkdownReady,
  buildNotionDocumentFromEnhancedMarkdown,
} from "./enhanced-markdown";
import { stableNotionAssetId, type ResolvedNotionAsset } from "./notion-assets";
import { PERSONAL_REVIEWED_LITERAL_SPECS } from "./reviewed-markup";
import type { SnapshotPageRecord } from "./snapshot";

const PAGE = "1".repeat(32);
const TARGET = "2".repeat(32);
const ASSET = "https://file.notion.so/f/synthetic/standalone.png?token=one";
// Read off the inventory rather than copied, so the two cannot drift apart.
const REVIEWED_INSERT = PERSONAL_REVIEWED_LITERAL_SPECS[0].notionId;
const REVIEWED_CLOSINGS = PERSONAL_REVIEWED_LITERAL_SPECS[1].notionId;

function syntheticPage(markdown: string): SnapshotPageRecord {
  return {
    type: "page",
    notionId: PAGE,
    parentNotionId: null,
    position: 0,
    title: "Synthetic",
    enhancedMarkdown: markdown,
    assets: [],
  };
}

describe("Notion enhanced Markdown adapter", () => {
  it("canonicalizes empty blocks, hard breaks, page refs, and external links", () => {
    const page = syntheticPage(
      [
        "before<br>after",
        "<empty-block/>",
        `[internal](https://app.notion.com/p/synthetic/Synthetic-${TARGET}) and [external](https://example.test/?q=one)`,
      ].join("\n"),
    );
    const result = buildNotionDocumentFromEnhancedMarkdown(page, new Map());
    expect(result.issues).toEqual([]);
    expect(result.stats).toMatchObject({
      emptyBlocks: 1,
      hardBreaks: 1,
      pageRefs: 1,
      externalLinks: 1,
    });
    const converted = convertNotionDocumentWithIssues(result.document, {
      parentId: null,
      beforeId: null,
      pageIdByNotionId: { [TARGET]: "brain-target" },
    });
    expect(converted.issues).toEqual([]);
    expect(converted.markdown).toContain("before\\\nafter");
    expect(converted.markdown).toContain("[internal](/p/brain-target)");
    expect(converted.markdown).toContain(
      "[external](https://example.test/?q=one)",
    );
    expect(converted.markdown).toContain("::empty-block");
  });

  it("turns a standalone PNG into an attachment block", () => {
    const page = {
      ...syntheticPage(`![Standalone](${ASSET})`),
      assets: [{ url: ASSET, name: "standalone.png", kind: "image" as const }],
    };
    const sourceId = stableNotionAssetId(ASSET);
    const resolved: ResolvedNotionAsset = {
      sourceId,
      name: "standalone.png",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      bytes: new Uint8Array([1]),
    };
    const result = buildNotionDocumentFromEnhancedMarkdown(
      page,
      new Map([[sourceId, resolved]]),
    );
    expect(result.issues).toEqual([]);
    expect(result.stats.assets).toBe(1);
    expect(result.document.blocks).toEqual([
      expect.objectContaining({
        type: "attachment",
        sourceId,
        sha256: "a".repeat(64),
        kind: "image",
      }),
    ]);
  });

  it("turns a declared standalone file link into a file attachment block", () => {
    const fileUrl = "https://file.notion.so/f/synthetic/data.json?token=one";
    const page = {
      ...syntheticPage(`[data.json](${fileUrl})`),
      assets: [{ url: fileUrl, name: "data.json", kind: "file" as const }],
    };
    const sourceId = stableNotionAssetId(fileUrl);
    const resolved: ResolvedNotionAsset = {
      sourceId,
      name: "data.json",
      mimeType: "application/json",
      sha256: "b".repeat(64),
      bytes: new TextEncoder().encode('{"safe":true}'),
    };

    const result = buildNotionDocumentFromEnhancedMarkdown(
      page,
      new Map([[sourceId, resolved]]),
    );

    expect(result.issues).toEqual([]);
    expect(result.stats.assets).toBe(1);
    expect(result.document.blocks).toContainEqual({
      type: "attachment",
      sourceId,
      sha256: "b".repeat(64),
      name: "data.json",
      mimeType: "application/json",
      kind: "file",
    });
  });

  it("keeps a literal Brain empty-block spelling as escaped prose", () => {
    const result = buildNotionDocumentFromEnhancedMarkdown(
      syntheticPage(["<empty-block/>", "::empty-block"].join("\n")),
      new Map(),
    );
    expect(result.stats.emptyBlocks).toBe(1);
    expect(result.document.blocks.filter((block) => block.type === "empty_block"))
      .toHaveLength(1);
    const converted = convertNotionDocumentWithIssues(result.document, {
      parentId: null,
      beforeId: null,
      pageIdByNotionId: {},
    });
    expect(converted.issues).toEqual([]);
    expect(converted.markdown).toBe("::empty-block\n\n\\::empty-block");
  });

  it("keeps nested quote and list empty-block spellings as literal prose", () => {
    const result = buildNotionDocumentFromEnhancedMarkdown(
      syntheticPage(
        ["> ::empty-block", "- ::empty-block", "> - ::empty-block"].join(
          "\n",
        ),
      ),
      new Map(),
    );
    expect(result.stats.emptyBlocks).toBe(0);
    expect(result.document.blocks).not.toContainEqual({ type: "empty_block" });
    const converted = convertNotionDocumentWithIssues(result.document, {
      parentId: null,
      beforeId: null,
      pageIdByNotionId: {},
    });
    expect(converted.issues).toEqual([]);
    expect(converted.markdown).toContain("> \\::empty-block");
    expect(converted.markdown).toContain("- \\::empty-block");
    expect(converted.markdown).toContain("> - \\::empty-block");
  });

  it("accepts only the reviewed escaped literal tags on their exact pages", () => {
    const insert = buildNotionDocumentFromEnhancedMarkdown(
      {
        ...syntheticPage("before \\<insert-here/> after"),
        notionId: REVIEWED_INSERT,
      },
      new Map(),
    );
    expect(insert.issues).toEqual([]);
    expect(insert.document.blocks).toEqual([
      {
        type: "rich_markdown",
        segments: [{ type: "text", text: "before \\<insert-here/> after" }],
      },
    ]);

    const closings = buildNotionDocumentFromEnhancedMarkdown(
      {
        ...syntheticPage("before \\</content>\n\\</invoke>"),
        notionId: REVIEWED_CLOSINGS,
      },
      new Map(),
    );
    expect(closings.issues).toEqual([]);

    for (const page of [
      syntheticPage("before \\<insert-here/> after"),
      {
        ...syntheticPage("before <insert-here/> after"),
        notionId: REVIEWED_INSERT,
      },
      {
        ...syntheticPage("before \\<arbitrary-html/> after"),
        notionId: REVIEWED_INSERT,
      },
      {
        ...syntheticPage("before \\\\<insert-here/> after"),
        notionId: REVIEWED_INSERT,
      },
    ]) {
      expect(
        buildNotionDocumentFromEnhancedMarkdown(page, new Map()).issues,
      ).toContainEqual(
        expect.objectContaining({ type: "unsupported_enhanced_markdown" }),
      );
    }

    const enclosingForeignTag = buildNotionDocumentFromEnhancedMarkdown(
      {
        ...syntheticPage("<foreign data-x=\\</content>"),
        notionId: REVIEWED_CLOSINGS,
      },
      new Map(),
    );
    expect(enclosingForeignTag.issues).toContainEqual(
      expect.objectContaining({ type: "unsupported_enhanced_markdown" }),
    );

    const mintedAfterSupportedTagRemoval = buildNotionDocumentFromEnhancedMarkdown(
      {
        ...syntheticPage(
          "before \\<insert-here/> after\n\\<insert<br>-here/>",
        ),
        notionId: REVIEWED_INSERT,
      },
      new Map(),
    );
    expect(mintedAfterSupportedTagRemoval.issues).toContainEqual(
      expect.objectContaining({ type: "unsupported_enhanced_markdown" }),
    );
  });

  it("fails closed on unknown tags, raw Notion URLs, and missing assets", () => {
    const unknown = buildNotionDocumentFromEnhancedMarkdown(
      syntheticPage("<database id=\"synthetic\"></database>"),
      new Map(),
    );
    expect(() => assertEnhancedMarkdownReady(unknown)).toThrowError(
      expect.objectContaining({ name: "EnhancedMarkdownIssuesError" }),
    );

    const raw = buildNotionDocumentFromEnhancedMarkdown(
      syntheticPage(`https://www.notion.so/${TARGET}`),
      new Map(),
    );
    expect(raw.issues).toContainEqual(
      expect.objectContaining({ type: "raw_notion_url" }),
    );

    const missing = buildNotionDocumentFromEnhancedMarkdown(
      {
        ...syntheticPage(`![Missing](${ASSET})`),
        assets: [{ url: ASSET, name: "standalone.png", kind: "image" }],
      },
      new Map(),
    );
    expect(missing.issues).toContainEqual(
      expect.objectContaining({ type: "asset_not_resolved" }),
    );

    const externalImage = buildNotionDocumentFromEnhancedMarkdown(
      syntheticPage("![external](https://example.test/image.png)"),
      new Map(),
    );
    expect(externalImage.issues).toContainEqual(
      expect.objectContaining({ type: "image_not_declared" }),
    );
  });

  const codeSentinels = [
    "<empty-block/>",
    "<!-- notion-empty-block -->",
    "<br>",
    `<mention-page url="https://app.notion.com/p/synthetic/Page-${TARGET}">mention</mention-page>`,
    "<database id=\"synthetic\"></database>",
    "::empty-block",
    `![asset](${ASSET})`,
    `[internal](https://app.notion.com/p/synthetic/Page-${TARGET})`,
    "[external](https://example.test/path)",
    `https://www.notion.so/${TARGET}`,
  ];

  it.each([
    {
      name: "backtick fence",
      markdown: ["````md", ...codeSentinels, "````"].join("\n"),
    },
    {
      name: "tilde fence",
      markdown: ["~~~md", ...codeSentinels, "~~~"].join("\n"),
    },
    {
      name: "long fence with a shorter non-closing run",
      markdown: ["`````md", "```", ...codeSentinels, "`````"].join("\n"),
    },
    {
      name: "indented code block",
      markdown: codeSentinels.map((line) => `    ${line}`).join("\n"),
    },
    {
      name: "inline code span",
      markdown: `before \`${codeSentinels.join(" | ")}\` after`,
    },
  ])("preserves every sentinel inside $name as code-only bytes", ({ markdown }) => {
    const result = buildNotionDocumentFromEnhancedMarkdown(
      syntheticPage(markdown),
      new Map(),
    );
    expect(result.issues).toEqual([]);
    expect(result.stats).toEqual({
      emptyBlocks: 0,
      hardBreaks: 0,
      externalLinks: 0,
      pageRefs: 0,
      assets: 0,
    });
    expect(result.document.blocks).toEqual([
      {
        type: "rich_markdown",
        segments: [{ type: "text", text: markdown }],
      },
    ]);
  });
});
