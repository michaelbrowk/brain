# Brain Mail: service boundary and safety contract

- Status: accepted design gate plus repository-staged production candidate
- Date: 2026-07-20
- Scope: custom-domain IMAP and SMTP, including Gmail-compatible accounts but not limited to Gmail

Implementation status (2026-07-20): the account-connect and local
multi-account slices are staged in the repository, but are not installed or
enabled in production. The service supports up to three custom-domain IMAP
accounts through a redacted `/v2/accounts` API, encrypted per-account
credentials in `local.sqlite3`, verified TLS/STARTTLS provisioning, scoped
disconnect, and the Brain Settings and `/mail` surfaces. A legacy encrypted
`account.v1.json` is migrated transactionally on first start.

The Gmail path now includes OAuth plumbing, bounded initial and history sync,
per-account message caches, list/reader APIs, system mailbox actions,
compose/reply, a durable idempotent outbox, Gmail API send, serialized
background refresh, isolated MIME parsing, sanitized text/HTML rendering, and
private streamed attachment downloads. This remains repository and test
evidence for the new content path until the exact production artifact and a
read-only live mailbox canary pass.

The first custom-domain receive slice is also repository-staged. It connects
through the same trusted, encrypted account binding and verified TLS session,
then publishes Inbox metadata for at most the newest 200 messages in bounded
pages of 20. Its cache identity is `(accountId, Inbox, UIDVALIDITY, UID)` and
each IMAP message is deliberately represented as one Brain thread until
conversation grouping is implemented. New UIDs are polled incrementally;
UIDVALIDITY changes, definite expunges, and the tenth incremental poll rebuild
the bounded snapshot. Message bodies, inline images, attachments, and cached
remote images now reach the reader through the same isolated content pipeline
the Gmail path uses: the content coordinator records a demand when the owner
opens a message (and for the newest three Inbox messages on the background
schedule), a provider-neutral IMAP content source opens one bounded read-only
session through the same `ImapFlowReadSessionFactory` that metadata sync
uses, verifies that the mailbox UIDVALIDITY still matches the cached
`(UIDVALIDITY, UID)` identity, streams `BODY.PEEK[]` in literal-sized slices
straight into the staged incoming blob under the 40 MiB raw cap and the lease
deadline, and closes the session before the blob is handed to the isolated
MIME parser. A UIDVALIDITY change or vanished UID is a permanent content
failure, an authentication or binding failure surfaces as reauthentication
required, and transport failures stay transient. The fetch is flag-neutral, the
password never leaves the session factory, and no new egress host is involved
because the account's IMAP endpoint was already allowed for sync.

Thread mutations now run on the same session factory. Marking read or starred
is a `UID STORE` of `\Seen` or `\Flagged` on a writable Inbox lock; archive,
trash and junk are a `UID MOVE` (RFC 6851), and each has its inverse back into
the Inbox. Because one IMAP message is one Brain thread, a thread mutation
touches exactly one message.

**A server that does not advertise `MOVE` is refused, not emulated.** ImapFlow
emulates a missing MOVE with COPY, `\Deleted` and EXPUNGE, and returns the
COPY's result whatever the delete did — so an archive can be reported as done
with the message still in the Inbox. The EXPUNGE is the worse half: ImapFlow
picks `UID EXPUNGE` only where UIDPLUS is advertised, and a host with neither
MOVE nor UIDPLUS is the same generation of host, so the emulation sends a bare
EXPUNGE, which removes every `\Deleted` message in the Inbox rather than the one
being moved. Mail another client flagged and never expunged would go with it.
The adapter therefore reads `capabilities` off the session and refuses the
relocation with `mail_provider_mutation_unsupported` when MOVE is absent.
Flags are unaffected — a STORE happens where the message already is.

**A MOVE the server answers NO to is the same refusal.** LIST named the folder
and the server still would not put a message in it — its layout or its ACLs,
as true on the next press as on this one — so ImapFlow's `false` maps to
`mail_provider_mutation_unsupported` rather than to a retryable
`mail_provider_unavailable`, which is kept for a session that died under the
command with no answer at all. Flags read the SELECT response before a STORE
is sent: a mailbox the server opened READ-ONLY, or a PERMANENTFLAGS set that
admits neither the flag nor `\*`, is refused with the same code before
anything goes on the wire. ImapFlow would return `false` without sending the
STORE, and that used to read as an outage with a "Try again" that could never
succeed. Removing a flag is always sent, as ImapFlow sends it: clearing what
the server never kept is harmless.

The destination mailbox is discovered, never assumed. `LIST` carries the
SPECIAL-USE and XLIST attributes as `specialUse`, and the role is resolved in
tiers: `\Archive`, then a mailbox named `Archive` or `Archives`, then
`\All`, then `All Mail`; `\Trash` then `Trash` / `Deleted Items` / `Deleted
Messages`; `\Junk` then `Junk` / `Spam` / `Junk E-mail`. A name counts only at
the account root or directly under the Inbox, where a mail client creates such
a folder — a `Projects/2019/Archive` is a folder about something else, and
without the depth rule it wins the tier and receives mail the reader archived. Unselectable
mailboxes and the Inbox itself are never candidates, two folders answering to
one name are a refusal rather than a choice, so the answer does not depend on
LIST order, and a localized name is not matched. A server
that advertises nothing and names nothing has no mailbox for that role, and the
mutation is refused with `mail_provider_mutation_unsupported` — a 409, not a
retryable 503, because retrying cannot conjure a folder. Nothing is moved on a
refusal.

A MOVE changes the message's UID, so the adapter remembers where it put each
thread for its own lifetime and keeps the Brain thread id stable across the
move. The destination UID comes from UIDPLUS `COPYUID` when the server offers
it and from a Message-ID `SEARCH` in the destination when it does not — and
that search must return exactly one hit. A Message-ID is not unique inside a
mailbox, and returning the wrong copy means the next undo puts a different
message back in the Inbox, so 0 or 2+ hits leave the thread with no handle.

**The Inbox listing repairs itself without that memory. Undo does not.** The
MOVE shrinks the Inbox, the next incremental poll sees a lower EXISTS, rejects
its cursor, and the full rebuild that follows does not list the moved message.
Undo needs the handle, so a runtime restart between the archive and the press
leaves the message in a folder Brain does not yet list, with no way back from
Brain. The window is seconds long and the map is the only record, which makes
the hole narrow but real: a durable relocation record is what closes it. The
press itself is answered with `mail_provider_thread_stale` — `409
mail_thread_stale` at the service boundary — rather than a retryable 503,
because no retry brings the handle back. The same code covers a thread another
client moved or expunged, or whose mailbox was recreated under a new
UIDVALIDITY, so the surface can say the undo is no longer available instead of
offering a "Try again" that cannot work; the next sync rebuilds the list
without the moved message.

Each mutation opens its own bounded session, so a section Done over N threads
is 2N sequential connect-and-authenticate cycles (archive, then mark read) and
takes as long as those logins take. The surface's undo window is a flat ten
seconds that starts when the run settles rather than when the button was
pressed because of it, and the first refusal on an account stops the loop for
that account instead of spending a login per thread on an answer that cannot
change. It is correct and
serialized, but it is the first thing to watch on a server that throttles
logins; a pooled session is the fix if it bites.

`mailboxes` stays Inbox-only for custom-domain accounts. The mutations move
mail out of the Inbox; giving those folders somewhere to be browsed is a
separate slice. This has no production or provider canary claim yet. See
[`mail-account-connect-operations.md`](./mail-account-connect-operations.md)
and [`gmail-oauth.md`](./gmail-oauth.md).

The account-local outbox database also carries an active provider-neutral
draft API foundation. Private Unix-socket routes support create, list, read,
patch, delete, and atomic draft send, with a same-origin Next.js bridge for the
Brain client. There is still no provider Drafts-folder sync and no attachment
writer in this slice: `MailSendInput` carries no attachment list and the draft
API stores none. Existing direct `/v1/send` behavior
is unchanged.

## 1. Product constraint

Brain Mail must accept ordinary custom-domain mailboxes. A provider-specific Gmail client does not meet the product request. The first complete slice therefore uses the standard protocols:

- IMAP for mailbox listing, message sync, flags, and Sent copy storage
- SMTP Submission for outgoing messages
- A provider-neutral core so provider quirks stay inside adapters

The reader keeps the Brain rule that text is the main interface. Mail bodies and attachments do not become Brain notes automatically. They are not written into the notes Git repository. A later explicit `Save to Brain` action can create a normal note through `lib/store`.

### Reply and forward contract

- Reply and Reply All are derived from the latest message. A bounded, valid
  `Reply-To` mailbox list takes precedence over `From`; malformed optional
  values fall back to `From` instead of blocking mailbox sync. The active
  account and provider-equivalent forms of its verified primary address are
  excluded. Other recipients are deduplicated across To and Cc only by exact,
  case-insensitive mailbox address. Brain never guesses that an unrelated
  custom address is a self alias. Bcc is never inferred.
- Both reply actions submit the existing provider message ID. The Mail service,
  not the browser, resolves and owns `In-Reply-To`, `References`, and the
  provider thread ID.
- Forward is a new non-threaded compose operation. It includes only bounded,
  inert plain-text context from the latest message; it does not reuse the
  provider thread ID.
- Outbound attachments are not implemented in this slice. A forward with
  original attachments says so in the composer and does not claim or imply
  that those files will be sent.

The `replyTo` response field is an additive rollout. Deploy the Brain
frontend/proxy first: the new decoder accepts both legacy responses without
`replyTo` and current responses with it. Restart the Mail service only after
that version is serving. For rollback, reverse the order: restore the legacy
Mail service before restoring the legacy Brain frontend/proxy. This prevents
the older exact response decoder from rejecting a newer message payload.

The original PR0 shipped contracts only. Later repository-staged slices now
include the service, storage, account UI, and the bounded Gmail client described
above. None of those slices changes production until the separate rollout gate
passes.

## 2. Decisions

| Area | PR0 decision |
| --- | --- |
| Account support | Standard IMAP plus SMTP Submission, not Gmail-only |
| Process boundary | An isolated `brain-mail` service, reached only through a root/systemd-owned Unix socket restricted to one Brain client group |
| Credentials | Opaque secret and transport-binding references in core state. Secret bytes exist only inside the isolated protocol-adapter edge |
| Protocol auth | IMAP and SMTP keep separate usernames and opaque credential references |
| Sync identity | `(accountId, mailboxId, UIDVALIDITY, UID)` |
| Sync commit | Fetched rows and the resume cursor commit atomically. Publish a generation only after a complete sync |
| Send guarantee | At-most-one automatic SMTP handoff after delivery becomes possible |
| SMTP ambiguity | Enter `delivery_unknown`. Never retry automatically |
| Partial SMTP delivery | Persist every accepted and rejected recipient. Never retry the original envelope |
| Sent folder | SMTP acceptance and IMAP APPEND are separate durable states |
| SMTP egress | Brain owns SMTP and end-to-end TLS. Cloudflare may relay authenticated raw bytes only |
| Storage | Separate local durable state from reconstructible cache state |
| HTML | Sanitized, remote content blocked, sandboxed, strict CSP |
| Attachments | Download by default. Only verified CID raster images may render inline |
| Sender-icon egress | Deliberate, documented exception: the Brain app, never the mail service, may resolve DNS and open TLS to a sender's own domain to fetch its `/favicon.ico`, server-side and SSRF-guarded, cached on disk under an LRU cap. Sender domains are the only data that leaves; message content, addresses, and subjects never do |
| Capacity | Separate receive, 1 MiB MVP send, relay-frame, parser, connection, queue, cache, temp, WAL, and process limits sized for a handful of accounts on a small host shared with the rest of Brain |
| PR0 dependencies | None added |

## 3. Build versus buy

The implementation keeps protocol code behind Brain-owned ports:

- [ImapFlow](https://imapflow.com/) for IMAP sync and raw-message fetch
- a narrow first-party IMAP APPEND adapter, because ImapFlow exposes no documented callback after the literal continuation and before the first literal byte
- a narrow first-party SMTP protocol adapter over a Brain-owned byte transport
- Node's public [`node:net`](https://nodejs.org/api/net.html) and [`node:tls`](https://nodejs.org/api/tls.html) APIs for direct egress where the host permits it
- an authenticated Cloudflare WebSocket-to-TCP byte relay for SMTP egress from DigitalOcean
- only the streaming [MailParser](https://nodemailer.com/extras/mailparser) part of Nodemailer for MIME parsing
- [htmlparser2](https://github.com/fb55/htmlparser2) for the bounded,
  event-based allowlist sanitizer; the Mail worker never constructs an
  unbounded browser DOM
- Node 22's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) for the service-owned account database

[EmailEngine](https://emailengine.app/) is not selected. It is a separate email API server with its own Redis, deployment, licensing, and operating surface. That is too much permanent overhead for a single-user self-hosted deployment. Its documentation remains useful as a protocol behavior reference. Reconsider it only if maintaining provider adapters becomes more expensive than running another service.

Nodemailer's high-level SMTP transport is not selected. Brain's at-most-once handoff requires an exact awaited hook after the server's `354` reply and before the first DATA byte; a high-level `sendMail` boundary cannot prove that ordering. The first-party adapter is intentionally narrow: one physical connection per authenticated session; bounded greeting and multiline-reply parsing; EHLO, mandatory STARTTLS where configured, authentication, MAIL FROM, RCPT TO, DATA with dot-stuffing, and QUIT; strict deadlines and no pooling, automatic reconnect, ambient proxy, or protocol logging. Its byte transport may be direct or an explicitly authenticated relay, but SMTP parsing and the DATA barrier always stay in Brain. PR0 defines this contract but implements no network adapter.

The first local account store uses Node 22's built-in `node:sqlite`. It gives
this slice transactions, foreign keys, a busy timeout, WAL checkpoints, and
secure deletion without introducing a native addon whose ABI could differ on
the production host. Node still marks this API experimental in Node 22, so the
Mail service and its exact-artifact smoke command suppress only that named
warning with `--disable-warning=ExperimentalWarning`; broad warning suppression
is forbidden. The smoke reads the service's stderr as records through
[`mail-log-lines.mjs`](../scripts/mail-log-lines.mjs): a line that is not one
— a DeprecationWarning from a minor Node release, which that flag does not
cover — fails by name with the line quoted rather than as a SyntaxError from
inside `JSON.parse`, and records compare as a multiset, so a second provoked
refusal cannot make the check depend on the order two requests raced in. A
future backup implementation must use the SQLite backup API or a checkpointed
snapshot and receive its own exact production-artifact proof.

No listed library is added by PR0.

## 4. Trust and process boundary

Future runtime shape:

```text
browser
  |
  | existing Brain HTTPS session
  v
brain.service                 user: brain
  |
  | /run/brain-mail/brain-mail.sock
  | root/systemd-owned socket, group brain-mail-client, mode 0660
  v
brain-mail.service            user: brain-mail
  |             |             | private bounded IPC
  | IMAP TLS    | private FS  v
  v             v          brain-mail-mime worker
IMAP provider   SQLite/blobs  user: brain-mail-mime
                              no network, no credential mount

brain-mail -- WSS + HMAC/Access --> Cloudflare byte relay -- raw TCP --> SMTP
     \________________ Node TLS with original SNI to provider ______________/

systemd-wrapped key -> one account credential inside protocol adapter
```

The service socket is not bound to TCP. Nginx and Cloudflare never expose it. A root-owned systemd socket unit creates `/run/brain-mail/brain-mail.sock` with group `brain-mail-client` and mode `0660`; only the `brain` service account belongs to that unique client group. The mail process accepts the inherited socket rather than replacing it. The protocol is bounded HTTP over the Unix-domain socket with strict body, header, request-count, and deadline limits. Node 22 has no public `SO_PEERCRED` API, so the design does not promise a literal peer-UID check or add a native addon solely for one. If a second application ever joins the group, systemd `LoadCredential=` may supply an optional short-lived HMAC capability with nonce/replay rejection as defense in depth; it is not a substitute for the socket ACL.

PR2 fixes the service-shell limits below. The process fails closed unless systemd passes exactly one descriptor named `brain-mail` as file descriptor 3. It never binds a path, listens on TCP, or unlinks the socket.

The immutable Brain release remains `root:brain` and is never made readable by the `brain-mail` identity. Immediately before service start, a root-owned helper resolves one immutable release and projects exactly 60 allowlisted compiled Mail files across four allowlisted directories into `/run/brain-mail-runtime/current`. The frozen release also carries generated third-party notices. The set includes twelve Gmail OAuth, API, sync, send, and content modules under `providers/gmail`, the custom-domain Inbox sync, thread-mutation, and raw-message content adapter under `providers/imap`, plus the provider-neutral message cache, background sync, durable outbox, dormant draft contracts, local search, content cache, bounded raster inspector, MIME client modules, and the optional SMTP runtime bundle. ImapFlow, `ws`, and the SMTP transport are bundled into audited runtime artifacts, and `jose` is bundled into the Gmail OAuth module, so the isolated runtime does not read the application `node_modules` tree. That projection is `root:brain-mail-runtime`, directories are `0550`, files are `0440`, and the service has read-only membership in that dedicated group. The same group receives execute-only traversal on `/opt/brain` so the process can reach the separately root-owned Node runtime, but it cannot list the directory or traverse the `root:brain` release and notes directories. `/etc/brain` and `/opt/brain/notes` are also hidden from the Mail namespace. The main Brain unit remains unchanged until the staged `brain-mail-client` drop-in is deliberately installed through the operations gate.

| Boundary | Limit |
| --- | ---: |
| Header bytes | 8 KiB |
| Header count | 32 |
| JSON body bytes | 16 KiB |
| Header deadline | 2 seconds |
| Absolute request deadline | 5 seconds |
| Account connect verification budget | 10 seconds |
| Provider sync/action/send budget | 10 seconds |
| Keep-alive timeout | 2 seconds |
| Requests per connection | 32 |
| Concurrent connections | 16 |

The versioned service API keeps `GET`, `POST`, and `DELETE /v1/account` for the
one-account compatibility path and adds `GET`/`POST /v2/accounts` plus
`PATCH`/`DELETE /v2/accounts/:accountId`. Account responses are redacted: they
contain provider and endpoint metadata but never a password, token,
ciphertext, wrapping-key state, Google identifier, or raw provider response.
The v2 list is capped at three accounts, email uniqueness is global after
normalization, and IMAP `POST` still validates DNS, verified implicit TLS or
mandatory STARTTLS, observed peer equality, and authentication before saving.
An edit may omit the password to keep the saved secret; first setup may not.
`DELETE` is local-only, removes only the selected account and its cache, and
never opens IMAP or mutates the remote mailbox. Once more than one account
exists, both legacy v1 mutations fail with `409 account_selection_required`
instead of guessing a target. Reservations still carry no account
configuration, provider endpoint, credential reference, message, or mailbox
content. Health reports local schema version `2`. The repository-staged Gmail
message path exists. Once its runtime is wired to an account, health reports
`degraded` until a private configuration and real canary prove readiness; it
does not claim provider success from local wiring alone.
The systemd definitions, projector, key tool, and Brain client drop-in are
staged in the repository; installation and enabling remain a separate
fail-closed operations gate.

The 5/10-second budgets apply while an account mutation waits for admission and while DNS/TLS/auth is cancellable. Once an atomic local commit starts, the HTTP handler waits for its true result instead of returning a false timeout followed by a late write. Disconnect atomically renames the active cache out of the live namespace, removes account state, and fsyncs the directory; bounded recursive deletion of the staged cache continues in the background and is retried at service startup. Thus a large cache cannot hold the API mutex for the full physical deletion, and no staged cache is ever treated as active mail state.

The Brain process sends account IDs, operation IDs, idempotency keys, mailbox IDs, and content hashes. The mail service owns remote paths and sync cursors. Brain never sends a password, refresh token, or access token during normal operation. Account setup hands each IMAP or SMTP secret to a narrow provisioning path and receives a separate opaque `{ id, version }` reference. The two references may deliberately point to the same encrypted secret, but the data model never assumes that they do.

A systemd credential supplies only the 32-byte wrapping key outside releases.
In schema v2, account metadata lives in `local.sqlite3`; each password is a
separate AES-256-GCM credential row authenticated against its account ID,
credential kind, opaque credential reference, and version. Provisioning keeps
separate credential and transport-binding references and returns only redacted
account metadata. On first start, the service decrypts the legacy
`account.v1.json`, preserves its account ID and reference versions, commits the
account and credential in one SQLite transaction, then renames the old envelope
to `account.v1.migrated.json`. A durable migration marker plus crash recovery
makes this idempotent. Disconnect does not need to decrypt the selected
credential, so a lost key or corrupt ciphertext cannot trap local deletion.
The adapter owns the connection policy: complete-set DNS validation, a
validated literal IP, original hostname for SNI and certificate verification,
mandatory implicit TLS or STARTTLS, logging disabled, ambient proxy use
disabled, and direct transport. ImapFlow receives the password only inside this
adapter edge; tests prove that STARTTLS occurs before LOGIN and that PREAUTH
cannot falsely validate an untested password. Owned request, plaintext, key,
IV, tag, ciphertext, and decoded-password buffers are overwritten on all
handled exits. JavaScript strings and internal third-party-library copies
cannot be reliably overwritten, so process isolation and disabled logging
remain primary controls.

For SMTP through Cloudflare, Brain signs a fresh challenge-bound request for one validated literal public IP on port 465 or 587. The Worker opens no TCP socket before HMAC verification. It opens one raw socket with TLS disabled, never reconnects, and relays bounded sequenced frames. Node 22 wraps the relay-backed Duplex with `tls.connect({ servername: originalHostname, rejectUnauthorized: true })`, so the SMTP TLS session terminates in Brain and at the provider. On port 587 only the greeting, EHLO, and STARTTLS command cross the relay before the inner TLS handshake. AUTH and message bytes cross only inside that verified TLS session. If Cloudflare reports a remote address it must equal the signed literal target; a null value is recorded honestly and never turned into observed-peer evidence. The factory overwrites its owned temporary buffer after session creation; process isolation remains the primary control because third-party libraries can create copies. Rotation increments reference and binding versions and invalidates stale workers. The parser unit disables core dumps and never mounts the wrapping key into the parser worker.

MIME parsing and HTML sanitization run in a separate bounded worker identity. Immediately before IPC, an exact validator projects only the operation ID, raw-blob hash and size, deadline, and named parser budgets. Unknown, nested, accessor-backed, endpoint, socket, credential-reference, and secret fields cannot cross the boundary. The worker has no outbound network and no access to the service credential directory or durable local database.

## 5. Filesystem and data classes

Current repository-staged account and Gmail cache layout, plus future protocol
storage:

```text
/var/lib/brain-mail/
  account.v1.json     legacy encrypted bootstrap; present only before migration
  account.v1.migrated.json  inert migration archive until that account is deleted
  cache/<accountId>/  account-scoped local Mail state
    messages.sqlite3 rebuildable Gmail thread/message cache, sync cursor, and
                     local header/preview FTS5 index
    outbox.sqlite3   durable idempotent send operations and MIME payloads,
                     plus dormant local draft records and mutation receipts
  local.sqlite3       current account metadata and encrypted credentials
  cache.sqlite3       future protocol-neutral mailbox index
  blobs/
    local/            durable locally-created MIME and draft attachments
    cache/            rebuildable fetched MIME and attachments
/run/brain-mail/
  brain-mail.sock
```

`local.sqlite3` is the current authoritative account store. The migration from
`account.v1.json` runs automatically and transactionally before the service
accepts account requests. The per-account Gmail message cache is rebuildable.
The outbox and its draft tables are durable local state and must not be
described as reconstructible mailbox cache even though account-scoped
disconnect removes the complete local account directory. Protocol-neutral
`cache.sqlite3` and blob stores remain future work.

Rules:

1. `/var/lib/brain-mail` is owned by `brain-mail:brain-mail` with mode `0700`.
2. `/run/brain-mail` is root-owned with group `brain-mail-client` and mode `0710`; `brain-mail.sock` uses group `brain-mail-client` and mode `0660`, so the Brain client can traverse only to the socket.
3. Databases never live inside an immutable Brain release.
4. `local.sqlite3`, every account-local `outbox.sqlite3`, and `blobs/local` are backed up together from one consistent snapshot.
5. `cache.sqlite3` and `blobs/cache` may be deleted and rebuilt from IMAP.
6. Blob names are content hashes, not sender filenames.
7. A database row becomes visible only after its blob is durably written and verified.
8. Garbage collection never removes a blob referenced by local state or an active cache generation.
9. Mail data never enters `/opt/brain/notes` unless the user explicitly saves a message as a Brain page.

### Draft API contract

Draft IDs and mutation IDs are random UUID-based values created by the client.
A draft keeps raw `to`, `cc`, `bcc`, subject, and text fields, so a partially
typed address is valid draft data. Address syntax is checked only at the send
handoff.

Every accepted patch or send mutation advances the revision, including a patch
whose visible value is unchanged. A repeated mutation ID with the same exact
fingerprint returns its original applied revision. Reusing that ID with changed
content fails. A stale revision cannot apply after an old receipt has aged out.
The database retains at most 128 recent mutation receipts per account. Its
separate immutable create fingerprint lets a retried create return the current
draft even after later edits without mistaking those edits for changed input.

Each account may retain 100 active drafts. Sent tombstones do not consume that
quota: the database separately retains at most the newest 100 tombstones, and
never for longer than 24 hours. One text body is capped at 1 MiB. Draft bodies
and reserved local attachment bytes are capped at 128 MiB in aggregate. The
attachment table is only a storage contract in this slice. No code can add an
attachment yet.

The send operation link deliberately has no foreign key to the retained outbox.
SQLite triggers map outbox `queued` and `sending` to draft `submitting`, then
map terminal send states to `sent`, `failed`, or `delivery_unknown` in the same
transaction as the outbox update. A sent draft keeps a 24-hour tombstone but
scrubs raw addresses, subject, body, and attachment rows immediately. If that
linked update cannot commit, the outbox state change rolls back too.

A draft stores raw address text, so exactly one module turns that text into
recipients: `lib/mail/recipients.ts`, shared by the composer and the service and
free of Node globals. It splits on commas and semicolons outside quoted display
names and angle brackets, drops empty tokens, reduces `Name <addr>` to the
addr-spec, lowercases, deduplicates across To then Cc then Bcc, and bounds the
list. Its accept set is the intersection of every validator downstream, so the
composer can never approve a list the service refuses. A newline is not a
separator — the draft codec rejects one outright, and treating it as structure
would soften a header-injection boundary. Display names are dropped rather than
encoded, because the wire format carries bare addr-specs only.

The draft-send store boundary checks the draft revision, records
the send mutation, and inserts the matching initial outbox operation in one
SQLite transaction. Before commit it rebuilds the deterministic outgoing MIME
from that exact draft revision and requires the recipients, subject, text,
reply context, request fingerprint, and stored bytes to match the proposed
outbox operation. That rebuild runs the service's own draft-to-send derivation:
a second recipient parser here changed the fingerprint for any address typed
with a capital letter and blocked the send as an idempotency conflict. Exact mutation replay returns the already-linked outbox
operation; a collision, content mismatch, or failed outbox insert leaves the
draft and mutation receipt unchanged. Terminal outbox rows remain retained
while a live draft, sent tombstone, or retained send-mutation receipt links to
them, so bounded terminal-row cleanup cannot break exact replay; sent
tombstones still expire after 24 hours.
The private `POST /v1/drafts/:draftId/send` route constructs this boundary. Its
service resolves the connected account and provider capabilities, derives any
reply context from trusted cached message metadata, chooses the immutable
Message-ID, and builds deterministic RFC 2822 bytes before calling the store.
The proposed submission is a trusted internal value, not the HTTP request, and
an HTTP body is never passed directly to the transaction boundary.
Calling the generic draft mutation and outbox enqueue methods in sequence is
not an acceptable public handoff because a crash between them could strand a
submitting draft.

The private service API is versioned by the draft response envelope and exposes
only these exact routes: `POST /v1/drafts`, `GET /v1/drafts`,
`GET /v1/drafts/:draftId`, `PATCH /v1/drafts/:draftId`,
`DELETE /v1/drafts/:draftId`, and `POST /v1/drafts/:draftId/send`. The Brain
bridge repeats account and draft ownership checks instead of trusting URL or
body fields. First create returns `201`; exact create replay returns `200`; an
accepted send returns `202`. Synchronous provider failure after the atomic
handoff does not lose the draft or operation: the durable outbox remains the
source of truth and resumes delivery after restart.

The list route returns bounded summaries only: identity, revision, state,
intent, subject, send status, and timestamps. Recipient text, body text, and
attachment metadata require the single-draft route, so the valid 128 MiB
account quota can never become one oversized list response or one equivalent
in-memory projection. The list wire envelope is capped at 2 MiB. A full draft
request or response may use up to 8 MiB of JSON transport space because a valid
1 MiB text body can expand substantially when JSON escapes control bytes.

Every mutating HTTP route carries its disconnect signal and absolute deadline
through the service into the SQLite store. The store checks that admission
again immediately before `COMMIT`; a disconnect or expired request rolls the
transaction back and cannot create, patch, delete, or enqueue late. Exact send
replay first resolves the already-durable operation and mutation receipt. A
later `reauth_required` state or lost provider capability blocks only a new
handoff, not a replay of one already accepted; replay also does not start a
second synchronous delivery attempt.

SQLite must run with foreign keys enabled, a busy timeout, bounded transactions, and WAL mode. Backup uses the SQLite backup API or a checkpointed snapshot, not a copy of live database files. The [SQLite WAL documentation](https://sqlite.org/wal.html) is the operating reference.

Schema numbers migrate forward, never refuse: the account store keeps a forward-only ladder keyed by `user_version`, the outbox migrates v1 to v2, and both caches stay additive at v1 with a rebuild as their migration path. The oldest supported fixture set under `test/data-versions/` must open in CI.

## 6. Provider-neutral ports

Executable TypeScript contracts live in [`lib/mail/ports.ts`](../lib/mail/ports.ts). They define:

- opaque credential references
- separate IMAP and SMTP authentication identities
- opaque trusted bindings from account, protocol, endpoint, and auth identity to one credential
- standard TLS endpoint descriptions
- complete-set DNS validation with a five-minute maximum generation lifetime and pinned dial targets
- a TLS proof for configured literal address, original hostname/SNI, and verified TLS without inventing an unavailable observed peer
- a bounded SMTP egress-tunnel port for direct or authenticated byte-relay transport
- adapter-owned IMAP/SMTP session factories with pinned-IP/original-SNI policy and auth-after-TLS ordering
- IMAP metadata sync, separate bounded raw-MIME fetch, and APPEND contracts
- awaited durable callbacks immediately before SMTP DATA and IMAP APPEND literal bytes
- SMTP submission outcomes with per-recipient acceptance and rejection
- streaming content-addressed blob storage
- a versioned persistence boundary
- one atomic transaction for fetched rows plus their resume-cursor advance
- optimistic compare-and-swap for every async worker transition
- an isolated MIME parser port with no network or credential access
- atomic aggregate quota admission for connections, fetches, parsers, SMTP submissions, queues, and storage
- the inherited Unix-socket service surface

Session factories and adapters do not own product state. They bind one provider connection to a trusted account identity and translate protocol operations into these ports. State machines decide whether a cursor or submission can move forward.

Every worker reads a versioned record, computes one pure transition, then writes with compare-and-swap. A late network response outside its lease is rejected even when recovery has not run yet. A response after another worker commits also loses the compare-and-swap.

## 7. Endpoint and TLS policy

Only these combinations are accepted:

| Protocol | Port | TLS mode |
| --- | ---: | --- |
| IMAP | 993 | implicit TLS |
| IMAP | 143 | mandatory STARTTLS |
| SMTP Submission | 465 | implicit TLS |
| SMTP Submission | 587 | mandatory STARTTLS |

Port 25 is not a client submission port and is rejected. Plaintext and opportunistic TLS are rejected. Certificate verification remains enabled. STARTTLS capability must be confirmed before credentials are sent.

The account form accepts a DNS hostname, never an IP literal. On every connection and reconnect, the service resolves all A and AAAA results and rejects loopback, private, link-local, carrier-grade NAT, multicast, unspecified, benchmark, NAT64, and unsafe protocol-transition targets. If any answer is forbidden, empty, duplicated, malformed, or over the answer budget, the complete resolution generation is rejected.

Each protocol-session factory configures one validated literal IP while retaining the original hostname for TLS SNI and certificate validation. A hostname re-resolution inside the adapter is forbidden. A DNS generation expires no later than five minutes after resolution, and a connection deadline cannot exceed that expiry. IMAP tries validated addresses sequentially without credential spray: each non-final target receives a fair budget capped at three seconds, while the final target receives the entire remaining global budget. Authentication failure is terminal; transport or TLS failure may advance to the next address. The provider-neutral TLS proof records the configured literal address, original hostname/SNI, and successful verified implicit TLS or mandatory STARTTLS. A direct Node socket must match its observed remote address. An authenticated relay passes the literal target without provider-hostname fallback; if Cloudflare returns a remote address it must match, while a documented null remains null. Brain still verifies the provider certificate against the original hostname over the inner TLS session. A reconnect requires a newly resolved and validated generation. Proxy environment variables are not inherited by the service.

The IMAP and SMTP session factories receive an account ID, validated target, opaque transport-binding reference, and deadline. An exact validator rejects malformed, stale, non-canonical, non-public, accessor-backed, or extended open requests before binding lookup, secret access, or dialing. Each factory then resolves the binding from trusted provisioning storage and requires its account, protocol, and endpoint to match the request. Username and credential reference have no caller-supplied counterpart: the trusted binding is their only source. Per-operation requests contain no auth reference, so identity is bound once to the returned session. ImapFlow receives the literal address as `host` and the original hostname as TLS `servername`, with certificate verification, mandatory STARTTLS, logging disabled, and no ambient proxy. The first-party SMTP adapter owns the protocol state machine over exactly one direct or relay byte transport and owns exactly one physical authenticated provider connection per returned session. Secret loading can precede either handshake, but `auth_sent` must follow verified TLS. Cross-pair and invalid-target failures precede secret loading; certificate, hostname, missing STARTTLS, timeout, or reconnect failures may follow secret loading but must precede authentication. The executable open-request, target, tunnel-proof, and TLS-proof validators live in [`lib/mail/security.ts`](../lib/mail/security.ts). Deterministic ordering lives in [`lib/mail/testing/fakes.ts`](../lib/mail/testing/fakes.ts).

The executable syntax and address rules live in [`lib/mail/security.ts`](../lib/mail/security.ts).

### Sender-icon fetch policy

The mail surface shows sender favicons through the session-gated proxy route `/api/mail/sender-icon/<domain>`. This is a deliberate egress exception, and it is the only outbound fetch the mail surface performs from the Next app.

What leaves: sender **domains** only — the part of the first participant's address after the last `@`. The proxy performs a server-side DNS resolution and a TLS connection to that origin and requests exactly `https://<domain>/favicon.ico`. Message content, addresses, subjects, and account identity never leave.

When: once per domain. A validated icon is persisted to `/var/lib/brain/sender-icons` and re-served from there without another fetch (icons are cosmetic; staleness is acceptable). The store holds at most 2048 domains; an opportunistic LRU sweep drops the oldest beyond that, and an evicted domain is fetched again the next time it is seen. A miss is recorded on disk and re-tried no sooner than seven days later.

Guard chain: the same SSRF blocklist and DNS pre-resolution check as the unfurl route, shared via [`lib/unfurl-guard.ts`](../lib/unfurl-guard.ts) — private/special-use IPv4 and IPv6 literals (including IPv4-mapped forms), localhost, single-label hosts, and any name resolving to a private address are refused. The fetch is https-only with at most three redirect hops, each hop re-vetted by the full guard chain with no downgrade to http, under a five-second per-attempt timeout and a 256 KiB body cap. Served bytes are classified by magic numbers only (ICO, PNG, GIF, JPEG, WebP); SVG, HTML, and anything unrecognized become a negative result — consistent with the app-wide rejection of active SVG. The browser only ever sees the same-origin proxy URL, served with `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and the sandboxed mail-binary CSP.

### Production SMTP egress

The current DigitalOcean runtime is receive-capable but not send-capable. A read-only TCP preflight reaches public HTTPS and IMAP 993, while SMTP 465 and 587 time out against every provider tried. This matches [DigitalOcean's documented platform block](https://docs.digitalocean.com/support/why-is-smtp-blocked/) on outbound ports 25, 465, and 587.

Until a separately reviewed egress route exists, health reports `receiveReadiness: "ready"` and `sendReadiness: "egress_blocked"`, but never fully `ready`. The selected candidate is a dedicated Cloudflare Worker that acts only as an authenticated WebSocket-to-raw-TCP relay. It receives no SMTP password, hostname fallback, MIME metadata, or send instruction. Brain signs a fresh 256-bit Worker challenge together with protocol version and audience, the explicit `authenticated_byte_relay` route, exact validated literal address and family, port, target expiry, session, attempt, and deadline. The issued challenge remains trusted connection-local Worker state; the returned envelope must echo it exactly, and the Worker verifies the canonical payload with a constant-time HMAC comparison. A response signed for another WebSocket is rejected even inside the five-second challenge lifetime. The Worker consumes the challenge before independently rejecting non-public addresses and every port except 465 and 587, and only then opens one raw TCP socket with `secureTransport: "off"`.

The relay protocol allows one TCP socket, no reconnect, no retry, a 60-second absolute deadline, frames no larger than 16 KiB, no more than 2 MiB total client-to-TCP bytes, no more than 128 KiB server-to-client bytes, one unacknowledged frame in each direction, and monotonic sequence numbers. The 2 MiB tunnel ceiling leaves bounded room above the 1 MiB MIME cap for SMTP commands, dot-stuffing, and TLS records. A write acknowledgement is emitted only after the underlying writer accepts that frame. Production adds Cloudflare Access Service Auth in front of the challenge HMAC. A staging preview may use HMAC alone only for a short feasibility run. Direct DigitalOcean SMTP fallback is forbidden.

This route remains conditional until a deployed Free Worker proves literal IPv4/IPv6 dialing, port 465, port 587 with STARTTLS, inner hostname/certificate failure before AUTH, disconnect semantics, and a 1 MiB message below the 10 ms CPU limit. Cloudflare documents `remoteAddress` as nullable and does not promise a stable egress prefix, so the canary must also prove the actual provider accepts the connection. Oracle or Lightsail remains an operator fallback only if the free canary fails. No cloud resource is created by PR0.

The follow-up feasibility implementation and its disabled-by-default rollout gates are documented in [`mail-egress-operations.md`](./mail-egress-operations.md). It does not enable or deploy the route.

## 8. Mailbox sync state machine

The protocol rules come from [IMAP4rev1](https://datatracker.ietf.org/doc/html/rfc3501), [IMAP4rev2](https://datatracker.ietf.org/doc/html/rfc9051), [QRESYNC](https://datatracker.ietf.org/doc/html/rfc7162), and [IDLE](https://datatracker.ietf.org/doc/html/rfc2177).

State:

| Phase | Durable data | Allowed next steps |
| --- | --- | --- |
| `idle` | Active cursor or no cursor | Claim a sync lease |
| `syncing` | Active cursor, resume cursor, lease | Advance, complete, fail, recover expired lease |
| `rebuilding` | Old active generation, staged new generation, lease | Advance new generation, complete, fail, recover expired lease |
| `backoff` | Active cursor, durable resume cursor, retry time | Claim only after retry time |

Cursor fields:

- `generation`
- `uidValidity`
- `highestUid`
- `highestModSeq`, nullable when the server lacks the extension

Commit protocol:

1. Claim a bounded worker lease.
2. Select the mailbox and record UIDVALIDITY on this specific lease. A resumed worker cannot reuse the previous worker's observation.
3. Resume the matching staged cursor or create a new generation.
4. Fetch changes in bounded metadata pages. Raw MIME is a separate bounded streaming operation.
5. Validate every page's count, UID, MODSEQ, flag, and vanished-UID fields.
6. Commit the fetched rows and the matching resume-cursor advance in one storage transaction. The storage boundary verifies exact equality between the page and staged cursor for generation, UIDVALIDITY, highest UID, and highest MODSEQ; a plain cursor compare-and-swap or two unrelated caller values are insufficient.
7. Advance only monotonically within the same UIDVALIDITY.
8. Publish the staged cursor as active only after the complete transition.
9. Keep the old active generation visible throughout a UIDVALIDITY rebuild.
10. Remove the old generation only after the new generation is active and no reader holds it.

A disconnect keeps the staged resume cursor and enters exponential backoff. An expired worker lease follows the same path. A stale attempt ID cannot advance or complete another worker's state. A new attempt cannot advance or complete until that attempt has observed the current UIDVALIDITY.

UIDVALIDITY is part of every remote message key. Reusing UID 7 under a new UIDVALIDITY creates a different identity. Flags and vanished UIDs apply only to their generation.

MODSEQ is either absent or a positive unsigned 63-bit decimal value as required by RFC 7162. Provider-controlled decimal strings, page arrays, flags, and counters are rejected before persistence when they exceed their protocol or resource bounds.

IDLE is a notification hint, not a source of truth. Restart IDLE before 29 minutes, then run a bounded sync. Polling remains the recovery path when IDLE is missing or disconnected.

The executable transition rules live in [`lib/mail/sync-state.ts`](../lib/mail/sync-state.ts).

## 9. Submission state machine

SMTP Submission follows [RFC 8314](https://datatracker.ietf.org/doc/html/rfc8314) and the SMTP command model in [RFC 5321](https://datatracker.ietf.org/doc/html/rfc5321).

State:

| Phase | Meaning | Automatic SMTP retry |
| --- | --- | --- |
| `queued` | Immutable MIME is durable and not claimed | Yes |
| `submitting` | One worker holds a lease | No second worker |
| `retry_wait` | Failure is known to be before delivery risk | Yes, after backoff |
| `delivery_unknown` | Server may have accepted DATA | Never |
| `sent_copy_pending` | SMTP accepted, IMAP Sent copy is not confirmed | Never resend SMTP |
| `sent_copy_unknown` | APPEND may have succeeded but no UID was confirmed | Never retry APPEND before reconciliation |
| `sent_copy_failed` | SMTP delivered, but a permanent APPEND rejection prevents a Sent copy | No automatic retry |
| `sent` | SMTP accepted and Sent copy metadata stored | No |
| `partially_sent` | At least one recipient accepted, at least one rejected, and Sent copy stored | Never retry the original envelope |
| `failed` | Permanent rejection | No |

The request fingerprint (`fingerprintMailSendInput`) is a SHA-256 over exactly
the caller's own submission, in this order:

- account ID
- send mode
- To, Cc and Bcc
- subject
- body text
- in-reply-to message ID

Operation ID, idempotency key, provider kind, created-at and the built message
are not fingerprint inputs. They are immutable fields of the queued record,
compared field by field on every replay by `assertImmutableIdentity`, so a
second submission that reuses an operation ID with anything else changed is
refused rather than deduplicated.

The service also assigns a durable creation time. That timestamp is immutable record metadata, but it is explicitly outside the request fingerprint because a lost-response replay cannot reproduce it.

The raw MIME blob is written before the queue record becomes claimable. A retry uses the same bytes and Message-ID.

The Unix-socket queue request requires a caller-generated idempotency key. The service computes a fingerprint over every caller-supplied immutable queue field. Server-generated metadata such as durable creation time is deliberately excluded, so reconstructing the same request after a lost response returns the existing operation when key and request fingerprint match. Reusing the key with different caller content or reusing an operation ID with another key fails closed. Brain can look up the result by idempotency key before deciding whether to retry.

The first-party SMTP wire adapter must await a worker callback after parsing the server's `354` continuation and immediately before writing the first DATA byte to its one physical session socket. That exact boundary is why PR0 does not select a high-level Nodemailer transport. The callback persists `deliveryRisk: possible` with compare-and-swap. The adapter is not allowed to emit an accepted result until the callback succeeds. The state machine rejects accepted outcomes without the mark and accepts only the final `250` response to DATA. A connection loss after the mark enters `delivery_unknown`. A response arriving after the worker lease expires is rejected and recovery enters the same safe state. Automatic retry is forbidden because SMTP does not provide a portable exactly-once transaction. Manual reconciliation can search Sent and the target mailbox by Message-ID, but its product flow is deferred.

SMTP recipient acceptance is not all-or-nothing. The adapter persists an exact partition of the immutable envelope into accepted recipients and rejected recipients with stable response codes. When at least one recipient accepted DATA, the original envelope is never retried automatically, even when another recipient received a transient rejection. The final record remains visibly partial so a later product flow can offer a new send addressed only to selected rejected recipients.

An SMTP `250` response enters `sent_copy_pending`. Appending the same immutable MIME to the configured Sent folder is a separate retry loop. An IMAP APPEND failure cannot return the record to the SMTP queue. A definitive retryable tagged rejection schedules only APPEND. A permanent tagged rejection enters `sent_copy_failed`.

The first-party IMAP APPEND adapter must await a durable callback after the continuation response and before the first APPEND literal byte. ImapFlow remains the sync/fetch adapter and is not used for this exact barrier because its documented `append()` API exposes no continuation callback. A disconnect after the mark enters `sent_copy_unknown`. It does not retry APPEND until reconciliation by Message-ID confirms whether the server stored the copy. A tagged `OK` without UIDPLUS also enters `sent_copy_unknown`: storage is known, but the UID must be discovered by Message-ID or a unique marker. This prevents duplicate Sent copies after a lost APPEND response and supports providers that omit APPENDUID.

The executable transition rules live in [`lib/mail/send-state.ts`](../lib/mail/send-state.ts).

Ownership between the legacy provider outbox worker and the first-party SMTP worker is decided exactly once. Inserting an IMAP-provider outbox row creates its `smtp_submission_state` row inside the same SQLite transaction, so the operation is SMTP-owned before any worker can list it. The legacy outbox compare-and-swap refuses every IMAP-provider row, and the legacy runnable queries exclude SMTP-owned rows, so the two workers can never claim the same operation. The SMTP worker in [`lib/mail/service/smtp-worker.ts`](../lib/mail/service/smtp-worker.ts) claims with the persisted lease transitions above; restart recovery is the expired-lease reclaim path, and a lease that reached the DATA barrier recovers only into `delivery_unknown`.

Outcome-grade transitions mirror onto the public outbox row in the same store transaction: reaching SMTP acceptance mirrors as `sent`, a permanent rejection as `failed` with a legacy-safe error code, and an ambiguous DATA handoff as `delivery_unknown`. Claim and retry churn stays private to the state row. Reconciliation searches the account's Sent mailbox by the immutable Message-ID: a hit resolves `sent_copy_unknown` (and `delivery_unknown`) to `sent`, a definitive miss returns only `sent_copy_unknown` to the safe APPEND retry loop, and a miss after `delivery_unknown` proves nothing and never re-sends. Transient SMTP retries stop permanently at the attempt cap in `send-state.ts`.

## 10. MIME and rendering boundary

Current repository-staged Gmail receive pipeline:

1. Read advertised RFC822 size before fetch when available.
2. Stream raw MIME through the dedicated fetch port into a bounded temporary blob while hashing it.
3. Stop before retaining a chunk that would cross the raw or aggregate temporary-byte limit.
4. Hand only the verified blob descriptor and a fixed budget to the isolated parser worker.
5. Parse with the streaming MailParser API under concurrency, deadline,
   decoded-byte, part, depth, address, DOM-node, DOM-attribute, and memory
   limits. Those streaming counters run before retaining each bounded chunk,
   part, or node rather than only after a complete parse.
6. Exact-project and validate the worker response, including descriptor
   hashes/sizes, bounded attachment count, and aggregate decoded bytes. At this
   post-parse boundary, inspect candidate raster container metadata and enforce
   cumulative decoded-pixel and frame limits before persistence or browser
   decode.
7. Store sanitized render data separately from the original raw MIME hash.
8. Fetch each referenced, verified CID raster through the authenticated Brain
   attachment proxy in the parent document, validate exact response headers,
   convert it to a short-lived `blob:` URL, and render HTML in a sandboxed
   iframe with the strict reader CSP. The sandbox grants only `allow-same-origin`
   because Chromium otherwise rejects the parent-created `blob:` URL; it does
   not grant scripts, forms, navigation, popups, downloads, or any other
   capability. Separate browser gates permit at most two full-content workflows
   and two CID fetches across the whole thread. Newer messages enter the body
   gate first, and the 30-second body deadline starts only after admission, so
   time spent waiting behind an older message cannot create a false timeout.

Remote images, stylesheets, fonts, media, frames, forms, scripts, SVG, MathML, and active embeds are blocked. Protocol-relative URLs are remote. `data:` and `javascript:` resources are blocked. The sanitizer retains only a bounded presentation-only subset of inline CSS; URL-bearing, executable, layout-escape, and obfuscated CSS is discarded. A strict `cid:` reference may resolve only to an inline PNG, JPEG, GIF, or WebP attachment from the same message after MIME magic, container dimensions, frame geometry, aggregate byte, pixel, and frame verification. Explicit `Content-Disposition: attachment` is never promoted; a common CID part with no disposition may be normalized to inline. Admission counts `width × height × frames` and accumulates decoded pixels and frames across every inline part in the message.

SVG, HTML, PDF, office documents, and unknown types are downloads. The server sets attachment disposition, `X-Content-Type-Options: nosniff`, same-origin CORP, an inert attachment CSP, a safe generated filename, and a private no-store policy. Original sender filenames are metadata only. Blob URLs are revoked on reader cleanup; queued and active CID requests are abortable.

Links are retained only as inert sanitized destination metadata until the step-7 product decision defines the external-navigation interstitial.

Remote images are served to the reader only from the server-side privacy cache; the browser never contacts a third-party host. The cache is populated on two paths. The background path prefetches images for a small stable cohort of the newest Inbox messages on the sync schedule, deliberately detached from any open event, so a tracking pixel in those messages observes only the server address and sync timing. The on-open path is an owner-approved trade-off with Gmail-web semantics: opening a message records a durable content demand, and the server then fetches that message's images through the same SSRF-validated, budgeted fetcher. The sender's tracking pixel can observe the server's IP address and approximate open timing for messages the reader actually opens — accepted so opened mail renders with images — while the reader endpoint itself stays cache-only and never triggers an origin request.

The on-open fetch starts the moment it is approved, not when the scheduler gets round to it. A demand on a message whose body is already cached, and a ready commit of a body that references images, each start a drain of that message's pending images — detached from the response, serialised per message, deduplicated per image, bound to the account's lifecycle. The scheduler's own pass stays as the backstop: cohort messages the drain never saw, transient failures whose retry window has passed, rows left over from a restart. For a while the drain did not exist and the demand only marked the message eligible; the images waited for a scheduler pass that ran only after the provider sync step reported no more pages, and a provider mid-history-walk or failing outright held them back for tens of seconds while the reader, polling a cache-only endpoint, gave up. The prefetch step now runs on every scheduler page, whatever the provider said. At most two drains run at once across the process: the reader opens a thread's messages together, and without a ceiling a long thread would dial that many origins at the same time, each able to buffer a message's whole image budget. The reader also asks again: after a run of cache misses it re-POSTs the message-content request, which re-records the demand and starts the drain over. Body and images draw on one counter — three message-content POSTs per open, however they are split — and the image load deadline runs from the last answer rather than from the open. The reader endpoint answers 503 for an image the cache does not hold yet, 404 for one it has no live row for, and 410 for one it has refused for good (a blocked tracker, a spent raster budget), so the reader re-asks once for a missing row and never for a refusal.

The worker process, patched streaming MailParser/MailSplit limits, sanitizer,
disk-backed cache, attachment streamer, and malicious corpus are implemented in
the MIME content slice. The worker cannot share an OS identity, credential
mount, network namespace, or database access with the transport edge. Content
format version `8` forces cached pre-verification output to be reparsed before
reader use. Verified inline CID raster rendering and private downloads are
implemented; remote images render from the server-side privacy cache as
described above.

## 11. Executable resource budget

The constants in [`lib/mail/security.ts`](../lib/mail/security.ts) are the source of truth.

| Resource | Limit |
| --- | ---: |
| Accounts | 3 |
| Incoming raw message | 40 MiB |
| Outgoing raw message, MVP | 1 MiB |
| Relay frame | 16 KiB |
| Relay client bytes | 2 MiB per tunnel, including SMTP/TLS overhead |
| Relay server bytes | 128 KiB |
| Relay session | 60 seconds |
| Headers | 256 KiB |
| HTML text | 1,048,576 characters |
| Plain text | 2,097,152 characters |
| MIME parts | 256 |
| MIME nesting depth | 32 |
| Parsed addresses | 200 |
| Messages per sync page | 50 |
| Concurrent IMAP fetch streams | 2 |
| Concurrent MIME parsers | 2 |
| Concurrent SMTP submissions | 1 |
| DNS answers per generation | 16 |
| DNS generation lifetime | 5 minutes maximum |
| Flags per message | 64 |
| Vanished UIDs per page | 2,000 |
| Mailboxes per account | 256 |
| Active IMAP connections | 5 |
| Concurrent IDLE sessions | 3 |
| Queued submissions | 100 |
| Cache | 2 GiB / 100,000 messages |
| Aggregate temporary data | 128 MiB |
| SQLite WAL | 64 MiB |
| Open file descriptors | 256 |
| Decoded MIME | 80 MiB |
| Sanitized DOM | 50,000 nodes / 200,000 attributes |
| Inline raster | 8 MiB encoded per part / 12,000,000 cumulative decoded pixels / 100 cumulative frames per message |
| IDLE restart | 25 minutes |
| Worker lease | 5 minutes maximum |
| Process memory | `MemoryHigh=192 MiB`, `MemoryMax=256 MiB` contract |
| Process CPU/tasks | 35% CPU quota / 32 tasks contract |
| Parser memory | `MemoryHigh=128 MiB`, `MemoryMax=192 MiB` contract |
| Parser CPU/tasks/FDs | 20% CPU quota / 8 tasks / 64 file descriptors contract |

[`MailSystemAdmissionPort`](../lib/mail/ports.ts) atomically reserves aggregate capacity before each connection, fetch, parse, SMTP submission, queue, temp blob, or WAL-growing operation. Its exact delta validator rejects unknown, negative, fractional, non-finite, accessor-backed, or individually oversized counters before arithmetic. [`admitMailSystemUsage`](../lib/mail/security.ts) rejects a snapshot above any quota, including the explicit fetch/parser/SMTP concurrency fields. Per-account limits cannot substitute for these global limits.

Later service units must enforce the executable process contract below the host's physical capacity: 192 MiB soft memory pressure, 256 MiB hard memory, 35% CPU, 32 tasks, and 256 file descriptors. The parser worker has its own smaller 128/192 MiB, 20% CPU, 8-task, and 64-file-descriptor contract. A parser failure, out-of-memory kill, or process restart must leave only a resumable atomic sync page or an expired lease. It must not publish half a mailbox generation or retry an ambiguous send.

Disk admission is checked before a fetch, local compose attachment, or MIME queue write. When free space crosses the warning floor, pause cache growth and evict unpinned cache blobs. When it crosses the hard floor, reject new local writes with a durable error and keep existing mail readable. Exact floors depend on a measured production baseline and are deferred.

## 12. Threat model

| Threat | Required control | PR0 evidence |
| --- | --- | --- |
| SSRF through custom hostnames | Validate a complete short-lived DNS generation, block special ranges independently in Brain and relay, sign only the literal target, and never fall back to hostname dialing | Endpoint, target, expiry, tunnel-proof, and session-factory tests |
| Relay becomes an open proxy | Cloudflare Access plus fresh challenge HMAC, public literal target only, ports 465/587, one socket, fixed deadline, frame and byte caps | PR0 tunnel contract; implementation and deployed negative tests required |
| TLS downgrade or credential theft | Fixed TLS/port pairs, trusted account/protocol/endpoint/credential binding, pinned-IP plus original-SNI policy, auth only after verified TLS, mandatory STARTTLS | Cross-pair, proof, and event-order tests |
| Secrets in Brain or logs | Separate opaque protocol refs, isolated adapter-owned session factory, disabled provider logging, top-level log allowlist | Port types, session fakes, and projection tests |
| Cross-process socket caller | Root/systemd-owned socket, unique Brain client group, mode `0660`, bounded requests; optional replay-safe capability | Service requirement, implementation deferred |
| HTML XSS and trackers | Sanitize, block remote resources, sandbox, CSP | HTML policy and resource tests |
| Active inline attachments | Raster CID allowlist, all other types download | Attachment policy tests |
| MIME decompression, image, or nesting bomb | No-network parser worker, exact request/result IPC projection, and pre-allocation aggregate budgets | Progress, image, request/result-projection, budget, and isolation tests |
| Duplicate outgoing mail | Immutable MIME, idempotency key, lease, SMTP parser in Brain, and pre-DATA risk mark before the first relay frame | Submission state and relay-boundary tests |
| Partial recipient delivery | Exact accepted/rejected partition, no retry of original envelope | Submission state tests |
| Lost accepted mail in Sent | Separate durable Sent-copy retry state | Submission state tests |
| UID reuse after mailbox reset | UIDVALIDITY in identity, staged generation swap | Sync state tests |
| Worker crash | Per-attempt identity observation, page/cursor identity equality inside one atomic commit, durable literal barriers, bounded leases | Lease, state, mismatch, and atomic fake tests |
| Cache corruption or loss | Rebuildable cache separated from local state | Storage design, implementation deferred |
| Disk full during blob write | Temporary file, hash, fsync, atomic publish, admission floor | Implementation deferred |
| Malicious logs or filenames | Structured top-level event projection, discard unknown data, generated download name | Projection contract, download implementation deferred |
| Parser compromise steals credentials | Separate worker identity without network, credentials, or durable database | Isolation port/fake now, OS sandbox test with MIME implementation |
| Shared-host exhaustion | Atomic aggregate reservations including fetch/parser/SMTP concurrency plus process memory/CPU/task/FD ceilings | Delta, concurrent-reservation, snapshot, and future service-unit tests |
| Dependency compromise | Frozen lockfile, minimal packages, Linux artifact tests, source review | No PR0 dependency change |

Out of scope for the first complete slice: malware scanning, PGP, S/MIME, shared mailboxes, Exchange proprietary APIs, JMAP, server-side rules, and remote-image proxying. Attachment download remains untrusted even when its MIME type is familiar.

## 13. Logging and health

Allowed structured log fields:

- event name
- account ID
- mailbox ID
- operation ID
- state phase
- duration bucket
- account, mailbox, message, attachment, recipient, queued-submission, remote-image, and remote-image-attempt counts
- raw-MIME, cache, temporary, and WAL byte counts
- stable error code

Never log subjects, addresses, Message-IDs, filenames, headers, body fragments, raw MIME, credentials, IMAP command payloads, SMTP payloads, or server response text that can echo message data. [`projectMailLogRecord`](../lib/mail/security.ts) constructs the final record from the complete top-level allowlist and discards every unknown or nested value. Raw adapter errors and configuration objects never reach it. Invalid event names reject the whole record.

**Every answered failure is written down, not only the ones that crashed.** The threshold was a status of 500 for a while, which made an outage loud and left every refusal silent — a 409 saying an account's server has no folder for an archive, a 404 for a thread the reader can still see, a 429 from a provider. Each of those is a decision the service made about the owner's mail, and a morning of them could pass without a line. `mail_request_failed` carries the stable code for any status of 400 or more, alongside the account the request named and a `phase`.

A `phase` is a route family and its verb — `thread_patch`, `message_content_post`, `mailbox_thread_get` — derived from the path by [`mailRequestPhase`](../lib/mail/security.ts) rather than passed in, so it cannot drift from the routes. The path itself never travels: thread, message and attachment ids live there and none of them has a field on the allowlist. A route the table does not know logs `unknown_route`.

The account id in a `mail_request_failed` record is the one the request named, and it is written only when it has the shape of one: `account-a` and thirty-two hex digits. The projection's own guard admits any 128-character identifier, which is wide enough for a token pasted into the query, so the router checks the shape before the record does and a request that names something else is recorded without an account.

The service writes on two streams, and under one name each. `writeMailLogRecord` in [`security.ts`](../lib/mail/security.ts) puts an answered failure on stderr; `writeServiceLog` in [`main.ts`](../lib/mail/service/main.ts) puts the service's own lifecycle and worker events — `mail_service_started`, `mail_service_stopping`, a worker's stop failure, the remote-image pipeline's `mail_remote_image_drain_started`, `mail_remote_image_settled` and `mail_remote_image_drain_finished` — on stdout. A settled image carries its outcome as the `phase` (`fetched`, `blocked`, `origin_refused`, `budget_exhausted`, `transient`), the fetcher's stable code as `errorCode`, and the bytes a fetched image added to the cache as `cacheBytes`; a transient retry is always one interval away, so the record does not repeat it. A drain starts with the images it means to take as `remoteImageCount` and finishes with the ones it attempted as `remoteImageAttemptCount`, which differ when teardown cut it short or another path settled an image first. No field names an image, a URL or a host. Both go through the same projection. The artifact smoke reads the two apart, which is why the router never imports the stderr writer under the stdout writer's name.

Brain's own proxy layer writes two events, because a failure it manufactures is one the service never saw and cannot record. `mail_proxy_request_failed` covers the three cases where the service's answer was never heard — `mail_service_timeout`, `mail_service_unavailable`, and `mail_service_invalid_response` — and `mail_api_action_failed` covers a route handler throwing something that is not a service answer at all. A cancelled request is not logged: the browser dropping a read it no longer needs happens on every thread switch. A code the service coined is not logged twice.

`mail_service_invalid_response` is the one to read closely. It means Brain refused to relay what its own service said, which is right for a transport code and a bug for a domain code — the status and the meaning are both lost, and a refusal a surface knows how to explain arrives looking like an outage. The forwarding set lives in [`brain-mail-client.ts`](../lib/mail/brain-mail-client.ts), and a new service error code on a message or account route belongs there in the same commit that adds it.

The service's error vocabulary is declared once, as `MAIL_SERVICE_ERROR_CODES` in [`http.ts`](../lib/mail/service/http.ts), in three groups: `relayed` codes exist to tell a surface something it can act on and Brain forwards each unchanged; `transport` codes mean the request never formed and Brain collapses them on purpose; `admission` codes belong to the ledger's own routes, which no surface calls. `MailHttpError` accepts only a code from that set, so every code that can reach the wire — a literal in the router or `error.code` relayed off a typed error class — is a declared one, and `proxies every relayed service error code` asserts the forwarding set holds every `relayed` code and none of the others. The test used to grep the router for literals, which could not see the sites that relay an error class's own code, and five `smtp_*` account codes shipped that way with no place in the forwarding set: a wrong outgoing password reached the settings surface as a 502 outage.

The typed health contract reports API version, exact build commit/time, status, nullable local/cache schema versions for the pre-database shell, separate receive and send readiness, active-account count, queue depth, nullable last-successful-sync age, `normal`/`warning`/`critical` cache pressure, and a nullable bounded stable error code. Account health aggregates the Inbox and every hidden system mailbox: an explicit Sent, Starred, Spam, Trash, or All Mail failure cannot be masked by a healthy Inbox, and the age uses the oldest completed mailbox refresh while preserving the existing Inbox age before first hidden hydration. `sendReadiness: egress_blocked` necessarily makes overall status degraded. Its exact validator rejects unknown, accessor-backed, inconsistent, or out-of-quota values. It does not query a provider during a health request.

Both readinesses answer from that aggregate and nothing else, because a health request may not dial a provider. `not_configured` means no account is wired for that path. Beyond that, receive is `ready` once the schemas exist and every account holds a completed sync with no recorded error, and `degraded` otherwise — never having synced is not the same as being healthy. Send does not wait on a sync: a queue can take a letter on an account whose first refresh is still running, so only a recorded error, reauth included, takes send readiness away. A readiness cannot claim `ready` before its schemas are built, and the validator refuses the pair. **`degraded` has to be able to be wrong.** For a while the code had no branch that could produce `ready` at all, so a service syncing cleanly reported degraded on both paths with a null error code, and the endpoint could not tell an incident from an ordinary healthy run.

## 14. Deterministic test surface

[`lib/mail/testing/fakes.ts`](../lib/mail/testing/fakes.ts) provides network-free adapters:

- scripted IMAP pages and disconnect points
- scripted SMTP acceptance, partial recipient rejection, and transport ambiguity
- scripted Sent APPEND with mandatory literal barrier and UID-less success
- IMAP/SMTP session factories with observable `binding_resolved`, `credential_loaded`, relay authorization/connect, `dial_started`, TLS/STARTTLS verification, `auth_sent`, and `session_ready` ordering; relay absence of `remoteAddress` remains explicit
- one atomic fake transaction that rejects any sync page/generation/cursor mismatch
- an isolated parser fake that exact-projects and bounds both IPC request and response and has no endpoint or credential surface
- an atomic aggregate-admission fake that proves one of two simultaneous reservations loses at a concurrency ceiling
- an idempotent fake outbox that rejects key reuse with different MIME
- recorded protocol calls bound to a session identity, containing neither credential references nor secret values

Required cases before a real provider adapter can merge:

| Area | Cases |
| --- | --- |
| Sync | initial, resume, fresh identity observation per attempt, disconnect each page, atomic rows+cursor crash points, UIDVALIDITY change, vanished UIDs, stale lease, no QRESYNC, no IDLE |
| Send | one connection per SMTP session, bounded multiline replies, STARTTLS and post-TLS EHLO, auth-after-TLS, partial recipients, dot-stuffing, exact post-`354`/pre-first-DATA-byte barrier, 4xx before DATA, 5xx, disconnect before DATA, disconnect after DATA, late lease response, worker crash, Sent APPEND pre-literal retry, post-literal unknown, tagged OK without UIDPLUS, permanent APPEND rejection |
| MIME | limit minus one, exact limit, limit plus one, deep nesting, many parts, malformed headers, truncated body |
| HTML | scripts, forms, SVG, CSS URL, protocol-relative tracker, CID mismatch, event handlers, base tag |
| Endpoint | IP literals, empty/mixed/duplicate/oversized DNS answers, NAT64, DNS expiry, credential/host cross-pair, invalid cert, hostname mismatch, STARTTLS missing, relay target mismatch or nullable peer, zero secret reads before binding/target admission, and zero auth sends before verified TLS |
| Relay | missing Access/HMAC, stale or replayed challenge, target/port substitution, private address, frame gap/duplicate/oversize, backpressure, absolute deadline, one socket, no reconnect, and close in every pre/post-DATA state |
| Storage | crash before blob publish, crash before transaction commit, WAL recovery, cache rebuild, backup restore |
| Capacity | mailbox, connection, IDLE, fetch, parser, SMTP, queue, cache, temp, WAL, FD, DOM, cumulative image, concurrent reservation, and process ceilings |

Tests use synthetic domains and content: reserved names such as `example.test`, `example.com` and `.example`, except where a case turns on a provider domain the product's own code recognizes (`gmail.com` and `googlemail.com` for Gmail address canonicalization, `icloud.com` for the IMAP host preset). They never contain the owner's real addresses, messages, passwords, tokens, or production hostnames.

## 15. Pull request sequence

Each pull request stays independently releasable. A release with an unused module must not change production behavior.

1. **PR0, contracts**: this document, ports, state machines, limits, deterministic fakes, unit tests.
2. **PR1, Cloudflare egress feasibility**: disabled-by-default Worker byte relay, challenge HMAC, WebSocket Duplex client, independent frame acknowledgements, adversarial local tests, dry-run bundle, and an operator staging probe. Production routing remains off.
3. **PR2, service shell**: dedicated process, root/systemd-owned Unix socket with unique Brain client group and mode `0660`, bounded HTTP-over-UDS, versioned health and aggregate admission only, no provider credentials or native addon. Unit assertions enforce the PR0 service and parser process contracts.
4. **PR3, persistence**: two SQLite databases, migrations, blob stores, atomic sync-page commit with page/cursor identity enforcement, backup and cache rebuild tests, and exact Linux native-artifact proof.
5. **PR4, account provisioning**: separate IMAP/SMTP auth refs, trusted transport bindings, encrypted credential storage, short-lived complete-set DNS preflight, ImapFlow sync/fetch factory, SMTP protocol-session foundation over direct or authenticated relay, cross-pair rejection, secret rotation, and zero auth sends before TLS proof. No message sync or SMTP DATA.
6. **PR5, IMAP metadata sync**: folders, bounded metadata pages, cursors, UIDVALIDITY rebuild, QRESYNC fallback, IDLE scheduler. No raw MIME download. The later IMAP message-bodies slice added the bounded `BODY.PEEK[]` raw fetch through the shared content pipeline.
7. **PR6, MIME receive path**: separate bounded raw fetch, isolated no-network parser worker, incremental budgets, sanitized text/HTML, verified raster metadata, and safe downloads.
8. **PR7, SMTP and Sent copy**: bounded first-party SMTP state machine over one byte transport, first-party IMAP APPEND barrier adapter, durable outbox, idempotent queue replay, per-recipient outcomes, exact awaited post-`354`/pre-DATA and APPEND barriers, ambiguity states, UID-less reconciliation, terminal failures, and a manual test mailbox.
9. **PR8, Brain integration and UI**: Mail entry, list and reader, composer, responsive states. A design reviewer takes this gate against the Brain design system before implementation.
10. **PR9, canary and operations**: Cloudflare Access, real-provider 465/587 and 1 MiB CPU proof, resource measurement, backup restore, provider matrix, rollback, then one test account.

No step receives production credentials until its security tests and the full Brain gate are green. No UI step begins before the underlying failure states are representable through the service API.

## 16. Remaining product decisions

These do not block PR0:

- which three accounts enter the first canary
- cache retention and offline body pinning
- manual actions for `delivery_unknown`, `sent_copy_unknown`, `sent_copy_failed`, and rejected recipients in a partial delivery
- deletion, archive, snooze, and undo timing
- conversation grouping rules
- later body-search scope beyond the shipped local header/preview index
- whether drafts synchronize through IMAP in the first release
- exact disk warning and hard floors after measurement

They must be resolved before the pull request that makes each behavior user-visible.

## 17. PR0 acceptance gate

PR0 is complete only when:

1. No runtime dependency changes.
2. No credential, provider connection, socket, database, systemd, UI, deploy, or production mutation exists.
3. State transitions are pure and reject stale attempts.
4. Every resumed sync attempt observes UIDVALIDITY again, and rows plus cursor advance have one atomic storage port.
5. The selected first-party SMTP protocol contract owns one provider connection over one direct or authenticated byte transport, and SMTP DATA plus first-party IMAP APPEND success are impossible without their exact awaited durable barriers.
6. SMTP ambiguity and partial recipient delivery cannot return the original envelope to automatic retry.
7. APPEND ambiguity, UID-less success, and permanent rejection have distinct non-SMTP-retry states.
8. A UIDVALIDITY rebuild cannot replace the active generation before completion.
9. Short-lived complete-set DNS validation, trusted account/protocol/endpoint/credential binding, adapter-owned session factories, configured literal-IP/original-SNI TLS proof, exact relay request/proof validation, nullable observed-peer honesty, and auth-after-TLS ordering are mandatory contracts with deterministic cross-pair and failure tests.
10. IMAP and SMTP use separate usernames and opaque credential references.
11. Metadata sync and raw MIME fetch are separate contracts.
12. The parser port proves no network and no credential access; exact bounded IPC validators strip every unknown request/result field and reject malformed or oversized result descriptors.
13. Incoming/outgoing message, relay frame/session, cumulative decoded-image, incremental parser, atomic aggregate service including fetch/parser/SMTP concurrency, and separate service/parser process limits are executable, not prose only.
14. Logs are projected onto the documented allowlist and never serialize adapter errors.
15. Queue replay exposes an idempotency key and server-computed caller-request fingerprint that excludes server-generated timestamps.
16. Fakes execute every state and security ordering, page/cursor mismatch, cross-paired binding, and concurrent capacity race without a network.
17. `pnpm check` is green.

The full implementation must also clear the gate `AGENTS.md` describes and
the release checks in `docs/release-checklist.md`.
