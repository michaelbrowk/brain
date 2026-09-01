import { OAuthRequestError } from "@/lib/oauth/config";
import {
  OAUTH_NO_STORE_HEADERS,
  oauthErrorResponse,
  oauthOptionsResponse,
  oauthRateLimitResponse,
  readBoundedText,
} from "@/lib/oauth/http";
import { trustedOAuthRateSource } from "@/lib/oauth/rate-source";
import { exchangeOAuthToken } from "@/lib/oauth/server";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const sourceLimiter = new FixedWindowRateLimiter({
  limit: 240,
  windowMs: 60_000,
  maxEntries: 1_024,
});

const clientLimiter = new FixedWindowRateLimiter({
  limit: 120,
  windowMs: 60_000,
  maxEntries: 2_048,
});

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      throw new OAuthRequestError("invalid_request", "Expected form body");
    }
    const form = new URLSearchParams(await readBoundedText(request, 8 * 1024));
    const source = trustedOAuthRateSource(request);
    const sourceAdmission = sourceLimiter.consume(`oauth-token-source:${source}`);
    if (!sourceAdmission.allowed) {
      return oauthRateLimitResponse(sourceAdmission.retryAfterSeconds);
    }
    const clientId = boundedRateClientId(form);
    const admitted = clientLimiter.consume(`oauth-token:${source}:${clientId}`);
    if (!admitted.allowed) {
      return oauthRateLimitResponse(admitted.retryAfterSeconds);
    }
    const response = await exchangeOAuthToken(form);
    return Response.json(response, { headers: OAUTH_NO_STORE_HEADERS });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

function boundedRateClientId(form: URLSearchParams): string {
  const values = form.getAll("client_id");
  return values.length === 1 && values[0] && values[0].length <= 2_048
    ? values[0]
    : "invalid-client";
}

export const OPTIONS = oauthOptionsResponse;
