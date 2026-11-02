#!/usr/bin/env node
// Socket-activated one-message workers, like systemd Accept=yes. This process
// runs only in the networkless MIME container, which has no credential, mail
// state or notes mount. Docker bounds the entire pool's memory/CPU/processes.
import { spawn } from "node:child_process";
import { chmod, mkdir, rename, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function serveMimeSocket({ socketPath, entrypoint, timeoutMs = 16_000 }) {
  const children = new Set();
  let stopping = false;
  const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
    if (stopping || children.size >= 2) { socket.destroy(); return; }
    const child = spawn(process.execPath, ["--max-old-space-size=128", "--disable-warning=ExperimentalWarning", entrypoint], {
      cwd: path.dirname(entrypoint),
      // Never inherit the service's credentials or any operator's environment.
      env: { NODE_ENV: "production" },
      stdio: [socket, "inherit", "inherit"],
    });
    children.add(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref();
    child.once("spawn", () => socket.destroy());
    child.once("error", () => socket.destroy());
    child.once("close", () => { clearTimeout(timer); children.delete(child); });
  });
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o710 });
  const prepared = `${socketPath}.${process.pid}`;
  await unlink(prepared).catch((error) => { if (error.code !== "ENOENT") throw error; });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(prepared, () => { server.off("error", reject); resolve(); });
  });
  await chmod(prepared, 0o600);
  await rename(prepared, socketPath);
  return async () => {
    stopping = true;
    const exited = [...children].map((child) => new Promise((resolve) => {
      child.once("close", resolve);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    }));
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(exited);
    await unlink(socketPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [socketPath, entrypoint] = process.argv.slice(2);
  if (!socketPath || !entrypoint || !path.isAbsolute(socketPath) || !path.isAbsolute(entrypoint)) {
    process.stderr.write("usage: brain-mail-mime-activate.mjs <absolute socket-path> <absolute worker.js>\n");
    process.exit(64);
  }
  const stop = await serveMimeSocket({ socketPath, entrypoint });
  let stopped = false;
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
    if (stopped) return;
    stopped = true;
    void stop().then(() => process.exit(0), () => process.exit(1));
  });
}
