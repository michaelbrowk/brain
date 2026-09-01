import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(path.join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
const at = (needle: string) => {
  const index = workflow.indexOf(needle);
  expect(index, needle).toBeGreaterThan(-1);
  return index;
};

describe("release workflow", () => {
  it("runs on version tags only, never cancels itself, and pins every action", () => {
    expect(workflow).toContain('on:\n  push:\n    tags: ["v*"]\n');
    expect(workflow).toContain("cancel-in-progress: false\n");
    expect(workflow).not.toContain("workflow_dispatch:");
    for (const line of workflow.split("\n").filter((line) => line.includes("uses:"))) {
      expect(line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/);
    }
  });

  it("refuses a tag whose version is not the package.json version", () => {
    expect(workflow).toContain('test "$package_version" = "$version"');
  });

  it("orders the gate before packaging and packaging before the draft", () => {
    const gate = at("run: bash scripts/verify-ops.sh");
    const check = at("run: pnpm check");
    const browser = at("run: pnpm test:e2e:release");
    const build = at("run: pnpm build");
    const smoke = at("run: pnpm smoke:standalone");
    const mailSmoke = at("run: pnpm smoke:mail-service");
    const pack = at("--layout release");
    const draft = at("gh release create");
    expect(gate).toBeLessThan(check);
    expect(check).toBeLessThan(browser);
    expect(browser).toBeLessThan(build);
    expect(build).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(mailSmoke);
    expect(mailSmoke).toBeLessThan(pack);
    expect(pack).toBeLessThan(draft);
  });

  it("smokes the container it built before logging in to GHCR and pushes both architectures before the draft", () => {
    const pack = at("--layout release");
    const smokeBuild = at("tags: brain-smoke:local");
    const smoke = at("run: node scripts/smoke-compose.mjs");
    const login = at("docker/login-action@");
    const push = at("platforms: linux/amd64,linux/arm64");
    const draft = at("gh release create");
    expect(pack).toBeLessThan(smokeBuild);
    expect(smokeBuild).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(login);
    expect(login).toBeLessThan(push);
    expect(push).toBeLessThan(draft);
    expect(workflow).toContain("registry: ghcr.io");
    expect(workflow).toContain("node scripts/release-version.mjs image-tags ghcr.io/michaelbrowk/brain");
  });

  it("creates a draft with generated notes and never moves latest for a pre-release", () => {
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("--generate-notes");
    expect(workflow).toContain("--verify-tag");
    expect(workflow).toContain('args+=(--prerelease --latest=false)');
    expect(workflow).toContain('"artifacts/brain-$version-linux-x64.tar.gz" artifacts/SHA256SUMS');
    expect(workflow).not.toContain("actions/upload-artifact@");
  });
});
