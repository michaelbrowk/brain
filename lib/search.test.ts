import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSearchReady,
  buildSearchTextTarget,
  rankSearchCandidate,
  runRipgrep,
  SearchBackendError,
  tokenizeSearchQuery,
} from "./search";

describe("search retrieval", () => {
  it("turns a multiword query into unique Unicode terms", () => {
    expect(tokenizeSearchQuery("  Product  direction продукт  Product ")).toEqual([
      "product",
      "direction",
      "продукт",
    ]);
  });

  it("ranks titles ahead of body phrases and scattered body terms", () => {
    expect(rankSearchCandidate("Product direction", [], "product direction")).toBe(0);
    expect(
      rankSearchCandidate(
        "Strategy",
        ["The current product direction is deliberate."],
        "product direction",
      ),
    ).toBe(40);
    expect(
      rankSearchCandidate(
        "Strategy",
        ["The product is deliberate.", "Direction follows intent."],
        "product direction",
      ),
    ).toBe(80);
  });

  it("ranks a same-line multiword match ahead of terms spread over the page", () => {
    const sameLine = rankSearchCandidate(
      "Strategy",
      ["Direction for this product"],
      "product direction",
    );
    const spread = rankSearchCandidate(
      "Strategy",
      ["Product principles", "Direction notes"],
      "product direction",
    );

    expect(sameLine).toBeLessThan(spread);
  });

  it("binds a body result to its exact repeated occurrence and visible context", () => {
    const target = buildSearchTextTarget(
      [
        "Needle in the first place",
        "",
        "**Needle** in the selected place",
      ].join("\n"),
      "**Needle** in the selected place",
      "Needle",
    );

    expect(target).toEqual({
      exact: "Needle",
      occurrence: 1,
      before: "Needle in the first place ",
      after: " in the selected place",
    });
  });

  it("binds to the raw line selected by ripgrep, not an earlier projected prefix", () => {
    const target = buildSearchTextTarget(
      ["Needle **special** extended", "", "Needle special"].join("\n"),
      "Needle special",
      "Needle special",
    );

    expect(target).toEqual({
      exact: "Needle special",
      occurrence: 1,
      before: "Needle special extended ",
      after: "",
    });
  });

  it("does not count a cross-line projected phrase as the selected raw match", () => {
    const target = buildSearchTextTarget(
      ["Needle", "special preface Needle special"].join("\n"),
      "special preface Needle special",
      "Needle special",
    );

    expect(target).toEqual({
      exact: "Needle special",
      occurrence: 1,
      before: "Needle special preface ",
      after: "",
    });
  });

  it("keeps raw-offset binding inside a projected page-ref label", () => {
    const markdown = "See [Project Atlas](/p/project-atlas) today";

    expect(
      buildSearchTextTarget(markdown, markdown, "Project Atlas"),
    ).toEqual({
      exact: "Project Atlas",
      occurrence: 0,
      before: "See ",
      after: " today",
    });
  });

  it("fails closed when the selected raw line identity is ambiguous", () => {
    expect(
      buildSearchTextTarget(
        ["Needle special", "", "Needle special"].join("\n"),
        "Needle special",
        "Needle special",
      ),
    ).toBeNull();
  });

  it("does not retarget a stale backend match to another query word", () => {
    expect(
      buildSearchTextTarget(
        "Beta remains in the current body",
        "Alpha and beta were together",
        "Alpha",
      ),
    ).toBeNull();
  });

  it.each([
    "- Needle in a bullet",
    "1. Needle in an ordered item",
    "- [ ] Needle in an open task",
    "- [x] Needle in a completed task",
  ])("projects a list result onto its visible editor text: %s", (markdown) => {
    expect(
      buildSearchTextTarget(markdown, markdown, "Needle"),
    ).toEqual({
      exact: "Needle",
      occurrence: 0,
      before: "",
      after: expect.stringContaining(" in "),
    });
  });
});

describe("search readiness", () => {
  it("accepts an executable ripgrep binary", async () => {
    await expect(assertSearchReady()).resolves.toBeUndefined();
  });

  it("rejects when ripgrep cannot be resolved from PATH", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/definitely-missing-brain-path";
    try {
      await expect(assertSearchReady()).rejects.toThrow(
        "ripgrep is not executable",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("treats ripgrep exit 1 as a successful empty search", async () => {
    await withFakeRipgrep("exit 1", async (cwd) => {
      await expect(runRipgrep(["needle"], cwd)).resolves.toEqual([]);
    });
  });

  it("rejects an interactive search when ripgrep fails", async () => {
    await withFakeRipgrep('echo "backend failed" >&2\nexit 2', async (cwd) => {
      await expect(runRipgrep(["needle"], cwd)).rejects.toEqual(
        expect.objectContaining<SearchBackendError>({
          name: "SearchBackendError",
          message: expect.stringContaining("backend failed"),
        }),
      );
    });
  });
});

async function withFakeRipgrep(
  body: string,
  run: (cwd: string) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-search-"));
  const executable = path.join(root, "rg");
  const originalPath = process.env.PATH;
  await fs.writeFile(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  process.env.PATH = root;
  try {
    await run(root);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  }
}
