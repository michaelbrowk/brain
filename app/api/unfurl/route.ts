import { NextRequest, NextResponse } from "next/server";
import { hostResolvesPrivate, safeHttpUrl, USER_AGENT } from "@/lib/unfurl-guard";

export const dynamic = "force-dynamic";

type UnfurlData = {
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  url: string;
};

const FETCH_TIMEOUT_MS = 6000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 200;
const MAX_REDIRECTS = 3;

const cache = new Map<string, UnfurlData>();

function remember(key: string, value: UnfurlData) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const first = cache.keys().next().value;
    if (!first) break;
    cache.delete(first);
  }
}

function decodeHtml(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return entities[key] ?? match;
  });
}

function cleanText(value?: string) {
  return decodeHtml(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hostnameLabel(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname || rawUrl;
  } catch {
    return rawUrl || "Link";
  }
}

// The SSRF guard chain (isPrivateIPv4/IPv6, isBlockedHost, hostResolvesPrivate,
// safeHttpUrl) lives in lib/unfurl-guard.ts, shared with the sender-icon proxy.

function fallback(rawUrl: string): UnfurlData {
  return { url: rawUrl, title: hostnameLabel(rawUrl) };
}

async function readCappedHtml(res: Response) {
  if (!res.body) return "";

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let html = "";

  try {
    while (received < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_BODY_BYTES - received;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      html += decoder.decode(chunk, { stream: true });
      received += chunk.byteLength;
      if (/<\/head>/i.test(html) || value.byteLength > remaining) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return html + decoder.decode();
}

function attrs(tag: string) {
  const out: Record<string, string> = {};
  const attrRe = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(tag))) {
    out[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function resolveAsset(rawValue: string | undefined, baseUrl: string) {
  const value = cleanText(rawValue);
  if (!value) return undefined;
  return safeHttpUrl(value, baseUrl)?.toString();
}

function parseHead(html: string, finalUrl: string): UnfurlData {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? html.slice(0, MAX_BODY_BYTES);
  const meta = new Map<string, string>();
  const links: Record<string, string> = {};

  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const key = (a.property || a.name || a.itemprop || "").toLowerCase();
    const content = cleanText(a.content);
    if (key && content && !meta.has(key)) meta.set(key, content);
  }

  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const rel = (a.rel ?? "").toLowerCase();
    const type = (a.type ?? "").toLowerCase();
    if (!a.href) continue;

    if (type === "application/json+oembed" && a.title && !links.oembedTitle) {
      links.oembedTitle = cleanText(a.title);
    }
    if (rel.includes("image_src") && !links.imageSrc) links.imageSrc = a.href;
    if ((rel.includes("icon") || rel.includes("apple-touch-icon")) && !links.favicon) {
      links.favicon = a.href;
    }
  }

  const titleTag = cleanText(head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const title =
    meta.get("og:title") ||
    meta.get("twitter:title") ||
    meta.get("title") ||
    links.oembedTitle ||
    titleTag ||
    hostnameLabel(finalUrl);
  const description =
    meta.get("og:description") || meta.get("twitter:description") || meta.get("description") || undefined;
  const image = resolveAsset(
    meta.get("og:image:secure_url") ||
      meta.get("og:image:url") ||
      meta.get("og:image") ||
      meta.get("twitter:image:src") ||
      meta.get("twitter:image") ||
      links.imageSrc,
    finalUrl,
  );
  const favicon = resolveAsset(links.favicon || "/favicon.ico", finalUrl);
  const siteName =
    meta.get("og:site_name") ||
    meta.get("application-name") ||
    meta.get("twitter:site")?.replace(/^@/, "") ||
    undefined;

  return {
    title,
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    ...(siteName ? { siteName } : {}),
    ...(favicon ? { favicon } : {}),
    url: finalUrl,
  };
}

async function fetchHtml(url: URL, signal: AbortSignal) {
  let current = url;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (await hostResolvesPrivate(current.hostname))
      throw new Error("Blocked host (resolves to private address)");
    const res = await fetch(current, {
      redirect: "manual",
      signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect missing location");
      const next = safeHttpUrl(location, current.toString());
      if (!next) throw new Error("Blocked redirect");
      current = next;
      continue;
    }

    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml|application\/xml|text\/plain/i.test(contentType)) {
      throw new Error("Unsupported content type");
    }

    return { html: await readCappedHtml(res), finalUrl: current.toString() };
  }

  throw new Error("Too many redirects");
}

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url")?.trim() ?? "";
  const safeUrl = safeHttpUrl(rawUrl);
  if (!safeUrl) return NextResponse.json(fallback(rawUrl));

  const key = safeUrl.toString();
  const cached = cache.get(key);
  if (cached) return NextResponse.json(cached);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const { html, finalUrl } = await fetchHtml(safeUrl, ctrl.signal);
    const data = parseHead(html, finalUrl);
    remember(key, data);
    return NextResponse.json(data);
  } catch {
    const data = fallback(key);
    remember(key, data);
    return NextResponse.json(data);
  } finally {
    clearTimeout(timeout);
  }
}
