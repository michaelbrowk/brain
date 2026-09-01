import { OAUTH_CORS_HEADERS, oauthOptionsResponse } from "@/lib/oauth/http";
import { authorizationServerMetadata } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(authorizationServerMetadata(), {
    headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "public, max-age=3600" },
  });
}

export const OPTIONS = oauthOptionsResponse;
