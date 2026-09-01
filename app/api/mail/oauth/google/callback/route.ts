import { proxyGmailOAuthCallback } from "@/lib/mail/providers/gmail/public-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxyGmailOAuthCallback(request);
}

