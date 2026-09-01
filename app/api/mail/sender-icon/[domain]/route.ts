import { Buffer } from "node:buffer";
import { inspectMailRaster } from "@/lib/mail/raster-metadata";
import {
  hostResolvesPrivate,
  isBlockedHost,
  readCappedBytes,
  safeHttpUrl,
  USER_AGENT,
} from "@/lib/unfurl-guard";
import {
  readCachedIcon,
  sweepIcons,
  writeIcon,
  writeMiss,
} from "@/lib/sender-icon-store";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ domain: string }> };

// Server-side favicon proxy for mail sender domains. This is the one
// deliberate, owner-approved egress exception in the mail surface: the Next
// app (never the mail service) resolves DNS and opens TLS to the sender's own
// origin to fetch /favicon.ico. Sender DOMAINS are the only data that leaves;
// message content, addresses, and subjects never do. Auth: proxy.ts session
// gate — this path is in no public allowlist. The browser only ever sees the
// same-origin proxy URL.

const MAX_DOMAIN_LENGTH = 253;
const MAX_ICON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
// Anything under 2px on an edge is a tracking pixel or a blank placeholder,
// never a logo. Only a positively read header rejects; ICO and unreadable
// containers pass through and the client-side size check still applies.
const MIN_ICON_EDGE = 2;
const POSITIVE_CACHE_CONTROL = "private, max-age=31536000, immutable";
const NEGATIVE_CACHE_CONTROL = "private, max-age=86400";

// LDH label (RFC 1035 syntax, letters-digits-hyphen, no leading/trailing
// hyphen, ≤ 63 chars). The final label must additionally start with a letter
// (covers xn-- punycode), which rejects all-numeric TLDs and therefore every
// dotted-decimal IPv4 literal.
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FINAL_LABEL = /^[a-z][a-z0-9-]*$/;

/** Normalize and validate a sender domain. The returned value is safe as a
 *  cache key and never contains a path or IP literal. */
function normalizeDomain(raw: string): string | null {
  if (!raw || raw.length > MAX_DOMAIN_LENGTH) return null;
  const domain = raw.toLowerCase().replace(/\.$/, "");
  // IPv6 literals (and any port-like syntax) are rejected outright.
  if (domain.includes(":") || domain.includes("[")) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LDH_LABEL.test(label))) return null;
  const finalLabel = labels[labels.length - 1];
  if (!FINAL_LABEL.test(finalLabel) && !finalLabel.startsWith("xn--")) return null;
  return domain;
}

type IconResult =
  | { readonly kind: "icon"; readonly bytes: Buffer; readonly contentType: string }
  | { readonly kind: "miss" };

/** Sniff the served bytes by magic numbers only — the sender's Content-Type
 *  header is ignored entirely. SVG (active content) and everything unknown
 *  fall through to null, which the pipeline treats as a negative result. */
function sniffIconContentType(bytes: Buffer): string | null {
  if (bytes.byteLength >= 4 && bytes.readUInt32BE(0) === 0x00000100) {
    return "image/x-icon";
  }
  if (
    bytes.byteLength >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    bytes.byteLength >= 6 &&
    (bytes.subarray(0, 6).equals(Buffer.from("GIF87a", "ascii")) ||
      bytes.subarray(0, 6).equals(Buffer.from("GIF89a", "ascii")))
  ) {
    return "image/gif";
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).equals(Buffer.from("RIFF", "ascii")) &&
    bytes.subarray(8, 12).equals(Buffer.from("WEBP", "ascii"))
  ) {
    return "image/webp";
  }
  return null;
}

/** Fetch https://<domain>/favicon.ico with ≤ 3 redirect hops, each hop
 *  re-vetted (safeHttpUrl + https-only — stricter than unfurl, no downgrade —
 *  + DNS resolve check) and a 5 s per-attempt timeout. Returns null on any
 *  failure; the caller records a negative. */
async function fetchIconBytes(
  domain: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  let current = new URL(`https://${domain}/favicon.ico`);

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "image/*",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return null;
      const next = safeHttpUrl(location, current.toString());
      if (!next || next.protocol !== "https:") return null;
      if (await hostResolvesPrivate(next.hostname)) return null;
      current = next;
      continue;
    }

    if (!res.ok) return null;

    const bytes = await readCappedBytes(res, MAX_ICON_BYTES);
    // Over the cap → negative. Truncated bytes are never stored or served.
    if (bytes.byteLength > MAX_ICON_BYTES) return null;
    const contentType = sniffIconContentType(bytes);
    if (!contentType) return null;
    const raster = inspectMailRaster(contentType, bytes);
    if (raster && (raster.width < MIN_ICON_EDGE || raster.height < MIN_ICON_EDGE)) {
      return null;
    }
    return { bytes, contentType };
  }

  return null; // too many redirects
}

async function resolveIcon(domain: string): Promise<IconResult> {
  try {
    if (await hostResolvesPrivate(domain)) {
      await writeMiss(domain);
      return { kind: "miss" };
    }

    const fetched = await fetchIconBytes(domain);
    if (!fetched) {
      await writeMiss(domain);
      return { kind: "miss" };
    }

    // Persist atomically, then opportunistically enforce the LRU cap. A disk
    // failure must not fail the request — the icon is cosmetic.
    try {
      await writeIcon(domain, fetched.bytes, fetched.contentType);
      await sweepIcons();
    } catch {
      // Serve the fresh bytes anyway; the next request retries the persist.
    }
    return { kind: "icon", bytes: fetched.bytes, contentType: fetched.contentType };
  } catch {
    await writeMiss(domain).catch(() => {});
    return { kind: "miss" };
  }
}

// Single-flight per domain: the app is one Node process (brain.service), so a
// module-level map is the whole story. Concurrent requests for one domain
// await the same fetch instead of racing the origin and the disk store.
const inflight = new Map<string, Promise<IconResult>>();

function iconResponse(bytes: Buffer, contentType: string): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": POSITIVE_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

function negativeResponse(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": NEGATIVE_CACHE_CONTROL },
  });
}

function invalidDomainResponse(): Response {
  return new Response(null, { status: 400 });
}

export async function GET(_request: Request, { params }: Context) {
  const { domain: rawParam } = await params;
  let raw: string;
  try {
    raw = decodeURIComponent(rawParam);
  } catch {
    return invalidDomainResponse();
  }

  const domain = normalizeDomain(raw);
  if (!domain) return invalidDomainResponse();
  // Belt-and-braces on top of the syntax check: localhost, single-label
  // hosts, and private literals never reach the cache or the network.
  if (isBlockedHost(domain)) return invalidDomainResponse();

  const cached = await readCachedIcon(domain);
  if (cached.kind === "icon") return iconResponse(cached.bytes, cached.contentType);
  if (cached.kind === "miss") return negativeResponse();

  let pending = inflight.get(domain);
  if (!pending) {
    pending = resolveIcon(domain).finally(() => {
      inflight.delete(domain);
    });
    inflight.set(domain, pending);
  }
  const result = await pending;

  if (result.kind === "icon") return iconResponse(result.bytes, result.contentType);
  return negativeResponse();
}
