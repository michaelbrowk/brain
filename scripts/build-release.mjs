#!/usr/bin/env node
// The one packer for both workflows. Behaviour is the inline "Package Linux
// x64 standalone" step of .github/workflows/ci.yml as of 1de08de, moved here
// so the push workflow and the tag workflow cannot drift apart.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { listFixtureVersions } from "./data-versions.mjs";
import { parseSemver, resolveMinUpgradeFrom } from "./release-version.mjs";

const execFileAsync = promisify(execFile);

export const LEGACY_ARCHIVE_NAME = "brain-standalone-linux-x64.tar.gz";
export const LEGACY_MANIFEST_NAME = "brain-standalone-linux-x64.json";

/** brain-mail-ops payload: [repository source, staged name, mode]. */
export const MAIL_OPS_FILES = Object.freeze(
  /** @type {ReadonlyArray<[source: string, stagedName: string, mode: number]>} */ ([
  ["ops/brain-mail.service", "brain-mail.service", 0o644],
  ["ops/brain-mail.socket", "brain-mail.socket", 0o644],
  ["ops/brain-mail-mime.socket", "brain-mail-mime.socket", 0o644],
  ["ops/brain-mail-mime@.service", "brain-mail-mime@.service", 0o644],
  ["ops/brain-mail.sysusers.conf", "brain-mail.sysusers.conf", 0o644],
  ["ops/brain-mail-mime.sysusers.conf", "brain-mail-mime.sysusers.conf", 0o644],
  ["ops/brain-mail.tmpfiles.conf", "brain-mail.tmpfiles.conf", 0o644],
  ["ops/brain-mail-mime.tmpfiles.conf", "brain-mail-mime.tmpfiles.conf", 0o644],
  ["ops/project_mail_runtime.py", "project_mail_runtime.py", 0o755],
  ["ops/create-brain-mail-key.sh", "create-brain-mail-key.sh", 0o755],
  ["ops/brain-mail-state-rollback.py", "brain-mail-state-rollback.py", 0o755],
  ["ops/install-brain-mail.sh", "install-brain-mail.sh", 0o755],
  ["ops/rollback-brain-mail-install.sh", "rollback-brain-mail-install.sh", 0o755],
  ["docs/mail-account-connect-operations.md", "mail-account-connect-operations.md", 0o644],
  ["docs/mail-egress-operations.md", "mail-egress-operations.md", 0o644],
  ["ops/brain.service.d/90-brain-mail-client.conf", "brain.service.d/90-brain-mail-client.conf", 0o644],
  ["ops/brain-mail.service.d/90-smtp-egress.conf.example", "brain-mail.service.d/90-smtp-egress.conf.example", 0o644],
]),
);

export function tarballName(version) {
  parseSemver(version);
  return `brain-${version}-linux-x64.tar.gz`;
}

/** ops/ payload of a release: [repository source, staged name, mode]. */
export const RELEASE_OPS_FILES = Object.freeze(
  /** @type {ReadonlyArray<[source: string, stagedName: string, mode: number]>} */ ([
  ["ops/backup-notes.sh", "bin/backup-notes.sh", 0o755],
  ["ops/verify-notes-backup.py", "bin/verify-notes-backup.py", 0o755],
  ["ops/brain-alert.sh", "bin/brain-alert.sh", 0o755],
  ["ops/deploy-puller.sh", "bin/deploy-puller.sh", 0o755],
  ["ops/resolve-deploy-candidate.mjs", "bin/resolve-deploy-candidate.mjs", 0o755],
  ["ops/deploy-provenance.mjs", "bin/deploy-provenance.mjs", 0o644],
  ["ops/deploy-transaction.mjs", "bin/deploy-transaction.mjs", 0o755],
  ["ops/read-mail-health-commit.mjs", "bin/read-mail-health-commit.mjs", 0o644],
  ["ops/extract_release.py", "bin/extract_release.py", 0o755],
  ["scripts/write-release-metadata.mjs", "bin/write-release-metadata.mjs", 0o644],
  ["ops/project_mail_runtime.py", "bin/project_mail_runtime.py", 0o755],
  ["ops/create-brain-mail-key.sh", "bin/create-brain-mail-key.sh", 0o755],
  ["ops/brain-mail-state-rollback.py", "bin/brain-mail-state-rollback.py", 0o755],
  ["ops/install-brain-mail.sh", "bin/install-brain-mail.sh", 0o755],
  ["ops/rollback-brain-mail-install.sh", "bin/rollback-brain-mail-install.sh", 0o755],
  ["ops/install-deploy-puller.sh", "bin/install-deploy-puller.sh", 0o755],
  ["ops/install-node-runtime.sh", "bin/install-node-runtime.sh", 0o755],
  ["ops/brain.service", "systemd/brain.service", 0o644],
  ["ops/brain.service.d/90-brain-mail-client.conf", "systemd/brain.service.d/90-brain-mail-client.conf", 0o644],
  ["ops/brain-mail.service", "systemd/brain-mail.service", 0o644],
  ["ops/brain-mail.service.d/90-smtp-egress.conf.example", "systemd/brain-mail.service.d/90-smtp-egress.conf.example", 0o644],
  ["ops/brain-mail.socket", "systemd/brain-mail.socket", 0o644],
  ["ops/brain-mail-mime.socket", "systemd/brain-mail-mime.socket", 0o644],
  ["ops/brain-mail-mime@.service", "systemd/brain-mail-mime@.service", 0o644],
  ["ops/brain-backup.service", "systemd/brain-backup.service", 0o644],
  ["ops/brain-backup.timer", "systemd/brain-backup.timer", 0o644],
  ["ops/brain-deploy-puller.service", "systemd/brain-deploy-puller.service", 0o644],
  ["ops/brain-deploy-puller.timer", "systemd/brain-deploy-puller.timer", 0o644],
  ["ops/brain-alert@.service", "systemd/brain-alert@.service", 0o644],
  ["ops/brain-mail.sysusers.conf", "sysusers.d/brain-mail.conf", 0o644],
  ["ops/brain-mail-mime.sysusers.conf", "sysusers.d/brain-mail-mime.conf", 0o644],
  ["ops/brain-mail.tmpfiles.conf", "tmpfiles.d/brain-mail.conf", 0o644],
  ["ops/brain-mail-mime.tmpfiles.conf", "tmpfiles.d/brain-mail-mime.conf", 0o644],
  ["ops/nginx/brain.conf.example", "nginx/brain.conf.example", 0o644],
  ["ops/nginx/brain-edge-secret.conf.example", "nginx/brain-edge-secret.conf.example", 0o644],
  ["ops/nginx/brain-cloudflare-ips.conf.example", "nginx/brain-cloudflare-ips.conf.example", 0o644],
]),
);

/** Tracked ops/ sources that deliberately stay out of the tarball's ops/. */
export const RELEASE_OPS_EXCLUDED = Object.freeze([
  "ops/brain-server.cjs",           // staged as server.js
  "ops/brain-shutdown-preload.mjs", // staged at the release root
  "ops/docker/",                    // image-only
]);

/** Exact listings (`name|f` / `name|d`) of the packaged Mail runtime. */
export const MAIL_RUNTIME_LISTING = Object.freeze({
  ".": [
    "THIRD_PARTY_NOTICES.txt|f", "address-identity.js|f", "build.json|f",
    "cloudflare-egress-client.js|f", "content-codec.js|f", "content-types.js|f",
    "draft-codec.js|f", "draft-types.js|f", "message-codec.js|f", "search-query.js|f",
    "message-types.js|f", "ports.js|f", "reader-content.js|f", "providers|d",
    "raster-metadata.js|f", "recipients.js|f", "security.js|f", "send-state.js|f",
    "thread-contract.js|f", "service|d",
  ],
  providers: ["gmail|d", "imap|d"],
  "providers/gmail": [
    "access-token-port.js|f", "api-client.js|f", "api-types.js|f",
    "content-source-adapter.js|f", "contract.js|f", "credentials.js|f", "oauth.js|f",
    "raw-message-stream.js|f", "send-adapter.js|f", "service-adapter.js|f",
    "sync-adapter.js|f", "token-envelope.js|f",
  ],
  "providers/imap": ["sync-adapter.js|f"],
  service: [
    "account-store.js|f", "account-types.js|f", "accounts.js|f", "admission.js|f",
    "background-sync.js|f", "content-blob-store.js|f", "content-cache.js|f",
    "content-coordinator.js|f", "content-source.js|f", "content-work-runner.js|f",
    "dns.js|f", "drafts.js|f", "http.js|f", "imapflow-adapter.js|f", "limits.js|f",
    "mail-html-sanitizer.js|f", "main.js|f", "message-cache.js|f",
    "message-service-registry.js|f", "message-service.js|f", "mime-parser-client.js|f",
    "mime-parser-runtime.js|f", "mime-parser-worker.js|f", "mime-protocol.js|f",
    "outbound-message.js|f", "outbound-store.js|f", "outbound-worker.js|f",
    "outbound.js|f", "remote-image-fetcher.js|f", "runtime-config.js|f",
    "smtp-runtime.js|f", "smtp-state-store.js|f",
  ],
});

async function listing(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .map((entry) => `${entry.name}|${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"}`)
    .sort();
}

export async function stageFileSet({ root, destination, files }) {
  await mkdir(destination, { recursive: true });
  const lines = [];
  for (const [source, name, mode] of files) {
    const target = path.join(destination, name);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, source), target);
    await chmod(target, mode);
    lines.push(`${createHash("sha256").update(await readFile(target)).digest("hex")}  ${name}`);
  }
  await writeFile(path.join(destination, "MANIFEST.sha256"), `${lines.join("\n")}\n`);
  await chmod(path.join(destination, "MANIFEST.sha256"), 0o644);
}

export async function verifyManifest(directory) {
  const manifest = await readFile(path.join(directory, "MANIFEST.sha256"), "utf8");
  for (const line of manifest.trimEnd().split("\n")) {
    const match = /^([0-9a-f]{64})  (\S.*)$/.exec(line);
    if (!match) throw new Error(`malformed manifest line in ${directory}: ${line}`);
    const actual = createHash("sha256").update(await readFile(path.join(directory, match[2]))).digest("hex");
    if (actual !== match[1]) throw new Error(`manifest mismatch for ${match[2]} in ${directory}`);
  }
}

export async function stageStandalone({ root, stage }) {
  const standalone = path.join(root, ".next", "standalone");
  await mkdir(path.join(stage, ".next"), { recursive: true });
  // cp -R keeps relative symlink text verbatim; the extractor rejects absolute links.
  await execFileAsync("cp", ["-R", `${standalone}/.`, `${stage}/`]);
  await rm(path.join(stage, ".next", "static"), { recursive: true, force: true });
  await rm(path.join(stage, "public"), { recursive: true, force: true });
  await mkdir(path.join(stage, ".next", "static"), { recursive: true });
  await mkdir(path.join(stage, "public"), { recursive: true });
  await execFileAsync("cp", ["-R", `${path.join(root, ".next", "static")}/.`, `${path.join(stage, ".next", "static")}/`]);
  await execFileAsync("cp", ["-R", `${path.join(root, "public")}/.`, `${path.join(stage, "public")}/`]);
  try {
    await access(path.join(stage, "brain-next-server.js"));
  } catch {
    await rename(path.join(stage, "server.js"), path.join(stage, "brain-next-server.js"));
  }
  await cp(path.join(root, "ops", "brain-server.cjs"), path.join(stage, "server.js"));
  await cp(path.join(root, "ops", "brain-shutdown-preload.mjs"), path.join(stage, "brain-shutdown-preload.mjs"));
  await stageFileSet({ root, destination: path.join(stage, "brain-mail-ops"), files: MAIL_OPS_FILES });
}

export async function verifyStage(stage, { layout = "legacy" } = {}) {
  for (const required of ["server.js", "brain-next-server.js", "brain-shutdown-preload.mjs", "brain-mail-ops/project_mail_runtime.py"]) {
    if (!(await stat(path.join(stage, required))).isFile()) throw new Error(`${required} is not a regular file`);
  }
  for (const [relative, expected] of Object.entries(MAIL_RUNTIME_LISTING)) {
    const actual = await listing(path.join(stage, "mail-service", relative));
    if (actual.join("\n") !== [...expected].sort().join("\n")) {
      throw new Error(`mail-service/${relative} listing differs:\n${actual.join("\n")}`);
    }
  }
  await verifyManifest(path.join(stage, "brain-mail-ops"));
  if (layout === "release") {
    await verifyManifest(path.join(stage, "ops"));
    const release = JSON.parse(await readFile(path.join(stage, "release.json"), "utf8"));
    if (release.schema !== 1 || !/^[0-9a-f]{40}$/.test(release.commit) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(release.buildTime)) {
      throw new Error("release.json is invalid");
    }
    parseSemver(release.version);
    parseSemver(release.minUpgradeFrom);
    // The image is built for two architectures from this one stage, so a
    // per-architecture native module here is a broken image on the other one.
    const natives = (await execFileAsync("find", [stage, "-name", "*.node"])).stdout.trim();
    if (natives) throw new Error(`release stage carries native modules:\n${natives}`);
    const staleLinks = [];
    for (const link of (await execFileAsync("find", [stage, "-type", "l"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean)) {
      await stat(link).catch((error) => {
        if (error?.code === "ENOENT") {
          staleLinks.push(link);
          return;
        }
        throw error;
      });
    }
    if (staleLinks.length > 0) {
      throw new Error(`release stage carries dangling symlinks:\n${staleLinks.join("\n")}`);
    }
  }
}

export async function packTarball({ stage, destination }) {
  await execFileAsync("tar", ["-C", stage, "-czf", destination, "."]);
}

export async function buildLegacyArtifact({ root, stage, out, commit, builtAt }) {
  await stageStandalone({ root, stage });
  await verifyStage(stage);
  await mkdir(out, { recursive: true });
  const archive = path.join(out, LEGACY_ARCHIVE_NAME);
  const manifest = path.join(out, LEGACY_MANIFEST_NAME);
  await packTarball({ stage, destination: archive });
  await execFileAsync(process.execPath, [path.join(root, "scripts", "write-artifact-manifest.mjs"), archive, manifest, commit, builtAt]);
  return { archive, manifest };
}

export async function writeReleaseJson({ stage, version, commit, buildTime, minUpgradeFrom }) {
  parseSemver(version);
  parseSemver(minUpgradeFrom);
  await writeFile(
    path.join(stage, "release.json"),
    `${JSON.stringify({ schema: 1, version, commit, buildTime, minUpgradeFrom }, null, 2)}\n`,
  );
  await chmod(path.join(stage, "release.json"), 0o644);
}

export async function writeChecksums({ out, names }) {
  const lines = [];
  for (const name of names) {
    lines.push(`${createHash("sha256").update(await readFile(path.join(out, name))).digest("hex")}  ${name}`);
  }
  const destination = path.join(out, "SHA256SUMS");
  await writeFile(destination, `${lines.join("\n")}\n`);
  return destination;
}

/** Next traces an installed sharp into the standalone output, and sharp is a
 * per-architecture native module. Nothing in Brain imports it at runtime (no
 * page uses next/image), so the release stage — the one stage both the
 * two-architecture image and the tarball are built from — drops it. The
 * legacy artifact is left exactly as it always shipped. */
export async function pruneNativeModules(stage) {
  const modules = path.join(stage, "node_modules");
  const doomed = [path.join(modules, "sharp"), path.join(modules, "@img")];
  const store = path.join(modules, ".pnpm");
  const missingIsEmpty = (error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  };
  for (const entry of (await readdir(store).catch(missingIsEmpty))) {
    if (entry.startsWith("sharp@") || entry.startsWith("@img+")) {
      doomed.push(path.join(store, entry));
    }
  }
  // pnpm gives every consumer a private symlink into the store
  // (.pnpm/<pkg>/node_modules/sharp -> ../../sharp@…): next and miniflare
  // both carry one. Deleting only the store entries would strand those
  // links dangling in the shipped stage, so each consumer scope is swept too.
  for (const entry of (await readdir(store).catch(missingIsEmpty))) {
    for (const name of ["sharp", "@img"]) {
      doomed.push(path.join(store, entry, "node_modules", name));
    }
  }
  for (const target of doomed) {
    await rm(target, { recursive: true, force: true });
  }
  // pnpm also links packages from hidden scopes the entry sweeps above cannot
  // name (.pnpm/node_modules/@img/… among them), so the last word is shape-
  // independent: any symlink left pointing at a pruned target is garbage in a
  // self-contained stage and gets removed wherever it lives.
  const links = (await execFileAsync("find", [modules, "-type", "l"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const link of links) {
    await stat(link).catch((error) => {
      if (error?.code === "ENOENT") return rm(link, { force: true });
      throw error;
    });
  }
}

export async function buildReleaseArtifact({ root, stage, out, version, commit, builtAt, fixtureVersions }) {
  await stageStandalone({ root, stage });
  await pruneNativeModules(stage);
  await stageFileSet({ root, destination: path.join(stage, "ops"), files: RELEASE_OPS_FILES });
  await writeReleaseJson({
    stage, version, commit, buildTime: builtAt,
    minUpgradeFrom: resolveMinUpgradeFrom(version, fixtureVersions),
  });
  await verifyStage(stage, { layout: "release" });
  await mkdir(out, { recursive: true });
  const archive = path.join(out, tarballName(version));
  await packTarball({ stage, destination: archive });
  const checksums = await writeChecksums({ out, names: [tarballName(version)] });
  return { archive, checksums };
}

export function parseArguments(argv) {
  const options = { layout: "legacy" };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--layout") options.layout = value;
    else if (key === "--out") options.out = value;
    else if (key === "--stage") options.stage = value;
    else if (key === "--commit") options.commit = value;
    else if (key === "--built-at") options.builtAt = value;
    else if (key === "--version") options.version = value;
    else throw new Error(`unknown option ${key}`);
  }
  if (!options.out) throw new Error("--out is required");
  if (!/^[0-9a-f]{40}$/.test(options.commit ?? "")) throw new Error("--commit must be a 40-character commit");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(options.builtAt ?? "")) throw new Error("--built-at must be YYYY-MM-DDTHH:MM:SSZ");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (`${process.platform}-${process.arch}` !== "linux-x64") throw new Error("release packaging runs on Linux x64 only");
  const root = process.cwd();
  const stage = options.stage ?? (await mkdtemp(path.join(tmpdir(), "brain-release-stage-")));
  if (options.layout === "legacy") {
    const { archive } = await buildLegacyArtifact({ root, stage, out: options.out, commit: options.commit, builtAt: options.builtAt });
    process.stdout.write(`${archive}\n`);
    return;
  }
  if (options.layout === "release") {
    if (!options.version) throw new Error("--version is required for the release layout");
    const { archive } = await buildReleaseArtifact({
      root, stage, out: options.out, version: options.version, commit: options.commit, builtAt: options.builtAt,
      fixtureVersions: await listFixtureVersions(root),
    });
    process.stdout.write(`${archive}\n`);
    return;
  }
  throw new Error(`unknown layout ${options.layout}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`release packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
