import { describe, expect, it } from "vitest";
import {
  parsePage,
  serializeLivePage,
  serializePage,
} from "./frontmatter";
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

describe("the visitor label", () => {
  const meta = (updatedBy: "me" | "visitor"): PageMeta => ({
    id: "p1",
    title: "Page",
    order: "a0",
    created: "2026-09-05T10:00:00.000Z",
    updated: "2026-09-05T10:00:00.000Z",
    updatedBy,
    updatedByName: "Ada",
  });

  it("leaves the caller's object alone, because two Notion paths hash with it", () => {
    const owner = meta("me");
    const raw = serializePage(owner, "body");
    expect(raw).not.toContain("updatedByName");
    expect(owner.updatedByName).toBe("Ada");
  });

  it("takes the stale name out of a live entry the writer is about to persist", () => {
    const owner = meta("me");
    expect(serializeLivePage(owner, "body")).not.toContain("updatedByName");
    expect(owner.updatedByName).toBeUndefined();

    const visitor = meta("visitor");
    expect(serializeLivePage(visitor, "body")).toContain("updatedByName: Ada");
    expect(visitor.updatedByName).toBe("Ada");
  });
});
