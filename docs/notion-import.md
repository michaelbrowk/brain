# Notion import protocol

Live imports must use the authenticated `notion_*` MCP tools. The legacy
`scripts/notion-import.py` writes the filesystem directly and is only retained
for offline export recovery. It must not target live notes.

## Safety model

- The Store remains the only writer for pages and attachments.
- `notionId` is the idempotency key. One Notion id can bind to one Brain page.
- Source and canonical target hashes are computed before finalize and verified
  again by the Store. The conversion hash commits to the immutable `parentId`
  and `beforeId` plan as well as title, icon, cover, and body.
- Body, title, icon, cover, parent, next sibling, and order changes stop an
  import. Existing pages are adopted only after a reviewed read and exact rev,
  parent, and next-sibling match.
- Brain page icons are text or emoji. File and URL icons fail as
  `incompatible_icon`; the planner records them as unsupported instead of
  silently dropping them.
- Covers must be deterministic local `/_attachments-v2/<sha256>.<ext>` URLs.
  Signed or external cover URLs fail as `incompatible_cover`. SVG images must
  be converted to a supported raster format or represented as downloadable
  files. The same raster-only check covers MIME aliases, misleading `.svg`
  names, and octet-stream descriptors for both image blocks and covers.
  Accepted legacy raster aliases (`image/jpg`, `image/pjpeg`, `image/x-png`)
  are canonicalized once, so signature checks, stored extension, deterministic
  URL, and returned MIME always agree.
  SVG aliases canonicalize to `image/svg+xml`: ordinary uploads reject them as
  active content, while the Notion path may stage them only for a file link.
- Attachments are content-addressed, staged outside the notes tree, promoted
  only during finalize, and served through the private v2 namespace. Every
  upload carries the descriptor's `expectedSha256`; byte mismatches fail as
  `hash_mismatch` before staging.
- The staging base, staging root, and active token directory must each be a
  real `0700` directory owned by the effective user. The permanent
  `_attachments` parent must remain the same real directory for the whole
  copy/install operation. Symlinks, owner/mode drift, directory replacement,
  and native filesystem failures return fixed `staging_unavailable` or
  `attachment_store_unavailable` errors without exposing a path, reservation
  token, or hash.
- Staging has per-reservation and process-root aggregate file/byte limits.
  Startup and uploads remove orphan and expired staging. Fresh leases survive;
  invalid, future, and exactly-TTL timestamps are stale. Filesystem accounting
  errors fail closed.
- Promotion preflights size and SHA-256 with streams, then copies and atomically
  installs one file at a time. It never buffers the full attachment batch.
- A failed or interrupted run is resumed from recorded ids and tokens. It never
  retries a missing parent at the root.
- Cross-parent moves use a durable `.brain-move-intent.json`. Startup either
  abandons a not-yet-renamed move or completes order persistence after a rename,
  before rebuilding the page index. An unresolved or ambiguous intent blocks
  startup instead of guessing.
- Abort metadata updates are per-page filesystem transactions. A durable
  `.brain-abort-intent-<nonce>.json` is written first; exact `before` and `next`
  files are then fsynced, and the actual canonical `index.md` entry is captured
  by rename inside an exclusive, process-owned `0700`
  `.brain-abort-txn-<nonce>` directory. The replacement is installed by a
  no-overwrite hard link. Every authoritative canonical file is read, hashed,
  file-fsynced, re-statted, and path-identity checked before the intent can be
  cleared; directory fsyncs make the namespace transitions durable.
- Startup reconciles abort intents before walking the page tree or rebuilding
  the Notion index. Canonical `before` rolls back, canonical `next` completes,
  and an atomically captured or already-visible external writer wins without
  being overwritten. Two distinct external candidates, malformed helpers,
  symlinks, hash/identity drift, or ambiguous state fail startup closed.
- A completed abort leaves a durable receipt on the preserved page. A retry
  replays that receipt only for the exact source hash and token proof. The next
  reserve must acknowledge the receipt with the same journaled source and
  token, then clears the receipt and installs the reservation in one canonical
  write. Adoption, direct creation with the same Notion id, and permanent
  deletion remain blocked until acknowledgement. Manual content, metadata, or
  hierarchy changes made before or after abort are preserved and make the
  acknowledgement fail as `source_changed`.
- An unresolved abort or move intent keeps the Git snapshot barrier held and
  poisons that Store instance against further mutations. A fresh Store may
  resume writes and Git snapshots only after startup reconciliation, tree/index
  rebuild, and staging reconciliation all succeed.

Never delete, rename, edit, or chmod an active `.brain-abort-intent-*`, its
`.brain-abort-txn-*`, `.brain-abort-next-*`, or matching recovery file by hand.
They are one recovery record, not disposable temporary files. Stop the writer,
preserve the complete page directory byte-for-byte, and diagnose the
fail-closed error before taking any operator action. A retained recovery file
whose intent and transaction helpers are already gone may be removed only by a
separate operator procedure after byte review and a stable Git snapshot.

## External journal

Keep one append-only JSONL journal outside the repository and notes root as an
effective-user-owned, single-link regular file with mode `0600` under an owned
real `0700` directory. The repository exclusion is derived from the importer
module location and still applies when the CLI starts from another working
directory. Symlinks and hard links fail closed. Opening the journal holds an
exclusive sibling lock until close, so two
executors cannot append or mutate from the same journal concurrently. It may
contain source ids, Brain ids, hashes, reservation tokens, attachment
filenames, statuses, and error codes. It must not contain MCP credentials,
Notion signed URLs, attachment bytes, or note bodies. Reservation tokens are
scoped importer capabilities. The active reservation lease is time-bounded,
but an abort-acknowledgement token remains valid until its durable receipt is
acknowledged. Raw tokens may be durable only in this private journal, active
reservation frontmatter, retained pre-abort recovery files, and the separately
private notes Git history. Canonical abort receipts store only a one-way token
hash. Raw tokens must never enter the application repository, public Git,
exception text, logs, status/read responses, or support messages.

The owner-token lock directory fails closed and is not auto-stolen. After an
executor crash, inspect the PID in its `owner-*` marker and confirm no importer
process is alive before manually removing the sibling `.lock` directory. Never
remove it merely because a run is slow. A predecessor can never remove a
manually recovered successor's unpredictable owner marker.

Record these events with a monotonically increasing sequence number:

1. `run_started` — run id, source root, converter version, inventory counts.
2. `capacity_reserved` — run id, plan fingerprint, and the fixed byte ceiling
   reserved before that run's first remote mutation.
3. `page_planned` — Notion id, source hash, desired parent and next sibling,
   planned Channel action (`create` or `update`).
4. `page_target_planned` — conversion hash and resolved Brain placement after
   every source id has a destination id.
5. `page_adopted` — Brain id, source/conversion identity, rev, and whether a
   lost durable adoption acknowledgement was recovered. Generic v2 only.
6. `page_reserved` — Brain id, reservation token, pass number, status, and
   current/tracked hierarchy.
7. `attachment_saved` — source block id, sha256, size, MIME, and deterministic
   v2 URL.
8. `page_finalized` — conversion hash, rev, status, and staging cleanup result.
9. `page_aborted` or `page_abort_failed` — receipt/cleanup outcome or a stable
   failure code. Recovered lost acknowledgements use the same event types.
10. `page_verified` — read-back hash, hierarchy/order result, and attachment
   count.
11. `run_stopped` or `run_completed` — run id, totals, and cleanup counts.

Append and fsync each event before the next remote mutation. On resume, call
`notion_find_page` and reconcile its current/tracked state with the journal.
Before opening a generic v2 run, inspect every fixed `preserve` and `adopt`
candidate by explicit Brain id with `notion_inspect_candidate`, then read only
adoption bodies needed to compute their canonical target hashes. The candidate
response itself is metadata-only: no title, body, fractional order, or raw
reservation capability. Every reviewed fixed baseline and the normal
destination preflight must succeed before `run_started` or any remote mutation.
Fail on a missing/deleted candidate, changed rev or placement, pending or
foreign binding, an unowned active reservation, duplicate mapping, or any body,
metadata, hierarchy, attachment, or tracked-baseline drift. `run_stopped`
records a stable error code without storing exception text after a run has
opened.
An exact legacy page whose sole Notion metadata is the reviewed `notionId` is
reported as an upgradeable `bound_untracked` candidate. Preserve may use it
read-only; adopt may add the complete tracked baseline only after the same
rev/parent/next-sibling and canonical-target checks as an unbound page. A
different `notionId` or any partial source, conversion, target, reservation, or
abort metadata is never upgradeable.
Never assume a timed-out request failed: a reserve or finalize may already be
durable.

The file has a hard 16 MiB limit. Before the first mutation of a run, the
executor durably reserves a 4 MiB per-run ceiling. Every reserve, upload,
finalize, and abort attempt checks that its acknowledgement and cleanup
headroom still fit before making the request. Normal work preserves 512 KiB
for cleanup plus 32 KiB for the next acknowledgement. Cleanup preserves the
32 KiB acknowledgement reserve. A restart restores the same ceiling from the
hash-chained `capacity_reserved` event. A completed run receives a new run id
and ceiling only when later read-back proves that another mutation is actually
needed. A verified no-op apply creates no rollover events. If a stopped run has
used its normal headroom, a new invocation first completes the entire read-only
destination preflight, then durably starts a successor run with a fresh 4 MiB
ceiling before reconciling abort receipts or mutating Brain. Existing
`token_prepared` and `page_aborted` events remain the ownership and
acknowledgement chain. The executor never rolls over mid-request or before
terminal cleanup and `run_stopped` are durable. If the 16 MiB file has no room
for another full 4 MiB ceiling, it fails as `journal_capacity` with zero remote
mutation; the operator must preserve the journal and start a reviewed successor
journal rather than deleting audit records.

## Planner

1. Freeze a complete source inventory and normalize Notion ids.
2. Hash attachment bytes before reservation. Temporary signed URLs are not
   source identity.
3. Produce the intermediate block tree and a report for every unsupported block
   or icon. Run `assertNotionConversionReady` and stop for a fidelity decision
   instead of omitting content. A `notion-unsupported` marker is also rejected
   server-side before any hierarchy or page write.
4. Match reviewed existing Brain roots before planning creates. Adoption is an
   explicit action, never a title-only guess.
5. Compute the desired parent and next sibling for every page. The plan is
   immutable once execution starts.

## Executor

1. Generic v2 preflights every reviewed `preserve`/`adopt` baseline before the
   journal opens. In apply mode it adopts all unbound candidates, in plan order,
   before any reserve/create request. Already tracked candidates for the same
   Notion id are accepted only when their Store-computed target and attachment
   integrity are intact; a missing acknowledgement is journaled as recovered.
   Fixed Brain ids are seeded into the destination map before hierarchy and
   next-sibling resolution. Verify mode never adopts and rejects an unbound
   adoption candidate.
2. Pass one reserves every active page id. `parentId`, `beforeId`, and a
   client-generated reservation token are required fields; hierarchy fields use
   explicit `null`. Journal the token before the request so a lost response can
   be reconciled safely. A visible file whose post-rename directory fsync still
   fails is indexed for same-token recovery but the reserve request fails; it is
   never acknowledged as durable.
3. Pass two replays reserve with the complete id map, conversion hash, parent,
   and next sibling.
4. Upload attachments serially and send `expectedSha256`. MCP/base64 and
   `POST /api/mcp/notion-upload` both accept the Store's 25 MiB per-file limit;
   the binary route avoids base64 overhead when a caller can use it. Respect
   `retryAfterMs` and HTTP `Retry-After`.
   After every acknowledgement, call authenticated `notion_verify_attachment`.
   It reads the staged file and returns its actual byte size and SHA-256. A URL
   match alone is not verification. After finalize, call
   `notion_verify_finalized_attachment` for every body asset and cover. It
   accepts only the exact source/conversion identity, requires an intact tracked
   target, proves the URL is a real Markdown destination or that page's cover,
   then hashes the regular non-symlink file in the permanent attachment store.
5. Finalize parents before children. Within one sibling group, finalize from
   last to first because `beforeId` must already be stable.
6. On a terminal conversion or upload failure, abort every token-owned active
   reservation leaf-first and journal each cleanup report. Preserve the
   original failure even if cleanup also fails. Created placeholders are never
   hard-deleted during abort. They are detached and preserved, including a
   hidden `.brain-abort-recovery-*.md` copy of the exact pre-detach index. The
   detached canonical index is installed with no-overwrite semantics, so a
   raced external save wins and abort fails safely instead of replacing it.
   A parent placeholder with any imported descendant fails as
   `has_import_children`; reservations must be aborted leaf-first. Manual
   children do not make the parent disposable and remain attached to the
   preserved placeholder.
   Its untouched provisional cover is cleared; a cover changed manually after
   reserve is preserved. Recovery files remain in the notes Git history and may
   be removed only after their contents have been reviewed.
   Finalize also returns `cleanup.stagingRemoved`; `false` means the page is
   durable but orphan staging still needs a retry or startup reconciliation.
   A lost abort response is reconciled from `pendingAbort` with the same
   journaled token. The executor records `page_aborted` before sending the
   receipt acknowledgement on the next reserve and never mints a replacement
   token for that recovery chain.

## Verifier

For every finalized page, read it back and verify title, icon, cover, body hash,
parent, next sibling, and permanent attachment bytes, sizes, and hashes. Compare page, block, image,
file, database/table, and unsupported counts against the frozen inventory.
Verify a second execution plans every completed page as unchanged. A pilot is
complete only after the full TypeScript, Vitest, and Markdown round-trip gate is
green and the journal has no unclassified failures.

## Generic snapshot v2 foundation

The generic source boundary is separate from the Channel v1 adapter. Its JSONL
stream is `manifest(version: 2) -> node* -> end`. Every node is explicitly a
`page`, `collection`, or `row`. Collection schemas and row values are typed,
counts are derived again by the reader, hierarchy and contiguous sibling
positions are checked, and every row must exactly match its parent collection
schema. Temporary signed asset queries are removed only from the source
fingerprint. Meaningful external-link queries, property values, topology, and
asset descriptors remain committed.

Notion rows may have an empty source title. Snapshot v2 preserves that empty
typed title value, while the Brain page/document title is materialized as
`Untitled`. Empty ordinary page and collection titles remain invalid. A v2
plain-page target sends explicit `null` only as the transport command to clear
old collection metadata. The canonical final hash omits cleared metadata, so
legacy page hashes remain byte-stable.
Every collection row carries one explicit typed value for every property in
its parent schema, including null/empty values and read-only system properties.
Missing properties, duplicate selections, and select options that do not
exactly match the parent definition fail before execution.

Destination decisions never enter the source snapshot. A separate reviewed
bindings JSON file is tied to the exact snapshot fingerprint and must cover
every source node once with one of four dispositions:

- `create` creates or updates an importer-owned destination.
- `skip` excludes a complete subtree and records a reason.
- `preserve` supplies an existing Brain id plus expected rev, parent, and next
  sibling as a read-only hierarchy anchor. Placement is part of the reviewed
  baseline because moving a page does not change its file rev.
- `adopt` supplies an existing Brain id, expected rev, parent, and next sibling
  for the explicit Store adoption handshake.

Live code must open bindings through `readPrivateNotionBindingsFile`. It
requires an absolute, effective-user-owned, single-link regular `0600` file
under an owned real `0700` directory and checks file and parent identity across
the read. Symlinks and hard links fail closed. The module-derived repository
root is forbidden independently of the process working directory. The file is
private operator state and must stay outside source control, notes, import
journals, and support output. The reviewed collection-enrichment manifest uses
the same reader and boundary.

`buildGenericNotionImportPlan` is pure. Its fingerprint commits to the frozen
snapshot, reviewed bindings, mutation order, source hashes, fixed Brain ids,
asset hashes and sizes, and every disposition. Skipped nodes cannot have active
descendants or active page references. The default materializer accepts plain
pages only. Collection or row mutation fails until a typed collection
materializer is supplied, so properties cannot be silently flattened or
dropped.

The remote executor consumes a source-agnostic execution-plan shape while the
Channel v1 entry point and behavior remain unchanged. Generic v2 supports
create-only and anchored plans. `prepareGenericNotionExecution` validates the
complete active dependency graph and asset inventory; the live executor then
performs the fail-closed read-before-write candidate phase described above.
Preserved ids remain read-only anchors. Adopted ids enter the normal two-pass
flow only after the explicit Store adoption handshake, and are verified from
their canonical read-back target. Any fixed-baseline drift fails with zero
journal records and zero remote mutations. A partial adoption run is resumable:
durably tracked candidates are reconciled without a second adoption, remaining
candidates are adopted in deterministic plan order, and a stable rerun is a
verified no-op.

Run a small representative subtree first. Review its hierarchy, ordering,
internal links, tables, columns, toggles, callouts, images, files, and unsupported
report before authorizing the larger source roots.
