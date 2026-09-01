import { lookup } from "node:dns/promises";
import { Buffer } from "node:buffer";

// Shared SSRF guard for every route that fetches a user-influenced URL from
// the Next app (unfurl previews, sender favicons). Extracted verbatim from
// app/api/unfurl/route.ts so the audit-hardened branches (including the
// 2026-08-19 IPv4-mapped IPv6 fix) have exactly one home and future fixes
// cannot fork between callers.

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export function isPrivateIPv4(host: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;

  const parts = host.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIPv6(host: string) {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  // IPv4-mapped addresses (::ffff:a.b.c.d) — the URL parser normalizes the
  // dotted tail to hex (::ffff:7f00:1), so match both forms and reduce to the
  // embedded IPv4. Without the hex branch a mapped loopback slips the literal
  // check and reaches DNS resolution (audit 2026-08-19).
  const mappedDotted = value.match(/(?:^|:)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
  const mappedHex = value.match(/(?:^|:)ffff:([\da-f]{1,4}):([\da-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isPrivateIPv4(dotted);
  }

  return (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe80:")
  );
}

export function isBlockedHost(hostname: string) {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!host.includes(".") && !host.includes(":")) return true;
  if (isPrivateIPv4(host)) return true;
  if (host.includes(":") && isPrivateIPv6(host)) return true;
  return false;
}

/** Resolve the hostname and reject if ANY address is private/loopback. Closes
 *  DNS-rebinding: a public-looking name whose A/AAAA record points at internal
 *  infrastructure passes the string check in isBlockedHost but must not be
 *  fetched. (Small TOCTOU window remains; acceptable for a single-user,
 *  auth-gated tool.) */
export async function hostResolvesPrivate(hostname: string): Promise<boolean> {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (isPrivateIPv4(host) || (host.includes(":") && isPrivateIPv6(host))) return true;
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) =>
      a.family === 6 ? isPrivateIPv6(a.address) : isPrivateIPv4(a.address),
    );
  } catch {
    return true; // unresolvable → don't fetch
  }
}

export function safeHttpUrl(rawUrl: string, base?: string) {
  try {
    const url = base ? new URL(rawUrl, base) : new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (isBlockedHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

/** Binary sibling of the unfurl route's readCappedHtml. Reads at most
 *  maxBytes + 1 bytes and stops — the extra byte lets a caller detect an
 *  over-cap stream (`result.byteLength > maxBytes`) without buffering an
 *  unbounded body. Callers that must not serve truncated bytes treat the
 *  over-cap signal as a failure. */
export async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);

  const reader = res.body.getReader();
  const limit = maxBytes + 1;
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = limit - received;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      received += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks);
}
