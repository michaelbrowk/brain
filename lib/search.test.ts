import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertSearchReady,
  buildSearchTextTarget,
  MAX_BYTES_READ,
  MAX_LINES_READ,
  MAX_MATCH_LINES,
  rankSearchCandidate,
  runBodySearch,
  runRipgrep,
  SearchBackendError,
  searchRunPlan,
  tokenizeSearchQuery,
} from "./search";
import { MANAGED_PAGE_META_KEYS } from "./store/frontmatter";

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
      { pattern: "15", phrase: false },
    ]);
  });

  it("puts a number and a two-letter word last, and still searches them", () => {
    // Every word the reader typed is searched. "15" matches three lines in
    // most of Michael's notes, so its run goes after the word that says
    // something: the first twelve lines a page keeps should be the ones the
    // snippet is worth reading out of.
    expect(searchRunPlan("до 15 мая").map((run) => run.pattern)).toEqual([
      "до 15 мая",
      "мая",
      "до",
      "15",
    ]);
  });

  it("searches a short word that is the whole query", () => {
    expect(searchRunPlan("15")).toEqual([{ pattern: "15", phrase: true }]);
    expect(searchRunPlan("до")).toEqual([{ pattern: "до", phrase: true }]);
  });

  it("keeps both words of a query where every word is short", () => {
    expect(searchRunPlan("a b")).toEqual([
      { pattern: "a b", phrase: true },
      { pattern: "a", phrase: false },
      { pattern: "b", phrase: false },
    ]);
  });

  it("plans nothing for an empty query", () => {
    expect(searchRunPlan("   ")).toEqual([]);
  });
});

describe("bounded ripgrep output", () => {
  /** One `match` line as `rg --json` prints it. */
  const matchLine = (text: string) =>
    '{"type":"match","data":{"path":{"text":"./note/index.md"},' +
    `"lines":{"text":"${text}"},"line_number":1}}`;

  it("answers the first matches it has, stops the process, and logs nothing", async () => {
    const line =
      '{"type":"match","data":{"path":{"text":"./note/index.md"},' +
      '"lines":{"text":"Урок 15 сентября"},"line_number":1}}';
    const body = [
      "echo $$ > pid",
      // Real ripgrep warns about a file it could not read while succeeding.
      'echo "rg: some/file: warning" >&2',
      "i=0",
      `while [ $i -lt 10000 ]; do printf '%s\\n' '${line}'; i=$((i+1)); done`,
      "sleep 30",
    ].join("\n");

    const logged: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((...parts: unknown[]) => {
        logged.push(parts.map(String).join(" "));
      });
    try {
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
    } finally {
      error.mockRestore();
    }
    // The run this side ended is not a run that failed. A close after our own
    // SIGKILL carries a null code and ripgrep's warnings, and logging that
    // puts failures in the operator's log for searches that answered.
    expect(logged).toEqual([]);
  });

  it("neither answers nor counts a line the caller refuses", async () => {
    // The cap is on what is answered. A run that drops frontmatter while it
    // reads has to reach three hundred body lines, not three hundred lines.
    const body = [
      "i=0",
      "while [ $i -lt 400 ]; do",
      `printf '%s\\n' '${matchLine("created: 15")}'`,
      `printf '%s\\n' '${matchLine("body 15")}'`,
      "i=$((i+1))",
      "done",
      "sleep 30",
    ].join("\n");

    await withFakeRipgrep(body, async (cwd) => {
      const lines = await runRipgrep(
        ["needle"],
        cwd,
        (line) => !line.includes("created"),
      );
      expect(lines).toHaveLength(MAX_MATCH_LINES);
      expect(lines.every((line) => line.includes("body 15"))).toBe(true);
    });
  });

  it("stops reading at ten lines for every one it may answer, kept or not", async () => {
    // A word in every page's `created` and `updated` and in no body: nothing
    // is kept, so the cap on answers never fires, and without a second bound
    // the run read the whole notebook, eighty thousand lines over twenty
    // thousand pages where it had read six hundred.
    expect(MAX_LINES_READ).toBe(10 * MAX_MATCH_LINES);
    const body = [
      "echo $$ > pid",
      "i=0",
      `while [ $i -lt 10000 ]; do printf '%s\\n' '${matchLine("created: 15")}'; i=$((i+1)); done`,
      "exec sleep 30",
    ].join("\n");

    await withFakeRipgrep(body, async (cwd) => {
      let asked = 0;
      const lines = await runRipgrep(["needle"], cwd, () => {
        asked += 1;
        return false;
      });
      expect(lines).toEqual([]);
      expect(asked).toBe(MAX_LINES_READ);
      const pid = Number((await fs.readFile(path.join(cwd, "pid"), "utf8")).trim());
      expect(await died(pid)).toBe(true);
    });
  });

  it("answers what it kept when the time runs out, and refuses when it kept nothing", async () => {
    // A run that is slow after its first matches has still found them. One
    // that is slow before any is a search that did not happen, and saying
    // "nothing found" for it would be a lie about the notes.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const some = [
        `printf '%s\\n' '${matchLine("first")}'`,
        `printf '%s\\n' '${matchLine("second")}'`,
        "exec sleep 30",
      ].join("\n");
      await withFakeRipgrep(some, async (cwd) => {
        let read = 0;
        let bothRead: () => void = () => {};
        const twoLines = new Promise<void>((resolve) => {
          bothRead = resolve;
        });
        const run = runRipgrep(["needle"], cwd, () => {
          read += 1;
          if (read === 2) bothRead();
          return true;
        });
        await twoLines;
        await vi.advanceTimersByTimeAsync(3_000);
        expect(await run).toHaveLength(2);
      });

      await withFakeRipgrep("exec sleep 30", async (cwd) => {
        const run = runRipgrep(["needle"], cwd);
        const refused = expect(run).rejects.toEqual(
          expect.objectContaining<SearchBackendError>({
            name: "SearchBackendError",
            message: "ripgrep search timed out",
          }),
        );
        await vi.advanceTimersByTimeAsync(3_000);
        await refused;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    "stops reading at the byte ceiling, answers what it kept, and refuses when it kept nothing",
    async () => {
      // Lines are not a bound on bytes. A page of long lines offers every one
      // of them up to the per-page budget, three are kept, and sixty such
      // pages were 360 MB read for a run that had read 36 MB. Here: one short
      // match, then 102 MB of lines 400 KB long, each under the line limit,
      // so nothing but the ceiling ends the run. The clock is held still,
      // since a run that ends on time proves nothing about bytes.
      expect(MAX_BYTES_READ).toBe(64 * 1024 * 1024);
      const body = [
        "echo $$ > pid",
        // One line in a file, doubled eight times: a shell that prints 400 KB
        // two hundred times takes longer over it than the search does.
        "head -c 399999 /dev/zero | tr '\\0' x > block",
        "echo >> block",
        "n=0",
        "while [ $n -lt 8 ]; do cat block block > twice; mv twice block; n=$((n+1)); done",
        `printf '%s\\n' '${matchLine("first")}'`,
        "exec cat block",
      ].join("\n");
      const withoutTheClock = async (keep: (line: string) => boolean, cwd: string) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          return await runRipgrep(["needle"], cwd, keep);
        } finally {
          vi.useRealTimers();
        }
      };

      await withFakeRipgrep(body, async (cwd) => {
        let seen = 0;
        const lines = await withoutTheClock((line) => {
          seen += Buffer.byteLength(line) + 1;
          return line.length < 1_000;
        }, cwd);
        expect(lines).toEqual([matchLine("first")]);
        // Within a line and a pipe's worth of the ceiling, from either side.
        expect(seen).toBeGreaterThan(MAX_BYTES_READ - 1_000_000);
        expect(seen).toBeLessThanOrEqual(MAX_BYTES_READ + 1_000_000);
        const pid = Number((await fs.readFile(path.join(cwd, "pid"), "utf8")).trim());
        expect(await died(pid)).toBe(true);
      });

      await withFakeRipgrep(body, async (cwd) => {
        await expect(withoutTheClock(() => false, cwd)).rejects.toEqual(
          expect.objectContaining<SearchBackendError>({
            name: "SearchBackendError",
            message: "ripgrep search exceeded output limit",
          }),
        );
      });
    },
    30_000,
  );

  it("skips a line past the limit once it has something to answer", async () => {
    // The fourth match of a page, 600 KB of it. The three before it are an
    // answer already, and the whole search used to be refused over a line it
    // was never going to show.
    const body = [
      `printf '%s\\n' '${matchLine("one")}'`,
      `printf '%s\\n' '${matchLine("two")}'`,
      `printf '%s\\n' '${matchLine("three")}'`,
      "head -c 600000 /dev/zero | tr '\\0' x",
      "echo",
      `printf '%s\\n' '${matchLine("after")}'`,
      "exit 0",
    ].join("\n");

    await withFakeRipgrep(body, async (cwd) => {
      const lines = await runRipgrep(["needle"], cwd);
      expect(lines).toEqual(
        ["one", "two", "three", "after"].map((text) => matchLine(text)),
      );
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

  it("measures that line in bytes, not in UTF-16 units", async () => {
    // 25 Cyrillic-and-digit characters doubled fourteen times: 409,600
    // characters, which is under the 524,288 the old `String.length` check
    // compared against, and 786,432 bytes, which is over it.
    const body = [
      "s=ПятнадцатоеСентябряУрок15",
      "i=0",
      "while [ $i -lt 14 ]; do s=\"$s$s\"; i=$((i+1)); done",
      "printf '%s\\n' \"$s\"",
      "exit 0",
    ].join("\n");

    await withFakeRipgrep(body, async (cwd) => {
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

describe("searchNotes over a real notes root", () => {
  it.skipIf(!HAS_RIPGREP)(
    "answers the pages holding the whole query first",
    async () => {
      // THE ONE END-TO-END CASE. Everything between the plan and the hits —
      // marking a candidate from a phrase-run line, the title that holds the
      // whole query, and the sort that puts both first — lives in `doSearch`,
      // which every other suite mocks away. Real ripgrep, a real Store, four
      // pages in a temp notes root.
      await withRealNotes(async (store, searchNotes) => {
        // The phrase, in a body. Rank 40.
        await store.createPage(null, "Дневник", {
          markdown: "Урок 15 сентября — пришли все.",
        });
        // Every word in the title, none of them in order. Rank 30, so this
        // page sorts ahead of the phrase page on rank alone: it is what makes
        // the phrase key load-bearing rather than decorative.
        await store.createPage(null, "Сентября 15 урок", { markdown: "Ничего." });
        // The three words on three separate lines — the recall a dropped
        // standalone run for "15" would cost.
        await store.createPage(null, "Заметки", {
          markdown: "Урок прошёл.\n\nПятнадцатое? нет, 15.\n\nБыло в сентября.",
        });
        // Two words of three. The intersection still refuses it.
        await store.createPage(null, "Пустое", {
          markdown: "Урок сентября без числа.",
        });

        const hits = await searchNotes("Урок 15 сентября");

        expect(hits.map((hit) => hit.title)).toEqual([
          "Дневник",
          "Сентября 15 урок",
          "Заметки",
        ]);
      });
    },
    30_000,
  );

  it.skipIf(!HAS_RIPGREP)(
    "finds a word in the body of a page whose own frontmatter holds it three times",
    async () => {
      // WHY THE CASE ABOVE FAILED ONCE A WEEK. ripgrep answers the first three
      // matching lines of a file, and a page's frontmatter is the top of its
      // file. "15" is in `created` and `updated` for one hour of the day and
      // one minute and one second of every sixty, and in one random id in two
      // hundred. When all three held it, the three lines ripgrep answered were
      // frontmatter, the body line with the number in it was never read, and
      // the page failed the intersection. It looked like load because nothing
      // in the test said which clock and which id it had been dealt. Both are
      // pinned here, to the worst a page can be dealt.
      await withRealNotes(async (store, searchNotes) => {
        vi.useFakeTimers({
          toFake: ["Date"],
          now: new Date("2026-09-15T15:15:15.150Z"),
        });
        try {
          await store.createPage(null, "Заметки", {
            id: "page15page",
            quickCaptureFingerprint: "a".repeat(64),
            markdown: "Урок прошёл.\n\nПятнадцатое? нет, 15.\n\nБыло в сентября.",
          });
        } finally {
          vi.useRealTimers();
        }

        const hits = await searchNotes("Урок 15 сентября");

        expect(hits.map((hit) => hit.title)).toEqual(["Заметки"]);
        // The lines a reader sees are the page's, never its metadata.
        expect(hits[0]?.snippet.before + hits[0]?.snippet.match).not.toMatch(
          /^(id|created|updated):/,
        );
      });
    },
    30_000,
  );

  it.skipIf(!HAS_RIPGREP)(
    "never answers a share password hash, or any other line the store wrote",
    async () => {
      // A shared page keeps its password hash, its link version and its
      // expiry in frontmatter. None of the three was on the list of keys the
      // search refused, so a query the hash happened to hold was answered
      // with `sharePass: $2a$10$…` as the snippet, in the palette and through
      // the MCP `search` tool alike.
      await withRealNotes(async (store, searchNotes) => {
        const page = await store.createPage(null, "Заметки", {
          markdown: "Урок прошёл.\n\nПятнадцатое? нет, 15.\n\nБыло в сентября.",
        });
        // Written the way `serializePage` writes them, straight into the
        // file: a real hash cannot be made to hold a chosen word.
        const file = path.join(store.resolve(page.id), "index.md");
        const shared = (await fs.readFile(file, "utf8")).replace(
          /\n---\n/,
          "\nsharePass: $2a$10$abc15defghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQ\n" +
            "shareVersion: 15\nshareExpiresAt: '2026-10-15T10:00:00.000Z'\n---\n",
        );
        await fs.writeFile(file, shared);

        const hits = await searchNotes("15");
        expect(hits.map((hit) => hit.snippet)).toEqual([
          { before: "Пятнадцатое? нет, ", match: "15", after: "." },
        ]);

        // And a word only the hash holds answers nothing at all.
        expect(await searchNotes("defghijklmnopqrstuvwxyz")).toEqual([]);
      });
    },
    30_000,
  );
});

/** ONE RUN, ON FILES WRITTEN BY HAND.
 *
 *  What a run asks ripgrep for and what it keeps of the answer are two
 *  numbers that have to agree: a line for every key the store manages, and
 *  three more, of which the three are kept. Either one wrong is silent. Too
 *  few lines asked for and a page whose frontmatter holds the word loses its
 *  body, too many kept and one long note takes the whole answer. So the page
 *  here holds the word on every managed key and on five lines of its body. */
describe("backlinks over a real notes root", () => {
  it.skipIf(!HAS_RIPGREP)(
    "finds a page that links words to the page, and none that only names a longer id",
    async () => {
      await withRealNotes(async (store) => {
        const { backlinksFor } = await import("./search");
        const target = await store.createPage(null, "Target", { markdown: "" });
        const words = await store.createPage(null, "Words", {
          markdown: `read [the spec](/p/${target.id}#words) today`,
        });
        const chip = await store.createPage(null, "Chip", {
          markdown: `see [📄 Target](/p/${target.id}) here`,
        });
        // A copied chip carries a title; it is still a link to the page.
        const titled = await store.createPage(null, "Titled", {
          markdown: `see [📄 Target](/p/${target.id} "📄 Target") here`,
        });
        // The first line naming the id is not a link to it; the second is.
        await store.createPage(null, "Longer", {
          markdown: `[x](/p/${target.id}xyz)\n\nand [y](/p/${target.id}#section)`,
        });

        const found = (await backlinksFor(target.id)).map((hit) => hit.id).sort();
        expect(found).toEqual([words.id, chip.id, titled.id].sort());
      });
    },
    30_000,
  );
});

describe("backlinks a raw line still shows", () => {
  it.skipIf(!HAS_RIPGREP)(
    "finds deep-indented, continued and wrapped links, and many-mention pages never crowd out the rest",
    async () => {
      await withRealNotes(async (store) => {
        const { backlinksFor } = await import("./search");
        const target = await store.createPage(null, "Target", { markdown: "" });
        const indented = await store.createPage(null, "Indented", {
          markdown: `- a\n  - b\n    - c\n      - d\n\n        [deep](/p/${target.id})\n`,
        });
        const continued = await store.createPage(null, "Continued", {
          markdown: `1. one\n\n    continued [link](/p/${target.id}) here\n`,
        });
        const wrapped = await store.createPage(null, "Wrapped", {
          markdown: `see [the\nspec](/p/${target.id}#words) here\n`,
        });
        const heavy: string[] = [];
        for (let index = 0; index < 10; index += 1) {
          const lines = Array.from(
            { length: 50 },
            (_, day) => `- day ${day} [📄 Target](/p/${target.id})`,
          ).join("\n");
          heavy.push((await store.createPage(null, `Heavy ${index}`, { markdown: lines })).id);
        }
        const light: string[] = [];
        for (let index = 0; index < 5; index += 1) {
          light.push(
            (await store.createPage(null, `Light ${index}`, { markdown: `one [x](/p/${target.id}) link` })).id,
          );
        }

        const found = new Set((await backlinksFor(target.id)).map((hit) => hit.id));
        expect([indented.id, continued.id, wrapped.id].filter((id) => found.has(id))).toHaveLength(3);
        expect(heavy.filter((id) => found.has(id))).toHaveLength(10);
        expect(light.filter((id) => found.has(id))).toHaveLength(5);
      });
    },
    60_000,
  );
});

describe("one search run over a page", () => {
  const WORD = "a1b2";

  async function withPage(
    index: string,
    run: (root: string) => Promise<void>,
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-search-run-"));
    try {
      await fs.mkdir(path.join(root, "note"));
      await fs.writeFile(path.join(root, "note", "index.md"), index);
      await run(root);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  const texts = (lines: string[]) =>
    lines.map(
      (line) =>
        (JSON.parse(line) as { data: { lines: { text: string } } }).data.lines.text,
    );

  const everyManagedKey = [...MANAGED_PAGE_META_KEYS]
    .map((key) => `${key}: ${WORD}`)
    .join("\n");

  it.skipIf(!HAS_RIPGREP)(
    "reads past every managed key to the body, and keeps three lines of it",
    async () => {
      const body = [1, 2, 3, 4, 5].map((n) => `body ${n} ${WORD}`).join("\n");
      await withPage(`---\n${everyManagedKey}\n---\n${body}\n`, async (root) => {
        expect(texts(await runBodySearch(WORD, root))).toEqual([
          `body 1 ${WORD}\n`,
          `body 2 ${WORD}\n`,
          `body 3 ${WORD}\n`,
        ]);
      });
    },
  );

  it.skipIf(!HAS_RIPGREP)(
    "keeps three lines of a page that holds the word on ten, with ripgrep offering them all",
    async () => {
      // No key holds the word here, so the whole budget is body and ripgrep
      // hands over all ten. The three are this side's to count.
      const body = Array.from({ length: 10 }, (_unused, n) => `body ${n + 1} ${WORD}`);
      await withPage(`---\nid: p1\ntitle: Plain\n---\n${body.join("\n")}\n`, async (root) => {
        expect(texts(await runBodySearch(WORD, root))).toEqual(
          body.slice(0, 3).map((line) => `${line}\n`),
        );
      });
    },
  );

  it.skipIf(!HAS_RIPGREP)("answers no managed key, whichever one it is", async () => {
    await withPage(`---\n${everyManagedKey}\n---\nnothing here\n`, async (root) => {
      expect(await runBodySearch(WORD, root)).toEqual([]);
    });
    // A key whose value is on the lines under it is a line of its own, and a
    // query for the word the key is spelled with must not be answered by it.
    await withPage("---\nid: p1\ntags:\n  - work\n---\nnothing here\n", async (root) => {
      expect(await runBodySearch("tags", root)).toEqual([]);
    });
  });

  it("asks ripgrep for exactly a line a key and three more", async () => {
    // The number itself, off the command line: asking for more is as silent
    // as asking for fewer, and costs a read of every long note in full.
    await withFakeRipgrep('printf "%s\\n" "$@" > args\nexit 1', async (cwd) => {
      await runBodySearch(WORD, cwd);
      const args = (await fs.readFile(path.join(cwd, "args"), "utf8")).split("\n");
      expect(args[args.indexOf("--max-count") + 1]).toBe(
        String(MANAGED_PAGE_META_KEYS.size + 3),
      );
    });
  });
});

/** A real Store over a temp notes root, and the search module that reads it.
 *
 *  `NOTES_ROOT` is read at import, so the modules under test are the ones
 *  loaded after the stub, not the ones at the top of this file. */
async function withRealNotes(
  run: (
    store: Awaited<ReturnType<typeof import("./store").getStore>>,
    searchNotes: typeof import("./search").searchNotes,
  ) => Promise<void>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-search-notes-"));
  const globals = globalThis as {
    __brainStore?: unknown;
    __brainStoreInit?: unknown;
  };
  const heldStore = globals.__brainStore;
  const heldInit = globals.__brainStoreInit;
  try {
    vi.stubEnv("NOTES_ROOT", root);
    vi.resetModules();
    delete globals.__brainStore;
    delete globals.__brainStoreInit;
    const { getStore } = await import("./store");
    const { searchNotes } = await import("./search");
    await run(await getStore(), searchNotes);
  } finally {
    vi.unstubAllEnvs();
    globals.__brainStore = heldStore;
    globals.__brainStoreInit = heldInit;
    await fs.rm(root, { recursive: true, force: true });
  }
}

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
