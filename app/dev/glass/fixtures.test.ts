import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SAMPLE_TREE, loadStandTree } from "./fixtures";

const original = process.env.BRAIN_PRIVATE_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.BRAIN_PRIVATE_DIR;
  else process.env.BRAIN_PRIVATE_DIR = original;
});

describe("the stand's fixtures", () => {
  it("holds enough rows for the sidebar to overflow", () => {
    expect(SAMPLE_TREE.length).toBeGreaterThan(5);
  });

  it("falls back to the sample tree when no fixture directory is configured", () => {
    delete process.env.BRAIN_PRIVATE_DIR;
    expect(loadStandTree()).toEqual(SAMPLE_TREE);
  });

  it("reads the local tree when the fixture directory holds one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brain-fixtures-"));
    await writeFile(path.join(dir, "glass-fixtures.json"), JSON.stringify([{ title: "Real Page" }]));
    process.env.BRAIN_PRIVATE_DIR = dir;
    expect(loadStandTree()).toEqual([{ title: "Real Page" }]);
  });

  it("falls back rather than throwing when the fixture file is unreadable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "brain-fixtures-"));
    await writeFile(path.join(dir, "glass-fixtures.json"), "{ not json");
    process.env.BRAIN_PRIVATE_DIR = dir;
    expect(loadStandTree()).toEqual(SAMPLE_TREE);
  });
});
