import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, type SpawnOptions, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "..", "install.sh");

/** Every temp root the tests made, removed once the file has run. */
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A PATH with logging stubs in front, so nothing real runs. */
function stubs(root: string, extra: Record<string, string> = {}) {
  roots.push(root);
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
    // "__LOG__" in an override stands for the calls log, so a test's own stub
    // can keep logging without knowing the temp root.
    writeFileSync(file, `#!/usr/bin/env bash\n${body.split("__LOG__").join(log)}\n`);
    chmodSync(file, 0o755);
  }
  return { PATH: `${bin}:/usr/bin:/bin`, log };
}

/** The whole environment the script sees. NODE_ENV is there only because Next
 *  types it as required on ProcessEnv; bash does not read it. */
function scriptEnv(vars: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...vars };
}

/** `input` is what the script reads on stdin when it asks its questions.
 *  `detached` puts the script in its own session with no controlling terminal,
 *  so it answers on stdin here even when vitest itself runs from a terminal;
 *  without it the questions would go to that terminal and wait. spawnSync
 *  honours the flag (it shares spawn's option parser) though @types/node lists
 *  it only on the async SpawnOptions. */
function runInstall(env: Record<string, string>, args: string[] = [], extra: Record<string, string> = {}, input?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
  const { PATH, log } = stubs(root, extra);
  const installDir = path.join(root, "opt-brain");
  const options: SpawnSyncOptionsWithStringEncoding & Pick<SpawnOptions, "detached"> = {
    env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DIR: installDir, BRAIN_INSTALL_DRY_RUN: "1", ...env }),
    encoding: "utf8",
    input,
    detached: true,
  };
  const r = spawnSync("bash", [SCRIPT, ...args], options);
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

  it("reads an odd free output as no memory, with the refusal sentence and no bash error", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { free: `echo nonsense` });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Brain and its mail service want 2 GB of RAM; this machine has 0 MB.\n");
  });
});

/** Docker not installed yet: `compose version` fails. hash-password still
 *  answers, standing in for the image the plan has by then installed. */
const DOCKER_ABSENT = `echo "docker $*" >> "__LOG__"; case "$*" in *"compose version"*) exit 1;; *hash-password*) cat >/dev/null; echo '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';; esac`;

describe("install.sh first install", () => {
  it("plans Docker from its apt repo, resolves the latest tag, writes .env with a doubled-dollar hash", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { docker: DOCKER_ABSENT });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain("would run: apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin");
    expect(out).toContain("Latest release: 0.9.3");
    expect(out).toContain(`would run: curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/v0.9.3/ops/docker/docker-compose.yml`);
    const envFile = path.join(r.installDir, ".env");
    const env = readFileSync(envFile, "utf8");
    expect(env).toContain(`NOTES_ROOT=${path.join(r.installDir, "notes")}`);
    expect(env).toContain("AUTH_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(env).toContain("AUTH_PASSWORD_HASH=$$2a$$12$$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678");
    expect(env).toContain("BRAIN_PUBLIC_ORIGIN=https://notes.example.com");
    expect(env).not.toContain("abc12345");
    expect(r.calls()).not.toContain("abc12345"); // the password never becomes an argument
    expect(r.calls()).toContain("docker run --rm -i ghcr.io/michaelbrowk/brain:0.9.3 hash-password");
    expect(r.stdout).toContain(`would run: chown 1000:1000 ${path.join(r.installDir, "notes")}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(r.installDir, "notes"))).toBe(true);
    expect(existsSync(path.join(r.installDir, "docker-compose.yml"))).toBe(true);
  });

  it("finds Docker already present and leaves apt alone", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Docker: present");
    expect(r.stdout).not.toContain("apt-get install -y docker-ce");
  });

  it("keeps Brain local when no domain is given", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    expect(readFileSync(path.join(r.installDir, ".env"), "utf8")).toContain("BRAIN_PUBLIC_ORIGIN=http://localhost:3020");
    expect(r.stdout).toContain("ssh -L 3020:127.0.0.1:3020");
  });

  it("asks both questions on stdin when the environment does not answer them", () => {
    const r = runInstall({}, [], {}, "abc12345\nabc12345\nnotes.example.com\n");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Choose the Brain password: ");
    expect(r.stdout).toContain("Once more: ");
    expect(r.stdout).toContain("Domain name for this Brain, or leave empty to keep it on this machine only: ");
    expect(readFileSync(path.join(r.installDir, ".env"), "utf8")).toContain("BRAIN_PUBLIC_ORIGIN=https://notes.example.com");
  });

  it("refuses a short password and a mismatched one", () => {
    expect(runInstall({ BRAIN_PASSWORD: "short", BRAIN_DOMAIN: "" }).stderr).toBe("Password: at least 8 characters.\n");
    const r = runInstall({ BRAIN_DOMAIN: "" }, [], {}, "abc12345\nabc12346\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Password: the two entries differ.\n");
  });

  it("stops with one sentence when there is nothing to ask the password on", () => {
    const r = runInstall({ BRAIN_DOMAIN: "" }, [], {}, "");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("No terminal to ask on. Set BRAIN_PASSWORD and BRAIN_DOMAIN to install without prompts.\n");
  });

  it("stops with the same sentence when only the domain is left to ask", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345" }, [], {}, "");
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("No terminal to ask on. Set BRAIN_PASSWORD and BRAIN_DOMAIN to install without prompts.\n");
  });

  it("stops when the image cannot hash the password", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], {
      docker: `case "$*" in *"compose version"*) exit 0;; *) cat >/dev/null; exit 1;; esac`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Could not hash the password with the Brain image.\n");
  });

  it("stops when the releases API does not answer", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { curl: "exit 22" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Could not read the latest release from GitHub. Check the network and try again.\n");
  });

  it("stops when the releases API answers without a tag", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { curl: `printf '{"message":"rate limited"}'` });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Could not read the latest release from GitHub. Check the network and try again.\n");
  });
});
