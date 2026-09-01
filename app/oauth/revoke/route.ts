import { OAuthRequestError } from "@/lib/oauth/config";
import {
  OAUTH_NO_STORE_HEADERS,
  oauthErrorResponse,
  oauthOptionsResponse,
  oauthRateLimitResponse,
  readBoundedText,
} from "@/lib/oauth/http";
import { trustedOAuthRateSource } from "@/lib/oauth/rate-source";
import { revokeOAuthToken } from "@/lib/oauth/server";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const limiter = new FixedWindowRateLimiter({
  limit: 120,
  windowMs: 60_000,
  maxEntries: 2_048,
});

export async function POST(request: Request) {
  try {
    const form = new URLSearchParams(await readBoundedText(request, 8 * 1024));
    const source = trustedOAuthRateSource(request);
    const clientId = exact(form, "client_id", 2_048);
    const admitted = limiter.consume(`oauth-revoke:${source}:${clientId}`);
    if (!admitted.allowed) {
      return oauthRateLimitResponse(admitted.retryAfterSeconds);
    }
    const token = exact(form, "token", 2_048);
    await revokeOAuthToken(token, clientId);
    return new Response(null, { status: 200, headers: OAUTH_NO_STORE_HEADERS });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

function exact(form: URLSearchParams, name: string, max: number): string {
  const values = form.getAll(name);
  if (values.length !== 1 || !values[0] || values[0].length > max) {
    throw new OAuthRequestError("invalid_request", `Invalid ${name}`);
  }
  return values[0];
}

export const OPTIONS = oauthOptionsResponse;
