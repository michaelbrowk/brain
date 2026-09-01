# Brain Mail account-connect operations gate

Status: disabled-by-default operations gate. Nothing in this change installs,
enables, starts, restarts, or deploys `brain-mail`; current production state
must be verified separately before applying the gate.

## What this slice contains

- up to three custom-domain IMAP accounts over port `993` implicit TLS or port
  `143` mandatory STARTTLS;
- compatibility `GET`, `POST`, and `DELETE /v1/account`, plus account-scoped
  `GET`/`POST /v2/accounts` and `PATCH`/`DELETE
  /v2/accounts/:accountId`, over the private inherited Unix socket;
- a complete-set DNS check, public-address enforcement, original-hostname SNI,
  certificate verification, observed-peer match, and real authentication before
  save;
- Node 22 built-in SQLite metadata plus separately AES-256-GCM encrypted
  per-account password rows in `/var/lib/brain-mail/local.sqlite3`; the wrapping
  key remains a systemd credential from `/etc/brain/brain-mail-account.key`;
- an ImapFlow `1.4.7` bundle with generated `THIRD_PARTY_NOTICES.txt`;
- a Brain Settings form for connecting, editing, and locally disconnecting the
  account, plus the `/mail` entry surface;
- staged systemd units, users/groups, tmpfiles, runtime projector, Brain client
  group drop-in, a non-rotating key-creation tool, and a stopped-service state
  snapshot/restore tool.

The current branch also contains the Gmail client and safe-content slice:
bounded initial and incremental sync, a per-account message cache, inbox and
reader APIs, system mailbox actions, compose/reply, a durable idempotent
outbox, Gmail API send, serialized background refresh, isolated MIME parsing,
sanitized text/HTML rendering, and private streamed attachment downloads. The
branch itself makes no automatic production change. Its exact release still
requires CI, service health, and a read-only body-and-attachment canary before
any rollout claim.

Custom-domain receive now has a repository-staged, Inbox-only metadata
foundation. It lists at most the newest 200 messages in pages of 20, models
each message as one thread, keys identity by UIDVALIDITY and UID, polls new
UIDs, and rebuilds on UIDVALIDITY change, definite expunge, or the tenth
incremental poll. Thread mutations run on the same session
factory: `\Seen` and `\Flagged` through STORE, archive, trash and junk through
a MOVE into a mailbox found by SPECIAL-USE or a well-known name, with the
mutation refused rather than guessed when the server offers neither. Listing
folders other than the Inbox and conversation grouping remain unavailable for
custom-domain accounts. This is not a production-readiness claim: the exact artifact still needs an isolated
runtime smoke and a read-only real-provider canary.

With no account, health reports `receiveReadiness` and `sendReadiness` as
`not_configured`. A wired account reports both paths as `degraded` until a real
Gmail canary proves readiness. Neither state may be presented as proof that the
local Gmail message path is production-ready.

The v2 API caps the list at three accounts and rejects a normalized email that
already belongs to any provider. It returns redacted account metadata only.
When more than one account exists, legacy v1 `POST` and `DELETE` fail with
`409 account_selection_required`; callers must select an account through v2.

## Release and installation preflight

The ordinary application deploy does not install root-owned Mail units. CI
packages the matching staged files under `brain-mail-ops/` inside the signed
standalone artifact, but the deploy puller only places them in the immutable
release. A release is rollout-eligible only when its exact CI run is green and
contains both `mail-service/` and `brain-mail-ops/`. The packaged installer is
disabled-by-default and transactionally reversible; production rollout remains
blocked until its CI rollback rehearsal, human review, and a separately
approved canary all pass.

Before any future install, an operator must:

1. Record the immutable release path and commit. Never install from a mutable
   checkout or `/opt/brain/current` without resolving it first.
2. Back up every destination that will change: the Mail service, both sockets,
   sysusers and tmpfiles entries, runtime projector, key tool, state rollback
   tool, and Brain supplementary-group drop-in.
3. Run `systemd-analyze verify` against all four staged unit files and run the
   projector test against the exact release.
4. Install users/groups and tmpfiles before any unit. Install the Brain
   client drop-in last; it takes effect only after a separately approved Brain
   restart.
5. Run `create-brain-mail-key.sh` once. It creates 32 random bytes as
   `root:root 0400`, refuses overwrite/rotation, and leaves all Mail units
   disabled. The existing `/etc/brain` directory remains `root:brain 0750`;
   the tool requires a root owner and rejects group or world write access.
6. Project the exact runtime file set — `ops/project_mail_runtime.py` holds
   the list — across its four allowlisted directories and compare its
   `build.json` to the chosen release. The set includes all
   twelve compiled Gmail OAuth, sync, send, and content modules plus the
   custom-domain Inbox sync adapter even when either provider is disabled.
7. Start both sockets and the service together for a canary, query health over
   `/run/brain-mail/brain-mail.sock`, then stop all three units. Enable the
   public Mail socket only after this canary and the Brain client integration
   are reviewed.

No step may silently create a new key over an existing one, enable a unit, or
restart Brain. Those remain explicit operator decisions.

`brain-mail.service` carries no public origin of its own. Before the canary,
write the one this instance answers on into `/etc/brain/brain-mail.env`,
root-owned mode `0600`:

```text
BRAIN_PUBLIC_ORIGIN=https://<the exact public HTTPS origin, no trailing slash>
```

systemd reads that file as root before the unit's sandbox applies, which is why
`InaccessiblePaths=/etc/brain` does not hide it. Gmail authorization refuses to
start without the value, and a drop-in under
`/etc/systemd/system/brain-mail.service.d/` overrides it when a canary needs a
different one. It is a separate file from `/etc/brain/brain.env` on purpose: the
mail service never receives the web process's secrets.

The reviewed staging command takes the exact immutable ops directory:

```bash
sudo /bin/bash \
  /opt/brain/releases/<release>/brain-mail-ops/install-brain-mail.sh \
  /opt/brain/releases/<release>/brain-mail-ops
```

It verifies the exact file/type allowlist and `MANIFEST.sha256`, backs up absent
versus existing destinations with bytes and metadata, installs atomically,
creates additive system identities/runtime directories, reloads systemd, and
then proves all Mail units are still disabled and inactive. It never creates
or overwrites the wrapping key and never enables, starts, or restarts a service.
The printed transaction directory is required for rollback.

The installer durably records the saved and intended state plus a hash- and
metadata-checked transaction-local recovery script before its first replacement.
Recovery therefore does not depend on the release directory or an already
installed `/opt/brain/bin` script surviving. A killed install blocks the next
install until that transaction is rolled back. Rollback accepts both an
interrupted prepared transaction and a completed transaction, recognizes only
the exact saved or intended bytes and metadata, and resumes file by file after
another interruption.

The exact manual canary keeps cleanup inside a subshell so a failed health check
still stops the service and both sockets:

```bash
(
  set -Eeuo pipefail
  cleanup() { sudo systemctl stop brain-mail.service brain-mail-mime.socket brain-mail.socket; }
  trap cleanup EXIT
  sudo systemctl start brain-mail.socket brain-mail-mime.socket brain-mail.service
  sudo curl --fail --silent --show-error \
    --unix-socket /run/brain-mail/brain-mail.sock \
    http://brain-mail/v1/health
)
! sudo systemctl is-active --quiet brain-mail.service
! sudo systemctl is-active --quiet brain-mail-mime.socket
! sudo systemctl is-active --quiet brain-mail.socket
! sudo systemctl is-enabled --quiet brain-mail.service
! sudo systemctl is-enabled --quiet brain-mail-mime.socket
! sudo systemctl is-enabled --quiet brain-mail.socket
```

## Rollback contract

The operator must stop and disable `brain-mail.service`, `brain-mail.socket`,
and `brain-mail-mime.socket` before rollback. Rollback then restores the backed-up
root-owned unit/config/projector files, runs `systemctl daemon-reload`, and
restores the previous Brain drop-in state. It does not delete
`/var/lib/brain-mail` or the wrapping key: those are user data and require a
separate explicit decision. If Brain had already been restarted with the client
group, rolling that membership back requires another approved Brain restart.

`systemd-sysusers` is additive and rollback deliberately leaves the inert
`brain-mail`, `brain-mail-client`, and `brain-mail-runtime` identities in place.
Likewise, empty tmpfiles-created runtime directories and the execute-only ACL
may remain after a failed install. With all Mail units disabled and the Brain
drop-in restored, these grant no running process new access; removing identities
is a separate reviewed cleanup, never an automatic rollback side effect.

The service projector always resolves an immutable release, so application
rollback selects the matching older Mail runtime on the next service start.
Never mix a newer projector/unit with an unreviewed older artifact.
The projector supports the reviewed pre-IMAP artifact shape only when the
`providers/imap` directory is completely absent. Once that directory exists,
`providers/imap/sync-adapter.js` is mandatory and a partial provider fails
closed. This narrow compatibility profile lets an operator install the new
projector before atomically promoting the first IMAP-capable release.

An initialized account cache also carries a persisted
`reset_imap_snapshot_on_legacy_credential_rebind` guard. If a previous runtime
rotates the legacy credential version for an IMAP account without knowing the
new provider-binding table, the guard deletes only the rebuildable local mail
snapshot and leaves an empty Inbox state for the next sync. This prevents rows
from the previous IMAP mailbox appearing under the edited account. Gmail token
rotation does not activate this guard.

Before starting a previous Mail runtime after an IMAP connection edit, require
one of these two proofs:

1. the complete pre-change state tree has been restored through the sealed
   snapshot flow below; or
2. the account cache still contains the exact persisted guard and its rollback
   rehearsal has passed for the release being left.

Do not restore or delete only `provider_cache_binding`,
`background_sync_control`, or `messages.sqlite3`. Partial cache surgery removes
the identity evidence that makes the guard fail closed. If either proof is
missing, keep Mail stopped and use the full-tree restore.

Manual rollback uses the printed transaction path:

```bash
sudo /bin/bash \
  /var/lib/brain-mail-install-transactions/<transaction>/rollback-recovery.sh \
  /var/lib/brain-mail-install-transactions/<transaction>
```

It first requires all Mail units to be stopped and disabled. For every file it
accepts only the exact backed-up state or the exact intended installed state;
anything else is treated as a later operator change and rollback stops before
changing any destination.

If the installer or rollback is killed, do not start another install. Re-run
rollback with the same transaction path; durable per-file progress lets it
finish from either side of the interrupted atomic rename. A later installer
also refuses to run and prints the unfinished transaction path. A directory
whose name ends in `.preparing` was interrupted before any destination change;
it must be inspected and removed through a separate reviewed operator action,
not passed to rollback.

## First v2 state snapshot and runtime rollback

- On first schema-v2 start, an existing encrypted `account.v1.json` is migrated
  inside one SQLite transaction. Its account ID and credential/binding versions
  are preserved. Only after commit is the file renamed to
  `account.v1.migrated.json`; a durable marker makes restart idempotent.
- The application deploy and application rollback do not restart
  `brain-mail.service`. The first v2 Mail start is a separate operator action.
  This is the maintenance boundary for the state snapshot.

Before the first v2 Mail start, stop the service and both sockets, then create
one exact snapshot:

```bash
sudo systemctl stop brain-mail-mime.socket brain-mail.socket brain-mail.service
test "$(sudo systemctl show --property=ActiveState --value brain-mail-mime.socket)" = inactive
test "$(sudo systemctl show --property=ActiveState --value brain-mail.socket)" = inactive
test "$(sudo systemctl show --property=ActiveState --value brain-mail.service)" = inactive
sudo /opt/brain/bin/brain-mail-state-rollback.py snapshot
```

For a clean first installation where `/var/lib/brain-mail` does not exist,
record that fact in the rollout log and skip the snapshot command. Do not
create an empty state directory merely to manufacture a snapshot.

Keep the printed `/var/lib/brain-mail-state-rollbacks/<snapshot>` path in the
rollout record. The root-only tool takes its own lock and repeats both stopped
checks before publishing the snapshot. It copies all of `/var/lib/brain-mail`
as one tree, including `account.v1.json`, SQLite, WAL, shared-memory, migration
markers, and every account cache that exists. Every regular file has its bytes
hashed and size checked. Every entry has its type, owner, group, mode, and
modified time checked. Symlinks, hard links, special files, a changed source
tree, and an incomplete restore all stop the operation. The tool never starts a
unit.

Never copy `local.sqlite3` or its WAL as individual live files. Never restore
only `account.v1.json` beside a newer SQLite database. Either action creates two
local account histories.

After v2 has started, a rollback of the application symlink leaves the already
running v2 Mail process alone. Do not stop, restart, or socket-activate Mail
against an older release until the v1 snapshot has been restored. Point the
application back to a v2-compatible release or run the full-tree restore first.

To restore for an explicit v1 Mail runtime rollback:

```bash
sudo systemctl stop brain-mail-mime.socket brain-mail.socket brain-mail.service
test "$(sudo systemctl show --property=ActiveState --value brain-mail-mime.socket)" = inactive
test "$(sudo systemctl show --property=ActiveState --value brain-mail.socket)" = inactive
test "$(sudo systemctl show --property=ActiveState --value brain-mail.service)" = inactive
sudo /opt/brain/bin/brain-mail-state-rollback.py restore \
  /var/lib/brain-mail-state-rollbacks/<snapshot>
```

Restore verifies the sealed snapshot again, makes a full staging copy, and uses
Linux atomic directory exchange so `/var/lib/brain-mail` is never a missing or
partly restored tree. The displaced v2 tree remains root-only under the printed
`/var/lib/brain-mail-state-restores/<transaction>/replaced-state` path. Do not
delete it during the rollback window. If the process stops after the exchange,
run the exact same restore command again. It resumes only when it can prove
which complete tree is live. Any ambiguous tree or changed manifest fails
closed without another exchange.

The v1 snapshot does not contain Brain-local account changes made after v2
started. Restoring it intentionally returns local configuration and caches to
the pre-v2 point. It does not change any remote mailbox. The wrapping key stays
outside the snapshot and must remain unchanged.

## Key loss and recovery

- Never rotate the wrapping key in place. Existing state becomes unreadable.
- A corrupt envelope or lost key does not trap disconnect: `DELETE /v1/account`
  never decrypts account state.
- If the key file itself is gone, keep the unreadable state/cache backed up,
  create a replacement key through the same one-time tool, start the service,
  and disconnect locally before reconnecting the account. The remote mailbox is
  untouched.
- The password cannot be recovered from Brain without the original key. Re-enter
  it when reconnecting.

## Disconnect and deadlines

Disconnect is local-only. Once admitted, it atomically renames only
`cache/<accountId>` out of the live namespace, deletes that account row and its
credential rows in one SQLite transaction, checkpoints the WAL, and returns a
truthful result. Recursive deletion of a large staged cache continues after the
response and is retried at every service startup. Staged cache directories are
never read as active mail. Deleting the migrated legacy account also removes
its inert `account.v1.migrated.json` archive.

Requests can be cancelled while waiting for the single mutation queue and
during DNS/TLS/auth. Once an atomic save or disconnect commit begins, the HTTP
handler waits for the real result rather than returning `408` and applying a
late mutation. The nominal budgets are five seconds for normal account
operations and ten seconds for connect verification; a final local fsync may
finish just beyond that budget.

Graceful service shutdown allows 12 seconds for active work, and systemd allows
15 seconds before force-stop. Sync and send now add provider work outside the
account-connect path. Their abort and drain behavior must pass the real Gmail
canary before these shutdown values are accepted for production.

## Evidence required before production

- `pnpm check` and `pnpm build` green on Linux Node 22;
- projected artifact smoke green with its systemd state/credential environment;
- the effective `brain-mail.service` and exact-artifact smoke command use only
  `--disable-warning=ExperimentalWarning` for `node:sqlite`; `NODE_NO_WARNINGS`
  and `--no-warnings` are forbidden;
- real fake-server implicit TLS and STARTTLS tests green, including no password
  before STARTTLS; focused unit tests separately prove PREAUTH rejection, peer
  proof, auth failure, timeout, and dead-first-address fallback;
- `bash -n` and `shellcheck` green for the key, installer, and rollback scripts;
- the stopped-service state snapshot/restore rehearsal green, including exact
  metadata, tamper rejection, full SQLite/WAL tree replacement, and interrupted
  exchange resume;
- `systemd-analyze verify`, sysusers/tmpfiles/ACL, projector isolation, and
  package extraction gates green;
- a reviewed installer plus rollback rehearsal. This last item is still a
  rollout blocker until CI evidence and human review pass; merge does not
  authorize production installation.

The exact release also needs a read-only Gmail content canary. Open one already
read test message with a unique body and a small attachment whose size and
SHA-256 are known. Verify sanitized text/HTML without remote network requests,
download and hash the attachment, reopen the body from cache, and confirm the
message labels did not change. Compare the notes repository commit and clean
status before and after. Review Mail/MIME journals for restarts, timeouts, OOM,
and logged message data; subjects, addresses, filenames, headers, and bodies
must never appear.

The later manual canary must also prove the effective unit can resolve DNS and
dial an allowed public IMAP endpoint while `SocketBindDeny=any` still prevents
local listener creation. Local fake-server tests cannot prove that systemd
egress boundary and must not be presented as live-egress evidence.
