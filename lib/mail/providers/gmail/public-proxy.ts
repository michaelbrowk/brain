import { request as httpRequest } from "node:http";
import path from "node:path";

import {
  GMAIL_OAUTH_SERVICE_PATHS,
  GMAIL_OAUTH_TRANSACTION_COOKIE,
} from "./contract";

const DEFAULT_SOCKET_PATH = "/run/brain-mail/brain-mail.sock";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CALLBACK_QUERY_BYTES = 8 * 1024;
const MAX_COOKIE_HEADER_BYTES = 8 * 1024;
const MAX_START_FORM_BYTES = 256;
const CLEAR_TRANSACTION_COOKIE = `${GMAIL_OAUTH_TRANSACTION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

interface GmailOAuthProxyOptions {
  readonly socketPath?: string;
  readonly publicOrigin?: string;
  readonly requestTimeoutMs?: number;
}

interface MailServiceRedirect {
  readonly status: number;
  readonly location: string | null;
  readonly setCookies: readonly string[];
}

export async function proxyGmailOAuthStart(
  request: Request,
  options: GmailOAuthProxyOptions = {},
): Promise<Response> {
  let publicOrigin: string;
  try {
    publicOrigin = readPublicOrigin(options.publicOrigin);
    const targetAccountId = await validateStartRequest(request, publicOrigin);
    const servicePath =
      targetAccountId === null
        ? GMAIL_OAUTH_SERVICE_PATHS.start
        : `${GMAIL_OAUTH_SERVICE_PATHS.start}?accountId=${encodeURIComponent(targetAccountId)}`;
    const service = await requestMailServiceRedirect(
      "POST",
      servicePath,
      undefined,
      request.signal,
      options,
    );
    if (service.status !== 303 || service.location === null) {
      return safeStartError(publicOrigin);
    }
    const location = validateGoogleAuthorizationLocation(service.location);
    const cookie = validateStartCookie(service.setCookies);
    return redirectResponse(location, cookie);
  } catch {
    try {
      publicOrigin = readPublicOrigin(options.publicOrigin);
      return safeStartError(publicOrigin);
    } catch {
      return Response.json(
        { apiVersion: 1, error: { code: "gmail_oauth_unavailable" } },
        { status: 503, headers: safeHeaders() },
      );
    }
  }
}

export async function proxyGmailOAuthCallback(
  request: Request,
  options: GmailOAuthProxyOptions = {},
): Promise<Response> {
  let publicOrigin: string;
  try {
    publicOrigin = readPublicOrigin(options.publicOrigin);
    const callbackPath = validateCallbackRequest(request, publicOrigin);
    const cookie = extractTransactionCookie(request.headers.get("Cookie"));
    const service = await requestMailServiceRedirect(
      "GET",
      callbackPath,
      cookie,
      request.signal,
      options,
    );
    if (service.status !== 303 || service.location === null) {
      return safeCallbackError(publicOrigin);
    }
    const location = validateMailResultLocation(service.location, publicOrigin);
    return redirectResponse(location, CLEAR_TRANSACTION_COOKIE);
  } catch {
    try {
      publicOrigin = readPublicOrigin(options.publicOrigin);
      return safeCallbackError(publicOrigin);
    } catch {
      return new Response(null, {
        status: 503,
        headers: safeHeaders({ "Set-Cookie": CLEAR_TRANSACTION_COOKIE }),
      });
    }
  }
}

async function validateStartRequest(
  request: Request,
  publicOrigin: string,
): Promise<string | null> {
  if (
    request.method !== "POST" ||
    request.headers.get("Origin") !== publicOrigin ||
    request.headers.has("Transfer-Encoding")
  ) {
    throw new Error("invalid start request");
  }
  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_START_FORM_BYTES)
  ) {
    throw new Error("invalid start request");
  }
  const url = new URL(request.url);
  if (
    !hasPublicRequestAuthority(url, publicOrigin) ||
    url.pathname !== "/api/mail/oauth/google/start" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("invalid start request");
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_START_FORM_BYTES) {
        next.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new Error("invalid start request");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (bytes === 0) return null;
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers.get("Content-Type") ?? "",
    )
  ) {
    for (const chunk of chunks) chunk.fill(0);
    throw new Error("invalid start request");
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
    chunk.fill(0);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const form = new URLSearchParams(text);
    if (
      [...form.keys()].some((key) => key !== "accountId") ||
      form.getAll("accountId").length !== 1
    ) {
      throw new Error("invalid start request");
    }
    const accountId = form.get("accountId");
    if (!accountId || !/^account-a[0-9a-f]{32}$/.test(accountId)) {
      throw new Error("invalid start request");
    }
    return accountId;
  } finally {
    body.fill(0);
  }
}

function validateCallbackRequest(request: Request, publicOrigin: string): string {
  if (request.method !== "GET") throw new Error("invalid callback request");
  const url = new URL(request.url);
  if (
    !hasPublicRequestAuthority(url, publicOrigin) ||
    url.pathname !== "/api/mail/oauth/google/callback" ||
    url.hash !== "" ||
    Buffer.byteLength(url.search) > MAX_CALLBACK_QUERY_BYTES
  ) {
    throw new Error("invalid callback request");
  }
  const allowed = new Set([
    "authuser",
    "code",
    "error",
    "error_description",
    "error_subtype",
    "hd",
    "iss",
    "prompt",
    "scope",
    "state",
  ]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("invalid callback request");
    }
  }
  if (
    !url.searchParams.has("state") ||
    url.searchParams.has("code") === url.searchParams.has("error") ||
    url.searchParams.getAll("iss").length !== 1 ||
    url.searchParams.get("iss") !== "https://accounts.google.com"
  ) {
    throw new Error("invalid callback request");
  }
  return `${GMAIL_OAUTH_SERVICE_PATHS.callback}${url.search}`;
}

function hasPublicRequestAuthority(
  url: URL,
  publicOrigin: string,
): boolean {
  if (url.origin === publicOrigin) return true;

  // The standalone Next server is loopback-only and sits behind nginx. Next
  // normalizes route-handler URLs to its loopback authority, while preserving
  // nginx's forwarded https scheme, and may omit the original Host from the
  // Web Request. Trust only http/https on the configured public hostname or a
  // loopback hostname; start still requires the exact public Origin and the
  // callback remains bound to its opaque transaction cookie and Google state.
  const expected = new URL(publicOrigin);
  const internalHostname = url.hostname.toLowerCase();
  return (
    (url.protocol === "http:" || url.protocol === expected.protocol) &&
    (internalHostname === expected.hostname.toLowerCase() ||
      internalHostname === "127.0.0.1" ||
      internalHostname === "localhost" ||
      internalHostname === "[::1]")
  );
}

function validateGoogleAuthorizationLocation(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "accounts.google.com" ||
    url.port !== "" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("invalid authorization location");
  }
  for (const field of [
    "client_id",
    "code_challenge",
    "nonce",
    "redirect_uri",
    "scope",
    "state",
  ]) {
    if (url.searchParams.getAll(field).length !== 1) {
      throw new Error("invalid authorization location");
    }
  }
  if (
    url.searchParams.get("access_type") !== "offline" ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    url.searchParams.get("response_type") !== "code"
  ) {
    throw new Error("invalid authorization location");
  }
  return url.toString();
}

function validateMailResultLocation(value: string, publicOrigin: string): string {
  const url = new URL(value);
  if (
    url.origin !== publicOrigin ||
    url.pathname !== "/mail" ||
    url.hash !== "" ||
    url.searchParams.size !== 1 ||
    !["connected", "cancelled", "error"].includes(
      url.searchParams.get("gmail") ?? "",
    )
  ) {
    throw new Error("invalid result location");
  }
  return url.toString();
}

function validateStartCookie(setCookies: readonly string[]): string {
  if (setCookies.length !== 1) throw new Error("invalid transaction cookie");
  const parts = setCookies[0].split(";").map((part) => part.trim());
  const [pair, ...attributes] = parts;
  const prefix = `${GMAIL_OAUTH_TRANSACTION_COOKIE}=`;
  if (!pair.startsWith(prefix)) throw new Error("invalid transaction cookie");
  const value = pair.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{16,4096}$/.test(value)) {
    throw new Error("invalid transaction cookie");
  }
  const normalized = new Set(attributes.map((attribute) => attribute.toLowerCase()));
  const maxAge = attributes.find((attribute) =>
    /^max-age=/i.test(attribute),
  );
  const maxAgeSeconds = maxAge ? Number(maxAge.slice("max-age=".length)) : NaN;
  if (
    attributes.length !== 5 ||
    normalized.size !== 5 ||
    !normalized.has("path=/") ||
    !normalized.has("httponly") ||
    !normalized.has("secure") ||
    !normalized.has("samesite=lax") ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > 600 ||
    [...normalized].some((attribute) => attribute.startsWith("domain="))
  ) {
    throw new Error("invalid transaction cookie");
  }
  return setCookies[0];
}

function extractTransactionCookie(cookieHeader: string | null): string {
  if (
    cookieHeader === null ||
    Buffer.byteLength(cookieHeader) > MAX_COOKIE_HEADER_BYTES
  ) {
    throw new Error("missing transaction cookie");
  }
  const prefix = `${GMAIL_OAUTH_TRANSACTION_COOKIE}=`;
  const matches = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix));
  if (matches.length !== 1) throw new Error("invalid transaction cookie");
  const value = matches[0].slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{16,4096}$/.test(value)) {
    throw new Error("invalid transaction cookie");
  }
  return `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${value}`;
}

async function requestMailServiceRedirect(
  method: "GET" | "POST",
  requestPath: string,
  cookie: string | undefined,
  signal: AbortSignal,
  options: GmailOAuthProxyOptions,
): Promise<MailServiceRedirect> {
  const socketPath = readSocketPath(options.socketPath);
  const requestTimeoutMs = readTimeout(options.requestTimeoutMs);
  return new Promise<MailServiceRedirect>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      action();
    };
    try {
      const serviceRequest = httpRequest(
        {
          socketPath,
          method,
          path: requestPath,
          signal,
          headers: cookie
            ? { Accept: "text/plain", Cookie: cookie }
            : { Accept: "text/plain" },
        },
        (response) => {
          response.resume();
          response.once("end", () => {
            const contentLength = response.headers["content-length"];
            if (contentLength !== "0") {
              finish(() => reject(new Error("invalid mail service response")));
              return;
            }
            const location = response.headers.location;
            const setCookies = response.headers["set-cookie"] ?? [];
            finish(() =>
              resolve({
                status: response.statusCode ?? 502,
                location: typeof location === "string" ? location : null,
                setCookies,
              }),
            );
          });
          response.once("error", () =>
            finish(() => reject(new Error("mail service unavailable"))),
          );
          response.once("aborted", () =>
            finish(() => reject(new Error("mail service unavailable"))),
          );
        },
      );
      timer = setTimeout(() => {
        serviceRequest.destroy();
        finish(() => reject(new Error("mail service timeout")));
      }, requestTimeoutMs);
      serviceRequest.once("error", () =>
        finish(() => reject(new Error("mail service unavailable"))),
      );
      serviceRequest.end();
    } catch {
      finish(() => reject(new Error("mail service unavailable")));
    }
  });
}

function safeStartError(publicOrigin: string): Response {
  return redirectResponse(`${publicOrigin}/mail?gmail=error`, CLEAR_TRANSACTION_COOKIE);
}

function safeCallbackError(publicOrigin: string): Response {
  return redirectResponse(
    `${publicOrigin}/mail?gmail=error`,
    CLEAR_TRANSACTION_COOKIE,
  );
}

function redirectResponse(location: string, cookie: string): Response {
  return new Response(null, {
    status: 303,
    headers: safeHeaders({ Location: location, "Set-Cookie": cookie }),
  });
}

function safeHeaders(additional?: HeadersInit): Headers {
  const headers = new Headers(additional);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

function readPublicOrigin(override: string | undefined): string {
  const value = override ?? process.env.BRAIN_PUBLIC_ORIGIN;
  if (typeof value !== "string") throw new Error("missing public origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error("invalid public origin");
  }
  return value;
}

function readSocketPath(override: string | undefined): string {
  const value =
    override ?? process.env.BRAIN_MAIL_SOCKET_PATH ?? DEFAULT_SOCKET_PATH;
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\u0000") ||
    value.length > 512
  ) {
    throw new Error("invalid socket path");
  }
  return value;
}

function readTimeout(override: number | undefined): number {
  const value = override ?? REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new Error("invalid timeout");
  }
  return value;
}
