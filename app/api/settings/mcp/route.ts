import { NextResponse } from "next/server";
import { mcpResource, oauthIssuer } from "@/lib/oauth/config";
import { readBoundedText } from "@/lib/oauth/http";
import { getOAuthStateStore } from "@/lib/oauth/state";

export const dynamic = "force-dynamic";

/** MCP connection details for the settings pane.
 *  Reached only with a valid human session cookie (proxy-gated). */
export async function GET() {
  return NextResponse.json({
    endpoint: mcpResource(),
    token: process.env.MCP_TOKEN ?? "",
    oauth: {
      issuer: oauthIssuer(),
      authorizationEndpoint: `${oauthIssuer()}/oauth/authorize`,
    },
    connectedApps: await getOAuthStateStore().listConnectedApps(),
  });
}

export async function DELETE(request: Request) {
  try {
    const body = JSON.parse(await readBoundedText(request, 2_048)) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      !("grantId" in body) ||
      typeof body.grantId !== "string" ||
      !/^grant_[A-Za-z0-9_-]{24,128}$/.test(body.grantId) ||
      Object.keys(body).length !== 1
    ) {
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    }
    await getOAuthStateStore().revokeGrant(body.grantId);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
}
