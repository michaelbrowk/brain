import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ROLE_MARKER, runCheck } from "./check-forbidden-paths.mjs";

const execFileAsync = promisify(execFile);

// The shape a clean export has: tracked files, not one of them denied, and no
// role marker — that is what tells the check it is standing in the public tree.
async function exportedTree({ role = "", plant = [] }: { role?: string; plant?: string[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "brain-forbidden-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: root });
  const files = ["README.md", "lib/notion/snapshot.ts", "scripts/check-forbidden-paths.mjs", ...plant];
  if (role) files.push(ROLE_MARKER);
  for (const relative of files) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), relative === ROLE_MARKER ? `${role}\n` : "x\n");
  }
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

// Assertions that read the real tree hold in the source repository only, so
// they live in a test that does not travel. Everything below builds the tree it
// judges, so it is true in both repositories.
describe("the forbidden-path check", () => {
  it("passes an exported tree in public mode, where every denied path is absent by design", async () => {
    const root = await exportedTree();
    const asPublic = await runCheck({ root, mode: "public" });
    expect(asPublic.error ?? "", "public mode must not read a clean export as drift").toBe("");
    expect(asPublic.code).toBe(0);
    expect(asPublic.message).toContain("mode public");
    // The audit did not disappear, it moved: the same tree is a drifted
    // denylist in the mode that maintains one.
    const asArchive = await runCheck({ root, mode: "archive" });
    expect(asArchive.code).toBe(1);
    expect(asArchive.error).toContain("the denylist names paths this tree no longer has:");
  });

  it("takes archive mode from the marker file, and audits the denylist there", async () => {
    const root = await exportedTree({ role: "archive" });
    const run = await runCheck({ root });
    expect(run.code).toBe(1);
    expect(run.error).toContain("the denylist names paths this tree no longer has:");
  });

  it("takes public mode from a tree without the marker, and names the denied path it tracks", async () => {
    const root = await exportedTree({ plant: ["AGENTS.private.md"] });
    const run = await runCheck({ root });
    expect(run.error).toBe("the public tree tracks denied paths:\nAGENTS.private.md");
    expect(run.code).toBe(1);
  });

  it("lets an explicit mode overrule the marker's absence", async () => {
    const root = await exportedTree();
    const run = await runCheck({ root, mode: "archive" });
    expect(run.code).toBe(1);
    expect(run.error).toContain("the denylist names paths this tree no longer has:");
  });

  it("refuses a mode it does not know rather than passing the tree", async () => {
    const root = await exportedTree({ plant: ["AGENTS.private.md"] });
    expect(await runCheck({ root, mode: "publi" })).toEqual({ code: 64, error: "unknown mode: publi" });
  });
});
