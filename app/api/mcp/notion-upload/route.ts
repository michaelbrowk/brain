import { NextRequest } from "next/server";
import { withMcpAuth } from "mcp-handler";
import { handleNotionUpload } from "@/lib/notion/http-upload";
import { oauthIssuer } from "@/lib/oauth/config";
import {
  exactBearerToken,
  withMcpChallengeScopes,
} from "@/lib/oauth/http";
import { verifyMcpBearerToken } from "@/lib/oauth/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const authenticatedPost = withMcpAuth(
  (request) => handleNotionUpload(request as NextRequest),
  (request, token) => verifyMcpBearerToken(exactBearerToken(request, token)),
  {
    required: true,
    requiredScopes: ["brain:import"],
    resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
    resourceUrl: oauthIssuer(),
  },
);

export async function POST(request: Request): Promise<Response> {
  return withMcpChallengeScopes(
    await authenticatedPost(request),
    ["brain:import"],
  );
}
