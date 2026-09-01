import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

// Disk cache for the sender-favicon proxy. Deliberately NOT under the notes
// tree: /opt/brain/notes/_attachments is git-backed and swept by the
// referencedAttachmentNames GC, which would collect unreferenced icons and
// carry them into the notes' history and every clone of it. /var/lib/brain is writable by the Next app
// (brain.service ReadWritePaths) and is backup-exempt — the cache is fully
// reconstructible, so deleting the whole directory is always safe.

const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2048;

export function senderIconDirectory(): string {
  if (process.env.BRAIN_SENDER_ICON_DIR) {
    return process.env.BRAIN_SENDER_ICON_DIR;
  }
  if (process.env.NODE_ENV === "production") {
    return "/var/lib/brain/sender-icons";
  }
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-sender-icons-${process.getuid?.() ?? "dev"}`,
  );
}

// Layout (v1 namespace so a future format change gets a fresh directory):
//   <dir>/v1/<sha256(domain).hex>.icon  — validated bytes
//   <dir>/v1/<sha256(domain).hex>.json  — { v: 1, domain, contentType, bytes, fetchedAt }
//   <dir>/v1/<sha256(domain).hex>.miss  — { v: 1, domain, fetchedAt }
// Hashed filenames make the store immune to validator drift — no domain string
// ever becomes a path component; the sidecar JSON keeps it for debugging.

function storeDirectory(): string {
  return path.join(senderIconDirectory(), "v1");
}

function entryStem(domain: string): string {
  return createHash("sha256").update(domain).digest("hex");
}

type IconSidecar = {
  readonly v: 1;
  readonly domain: string;
  readonly contentType: string;
  readonly bytes: number;
  readonly fetchedAt: number;
};

type MissMarker = {
  readonly v: 1;
  readonly domain: string;
  readonly fetchedAt: number;
};

export type CachedSenderIcon =
  | { readonly kind: "icon"; readonly bytes: Buffer; readonly contentType: string }
  | { readonly kind: "miss" }
  | { readonly kind: "absent" };

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readCachedIcon(domain: string): Promise<CachedSenderIcon> {
  const stem = path.join(storeDirectory(), entryStem(domain));

  const sidecar = await readJsonFile<IconSidecar>(`${stem}.json`);
  if (sidecar && sidecar.v === 1 && typeof sidecar.contentType === "string") {
    try {
      const bytes = await fs.readFile(`${stem}.icon`);
      return { kind: "icon", bytes, contentType: sidecar.contentType };
    } catch {
      // Sidecar without bytes — treat as absent so the pipeline refetches.
    }
  }

  const miss = await readJsonFile<MissMarker>(`${stem}.miss`);
  if (
    miss &&
    miss.v === 1 &&
    typeof miss.fetchedAt === "number" &&
    Date.now() - miss.fetchedAt < MISS_TTL_MS
  ) {
    return { kind: "miss" };
  }

  return { kind: "absent" };
}

/** Write tmp + rename so a crash mid-write never leaves a partial file at a
 *  final path. The tmp file is unlinked on failure. */
async function writeFileAtomic(finalPath: string, data: Buffer | string): Promise<void> {
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, finalPath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function writeIcon(
  domain: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const directory = storeDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = path.join(directory, entryStem(domain));
  const sidecar: IconSidecar = {
    v: 1,
    domain,
    contentType,
    bytes: bytes.byteLength,
    fetchedAt: Date.now(),
  };
  // Bytes first, sidecar second: the reader keys on the sidecar, so it never
  // sees metadata pointing at bytes that are not on disk yet.
  await writeFileAtomic(`${stem}.icon`, bytes);
  await writeFileAtomic(`${stem}.json`, JSON.stringify(sidecar));
  await fs.unlink(`${stem}.miss`).catch(() => {});
}

export async function writeMiss(domain: string): Promise<void> {
  const directory = storeDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = path.join(directory, entryStem(domain));
  const marker: MissMarker = { v: 1, domain, fetchedAt: Date.now() };
  await writeFileAtomic(`${stem}.miss`, JSON.stringify(marker));
}

/** Opportunistic LRU cap: when the store holds more than maxEntries domains,
 *  delete the oldest entries (by newest file mtime per domain) down to the
 *  cap. Best-effort — a failed sweep never fails the caller's request. */
export async function sweepIcons(maxEntries = DEFAULT_MAX_ENTRIES): Promise<void> {
  const directory = storeDirectory();
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return;
  }

  const entries = new Map<string, { files: string[]; mtimeMs: number }>();
  for (const name of names) {
    const match = name.match(/^([0-9a-f]{64})\.(icon|json|miss)$/);
    if (!match) continue;
    const filePath = path.join(directory, name);
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    const entry = entries.get(match[1]) ?? { files: [], mtimeMs: 0 };
    entry.files.push(filePath);
    entry.mtimeMs = Math.max(entry.mtimeMs, mtimeMs);
    entries.set(match[1], entry);
  }

  if (entries.size <= maxEntries) return;

  const oldestFirst = [...entries.values()].sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of oldestFirst.slice(0, entries.size - maxEntries)) {
    for (const filePath of entry.files) {
      await fs.unlink(filePath).catch(() => {});
    }
  }
}
