import { proxyGmailOAuthStart } from "@/lib/mail/providers/gmail/public-proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return proxyGmailOAuthStart(request);
}

