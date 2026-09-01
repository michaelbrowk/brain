import { describe, expect, it } from "vitest";
import { renderReadOnly } from "./render-md";

describe("read-only attachment rendering", () => {
  it("adds page and share-version scope only for shared rendering", () => {
    const markdown = "![](/_attachments-v2/abcdef123456.png)";
    const owner = renderReadOnly(markdown);
    const shared = renderReadOnly(markdown, {
      attachmentAccess: { pageId: "shared-page", shareVersion: 7 },
    });

    expect(owner).toContain('src="/_attachments-v2/abcdef123456.png"');
    expect(shared).toContain(
      'src="/_attachments-v2/abcdef123456.png?page=shared-page&amp;v=7"',
    );
  });

  it("does not turn an attachment example in fenced code into a shared URL", () => {
    const html = renderReadOnly(
      "```md\n![](/_attachments-v2/abcdef123456.png)\n```",
      { attachmentAccess: { pageId: "shared-page", shareVersion: 7 } },
    );

    expect(html).toContain("/_attachments-v2/abcdef123456.png");
    expect(html).not.toContain("page=shared-page");
  });

  it("drops editor-only leaf directives so shared pages never print ::empty-block", () => {
    const html = renderReadOnly("## Agenda\n\n::empty-block\n\n## Notes\n\nText ::not-a-fence");

    expect(html).not.toContain("empty-block");
    expect(html).toContain("<h2>Agenda</h2>");
    expect(html).toContain("<h2>Notes</h2>");
    // only a line that IS a directive goes; inline colons in prose stay
    expect(html).toContain("Text ::not-a-fence");
  });

  it("keeps directive-indented attachment examples non-rendered and private", () => {
    const html = renderReadOnly(
      ":::col\n    ![](/_attachments-v2/abcdef123456.png)\n:::",
      { attachmentAccess: { pageId: "shared-page", shareVersion: 7 } },
    );

    expect(html).toContain("/_attachments-v2/abcdef123456.png");
    expect(html).not.toContain("page=shared-page");
  });

  it("flattens page refs without reparsing their label as block Markdown", () => {
    const html = renderReadOnly(
      "[```](/p/page)\n![](/_attachments-v2/abcdef123456.png)",
      { attachmentAccess: { pageId: "shared-page", shareVersion: 7 } },
    );

    expect(html).not.toContain('href="/p/page"');
    expect(html).toContain(
      'src="/_attachments-v2/abcdef123456.png?page=shared-page&amp;v=7"',
    );
  });

  it("rewrites only exact allowed page refs inside a shared subtree", () => {
    const html = renderReadOnly(
      [
        "[Root](/p/root)",
        "[Child](/p/child)",
        "[Outside](/p/outside)",
        "[Query](/p/child?private=1)",
        "[Fragment](/p/child#private)",
      ].join("\n\n"),
      {
        shareNavigation: {
          rootId: "root",
          isAllowedPage: (id) => id === "root" || id === "child",
        },
      },
    );

    expect(html).toContain('href="/share/root"');
    expect(html).toContain('href="/share/root?page=child"');
    expect(html).toContain(
      '<a class="brain-page-ref" href="/share/root">Root</a>',
    );
    expect(html).toContain(
      '<a class="brain-page-ref" href="/share/root?page=child">Child</a>',
    );
    expect(html).not.toContain('href="/p/outside"');
    expect(html).toContain("<p>Outside</p>");
    expect(html).not.toContain('href="/p/child?private=1"');
    expect(html).not.toContain('href="/p/child#private"');
    expect(html).toContain("<p>Query</p>");
    expect(html).toContain("<p>Fragment</p>");
  });

  it("keeps ordinary external links out of the page-reference treatment", () => {
    const html = renderReadOnly("[External](https://example.com)");

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('class="brain-page-ref"');
  });

  it.each([
    "/p/",
    "/p/child/extra",
    "/p/child.name",
    "/p/%2F",
    "/p/child?private=1",
    "/p/child#private",
  ])("flattens malformed or decorated internal href %s", (href) => {
    const html = renderReadOnly(`[Private](${href})`, {
      shareNavigation: {
        rootId: "root",
        isAllowedPage: () => true,
      },
    });

    expect(html).toContain("<p>Private</p>");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });

  it("scopes descendant attachments to root, target, and root version", () => {
    const html = renderReadOnly(
      "![](/_attachments-v2/abcdef123456.png)",
      {
        attachmentAccess: {
          rootId: "root",
          targetId: "child",
          shareVersion: 7,
        },
      },
    );

    expect(html).toContain(
      'src="/_attachments-v2/abcdef123456.png?root=root&amp;page=child&amp;v=7"',
    );
  });
});
