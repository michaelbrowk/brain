#!/usr/bin/env node
// Strict semver for Brain releases: parsing, ordering, image tags, and the
// minimum upgradable version. No build metadata, no leading "v".
import { pathToFileURL } from "node:url";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export function parseSemver(value) {
  const match = typeof value === "string" ? SEMVER_RE.exec(value) : null;
  if (!match) throw new Error(`invalid release version: ${JSON.stringify(value)}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split(".") : [] };
}

export function isPrerelease(version) {
  return parseSemver(version).prerelease.length > 0;
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function imageTags(repository, version) {
  const parsed = parseSemver(version);
  if (parsed.prerelease.length > 0) return [`${repository}:${version}`];
  return [`${repository}:${version}`, `${repository}:${parsed.major}.${parsed.minor}`, `${repository}:latest`];
}

export function resolveMinUpgradeFrom(version, fixtureVersions) {
  parseSemver(version);
  const eligible = fixtureVersions.filter((candidate) => compareSemver(candidate, version) <= 0).sort(compareSemver);
  return eligible[0] ?? version;
}

function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === "assert" && first && !second) { parseSemver(first); return; }
  if (command === "prerelease" && first && !second) { process.stdout.write(`${isPrerelease(first)}\n`); return; }
  if (command === "image-tags" && first && second) { process.stdout.write(`${imageTags(first, second).join(",")}\n`); return; }
  throw new Error("usage: release-version.mjs assert <version> | prerelease <version> | image-tags <repository> <version>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
