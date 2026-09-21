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
- `brain:mail` covers reading and sorting mail and saving one of its
  attachments into a note. `brain:mail:send` covers putting a message on the
  wire and includes `brain:mail`. Mail is a second axis, not a step above
  writing: `brain:mail` includes `brain:read`, because a mail reader has to
  name a page to save an attachment into, and it does not include
  `brain:write`. A grant that sorts mail cannot edit notes. Which tool sits
  under which scope is in `docs/mcp-tools.md`.
- **A `brain:write` grant reaches the import tools as well.** Brain is a
  single-owner service, and `ownerEffectiveScopes` in `lib/oauth/config.ts`
  widens any verified write grant to the full scope set when an access token is
  introspected, so the import tools accept it. The distinction the code enforces
  today is read-only versus writing, not writing versus importing: a read-only
  grant stays read-only, and everything above it can import. Do not treat
  `brain:import` as a second barrier in front of the import surface. The same
  widening now reaches the two mail scopes, which is deliberate: an owner
  connection made before mail existed gets the mail tools on upgrade without a
  second consent screen, and a read-only grant still gets neither. The widening
  is a rule about **grants**, and an OAuth grant is a screen the owner
  approved, a row under Connected apps and a Revoke button. The static
  `MCP_TOKEN` bearer is none of those and is not widened: it keeps
  `LEGACY_BEARER_SCOPES` (`brain:read`, `brain:write`, `brain:import`) and
  reaches no mail tool.
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

The older `MCP_TOKEN` remains a notes compatibility credential during the
migration: `brain:read`, `brain:write` and `brain:import`, the set it held
before 0.11.0, spelled out as `LEGACY_BEARER_SCOPES` in `lib/oauth/config.ts`.
**It cannot read mail and it cannot send mail.** A mail tool answers it HTTP
`403` with `scope="brain:mail"`, and its own `connection_check` reports
`mail: "not_authorized"`. The two mail scopes are reached only through an OAuth
grant the owner approved on the consent screen, which owns a row under
Settings → Connections and a Revoke button; this static bearer owns neither, so
widening it would be access nobody agreed to and nobody could take back short
of editing `/etc/brain/brain.env` and restarting. To give an agent mail,
connect it over OAuth and approve "Read and sort your mail", or "Send mail as
you" as well. `MCP_TOKEN` is not returned by OAuth and should be retired only
after every real client has completed an OAuth connect/read/write check.

`MCP_TOKEN_NAME` is what that client is called wherever Brain names it: the
activity line each mutation writes, the bell row that line earns, and the
Connections ring underneath. An OAuth client registers its own name and the
consent screen shows it, so those rows say "Claude" because Claude said so; the
static token has nowhere to say anything, so the owner says it here. Set it to
the agent that holds the token — with `MCP_TOKEN_NAME=Claude` the bell reads
"Claude created a page". The value is trimmed and has to be at most 40 drawable
characters; unset, longer, or carrying a control character, the name is
`API token`. Lines already in the log keep the word they were written with: the
log is history, and a rename is not a correction to what happened.

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
   revocation must still work. The legacy token keeps the notes scopes it had
   before this rollout and gains neither mail scope: confirm that
   `list_mail_accounts` on `MCP_TOKEN` answers HTTP `403` with exact
   `scope="brain:mail"`, and that its `connection_check` reports
   `mail: "not_authorized"` and `mailSend: "not_authorized"`.
8. Connect read-only again and confirm the bootstrap challenge advertises
   `scope="brain:read brain:write brain:import brain:mail brain:mail:send"`,
   that a mail tool returns HTTP `403` with exact `scope="brain:mail"`, and
   that `/var/lib/brain/mcp` is private to the `brain` service user with its
   files mode `0600`.
9. Connect a test app with mail access and confirm the two axes stay apart. A
   write tool must still be refused with exact `scope="brain:write"`, because
   `brain:mail` does not include it. Then send one message to yourself with
   `send_mail`, and check three things: the row in the Sent mailbox reads
   "Sent by ‹client›" with the name from the consent screen, which is resolved
   as that mailbox opens rather than polled, one line for that send appears under
   Settings → Connections, and the received message carries an
   `X-Brain-Agent: mcp` header and no extra body line. Turn "Let agents send
   mail" off and confirm the next `send_mail` answers `agent sending is off`
   while the mail reads keep working. A first-party SMTP account shows no
   caption on its Sent row by design, so run this step on a Gmail account.

Rollback is code-only, with one condition. Before any client has consented to
`brain:mail` or `brain:mail:send`, switch to the prior immutable release and
keep `/var/lib/brain/oauth` in place so a forward retry does not silently
forget owner grants; the prior release ignores this directory. Once one grant
has stored either mail scope, that stops being safe: the prior release's
scope validator does not know the two mail scopes, so it refuses the whole
state file on read, every grant in it, not only the mail one, rather than
loading it. From that point, stay on 0.11.0 or later. Revoking the mail-scoped
grant in Settings → Connections is not an immediate fix: a revoked grant keeps
its stored scopes for 24 hours before Brain prunes it, so the state file is
still unreadable by the prior release during that window.
