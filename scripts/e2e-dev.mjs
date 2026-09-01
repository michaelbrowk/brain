import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import bcrypt from "bcryptjs";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const port = process.env.BRAIN_E2E_PORT ?? "3021";
const publicOrigin = `http://127.0.0.1:${port}`;
const notesRoot = await mkdtemp(path.join(tmpdir(), "brain-e2e-notes-"));
await mkdir(path.join(notesRoot, ".trash"), { recursive: true });

const child = spawn(
  process.execPath,
  [nextBin, "dev", "--hostname", "127.0.0.1", "--port", port],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      NOTES_ROOT: notesRoot,
      AUTH_SECRET: "brain-e2e-auth-secret-not-for-production",
      AUTH_PASSWORD_HASH: bcrypt.hashSync("e2e-password", 4),
      BRAIN_PUBLIC_ORIGIN: publicOrigin,
      MCP_TOKEN: "brain-e2e-mcp-token-not-for-production",
      OPENROUTER_API_KEY: "",
      GIT_AUTHOR_NAME: "Brain E2E",
      GIT_AUTHOR_EMAIL: "brain-e2e@example.invalid",
      GIT_COMMITTER_NAME: "Brain E2E",
      GIT_COMMITTER_EMAIL: "brain-e2e@example.invalid",
    },
  },
);

let stopping = false;
const stop = async (signal = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  if (child.exitCode == null) child.kill(signal);
  await rm(notesRoot, { recursive: true, force: true });
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
