import { describe, expect, it } from "vitest";
import { canonicalizeMcpPageMarkdown } from "./mcp-page-markdown";

const ORIGIN = "https://brain.example";

describe("canonicalizeMcpPageMarkdown", () => {
  it("rewrites only exact configured-origin Markdown link destinations", () => {
    const input = [
      `[Exact](${ORIGIN}/p/abc_123-Z)`,
      `[Angle](<${ORIGIN}/p/angle-id>)`,
      `[Relative](/p/already-relative)`,
      `[Foreign](https://foreign.example/p/abc)`,
      `[Deceptive](https://brain.example.evil/p/abc)`,
      `[HTTP](http://brain.example/p/abc)`,
      `[Port](https://brain.example:444/p/abc)`,
      `[Credentials](https://user@brain.example/p/abc)`,
      `[Query](${ORIGIN}/p/abc?view=full)`,
      `[Hash](${ORIGIN}/p/abc#section)`,
      `[Suffix](${ORIGIN}/p/abc/more)`,
      `[Trailing slash](${ORIGIN}/p/abc/)`,
      `[Encoded](${ORIGIN}/p/abc%2Fdef)`,
      `[${ORIGIN}/p/label](${ORIGIN}/p/destination)`,
      `Autolink <${ORIGIN}/p/autolink>`,
    ].join("\n");

    expect(canonicalizeMcpPageMarkdown(input, ORIGIN)).toBe(
      [
        "[Exact](/p/abc_123-Z)",
        "[Angle](</p/angle-id>)",
        "[Relative](/p/already-relative)",
        "[Foreign](https://foreign.example/p/abc)",
        "[Deceptive](https://brain.example.evil/p/abc)",
        "[HTTP](http://brain.example/p/abc)",
        "[Port](https://brain.example:444/p/abc)",
        "[Credentials](https://user@brain.example/p/abc)",
        `[Query](${ORIGIN}/p/abc?view=full)`,
        `[Hash](${ORIGIN}/p/abc#section)`,
        `[Suffix](${ORIGIN}/p/abc/more)`,
        `[Trailing slash](${ORIGIN}/p/abc/)`,
        `[Encoded](${ORIGIN}/p/abc%2Fdef)`,
        `[${ORIGIN}/p/label](/p/destination)`,
        `Autolink <${ORIGIN}/p/autolink>`,
      ].join("\n"),
    );
  });

  it("preserves hard breaks, directives, code, and every non-URL byte", () => {
    const input = [
      `* [First](${ORIGIN}/p/first)  `,
      `  Continued with [Second](${ORIGIN}/p/second).`,
      `Backslash [Third](${ORIGIN}/p/third)\\`,
      "continues here.",
      "",
      `::note{kind="keep"}`,
      "",
      "`[Inline code](" + `${ORIGIN}/p/code)` + "`",
      "",
      "```md",
      `[Fenced code](${ORIGIN}/p/fenced)`,
      "```",
    ].join("\n");
    const expected = input
      .replace(`${ORIGIN}/p/first`, "/p/first")
      .replace(`${ORIGIN}/p/second`, "/p/second")
      .replace(`${ORIGIN}/p/third`, "/p/third");

    expect(canonicalizeMcpPageMarkdown(input, ORIGIN)).toBe(expected);
  });

  it("is idempotent", () => {
    const input = `[Page](${ORIGIN}/p/idempotent)`;
    const once = canonicalizeMcpPageMarkdown(input, ORIGIN);
    expect(canonicalizeMcpPageMarkdown(once, ORIGIN)).toBe(once);
  });
});
