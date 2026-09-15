const DEFAULT_PUBLIC_ORIGIN = "https://brain.example.com";

// Order is the output order of `normalizeScopes`, which filters this list, so
// a name appended here appears last in every stored grant and every challenge.
export const MCP_SCOPES = [
  "brain:read",
  "brain:write",
  "brain:import",
  "brain:mail",
  "brain:mail:send",
] as const;

// Advertise every MCP capability during connection and reauthorization.
// Import remains explicit on the consent screen because it can create many
// pages/assets; omitting it here traps clients that restart OAuth after a
// tool-specific insufficient-scope response in a read/write-only loop. The two
// mail scopes are here for the same reason.
export const MCP_CONNECTION_SCOPES = [
  "brain:read",
  "brain:write",
  "brain:import",
  "brain:mail",
  "brain:mail:send",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  "brain:read": "Read page titles and note content",
  "brain:write": "Create, edit, move, and delete pages",
  "brain:import": "Run the guarded Notion import tools",
  "brain:mail": "Read and sort your mail",
  "brain:mail:send": "Send mail as you",
};

export function oauthIssuer(): string {
  const raw = process.env.BRAIN_PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("BRAIN_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  return url.origin;
}

export function mcpResource(): string {
  return `${oauthIssuer()}/api/mcp`;
}

export function protectedResourceMetadataUrl(): string {
  return `${oauthIssuer()}/.well-known/oauth-protected-resource/api/mcp`;
}

export function normalizeScopes(values: readonly string[]): McpScope[] {
  const requested = new Set<McpScope>();
  for (const value of values) {
    if ((MCP_SCOPES as readonly string[]).includes(value)) {
      requested.add(value as McpScope);
    } else {
      throw new OAuthRequestError("invalid_scope", "Unsupported scope");
    }
  }
  // Mail is a second axis, not a step above writing. Send closes onto mail,
  // and mail closes onto read because a mail reader has to name a page to save
  // an attachment into. Neither reaches `brain:write`: a grant that sorts mail
  // cannot edit notes.
  if (requested.has("brain:mail:send")) requested.add("brain:mail");
  if (requested.has("brain:mail")) requested.add("brain:read");
  if (requested.has("brain:import")) requested.add("brain:write");
  if (requested.has("brain:write")) requested.add("brain:read");
  if (requested.size === 0) requested.add("brain:read");
  return MCP_SCOPES.filter((scope) => requested.has(scope));
}

// Brain is a single-owner service. Older Codex installations minted valid
// read/write grants before import was advertised during connection, and some
// hosts keep reusing that bearer after an accepted scope-upgrade flow. Treat a
// verified owner write grant as the full owner API so those durable grants do
// not get trapped in an OAuth refresh loop. Read-only grants stay read-only.
export function ownerEffectiveScopes(values: readonly McpScope[]): McpScope[] {
  if (!values.includes("brain:write")) return [...values];
  return [...MCP_SCOPES];
}

export class OAuthRequestError extends Error {
  constructor(
    readonly code:
      | "invalid_client"
      | "invalid_grant"
      | "invalid_request"
      | "invalid_scope"
      | "invalid_target"
      | "unsupported_grant_type"
      | "unsupported_response_type",
    message: string,
  ) {
    super(message);
    this.name = "OAuthRequestError";
  }
}
