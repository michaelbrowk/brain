import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSearchReady,
  buildSearchTextTarget,
  MAX_MATCH_LINES,
  rankSearchCandidate,
  runRipgrep,
  SearchBackendError,
  searchRunPlan,
  tokenizeSearchQuery,
} from "./search";

const HAS_RIPGREP = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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

  it("rejects an interactive search when ripgrep fails, keeping its stderr here", async () => {
    // THE MESSAGE LEAVES THE PROCESS. `app/api/mcp/route.ts` hands a
    // `SearchBackendError` to an agent with this sentence verbatim, under
    // `search_backend`, so what ripgrep chose to print is the operator's and
    // not the agent's — an `RIPGREP_CONFIG_PATH` that will not parse is
    // reported with its absolute path. The exit code travels, the stderr
    // stays in the log.
    const logged: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => {
        logged.push(parts.map(String).join(" "));
      });
    try {
      await withFakeRipgrep('echo "backend failed" >&2\nexit 2', async (cwd) => {
        await expect(runRipgrep(["needle"], cwd)).rejects.toEqual(
          expect.objectContaining<SearchBackendError>({
            name: "SearchBackendError",
            message: "ripgrep search failed (2)",
          }),
        );
      });
    } finally {
      error.mockRestore();
    }
    expect(logged.join("\n")).toContain("backend failed");
  });
});

describe("the search plan", () => {
  it("runs the whole query first, as one phrase", () => {
    expect(searchRunPlan("  Урок 15 сентября  ")).toEqual([
      { pattern: "Урок 15 сентября", phrase: true },
      { pattern: "урок", phrase: false },
      { pattern: "сентября", phrase: false },
    ]);
  });

  it("leaves a number and a two-letter word out of runs of their own", () => {
    // "15" matches three lines in most of Michael's notes, and a word that
    // broad on its own is what the output cap used to be spent on.
    expect(searchRunPlan("до 15 мая").map((run) => run.pattern)).toEqual([
      "до 15 мая",
      "мая",
    ]);
  });

  it("searches a short word that is the whole query", () => {
    expect(searchRunPlan("15")).toEqual([{ pattern: "15", phrase: true }]);
    expect(searchRunPlan("до")).toEqual([{ pattern: "до", phrase: true }]);
  });

  it("plans nothing for an empty query", () => {
    expect(searchRunPlan("   ")).toEqual([]);
  });
});

describe("bounded ripgrep output", () => {
  it("answers the first matches it has and stops the process", async () => {
    const line =
      '{"type":"match","data":{"path":{"text":"./note/index.md"},' +
      '"lines":{"text":"Урок 15 сентября"},"line_number":1}}';
    const body = [
      "echo $$ > pid",
      "i=0",
      `while [ $i -lt 10000 ]; do printf '%s\\n' '${line}'; i=$((i+1)); done`,
      "sleep 30",
    ].join("\n");

    await withFakeRipgrep(body, async (cwd) => {
      const lines = await runRipgrep(["needle"], cwd);
      expect(lines).toHaveLength(MAX_MATCH_LINES);
      expect(MAX_MATCH_LINES).toBe(300);

      // The answer came from stopping ripgrep, not from ripgrep finishing:
      // the script sleeps for thirty seconds after the last line.
      const pid = Number((await fs.readFile(path.join(cwd, "pid"), "utf8")).trim());
      expect(Number.isInteger(pid)).toBe(true);
      expect(await died(pid)).toBe(true);
    });
  });

  it("still refuses one line past the output limit", async () => {
    // A monstrous single line is the case the 512 KB guard was written for,
    // and it stays a refusal: nothing can be answered out of half of it.
    await withFakeRipgrep("head -c 600000 /dev/zero | tr '\\0' x\necho\nexit 0", async (cwd) => {
      await expect(runRipgrep(["needle"], cwd)).rejects.toEqual(
        expect.objectContaining<SearchBackendError>({
          name: "SearchBackendError",
          message: "ripgrep search exceeded output limit",
        }),
      );
    });
  });

  it.skipIf(!HAS_RIPGREP)(
    "answers a word that matches in two thousand notes",
    async () => {
      // The reported bug, with the real binary: "Урок 15 сентября" on
      // Michael's notebook answered `search_backend` because "15" is in most
      // of his notes. Three matches a file over two thousand files is past
      // the old 512 KB refusal several times over.
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-search-wide-"));
      try {
        await Promise.all(
          Array.from({ length: 2000 }, async (_unused, index) => {
            const dir = path.join(root, `note-${index}`);
            await fs.mkdir(dir);
            await fs.writeFile(
              path.join(dir, "index.md"),
              "Урок 15 сентября, и ещё про 15 число, и снова 15\n".repeat(4),
            );
          }),
        );

        const lines = await runRipgrep(
          ["--fixed-strings", "--ignore-case", "--max-count", "3", "-e", "15"],
          root,
        );
        const matches = lines.filter((line) => JSON.parse(line).type === "match");
        expect(matches).toHaveLength(MAX_MATCH_LINES);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

/** True once the process is gone. Polled: the kill is a signal, and the reap
 *  that makes the pid unknown again happens on this process's own event
 *  loop. */
async function died(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function withFakeRipgrep(
  body: string,
  run: (cwd: string) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-search-"));
  const executable = path.join(root, "rg");
  const originalPath = process.env.PATH;
  await fs.writeFile(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  // The fake comes first, and the rest of the machine stays behind it: a
  // script here calls `sleep` and `tr` the way any shell script does.
  process.env.PATH = originalPath ? `${root}:${originalPath}` : root;
  try {
    await run(root);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(root, { recursive: true, force: true });
  }
}
