import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "install.sh");

/** A PATH with logging stubs in front, so nothing real runs. */
function stubs(root: string, extra: Record<string, string> = {}) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, "calls.log");
  const base: Record<string, string> = {
    "apt-get": `echo "apt-get $*" >> "${log}"`,
    docker: `echo "docker $*" >> "${log}"; case "$*" in *"compose version"*) exit 0;; *hash-password*) cat >/dev/null; echo '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';; esac`,
    curl: `echo "curl $*" >> "${log}"; case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *docker-compose.yml*) printf 'services: {}\\n';; *api/health*) printf '{"version":"0.9.3"}';; esac`,
    getent: `echo "getent $*" >> "${log}"; echo "203.0.113.7 $2"`,
    ss: `echo "ss $*" >> "${log}"`,
    openssl: `echo "openssl $*" >> "${log}"; echo 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
    systemctl: `echo "systemctl $*" >> "${log}"`,
    id: `echo 0`,
    uname: `echo x86_64`,
    free: `printf 'Mem: 2048 0 0\\n'`,
    ...extra,
  };
  for (const [name, body] of Object.entries(base)) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return { PATH: `${bin}:/usr/bin:/bin`, log };
}

/** The whole environment the script sees. NODE_ENV is there only because Next
 *  types it as required on ProcessEnv; bash does not read it. */
function scriptEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

function runInstall(env: Record<string, string>, args: string[] = [], extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
  const { PATH, log } = stubs(root, extra);
  const installDir = path.join(root, "opt-brain");
  const r = spawnSync("bash", [SCRIPT, ...args], {
    env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DIR: installDir, BRAIN_INSTALL_DRY_RUN: "1", ...env }),
    encoding: "utf8",
  });
  return { ...r, root, installDir, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

describe("install.sh preflight", () => {
  it("refuses a non-root run with one plain sentence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root, { id: "echo 1000" });
    const r = spawnSync("bash", [SCRIPT], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1" }), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Run this with sudo: it installs Docker and needs root for that.\n");
  });

  it("refuses an unsupported architecture by name", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root, { uname: "echo armv7l" });
    const r = spawnSync("bash", [SCRIPT], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1" }), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Brain ships for x86_64 and aarch64; this machine is armv7l.\n");
  });

  it("warns, but continues, between 1.5 and 2 GB of RAM", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    // stub reports 2048 MB: no warning
    expect(r.stdout).not.toContain("less than 2 GB");
  });

  it("notes the small headroom at 1700 MB and carries on", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { free: `printf 'Mem: 1700 0 0\\n'` });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Note: less than 2 GB of RAM; it runs, with little headroom.");
  });

  it("refuses 1024 MB with the machine's own number", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { free: `printf 'Mem: 1024 0 0\\n'` });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Brain and its mail service want 2 GB of RAM; this machine has 1024 MB.\n");
  });
});
