#!/usr/bin/env node
// The on-disk stores a release must stay upgradable from, and the fixture
// tree that proves it. Fixtures live under test/data-versions/<version>/;
// until the first release cuts a fixture, the directory is absent and the
// minimum upgradable version is the release itself.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { compareSemver, parseSemver, resolveMinUpgradeFrom } from "./release-version.mjs";

export const FIXTURE_ROOT = "test/data-versions";
export const VERSIONED_STORES = Object.freeze([
  "account-store", "message-cache", "content-cache", "outbound-store", "token-envelope", "oauth-state",
]);

export async function listFixtureVersions(root = process.cwd()) {
  let entries;
  try {
    entries = await readdir(path.join(root, FIXTURE_ROOT), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => { try { parseSemver(name); return true; } catch { return false; } })
    .sort(compareSemver);
}

async function main() {
  const [command, version] = process.argv.slice(2);
  if (command === "min-upgrade-from" && version) {
    process.stdout.write(`${resolveMinUpgradeFrom(version, await listFixtureVersions())}\n`);
    return;
  }
  throw new Error("usage: data-versions.mjs min-upgrade-from <version>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
