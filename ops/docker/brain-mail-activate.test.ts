import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const shim = path.join(process.cwd(), "ops", "docker", "brain-mail-activate.mjs");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mail socket handoff", () => {
  it("hands one named listening socket to the child exactly as systemd would", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-activate-"));
    roots.push(root);
    const socketPath = path.join(root, "run", "brain-mail.sock");
    const fake = path.join(root, "service", "main.js");
    await writeFile(fake, "", { flag: "wx" }).catch(async () => {
      await execFileAsync("mkdir", ["-p", path.dirname(fake)]);
    });
    await writeFile(
      fake,
      [
        'const { fstatSync } = require("node:fs");',
        "const ok = process.env.LISTEN_PID === String(process.pid)",
        '  && process.env.LISTEN_FDS === "1"',
        '  && process.env.LISTEN_FDNAMES === "brain-mail"',
        "  && fstatSync(3).isSocket();",
        'process.stdout.write(ok ? "handoff ok\\n" : "handoff broken\\n");',
        "process.exit(ok ? 0 : 3);",
      ].join("\n"),
    );
    const result = await execFileAsync(process.execPath, [shim, socketPath, fake]);
    expect(result.stdout).toBe("handoff ok\n");
    expect((await stat(socketPath)).isSocket()).toBe(true);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
  });

  it("forwards SIGTERM and exits with the child's status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "brain-activate-"));
    roots.push(root);
    await execFileAsync("mkdir", ["-p", path.join(root, "service")]);
    const fake = path.join(root, "service", "main.js");
    await writeFile(fake, 'process.on("SIGTERM", () => process.exit(143));\nprocess.stdout.write("waiting\\n");\nsetInterval(() => {}, 1000);\n');
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [shim, path.join(root, "brain-mail.sock"), fake], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => child.once("exit", (value) => resolve(value)));
    expect(code).toBe(143);
  });
});
