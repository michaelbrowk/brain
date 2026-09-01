import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  documentedEnvNames,
  readEnvNames,
  undocumentedEnvNames,
  unreadEnvNames,
} from "./check-env-docs.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    await rm(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

async function fixtureRepository(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-env-docs-"));
  temporaryRoots.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  // -f because a global ignore rule for .env* would otherwise hide the very
  // file under test, the same reason the real .env.example is force-added.
  await execFileAsync("git", ["add", "-A", "-f"], { cwd: root });
  return root;
}

describe("environment documentation", () => {
  it("finds the variables read through the health route's helper", async () => {
    const names = await readEnvNames(process.cwd());
    for (const hidden of ["AUTH_SECRET", "AUTH_PASSWORD_HASH", "BRAIN_READINESS_TOKEN"]) {
      expect(names, hidden).toContain(hidden);
    }
  });

  it("reads the names .env.example documents, commented ones included", async () => {
    const documented = await documentedEnvNames(process.cwd());
    expect(documented).toContain("NOTES_ROOT");
    expect(documented).toContain("BRAIN_OAUTH_STATE_DIR");
  });

  it("leaves nothing undocumented", async () => {
    const missing = await undocumentedEnvNames(process.cwd());
    expect(missing, `undocumented: ${missing.join(", ")}`).toEqual([]);
  });

  it("leaves nothing documented that the tree never reads", async () => {
    const unread = await unreadEnvNames(process.cwd());
    expect(unread, `documented but unread: ${unread.join(", ")}`).toEqual([]);
  });

  it("sees variables no JavaScript or TypeScript file reads", async () => {
    const names = await readEnvNames(process.cwd());
    // Read only by ops/verify-notes-backup.py, via os.environ.get.
    expect(names, "python").toContain("BRAIN_BACKUP_TEST_LIMITS_JSON");
    // Read only by ops/deploy-puller.sh, via ${NAME:-default}.
    expect(names, "shell").toContain("BRAIN_DEPLOY_FETCH_USER");
    // Read only by ops/docker/docker-compose.smoke.yml, via ${NAME:?message}.
    expect(names, "compose").toContain("BRAIN_SMOKE_PASSWORD_HASH");
  });

  it("reads the configuration files sitting in the repository root", async () => {
    const names = await readEnvNames(process.cwd());
    // Read only by next.config.ts, which no directory prefix covers.
    expect(names, "root").toContain("BRAIN_DIST_DIR");
  });

  it("scans a root file, and still skips a root test file", async () => {
    const root = await fixtureRepository({
      "next.config.ts": "export default { distDir: process.env.BRAIN_ROOT_REAL };\n",
      "next-config.test.ts": "const unused = process.env.BRAIN_ROOT_TEST_ONLY;\n",
      ".env.example": "# BRAIN_ROOT_REAL=\n",
    });
    expect(await readEnvNames(root)).toEqual(["BRAIN_ROOT_REAL"]);
    expect(await unreadEnvNames(root)).toEqual([]);
  });

  it("ignores a name that only a JavaScript comment mentions", async () => {
    const root = await fixtureRepository({
      "scripts/reader.mjs": [
        "// A doc comment naming process.env.PHANTOM_ONE contributes nothing.",
        "/*",
        " * Neither does a block continuation naming process.env.PHANTOM_STAR.",
        " */",
        "export const value = process.env.BRAIN_SCRIPT_REAL; // trailing comments do not hide the read",
        "",
      ].join("\n"),
      ".env.example": "# BRAIN_SCRIPT_REAL=\n",
    });
    expect(await readEnvNames(root)).toEqual(["BRAIN_SCRIPT_REAL"]);
    expect(await unreadEnvNames(root)).toEqual([]);
  });

  it("ignores a name that only a shell comment mentions", async () => {
    const root = await fixtureRepository({
      "ops/reader.sh": [
        "#!/usr/bin/env bash",
        "# A comment naming ${BRAIN_PHANTOM_TWO} contributes nothing.",
        'target="${BRAIN_SHELL_REAL:-/tmp/brain}" # trailing comments do not hide the read',
        // A `#` inside a value is not a comment, so the read before it counts.
        'marker="$BRAIN_SHELL_MARKER#fragment"',
        "",
      ].join("\n"),
      ".env.example": "# BRAIN_SHELL_MARKER=\n# BRAIN_SHELL_REAL=\n",
    });
    expect(await readEnvNames(root)).toEqual(["BRAIN_SHELL_MARKER", "BRAIN_SHELL_REAL"]);
    expect(await unreadEnvNames(root)).toEqual([]);
  });

  it("reports a documented name that nothing in the tree reads", async () => {
    const root = await fixtureRepository({
      "scripts/reader.mjs": "export const value = process.env.BRAIN_REAL_NAME;\n",
      ".env.example": "# BRAIN_REAL_NAME=\n# BRAIN_GHOST_NAME=\n",
    });
    expect(await readEnvNames(root)).toEqual(["BRAIN_REAL_NAME"]);
    expect(await undocumentedEnvNames(root)).toEqual([]);
    expect(await unreadEnvNames(root)).toEqual(["BRAIN_GHOST_NAME"]);
  });
});
