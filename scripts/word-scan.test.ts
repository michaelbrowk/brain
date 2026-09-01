import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadWordList, publicationRole, resolveWordListPath, scanText } from "./word-scan.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

// macOS hands out /var/folders paths that git reports back through their
// /private realpath, so the fixture has to agree with git before comparing.
async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "brain-scan-")));
  temporaryRoots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

describe("the word scan", () => {
  it("returns null when the word list is absent, so contributors are unaffected", async () => {
    const root = await temporaryRoot();
    expect(await loadWordList(path.join(root, "word-list.txt"))).toBeNull();
  });

  it("reads one word per line and ignores comments and blanks", async () => {
    const root = await temporaryRoot();
    const file = path.join(root, "word-list.txt");
    await writeFile(file, "# secret things\nAcmeCorp\n\n  Zephyr  \n");
    expect(await loadWordList(file)).toEqual(["AcmeCorp", "Zephyr"]);
  });

  it("matches whole words case-insensitively and reports the line", () => {
    const text = "one\nthe acmecorp deal\nZephyrless\n";
    expect(scanText(text, ["AcmeCorp", "Zephyr"])).toEqual([{ word: "AcmeCorp", line: 2 }]);
  });

  it("finds nothing in text that only shares a stem", () => {
    expect(scanText("zephyrologist\n", ["Zephyr"])).toEqual([]);
  });
});

describe("the default word list path", () => {
  it("resolves beside the main checkout even when the push comes from a worktree", async () => {
    const root = await temporaryRoot();
    const main = path.join(root, "brain");
    await mkdir(main);
    await git(main, ["init", "--quiet", "."]);
    await git(main, ["config", "user.email", "hook@example.com"]);
    await git(main, ["config", "user.name", "hook"]);
    await git(main, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
    const tree = path.join(root, "worktrees", "feature");
    await git(main, ["worktree", "add", "--quiet", "-b", "feature", tree]);

    expect(await resolveWordListPath(tree)).toBe(path.join(root, "brain-word-list.txt"));
    // The tree's own sibling is where the naive resolution would have looked,
    // and in this repository nothing is there.
    expect(await resolveWordListPath(tree)).not.toBe(
      path.join(root, "worktrees", "brain-word-list.txt"),
    );
    expect(await resolveWordListPath(main)).toBe(await resolveWordListPath(tree));
  }, 20_000);

  it("falls back to the current directory when there is no history to ask", async () => {
    const root = await temporaryRoot();
    const loose = path.join(root, "loose");
    await mkdir(loose);
    expect(await resolveWordListPath(loose)).toBe(
      path.join(root, "brain-word-list.txt"),
    );
  });

  it("reads the role marker that says which side of the export a tree is on", async () => {
    const root = await temporaryRoot();
    expect(await publicationRole(root)).toBe("");
    await writeFile(path.join(root, ".publication-role"), "archive\n");
    expect(await publicationRole(root)).toBe("archive");
  });

  it("is silent about a missing list in an exported tree and loud in the archive", async () => {
    const root = await temporaryRoot();
    const tree = path.join(root, "tree");
    await mkdir(tree);
    await git(tree, ["init", "--quiet", "."]);
    await git(tree, ["config", "user.email", "hook@example.com"]);
    await git(tree, ["config", "user.name", "hook"]);
    await git(tree, ["commit", "--quiet", "--allow-empty", "-m", "init"]);
    const run = () =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [path.join(process.cwd(), "scripts/word-scan.mjs"), "HEAD", "HEAD"], {
          cwd: tree,
          stdio: "ignore",
        });
        child.on("exit", (code) => resolve(code ?? -1));
      });
    expect(await run()).toBe(0);
    await writeFile(path.join(tree, ".publication-role"), "archive\n");
    expect(await run()).toBe(1);
  }, 20_000);

  it("lets an explicit path win, resolved against the tree it was given", async () => {
    expect(await resolveWordListPath("/somewhere/tree", "/elsewhere/list.txt")).toBe(
      "/elsewhere/list.txt",
    );
    expect(await resolveWordListPath("/somewhere/tree", "list.txt")).toBe(
      "/somewhere/tree/list.txt",
    );
  });
});
