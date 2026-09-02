# Brain operations

Brain deploys as immutable releases and runs as a dedicated operating-system user. Notes and secrets stay outside every release.

## Who this document is for

This is the **systemd** path: Brain as a service on a Linux host you have root
on, with immutable releases under `/opt/brain` and notes and secrets outside
every one of them. `docs/deploy-puller.md` builds on this layout, and so does
`pnpm deploy`.

It is not the first install. That one is the Docker Compose install in the
README — two containers against a folder of Markdown — and nothing in this
document is needed for it. Come here when you want systemd instead of
containers, and go back there for the container upgrade path.

There is no separate from-scratch procedure below. The migration section is
also the install, minus its PM2 sentences:

- Step 1 has no PM2 config to move values out of on a new host. Generate them.
- Step 5 has no running standalone directory to relocate. Extract a
  `brain-<version>-linux-x64.tar.gz` release asset and lay that down as the
  first release instead.
- **Skip step 6** if you did. That marker exists for a first release that has
  no `release.json`, which a hand-built standalone directory is and a release
  tarball is not, and a marker left beside metadata makes the next deploy fail
  closed on purpose.
- Steps 8 and 9 lose their `pm2` commands. `systemctl enable --now
  brain.service` is the whole cutover, and there is no PM2 process to fall
  back to — the fallback on a new host is the container install.

Every other step applies unchanged.

## Layout

- `/opt/brain/releases/<commit>-<timestamp>-<nonce>` contains immutable standalone builds. The deploy script retains the seven newest releases plus any older active/rollback target.
- `/opt/brain/current` is an atomic symlink to the active release.
- `/opt/brain/runtime/current` is an atomic symlink to Brain's pinned Node 22 runtime.
- `/opt/brain/notes` is the writable Markdown and Git source of truth.
- `/var/lib/brain/oauth` is Brain's private mode `0700` OAuth directory. Its
  mode `0600` state file contains client/grant metadata plus only hashed codes
  and current refresh nonces; its owner file enforces one live process/thread.
- `/var/lib/brain/sender-icons` holds cached favicon bytes for the mail
  sender-icon proxy. The cache is fully reconstructible, exempt from backups,
  and safe to delete at any time; Brain recreates it on demand.
- `/var/lib/brain/update` holds the update check's last answer from GitHub.
  The file is fully reconstructible, exempt from backups, and safe to delete
  at any time. Brain recreates it on the next check.
- `/etc/brain/brain.env` contains runtime secrets and is readable only by `root` and the `brain` group.
- `/etc/brain/deployer.env` contains the read-only GitHub token and merger
  allowlist. It is `root:root` mode `0600` and is never loaded by the app.
- `/opt/brain/bin` contains root-owned operational code. Today it is installed
  by hand; a release tarball ships the same files under `ops/bin/` (with units
  under `ops/systemd/`, sysusers/tmpfiles under `ops/sysusers.d/` and
  `ops/tmpfiles.d/`, and the reference nginx vhost under `ops/nginx/`) so the
  installer of B/E can apply them. The deploy puller never installs anything
  from an artifact.
- `/opt/brain/backups` contains up to seven rehearsal-verified rotating
  archives, `last-success.json` for the latest verified archive, and
  `last-attempt.json` for the latest backup attempt.

## Container image

`ghcr.io/michaelbrowk/brain:<version>` carries the same `server/` and
`mail-service/` as the tarball on Node 22.23.1 with `ripgrep` and `git`, and
runs as the unprivileged `node` user. `brain-entrypoint.sh web` starts the
Next standalone on `0.0.0.0:3020`; `brain-entrypoint.sh mail` creates
`/run/brain-mail/brain-mail.sock` and hands it to the Mail service as fd 3
(`LISTEN_FDS=1`, `LISTEN_FDNAMES=brain-mail`), which is the only way the
service will listen. `ops/docker/docker-compose.smoke.yml` runs both as two
services of one image sharing the socket volume; it is the release smoke, not
the onboarding compose file (B). Inside the image there is no per-message
MIME worker yet: Mail reports `mail_mime_worker_unavailable` for bodies that
need parsing until B designs supervision. A systemd install stays on systemd.

## One-time migration from root PM2

Perform this in a maintenance window. Keep `/opt/brain/ecosystem.config.js` intact as the rollback source until the reboot check succeeds. PM2 and systemd cannot listen on port 3020 at the same time.

1. Create a locked `brain` system user and `/etc/brain` group-readable environment file. Move values from the existing PM2 config without printing them to the terminal or shell history. Install the runtime search dependency with `apt-get update && apt-get install -y ripgrep`, then verify `command -v rg` as the `brain` user.
2. Run `ops/install-node-runtime.sh` as root. It verifies the official Node `22.23.1` Linux x64 archive against its pinned SHA256 and installs it under an installation lock only in `/opt/brain/runtime`, leaving other applications untouched. Node 20 is end-of-life and must not remain the Brain runtime.
3. Set `NOTES_ROOT=/opt/brain/notes`, `BRAIN_PUBLIC_ORIGIN=https://brain.example.com`, `HOSTNAME=127.0.0.1`, and `PORT=3020` in `/etc/brain/brain.env`. Ensure `AUTH_SECRET` contains at least 32 bytes. Add separate plain 64-character hex `BRAIN_READINESS_TOKEN` and `BRAIN_EDGE_RATE_SECRET` values generated with `openssl rand -hex 32`. The readiness token authenticates only the deep loopback deploy probe. The edge secret is shared only with the root-readable nginx include described in `docs/mcp-oauth.md`; nginx must overwrite the trusted edge/source headers and apply source-level OAuth limits. Bind to loopback so the application port is not reachable directly from the internet. `brain.service` creates `/var/lib/brain`; Brain creates `/var/lib/brain/oauth` privately. Do not place OAuth state inside an immutable release.
   The deploy pipeline never edits this file. Existing installations must add `BRAIN_PUBLIC_ORIGIN` before Mail mutations or MCP OAuth are enabled.
4. Recursively transfer the whole notes repository, including `.git`, with `chown -R brain:brain /opt/brain/notes`, then set the root mode to `0700`. Verify as `brain` that both the worktree and `git rev-parse --git-common-dir` are writable. Set `/etc/brain/brain.env` to `0640`, owned by `root:brain`.
5. Keep `/opt/brain` and its release/runtime directories root-owned and traversable by the service (`root:brain` `0750` for `/opt/brain`, `releases`, and `incoming`; the runtime installer makes `/opt/brain/runtime` root-owned `0755`). Move the current standalone directory into `/opt/brain/releases/bootstrap-<timestamp>`, then replace `/opt/brain/current` with a symlink to it.
6. Install the reviewed `ops/deploy-transaction.mjs` as root-owned mode `0755`
   at `/opt/brain/bin/deploy-transaction.mjs`. Create the one-time exception
   with the pinned runtime:
   `/opt/brain/runtime/current/bin/node /opt/brain/bin/deploy-transaction.mjs write-bootstrap /opt/brain <approved-sha>`.
   The helper fsyncs the root-owned mode `0600` file and its parent directory.
   Its only line is the exact reviewed 40-character `main` SHA.
   It permits exactly one deployment from the legacy bootstrap, which has
   neither `release.json` nor authenticated deep health. A successful deploy
   removes it. Never leave or recreate this marker during normal operation. If
   an operator interruption leaves a marker beside an already managed
   `current/release.json`, deploy fails closed; compare authenticated health
   with that metadata before removing the stale marker manually.
7. Copy `ops/brain.service` to `/etc/systemd/system/brain.service` and run `systemctl daemon-reload`. The reviewed unit declares Next.js's explicit graceful `SIGTERM` exit code `143` as successful. `KillMode=mixed` sends the first `SIGTERM` only to the main Node process, so its ordinary in-flight requests and child `git`/`rg` work can drain. New artifacts keep `server.js` as the stable entrypoint: its same-process wrapper installs the shutdown preload, then starts the preserved `brain-next-server.js`. A rollback to a legacy release still runs that release's original `server.js`. If the 20-second deadline is exceeded, systemd still kills the whole remaining service group. Do not start it while PM2 still owns the port.
8. Begin the reversible cutover: `pm2 stop brain`, then `systemctl enable --now brain.service`. Confirm `systemctl is-active brain.service`, `systemctl is-enabled brain.service`, `systemctl show brain.service -p User -p ExecStart`, exact Node `v22.23.1`, `rg --version`, and loopback-only port 3020. If any check fails, run `systemctl disable --now brain.service`, then `pm2 restart brain --update-env`; investigate before retrying.
9. Confirm authenticated deep health, login, editing, MCP OAuth discovery and consent, legacy MCP authentication, upload, search, Git history, and an archive restore. Revoke the test OAuth connection in **Settings → MCP** and confirm it stops working. Only after all checks pass, run `pm2 delete brain && pm2 save`, reboot once, and repeat `is-active`, `is-enabled`, loopback, health, search, and edit checks. If the reboot check fails, disable systemd and restore Brain from the untouched `/opt/brain/ecosystem.config.js`, then `pm2 save`.
10. Provision the existing scoped notes deploy key as `/etc/brain/notes-deploy-key` and pin GitHub's host key in `/etc/brain/known_hosts`. Both files stay outside releases and are readable only by `root:brain`.
11. Create `/opt/brain/bin` as `root:root` mode `0755` and
    `/opt/brain/backups` as `brain:brain`. Install `ops/backup-notes.sh` and
    `ops/verify-notes-backup.py` under `/opt/brain/bin` as root-owned mode
    `0755`, plus `ops/brain-backup.service` and
    `ops/brain-backup.timer` under `/etc/systemd/system`. Run
    `systemctl daemon-reload`, enable the timer, and run the service once
    manually. Set `BRAIN_BACKUP_HEALTHCHECK_URL` only in
    `/etc/brain/backup.env` if an external heartbeat is used.

Other applications on the server must also move away from root-owned PM2 processes. A root process can still read Brain even after Brain itself is isolated.

## Failure alerting

Every Brain unit (`brain.service`, `brain-mail.service`, `brain-backup.service`,
`brain-deploy-puller.service`) declares `OnFailure=brain-alert@%n.service`. The
template unit runs `/opt/brain/bin/brain-alert.sh`, which posts one line — host,
unit, `Result`, exit status, UTC time, never journal content — to a dedicated
Telegram bot. One-time setup:

1. Install `ops/brain-alert.sh` to `/opt/brain/bin/brain-alert.sh` (root-owned,
   mode `0755`) and `ops/brain-alert@.service` to `/etc/systemd/system/`, then
   run `systemctl daemon-reload`.
2. Create `/etc/brain/alert.env` (root-owned, mode `0600`) with
   `BRAIN_ALERT_TELEGRAM_TOKEN` and `BRAIN_ALERT_TELEGRAM_CHAT_ID` for the
   dedicated alert bot. Do not reuse another bot's token.
3. Test without touching a real service:
   `systemctl start 'brain-alert@smoke-test.service'` must deliver a message.

The alert path is deliberately non-fatal: missing configuration or an
unreachable Telegram API logs to the journal and exits 0, so a failed unit can
never be re-failed by its own alert. The backup dead-man's-switch
(`BRAIN_BACKUP_HEALTHCHECK_URL` in `/etc/brain/backup.env`) stays separate — it
also catches the timer never firing, which `OnFailure=` cannot see.

## Release deploy

GitHub Actions builds a versioned release on a `v*` tag and never connects to
the server; `brain-deploy-puller.timer` installs the latest published release
with a read-only GitHub token stored only on the server.

With `BRAIN_DEPLOY_SOURCE=release` the same timer installs the latest published
GitHub Release instead of the CI artifact; see the release source section of
`docs/deploy-puller.md`.

The puller rejects direct pushes, fork PRs, non-allowlisted mergers, a stale
`main`, unsuccessful or replaced run attempts, expired or duplicate artifacts,
unsafe archives, and a release whose deep health does not report the exact
commit. The same lock serializes puller and operator promotions. Setup, exact
permissions, canary steps, and the remaining GitHub Free trust boundary are in
`docs/deploy-puller.md`.

Do not put `MCP_TOKEN`, `BRAIN_READINESS_TOKEN`, `BRAIN_EDGE_RATE_SECRET`,
`AUTH_PASSWORD_HASH`, `AUTH_SECRET`, `OPENROUTER_API_KEY`, or a production SSH
key in GitHub.

For an operator-run fallback, run from a clean checkout with Node 22 and pnpm
11:

```bash
BRAIN_DEPLOY_HOST=<ssh-host> pnpm deploy <version>
```

`BRAIN_DEPLOY_HOST` is **required and has no default** — the ssh host or alias
the release is uploaded to. Unset, the script exits with
`set BRAIN_DEPLOY_HOST to the ssh host of your server` — after it has checked
the version argument and asserted the version, and before it downloads,
connects, or uploads anything.
Put it in the shell profile or the ssh config beside the alias it names, so a
fallback deploy is one command. `BRAIN_DEPLOY_BASE` still defaults to
`/opt/brain`.

`pnpm deploy <version>` runs the full gate, refuses a draft or missing
release, downloads the two release assets, verifies `SHA256SUMS`, and uploads
the extracted tree; the remote side is unchanged. That remote side rejects
special entries and hard links, then normalizes
the complete incoming tree to `root:brain`, directories `0550`, and regular
files `0440`. It then runs the installed bounded tree verifier and rejects
broken, cyclic, absolute, out-of-release, or required-path symbolic links before
a durable marker can refer to the upload. It refuses to start over
an existing durable pending marker or transaction journal, leaving that recovery
to the puller. For its own promotion
it uses the same fsynced pending-marker and transaction-journal protocol as the
automatic puller, so an interruption is classified by the same startup recovery.
Before switching, normal operation requires authenticated deep health
from the current process and an exact match with `current/release.json`. A
degraded or ambiguous rollback target blocks deployment. It then atomically
switches `current`, restarts `brain.service`, verifies the authenticated deep
`/api/health?ready=1` probe over loopback, and rolls back the symlink if startup
or health checks fail. A startup-installed irreversible shutdown latch closes
both existing and newly registered long-lived `/api/events` streams before
Next.js drains ordinary in-flight requests. If `SIGTERM` arrives after Next's
listener but before the app latch, the original signal is not replayed. Browsers
reconnect event streams after startup. The public `/api/health` route is liveness-only. It never
overlays files into the active release, rejects low disk headroom, removes
abandoned incoming uploads after seven days, and retains a bounded release
history.

A tab that was open across the switch still holds the previous release's
`/_next/static/chunks` URLs, which the new `current` no longer serves. The
shell navigates in place and loads its surfaces on demand, so the first
surface such a tab has not opened yet fails with a chunk-load error rather
than a router navigation. The tab reloads itself once for that
(`lib/stale-chunk.ts`, guarded per URL and build in `sessionStorage`), which
fetches the new release; a second failure in the same build shows the error
screen with a Reload button instead of looping. A tab that cannot write
`sessionStorage` (private mode, a full quota) never reloads on its own, by
design, and gets that screen straight away; so does a tab that is offline,
since the same error comes from a dropped connection. Next's `deploymentId` is
deliberately not set: on a single server it only turns a router navigation
into a hard reload, and the shell does not navigate through the router.

The puller writes `release.json` and `deploy-provenance.json` after it has
normalized the tree, so the writer gives them the release directory's group:
they end up `root:brain`, readable by the service like every other release
file, and the puller refuses to promote a release whose metadata is not. (The
operator path writes them before upload, and the remote normalization above
covers them.) A `version: null` from `/api/health` right after a deploy means
the app user cannot read `release.json`; once the ownership is fixed the next
health poll picks the file up without a restart.

Two more signals arrive with a release. Settings → Account shows the running
version (from `release.json` at the app root) and, once a day, whether a newer
release exists on GitHub — the check runs thirty seconds after boot and then
daily, keeps its answer in `/var/lib/brain/update/update-check.json`, and is
off with `BRAIN_UPDATE_CHECK=off`. And a tab that was open across a deploy
learns about it when its event stream reconnects: the shell compares the
server's commit from `/api/health` with its own build id and offers one
"Brain was updated · Reload" line instead of waiting for a missing chunk.

Journal removal commits the manual deployment only after its deployment-directory
fsync returns successfully. If unlink succeeded but that fsync or command still
fails, the in-process rollback trap retains the exact previous/candidate authority
even though the journal name is already absent. Before changing `current`, it
exclusively recreates the exact journal or validates the existing one. It keeps
that authority while restoring and fsyncing `current`, recreating the one-time
bootstrap marker when applicable, verifying the previous release, and removing
the candidate. The final journal clear retries its parent-directory fsync and
reconciles an absent name with an explicit base-directory sync. A later puller
therefore observes either the fully committed candidate or deterministic
previous-release state, never an
unclassified active candidate.

## Rollback

For rolling back **which source feeds deploys** (a bad GitHub release, or a
return to CI-artifact deploys), see "Rollback of the source" in
`docs/deploy-puller.md` — the release bridge never downgrades on its own.
The procedure below rolls back the **installed release** on a systemd host.
It does not apply to the Compose install: there, rolling back is pinning the
previous image tag in `docker-compose.yml` and running `docker compose up -d`
again.

Acquire the same lock used by deploy before any manual rollback:

```bash
exec 9>/opt/brain/.deploy.lock
if ! flock -w 300 9; then
  echo "timed out waiting for the Brain deployment lock" >&2
  exit 75
fi
if [[ -e /opt/brain/.deploy-transaction.json || \
  -L /opt/brain/.deploy-transaction.json || \
  -e /opt/brain/.deploy-pending.json || \
  -L /opt/brain/.deploy-pending.json ]]; then
  echo "automatic deployment recovery is pending; refusing manual rollback" >&2
  exit 75
fi
```

If either recovery file exists, run the automatic puller recovery first and
verify both were cleared. Do not replace its recorded cleanup or rollback
decision manually.
Keep that shell and descriptor open. While holding it, verify the target's
`release.json`, point `/opt/brain/current` to it using a temporary symlink plus
`mv -T`, restart `brain.service`, then verify authenticated deep health reports
the target commit and perform an authenticated page read. Never change
`current` outside this lock.

## Attachment privacy cache cutover

Upgrade note. It applies to an install that ran a version before the guarded
media route, and to no other.

Attachments are served from `/_attachments-v2/<name>`, a namespace that must
stay private and uncached. Earlier versions answered `/_attachments/<name>` and
`/api/media/<name>` publicly, with a one-year immutable cache lifetime. Origin
authorization cannot revoke an object a CDN or a browser is already serving out
of its own cache, so tightening the origin is not enough by itself: the objects
cached from the old namespace have to be purged once, and until they are, an
unauthenticated request can still be handed one.

If you are upgrading such an install, do all of this in one rollout:

1. Deploy the guarded route and verify your own authenticated access through a
   v2 URL.
2. Purge every cached v1 `/_attachments/*` and `/api/media/*` object at every
   cache in front of the origin. Use a full purge if your CDN cannot purge by
   prefix. Do not purge before the guarded origin is live, or a v1 object can
   be cached publicly again between the two steps.
3. Request a known v1 object without cookies and verify `404`,
   `Cache-Control: private, no-store`, and no cache hit. Then verify the same
   object still loads for an authenticated session.
4. Verify an unlocked shared page can load only an attachment it references,
   with the matching `page` and `v` query. Verify a locked share also needs its
   page-scoped cookie.

Do not start an attachment import until steps 1–3 pass. A browser that already
downloaded bytes cannot be made to forget them; the purge is what stops a new
unauthenticated request from being handed the old cached response.

A fresh install has nothing to purge — it never served the v1 namespace.

Notion imports send files larger than 1 MiB as raw bytes to
`POST /api/mcp/notion-upload`; send the UTF-8 filename as base64 in
`x-file-name-b64` and the frozen descriptor hash in `x-expected-sha256`. Both
routes accept the Store's 25 MiB per-file limit. The 1 MiB figure is a
client-side routing threshold, not a cap: above it the importer stops paying
base64 overhead and uses the binary route. Configure the exact binary route in
Nginx with `client_max_body_size 26m`, `proxy_request_buffering off`, and a
120-second read/send timeout. The reference vhost
`ops/nginx/brain.conf.example` carries exactly this location. The ordinary MCP
JSON route needs no body limit of its own: it sits under the server-level
`client_max_body_size` and the application enforces 25 MiB itself.
Verify the limit through Cloudflare and Nginx with a disposable near-25 MiB
file before a bulk import. The application admits one body stream at a time and
returns `429` with `Retry-After` to parallel upload attempts.

### What a move writes

A page's children are blocks of its body, so a move between parents is two
body edits under one journal, whoever asks for it — the sidebar, a page-ref
nesting gesture in the editor, or MCP `move_page`. Every standalone
`[label](/p/<id>)` paragraph for the page leaves the old parent's body; a
reference inside a sentence is prose and stays. One such paragraph is appended
at the top level of the new parent's body, after any container the body left
open, unless that body already links the page anywhere. A reorder among
siblings edits no body. The two rewritten pages record who asked —
`updatedBy: me` for a human, `updatedBy: claude` for MCP — and the response
names the old parent as `unlinkedFrom`, or `null` when no body changed.

### Recovering a stuck move journal

A cross-parent move — from the sidebar, from a page-ref nesting gesture in the
editor, or from MCP `move_page` — is journaled in
`<NOTES_ROOT>/.brain-move-intent.json` (on the server
`/opt/brain/notes/.brain-move-intent.json`, inside the `brain:brain` mode `0700`
notes root) for the window between the directory rename and the body rewrites.
Startup replays or rolls that journal back before it builds the index, and it
fails closed when the disk matches no state the journal describes. Never delete
the journal without finishing the move by hand: that strands a page between
parents, loses its sibling order, or leaves a body claiming a child it no
longer has.

**What it looks like.** `GET /api/health?ready=1` answers `503`, every page
request answers `500`, and `journalctl -u brain` repeats one of:

- `move intent origin revision mismatch: <pageId>` — the old parent's `index.md`
  is neither the recorded before-text nor the recorded after-text
- `move intent destination revision mismatch: <pageId>` — the same for the new
  parent
- `page-ref move intent parent revision mismatch: <pageId>` — the same for the
  page whose reference row was dragged
- `ambiguous move intent for page <pageId>` — the moved page's directory exists
  at both `originalDir` and `targetDir`
- `move intent lost both page locations: <pageId>` — it exists at neither

The process does not exit, so systemd does not restart it. Every request
retries the start, so once the journal is repaired the next request answers
`200` without a restart.

**The journal** is one JSON object:

| field | meaning |
| --- | --- |
| `pageId` | the page being moved |
| `originalDir`, `targetDir` | its directory before and after the move, relative to the notes root |
| `originalParentId`, `targetParentId` | the parents (`null` is the top level) |
| `nextOrder`, `updated` | the sibling order and timestamp the move stamps on the moved page |
| `originPageRef` | the old parent: `indexFile`, `beforeRaw`/`beforeRev`, `afterRaw`/`afterRev`. The after-text has every standalone `[label](/p/<pageId>)` paragraph removed |
| `destinationPageRef` | the new parent, same shape. The after-text has one `[label](/p/<pageId>)` paragraph appended |
| `pageRefNest` | an editor nesting gesture: `parentIndex` with `originalParentRaw`/`nextParentRaw`, and `targetPage` shaped like `destinationPageRef` |

**Procedure.** Paths below are relative to `/opt/brain/notes`.

1. `systemctl stop brain`.
2. Take a snapshot before touching a file. `git -C /opt/brain/notes log -3
   --stat` shows what the last automatic commit already holds; then
   `cp -a /opt/brain/notes /root/notes-move-recovery-$(date -u +%Y%m%dT%H%M%SZ)`.
3. `jq . .brain-move-intent.json` and read every field above.
4. Find the phase: `test -d "$originalDir"; test -d "$targetDir"`. Exactly one
   of the two must exist. If both or neither exist, do not move or write any
   file. Use the notes' Git history (`git log --all -- <dir>`) to find where
   the page's `index.md` last was, restore that, and only then continue.
5. Pick the direction the disk is already in. **Forward**, when the page is at
   `targetDir`: write each recorded after-text over its file —
   `jq -r .originPageRef.afterRaw .brain-move-intent.json > <indexFile>`, the
   same for `destinationPageRef`, `pageRefNest.parentIndex` (takes
   `nextParentRaw`) and `pageRefNest.targetPage` — and set `order:` in the moved
   page's own `index.md` frontmatter to `nextOrder`. **Back**, when the page is
   at `originalDir`: write the before-texts (`beforeRaw`, `originalParentRaw`)
   instead, and `rmdir "$targetDir"` if an empty directory was left there.
6. Compare first. If a current file equals neither its before-text nor its
   after-text, someone edited it after the crash. Keep that edit and apply the
   delta by hand: forward means removing every paragraph that is exactly
   `[label](/p/<pageId>)` from the old parent and appending one such paragraph
   to the new parent; back means the reverse.
7. `rm .brain-move-intent.json`.
8. `systemctl start brain`. The authenticated deep probe must answer `200`:
   `curl --fail -H "X-Brain-Readiness: $BRAIN_READINESS_TOKEN"
   http://127.0.0.1:3020/api/health?ready=1`. Open the moved page and confirm
   it sits under the parent you settled on.

## Backup acceptance checks

### Safe verifier and script rollout

Keep the timer stopped until the new pair proves one complete backup. Do not
replace the script while `brain-backup.service` is active.

```bash
systemctl stop brain-backup.timer
while systemctl is-active --quiet brain-backup.service; do sleep 1; done

rollback="/root/brain-backup-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0700 "$rollback"
cp -a /opt/brain/bin/backup-notes.sh "$rollback/"
if test -e /opt/brain/bin/verify-notes-backup.py; then
  cp -a /opt/brain/bin/verify-notes-backup.py "$rollback/"
fi

install -o root -g root -m 0755 ops/verify-notes-backup.py \
  /opt/brain/bin/.verify-notes-backup.py.new
mv -T /opt/brain/bin/.verify-notes-backup.py.new \
  /opt/brain/bin/verify-notes-backup.py
sync -f /opt/brain/bin/verify-notes-backup.py
sync -f /opt/brain/bin

install -o root -g root -m 0755 ops/backup-notes.sh \
  /opt/brain/bin/.backup-notes.sh.new
mv -T /opt/brain/bin/.backup-notes.sh.new /opt/brain/bin/backup-notes.sh
sync -f /opt/brain/bin/backup-notes.sh
sync -f /opt/brain/bin

systemctl start brain-backup.service
systemctl --no-pager --full status brain-backup.service
```

Run the read-only status check below and confirm its referenced archive exists
with the recorded byte count. Then run the manual extraction rehearsal. Only
after both pass, run `systemctl enable --now brain-backup.timer`.

If the manual service or either validation fails, leave the timer stopped.
Restore the saved script atomically while keeping the verifier installed:

```bash
install -o root -g root -m 0755 "$rollback/backup-notes.sh" \
  /opt/brain/bin/.backup-notes.sh.rollback
mv -T /opt/brain/bin/.backup-notes.sh.rollback /opt/brain/bin/backup-notes.sh
sync -f /opt/brain/bin/backup-notes.sh
sync -f /opt/brain/bin
systemctl start brain-backup.service
```

Re-enable the timer only after the old service checks pass. Do not delete or
edit `last-success.json`, `last-attempt.json`, or the referenced archive during
rollback. An old script no longer updates `last-attempt.json`, so Settings
truthfully becomes stale after 36 hours instead of inferring success.

A backup is successful only when all of these pass:

1. `git fsck --no-dangling` succeeds in the notes repository.
2. The exact captured commit is clean and its offsite Git push succeeds.
3. After acquiring the backup lock, the verifier removes abandoned private
   staging directories only when both their exact
   `.brain-notes-YYYYMMDDTHHMMSSZ.XXXXXX` name and directory mtime are at least
   six hours old. Cleanup accepts only same-owner, private regular files and
   real directories on the backup filesystem. It uses descriptor-relative
   `O_NOFOLLOW` traversal, skips links, special entries, hard-linked files, and
   mount boundaries, and is capped at 4,096 backup-root entries, eight stale
   directories per run, and 25,000 entries/depth 40 per staging tree. Published
   archives, `last-success.json`, and its referenced last-known-good archive do
   not match the private staging pattern and are never cleanup candidates.
   The six-hour quarantine deliberately leaves residue in place during an
   immediate retry; the next nightly run cleans it. An unusual or over-limit
   candidate is logged and left for operator inspection rather than traversed.
4. Before `git archive`, the verifier checks worst-case simultaneous staging
   space on the backup filesystem. The archive child alone receives a
   byte-exact 512 MiB `RLIMIT_FSIZE`, so a partial oversized gzip fails inside
   private staging without constraining the later raw-tar rehearsal.
5. `git archive` snapshots that immutable commit, so concurrent edits cannot mix worktree and Git states inside the archive.
6. `gzip -t` passes, then `verify-notes-backup.py` rejects paths outside
   `brain-notes/`, links, devices, and other special entries before extracting
   every regular file into a private temporary directory.
7. The archive and `last-success.json` are atomically published and synced with
   their parent directory. The status contains only `status`, archive basename,
   commit, byte count, and UTC verification time.
8. `last-attempt.json` is written after the process owns the backup lock and is
   atomically advanced from `running` to `success` or a bounded failure code.
   A lock loser never overwrites the active attempt. A process killed before
   the terminal write leaves `running`; the owner API treats it as interrupted
   after 20 minutes.
9. The job emits a successful system log or external heartbeat.

The envelope below is fixed rather than fitted to whatever vault it happens to
run over. Each limit sits several times above what an ordinary personal notes
repository produces, so normal growth never approaches one, while a corrupt or
hostile archive still meets a ceiling that does not move. Measure your own
vault against them before raising any of them. Limits are:

- 512 MiB compressed archive and 1.5 GiB decompressed tar stream;
- 8 MiB for one PAX or GNU metadata record, 16 MiB across all such records,
  and 1,024 metadata records;
- 20,000 members;
- 1,024 UTF-8 bytes per normalized path, 8 MiB across all normalized paths,
  and depth 32;
- 64 MiB per regular file and 1 GiB aggregate regular-file content;
- 20:1 aggregate regular-file to compressed-archive ratio.

The gzip stream is copied with the 1.5 GiB cap before Python's tar parser sees
metadata. A raw tar-header pass then enforces both PAX/GNU caps. The current
Git-produced archive has only a small service metadata record, so 16 MiB leaves
orders of magnitude of headroom without allowing accumulated global PAX values
to consume process memory toward the tar-stream cap. Validation and extraction
are separate passes over that bounded temporary tar.

Disk reserve is the declared uncompressed content plus the greater of 5 GiB or
10 percent of the destination filesystem. Before staging the tar, the verifier
also requires that reserve plus the complete simultaneous caps: 512 MiB gzip,
1.5 GiB raw tar, and 1 GiB extraction. The pre-archive requirement is therefore
`max(8 GiB, 10% of filesystem size + 3 GiB)`. It runs before `git archive`
writes a byte, so a host that cannot meet it fails the check without touching
the repository. Size the backup filesystem for that figure, not for the
finished archive. The smoke
test can only tighten maximum-style limits and can only raise the minimum
free-space reserve in explicit private test mode. Production defaults do not
read configurable limit values.

Read the status without changing backup state:

```bash
sudo -u brain /opt/brain/runtime/current/bin/node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = "/opt/brain/backups";
  const status = JSON.parse(
    fs.readFileSync(path.join(root, "last-success.json"), "utf8"),
  );
  if (!/^brain-notes-\d{8}T\d{6}Z-[0-9a-f]{12,64}\.tar\.gz$/
      .test(status.archive)) process.exit(1);
  const archive = path.join(root, status.archive);
  const ageHours = (Date.now() - Date.parse(status.verifiedAt)) / 3_600_000;
  if (status.status !== "ok" || !Number.isFinite(ageHours) ||
      fs.statSync(archive).size !== status.archiveBytes) process.exit(1);
  console.log(JSON.stringify({...status, ageHours}));
'
```

The nightly timer includes up to five minutes of random delay. Investigate a
failed attempt or an attempt age above 36 hours with
`systemctl status brain-backup.service` and
`journalctl -u brain-backup.service`. `last-success.json` intentionally remains
at the last known good rehearsal after a failed run; `last-attempt.json`
records that newer failure independently.

The owner-only `GET /api/settings/backup` reads both status files with bounded,
no-follow file access and returns no filesystem paths, archive names, stderr,
or raw exit codes. Settings → Data labels these as backup facts, never as
`Healthy` or `Recoverable`. A passed extraction proves that the archive can be
unpacked; it is not evidence of a full running-service restore.

To rehearse the newest archive manually without touching the notes repository:

```bash
sudo -u brain bash -Eeuo pipefail <<'SH'
root=/opt/brain/backups
latest="$(find "$root" -maxdepth 1 -type f \
  -name 'brain-notes-*.tar.gz' -print | sort -r | head -n 1)"
test -n "$latest"
restore="$(mktemp -d "$root/.manual-restore.XXXXXX")"
trap 'rm -rf -- "$restore"' EXIT
/opt/brain/bin/verify-notes-backup.py "$latest" "$restore"
test -n "$(find "$restore/brain-notes" -type f -print -quit)"
echo "manual backup rehearsal passed: $(basename -- "$latest")"
SH
```

The rotating tar files contain the committed notes snapshot, while the private
offsite Git remote retains history. Test a clone from the offsite remote into a
temporary directory at least monthly. The nightly extraction rehearsal proves
the archive itself on every run.
