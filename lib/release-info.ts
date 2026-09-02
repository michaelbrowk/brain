// The running release. scripts/build-release.mjs writes release.json at the
// stage root, which is the app root at runtime (/opt/brain/current is both the
// Docker WORKDIR and the deploy symlink), so the file is cwd-relative. The dev
// server has no release: version stays null and the build sha from
// next.config's env carries the commit.

import fs from "node:fs/promises";
import path from "node:path";

export interface ReleaseInfo {
  version: string | null;
  commit: string;
  buildTime: string | null;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[0-9a-f]{40}$/;

function fromEnv(): ReleaseInfo {
  return {
    version: null,
    commit: process.env.BRAIN_BUILD_SHA ?? "unknown",
    buildTime: process.env.BRAIN_BUILD_TIME ?? null,
  };
}

function parse(text: string): ReleaseInfo | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.schema !== 1) return null;
  if (typeof r.version !== "string" || !SEMVER.test(r.version)) return null;
  if (typeof r.commit !== "string" || !SHA.test(r.commit)) return null;
  if (typeof r.buildTime !== "string" || Number.isNaN(Date.parse(r.buildTime))) return null;
  return { version: r.version, commit: r.commit, buildTime: r.buildTime };
}

async function read(file: string): Promise<ReleaseInfo> {
  try {
    return parse(await fs.readFile(file, "utf8")) ?? fromEnv();
  } catch {
    return fromEnv();
  }
}

let cached: Promise<ReleaseInfo> | null = null;

export function readReleaseInfo(file?: string): Promise<ReleaseInfo> {
  if (file) return read(file);
  cached ??= read(path.join(process.cwd(), "release.json"));
  return cached;
}
