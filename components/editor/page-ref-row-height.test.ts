// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "milkdown.css"), "utf8");

interface Rule {
  selectors: string[];
  body: string;
}

/** Every innermost declaration block in the stylesheet, with its selector list
 *  split out. Comments go first so a brace inside one cannot open a block, and
 *  matching only blocks with no nested braces keeps an `@media` wrapper out of
 *  the selector while still reaching the rules inside it. */
function rules(): Rule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Rule[] = [];
  for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = selector
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean);
    if (selectors.length) found.push({ selectors, body });
  }
  return found;
}

/** True when some rule declaring `property` applies to this element. jsdom
 *  cascades nothing, so this asks the one question that matters here: is the
 *  element covered at all. A selector jsdom cannot parse is not one of ours. */
function declared(element: Element, property: RegExp, rule: readonly Rule[]): boolean {
  return rule.some(({ selectors, body }) => {
    if (!property.test(body)) return false;
    return selectors.some((selector) => {
      try {
        return element.matches(selector);
      } catch {
        return false;
      }
    });
  });
}

/** The shape a browser gives a standalone page row.
 *
 *  prosemirror-view appends `<img class="ProseMirror-separator">` and
 *  `<br class="ProseMirror-trailingBreak">` after a textblock that ends in an
 *  inline atom, so the cursor has a position after it. jsdom's copy emits only
 *  the break, so the row is written out here instead of rendered: this is the
 *  DOM `e2e/critical-flows.spec.ts` reads during a page-ref drag. */
function pageRefRow(): { separator: Element; trailingBreak: Element } {
  const editor = document.createElement("div");
  editor.className = "milkdown";
  const prose = document.createElement("div");
  prose.className = "ProseMirror editor";
  const row = document.createElement("p");
  row.className = "brain-page-ref-only";
  row.innerHTML =
    '<a contenteditable="false" class="brain-page-ref" href="/p/target"' +
    ' data-page-ref="target">Target page</a>' +
    '<img class="ProseMirror-separator" alt="">' +
    '<br class="ProseMirror-trailingBreak">';
  prose.append(row);
  editor.append(prose);
  document.body.append(editor);
  return {
    separator: row.querySelector("img.ProseMirror-separator")!,
    trailingBreak: row.querySelector("br.ProseMirror-trailingBreak")!,
  };
}

describe("a standalone page row draws on one line", () => {
  it("collapses every trailing hack ProseMirror leaves after the link", () => {
    const rule = rules();
    const { separator, trailingBreak } = pageRefRow();

    // The premise. A task line carries a widget at its end and needs the
    // separator inline, or the line doubles, so the stylesheet un-blocks it
    // for the whole editor. That is what puts the page row at risk: its link
    // is a block, and an inline separator after a block opens a second line
    // box, which doubles the row from 24 to 48.
    expect(declared(separator, /display:\s*inline/, rule)).toBe(true);

    // A row twice the height it draws moves the nesting band of
    // `lib/drop-zone.ts` (30-70% of the row's rect) off the title the pointer
    // is on, and a centre drop stops nesting.
    expect(declared(separator, /display:\s*none/, rule)).toBe(true);
    expect(declared(trailingBreak, /display:\s*none/, rule)).toBe(true);
  });
});
