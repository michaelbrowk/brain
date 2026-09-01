# Gmail OAuth foundation

Status: implemented, connected to the multi-account store, and deliberately
disabled until the private Google configuration is installed. No Google
credential has been created, stored, or used by this change.

The local Mail client now has bounded Gmail sync, list/reader actions,
compose/reply, durable send state, and background refresh behind this OAuth
boundary. Those modules remain pre-production until this flow completes with a
real private account and the read/action/send canary passes. Local green tests
alone do not make Gmail live.

## Boundary

The browser uses a top-level OAuth redirect. The flow does not run in an iframe
or a popup.

1. `POST /api/mail/oauth/google/start` accepts a same-origin form POST. A new
   connection has an empty body. Reconnect sends one URL-encoded `accountId`.
2. The Next route proxies to `POST /v1/oauth/gmail/start` over the private
   brain-mail Unix socket.
3. brain-mail creates PKCE S256, `state`, and OpenID Connect `nonce` values. It
   returns Google's authorization URL and one encrypted transaction cookie.
4. Google redirects to `/api/mail/oauth/google/callback`.
5. Next forwards only the callback query and the Gmail transaction cookie to
   `GET /v1/oauth/gmail/callback?...` over the Unix socket. Session and unrelated
   cookies are not forwarded.
6. brain-mail consumes the transaction once, exchanges the code, validates the
   exact scopes and signed ID token, then atomically creates the Gmail account
   or rotates the credential of the reconnect target.
7. The browser is redirected to `/mail?gmail=connected`, `cancelled`, or
   `error`. The transaction cookie is cleared on every callback result.

The Next route graph does not import the service OAuth module, read the Google
client secret, contact Google's token endpoint, or receive access and refresh
tokens. The Google client secret and token exchange live only in brain-mail.

## Scope and token policy

The exact requested scopes are:

```text
openid
email
https://www.googleapis.com/auth/gmail.modify
```

Google documents `gmail.modify` as permission to read, compose, send, and modify
mail without immediate permanent deletion. It is a restricted scope. The flow
rejects missing, duplicate, or additional scopes instead of silently accepting
a broader grant. See [Google's Gmail scope table](https://developers.google.com/workspace/gmail/api/auth/scopes).

The authorization request uses `access_type=offline` and requires a refresh
token in the code exchange. Google can issue the refresh token only on the first
grant, so the flow currently requests consent for each new connection. See
[Google's web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

The access token and its expiry remain in memory only. Both token buffers are
wiped after the account sink finishes. Persistent state contains a versioned,
AES-256-GCM envelope with only:

- Google subject and email
- the exact granted scopes
- refresh token
- grant time

The envelope is authenticated against the Brain account ID, so it cannot be
moved to another account file. The account store must supply its existing
32-byte wrapping key and must wipe the opened refresh-token buffer after use.

## Security properties

- PKCE uses a unique 64-byte verifier and S256 challenge for every attempt.
- `state`, OpenID Connect `nonce`, issuer, audience, verified email, redirect
  URI, callback fields, and exact scopes are checked before persistence.
- Pending transactions are bounded, expire after ten minutes, and are consumed
  before the code exchange. A callback cannot be replayed.
- The transaction cookie is encrypted and has `__Host-`, `Secure`, `HttpOnly`,
  `SameSite=Lax`, `Path=/`, no `Domain`, and `Max-Age` no greater than 600.
- Callback code, state, provider descriptions, cookies, and tokens are never
  copied into public error bodies or result URLs.
- Token responses and callback inputs have byte limits.
- The client secret and transaction key are read from private systemd
  credentials with regular-file, owner, link-count, size, and permission checks.
- Google's signed ID token is verified with the official JWKS. See the
  [OpenID Connect reference](https://developers.google.com/identity/openid-connect/openid-connect).

Google recommends encrypted server-side token storage and full-featured browser
authorization. See [OAuth security best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

## Runtime contract

Non-secret brain-mail environment:

```text
BRAIN_PUBLIC_ORIGIN=<the exact public HTTPS origin, from /etc/brain/brain-mail.env>
GMAIL_OAUTH_CLIENT_ID=<Google Web application client id>
CREDENTIALS_DIRECTORY=<provided by systemd>
```

Private systemd credential names:

```text
gmail-oauth-client-secret   # UTF-8 bytes, no trailing newline
gmail-oauth-transaction-key # exactly 32 random bytes
```

Do not add `GMAIL_OAUTH_CLIENT_SECRET` or a transaction key to an environment
file. The unit should use `LoadCredential=` for both private files. Create the
transaction key as raw bytes, not hex or base64 text.

The OAuth start remains disabled while the adapter or durable account sink is
unavailable. The mail health endpoint and IMAP accounts continue to work. A
failed browser start returns to `/mail?gmail=error` instead of leaving the user
on a JSON error page.

With no `GMAIL_OAUTH_CLIENT_ID`, Gmail stays disabled and IMAP-only startup is
unchanged. Once an operator adds the Gmail drop-in, missing or invalid private
credentials fail service startup so a broken opt-in cannot look healthy.

Reconnect binds the target account ID into the encrypted one-time transaction.
The callback rotates only that Gmail account, and **the identity it matches on
is the Google subject alone**: a grant whose subject differs from the stored one
is refused as `account_already_exists`, and a grant whose subject matches is
accepted whatever address it carries. The stored `email` and `normalized_email`
are then overwritten from the new grant, so reconnecting a Google account whose
address has changed silently renames the account rather than refusing it. The
only guard on the incoming address is uniqueness — it may not collide with
another connected account. It preserves `createdAt`, updates `connectedAt`,
increments the credential version, and replaces the encrypted refresh token in
one SQLite transaction.

### Credential-gated systemd drop-in

The base unit contains none of these three Gmail settings. This keeps the Mail
service healthy for IMAP-only installations and prevents a missing optional
Google file from blocking socket activation.

After creating the Google Web client, place the two root-owned files at:

```text
/etc/brain/brain-mail-gmail-client-secret       # 0400, UTF-8, no newline
/etc/brain/brain-mail-gmail-transaction.key     # 0400, exactly 32 raw bytes
```

Then create
`/etc/systemd/system/brain-mail.service.d/90-gmail-oauth.conf`:

```ini
[Service]
Environment=GMAIL_OAUTH_CLIENT_ID=<google-web-client-id>
LoadCredential=gmail-oauth-client-secret:/etc/brain/brain-mail-gmail-client-secret
LoadCredential=gmail-oauth-transaction-key:/etc/brain/brain-mail-gmail-transaction.key
```

The operator must verify both file modes and lengths before running
`systemctl daemon-reload` and restarting `brain-mail.service`. Removing the
drop-in and reloading systemd disables Gmail without changing IMAP state.

## Google Cloud setup for a private test

1. Create a dedicated Google Cloud project and enable the Gmail API.
2. Configure the Google Auth Platform audience. Start with External / Testing
   and add only the accounts you will connect as test users.
3. Add the three exact scopes above to Data Access.
4. Create an OAuth client of type **Web application**.
5. Register this exact redirect URI:

   ```text
   https://brain.example.com/api/mail/oauth/google/callback
   ```

6. Install the client ID as non-secret configuration and the client secret via
   the systemd credential above.
7. Install the credential-gated systemd drop-in above and verify the private
   start/callback flow.

Google says Testing grants that include Gmail scopes expire after seven days,
including their refresh tokens. This mode is suitable for the first private
test, not a durable mailbox. See [Manage App Audience](https://support.google.com/cloud/answer/15549945).

Before public open-source users can connect through one centrally operated
Google OAuth client, `gmail.modify` requires Google's restricted-scope
verification. Server-side storage of restricted data can also require a
security assessment. See [OAuth verification requirements](https://support.google.com/cloud/answer/13464321).
For self-hosting, each installation can instead create and own its Google Cloud
OAuth credentials.

## Verification completed locally

- focused Gmail OAuth, proxy, credential, service-adapter, and envelope tests
- actual zero-byte HTML form POST behavior
- callback replay, wrong state, PKCE, redirect, scope, issuer, audience, nonce,
  missing refresh token, unsafe cookies, and secret-boundary cases
- `pnpm build:mail-service`
- exact runtime projection followed by a real service start from the projected
  tree, with Gmail disabled and no application `node_modules` access
- isolated CommonJS load of the built Gmail provider from `/tmp`
- generated third-party notices contain pinned `jose@6.2.9` and
  `imapflow@1.4.7`
- SQLite create, restart, mixed-provider uniqueness/cap, scoped deletion,
  reconnect rotation, corrupted-row isolation, and token-absence checks
- service endpoint dispatch with callback query/cookie/token log redaction

The mail build bundles the Gmail OAuth provider and `jose` into the immutable
artifact. It does not rely on Next's traced `node_modules` layout.
