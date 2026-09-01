import { describe, expect, it } from "vitest";
import { parsePage, serializePage } from "./frontmatter";
import type { PageMeta } from "./types";

const baseMeta: PageMeta = {
  id: "appearance-page",
  title: "Appearance",
  order: "a0",
  created: "2026-07-13T00:00:00.000Z",
  updated: "2026-07-13T00:00:00.000Z",
};

describe("page appearance frontmatter", () => {
  it("round-trips non-default appearance in a stable order near view", () => {
    const first = serializePage(
      {
        ...baseMeta,
        view: "sections",
        font: "mono",
        smallText: true,
        fullWidth: true,
        sections: ["One"],
      },
      "Body",
    );
    const parsed = parsePage(first);

    expect(parsed.meta).toMatchObject({
      view: "sections",
      font: "mono",
      smallText: true,
      fullWidth: true,
      sections: ["One"],
    });
    expect(serializePage(parsed.meta as PageMeta, parsed.markdown)).toBe(first);

    const viewIndex = first.indexOf("view:");
    const fontIndex = first.indexOf("font:");
    const smallTextIndex = first.indexOf("smallText:");
    const fullWidthIndex = first.indexOf("fullWidth:");
    const sectionsIndex = first.indexOf("sections:");
    expect(viewIndex).toBeLessThan(fontIndex);
    expect(fontIndex).toBeLessThan(smallTextIndex);
    expect(smallTextIndex).toBeLessThan(fullWidthIndex);
    expect(fullWidthIndex).toBeLessThan(sectionsIndex);
  });

  it("keeps an explicit sans override and omits false toggles", () => {
    const raw = serializePage(
      {
        ...baseMeta,
        font: "sans",
        smallText: false,
        fullWidth: false,
      },
      "Body",
    );

    expect(raw).toMatch(/^font: sans$/m);
    expect(raw).not.toMatch(/^(smallText|fullWidth):/m);
  });
});
