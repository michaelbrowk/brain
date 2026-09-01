import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DENIED_PATHS, DENIED_PREFIXES, isDenied } from "./publication-denylist.mjs";
import {
  assertExportableTree,
  exportPublic,
  verifyExport,
} from "./export-public.mjs";

const execFileAsync = promisify(execFile);

async function syntheticRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "brain-export-"));
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "T"], { cwd: root });
  const plant = async (relative: string, body = "x\n") => {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), body);
  };
  await plant("README.md", "# Brain\n");
  await plant("lib/notion/snapshot.ts");
  await plant("lib/notion/export-directory.ts");
  await plant("docs/design/phase0/frame.webp");
  await plant("docs/superpowers/specs/plan.md");
  await plant("AGENTS.private.md");
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "seed"], { cwd: root });
  return root;
}

describe("the publication denylist", () => {
  it("denies every exact path it lists and everything under every prefix", () => {
    expect(isDenied("lib/notion/export-directory.ts")).toBe(true);
    expect(isDenied("docs/design/phase0/frame.webp")).toBe(true);
    expect(isDenied("docs/superpowers/specs/plan.md")).toBe(true);
    expect(isDenied("AGENTS.private.md")).toBe(true);
  });

  it("keeps the generic Notion infrastructure the operator was carved out of", () => {
    for (const kept of [
      "lib/notion/snapshot.ts",
      "lib/notion/reviewed-markup.ts",
      "lib/notion/private-operator-file.ts",
      "README.md",
      "DESIGN.md",
      // The public agent guide, which has to travel under the name an agent
      // looks for.
      "AGENTS.md",
    ]) {
      expect(isDenied(kept), kept).toBe(false);
    }
  });

  it("states every prefix as a directory so a sibling file is never denied by accident", () => {
    for (const prefix of DENIED_PREFIXES) expect(prefix.endsWith("/")).toBe(true);
    expect(DENIED_PATHS).not.toContain("");
  });
});

describe("the export", () => {
  it("copies the tracked tree without a single denied path", async () => {
    const root = await syntheticRepo();
    const destination = path.join(root, "..", `${path.basename(root)}-public`);
    const result = await exportPublic({ root, destination });
    expect(result.denied).toBeGreaterThan(0);
    await expect(stat(path.join(destination, "README.md"))).resolves.toBeTruthy();
    await expect(stat(path.join(destination, "lib/notion/snapshot.ts"))).resolves.toBeTruthy();
    for (const gone of [
      "lib/notion/export-directory.ts",
      "docs/design/phase0/frame.webp",
      "docs/superpowers/specs/plan.md",
      "AGENTS.private.md",
    ]) {
      await expect(stat(path.join(destination, gone))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect((await readFile(path.join(destination, "README.md"), "utf8"))).toContain("# Brain");
  });

  it("refuses a destination that already holds files", async () => {
    const root = await syntheticRepo();
    const destination = path.join(root, "..", `${path.basename(root)}-occupied`);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "stray.txt"), "x\n");
    await expect(exportPublic({ root, destination })).rejects.toThrow("destination is not empty");
  });

  it("fails when a denied path survives in the destination", async () => {
    const destination = await mkdtemp(path.join(tmpdir(), "brain-export-survivor-"));
    const survivor = "docs/design/phase0/frame.webp";
    await mkdir(path.join(destination, path.dirname(survivor)), { recursive: true });
    await writeFile(path.join(destination, survivor), "x\n");
    await writeFile(path.join(destination, "README.md"), "# Brain\n");
    // The kept set here is what a broken isDenied would have produced — it carries
    // the denied path, so only a check against the denylist data catches this.
    await expect(verifyExport({ destination, kept: ["README.md", survivor] })).rejects.toThrow(
      `export carries denied paths:\n${survivor}`,
    );
  });

  it("fails when the destination does not hold exactly the kept set", async () => {
    const destination = await mkdtemp(path.join(tmpdir(), "brain-export-mismatch-"));
    await writeFile(path.join(destination, "README.md"), "# Brain\n");
    await mkdir(path.join(destination, "lib"), { recursive: true });
    await writeFile(path.join(destination, "lib/stray.ts"), "x\n");
    await expect(verifyExport({ destination, kept: ["README.md"] })).rejects.toThrow(
      "unexpected in the destination:\nlib/stray.ts",
    );
    await expect(
      verifyExport({ destination, kept: ["README.md", "lib/stray.ts", "DESIGN.md"] }),
    ).rejects.toThrow("missing from the destination:\nDESIGN.md");
  });
});

describe("the dirty-tree guard on the export itself", () => {
  const cli = path.join(import.meta.dirname, "export-public.mjs");

  it("passes a clean tree and refuses a dirty one, staged or not", async () => {
    const root = await syntheticRepo();
    await expect(assertExportableTree(root)).resolves.toBeUndefined();

    await writeFile(path.join(root, "README.md"), "# Brain, edited\n");
    await expect(assertExportableTree(root)).rejects.toThrow(
      /refusing to export a dirty working tree:[\s\S]*README\.md/,
    );
    // The escape hatch the cutover must never use.
    await expect(
      assertExportableTree(root, { allowDirty: true }),
    ).resolves.toBeUndefined();

    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await expect(assertExportableTree(root)).rejects.toThrow(
      /refusing to export a dirty working tree/,
    );
  });

  it("refuses through the CLI, before it writes anything", async () => {
    const root = await syntheticRepo();
    await writeFile(path.join(root, "untracked.md"), "stray\n");
    const destination = path.join(root, "..", `${path.basename(root)}-dirty`);

    const failure = await execFileAsync("node", [cli, destination], { cwd: root }).catch(
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure).toMatchObject({ code: 1 });
    expect((failure as { stderr: string }).stderr).toContain("untracked.md");
    await expect(stat(destination)).rejects.toThrow();

    const allowed = await execFileAsync("node", [cli, "--allow-dirty", destination], {
      cwd: root,
    });
    expect(allowed.stderr).toContain("--allow-dirty");
    expect(allowed.stdout).toContain("exported");
    await expect(stat(path.join(destination, "README.md"))).resolves.toBeTruthy();
  });

  it("exits 64 on an unknown flag", async () => {
    const root = await syntheticRepo();
    const failure = await execFileAsync("node", [cli, "--nope", "out"], { cwd: root }).catch(
      (error: { code?: number }) => error,
    );
    expect(failure).toMatchObject({ code: 64 });
  });
});

// Assertions that read the real tree hold in the source repository only, so
// they live in a test that does not travel. Everything above seeds its own
// repository and is true in both.
