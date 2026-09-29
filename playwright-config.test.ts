import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import playwrightConfig from "./playwright.config";
import { documentedEnvExamples } from "./scripts/check-env-docs.mjs";
import { e2eServerEnv } from "./scripts/e2e-dev.mjs";

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
   *  pair the developer's devices then subscribed against.
   *
   *  The list is every `BRAIN_*_DIR` that `.env.example` documents under
   *  /var/lib/brain, which is where production keeps runtime state, read with
   *  the parser `scripts/check-env-docs.mjs` holds equal to what the code reads.
   *  A directory added later fails here until the harness names it. The
   *  assertion is on the environment the harness hands the server, so the
   *  order it is assembled in counts: a developer's own value in the shell must
   *  lose to the run's. */
  it("gives the server every state directory of its own, under the run's root", async () => {
    const examples = await documentedEnvExamples(process.cwd());
    const stateDirectories = [...examples]
      .filter(
        ([name, value]) =>
          /^BRAIN_[A-Z0-9_]+_DIR$/.test(name) && value.startsWith("/var/lib/brain/"),
      )
      .map(([name]) => name);
    expect(stateDirectories).toEqual(
      expect.arrayContaining(["BRAIN_PUSH_STATE_DIR", "BRAIN_SENDER_ICON_DIR"]),
    );

    const stateRoot = path.join(tmpdir(), "brain-e2e-state-under-test");
    const developerShell = Object.fromEntries(
      stateDirectories.map((name) => [name, `/var/lib/brain/${name}`]),
    );
    const environment = e2eServerEnv(
      { port: "3999", notesRoot: "/notes", stateRoot, passwordHash: "hash" },
      { ...developerShell, PATH: "/usr/bin" },
    );

    const folders = stateDirectories.map((name) => environment[name]);
    for (const [index, name] of stateDirectories.entries()) {
      expect(path.dirname(folders[index] ?? ""), name).toBe(stateRoot);
    }
    expect(new Set(folders).size, "each directory is a folder of its own").toBe(
      folders.length,
    );
    expect(environment.NOTES_ROOT).toBe("/notes");
    expect(environment.PATH).toBe("/usr/bin");
  });

  /** THE HARNESS GETS TO CLEAN UP.
   *
   *  Playwright stops its web server with SIGKILL unless told otherwise, and a
   *  killed `scripts/e2e-dev.mjs` never reaches the handler that deletes its
   *  notes root and its state root. Every run left both behind in the temp
   *  directory, VAPID pair, session epoch and OAuth grants included. SIGTERM is
   *  the signal that handler listens for. */
  it("stops the web server with a signal the harness cleans up on", () => {
    const server = playwrightConfig.webServer;
    expect(Array.isArray(server)).toBe(false);
    expect(server).toMatchObject({
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    });
  });
});
