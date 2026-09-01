# Brain MCP OAuth

Brain is both the OAuth authorization server and the protected MCP resource.
OAuth-capable clients connect to `https://brain.example.com/api/mcp`; they
discover the remaining endpoints automatically.

## Security model

- The Brain owner must have a valid human session before approving a client.
- Dynamic Client Registration accepts only exact HTTPS callbacks or loopback
  HTTP callbacks. Authorization and token requests must carry the exact Brain
  MCP resource URL.
- Signed consent requests are one-time. Approval and denial both consume the
  request atomically, so a repeated click or concurrent replay cannot create a
  second grant.
- Every authorization-code flow requires PKCE S256. Codes live for five
  minutes and are one-time.
- Access tokens live for 15 minutes and are audience-bound. Public clients get
  signed rotating refresh tokens. Each grant persists only its current
  generation and nonce hash; replay revokes that grant family without filling
  a global spent-token registry or affecting another client.
- Two byte-identical refresh exchanges that overlap inside the single Brain
  process share only their in-flight promise. The entry is keyed by a hash of
  the presented token and is removed immediately at settlement. There is no
  replay grace window or persisted successor token; a later replay still
  revokes the family.
- `brain:read` covers list, read, and search. `brain:write` includes read and
  covers page mutations. `brain:import` includes write and is the scope the
  guarded Notion import tools and the binary import-upload route are declared
  against.
- **A `brain:write` grant reaches the import tools as well.** Brain is a
  single-owner service, and `ownerEffectiveScopes` in `lib/oauth/config.ts`
  widens any verified write grant to the full scope set when an access token is
  introspected, so the import tools accept it. The distinction the code enforces
  today is read-only versus writing, not writing versus importing: a read-only
  grant stays read-only, and everything above it can import. Do not treat
  `brain:import` as a second barrier in front of the import surface.
- Settings lists active connected apps by grant. Revoking one grant immediately
  invalidates its access and refresh tokens. A recognized valid token returns
  success only after the revocation state is durably written; transient state
  failures return OAuth `server_error` instead of a false success.

OAuth state defaults to the dedicated `/var/lib/brain/oauth` directory in
production. The directory is mode `0700`; state and process-owner files are
mode `0600`, owner-checked, regular files. Brain writes state atomically and
persists only authorization-code and current refresh-nonce hashes. The state
store intentionally permits one live Node process/thread; a second runtime
fails closed instead of racing file writes. Concurrent first reads share one
per-path acquisition and verify that the accepted process claim still exists.
State must not be copied into a release artifact or committed.

`AUTH_SECRET` must contain at least 32 bytes. Brain derives independent access,
authorization-request, and refresh signing keys with HKDF, so one token kind
cannot be accepted as another.

## Required trusted edge

The public registration, token, and revocation routes require nginx to prove
the request source. Generate a separate `BRAIN_EDGE_RATE_SECRET` with
`openssl rand -hex 32`, store it in `/etc/brain/brain.env`, and place the same
value only in a root-readable nginx include. Never put it in Cloudflare, Git,
the browser, or a public request header.

On the three `/oauth/register`, `/oauth/token`, and `/oauth/revoke` locations,
nginx must **overwrite** (not append or preserve) both headers before proxying:

```nginx
proxy_set_header X-Brain-Edge-Secret "<same 64-character secret>";
proxy_set_header X-Brain-Rate-Source $remote_addr;
```

Configure nginx `set_real_ip_from` only for Cloudflare's current published IP
ranges, `real_ip_header CF-Connecting-IP`, and `real_ip_recursive on`. Then a
Cloudflare request uses the real client address, while a direct-origin request
keeps its actual source; a forged public `CF-Connecting-IP` or Brain header is
not trusted. Keep port 3020 bound to loopback so nobody can bypass nginx.

The token endpoint consumes a bounded aggregate source bucket before its
source+client bucket, so rotating client ids cannot bypass the source limit.
Every limiter fails closed when its bounded map is full; it never evicts an
active bucket to admit a new key. nginx or Cloudflare must additionally enforce
a source-level limit on these public routes, especially registration. Requests
reaching Brain without valid edge proof deliberately fail closed. The reference
vhost `ops/nginx/brain.conf.example` carries the three locations and the
edge-secret include, and ships the Cloudflare `set_real_ip_from` include
commented out — fill the ranges in and uncomment all three lines before
putting Cloudflare in front. `scripts/verify-ops.sh` runs `nginx -t` on it in
CI. The repository still never
mutates production nginx or Cloudflare configuration.

## Discovery and endpoints

- Protected resource metadata:
  `/.well-known/oauth-protected-resource/api/mcp`
- Authorization server metadata: `/.well-known/oauth-authorization-server`
- Consent: `/oauth/authorize`
- Dynamic registration: `/oauth/register`
- Token exchange: `/oauth/token`
- Revocation: `/oauth/revoke`

The older `MCP_TOKEN` remains a full-access compatibility credential during the
migration. It is not returned by OAuth and should be retired only after every
real client has completed an OAuth connect/read/write check.

## Rollout check

1. Confirm `BRAIN_PUBLIC_ORIGIN` is the exact public HTTPS origin,
   `/var/lib/brain/oauth` is private to the `brain` service user, and the nginx
   trusted-edge/source-level limits above are active. A direct request to the
   loopback app without edge proof must be rejected.
2. Fetch both discovery documents and verify every advertised URL uses the
   production origin.
3. Connect a real MCP client. Consent must mark the supplied client name as
   unverified and show the complete exact redirect URI. Approve read-only
   access, run `connection_check`, read a known page, and confirm a write tool returns HTTP `403` with
   `error="insufficient_scope"`, exact `scope="brain:write"`, and
   `resource_metadata` without changing notes. Import tools and the binary
   upload route must advertise `scope="brain:import"`.
4. Connect with write access, make one reversible test edit, and verify the
   normal Store/git history path recorded it.
5. Revoke the test app in Settings and confirm reconnection requires fresh
   owner consent.
6. Rotate one test refresh token repeatedly, replay an older generation, and
   confirm only that app is revoked while a second app still refreshes.
7. Restart `brain.service`; discovery, an unreplayed existing refresh, and
   revocation must still work. The legacy token remains unchanged during this
   rollout.

Rollback is code-only: switch to the prior immutable release. Keep
`/var/lib/brain/oauth` in place so a forward retry does not silently forget
owner grants. The prior release ignores this directory.
