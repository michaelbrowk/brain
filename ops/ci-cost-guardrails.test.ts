import { readFileSync } from "node:fs";
import path from "node:path";

import matter from "gray-matter";
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
  it("cancels a superseded pull request run and never a run on main", () => {
    // The build and both smokes run only on a push to main. Cancelling there
    // meant a second merge stopped the first one's run before it reached
    // them, so a merged change could go unbuilt, and one did: the standalone
    // smoke broke on main and was first seen at a release gate. A pull
    // request's superseded run is still worth nothing and is still stopped.
    //
    // Read as YAML, not as text: the same two lines behind a `#` are text
    // that is still there and a setting that is gone, and a search for the
    // text passed with the whole block commented out.
    const parsed = matter(`---\n${workflow}\n---\n`).data as {
      concurrency?: Record<string, unknown>;
      jobs?: Record<string, { concurrency?: unknown }>;
    };
    expect(parsed.concurrency).toEqual({
      // Never displaced while it waits either: a group keeps one run and one
      // pending, so a commit on main is a group of its own.
      group:
        "ci-${{ github.workflow }}-${{ github.ref }}-" +
        "${{ github.ref == 'refs/heads/main' && github.sha || 'latest' }}",
      "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}",
    });
    // And no job says otherwise for itself.
    expect(Object.keys(parsed.jobs ?? {})).toEqual(["check"]);
    expect(parsed.jobs?.check?.concurrency).toBeUndefined();
    // The release gate reads that run, so the checklist has to ask for it,
    // and for the commit being released rather than for whichever is newest.
    const checklist = readFileSync(
      path.join(process.cwd(), "docs", "release-checklist.md"),
      "utf8",
    );
    expect(checklist).toContain(
      "The `CI` run for the commit being released is green: completed, not cancelled",
    );
    expect(checklist).toContain(
      "`gh run list --workflow CI --event push --commit <sha>`",
    );
  });

  it("keeps hosted CI on main only and every expensive step push-only", () => {
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

  it("audits the production dependency tree on every event", () => {
    // The audit was a human habit until Next 16.2 shipped with two critical
    // advisories nobody ran it against. A habit is not a gate, so it is a
    // step, and a cheap one: no push-only guard, so a pull request answers
    // for what it adds to the lockfile before it is merged.
    expect(workflow).toContain("- name: Audit production dependencies\n");
    const index = workflow.indexOf("- name: Audit production dependencies\n");
    const stepStart = workflow.lastIndexOf("\n      - ", index);
    let stepEnd = workflow.indexOf("\n      - ", index + 1);
    if (stepEnd === -1) stepEnd = workflow.length;
    const step = workflow.slice(stepStart, stepEnd);
    expect(step).not.toContain("if: github.event_name == 'push'");
    expect(step).toContain("run: pnpm audit:prod");
    // After the install, because there is no tree to audit before it.
    expect(index).toBeGreaterThan(
      workflow.indexOf("run: pnpm install --frozen-lockfile"),
    );
    expect(packageScripts["audit:prod"]).toBe(
      "pnpm audit --prod --audit-level=high",
    );
    // First in the local run too: a known-vulnerable dependency is not worth
    // a build and three browser suites to find out about.
    expect(packageScripts["ci:local"]?.startsWith("pnpm audit:prod &&")).toBe(
      true,
    );
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
