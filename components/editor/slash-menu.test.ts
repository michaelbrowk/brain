// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("@milkdown/react", () => ({ useInstance: () => [null, () => null] }));
vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { slashMenuItems, visibleSlashItems } from "./slash-menu";

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

  it("keeps Task out of a quote, and Table out of a table", () => {
    const all = slashMenuItems({});
    const here = { query: "", inTable: false, inQuote: false };
    expect(labels(visibleSlashItems(all, here))).toEqual(
      expect.arrayContaining(["Task", "Table"]),
    );
    // A task line inside a quote serialises as `> * [ ] x`: a checkbox the
    // store cannot read, and one of them refuses + Task for the whole note.
    const quoted = labels(visibleSlashItems(all, { ...here, inQuote: true }));
    expect(quoted).not.toContain("Task");
    expect(quoted).toContain("Quote");
    expect(labels(visibleSlashItems(all, { ...here, inTable: true }))).not.toContain("Table");
    expect(labels(visibleSlashItems(all, { ...here, query: "task" }))).toEqual(["Task"]);
  });

  it("offers a Task item, findable by its keywords, after Numbered list", () => {
    const items = slashMenuItems({});
    const task = items.find((item) => item.label === "Task");
    expect(task?.keywords).toBe("task todo to-do checkbox check задача чекбокс");
    expect(labels(items).indexOf("Task")).toBe(labels(items).indexOf("Numbered list") + 1);
  });
});
