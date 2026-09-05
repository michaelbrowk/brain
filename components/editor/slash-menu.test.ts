// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/react", () => ({ useInstance: () => [null, () => null] }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { slashMenuItems } from "./slash-menu";

const labels = (items: ReadonlyArray<{ label: string }>) => items.map((item) => item.label);

describe("slashMenuItems", () => {
  it("lists the AI and upload entries only when their capability is present", () => {
    const owner = labels(slashMenuItems({ ai: true, upload: { endpoint: "/api/upload" } }));
    expect(owner).toEqual(expect.arrayContaining(["Continue writing", "Image", "File"]));
  });

  it("has no AI entry and no upload entry without them, and keeps everything else", () => {
    const visitor = labels(slashMenuItems({}));
    expect(visitor).not.toContain("Continue writing");
    expect(visitor).not.toContain("Image");
    expect(visitor).not.toContain("File");
    expect(visitor).toEqual(expect.arrayContaining(["Text", "Heading 1", "Table", "Divider"]));
    expect(visitor).toHaveLength(labels(slashMenuItems({ ai: true, upload: { endpoint: "/x" } })).length - 3);
  });
});
