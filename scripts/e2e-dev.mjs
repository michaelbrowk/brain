import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import bcrypt from "bcryptjs";

const require = createRequire(import.meta.url);

// THE STATE DIRECTORIES ARE THIS RUN'S OWN, not the ones a developer's own
// `pnpm dev` keeps under the same uid, each a folder of its own under the
// run's state root. The notification centre matters most: a run that
// inherited yesterday's rows would open the bell on them, and a run that wrote
// its own into the shared file would put them in the bell of the machine it
// ran on. The owner settings hold the module switches, which
// `e2e/modules.spec.ts` turns off and on: a run killed between the two left
// the machine's own `pnpm dev` with Mail or Tasks missing and nothing on
// screen to explain it. Push holds the VAPID pair, generated on first use, so
// `e2e/notifications.spec.ts` reading the key on the shared folder minted the
// pair the developer's own devices then subscribed against. The session epoch,
// the OAuth grants, the update answer and the sender icons are the same shape
// of state. `playwright-config.test.ts` holds this list to every directory
// `.env.example` documents under /var/lib/brain.
const STATE_FOLDERS = {
  BRAIN_NOTIFICATIONS_STATE_DIR: "notifications",
  BRAIN_MCP_STATE_DIR: "mcp",
  BRAIN_SETTINGS_STATE_DIR: "settings",
  BRAIN_PUSH_STATE_DIR: "push",
  BRAIN_AUTH_STATE_DIR: "auth",
  BRAIN_OAUTH_STATE_DIR: "oauth",
  BRAIN_UPDATE_STATE_DIR: "update",
  BRAIN_SENDER_ICON_DIR: "sender-icons",
};

/** The environment the harness hands `next dev`. The run's values come after
 *  `base`, so a directory or a secret a developer exported in their own shell
 *  never reaches the server under test.
 *
 *  @param {{ port: string, notesRoot: string, stateRoot: string, passwordHash: string }} run
 *  @param {Record<string, string | undefined>} [base]
 *  @returns {Record<string, string | undefined>} */
export function e2eServerEnv({ port, notesRoot, stateRoot, passwordHash }, base = process.env) {
  const stateDirectories = Object.fromEntries(
    Object.entries(STATE_FOLDERS).map(([name, folder]) => [name, path.join(stateRoot, folder)]),
  );
  return {
    ...base,
    NOTES_ROOT: notesRoot,
    AUTH_SECRET: "brain-e2e-auth-secret-not-for-production",
    AUTH_PASSWORD_HASH: passwordHash,
    BRAIN_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    MCP_TOKEN: "brain-e2e-mcp-token-not-for-production",
    OPENROUTER_API_KEY: "",
    BRAIN_UPDATE_CHECK: "off",
    ...stateDirectories,
    // A timer writing task files under a temp notes root mid-run is a flake
    // nobody would diagnose twice. NODE_ENV is development here, so the
    // scan's own test guard does not cover this process.
    BRAIN_REMINDERS: "0",
    // Unlocks POST /api/dev/reset, which every spec file calls once so its
    // premises are its own rather than the leavings of the file that sorted
    // before it (e2e/fresh-notes.ts). The route names the other three gates
    // on it; this seam is the one only the harness sets.
    BRAIN_E2E_RESET: "1",
    GIT_AUTHOR_NAME: "Brain E2E",
    GIT_AUTHOR_EMAIL: "brain-e2e@example.invalid",
    GIT_COMMITTER_NAME: "Brain E2E",
    GIT_COMMITTER_EMAIL: "brain-e2e@example.invalid",
  };
}

async function main() {
  const nextBin = require.resolve("next/dist/bin/next");
  const port = process.env.BRAIN_E2E_PORT ?? "3021";
  const notesRoot = await mkdtemp(path.join(tmpdir(), "brain-e2e-notes-"));
  await mkdir(path.join(notesRoot, ".trash"), { recursive: true });
  const stateRoot = await mkdtemp(path.join(tmpdir(), "brain-e2e-state-"));

  const child = spawn(
    process.execPath,
    [nextBin, "dev", "--hostname", "127.0.0.1", "--port", port],
    {
      cwd: process.cwd(),
      stdio: "inherit",
      env: e2eServerEnv({
        port,
        notesRoot,
        stateRoot,
        passwordHash: bcrypt.hashSync("e2e-password", 4),
      }),
    },
  );

  // Both roots go when the server does. Playwright sends SIGTERM for that
  // (`gracefulShutdown` in playwright.config.ts); a SIGKILL never reaches here.
  let stopping = false;
  const stop = async (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode == null) child.kill(signal);
    await rm(notesRoot, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  };

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      void stop(signal).finally(() => process.exit(0));
    });
  }

  child.on("exit", (code, signal) => {
    void stop().finally(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  });
}

// Run as a script, it starts the server. Imported, as the harness test does,
// it only hands out the environment.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
