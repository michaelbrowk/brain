import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { Stats } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MAX_NOTION_ASSET_BYTES,
  stableNotionAssetId,
  verifyPng,
  type ResolvedNotionAsset,
} from "./notion-assets.ts";

export interface LocalExportAssetSource {
  root: string;
  relativePath: string;
  name?: string;
}

export interface ResolveLocalExportAssetOptions {
  maxBytes?: number;
}

/** A private export path never enters the source snapshot. The logical URL is
 * an identity-only, non-fetchable Notion-shaped value whose path commits to a
 * digest of the normalized relative path. Generic planning can therefore use
 * the same stable asset ids as live captures without leaking a local path. */
export function localExportAssetIdentity(relativePath: string): {
  logicalUrl: string;
  sourceId: string;
} {
  const normalized = normalizeRelativePath(relativePath);
  const pathHash = createHash("sha256").update(normalized).digest("hex");
  const logicalUrl = `https://file.notion.so/f/brain-export/${pathHash}`;
  return { logicalUrl, sourceId: stableNotionAssetId(logicalUrl) };
}

/** Read one already-extracted Notion asset from an owned private tree. Every
 * path component is a real, owner-only directory; the file is opened with
 * O_NOFOLLOW and re-statted before its bytes become import input. */
export async function resolveLocalExportAsset(
  source: LocalExportAssetSource,
  options: ResolveLocalExportAssetOptions = {},
): Promise<ResolvedNotionAsset> {
  const maxBytes = options.maxBytes ?? MAX_NOTION_ASSET_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_NOTION_ASSET_BYTES
  ) {
    throw new Error("invalid local Notion asset byte limit");
  }
  if (!path.isAbsolute(source.root)) {
    throw new Error("local Notion asset root must be absolute");
  }
  const normalizedRelativePath = normalizeRelativePath(source.relativePath);
  const root = path.resolve(source.root);
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined) {
    throw new Error("local Notion asset owner cannot be verified");
  }

  const rootBefore = await fs.lstat(root);
  assertOwnedPrivateDirectory(rootBefore, effectiveUserId, "root", true);
  const canonicalRoot = await fs.realpath(root);

  const components = normalizedRelativePath.split("/");
  const directoryIdentities: Array<{
    path: string;
    dev: number;
    ino: number;
    uid: number;
    mode: number;
  }> = [];
  let current = canonicalRoot;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new Error("local Notion asset path cannot contain symlinks");
    }
    if (index < components.length - 1) {
      // Notion's ZIP extractor commonly creates 0755 descendants beneath an
      // owned 0700 extraction root. The root remains the privacy boundary;
      // descendants only need to be owner-controlled and not externally
      // writable to prevent path swaps.
      assertOwnedPrivateDirectory(stat, effectiveUserId, "directory", false);
      directoryIdentities.push({
        path: current,
        dev: stat.dev,
        ino: stat.ino,
        uid: stat.uid,
        mode: stat.mode & 0o777,
      });
    } else if (
      !stat.isFile() ||
      stat.uid !== effectiveUserId ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new Error("local Notion asset must be an owned private regular file");
    }
  }
  const candidate = current;
  const before = await fs.lstat(candidate);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.uid !== effectiveUserId ||
    (before.mode & 0o077) !== 0 ||
    before.nlink !== 1
  ) {
    throw new Error("local Notion asset must be an owned private regular file");
  }
  if (before.size > maxBytes) {
    throw new Error("local Notion asset exceeds byte limit");
  }

  const handle = await fs.open(
    candidate,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.uid !== effectiveUserId ||
      (opened.mode & 0o077) !== 0 ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > maxBytes
    ) {
      throw new Error("local Notion asset changed while opening");
    }
    const raw = await handle.readFile();
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (bytes.byteLength > maxBytes) {
      throw new Error("local Notion asset exceeds byte limit");
    }
    const [after, rootAfter, ...directoryAfters] = await Promise.all([
      handle.stat(),
      fs.lstat(root),
      ...directoryIdentities.map((identity) => fs.lstat(identity.path)),
    ]);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      rootAfter.dev !== rootBefore.dev ||
      rootAfter.ino !== rootBefore.ino ||
      rootAfter.uid !== rootBefore.uid ||
      (rootAfter.mode & 0o777) !== (rootBefore.mode & 0o777)
    ) {
      throw new Error("local Notion asset changed while reading");
    }
    directoryAfters.forEach((stat, index) => {
      const expected = directoryIdentities[index];
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        stat.uid !== expected.uid ||
        (stat.mode & 0o777) !== expected.mode
      ) {
        throw new Error("local Notion asset directory changed while reading");
      }
    });

    const name = safeDisplayName(source.name ?? path.basename(candidate));
    const mimeType = detectLocalExportMimeType(name, bytes);
    const { sourceId } = localExportAssetIdentity(normalizedRelativePath);
    return {
      sourceId,
      name,
      mimeType,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  } finally {
    await handle.close();
  }
}

export function detectLocalExportMimeType(
  name: string,
  bytes: Uint8Array,
): string {
  const extension = path.extname(name).toLowerCase();
  switch (extension) {
    case ".png":
      verifyPng(bytes);
      return "image/png";
    case ".jpg":
    case ".jpeg":
      if (
        bytes.byteLength < 4 ||
        bytes[0] !== 0xff ||
        bytes[1] !== 0xd8 ||
        bytes[2] !== 0xff ||
        bytes.at(-2) !== 0xff ||
        bytes.at(-1) !== 0xd9
      ) {
        throw new Error("invalid JPEG asset");
      }
      return "image/jpeg";
    case ".json": {
      const text = decodeSafeText(bytes, "JSON");
      try {
        JSON.parse(text);
      } catch {
        throw new Error("invalid JSON asset");
      }
      return "application/json";
    }
    default:
      throw new Error(`unsupported local Notion asset extension: ${extension || "none"}`);
  }
}

function normalizeRelativePath(input: string): string {
  if (
    !input ||
    input.includes("\\") ||
    input.includes("\0") ||
    path.posix.isAbsolute(input)
  ) {
    throw new Error("invalid local Notion asset relative path");
  }
  const normalized = path.posix.normalize(input);
  const components = normalized.split("/");
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    components.some((component) => !component || component === "." || component === "..")
  ) {
    throw new Error("invalid local Notion asset relative path");
  }
  return normalized;
}

function assertOwnedPrivateDirectory(
  stat: Stats,
  effectiveUserId: number,
  label: string,
  requirePrivate: boolean,
): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== effectiveUserId ||
    (requirePrivate ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0)
  ) {
    throw new Error(
      `local Notion asset ${label} must be an owned ${requirePrivate ? "private" : "controlled"} directory`,
    );
  }
}

function safeDisplayName(input: string): string {
  const name = input.split(/[\\/]/).at(-1)?.replace(/[\r\n]/g, " ").trim();
  if (
    !name ||
    name.length > 500 ||
    Buffer.byteLength(name, "utf8") > 1_000 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("invalid local Notion asset name");
  }
  return name;
}

function decodeSafeText(bytes: Uint8Array, label: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`invalid UTF-8 ${label} asset`);
  }
  if (text.includes("\0")) throw new Error(`invalid ${label} asset`);
  return text.replace(/^\uFEFF/, "");
}
