import {
  MCP_SCOPES,
  mcpResource,
  oauthIssuer,
} from "@/lib/oauth/config";
import { OAUTH_CORS_HEADERS, oauthOptionsResponse } from "@/lib/oauth/http";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      resource: mcpResource(),
      authorization_servers: [oauthIssuer()],
      bearer_methods_supported: ["header"],
      scopes_supported: [...MCP_SCOPES],
    },
    { headers: { ...OAUTH_CORS_HEADERS, "Cache-Control": "public, max-age=3600" } },
  );
}

export const OPTIONS = oauthOptionsResponse;
