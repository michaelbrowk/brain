// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/react", () => ({ useInstance: () => [null, () => null] }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { slashMenuItems } from "./slash-menu";

const labels = (items: ReadonlyArray<{ label: string }>) => items.map((item) => item.label);

describe("slashMenuItems", () => {
  const OWNER = { ai: true, upload: { endpoint: "/api/upload" }, createPage: true };

  it("lists the AI, upload and new-page entries only when their capability is present", () => {
    const owner = labels(slashMenuItems(OWNER));
    expect(owner).toEqual(
      expect.arrayContaining(["New page", "Continue writing", "Image", "File"]),
    );
    expect(labels(slashMenuItems({ ...OWNER, createPage: false }))).not.toContain("New page");
    expect(labels(slashMenuItems({ ...OWNER, ai: false }))).not.toContain("Continue writing");
    expect(labels(slashMenuItems({ ...OWNER, upload: undefined }))).not.toContain("Image");
  });

  it("has none of the four without them, and keeps everything else", () => {
    const visitor = labels(slashMenuItems({}));
    expect(visitor).not.toContain("New page");
    expect(visitor).not.toContain("Continue writing");
    expect(visitor).not.toContain("Image");
    expect(visitor).not.toContain("File");
    expect(visitor).toEqual(expect.arrayContaining(["Text", "Heading 1", "Table", "Divider"]));
    expect(visitor).toHaveLength(labels(slashMenuItems(OWNER)).length - 4);
  });
});
