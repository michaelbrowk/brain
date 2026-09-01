# Brain Mail SMTP egress: feasibility operations

- Status: local feasibility implementation; disabled by default
- Date: 2026-07-13
- Production impact: none until a separately reviewed Worker deployment and Brain configuration

## What this component does

DigitalOcean blocks outbound SMTP ports 465 and 587. The feasibility Worker opens one raw TCP connection to an already validated public IP and relays bytes over WebSocket. Brain still owns SMTP, STARTTLS, TLS certificate verification, original-hostname SNI, AUTH, and the message body.

The control envelope never contains a provider hostname, SMTP password, token, MIME metadata, or a request to “send mail”. On port 587 the pre-STARTTLS greeting and EHLO remain ordinary transport bytes and can contain hostnames; the Worker does not parse or log them. It accepts only a signed literal IPv4/IPv6 address on port 465 or 587.

```text
brain-mail
  -> WSS + Cloudflare Access + connection-local HMAC
  -> Cloudflare Worker raw byte relay
  -> TCP to signed literal IP:465/587

brain-mail -> Node TLS with original provider hostname/SNI -> SMTP provider
```

Implementation:

- Brain client: [`lib/mail/cloudflare-egress-client.ts`](../lib/mail/cloudflare-egress-client.ts)
- Worker: [`workers/mail-egress/src/index.ts`](../workers/mail-egress/src/index.ts)
- Wire validation: [`workers/mail-egress/src/protocol.ts`](../workers/mail-egress/src/protocol.ts)

## Fail-closed defaults

1. `MAIL_EGRESS_ENABLED` defaults to `false`; the tunnel route returns `404`.
2. `MAIL_EGRESS_HMAC_KEY` is a 32-byte secret stored as canonical unpadded base64url. It is never committed or placed in a URL.
3. A production hostname must be protected by Cloudflare Access Service Auth. Access credentials travel only in headers.
4. URLs with credentials, query strings, or fragments are rejected.
5. The unauthenticated challenge expires after five seconds. A signed attempt cannot exceed its own deadline or 60 seconds from WebSocket creation.
6. One connection has one TCP socket, no retry, no reconnect, no fallback hostname, and no ambient proxy.
7. Limits are 16 KiB per DATA frame, 2 MiB Brain-to-TCP, and 128 KiB TCP-to-Brain, with one unacknowledged frame per direction.
8. WebSocket compression is disabled. Brain caps the WebSocket parser before a frame is copied.
9. Normal completion requires explicit EOF acknowledgement in both directions. An ordinary early WebSocket close is truncation.
   A provider read reset is held fail-closed until the authenticated client has
   received the complete terminal SMTP reply and closes its write side; without
   that client EOF the session reaches `deadline_exceeded` instead of succeeding.
10. Neither side logs payloads, credentials, authorization envelopes, or target query parameters.
11. Worker observability is disabled in the feasibility config; a later metrics design must remain payload-free and must not retain request query strings.

## Local verification

From the repository root:

```bash
pnpm check
pnpm exec eslint \
  lib/mail/cloudflare-egress-client.ts \
  lib/mail/cloudflare-egress-client.test.ts \
  scripts/mail-egress-live-probe.ts \
  scripts/mail-egress-live-probe.test.ts \
  workers/mail-egress/src/index.ts \
  workers/mail-egress/src/index.test.ts
pnpm --dir workers/mail-egress bundle
```

`pnpm lint` is clean repository-wide and is one of the steps `pnpm check` runs,
so the changed TypeScript files above have to pass it like everything else.

`bundle` is a Wrangler dry run. It creates a local build artifact but does not deploy a Worker.

## Live transport probe without mailbox credentials

The opt-in probe contains no `AUTH`, `MAIL FROM`, `RCPT TO`, or `DATA` path. It
checks implicit TLS on 465, greeting/EHLO/STARTTLS/inner TLS on 587, original
hostname SNI and certificate validation, then proves that a wrong hostname is
rejected before authentication. Raw SMTP replies are parsed within fixed limits
and are never printed.

This is credentialless transport and shutdown evidence. It does not prove a
1 MiB transaction or Cloudflare Free resource use, authenticated provider
acceptance, or a production SMTP-engine integration. Those preview gates remain
open and must be recorded separately.

Run it only against a separately deployed, short-lived preview:

```bash
BRAIN_MAIL_EGRESS_LIVE=1 \
BRAIN_MAIL_EGRESS_URL=wss://<preview-host>/v1/tunnel \
BRAIN_MAIL_EGRESS_HMAC_KEY_FILE=/absolute/path/to/one-time-key.json \
BRAIN_MAIL_EGRESS_SMTP_HOST=<smtp-provider-hostname> \
BRAIN_MAIL_EGRESS_SMTP_FAMILY=4 \
pnpm probe:mail-egress
```

The dedicated command fails unless `BRAIN_MAIL_EGRESS_LIVE=1` is present. The
ordinary unit-test suite still skips these network tests, so CI never contacts a
real provider.

The key file is also the input to Wrangler's `--secrets-file`; generate and
store the key once instead of copying it. It must be a regular file owned by the
current user with exact mode `0600` and strict JSON shape
`{"MAIL_EGRESS_HMAC_KEY":"<canonical 32-byte base64url key>"}`.
Never put the key itself in an environment variable or shell history. The probe
rejects a literal key and also rejects simultaneous key and key-file settings.

Set both `BRAIN_MAIL_EGRESS_ACCESS_CLIENT_ID` and
`BRAIN_MAIL_EGRESS_ACCESS_CLIENT_SECRET` when Cloudflare Access protects the
preview. `BRAIN_MAIL_EGRESS_SMTP_ADDRESS` optionally selects one address from
the live DNS answer set. Repeat with family `6` only when the provider publishes
AAAA records. Set `BRAIN_MAIL_EGRESS_HOLD_SECONDS=31` to keep the relay open for
31 seconds with one bounded `NOOP` every five seconds; the default is no hold.
The probe refuses to start unless the signed DNS lifetime also leaves ten
seconds for teardown.

The relay path enforces an idle timeout that Cloudflare does not publish as a
number, and that unpublished limit is the reason the hold is paced at all:
without bidirectional activity every few seconds the next command lands on a
connection that is already closed. A `NOOP` every five seconds is the interval
that satisfies it with margin, which is why the pacing is fixed at five seconds
however long the hold is. What a
passing hold demonstrates is a bounded relay session — longer than 30 seconds
under continuous activity — and neither indefinite silent idle nor production
readiness. It does not isolate whether the close is at the Cloudflare WebSocket
edge or at its outbound TCP socket; run the probe against your own preview to
see where yours stands.

The no-hold IPv4 suite covers both 465 and 587, and a pass means all of it:
original hostname SNI and certificate validation succeeded, STARTTLS upgraded
in place, the wrong-hostname canary failed before authentication, and normal
post-`QUIT` resets completed only after the client had parsed the full `221`.
The probe sends no `AUTH`, `MAIL FROM`, `RCPT TO`, or `DATA` commands.

An HMAC-only preview is permitted only for a short, supervised feasibility
probe and uses a one-time key. It is not a production option. Production
requires Cloudflare Access Service Auth in addition to HMAC. Publishing a
disabled new version or moving an alias does not disable an older versioned
preview URL. Reliable cleanup means deleting the dedicated preview Worker or
disabling Preview URLs, then treating that HMAC key as compromised and never
reusing it. Do not run the delete command as part of the probe.

## Preview gate

A preview is allowed only after local checks and stacked PR CI are green. It must use a new random HMAC key. HMAC-only preview exposure is acceptable only for a short, supervised feasibility probe; production requires Cloudflare Access before the route is enabled.

The preview must prove all of the following without sending credentials until TLS is verified:

- literal IPv4 to port 465;
- literal IPv6 to port 465, when the provider publishes IPv6;
- port 587 greeting, EHLO, STARTTLS, and inner TLS;
- original-hostname SNI and certificate verification inside Brain;
- invalid certificate/hostname fails before `AUTH`;
- a relay session longer than 30 seconds stays alive with bounded activity
  below the unpublished idle cutoff;
- a worst-case 1 MiB MIME transaction remains inside Cloudflare Free CPU and memory limits;
- the real SMTP provider accepts Cloudflare egress addresses;
- disconnect and both EOF directions fail closed without a retry.

Do not use a real mailbox password for the transport probe. First prove TCP and TLS with a test provider/account, then separately approve an authenticated send canary.

## Production gate and rollback

Three canary gates remain open: a worst-case 1 MiB MIME transaction, Cloudflare
Free CPU and memory measurements for that transaction, and authenticated SMTP
provider acceptance from Cloudflare egress.

Production remains a No-Go until the preview evidence is attached to the PR and reviewed. Enabling production changes two independent controls: Cloudflare Access policy plus the Worker's `MAIL_EGRESS_ENABLED=true`, and the separately disabled Brain runtime described below.

### Brain runtime contract for one supervised canary

The base `brain-mail.service` contains no SMTP egress settings. A dark deploy
therefore cannot start the SMTP worker, expose custom-domain send capability,
or read optional SMTP credentials.

The release artifact contains the reviewed, disabled template and the installer
projects it to
`/opt/brain/share/brain-mail.service.d/90-smtp-egress.conf.example`. Before a
canary, copy it to
`/etc/systemd/system/brain-mail.service.d/90-smtp-egress.conf`, replace the
`example.invalid` hostname with the exact Cloudflare Access-protected hostname,
and leave the path exactly `/v1/tunnel`.

The effective drop-in must contain these non-secret settings:

```ini
[Service]
Environment=BRAIN_MAIL_SMTP_EGRESS_ENABLED=1
Environment=BRAIN_MAIL_SMTP_EGRESS_URL=wss://<access-protected-host>/v1/tunnel
Environment=BRAIN_MAIL_SMTP_EGRESS_ACCESS_ENABLED=1
```

Create these root-owned source files with mode `0400`, one hard link, no
newline, and no symlink. Never place their values in an environment file,
command line, shell history, repository, or URL:

```text
/etc/brain/brain-mail-smtp-egress-hmac.key          # 43 canonical base64url characters
/etc/brain/brain-mail-smtp-egress-access-client-id  # Cloudflare Access service-token id
/etc/brain/brain-mail-smtp-egress-access-client-secret
```

The drop-in loads them under the exact private systemd credential names below.
Systemd supplies `CREDENTIALS_DIRECTORY`; operators must not set or override it:

```ini
LoadCredential=smtp-egress-hmac-key:/etc/brain/brain-mail-smtp-egress-hmac.key
LoadCredential=smtp-egress-access-client-id:/etc/brain/brain-mail-smtp-egress-access-client-id
LoadCredential=smtp-egress-access-client-secret:/etc/brain/brain-mail-smtp-egress-access-client-secret
```

Before enabling, verify the effective unit and files without printing secret
contents, then reload and restart only `brain-mail.service`:

```bash
sudo test "$(stat -c '%U:%G %a %F %h' /etc/brain/brain-mail-smtp-egress-hmac.key)" = "root:root 400 regular file 1"
sudo test "$(stat -c '%s' /etc/brain/brain-mail-smtp-egress-hmac.key)" = 43
sudo grep -Eq '^[A-Za-z0-9_-]{43}$' /etc/brain/brain-mail-smtp-egress-hmac.key
sudo test "$(stat -c '%U:%G %a %F %h' /etc/brain/brain-mail-smtp-egress-access-client-id)" = "root:root 400 regular file 1"
sudo test "$(stat -c '%U:%G %a %F %h' /etc/brain/brain-mail-smtp-egress-access-client-secret)" = "root:root 400 regular file 1"
sudo systemctl daemon-reload
sudo systemd-analyze verify brain-mail.service
sudo systemctl restart brain-mail.service
sudo systemctl is-active --quiet brain-mail.service
```

The production SMTP adapter must preserve the probe's shutdown order: validate
the terminal SMTP reply first, then end the raw relay. Ending the relay before a
complete reply must remain an application failure even if the WebSocket itself
closes cleanly.

Brain-side rollback is immediate, does not touch mailbox data, and does not
re-send queued or ambiguous operations:

1. remove `/etc/systemd/system/brain-mail.service.d/90-smtp-egress.conf`;
2. run `systemctl daemon-reload` and restart only `brain-mail.service`;
3. verify the effective unit no longer contains `BRAIN_MAIL_SMTP_EGRESS_` or
   the three `smtp-egress-` credential names;
4. verify custom-domain send readiness is disabled while IMAP/Gmail stay
   healthy;
5. disable the Worker route or set its separate `MAIL_EGRESS_ENABLED=false`;
6. rotate the HMAC and Access service token if exposure is suspected;
7. never fall back to direct DigitalOcean SMTP or retry an ambiguous SMTP handoff.

Removing the Brain drop-in is sufficient for the application rollback even if
the protected Worker stays online: no Brain process retains the credentials or
route. Source credential files may remain root-only during investigation, but
must be deleted after rollback if the canary is abandoned.

No Worker deployment, DNS route, Access policy, secret, or production
configuration is created merely by installing this dark release.
