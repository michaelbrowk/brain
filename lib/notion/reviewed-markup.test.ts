import { describe, expect, it } from "vitest";
import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { sourceHashForNotionDocument } from "./converter";
import { buildNotionDocumentFromEnhancedMarkdown } from "./enhanced-markdown";
import {
  assertReviewedMarkupSnapshot,
  emptyNotionReviewedMarkupReport,
  PERSONAL_REVIEWED_CALLOUT_SPECS,
  PERSONAL_REVIEWED_LITERAL_SPECS,
  normalizeReviewedPersonalMarkup,
} from "./reviewed-markup";
import {
  deriveNotionSnapshotV2Counts,
  readNotionSnapshotV2Jsonl,
  type NotionSnapshotV2Node,
} from "./snapshot-v2";

const UNREVIEWED = "a".repeat(32);

describe("reviewed personal export markup", () => {
  it("maps the exact aside inventory to callouts and escapes literal tags", () => {
    const pages = fixturePages();
    const firstCalloutId = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    pages.set(
      firstCalloutId,
      [
        "before",
        "",
        "<aside>",
        "",
        "🧠  Exact **body**  ",
        "",
        "- one",
        "- two",
        "",
        "</aside>",
        "",
        "after",
      ].join("\n"),
    );

    const normalized = normalizeReviewedPersonalMarkup(pages);
    const first = normalized.markdownByNotionId.get(firstCalloutId);
    expect(first).toContain(
      [
        ':::callout{icon="🧠"}',
        "",
        "Exact **body**  ",
        "",
        "- one",
        "- two",
        ":::",
      ].join("\n"),
    );
    expect(first).not.toContain("<aside>");
    expect(
      normalized.markdownByNotionId.get(
        PERSONAL_REVIEWED_LITERAL_SPECS[0].notionId,
      ),
    ).toContain("prefix \\<insert-here/> suffix");
    const closing = normalized.markdownByNotionId.get(
      PERSONAL_REVIEWED_LITERAL_SPECS[1].notionId,
    );
    expect(closing).toContain("prefix \\</content>");
    expect(closing).toContain("\\</invoke>");
    expect(normalized.report).toMatchObject({
      version: 1,
      callouts: PERSONAL_REVIEWED_CALLOUT_SPECS,
      literals: PERSONAL_REVIEWED_LITERAL_SPECS.map((spec) => ({
        ...spec,
        representation: "escaped_text_v1",
      })),
    });
    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        [...normalized.markdownByNotionId].map(
          ([notionId, enhancedMarkdown]) => ({
            kind: "page" as const,
            notionId,
            enhancedMarkdown,
          }),
        ),
        normalized.report,
      ),
    ).not.toThrow();
  });

  it("leaves unrelated HTML untouched so the Enhanced Markdown gate still rejects it", () => {
    const pages = fixturePages();
    pages.set(UNREVIEWED, "before <mark>untouched</mark> after");
    const normalized = normalizeReviewedPersonalMarkup(pages);
    expect(normalized.markdownByNotionId.get(UNREVIEWED)).toBe(
      "before <mark>untouched</mark> after",
    );
  });

  it("ignores reviewed-looking tokens inside fenced and inline code", () => {
    const pages = fixturePages();
    pages.set(
      UNREVIEWED,
      [
        "```html",
        "<aside>",
        "😀 code",
        "</aside>",
        "<insert-here/>",
        "```",
        "",
        "`</content>` and `</invoke>`",
      ].join("\n"),
    );
    expect(() => normalizeReviewedPersonalMarkup(pages)).not.toThrow();
  });

  it("skips an inventoried page the tree does not hold, including all of them", () => {
    const first = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    const missing = fixturePages();
    missing.delete(first);
    const partial = normalizeReviewedPersonalMarkup(missing);
    expect(partial.markdownByNotionId.has(first)).toBe(false);
    expect(partial.markdownByNotionId.size).toBe(missing.size);

    const none = normalizeReviewedPersonalMarkup(new Map());
    expect(none.markdownByNotionId.size).toBe(0);

    const unrelated = normalizeReviewedPersonalMarkup(
      new Map([[UNREVIEWED, "plain paragraph"]]),
    );
    expect(unrelated.markdownByNotionId.get(UNREVIEWED)).toBe("plain paragraph");
  });

  it("fails closed on extra, nested, unbalanced, attributed, or non-emoji asides", () => {
    const first = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    const outside = fixturePages();
    outside.set(UNREVIEWED, "<aside>\n😀 unexpected\n\n</aside>");
    expect(() => normalizeReviewedPersonalMarkup(outside)).toThrow(/outside/);

    const nested = fixturePages();
    nested.set(first, "<aside>\n😀 outer\n<aside>\n😀 inner\n\n");
    expect(() => normalizeReviewedPersonalMarkup(nested)).toThrow();

    const unbalanced = fixturePages();
    unbalanced.set(first, "<aside>\n😀 first\n<aside>\n😀 second\n\n");
    expect(() => normalizeReviewedPersonalMarkup(unbalanced)).toThrow(/nest|unbalanced/);

    const attributed = fixturePages();
    attributed.set(first, '<aside class="callout">\n😀 content\n\n</aside>');
    expect(() => normalizeReviewedPersonalMarkup(attributed)).toThrow(/attributes/);

    const nonEmoji = fixturePages();
    nonEmoji.set(first, "<aside>\nA content\n\n</aside>");
    expect(() => normalizeReviewedPersonalMarkup(nonEmoji)).toThrow(/emoji grapheme/);

    const noContent = fixturePages();
    noContent.set(first, "<aside>\n😀   \n\n</aside>");
    expect(() => normalizeReviewedPersonalMarkup(noContent)).toThrow(/followed by content/);

    const missingStructuralBlank = fixturePages();
    missingStructuralBlank.set(first, "<aside>\n😀 content\n</aside>");
    expect(() => normalizeReviewedPersonalMarkup(missingStructuralBlank)).toThrow(
      /structural trailing blank/,
    );

    const extraStructuralBlank = fixturePages();
    extraStructuralBlank.set(first, "<aside>\n😀 content\n\n\n</aside>");
    expect(() => normalizeReviewedPersonalMarkup(extraStructuralBlank)).toThrow(
      /structural trailing blank/,
    );
  });

  it("fails closed on literal token count, page, or pre-escaped source drift", () => {
    const insert = PERSONAL_REVIEWED_LITERAL_SPECS[0];
    const duplicate = fixturePages();
    duplicate.set(
      insert.notionId,
      `prefix ${insert.token} suffix ${insert.token}`,
    );
    expect(() => normalizeReviewedPersonalMarkup(duplicate)).toThrow(/count changed/);

    const outside = fixturePages();
    outside.set(UNREVIEWED, insert.token);
    expect(() => normalizeReviewedPersonalMarkup(outside)).toThrow(/outside/);

    const escaped = fixturePages();
    escaped.set(insert.notionId, `prefix \\${insert.token} suffix`);
    expect(() => normalizeReviewedPersonalMarkup(escaped)).toThrow(/source form/);

    const inLink = fixturePages();
    inLink.set(
      insert.notionId,
      `[not a literal](https://example.test/${insert.token})`,
    );
    expect(() => normalizeReviewedPersonalMarkup(inLink)).toThrow(/source form/);
  });

  it("sizes a callout fence for 0-3 space directives but not tab-indented code", () => {
    const first = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    const pages = fixturePages();
    pages.set(
      first,
      [
        "<aside>",
        "😀 content",
        "   ::::",
        "",
        "\t:::::",
        "",
        "</aside>",
      ].join("\n"),
    );

    const normalized = normalizeReviewedPersonalMarkup(pages);
    const markdown = normalized.markdownByNotionId.get(first);
    expect(markdown).toBe(
      [
        ':::::callout{icon="😀"}',
        "content",
        "   ::::",
        "",
        "\t:::::",
        ":::::",
      ].join("\n"),
    );

    const parsed = fromMarkdown(markdown ?? "", {
      extensions: [directive()],
      mdastExtensions: [directiveFromMarkdown()],
    }) as { children?: Array<{ type?: string; name?: string }> };
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children?.[0]).toMatchObject({
      type: "containerDirective",
      name: "callout",
    });
  });

  it("rejects nested container directives in reviewed callout prose but permits code", () => {
    const first = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    for (const name of ["toggle", "unknown"]) {
      const pages = fixturePages();
      pages.set(
        first,
        [
          "<aside>",
          "😀 content",
          `:::${name}{summary="nested"}`,
          "body",
          ":::",
          "",
          "</aside>",
        ].join("\n"),
      );
      expect(() => normalizeReviewedPersonalMarkup(pages)).toThrow(
        /cannot contain nested directives/,
      );
    }

    const code = fixturePages();
    code.set(
      first,
      [
        "<aside>",
        "😀 content",
        "```md",
        ':::unknown{summary="literal"}',
        ":::",
        "```",
        "",
        "</aside>",
      ].join("\n"),
    );
    expect(() => normalizeReviewedPersonalMarkup(code)).not.toThrow();
  });

  it("rejects report and normalized snapshot tampering at the operator boundary", () => {
    const normalized = normalizeReviewedPersonalMarkup(fixturePages());
    const nodes = [...normalized.markdownByNotionId].map(
      ([notionId, enhancedMarkdown]) => ({
        kind: "page" as const,
        notionId,
        enhancedMarkdown,
      }),
    );
    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        nodes,
        {
          ...normalized.report,
          callouts: normalized.report.callouts.slice(1),
        },
      ),
    ).toThrow(/closed policy/);

    const changed = nodes.map((node) =>
      node.notionId === PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId
        ? { ...node, enhancedMarkdown: node.enhancedMarkdown.replace("callout", "toggle") }
        : node,
    );
    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        changed,
        normalized.report,
      ),
    ).toThrow(/callout inventory changed/);

    expect(() =>
      assertReviewedMarkupSnapshot(
        "channel",
        [
          {
            kind: "page",
            notionId: UNREVIEWED,
            enhancedMarkdown: ':::callout{icon="😀"}\ntext\n:::',
          },
        ],
        emptyNotionReviewedMarkupReport(),
      ),
    ).toThrow(/outside/);

    const literalPage = PERSONAL_REVIEWED_LITERAL_SPECS[0].notionId;
    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        nodes.map((node) =>
          node.notionId === literalPage
            ? {
                ...node,
                enhancedMarkdown: `${node.enhancedMarkdown}\n\n:::callout{icon="😀"}\nextra\n:::`,
              }
            : node,
        ),
        normalized.report,
      ),
    ).toThrow(/callout inventory changed/);

    const calloutPage = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        nodes.map((node) =>
          node.notionId === calloutPage
            ? { ...node, enhancedMarkdown: `${node.enhancedMarkdown}\n\n\\</content>` }
            : node,
        ),
        normalized.report,
      ),
    ).toThrow(/literal inventory changed/);

    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        nodes.map((node) =>
          node.notionId === calloutPage ? { ...node, kind: "row" as const } : node,
        ),
        normalized.report,
      ),
    ).toThrow(/page node/);
  });

  it("rejects unbalanced, mismatched, nested, or multi-grapheme normalized callouts", () => {
    const normalized = normalizeReviewedPersonalMarkup(fixturePages());
    const first = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    const nodes = [...normalized.markdownByNotionId].map(
      ([notionId, enhancedMarkdown]) => ({
        kind: "page" as const,
        notionId,
        enhancedMarkdown,
      }),
    );
    const mutateFirst = (mutate: (markdown: string) => string) =>
      nodes.map((node) =>
        node.notionId === first
          ? { ...node, enhancedMarkdown: mutate(node.enhancedMarkdown) }
          : node,
      );
    const assertRejected = (mutate: (markdown: string) => string, error: RegExp) =>
      expect(() =>
        assertReviewedMarkupSnapshot(
          "personal",
          mutateFirst(mutate),
          normalized.report,
        ),
      ).toThrow(error);

    assertRejected((markdown) => markdown.replace(/\n:::$/u, ""), /unbalanced/);
    assertRejected(
      (markdown) => markdown.replace(/\n:::$/u, "\n::::"),
      /match exactly/,
    );
    assertRejected(
      (markdown) =>
        markdown.replace(
          /\n:::$/u,
          '\n:::callout{icon="🧠"}\nnested\n:::\n:::',
        ),
      /cannot nest/,
    );
    for (const name of ["toggle", "unknown"]) {
      assertRejected(
        (markdown) =>
          markdown.replace(
            /\n:::$/u,
            `\n:::${name}{summary="nested"}\nbody\n:::\n:::`,
          ),
        /cannot contain nested directives/,
      );
    }
    assertRejected(
      (markdown) => markdown.replace('icon="👨🏽‍💻"', 'icon="👨🏽‍💻x"'),
      /one emoji grapheme/,
    );
  });

  it("counts escaped literals only in visible prose text nodes", () => {
    const normalized = normalizeReviewedPersonalMarkup(fixturePages());
    const closingPage = PERSONAL_REVIEWED_LITERAL_SPECS[1].notionId;
    const nodes = [...normalized.markdownByNotionId].map(
      ([notionId, enhancedMarkdown]) => ({
        kind: "page" as const,
        notionId,
        enhancedMarkdown,
      }),
    );
    const replaceVisibleContent = (replacement: string) =>
      nodes.map((node) =>
        node.notionId === closingPage
          ? {
              ...node,
              enhancedMarkdown: node.enhancedMarkdown.replace(
                "\\</content>",
                replacement,
              ),
            }
          : node,
      );

    for (const hidden of [
      "[hidden](https://example.test/\\</content>)",
      '<span title="\\</content>">hidden</span>',
      ':toggle{summary="\\</content>"}',
      "`\\</content>`",
    ]) {
      expect(
        () =>
          assertReviewedMarkupSnapshot(
            "personal",
            replaceVisibleContent(hidden),
            normalized.report,
          ),
        hidden,
      ).toThrow(/literal inventory changed/);
    }

    expect(() =>
      assertReviewedMarkupSnapshot(
        "personal",
        replaceVisibleContent("[\\</content>](https://example.test)"),
        normalized.report,
      ),
    ).not.toThrow();
  });

  it("commits extracted icon and body semantics to snapshot and source hashes", async () => {
    const normalized = normalizeReviewedPersonalMarkup(fixturePages());
    const notionId = PERSONAL_REVIEWED_CALLOUT_SPECS[0].notionId;
    const first = normalized.markdownByNotionId.get(notionId);
    if (!first) throw new Error("missing synthetic reviewed callout");
    const second = first.replace('icon="👨🏽‍💻"', 'icon="🧭"');

    const firstSnapshot = await snapshotForMarkdown(notionId, first);
    const secondSnapshot = await snapshotForMarkdown(notionId, second);
    expect(secondSnapshot.fingerprint).not.toBe(firstSnapshot.fingerprint);

    const document = (enhancedMarkdown: string) =>
      buildNotionDocumentFromEnhancedMarkdown(
        {
          type: "page",
          notionId,
          parentNotionId: null,
          position: 0,
          title: "Synthetic",
          enhancedMarkdown,
          assets: [],
        },
        new Map(),
      ).document;
    expect(sourceHashForNotionDocument(document(second))).not.toBe(
      sourceHashForNotionDocument(document(first)),
    );
  });
});

function fixturePages(): Map<string, string> {
  const pages = new Map<string, string>();
  const icons = ["👨🏽‍💻", "🇺🇦", "1️⃣", "😀"];
  for (const [specIndex, spec] of PERSONAL_REVIEWED_CALLOUT_SPECS.entries()) {
    pages.set(
      spec.notionId,
      Array.from({ length: spec.count }, (_, index) =>
        [
          "<aside>",
          `${icons[specIndex]} content ${index}`,
          `line ${index}`,
          "",
          "</aside>",
        ].join("\n"),
      ).join("\n\n"),
    );
  }
  pages.set(
    PERSONAL_REVIEWED_LITERAL_SPECS[0].notionId,
    "prefix <insert-here/> suffix",
  );
  pages.set(
    PERSONAL_REVIEWED_LITERAL_SPECS[1].notionId,
    "prefix </content>\n</invoke>",
  );
  return pages;
}

async function snapshotForMarkdown(notionId: string, enhancedMarkdown: string) {
  const node: NotionSnapshotV2Node = {
    type: "node",
    kind: "page",
    notionId,
    parentNotionId: null,
    position: 0,
    title: "Synthetic",
    enhancedMarkdown,
    assets: [],
  };
  return readNotionSnapshotV2Jsonl(
    `${[
      {
        type: "manifest",
        version: 2,
        source: "notion",
        rootNotionIds: [notionId],
        counts: deriveNotionSnapshotV2Counts([node]),
      },
      node,
      { type: "end", nodeCount: 1, assetCount: 0 },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
}
