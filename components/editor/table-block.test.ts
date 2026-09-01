// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Editor, defaultValueCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { tableBlock } from "@milkdown/kit/component/table-block";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const css = readFileSync(join(__dirname, "table-block.css"), "utf8");

/** Every declaration block for one exact selector (the crepe base and the
 *  Brain override both use `.milkdown .milkdown-table-block`), collapsed. */
function rule(selector: string) {
  const blocks: string[] = [];
  const opener = `\n${selector} {`;
  for (let at = css.indexOf(opener); at !== -1; at = css.indexOf(opener, at + 1)) {
    const start = at + opener.length;
    blocks.push(css.slice(start, css.indexOf("}", start)));
  }
  expect(blocks.length, `missing rule ${selector}`).toBeGreaterThan(0);
  return blocks.join(" ").replace(/\s+/g, " ");
}

describe("table block width", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("renders the table inside the scroll wrapper the overhang CSS targets", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, "| a | b |\n| - | - |\n| 1 | 2 |\n");
      })
      .use(commonmark)
      .use(gfm)
      .use(tableBlock)
      .create();
    try {
      // `.milkdown .milkdown-table-block table` — editor root, NodeView wrapper, table
      const wrapper = root.querySelector(".milkdown .ProseMirror > .milkdown-table-block");
      expect(wrapper).not.toBeNull();
      expect(wrapper?.querySelector("table")).not.toBeNull();
    } finally {
      await editor.destroy();
    }
  });

  it("lets a table breathe past the column into a centred 880px zone, then scroll", () => {
    const wrapper = rule(".milkdown .milkdown-table-block");
    // (880 − 672) / 2 = 104px per side, shrinking to 0 where the canvas has no room
    expect(wrapper).toContain(
      "--brain-table-overhang: clamp(0px, (100vw - 280px - 720px) / 2 + 24px, 104px);",
    );
    expect(wrapper).toContain("margin-inline: calc(-1 * var(--brain-table-overhang));");
    expect(wrapper).toContain("overflow-x: auto;");

    const table = rule(".milkdown .milkdown-table-block table");
    // at least the column, at most the zone, centred — wider content scrolls the wrapper
    expect(table).toContain("width: max-content;");
    expect(table).toContain("min-width: calc(100% - 2 * var(--brain-table-overhang));");
    expect(table).toContain("max-width: 100%;");
    expect(table).toContain("margin-inline: auto;");

    // full-width pages already hand tables the whole article
    expect(
      rule('.brain-page-article[data-full-width="true"] .milkdown .milkdown-table-block'),
    ).toContain("--brain-table-overhang: 0px;");
  });

  it("sits in the paragraph rhythm with equal space above and below", () => {
    const declarations = rule(".milkdown .milkdown-table-block").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    // no block margin of its own: the ProseMirror `* + *` 12px rule spaces the
    // table like a paragraph on both sides (crepe's 4px gave 4 above, 12 below)
    expect(declarations).not.toMatch(/\bmargin(-block|-top|-bottom)?:/);
  });
});
