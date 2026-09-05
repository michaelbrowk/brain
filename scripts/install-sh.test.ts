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
function runInstall(
  env: Record<string, string>,
  args: string[] = [],
  extra: Record<string, string> = {},
  input?: string,
  /** Runs before the script, for a case that starts from an existing install dir. */
  prepare?: (installDir: string) => void,
) {
  const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
  const { PATH, log } = stubs(root, extra);
  const installDir = path.join(root, "opt-brain");
  prepare?.(installDir);
  const options: SpawnSyncOptionsWithStringEncoding & Pick<SpawnOptions, "detached"> = {
    env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DIR: installDir, BRAIN_INSTALL_DRY_RUN: "1", ...env }),
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
});

/** Docker not installed yet: `compose version` fails. hash-password still
 *  answers, standing in for the image the plan has by then installed. */
const DOCKER_ABSENT = `echo "docker $*" >> "__LOG__"; case "$*" in *"compose version"*) exit 1;; *hash-password*) cat >/dev/null; echo '$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678';; esac`;

describe("install.sh first install", () => {
  it("plans Docker from its apt repo, resolves the latest tag, writes .env with a doubled-dollar hash", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { docker: DOCKER_ABSENT });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain("Docker: installing from Docker's apt repository (this replaces Ubuntu's docker.io package if it is present)");
    expect(out).toContain("would run: apt-get install -y ca-certificates curl gnupg");
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
    expect(r.stdout + r.stderr).not.toContain("abc12345"); // the password is never printed
    expect(r.calls()).not.toContain("abc12345"); // and never becomes an argument
    expect(r.calls()).not.toContain("$2a$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345678"); // nor does the hash
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

describe("install.sh TLS", () => {
  it("installs Caddy from its apt repo and writes one site block when a domain is given", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would run: apt-get install -y caddy");
    expect(readFileSync(path.join(r.installDir, "Caddyfile"), "utf8")).toBe("notes.example.com {\n\treverse_proxy 127.0.0.1:3020\n}\n");
    expect(r.stdout).toContain("would run: install -m 0644");
    expect(r.stdout).toContain("would run: systemctl reload caddy");
    // the default stubs resolve the domain to this machine's own address
    expect(r.stdout).not.toContain("resolves to");
  });

  it("skips Caddy entirely without a domain", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "" });
    expect(r.stdout).not.toContain("caddy");
    expect(existsSync(path.join(r.installDir, "Caddyfile"))).toBe(false);
  });

  it("leaves apt alone when Caddy is already installed, and still writes and reloads", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], { caddy: "exit 0" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Caddy: present");
    expect(r.stdout).not.toContain("apt-get install -y caddy");
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
    expect(r.stdout).toContain("would run: apt-get install -y caddy");
  });

  it("notes when the public address cannot be read, and carries on", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "notes.example.com" }, [], {
      curl: `case "$*" in *releases/latest*) printf '{"tag_name":"v0.9.3"}';; *ifconfig.me*|*api.ipify*) exit 22;; esac`,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Note: could not compare DNS with this machine's address; Caddy keeps retrying until the record points here.");
    expect(r.stdout).toContain("would run: apt-get install -y caddy");
  });

  it("normalises a pasted URL down to the bare hostname", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "https://Notes.Example.com/" });
    expect(r.status).toBe(0);
    expect(readFileSync(path.join(r.installDir, ".env"), "utf8")).toContain("BRAIN_PUBLIC_ORIGIN=https://notes.example.com");
    expect(readFileSync(path.join(r.installDir, "Caddyfile"), "utf8").startsWith("notes.example.com {")).toBe(true);
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
    // the closing message is the last thing said, and there is no tunnel line with a domain
    expect(r.stdout.endsWith(`${closing("https://notes.example.com", path.join(r.installDir, "notes"))}\n`)).toBe(true);
  });

  it("adds the tunnel line, and only then, when there is no domain", () => {
    const r = runInstall({ BRAIN_PASSWORD: "abc12345", BRAIN_DOMAIN: "", SUDO_USER: "misha" }, [], { hostname: "echo brain-box" });
    expect(r.status).toBe(0);
    const tail = `${closing("http://localhost:3020", path.join(r.installDir, "notes"))}\nTunnel:    ssh -L 3020:127.0.0.1:3020 misha@brain-box\n`;
    expect(r.stdout.endsWith(tail)).toBe(true);
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
    const r = runInstall({ BRAIN_DOMAIN: "", SUDO_USER: "misha" }, [], { hostname: "echo brain-box" }, undefined, (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".env"), `NOTES_ROOT=${path.join(dir, "..", "elsewhere")}\nAUTH_SECRET=old\nAUTH_PASSWORD_HASH=old\nBRAIN_PUBLIC_ORIGIN=http://localhost:3020\n`);
      chmodSync(path.join(dir, ".env"), 0o644);
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    const notes = path.join(r.root, "elsewhere");
    expect(existsSync(notes)).toBe(true);
    expect(r.stdout).toContain(`would run: chown 1000:1000 ${notes}`);
    expect(r.stdout.endsWith(`${closing("http://localhost:3020", notes)}\nTunnel:    ssh -L 3020:127.0.0.1:3020 misha@brain-box\n`)).toBe(true);
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
    expect(r.stdout).toContain(`would run: rm -rf -- ${path.join(first.installDir, "notes")}`);
    expect(r.stdout.trim().split("\n").at(-1)).toBe(`Your notes are still in ${notes}.`);
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

  it("uninstall with nothing installed only says where the notes would be", () => {
    const root = mkdtempSync(path.join(tmpdir(), "brain-install-"));
    const { PATH } = stubs(root);
    const installDir = path.join(root, "o");
    const r = spawnSync("bash", [SCRIPT, "--uninstall"], { env: scriptEnv({ PATH, HOME: root, BRAIN_INSTALL_DRY_RUN: "1", BRAIN_INSTALL_DIR: installDir }), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`Your notes are still in ${path.join(installDir, "notes")}.\n`);
  });
});
