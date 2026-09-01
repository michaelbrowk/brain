#!/usr/bin/env node
// Hands one listening Unix socket to the Mail service the way systemd does
// (LISTEN_PID/LISTEN_FDS/LISTEN_FDNAMES, fd 3). No restarts and no MIME
// worker: process supervision inside the image is designed in B.
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

const [socketPath, entrypoint] = process.argv.slice(2);
if (!socketPath || !entrypoint) {
  process.stderr.write("usage: brain-mail-activate.mjs <socket-path> <main.js>\n");
  process.exit(64);
}

const directory = path.dirname(socketPath);
mkdirSync(directory, { recursive: true, mode: 0o710 });
const prepared = path.join(directory, `.brain-mail.${process.pid}.sock`);
rmSync(prepared, { force: true });
rmSync(socketPath, { force: true });

const owner = createServer();
await new Promise((resolve, reject) => {
  owner.once("error", reject);
  owner.listen(prepared, () => {
    owner.off("error", reject);
    resolve();
  });
});
chmodSync(prepared, 0o660);
renameSync(prepared, socketPath);
const fd = owner._handle.fd;
if (!Number.isInteger(fd)) {
  process.stderr.write("prepared Unix socket has no file descriptor\n");
  process.exit(70);
}

const child = spawn(
  "/bin/sh",
  ["-c", 'LISTEN_PID=$$; export LISTEN_PID; exec "$@"', "brain-mail", process.execPath, "--disable-warning=ExperimentalWarning", entrypoint],
  {
    cwd: path.dirname(path.dirname(entrypoint)),
    env: { ...process.env, LISTEN_FDS: "1", LISTEN_FDNAMES: "brain-mail" },
    stdio: ["ignore", "inherit", "inherit", fd],
  },
);
owner.close();

child.on("error", (error) => {
  process.stderr.write(`mail service failed to start: ${error.message}\n`);
  process.exit(70);
});
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 128 + os.constants.signals[signal] : 1));
});
