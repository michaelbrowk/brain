import { MCP_SCOPE_LABELS } from "@/lib/oauth/config";
import type { AuthorizationRequest } from "@/lib/oauth/server";

export function OAuthConsent({
  request,
  requestToken,
}: {
  request: AuthorizationRequest;
  requestToken: string;
}) {
  return (
    <section className="w-full max-w-[420px]">
      <p className="text-[12px] font-medium text-ink-3">Brain MCP</p>
      <h1 className="mt-3 text-[28px] font-semibold tracking-[-0.02em] text-ink">
        Connect {request.clientName}
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
        This client is asking to access your private Brain.
      </p>
      <p className="mt-3 inline-flex rounded-md bg-fill-hover px-2 py-1 text-[11px] font-medium text-ink-2">
        Unverified client name
      </p>

      <div className="mt-6 rounded-lg border border-line bg-surface px-3 py-3">
        <p className="text-[11px] font-medium text-ink-3">
          Exact redirect after approval
        </p>
        <code className="mt-1 block break-all text-[12px] leading-relaxed text-ink">
          {request.redirectUri}
        </code>
      </div>

      <div className="mt-6 border-y border-line py-1">
        {request.scopes.map((scope) => (
          <div
            key={scope}
            className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-1 last:border-b-0"
          >
            <span className="text-[13px] text-ink">
              {MCP_SCOPE_LABELS[scope]}
            </span>
            <span className="text-[11px] text-ink-3">{scope}</span>
          </div>
        ))}
      </div>
      <form
        action="/api/oauth/authorize"
        method="post"
        className="mt-8 flex justify-end gap-2"
      >
        <input type="hidden" name="request" value={requestToken} />
        <button
          type="submit"
          name="decision"
          value="deny"
          className="brain-touch-min rounded-md px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="submit"
          name="decision"
          value="approve"
          className="brain-touch-min rounded-md bg-ink px-3 py-1.5 text-[13px] font-medium text-paper transition-opacity hover:opacity-90"
        >
          Connect
        </button>
      </form>
    </section>
  );
}
