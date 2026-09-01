import { createHash } from "node:crypto";

export const MAX_NOTION_ASSET_BYTES = 25 * 1024 * 1024;
export const NOTION_ASSET_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/136.0.0.0 Safari/537.36";

const MAX_REDIRECTS = 3;
const ASSET_REQUEST_TIMEOUT_MS = 60_000;
const ALLOWED_ASSET_HOSTS: Readonly<Record<string, RegExp>> = {
  "file.notion.so": /^\/f\//,
  "www.notion.so": /^\/image\//,
  "prod-files-secure.s3.us-west-2.amazonaws.com": /^\//,
};

export interface NotionAssetSource {
  url: string;
  name: string;
}

export interface ResolvedNotionAsset {
  sourceId: string;
  name: string;
  mimeType: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface NotionAssetFetchOptions {
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

/** Signed query parameters rotate. Origin + decoded pathname is stable. */
export function stableNotionAssetId(input: string): string {
  const url = checkedNotionAssetUrl(input);
  const stable = `${url.origin}${decodeURIComponent(url.pathname)}`;
  return `asset_${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}

export function checkedNotionAssetUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid Notion asset URL");
  }
  const allowedPath = ALLOWED_ASSET_HOSTS[url.hostname];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !allowedPath ||
    !allowedPath.test(url.pathname)
  ) {
    throw new Error("Notion asset URL is outside the exact allowlist");
  }
  return url;
}

export async function fetchNotionPngAsset(
  source: NotionAssetSource,
  options: NotionAssetFetchOptions = {},
): Promise<ResolvedNotionAsset> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_NOTION_ASSET_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_NOTION_ASSET_BYTES) {
    throw new Error("invalid Notion asset byte limit");
  }
  let url = checkedNotionAssetUrl(source.url);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(ASSET_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "image/png,image/*;q=0.8,*/*;q=0.1",
        "User-Agent": NOTION_ASSET_USER_AGENT,
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirect === MAX_REDIRECTS) {
      throw new Error("Notion asset exceeded redirect limit");
    }
    const location = response.headers.get("location");
    if (!location) throw new Error("Notion asset redirect has no location");
    await response.body?.cancel();
    url = checkedNotionAssetUrl(new URL(location, url).toString());
  }
  if (!response?.ok) {
    throw new Error(`Notion asset request failed with status ${response?.status ?? 0}`);
  }
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "image/png") {
    throw new Error("Notion pilot asset is not image/png");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Notion asset exceeds 25 MiB");
  }
  if (!response.body) throw new Error("Notion asset response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("Notion asset exceeds byte limit");
      throw new Error("Notion asset exceeds 25 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  verifyPng(bytes);
  return {
    sourceId: stableNotionAssetId(source.url),
    name: safeAssetName(source.name),
    mimeType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}

export function verifyPng(bytes: Uint8Array): void {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < 45 ||
    !signature.every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error("invalid PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let first = true;
  let sawIdat = false;
  let sawIend = false;
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error("truncated PNG chunk");
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) throw new Error("truncated PNG payload");
    const typeBytes = bytes.slice(offset + 4, offset + 8);
    const type = new TextDecoder("ascii", { fatal: true }).decode(typeBytes);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    const expectedCrc = view.getUint32(offset + 8 + length);
    if (crc32(concatBytes(typeBytes, data)) !== expectedCrc) {
      throw new Error("invalid PNG chunk CRC");
    }
    if (first) {
      if (type !== "IHDR" || length !== 13) throw new Error("invalid PNG IHDR");
      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      if (
        width === 0 ||
        height === 0 ||
        width > 16_384 ||
        height > 16_384 ||
        width * height > 100_000_000
      ) {
        throw new Error("invalid PNG dimensions");
      }
      first = false;
    }
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      if (length !== 0 || end !== bytes.byteLength) {
        throw new Error("invalid PNG IEND");
      }
      sawIend = true;
    }
    offset = end;
  }
  if (!sawIdat || !sawIend) throw new Error("incomplete PNG");
}

function safeAssetName(input: string): string {
  const name = input.split(/[\\/]/).at(-1)?.replace(/[\r\n]/g, " ").trim();
  if (
    !name ||
    name.length > 500 ||
    Buffer.byteLength(name, "utf8") > 1000 ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("invalid Notion asset name");
  }
  return name;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
