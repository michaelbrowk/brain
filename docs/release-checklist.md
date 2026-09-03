# Brain release checklist

Automated checks run in CI. The device checks below remain mandatory because browser emulation does not reproduce the iOS keyboard, touch arbitration, or Safari viewport events faithfully.

## Automated gate

- `pnpm check`
- `pnpm build`
- `pnpm smoke:standalone`
- `pnpm smoke:mail-service`
- `pnpm test:e2e:release`
- `test/data-versions.test.ts` opens every fixture set under
  `test/data-versions/<version>/` with the current code: account store, message
  and content cache, outbox, sealed Gmail token envelope, and OAuth state.
  `release.json`'s `minUpgradeFrom` is the oldest fixture version at or below
  the release. Capture a new set with
  `BRAIN_DATA_VERSION_CAPTURE=<version> pnpm data-versions:capture` in the
  release commit of any version a later release must upgrade from; never edit
  a captured set.
- The standalone smoke pauses instrumentation after Next installs its signal
  listeners, queues an accepted authenticated `/api/events` request, then sends
  `SIGTERM`. It proves the original signal reaches Next without a replay and the
  startup latch closes that late stream. A ready run drains 20 event streams
  while an authenticated partial `PUT` finishes after the signal with HTTP
  `200` and persisted Markdown. Both shutdown paths exit cleanly with code `143`
  in under three seconds.
- `docs/release-notes/<version>.md` exists and says, in plain language, what
  changed for the person using Brain: what was wrong before, what happens now.
  No usernames, no pull-request numbers, no commit subjects. The releases page
  on GitHub and the release list on michaelbrowk.com/brain both render this
  file as written, so it is product copy, not a commit log. `pnpm release`
  refuses a stable version without it; a pre-release may go without.
- `pnpm release <version>` from a clean, current `main`. The `Release`
  workflow for the tag is green: tarball, `SHA256SUMS`, two-architecture
  image, and the draft exist; the draft is published by hand. A red tag
  workflow produces no artifact and no draft. Publishing is the moment
  installations may see the version. A pre-release (`-` in the version) is
  marked pre-release and never becomes `latest`.
- When Brain Mail is installed, the root-owned runtime projector must exactly
  match the projector in the verified candidate before deployment state is
  created or services are restarted. A projector upgrade is a separate,
  transactional operator action followed by an old-release health canary. The
  reviewed deploy-puller guard itself must be installed while its timer is
  disabled before that canary and candidate promotion.
- Runtime projection tests must cover the immediately previous Mail layout and
  reject a release that contains only part of a new runtime feature group.
- The server's puller recorded the active ancestry floor and, for the release
  source, the release id, tag, version, publication time, author login/id, and
  both asset ids and sizes in `current/release.json`, merged with the shipped
  `version`, `buildTime`, and `minUpgradeFrom`. The digest itself is not a field
  there — it lives in the `SHA256SUMS` asset the id points at.
- A direct push to `main`, a fork PR, an unapproved merger, an expired artifact,
  a rerun with another attempt, an actor/merger mismatch, or a delayed replay of
  an old merge remains rejected by the puller tests. GitHub Compare must prove
  the candidate is not behind the active release even when the old run and
  artifact are otherwise still valid.
- Unit tests cover durable pending-marker, journal, and bootstrap-marker writes.
  The production recovery classifier and durable helpers also run through an
  executable 11-window fault-injection harness, with repeated recovery proving
  idempotence. Static checks additionally cover shell ordering, manual-fallback
  tree normalization, use of the same transaction protocol, and rollback wiring.
  A separate fault case covers journal unlink followed by a failed directory
  fsync: both rollback paths must validate or exclusively recreate the exact
  journal before switching. Executable prefix tests cover authority recreation,
  switch, restart, bootstrap write, health, candidate removal, pending clear,
  and final journal clear; every prefix must recover idempotently. The manual
  remote verifier must reject broken, cyclic, absolute, out-of-release, and
  required-path symlinks before pending authority. Numeric identity checks must
  reject a fetch UID alias of `brain` and a fetch primary GID alias of any
  `id -G brain` group. Before first
  timer enablement, run disabled-timer canaries
  for both a pending-only candidate and a journal-owned candidate. The next run
  must remove the unreferenced release or restore the previous release, validate
  health, and clear both recovery files without changing the healthy commit.
- OAuth tests cover strict login return targets, authenticated aggregate and
  per-client rate-limit isolation, fail-closed limiter capacity, direct-origin
  rejection, 100 parallel owner-claim restart races, generation beyond 512
  without a global spent-token cap, per-family replay revocation, unknown-code
  read-only rejection, restart continuity, downscope persistence, and exported
  MCP route wrappers.

## Desktop browser

1. Sign in, create a page, edit twice, switch away, and return. Both edits remain.
2. Open search, history, settings, trash, and share using keyboard only. Focus returns to each trigger.
3. Disconnect the network during a save and a destructive action. The UI keeps the local state, reports the failure, and offers a safe retry.
4. Open the same page in two tabs and through MCP. Resolve a revision conflict without losing either version.
5. Move a page with children, then inspect and restore a version created before the move.
6. Export a page with one child, an internal page link, and a local attachment.
   Open the `.brain.tar.gz` outside Brain and confirm it contains separate
   Markdown files plus the attachment. Dry-run its import, confirm no page was
   created, then apply it and confirm the imported copy has fresh ids, working
   links, and leaves the source pages unchanged.

## Physical iPhone Safari

1. Open a page, focus the editor, and show the software keyboard. The floating toolbar stays directly above the keyboard during show, hide, rotate, and predictive-text changes.
2. Tap every header, sidebar, tree, toolbar, settings, and trash action near the edge of its visible icon. Isolated controls provide a 44px target. Dense controls provide at least 24px. The intended control always wins and adjacent hit areas never overlap.
3. Drag blocks within and across columns on a page laid out in two or more columns. Selection, ghost position, drop target, and final Markdown remain correct.
4. Use the photo picker and file picker. Cancel, large image, unsupported type, upload failure, and retry leave no orphaned attachment.
5. Increase Safari text size and rotate to landscape. There is no horizontal page overflow and controls remain reachable.
6. Enable Reduce Motion. All workflows remain understandable without motion.

## Sharing and security

1. Create a password-protected share, open it in a private browser, and verify only that page is available.
2. Change the share password. The old share cookie stops working immediately.
3. Restart Brain. The page remains password-protected.
4. Delete the page. Its share URL returns not found.
5. Connect an OAuth-capable MCP client to `/api/mcp`. Verify Brain marks the
   supplied client name as unverified and shows the complete exact redirect URI
   plus requested scopes before approval.
6. A read-only connection can list/read/search but cannot create, edit, move,
   delete, or run import tools. Write and import calls return HTTP `403` with
   exact `scope` and `resource_metadata` in `WWW-Authenticate`. Revoke it in
   **Settings → MCP** and verify both its access token and refresh flow stop.
7. Verify the legacy MCP token still works only for `/api/mcp` and cannot
   authorize other API routes during migration.

## Production verification

1. `/api/health` reports the reviewed Git commit.
2. `brain.service` is active and enabled under the `brain` user, restart count is stable, and the one-time `.bootstrap-deploy-once` marker is absent after the first immutable deploy.
3. With at least one authenticated Brain tab open during rollout, the systemd
   journal has no `stop-sigterm timed out` or `SIGKILL`; the event stream
   reconnects and the new process starts within five seconds.
4. Port `3020` listens only on loopback.
5. nginx overwrites both Brain trusted-edge headers, trusts
   `CF-Connecting-IP` only from current Cloudflare CIDRs, and applies an outer
   per-source limit on public OAuth routes. A direct loopback call without edge
   proof fails closed; two separate sources do not share an application bucket.
6. `rg --version` works in the service environment and search returns a known body match.
7. Notes and secrets are not readable by unprivileged service users.
8. The newest offsite push and immutable-commit archive both pass, then archive extraction and a temporary clone from the offsite remote succeed.

## Before publishing a new public tree

Run `pnpm verify:public`. It exports the tree exactly as the cutover does,
installs it in isolation, and runs the gate inside the export — a green run is
the only evidence that the public repository will build for a stranger.
