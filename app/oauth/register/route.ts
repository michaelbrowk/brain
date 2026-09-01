import {
  OAUTH_NO_STORE_HEADERS,
  oauthErrorResponse,
  oauthOptionsResponse,
  oauthRateLimitResponse,
  readBoundedText,
} from "@/lib/oauth/http";
import { trustedOAuthRateSource } from "@/lib/oauth/rate-source";
import { registerOAuthClient } from "@/lib/oauth/server";
import { OAuthRequestError } from "@/lib/oauth/config";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const limiter = new FixedWindowRateLimiter({
  limit: 20,
  windowMs: 60_000,
  maxEntries: 1_024,
});

export async function POST(request: Request) {
  try {
    const source = trustedOAuthRateSource(request);
    const admitted = limiter.consume(`oauth-registration:${source}`);
    if (!admitted.allowed) {
      return oauthRateLimitResponse(admitted.retryAfterSeconds);
    }
    const raw = await readBoundedText(request, 16 * 1024);
    let metadata: unknown;
    try {
      metadata = JSON.parse(raw);
    } catch {
      throw new OAuthRequestError(
        "invalid_request",
        "Request body must be valid JSON",
      );
    }
    const client = await registerOAuthClient(metadata);
    return Response.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(client.createdAt / 1_000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: client.applicationType,
      },
      { status: 201, headers: OAUTH_NO_STORE_HEADERS },
    );
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export const OPTIONS = oauthOptionsResponse;
