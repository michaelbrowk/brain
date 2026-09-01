import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "ci.yml"),
  "utf8",
);
const fullE2eWorkflow = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "e2e-full.yml"),
  "utf8",
);
const packageJson = readFileSync(
  path.join(process.cwd(), "package.json"),
  "utf8",
);
const packageScripts = (
  JSON.parse(packageJson) as { scripts: Record<string, string> }
).scripts;
const criticalFlows = readFileSync(
  path.join(process.cwd(), "e2e", "critical-flows.spec.ts"),
  "utf8",
);

describe("CI cost guardrails", () => {
  it("cancels superseded runs and keeps hosted CI on main only", () => {
    expect(workflow).toContain("cancel-in-progress: true\n");
    expect(workflow).toContain("push:\n    branches: [main]\n");
    // PRs may run the cheap gate, but every expensive step must stay
    // push-only so a pull request never packages or boots a browser.
    expect(workflow).toContain("pull_request:\n    branches: [main]\n");
    for (const step of [
      "pnpm exec playwright install",
      "pnpm test:e2e:release",
      "run: pnpm build",
      "pnpm smoke:standalone",
      "pnpm smoke:mail-service",
    ]) {
      const index = workflow.indexOf(step);
      expect(index).toBeGreaterThan(-1);
      // Bound the whole YAML step block (its "- " line to the next one) and
      // require the push-only guard somewhere inside it.
      const stepStart = workflow.lastIndexOf("\n      - ", index);
      let stepEnd = workflow.indexOf("\n      - ", index + step.length);
      if (stepEnd === -1) stepEnd = workflow.length;
      expect(workflow.slice(stepStart, stepEnd)).toContain(
        "if: github.event_name == 'push'",
      );
    }
    expect(workflow).toContain(
      "- name: Check type safety, tests, round-trips, and worker\n" +
        "        run: pnpm check\n",
    );
    expect(workflow).toContain(
      "- name: Install runtime search dependency\n" +
        "        run: |\n" +
        "          sudo apt-get update\n" +
        "          sudo apt-get install --yes ripgrep\n",
    );
  });

  it("runs the compact browser gate before the main build and smokes", () => {
    for (const step of [
      "Install release verification dependencies",
      "Verify operational contracts",
      "Install release browser",
      "Run compact release browser gate",
      "Set build provenance",
    ]) {
      expect(workflow).toContain(
        `- name: ${step}\n        if: github.event_name == 'push'\n`,
      );
    }

    const releaseGate = workflow.indexOf("run: pnpm test:e2e:release");
    const build = workflow.indexOf("run: pnpm build");
    const smoke = workflow.indexOf("run: pnpm smoke:standalone");
    expect(releaseGate).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(releaseGate);
    expect(smoke).toBeGreaterThan(build);
    expect(workflow).not.toContain("scripts/build-release.mjs");
    expect(workflow).not.toContain("\n  e2e:\n");
  });

  it("keeps exhaustive browser QA manual, scheduled, and local-first", () => {
    expect(workflow).not.toContain("  workflow_dispatch:\n");
    expect(workflow).not.toContain("  schedule:\n");
    expect(fullE2eWorkflow).toContain("name: Full E2E\n");
    expect(fullE2eWorkflow).toContain("  workflow_dispatch:\n");
    expect(fullE2eWorkflow).toContain("  schedule:\n");
    expect(fullE2eWorkflow).toContain("  full-e2e:\n");
    expect(fullE2eWorkflow).toContain("run: pnpm test:e2e:full\n");
    expect(fullE2eWorkflow).not.toContain("actions/upload-artifact@");
    expect(fullE2eWorkflow).not.toContain("Set build provenance");
    expect(packageScripts["test:e2e:release"]).toBe(
      "playwright test --grep @release",
    );
    expect(packageScripts["test:e2e:full"]).toBe("playwright test");
    expect(packageScripts["ci:local"]).toContain("pnpm test:e2e:full");
  });

  it("pins the compact release contract to the six core journeys", () => {
    expect(criticalFlows.match(/@release/g)).toHaveLength(6);
    for (const title of [
      "login, editor autosave, navigation flush, search, and mobile layout",
      "page-reference blocks reorder repeatedly and persist",
      "centre-dropping a page reference nests it without Trash and failed moves stay untouched",
      "page appearance persists across editor and public share",
      "pinned roots stay discoverable while home and search remain concise",
      "a page row nests from inside a column, in its own lane and across",
    ]) {
      expect(criticalFlows).toContain(`@release ${title}`);
    }
  });

  it("never uploads a deploy artifact from the push workflow", () => {
    expect(workflow).not.toContain("actions/upload-artifact@");
    expect(workflow).not.toContain("retention-days:");
  });

  it("runs the forbidden-path check before the slow gates", () => {
    const check = JSON.parse(packageJson).scripts.check as string;
    expect(
      check.startsWith("node scripts/check-forbidden-paths.mjs &&"),
    ).toBe(true);
  });

  it("scans for secrets on every event, with the deliberate test keys allowlisted", () => {
    expect(workflow).toContain("- name: Scan for secrets\n");
    const index = workflow.indexOf("- name: Scan for secrets\n");
    const stepStart = workflow.lastIndexOf("\n      - ", index);
    let stepEnd = workflow.indexOf("\n      - ", index + 1);
    if (stepEnd === -1) stepEnd = workflow.length;
    // Cheap enough to run on a pull request: no push-only guard here.
    expect(workflow.slice(stepStart, stepEnd)).not.toContain(
      "if: github.event_name == 'push'",
    );
    const config = readFileSync(
      path.join(process.cwd(), ".gitleaks.toml"),
      "utf8",
    );
    // The path entry is a regex, so the dot is escaped in the file itself.
    expect(config).toContain("lib/mail/testing/smtp-fixtures\\.ts");
    expect(config).toContain("-not-for-production");
  });

  it("is MIT-licensed and installable from the first screen of the README", () => {
    const manifest = JSON.parse(packageJson) as { private?: boolean; license?: string };
    expect(manifest.private).toBeUndefined();
    expect(manifest.license).toBe("MIT");
    expect(readFileSync(path.join(process.cwd(), "LICENSE"), "utf8")).toContain("MIT License");
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    const install = readme.indexOf("## Install");
    const develop = readme.indexOf("## Develop");
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(develop);
    expect(readme).toContain("docker compose");
  });
});
