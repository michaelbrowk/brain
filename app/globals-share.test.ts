import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The one CSS rule the /share surface cannot get wrong. The visitor's editor
 *  is drawn over a read-only render the server always emits, so exactly one
 *  rule decides whether the body is on the page once or twice. It has to hold
 *  in every browser a share link is opened in, and those are not the browsers
 *  the owner's app is built for: an old in-app webview and Firefox ESR reach
 *  a shared page long before they reach Brain itself. */

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8");
const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The selectors of every rule whose body carries `property`. */
function rulesWith(property: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(withoutComments))) {
    if (match[2].includes(property)) out.push(match[1].trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("the share fallback rule", () => {
  it("hides the read-only render through a sibling combinator", () => {
    const hiders = rulesWith("display: none").filter((selector) =>
      selector.includes("data-share-fallback"),
    );
    expect(hiders).toEqual(["[data-share-editor] ~ [data-share-fallback]"]);
  });

  it("never leans on :has(), which the browsers share links land in may not have", () => {
    for (const selector of withoutComments.match(/[^{}]+(?=\{)/g) ?? []) {
      if (!selector.includes("data-share-")) continue;
      expect(selector).not.toContain(":has(");
    }
  });
});
