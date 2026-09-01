# GitHub Free deploy puller

GitHub Actions builds the release tarball and image on a version tag. It has
no SSH key, server address, application secret, or write token. Production
initiates every connection.

## Acceptance contract

The root-owned puller follows a recurring two-minute calendar schedule with up
to 15 seconds of jitter. If one poll is still running, systemd skips that start
and keeps the next calendar event scheduled. `Persistent=true` also catches up
after timer downtime. A slow or failed poll therefore cannot consume the only
recurring trigger and leave the timer in `active (elapsed)`. The puller accepts
a candidate only when all of these remain true:

1. The candidate is the current `main` SHA.
2. That exact SHA is `merge_commit_sha` for one closed, merged PR whose base and
   head repositories are both the configured Brain repository. The complete,
   bounded associated-PR listing is repeated during every recheck and must still
   contain that same sole eligible PR.
3. The full PR response confirms that `merged_by.login` is in the root-managed
   merger allowlist. The merger's stable GitHub user id is pinned.
4. The all-status workflow listing contains exactly one `push` run of
   `.github/workflows/ci.yml` for that SHA. It must be the newest workflow run
   overall and must be completed successfully on its first attempt. Repository,
   head repository, branch, workflow id, and run id must match. Both the run
   actor and triggering actor must pin the merger's login and stable user id,
   and both run creation and attempt start must occur within five minutes of the
   merge. This prevents replaying an old approved merge with a rerun or delayed
   direct push.
   GitHub Compare must also prove that the candidate equals or is a forward
   descendant of the currently active release commit. The active commit is
   pinned into the candidate and the ancestry check repeats during recheck, so
   force-pushing `main` back to an old approved SHA remains non-deployable even
   while its original successful run and artifact still exist.
5. Exactly one unexpired `brain-standalone-linux-x64-<sha>` artifact belongs to
   that run. Its artifact id, size, and GitHub SHA-256 digest are pinned.
6. The downloaded zip matches the GitHub digest. It contains only the expected
   tarball and manifest. The manifest pins the commit, Linux, x64, byte count,
   build time, and tarball checksum.
7. The tarball contains only bounded regular files and directories. Absolute
   paths, `..`, duplicate paths, hard links, unsafe or broken symbolic links,
   sparse files, devices, FIFOs, encrypted zip entries, and expansion past the
   configured limits are rejected. Relative package links are accepted only
   when their complete chain resolves inside the extracted release.

The puller resolves and downloads as the locked `brain-deploy` user. Resolver
and extractor processes run in separate transient systemd cgroups with an empty
supplementary-group set, strict filesystem protection and `KillMode=control-group`.
Each exact GitHub API GET, including the authenticated artifact redirect, gets
at most four attempts. Retries use one, two, then four seconds of backoff, with
a hard 30-second total sleep budget. `Retry-After` accepts only whole seconds
or a canonical future HTTP date. A valid delay takes priority when it fits the
remaining budget. Only transport timeouts, connection errors, HTTP 408, 429,
500, 502, 503, and 504 are retried. HTTP 403 is retried only when GitHub
supplies a valid `Retry-After`. Authentication, missing-resource,
validation, malformed-response, redirect-trust, size, digest, and provenance
failures remain immediate fail-closed errors. Error output contains only the
HTTP status and GitHub request id, never a response body or token. The signed
object-storage download is not replayed after it starts. All network phases in
one resolver command share a 14-minute absolute deadline. Object storage keeps
its smaller ten-minute cap and is clipped to the remaining command time. This
leaves at least one minute for cleanup before the resolver cgroup reaches its
15-minute runtime limit.
The installer and every poll compare numeric identities, not group names: the
fetch UID must differ from the `brain` UID and its primary GID must differ from
every primary or supplementary GID held by `brain`. A pre-existing NSS/passwd
alias therefore fails closed instead of inheriting access to application secrets.
Only the resolver receives `/etc/brain/deployer.env` as a systemd credential.
The archive parser, root puller, filesystem tools, health checks, and Brain
process do not inherit the token. Every transient unit has a unique pinned name.
After `systemd-run` returns, root asks the service manager to kill and stop the
whole cgroup, then confirms through the manager that the unit is inactive. This
does not depend on `/proc` visibility. Root then revokes write ownership and
checks the tree again.
Root-owned code writes `release.json`, acquires the same deployment lock used by
the manual fallback, and rechecks GitHub immediately before the symlink switch.
It checks again after authenticated deep health. If `main` advances during
restart, the new process is rolled back.

`release.json` records the active ancestry floor; repository and repository ids;
PR and merger login/id; workflow actor and triggering-actor login/id; workflow,
run and first-attempt ids; artifact id, name, size, digest, creation/expiry and
workflow binding; and candidate resolution time. Releases remain immutable and
authenticated deep health remains the last gate.

Before moving a prepared tree into `releases/`, the puller durably writes a
root-owned mode-0600 pending marker and fsyncs it. After the move and a second
tree fsync, a separate transaction journal records the same exact release and
commit while the pending marker remains in place; only then may `current`
change. Startup recovery runs under both deployment
locks before GitHub configuration, resolver, extractor, or fetch-account
validation and before any "already active" path. A marker without a journal
removes only its unreferenced candidate; a leftover transaction always restores
the recorded previous release, removes the failed candidate, restarts Brain,
validates health, and only then clears the marker and journal. A healthy active
release is rechecked against GitHub without
requiring its artifact to remain available after the 14-day retention window.
If journal unlink succeeded but its directory fsync reported failure, the
in-process rollback first validates or exclusively recreates the exact journal
from its previous/release/commit/bootstrap tuple. It does this before changing
`current`, so a crash or failure anywhere in rollback remains recoverable. The
journal stays until the previous process is healthy, bootstrap authority is
restored when needed, and candidate plus pending state are gone. Journal clear
retries the directory barrier and reconciles an already-absent name with another
explicit deployment-directory fsync.
The manual fallback refuses to start over pre-existing recovery state and uses
the same durable pending-marker and transaction-journal protocol for its own
promotion. Its remote side runs the installed root-owned bounded tree verifier
after ownership/mode normalization and before the first tree fsync or pending
marker. Broken, cyclic, absolute, out-of-release, and required-path symlinks are
rejected under the same contract as automatic extraction. Before a new
download, the locked poll removes abandoned `.pull.*` workspaces and week-old
manual upload directories, then reserves space from the candidate's exact pinned
zip size, bounded extraction sizes, operational headroom, and the release
file-count inode limit.

## Release source (transition bridge)

With `BRAIN_DEPLOY_SOURCE=release` in `/etc/brain/deployer.env` the puller
keeps its whole transaction and changes only where the candidate comes from:

1. The target is the **latest published, non-draft, non-pre-release** GitHub
   Release of `BRAIN_DEPLOY_REPOSITORY` (`GET /releases/latest`). With
   `BRAIN_DEPLOY_RELEASE_TAG=v<semver>` the target is exactly that published
   release, pre-release or not; this is the only way a pre-release deploys.
2. The release must carry exactly one `brain-<version>-linux-x64.tar.gz` and
   one `SHA256SUMS`, both uploaded. Its tag must resolve to a commit that is
   GitHub-Compare-proven to be the active release commit or a forward
   descendant of it. The release id, tag, publication time, author login/id,
   and both asset ids/sizes are pinned in the candidate.
3. `SHA256SUMS` is downloaded first through the authenticated asset redirect,
   then the tarball, whose size must equal the asset size and whose SHA-256
   must equal its `SHA256SUMS` line. The extractor re-verifies that digest,
   applies the same path, link, and size rules as the Actions path, and
   requires the shipped `release.json` to name the resolved commit.
4. The merger allowlist, the workflow run binding, and the five-minute merge
   window do not apply; `BRAIN_DEPLOY_ALLOWED_MERGERS` is required only for the
   ci source and is ignored when set here. Provenance is "asset belongs to a
   published release of the configured repository". Recheck before and after the switch repeats the
   release lookup and the tag commit; a newer published release or a moved tag
   aborts the promotion.

No published release is a quiet wait (exit 75), not a failure. The installed
`current/release.json` is the shipped file (`version`, `buildTime`,
`minUpgradeFrom`) merged with the puller's `release`, `builtAt`, and a
`source` block of kind `release`. An active release from the CI source is
still rechecked by its own kind, so switching the source never invalidates
the running release. The CI source stays until E deletes the puller.

### Rollback of the source

Rehearsed on a release-candidate canary, not only designed:

- **Undo a bad release**: publish a fixed release (the puller only moves
  forward) or run the manual fallback `pnpm deploy <version>` with the
  previous good version. The puller's own health check already rolls back a
  release that fails deep health.
- **Return to the CI source**: retired as a rollback path — the push
  workflow no longer produces a deploy artifact, so with
  `BRAIN_DEPLOY_SOURCE` unset the CI source finds nothing to install and
  waits forever. Its code stays inert until E removes it with the puller. To
  roll back, run the manual fallback `pnpm deploy <version>` with the
  previous good version.
- **Steady state between releases**: `BRAIN_DEPLOY_SOURCE=release` with no
  pin logs `deploy source has no deployable target yet` until the first
  stable (non-pre-release) release is published, and the timer keeps
  retrying quietly.

Reinstalling the helpers (`ops/install-deploy-puller.sh`) requires the timer
**disabled**, not merely stopped — the installer refuses otherwise, and a
`&&`-chained call swallows that refusal.

## One-time setup

These steps are intentionally manual. Installing the files does not enable or
start the timer.

1. Create a fine-grained GitHub token scoped to only `michaelbrowk/brain` with
   Metadata read, Contents read, Actions read, and Pull requests read. It needs
   no write permission.
2. Install `acl`, `curl`, `python3`, `openssl`, and `util-linux` on the server.
   `acl` gives the locked fetch user traverse-only access to its incoming
   workspace. `util-linux` provides `flock`; transient execution uses the
   systemd already shipped by Ubuntu. The locked fetch account must have
   `/nonexistent` as home, `nologin` as shell, a locked password, its dedicated
   primary group, no supplementary groups, and no persistent processes. It must
   never share the numeric UID or any numeric primary/supplementary GID of
   `brain`, which can read application secrets. The installer refuses existing
   name aliases that resolve to those sensitive numeric identities.
3. Create `/etc/brain/deployer.env` without echoing the token into logs or shell
   history. Set it to `root:root` mode `0600`:

   ```text
   BRAIN_DEPLOY_GITHUB_TOKEN=<fine-grained read-only token>
   BRAIN_DEPLOY_REPOSITORY=michaelbrowk/brain
   BRAIN_DEPLOY_WORKFLOW=ci.yml
   BRAIN_DEPLOY_ALLOWED_MERGERS=your-github-login:1234567
   BRAIN_DEPLOY_SOURCE=release
   # BRAIN_DEPLOY_RELEASE_TAG=v0.9.0-rc.1
   ```

   Use your own login and numeric id — `gh api user --jq .id` prints yours. The
   numeric id is what the puller trusts; the login beside it is only there to
   read.

   Set `BRAIN_DEPLOY_SOURCE=release` only after the first release is published.
   Configured before one exists, every poll is the quiet exit-75 wait: the
   server silently stops deploying and no OnFailure alert ever fires.

   Each allowlist entry pins both the current GitHub login and its stable numeric
   account ID. A renamed login or a reclaimed old username therefore fails
   closed until this root-managed configuration is deliberately updated.

4. Stop and disable any previous puller timer. Review the exact commit, then run
   `sudo ops/install-deploy-puller.sh`. The installer refuses active units or
   held poll/deploy locks, and refuses to replace recovery code while a durable
   deployment marker or transaction is pending. It
   creates the locked `brain-deploy` user, copies the audited helpers to
   `/opt/brain/bin`, installs the two systemd units, and reloads systemd. It does
   not activate them.
5. Verify both installed units, then inspect the service sandbox. Run one
   canary with `sudo systemctl start brain-deploy-puller.service`, then inspect
   `journalctl -u brain-deploy-puller.service` and the `version` in
   `/opt/brain/current/release.json`. A currently active release is a safe
   no-op.

   When a release changes a root-owned deploy or Mail projection helper, keep
   the timer disabled and install that reviewed helper before the canary. First
   prove the currently active release still starts with the new helper; only
   then run the puller canary for the candidate. This orders the transition so
   either the old release stays healthy or the puller atomically promotes and
   health-checks the new one. Never make a direct push to `main` for this step:
   the provenance resolver intentionally accepts only a merged pull request.

   ```bash
   sudo systemd-analyze verify \
     /etc/systemd/system/brain-deploy-puller.service \
     /etc/systemd/system/brain-deploy-puller.timer
   systemd-analyze security brain-deploy-puller.service
   ```
6. Enable polling only after the canary:

   ```bash
   sudo systemctl enable --now brain-deploy-puller.timer
   systemctl list-timers brain-deploy-puller.timer
   systemctl show brain-deploy-puller.timer \
     --property=ActiveState \
     --property=SubState \
     --property=NextElapseUSecMonotonic
   ```

   The timer must report `ActiveState=active`, `SubState=waiting`, and a
   non-empty `NextElapseUSecMonotonic`. Repeat the two inspection commands after
   one poll completes to confirm that the next poll was rearmed.

To stop automatic release checks, disable the timer. The running Brain release
is not changed:

```bash
sudo systemctl disable --now brain-deploy-puller.timer
```

## Security assumptions

- The puller deploys what an allowlisted account merged, and that merge is
  the release approval. Where the plan or the repository cannot require branch
  protection or an independent reviewer, nothing else stands between a merge
  and a deploy — a direct push is possible, though it is not deployable.
- Someone able to merge as an allowlisted account can therefore ship
  application code. The application still runs as `brain`, not root. Require a
  second factor on every account on that allowlist and keep the list short.
- Puller, extraction, and promotion code under `/opt/brain/bin` is root-owned
  and is never taken from the application artifact. Updating it always requires
  another explicit operator install from a reviewed commit.
- The read-only token lives only in `/etc/brain/deployer.env` and is mounted
  read-only into the transient resolver as a systemd credential. Application
  secrets stay only in `/etc/brain/brain.env`. Neither file is copied into a
  release or GitHub.
- If a later setup needs approval independent of the merger, move the private
  repository to a GitHub plan with protected environments or add a separately
  held release-signing key. This puller deliberately does not pretend GitHub
  Free supplies that second approver.
