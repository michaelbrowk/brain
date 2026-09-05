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
    curl: `echo "curl $*" >> "${log}"; case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *docker-compose.yml*) printf 'services: {}\\n';; *api/health*) printf '{"version":"0.9.3"}';; *ifconfig.me*|*api.ipify*) printf '203.0.113.7';; esac`,
    getent: `echo "getent $*" >> "${log}"; echo "203.0.113.7 $2"`,
    ss: `echo "ss $*" >> "${log}"`,
    // A low-entropy stand-in on purpose: a random-looking 64 hex string here
    // reads as a real secret to the repository secret scanner.
    openssl: `echo "openssl $*" >> "${log}"; echo deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`,
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
function runInstall(
  env: Record<string, string>,
  args: string[] = [],
  extra: Record<string, string> = {},
  input?: string,
  /** Runs before the script, for a case that starts from an existing install dir.
   *  It may return environment for the script, such as the path of a file it made
   *  next to the install dir. */
  prepare?: (installDir: string) => void | Record<string, string>,
) {
  const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
  const { PATH, log } = stubs(root, extra);
  const installDir = path.join(root, "opt-brain");
  const more = prepare?.(installDir) ?? {};
  const options: SpawnSyncOptionsWithStringEncoding & Pick<SpawnOptions, "detached"> = {
    env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DIR: installDir, BRAIN_INSTALL_DRY_RUN: "1", ...env, ...more }),
    encoding: "utf8",
    input,
    cwd: root,
    detached: true,
  };
  const r = spawnSync("bash", [SCRIPT, ...args], options);
  return { ...r, root, installDir, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
}

/** A second run of the script against the install a first run left behind.
 *  The stubs are written again into the same root, which only rewrites them. */
function rerun(first: { root: string; installDir: string }, args: string[] = [], extra: Record<string, string> = {}, env: Record<string, string> = {}) {
  const { PATH } = stubs(first.root, extra);
  const options: SpawnSyncOptionsWithStringEncoding & Pick<SpawnOptions, "detached"> = {
    env: scriptEnv({ PATH, HOME: first.root, BRAIN_INSTALL_DIR: first.installDir, BRAIN_INSTALL_DRY_RUN: "1", ...env }),
    encoding: "utf8",
    cwd: first.root,
    detached: true,
  };
  return spawnSync("bash", [SCRIPT, ...args], options);
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
    expect(r.status).toBe(0);
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

  it("refuses a relative BRAIN_INSTALL_DIR", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "", BRAIN_INSTALL_DIR: "brain" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("BRAIN_INSTALL_DIR must be an absolute path.\n");
  });

  it.each<[string, string[]]>([
    ["current", []],
    ["releases", []],
    ["current", ["--uninstall"]],
    ["releases", ["--uninstall"]],
  ])("refuses a directory that holds a systemd install (%s, %j) before doing anything", (entry, args) => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, args, {}, undefined, (dir) => {
      mkdirSync(path.join(dir, entry), { recursive: true });
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`${r.installDir} already holds a systemd install of Brain, with current/ and releases/ in it. This installer manages only its own Docker install and would overwrite that one. Move it, or point BRAIN_INSTALL_DIR somewhere else.\n`);
    expect(r.stdout).toBe("");
    expect(r.calls()).toBe("");
  });

  it("refuses an unknown option instead of installing", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, ["--help"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Unknown option --help. This script takes no arguments, or --uninstall.\n");
    expect(r.stdout).toBe("");
    expect(r.calls()).toBe("");
  });

  it("ends with main, which the questions under curl | bash depend on", () => {
    const lines = readFileSync(SCRIPT, "utf8").trimEnd().split("\n");
    expect(lines.at(-1)).toBe('main "$@"');
  });
});

const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n';
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nID=debian\nVERSION_CODENAME=bookworm\n';
const MINT = 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_CODENAME=wilma\nUBUNTU_CODENAME=noble\n';

/** An os-release next to the install dir, and the environment that points the script at it. */
function osRelease(body: string) {
  return (installDir: string) => {
    const file = path.join(installDir, "..", "os-release");
    writeFileSync(file, body);
    return { BRAIN_OS_RELEASE: file };
  };
}

/** Every apt call waits for the dpkg lock, which cloud-init holds for a while
 *  on a machine that has just booted. */
const APT = "apt-get -o DPkg::Lock::Timeout=300";
const WAITING = "Waiting for other package managers to finish, if any...";

/** Docker not installed yet: `compose version` fails. hash-password still
 *  answers, standing in for the image the plan has by then installed. */
const DOCKER_ABSENT = `echo "docker $*" >> "__LOG__"; case "$*" in *"compose version"*) exit 1;; *hash-password*) cat >/dev/null; echo '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';; esac`;

describe("install.sh first install", () => {
  it("plans Docker from its apt repo, resolves the latest tag, writes .env with a doubled-dollar hash", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { docker: DOCKER_ABSENT }, undefined, osRelease(UBUNTU));
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain("Docker: installing from Docker's apt repository for ubuntu noble (this replaces the distribution's docker.io package if it is present)");
    expect(out).toContain(`would run: ${APT} install -y ca-certificates curl gnupg`);
    // every apt call in the plan, Docker's and Caddy's, carries the lock timeout
    const apt = out.match(/^would run: apt-get .*$/gm) ?? [];
    expect(apt.length).toBeGreaterThan(4);
    for (const line of apt) expect(line.startsWith(`would run: ${APT} `)).toBe(true);
    expect(out).toContain("would run: curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc");
    expect(out).toContain("would run: bash -c echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' > /etc/apt/sources.list.d/docker.list");
    expect(out).toContain(`would run: ${APT} install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin`);
    expect(out).toContain("Latest release: 0.9.3");
    // downloaded next to the compose file and moved into place, so a dropped transfer cannot truncate an existing one
    const fresh = path.join(r.installDir, ".docker-compose.yml.new");
    expect(out).toContain(`would run: curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/v0.9.3/ops/docker/docker-compose.yml -o ${fresh}`);
    expect(out).toContain(`would run: mv ${fresh} ${path.join(r.installDir, "docker-compose.yml")}`);
    const envFile = path.join(r.installDir, ".env");
    const env = readFileSync(envFile, "utf8");
    expect(env).toContain(`NOTES_ROOT=${path.join(r.installDir, "notes")}`);
    expect(env).toContain("AUTH_SECRET=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(env).toContain("AUTH_PASSWORD_HASH=$$2a$$12$$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678");
    expect(env).toContain("BRAIN_PUBLIC_ORIGIN=https://notes.example.com");
    expect(env).not.toContain("abc12345");
    expect(r.stdout + r.stderr).not.toContain("abc12345"); // the password is never printed
    expect(r.calls()).not.toContain("abc12345"); // and never becomes an argument
    expect(r.calls()).not.toContain("$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678"); // nor does the hash
    expect(r.calls()).toContain("docker run --rm -i ghcr.io/michaelbrowk/brain:0.9.3 hash-password");
    expect(r.stdout).toContain(`would run: chown 1000:1000 ${path.join(r.installDir, "notes")}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(r.installDir, "notes"))).toBe(true);
    expect(existsSync(path.join(r.installDir, "docker-compose.yml"))).toBe(true);
  });

  it("says a wait is possible when another package manager holds the dpkg lock", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { docker: DOCKER_ABSENT, fuser: "exit 0" }, undefined, osRelease(UBUNTU));
    expect(r.status).toBe(0);
    // once, right before the first apt call
    expect(r.stdout.match(new RegExp(`^${WAITING.replace(/\./g, "\\.")}$`, "gm"))).toHaveLength(1);
    expect(r.stdout.indexOf(WAITING)).toBeLessThan(r.stdout.indexOf(`would run: ${APT} update`));
  });

  it("says nothing about waiting when the dpkg lock is free", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { docker: DOCKER_ABSENT, fuser: "exit 1" }, undefined, osRelease(UBUNTU));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`would run: ${APT} update`);
    expect(r.stdout).not.toContain(WAITING);
  });

  it("takes Docker's Debian repository on Debian, under the Debian codename", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { docker: DOCKER_ABSENT }, undefined, osRelease(DEBIAN));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Docker: installing from Docker's apt repository for debian bookworm");
    expect(r.stdout).toContain("would run: curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc");
    expect(r.stdout).toContain("https://download.docker.com/linux/debian bookworm stable");
  });

  it("takes the Ubuntu repository under the Ubuntu codename on an Ubuntu derivative", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { docker: DOCKER_ABSENT, uname: "echo aarch64" }, undefined, osRelease(MINT));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://download.docker.com/linux/ubuntu noble stable");
    expect(r.stdout).toContain("[arch=arm64 ");
  });

  it("refuses a distribution Docker's apt repository does not cover", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { docker: DOCKER_ABSENT }, undefined, osRelease('ID=fedora\nVERSION_ID=41\n'));
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`Docker's apt repository covers Ubuntu and Debian; this machine reports ID=fedora in ${path.join(r.root, "os-release")}.\n`);
  });

  it("stops when os-release cannot be read", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { docker: DOCKER_ABSENT }, undefined, (dir) => ({ BRAIN_OS_RELEASE: path.join(dir, "..", "missing") }));
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`Could not read ${path.join(r.root, "missing")} to pick Docker's apt repository.\n`);
  });

  it("stops with one sentence when the compose file cannot be downloaded, leaving no half file", () => {
    // a real run, with every side effect on its way to the download stubbed
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "", BRAIN_INSTALL_DRY_RUN: "0" }, [], {
      curl: `case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *) exit 22;; esac`,
      chown: "",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Could not download the compose file for 0.9.3. Check the network and try again.\n");
    expect(existsSync(path.join(r.installDir, "docker-compose.yml"))).toBe(false);
    expect(existsSync(path.join(r.installDir, ".docker-compose.yml.new"))).toBe(false);
  });

  it("finds Docker already present and leaves apt alone", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Docker: present");
    expect(r.stdout).not.toContain("install -y docker-ce");
  });

  it("keeps Brain local when no domain is given", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    expect(r.status).toBe(0);
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
    const short = runInstall({ BRAIN_PASSWORD: "short", BRAIN_DOMAIN: "" });
    expect(short.status).toBe(1);
    expect(short.stderr).toBe("Password: at least 8 characters.\n");
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

  it("stops before writing .env when openssl cannot make the secret", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], { openssl: "exit 1" });
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(r.installDir, ".env"))).toBe(false);
  });

  it("reads the tag out of a release payload far larger than a pipe buffer", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], {
      curl: `printf '{"tag_name":"v0.9.3",\\n"body":"'; head -c 1000000 /dev/zero | tr '\\0' x; printf '"}'`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Latest release: 0.9.3");
  });

  it("stops when the image cannot hash the password", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], {
      docker: `case "$*" in *"compose version"*) exit 0;; *) cat >/dev/null; exit 1;; esac`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Could not hash the password with the Brain image 0.9.3. This installer needs a release that ships hash-password; a newer one may be needed.\n");
  });

  it("drops BRAIN_PASSWORD from the environment once it has been read", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], {
      docker: `echo "docker $* env-password=\${BRAIN_PASSWORD:-unset}" >> "__LOG__"; case "$*" in *"compose version"*) exit 0;; *hash-password*) cat >/dev/null; echo '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';; esac`,
    });
    expect(r.status).toBe(0);
    expect(r.calls()).toContain("hash-password env-password=unset");
  });

  it("refuses an IP address as the domain", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "203.0.113.7" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("That is an IP address, not a domain name. Caddy cannot get a certificate for one; leave the answer empty to keep Brain on this machine.\n");
  });

  it("refuses when 3020 is taken, with or without a domain", () => {
    const ss = 'echo "LISTEN 0 4096 127.0.0.1:3020 0.0.0.0:* users:((\\"node\\",pid=5,fd=3))"';
    for (const domain of ["", "notes.example.com"]) {
      const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: domain }, [], { ss });
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("Port 3020 is already taken by node. Stop it first, since Brain listens there.\n");
      expect(r.stdout).not.toContain("caddy");
    }
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

/** The site file the script writes, its first line marking it as the script's own. */
const OURS = "# managed by Brain install.sh\nnotes.example.com {\n\treverse_proxy 127.0.0.1:3020\n}\n";
/** Someone else's file, with the script's block added by hand after the refusal sentence. */
const THEIRS_WITH_OURS = "example.org {\n\troot * /srv/example\n\tfile_server\n}\nnotes.example.com {\n\treverse_proxy 127.0.0.1:3020\n}\n";

describe("install.sh TLS", () => {
  it("installs Caddy from its apt repo and writes one site block when a domain is given", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" });
    expect(r.status).toBe(0);
    expect(r.stdout.indexOf(`would run: ${APT} update`)).toBeLessThan(r.stdout.indexOf(`would run: ${APT} install -y debian-keyring`));
    expect(r.stdout).toContain(`would run: ${APT} install -y caddy`);
    expect(readFileSync(path.join(r.installDir, "Caddyfile"), "utf8")).toBe(OURS);
    // no Caddyfile on this machine yet, so the copy into place is planned
    expect(r.stdout).toContain(`would run: install -m 0644 ${path.join(r.installDir, "Caddyfile")} /etc/caddy/Caddyfile`);
    expect(r.stdout).toContain("would run: systemctl reload caddy");
    // the default stubs resolve the domain to this machine's own address
    expect(r.stdout).not.toContain("resolves to");
  });

  it("refuses to replace a Caddyfile that has another site in it", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { caddy: "exit 0" }, undefined, (dir) => {
      const file = path.join(dir, "..", "Caddyfile-etc");
      writeFileSync(file, "example.org {\n\troot * /srv/example\n\tfile_server\n}\n");
      return { BRAIN_CADDYFILE: file };
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`${path.join(r.root, "Caddyfile-etc")} already has a site in it. Add notes.example.com { reverse_proxy 127.0.0.1:3020 } yourself, or install Brain without a domain.\n`);
    expect(r.stdout).not.toContain("install -m 0644");
    expect(existsSync(path.join(r.installDir, "Caddyfile"))).toBe(false);
  });

  it("replaces its own Caddyfile on a re-run, known by its first line", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { caddy: "exit 0" }, undefined, (dir) => {
      const file = path.join(dir, "..", "Caddyfile-etc");
      writeFileSync(file, OURS);
      return { BRAIN_CADDYFILE: file };
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`would run: install -m 0644 ${path.join(r.installDir, "Caddyfile")} ${path.join(r.root, "Caddyfile-etc")}`);
  });

  it("refuses a file where the script's block was added by hand next to other sites", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { caddy: "exit 0" }, undefined, (dir) => {
      const file = path.join(dir, "..", "Caddyfile-etc");
      writeFileSync(file, THEIRS_WITH_OURS);
      return { BRAIN_CADDYFILE: file };
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe(`${path.join(r.root, "Caddyfile-etc")} already has a site in it. Add notes.example.com { reverse_proxy 127.0.0.1:3020 } yourself, or install Brain without a domain.\n`);
    expect(readFileSync(path.join(r.root, "Caddyfile-etc"), "utf8")).toBe(THEIRS_WITH_OURS);
  });

  it("skips Caddy entirely without a domain", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("caddy");
    expect(existsSync(path.join(r.installDir, "Caddyfile"))).toBe(false);
  });

  it("leaves apt alone when Caddy is already installed, and still writes and reloads", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { caddy: "exit 0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Caddy: present");
    expect(r.stdout).not.toContain("install -y caddy");
    expect(r.stdout).toContain("would run: install -m 0644");
    expect(r.stdout).toContain("would run: systemctl reload caddy");
  });

  it("names the process when 80 or 443 is taken", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root, { ss: 'echo "LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:((\\"nginx\\",pid=1234,fd=6))"' });
    const r = spawnSync("bash", [SCRIPT], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1", BRAIN_INSTALL_DIR: path.join(root, "o"), BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Port 80 is already taken by nginx. Stop it, or install Brain without a domain and put it behind that proxy yourself.\n");
    // refused before Caddy is planned
    expect(r.stdout).not.toContain("caddy");
  });

  it("says 'another program' on 443 when ss shows no process name", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { ss: 'echo "LISTEN 0 4096 [::]:443 [::]:*"' });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Port 443 is already taken by another program. Stop it, or install Brain without a domain and put it behind that proxy yourself.\n");
  });

  it("accepts Caddy's own listeners on a re-run, and ignores 8080 and 8443", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], {
      ss: `printf '%s\\n' 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=77,fd=3))' 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=77,fd=4))' 'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("java",pid=9,fd=5))' 'LISTEN 0 4096 [::]:8443 [::]:* users:(("java",pid=9,fd=6))'`,
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it.skipIf(existsSync("/usr/bin/ss") || existsSync("/bin/ss"))("skips the port check with a note when ss is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root);
    rmSync(path.join(root, "bin", "ss"));
    const r = spawnSync("bash", [SCRIPT], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1", BRAIN_INSTALL_DIR: path.join(root, "o"), BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Note: ss is not available, skipping the port check.");
  });

  it("still installs when DNS points elsewhere, and says which record to fix", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root, { getent: 'echo "198.51.100.9 $2"', curl: `case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *ifconfig.me*|*api.ipify*) printf '203.0.113.7';; *) printf 'ok';; esac` });
    const r = spawnSync("bash", [SCRIPT], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1", BRAIN_INSTALL_DIR: path.join(root, "o"), BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("notes.example.com resolves to 198.51.100.9 but this machine is 203.0.113.7. Point the A record here; Caddy keeps retrying until it can get a certificate.");
    expect(r.stdout).toContain(`would run: ${APT} install -y caddy`);
  });

  it("notes when the public address cannot be read, and carries on", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], {
      curl: `case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *ifconfig.me*|*api.ipify*) exit 22;; esac`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Note: could not compare DNS with this machine's address; Caddy keeps retrying until the record points here.");
    expect(r.stdout).toContain(`would run: ${APT} install -y caddy`);
  });

  it("normalises a pasted URL down to the bare hostname", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "https://Notes.Example.com/" });
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(r.installDir, ".env"), "utf8")).toContain("BRAIN_PUBLIC_ORIGIN=https://notes.example.com");
    expect(readFileSync(path.join(r.installDir, "Caddyfile"), "utf8")).toBe(OURS);
  });

  it("refuses a domain that is not a hostname", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "not a host" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Domain: use a bare hostname like notes.example.com.\n");
  });
});

const UPGRADE = "curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/main/install.sh | sudo bash";

/** The closing message, in order, for a Brain at `origin` with notes in `notes`. */
function closing(origin: string, notes: string) {
  return [
    "Brain 0.9.3 is running.",
    "",
    `Open:      ${origin}`,
    `Notes:     ${notes} (they belong to the app's user, uid 1000)`,
    `Upgrade:   ${UPGRADE}`,
    `Uninstall: ${UPGRADE} -s -- --uninstall`,
  ].join("\n");
}

describe("install.sh run, upgrade, uninstall", () => {
  it("pulls, starts, waits for health and prints the closing message", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const pull = r.stdout.search(/^would run: docker compose .*\bpull$/m);
    const up = r.stdout.search(/^would run: docker compose .*\bup -d$/m);
    expect(pull).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(pull);
    // the compose file was written before compose is asked to read it
    expect(r.stdout.indexOf("ops/docker/docker-compose.yml")).toBeLessThan(pull);
    expect(r.calls()).toContain("curl -fsS --max-time 2 http://127.0.0.1:3020/api/health");
    expect(r.stdout.indexOf("Waiting for Brain to answer on port 3020...")).toBeGreaterThan(up);
    // the closing message is the last thing said, and there is no tunnel line with a domain
    expect(r.stdout.endsWith(`${closing("https://notes.example.com", path.join(r.installDir, "notes"))}\n`)).toBe(true);
  });

  it("adds the tunnel line, to this machine's public address, only when there is no domain", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "", SUDO_USER: "misha" });
    expect(r.status).toBe(0);
    const tail = `${closing("http://localhost:3020", path.join(r.installDir, "notes"))}\nTunnel:    ssh -L 3020:127.0.0.1:3020 misha@203.0.113.7\n`;
    expect(r.stdout.endsWith(tail)).toBe(true);
    // asked once, and never allowed to hang the run after the closing message
    expect(r.calls().match(/^curl -fsSL --connect-timeout 2 --max-time 4 https:\/\/api\.ipify\.org$/gm)).toHaveLength(1);
  });

  it("falls back to the hostname in the tunnel line when the public address cannot be read", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "", SUDO_USER: "misha" }, [], {
      curl: `case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *api/health*) printf '{"version":"0.9.3"}';; *ifconfig.me*|*api.ipify*) exit 22;; esac`,
      hostname: "echo brain-box",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.endsWith("Tunnel:    ssh -L 3020:127.0.0.1:3020 misha@brain-box\n")).toBe(true);
  });

  it("gives up after two minutes of probing with the log tail and one sentence", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" }, [], {
      curl: `echo "curl $*" >> "__LOG__"; case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *api/health*) exit 7;; esac`,
      sleep: `echo "sleep $*" >> "__LOG__"`,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Brain did not answer on port 3020 within two minutes. The last log lines are above; please open an issue with them.\n");
    expect(r.stdout).toMatch(/^would run: docker compose .*\blogs --tail 20$/m);
    expect(r.stdout).not.toContain("is running");
    // 40 probes of at most 2 s with 1 s between them: under two minutes at worst, the first one right away
    expect(r.calls().match(/^curl -fsS --max-time 2 http:\/\/127\.0\.0\.1:3020\/api\/health$/gm)).toHaveLength(40);
    expect(r.calls().match(/^sleep 1$/gm)).toHaveLength(39);
  });

  it("upgrades in place when .env exists: keeps .env and notes, replaces compose, asks nothing", () => {
    const first = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" });
    const envBefore = readFileSync(path.join(first.installDir, ".env"), "utf8");
    writeFileSync(path.join(first.installDir, "notes", "keep.md"), "# keep\n");
    const again = rerun(first);
    expect(again.status).toBe(0);
    expect(again.stderr).toBe("");
    expect(again.stdout).toContain("Existing install found; upgrading to 0.9.3.");
    expect(again.stdout).not.toContain("Choose the Brain password");
    expect(again.stdout).not.toContain("Domain name for this Brain");
    expect(again.stdout).not.toContain("caddy");
    expect(again.stdout).toContain("would run: curl -fsSL https://raw.githubusercontent.com/michaelbrowk/brain/v0.9.3/ops/docker/docker-compose.yml");
    expect(again.stdout).toMatch(/^would run: docker compose .*\bup -d$/m);
    expect(again.stdout.endsWith(`${closing("https://notes.example.com", path.join(first.installDir, "notes"))}\n`)).toBe(true);
    expect(readFileSync(path.join(first.installDir, ".env"), "utf8")).toBe(envBefore);
    expect(existsSync(path.join(first.installDir, "notes", "keep.md"))).toBe(true);
    // the password was hashed once, on the first run
    expect(first.calls().match(/hash-password/g)).toHaveLength(1);
  });

  it("reads the notes path and origin out of an existing .env, and tightens a loose one to 600", () => {
    const r = runInstall({ BRAIN_DOMAIN: "", SUDO_USER: "misha" }, [], {}, undefined, (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".env"), `NOTES_ROOT=${path.join(dir, "..", "elsewhere")}\nAUTH_SECRET=old\nAUTH_PASSWORD_HASH=old\nBRAIN_PUBLIC_ORIGIN=http://localhost:3020\n`);
      chmodSync(path.join(dir, ".env"), 0o644);
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const notes = path.join(r.root, "elsewhere");
    expect(existsSync(notes)).toBe(true);
    expect(r.stdout).toContain(`would run: chown 1000:1000 ${notes}`);
    expect(r.stdout.endsWith(`${closing("http://localhost:3020", notes)}\nTunnel:    ssh -L 3020:127.0.0.1:3020 misha@203.0.113.7\n`)).toBe(true);
    const envFile = path.join(r.installDir, ".env");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, "utf8")).toContain("AUTH_SECRET=old");
  });

  it("uninstall removes everything but the notes and says where they are", () => {
    const first = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" });
    const r = rerun(first, ["--uninstall"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^would run: docker compose .*\bdown -v$/m);
    expect(r.stdout).not.toMatch(/would run: rm .*notes/);
    for (const name of ["Caddyfile", "docker-compose.yml", ".env"]) {
      expect(r.stdout).toContain(`would run: rm -rf -- ${path.join(first.installDir, name)}`);
    }
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`Your notes are still in ${path.join(first.installDir, "notes")}.`);
    // dry run: the plan is printed, nothing is removed
    expect(existsSync(path.join(first.installDir, ".env"))).toBe(true);
  });

  it("uninstall spares notes that .env keeps somewhere else inside the install directory", () => {
    const first = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    const notes = path.join(first.installDir, "my-notes");
    mkdirSync(notes);
    writeFileSync(path.join(first.installDir, ".env"), `NOTES_ROOT=${notes}\nBRAIN_PUBLIC_ORIGIN=http://localhost:3020\n`);
    const r = rerun(first, ["--uninstall"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/would run: rm .*my-notes/);
    // the default notes directory is spared whatever .env says
    expect(r.stdout).not.toMatch(/would run: rm .*\/notes$/m);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`Your notes are still in ${notes}.`);
  });

  it.each<[string, (notes: string) => string]>([
    ["double quotes", (notes) => `NOTES_ROOT="${notes}"\n`],
    ["single quotes", (notes) => `NOTES_ROOT='${notes}'\n`],
    ["a trailing space", (notes) => `NOTES_ROOT=${notes} \n`],
    ["a duplicated key", (notes) => `NOTES_ROOT=${notes}\nNOTES_ROOT=/nowhere\n`],
  ])("uninstall still spares the notes when .env writes NOTES_ROOT with %s", (_case, line) => {
    const first = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    const notes = path.join(first.installDir, "my-notes");
    mkdirSync(notes);
    writeFileSync(path.join(first.installDir, ".env"), `${line(notes)}BRAIN_PUBLIC_ORIGIN=http://localhost:3020\n`);
    const r = rerun(first, ["--uninstall"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/would run: rm .*my-notes/);
    expect(r.stdout).toContain(`would run: rm -rf -- ${path.join(first.installDir, ".env")}`);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`Your notes are still in ${notes}.`);
  });

  it("uninstall removes the Caddy site it wrote and leaves anyone else's alone, block or no block", () => {
    const first = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" });
    const file = path.join(first.root, "Caddyfile-etc");
    writeFileSync(file, OURS);
    const ours = rerun(first, ["--uninstall"], {}, { BRAIN_CADDYFILE: file });
    expect(ours.status).toBe(0);
    expect(ours.stdout).toContain(`would run: rm -f ${file}`);
    expect(ours.stdout).toContain("would run: systemctl reload caddy");
    for (const body of ["example.org {\n\troot * /srv/example\n}\n", THEIRS_WITH_OURS]) {
      writeFileSync(file, body);
      const theirs = rerun(first, ["--uninstall"], {}, { BRAIN_CADDYFILE: file });
      expect(theirs.status).toBe(0);
      expect(theirs.stdout).not.toContain(`rm -f ${file}`);
      expect(theirs.stdout).not.toContain("caddy");
      expect(readFileSync(file, "utf8")).toBe(body);
    }
  });

  it("uninstall spares the directories above notes nested deeper in the install directory", () => {
    const first = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    const notes = path.join(first.installDir, "data", "notes");
    mkdirSync(notes, { recursive: true });
    // the default notes folder of the first run is empty and no longer in use
    rmSync(path.join(first.installDir, "notes"), { recursive: true });
    writeFileSync(path.join(first.installDir, ".env"), `NOTES_ROOT=${notes}\nBRAIN_PUBLIC_ORIGIN=http://localhost:3020\n`);
    const r = rerun(first, ["--uninstall"]);
    expect(r.status).toBe(0);
    const removed = (r.stdout.match(/^would run: rm .*$/gm) ?? []).map((line) => line.slice(`would run: rm -rf -- ${first.installDir}`.length));
    expect(removed).toContain("/.env");
    for (const entry of removed) expect(entry).not.toMatch(/^\/(data|notes)(\/|$)/);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`Your notes are still in ${notes}.`);
  });

  it("uninstall needs root, like the install, and says so before doing anything", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root, { id: "echo 1000" });
    const r = spawnSync("bash", [SCRIPT, "--uninstall"], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1" }), encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("Run this with sudo: it installs Docker and needs root for that.\n");
    expect(r.stdout).toBe("");
  });

  it("uninstall with nothing installed says nothing, since no notes directory exists to name", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root);
    const installDir = path.join(root, "o");
    const r = spawnSync("bash", [SCRIPT, "--uninstall"], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1", BRAIN_INSTALL_DIR: installDir }), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });
});
