import { describe, expect, it } from "vitest";
import { rewriteMarkdownDestinations } from "./markdown-links";

const replacements = new Map([
  ["/p/source-page", "./p000001.md"],
  ["/_attachments-v2/example.png", "../assets/example.png"],
]);

describe("portable Markdown destinations", () => {
  it("changes only parsed destinations, preserving prose, labels, code and comments", () => {
    const source = [
      "Literal /p/source-page and `/_attachments-v2/example.png`.",
      "",
      "```md",
      "[Example](/p/source-page)",
      "```",
      "",
      "    [Indented example](/p/source-page)",
      "",
      "<!-- [Comment](/p/source-page) -->",
      "",
      "[/p/source-page](/p/source-page \"keep this /p/source-page title\")",
      "![image](/_attachments-v2/example.png)",
      "",
      "[Reference][ref]",
      "",
      '[ref]: </p/source-page> "A title"',
    ].join("\n");
    const expected = source
      .replace('](/p/source-page "keep', '](./p000001.md "keep')
      .replace("![image](/_attachments-v2/example.png)", "![image](../assets/example.png)")
      .replace("[ref]: </p/source-page>", "[ref]: <./p000001.md>");
    expect(rewriteMarkdownDestinations(source, replacements)).toBe(expected);
  });

  it("retains queries and fragments and never matches a URL prefix", () => {
    const source = [
      "[words](/p/source-page#words)",
      "[query](/p/source-page?view=one&amp;sort=two#part)",
      "[other page](/p/source-page-extra)",
      "[external](https://example.com/p/source-page)",
      "![attachment](/_attachments-v2/example.png?download=1#preview)",
    ].join("\n");
    expect(rewriteMarkdownDestinations(source, replacements)).toBe([
      "[words](./p000001.md#words)",
      "[query](./p000001.md?view=one&amp;sort=two#part)",
      "[other page](/p/source-page-extra)",
      "[external](https://example.com/p/source-page)",
      "![attachment](../assets/example.png?download=1#preview)",
    ].join("\n"));
  });

  it("finds links in editor containers and leaves code inside them alone", () => {
    const source = ":::cols\n:::col\n[Page](/p/source-page)\n\n`/p/source-page`\n:::\n:::";
    expect(rewriteMarkdownDestinations(source, replacements)).toBe(
      source.replace("[Page](/p/source-page)", "[Page](./p000001.md)"),
    );
  });

  it("matches decoded paths and preserves escaped or entity-encoded suffixes verbatim", () => {
    const source = String.raw`[Fragment](/p/source-page\#words)
[Query](/p/source-page\?view=one&amp;sort=two\#part)
[Escaped path](/p/source\-page?view=one)
[Encoded path](/p/source&#45;page&num;words)
[Named query](/p/source-page&quest;view=one&#35;part)
[Numeric query](/p/source-page&#x3f;view=one&#x23;part)
![Image](/_attachments-v2/example&#46;png\?download=1)

[Reference][ref]

[ref]: </p/source-page&#63;view=one> "Keep /p/source-page\#words"

Literal /p/source-page\#words and ` + "`[Code](/p/source-page\\#words)`";
    const expected = String.raw`[Fragment](./p000001.md\#words)
[Query](./p000001.md\?view=one&amp;sort=two\#part)
[Escaped path](./p000001.md?view=one)
[Encoded path](./p000001.md&num;words)
[Named query](./p000001.md&quest;view=one&#35;part)
[Numeric query](./p000001.md&#x3f;view=one&#x23;part)
![Image](../assets/example.png\?download=1)

[Reference][ref]

[ref]: <./p000001.md&#63;view=one> "Keep /p/source-page\#words"

Literal /p/source-page\#words and ` + "`[Code](/p/source-page\\#words)`";
    expect(rewriteMarkdownDestinations(source, replacements)).toBe(expected);
  });
});
