import { gzipSync, gunzipSync } from "node:zlib";

export const MAX_PORTABLE_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_PORTABLE_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_PORTABLE_FILES = 6_000;
const TAR_BLOCK_BYTES = 512;

export interface PortableArchiveEntry {
  path: string;
  data: Uint8Array;
}

function safeArchivePath(value: string): boolean {
  return (
    value === "manifest.json" ||
    /^pages\/p\d{6}\.md$/.test(value) ||
    /^assets\/[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,31})?$/.test(
      value,
    )
  );
}

function writeText(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error(`archive path is too long: ${value}`);
  bytes.copy(target, offset);
}

function writeOctal(
  target: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("archive contains an invalid integer");
  }
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length > length) throw new Error("archive integer is too large");
  target.write(encoded, offset, length, "ascii");
}

function readText(source: Buffer, offset: number, length: number): string {
  const end = source.indexOf(0, offset);
  return source
    .subarray(offset, end >= offset && end < offset + length ? end : offset + length)
    .toString("utf8");
}

function readOctal(source: Buffer, offset: number, length: number): number {
  const raw = source
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!/^[0-7]+$/.test(raw)) throw new Error("archive has an invalid tar number");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw new Error("archive tar number is too large");
  return value;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  return sum;
}

export function createPortableArchive(
  entries: PortableArchiveEntry[],
): Uint8Array {
  if (entries.length === 0 || entries.length > MAX_PORTABLE_FILES) {
    throw new Error("portable archive has an invalid file count");
  }
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  let unpackedBytes = 0;
  for (const entry of entries) {
    if (!safeArchivePath(entry.path) || seen.has(entry.path)) {
      throw new Error(`portable archive has an invalid path: ${entry.path}`);
    }
    seen.add(entry.path);
    const data = Buffer.from(entry.data);
    unpackedBytes += data.byteLength;
    if (unpackedBytes > MAX_PORTABLE_UNPACKED_BYTES) {
      throw new Error("portable archive is too large");
    }
    const header = Buffer.alloc(TAR_BLOCK_BYTES);
    writeText(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeText(header, 257, 6, "ustar");
    writeText(header, 263, 2, "00");
    writeText(header, 265, 32, "brain");
    writeText(header, 297, 32, "brain");
    const checksum = headerChecksum(header).toString(8).padStart(6, "0");
    header.write(`${checksum}\0 `, 148, 8, "ascii");
    chunks.push(header, data);
    const padding =
      (TAR_BLOCK_BYTES - (data.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 6 });
  if (compressed.byteLength > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw new Error("portable archive is too large");
  }
  return compressed;
}

export function readPortableArchive(
  input: Uint8Array,
): Map<string, Uint8Array> {
  if (input.byteLength === 0 || input.byteLength > MAX_PORTABLE_ARCHIVE_BYTES) {
    throw new Error("portable archive is empty or too large");
  }
  let archive: Buffer;
  try {
    archive = gunzipSync(input, {
      maxOutputLength: MAX_PORTABLE_UNPACKED_BYTES,
    });
  } catch {
    throw new Error("portable archive is not a valid gzip file");
  }
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + TAR_BLOCK_BYTES <= archive.byteLength) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) break;
    if (entries.size >= MAX_PORTABLE_FILES) {
      throw new Error("portable archive has too many files");
    }
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const type = String.fromCharCode(header[156] || "0".charCodeAt(0));
    if (
      !safeArchivePath(name) ||
      prefix ||
      (type !== "0" && type !== "\0") ||
      entries.has(name)
    ) {
      throw new Error(`portable archive has an unsafe entry: ${name || "unknown"}`);
    }
    const storedChecksum = readOctal(header, 148, 8);
    if (storedChecksum !== headerChecksum(header)) {
      throw new Error(`portable archive header checksum failed: ${name}`);
    }
    const size = readOctal(header, 124, 12);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.byteLength) {
      throw new Error(`portable archive entry is truncated: ${name}`);
    }
    entries.set(name, new Uint8Array(archive.subarray(dataStart, dataEnd)));
    offset =
      dataStart +
      size +
      ((TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);
  }
  if (!entries.has("manifest.json")) {
    throw new Error("portable archive is missing manifest.json");
  }
  return entries;
}
