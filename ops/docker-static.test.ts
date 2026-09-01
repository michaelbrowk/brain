import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const dockerfile = readFileSync(path.join(root, "ops", "docker", "Dockerfile"), "utf8");
const entrypoint = readFileSync(path.join(root, "ops", "docker", "brain-entrypoint.sh"), "utf8");
const compose = readFileSync(path.join(root, "ops", "docker", "docker-compose.smoke.yml"), "utf8");
const runtimeScript = readFileSync(path.join(root, "ops", "install-node-runtime.sh"), "utf8");
const ci = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const release = readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");

describe("container image", () => {
  it("pins the same Node as the runtime installer and both workflows", () => {
    const pinned = /^version="(\d+\.\d+\.\d+)"$/m.exec(runtimeScript)?.[1];
    expect(pinned).toBe("22.23.1");
    expect(dockerfile).toContain(`FROM node:${pinned}-bookworm-slim\n`);
    expect(dockerfile).toContain(`test "$(node --version)" = "v${pinned}"`);
    expect(ci).toContain(`node-version: ${pinned}\n`);
    expect(release).toContain(`node-version: ${pinned}\n`);
  });
  it("installs ripgrep and git, refuses native modules, and drops to the node user", () => {
    expect(dockerfile).toContain("apt-get install --yes --no-install-recommends ca-certificates git ripgrep");
    expect(dockerfile).toContain("test -z \"$(find /opt/brain/current -name '*.node' -print -quit)\"");
    expect(dockerfile).toContain("test -f /opt/brain/current/release.json");
    expect(dockerfile).toContain("USER node\n");
    expect(dockerfile).toContain('ENTRYPOINT ["/opt/brain/bin/brain-entrypoint.sh"]\n');
    expect(dockerfile).toContain('CMD ["web"]\n');
    expect(entrypoint).toContain("exec node /opt/brain/current/server.js");
    expect(entrypoint).toContain("exec node /opt/brain/bin/brain-mail-activate.mjs");
  });
  it("runs web and mail as two services of one image sharing the socket volume", () => {
    expect(compose.match(/image: \$\{BRAIN_SMOKE_IMAGE:\?set BRAIN_SMOKE_IMAGE\}/g)).toHaveLength(2);
    expect(compose).toContain('command: ["web"]');
    expect(compose).toContain('command: ["mail"]');
    expect(compose.match(/- mail-socket:\/run\/brain-mail/g)).toHaveLength(2);
    expect(compose.match(/init: true/g)).toHaveLength(2);
    expect(compose).not.toMatch(/restart:/);
  });
});
