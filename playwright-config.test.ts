import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import playwrightConfig from "./playwright.config";

/** THE BROWSER SUITE RUNS ONE FILE AT A TIME, AND SOMETHING HAS TO SAY SO.
 *
 *  `e2e/fresh-notes.ts` empties the notes root and the notification centre once
 *  per spec file, which is only scoped to that file while no other file is
 *  running. `workers: 1` and `fullyParallel: false` are the whole of that
 *  guarantee, and raising either is a one-word edit that breaks thirteen spec
 *  files in a way none of them reports: the reset deletes the pages another file
 *  is mid-test on, and what fails is the other file's assertions.
 *
 *  So it is pinned here, where `pnpm check` runs and the browser suite does not.
 *  The hook checks the live number too, because a `--workers=2` on the command
 *  line never touches this file. */
describe("the Playwright harness", () => {
  it("runs one worker, serially, which is what makes the per-file reset safe", () => {
    expect(playwrightConfig.workers).toBe(1);
    expect(playwrightConfig.fullyParallel).toBe(false);
  });

  it("registers the reset in every spec file that reads or writes notes", () => {
    const directory = path.join(process.cwd(), "e2e");
    const calls: string[] = [];
    const wants: string[] = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".spec.ts")) continue;
      const body = readFileSync(path.join(directory, name), "utf8");
      if (/freshNotes\(\)/.test(body)) calls.push(name);
      // A file that asks the owner API for a page, the tree, a task or the bell
      // is a file whose premises another file can spoil. The four mail specs
      // drive mocked routes and touch none of it; the artifact captures are
      // skipped behind their own environment variable and may be pointed at a
      // server this harness did not start, where the reset route is not there.
      const reads = /"\/api\/(?:page|tree|tasks|notifications)/.test(body);
      if (reads && !/test\.skip\(\s*process\.env\./.test(body)) wants.push(name);
    }
    expect(wants.length).toBeGreaterThan(0);
    expect(calls.sort()).toEqual(wants.sort());
  });
});
