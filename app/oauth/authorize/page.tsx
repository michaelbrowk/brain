import Link from "next/link";
import { OAuthConsent } from "@/components/oauth-consent";
import {
  createAuthorizationRequestToken,
  parseAuthorizationRequest,
  type AuthorizationRequest,
} from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

export default async function OAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let request: AuthorizationRequest | null = null;
  let requestToken = "";
  try {
    const raw = await searchParams;
    if (raw.invalid) throw new Error("invalid");
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(raw)) {
      if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
      else if (value !== undefined) params.set(key, value);
    }
    request = await parseAuthorizationRequest(params);
    requestToken = await createAuthorizationRequestToken(request);
  } catch {
    request = null;
  }

  if (!request) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper px-6 py-12">
        <section className="w-full max-w-[380px] text-center">
          <h1 className="text-[24px] font-semibold text-ink">Connection request expired</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Start the connection again from your MCP client.
          </p>
          <Link
            href="/"
            className="brain-touch-min mt-6 inline-flex items-center rounded-md px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            Back to Brain
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-6 py-12">
      <OAuthConsent request={request} requestToken={requestToken} />
    </main>
  );
}
