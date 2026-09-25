import {
  isPrivateNetworkHost,
  warnPlainHttpOriginOnce,
} from "@/lib/private-origin";

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

// WHAT THE STATIC `MCP_TOKEN` BEARER REACHES, SPELLED OUT RATHER THAN DERIVED.
//
// The legacy bearer is the one credential the owner never approved on a
// screen: it comes out of an env var, owns no row under Connected apps, has no
// Revoke button and no expiry, so taking it back means editing
// `/etc/brain/brain.env` and restarting. Building its set from `MCP_SCOPES`
// meant every name appended to that list widened it in silence, which is how
// 0.11.0 would have handed a machine token mail read and mail send in the
// owner's name off an upgrade alone. This is the pre-0.11 set and it stays
// that: mail is reached through a grant the consent screen showed.
export const LEGACY_BEARER_SCOPES = [
  "brain:read",
  "brain:write",
  "brain:import",
] as const;

// WHAT THE STATIC `MCP_TOKEN` BEARER IS CALLED.
//
// The other credential the owner never named on a screen. An OAuth client
// registers its own name and the consent screen shows it, so a bell row and a
// Connections row say "Claude" because Claude said so. The static token has
// nowhere to say anything, and "Legacy token" was this file's guess: it reads
// as something left behind, and Michael's own Claude is on that token, so
// every row it earns said the wrong word about the agent he uses most.
//
// `MCP_TOKEN_NAME` is where the owner says it instead, beside the token in the
// same env file. The default names what the thing is rather than how old it
// is.
export const DEFAULT_STATIC_CLIENT_NAME = "API token";

// Forty is a row's worth. Past it the name is not a name, and the bell and the
// Connections list would carry a paragraph where a word goes.
const MAX_STATIC_CLIENT_NAME = 40;

// Anything a row cannot draw: controls, separators, the formatting codepoints
// that reorder what follows them. `\p{C}` covers all three, and a value
// carrying one is refused whole rather than stripped — a half-obeyed name is
// worse to read than the default.
const UNDRAWABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** The display name of the static-token client: the activity line's `client`
 *  at write time, and through it the bell row and the Connections ring.
 *
 *  One reader, called per use rather than read once at import: the module is
 *  loaded long before the server's env is what it will be under systemd, and
 *  this costs a property read. A value that is not a name falls back to the
 *  default whole. */
export function staticClientName(): string {
  const value = (process.env.MCP_TOKEN_NAME ?? "").trim();
  if (!value) return DEFAULT_STATIC_CLIENT_NAME;
  if ([...value].length > MAX_STATIC_CLIENT_NAME) return DEFAULT_STATIC_CLIENT_NAME;
  if (UNDRAWABLE.test(value)) return DEFAULT_STATIC_CLIENT_NAME;
  return value;
}

export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  "brain:read": "Read page titles and note content",
  "brain:write": "Create, edit, move, and delete pages",
  "brain:import": "Run the guarded Notion import tools",
  "brain:mail": "Read and sort your mail",
  "brain:mail:send": "Send mail as you",
};

/** WHY THIS ACCEPTS PLAIN HTTP ON A PRIVATE NAME.
 *
 *  Everything MCP is sits behind this function, so an origin it refuses is an
 *  install with no MCP at all: no discovery documents, no tools, not even the
 *  static bearer. It refused anything that was not https, which turned away the
 *  house install Brain is written for, `http://brain.lan` or
 *  `http://192.168.1.10:3000`, because nobody terminates TLS for a name a home
 *  router invented.
 *
 *  `lib/private-origin.ts` owns the reading of which names are the owner's own
 *  network, and is the reading every caller uses. A public name stays
 *  https-only with the message it always had: `http://brain.example.com` is a
 *  box on the internet whatever its owner calls it. */
export function oauthIssuer(): string {
  const raw = process.env.BRAIN_PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // `new URL` throws `TypeError: Invalid URL`, which reaches the owner as a
    // stack trace and says nothing about which variable it was. One sentence,
    // the same one every other refused value gets. The shape most likely to
    // land here is an IPv6 address with a zone id, `http://[fe80::1%eth0]`,
    // pasted out of `ip addr` now that the docs invite IPv6 origins.
    throw new Error("BRAIN_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  const plainHttpOnPrivateNetwork =
    url.protocol === "http:" && isPrivateNetworkHost(url.hostname);
  if (
    (url.protocol !== "https:" && !plainHttpOnPrivateNetwork) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("BRAIN_PUBLIC_ORIGIN must be an exact HTTPS origin");
  }
  if (plainHttpOnPrivateNetwork) warnPlainHttpOriginOnce(url.origin);
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
