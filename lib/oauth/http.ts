import {
  type McpScope,
  OAuthRequestError,
  protectedResourceMetadataUrl,
} from "./config";

export const OAUTH_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
} as const;

export const OAUTH_NO_STORE_HEADERS = {
  ...OAUTH_CORS_HEADERS,
  "Cache-Control": "no-store",
  Pragma: "no-cache",
} as const;

export async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new OAuthRequestError("invalid_request", "Request is too large");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("OAuth request too large");
      throw new OAuthRequestError("invalid_request", "Request is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OAuthRequestError("invalid_request", "Request must be UTF-8");
  }
}

export function oauthErrorResponse(error: unknown): Response {
  if (error instanceof OAuthRequestError) {
    return Response.json(
      { error: error.code, error_description: error.message },
      {
        status: error.code === "invalid_client" ? 401 : 400,
        headers: OAUTH_NO_STORE_HEADERS,
      },
    );
  }
  return Response.json(
    { error: "server_error", error_description: "OAuth is temporarily unavailable" },
    { status: 503, headers: OAUTH_NO_STORE_HEADERS },
  );
}

export function oauthOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

export function oauthRateLimitResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "temporarily_unavailable" },
    {
      status: 429,
      headers: {
        ...OAUTH_NO_STORE_HEADERS,
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

export function mcpInsufficientScopeResponse(scope: McpScope): Response {
  return Response.json(
    {
      error: "insufficient_scope",
      error_description: "Insufficient scope",
    },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "WWW-Authenticate":
          `Bearer error="insufficient_scope", ` +
          `error_description="Insufficient scope", ` +
          `scope="${scope}", ` +
          `resource_metadata="${protectedResourceMetadataUrl()}"`,
      },
    },
  );
}

/** mcp-handler 1.1 omits the required scope from its WWW-Authenticate
 * challenge. Add it at the exported route boundary so clients can upscope. */
export function withMcpChallengeScopes(
  response: Response,
  scopes: readonly McpScope[],
): Response {
  if (response.status !== 401 && response.status !== 403) return response;
  const challenge = response.headers.get("WWW-Authenticate");
  if (!challenge?.startsWith("Bearer ") || /(?:^|,\s*)scope="/.test(challenge)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("WWW-Authenticate", `${challenge}, scope="${scopes.join(" ")}"`);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function exactBearerToken(
  request: Request,
  parsedToken: string | undefined,
): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(
    request.headers.get("Authorization") ?? "",
  );
  return match && match[1] === parsedToken ? parsedToken : undefined;
}
