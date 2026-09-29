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

  /** EVERY STATE DIRECTORY THE APP READS IS THE RUN'S OWN.
   *
   *  In development each of them defaults to a folder under the system temp
   *  directory named for the uid, which is the folder a developer's own `pnpm
   *  dev` uses too. A variable the harness does not set is state the run shares
   *  with that server: the push directory was one, so a run generated the VAPID
   *  pair the developer's devices then subscribed against. The list is read
   *  from `.env.example`, which `scripts/check-env-docs.mjs` keeps equal to what
   *  the code reads, so a directory added later fails here until the harness
   *  names it. Each has to sit under `stateRoot`, the folder the harness deletes
   *  when the server exits. */
  it("gives the server every state directory of its own, under the root it deletes", () => {
    const documented = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
    const harness = readFileSync(path.join(process.cwd(), "scripts/e2e-dev.mjs"), "utf8");
    const names = [...documented.matchAll(/^#?\s*(BRAIN_[A-Z_]+_STATE_DIR)=/gm)].map(
      (match) => match[1],
    );
    expect(names).toContain("BRAIN_PUSH_STATE_DIR");
    const unowned = names.filter(
      (name) => !new RegExp(`\\b${name}: path\\.join\\(stateRoot, "[a-z]+"\\)`).test(harness),
    );
    expect(unowned).toEqual([]);
  });
});
