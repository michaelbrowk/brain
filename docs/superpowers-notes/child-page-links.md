# Child pages are links in their parent

Design recorded before implementation. Line numbers below describe the starting tree.

## Paths audited

- Owner UI: `components/shell.tsx:2868` (`requestCreatePage`) and `:2913`
  (`createPage`: tree/menu/palette, templates, daily notes and recovery copies);
  `:2949` is slash `/Page` creation at the cursor. All use
  `app/api/page/route.ts:68` → `Store.createPage` (`lib/store/store.ts:3966`).
- MCP `create_page`: `app/api/mcp/route.ts:439` → the same leaf.
- MCP `create_app_page`: `app/api/mcp/app-tools.ts:426` →
  `Store.createAppPage` (`lib/store/store.ts:4152`); its app and owned children
  delegate to `createPage` (`:4184`, `:4217`). App bridge creation:
  `app/api/app-bridge/[id]/page/route.ts:89` → `createOwnedPage` (`:4088`).
- Duplicate: `app/api/page/[id]/duplicate/route.ts:13` → `duplicatePage`
  (`lib/store/store.ts:5540`) → `createPage`.
- Portable import: `app/api/portable/import/route.ts` →
  `lib/portable/model.ts:721` creates the whole hierarchy, then `:781` replaces
  bodies and later applies collection metadata. Its rollback deletes roots
  (`:897`). Links must be reconciled after bodies and metadata land.
- Notion import: MCP reservation/finalization (`app/api/mcp/route.ts:558`,
  `:697`) → `reserveNotionImport` (`lib/store/store.ts:2516`, independent
  placeholder write at `:2642`) and `finalizeNotionImport` (`:3035`).
  Finalization reparenting is `:3332`; abort restores placement at `:3492`.
  Placeholders are incomplete: defer their links until finalization, where
  collection metadata and the authoritative body are known.
- Owner tree drag and Move dialog: `app/api/move/route.ts:50`; MCP move:
  `app/api/mcp/route.ts:824` → `movePageWithBodyReport` (`:6203`).
  Cross-parent moves already journal both parent bodies (`:6247`); same-parent
  moves only reorder. Editor/tree page-ref nesting has its own combined
  journal (`app/api/page-ref/nest/route.ts` → `Store.nestPageRef`, `:6476`,
  raw move at `:6869`). Board card moves (`Store.mutateBoard`, `:5985`)
  change status/order only, never parentage.
- Trash: `app/api/page/[id]/route.ts:259`, MCP `:866`, development reset
  `app/api/dev/reset/route.ts:84`, portable rollback → `deletePage` (`:7144`).
  Restore: `app/api/trash/[id]/route.ts:13` → `restorePage` (`:7188`), which
  may also restore deleted ancestors. Purge/empty-trash only remove already
  trashed roots, whose parent links were removed when trashed.
- Visitor creation: `app/api/share-edit/page/route.ts:32` →
  `createSharedSubpage` (`:4940`). Preserve its authority check and visitor
  attribution; the shared-page child list itself is unchanged.

## Decisions

- Keep the folder hierarchy authoritative. Links are ordinary Markdown, no
  new parent metadata. Use `appendStandalonePageRef` and
  `removeStandalonePageRefs` from `lib/page-ref-nesting.ts`, the existing
  filing/move format and semantic parser. Any existing semantic link prevents
  appending; removal affects only standalone paragraphs, never prose/code.
- Eligible parents have neither `view: board`, `collection`, `collectionRow`
  nor `kind: app`. Collection rows are not filed as children either.
- Parent changes run under the existing Store mutation lock, use fresh disk
  revisions and the normal unlocked save, and emit write events. Automatic
  parent saves must reach the initiating tab too. Keep the existing durable
  composite move journal and its snapshot barrier.
- Slash creation still places its link at the cursor. Adopt only the known
  server-generated append as its new save baseline, then save the cursor
  placement against that revision; unrelated concurrent changes still conflict.
- Imports reconcile once their final bodies and view metadata are installed,
  so placeholder creation cannot pollute an excluded parent or be overwritten
  by the imported body. Preserve Notion's reservation/baseline safety.
- No generic notes migration runner exists. Add a small awaited startup
  backfill after recovery/index construction and the dirty snapshot. Guard it
  with a per-notes-root marker under the existing settings state directory
  (`BRAIN_SETTINGS_STATE_DIR`, production `/var/lib/brain/settings`). Build all
  patches first, save each parent once in tree order under a Git barrier,
  record a pending marker, commit immediately as
  `migrate: file child pages in their parents`, then atomically mark completion.
  A pending run retains its dirty changes for that named commit on restart.
  Empty notebooks need no commit. A failed run has no completion marker;
  semantic link checks make retry safe.
- Remove the owner footer and its exclusive filing bridge/plugin/tests. Keep
  the shared-page list and the shared semantic-reference helpers it uses.

## Validation and operational limits

- Parent writes are serialized with child placement and protected from the
  debounced Git snapshot by the existing snapshot barrier. Move/nesting uses
  the existing durable move intent, including a distinct old-parent image
  when a dragged reference belongs to another branch.
- Backfill records pending/completed state in one atomic marker. A Git failure
  keeps snapshots blocked until the next initialization retries the named
  migration. A body the existing append helper cannot safely extend (for
  example an unclosed HTML comment) fails before any backfill parent is saved.
- The generated append is the only change cursor creation may adopt as its
  new baseline; any other concurrent body change still takes the existing
  conflict/recovery path. Shared visitor creation follows the same rule.
- Removing the completion marker or moving the notes root deliberately runs
  backfill again. Keep it across deployments to preserve links the owner later
  chooses to remove.

- Notion read-back verification accounts for exact known direct-child rows
  appended after the parent's finalize, while retaining tracked-target integrity
  checks. Preserve anchors still pin exact revisions: child creation changes a
  preserved parent's revision, so its reviewed binding must be refreshed and a
  new plan/journal built before continuing. No rev-conflict guard is weakened to hide that save.

## Additional callers checked during validation

- Board card creation (`components/shell.tsx:5079`) and conflict recovery copies
  (`components/shell.tsx:4277`) call `/api/page` directly; both use the same
  Store leaf. Board card placement then reorders within its board.
- The native Notion CLI (`scripts/notion-pilot.ts:10`) uses
  `lib/notion/executor.ts`, whose reserve/finalize calls go through
  `lib/notion/brain-mcp-client.ts:429` and `:435` to the MCP routes above.
  Aborting a newly reserved placeholder keeps it as an ordinary child; that
  transition and abort-receipt replay file its parent link too.
- `scripts/notion-import.py:274` is the explicitly offline legacy export
  recovery writer described at the top of `docs/notion-import.md`, not a live
  notes mutation path. A recovered tree in a fresh target receives the startup
  backfill when Brain first opens it; the legacy script must never target live
  notes or be used to extend an already initialized notebook. Live imports use
  the MCP protocol or portable importer audited above.
- Restore also files returning legacy descendants whose bodies predate this
  feature. Portable import and restore filter the affected child ids, so they
  never file an unrelated sibling the owner deliberately left unlinked.

## Validation result

Node 22 was prepended to PATH. The original worktree's Git metadata is outside
this sandbox's writable roots, so staging failed with `Operation not permitted`.
A local writable clone on `feat/child-page-links` holds the reviewable commit;
its installed dependencies are reused from the original checkout. No push is
performed.

| Check | Exit | Result |
| --- | --- | --- |
| `pnpm check` (writable clone, dependency reinstall disabled) | 1 | Denylist, environment docs, ESLint and strict TypeScript pass. Last full Vitest attempt: 8,630 passed, 260 failed, 4 skipped, one unhandled socket error. Failures are in unchanged Mail/socket and installer files. |
| Final focused store tests | 0 | 396 passed, including all 14 new lifecycle/backfill cases and the final abort-receipt follow-up. |
| Notion executor / generic executor / native CLI | 0 | 46 passed. |
| Final strict TypeScript and focused ESLint | 0 | No errors. The full lint run retains existing unrelated warnings. |
| Shell DOM contracts | 0 | All 10 passed; the owner footer fixture is removed. |
| Operational Python tests | 0 | 49 tests, 16 platform skips. |
| Markdown round-trips | 0 | All 14 harnesses passed. |
| Mail-egress worker gate | 1 | Worker TypeScript passes; test startup is refused by sandbox socket permissions. Bundle stage is not reached. |
| Playwright critical flows and share editing | 1 | Web server cannot listen on `127.0.0.1:3021` (`EPERM`); no browser tests execute. |

The unrelated installer file was rerun alone and still timed out (8 failures,
59 passes). The Unix-socket Mail client file was also rerun alone: all 43 tests
failed at `listen EPERM`. These failures were not hidden, skipped or treated
as passing. The full gate therefore remains red and browser behavior requires
verification outside this restricted sandbox.

The original checkout retains the implementation changes with its original
branch ref; the writable clone and Git bundle provide the requested commit
without changing protected Git metadata. The operational risks are the pending
validation above, preserved-import revision review described earlier, and the
intentional startup refusal for a body the append helper cannot safely extend.
