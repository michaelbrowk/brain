# Portable Brain archives

Brain can export either one page with its descendants or the complete notes
tree as a portable `.brain.tar.gz` archive. The archive is an ordinary gzip
tarball that macOS and standard command-line tools can open.

## Layout

```text
manifest.json
pages/
  p000001.md
  p000002.md
assets/
  <stored attachment name>
```

- Every note remains a separate plain Markdown file.
- `manifest.json` contains page hierarchy, supported Brain metadata, and the
  notebook's tasks.
- Links between exported pages point at the packaged Markdown files.
- Local attachments and covers are copied into `assets/` and referenced with
  relative links.
- The manifest carries a SHA-256 digest and exact byte size for every asset.

## Format version

The manifest carries a `version`. Version 2 is the first to carry tasks, and
an archive exported before it, version 1, imports unchanged. A version 1
manifest never has a `tasks` key, and a notebook with no tasks exports a
version 2 manifest that has none either.

## Tasks

A task rides in the manifest with its title, its `when`, its `deadline`, its
category, its repeat rule, and, for a task linked to a checkbox, the page and
the anchor that find that checkbox. A completed task comes back completed.

- A task linked to a page the archive carries points at that page's new id
  after the import.
- A task naming a page the archive does not carry is imported detached. It
  keeps its schedule and its last known title, and it is never dropped.
- A subtree export carries the tasks linked to the pages it carries. A whole
  notebook export carries those and every unlinked task.
- Brain allocates a fresh task id on import, the way it allocates a fresh page
  id.
- A completion older than the 30 day Logbook window is in no list, and so is
  in no export. The same is true of a task whose page is in the Trash.
- A task's `_tasks/<id>.md` file may hold a hand-written body under its
  frontmatter. Brain has no reader for it and the archive does not carry it.

## Export

- **Settings → Data → Download archive** exports every page.
- **Page actions → Export Markdown** exports the selected page and all of its
  descendants.
- Brain flushes the open editor before exporting the selected page. A failed
  save stops the export and leaves the local draft intact.

## Import

1. Open **Settings → Data → Choose archive**.
2. Brain performs a read-only preflight. It validates the tar structure,
   manifest, hierarchy, Markdown, attachment types, sizes, and hashes.
3. Review the page, attachment, and task counts.
4. Choose **Import new pages**.

Import never overwrites an existing page. Brain allocates fresh page, asset,
and task ids, rebuilds hierarchy, and rewrites packaged links to those new ids.
If page or task creation fails, the newly created tasks are removed and the
newly created root pages are moved to Trash; existing notes are not changed.

## Limits and trust boundary

- Compressed archive: 100 MB maximum.
- Unpacked archive: 256 MB maximum.
- Pages: 5,000 maximum.
- Tasks: 20,000 maximum.
- Files: 6,000 maximum.
- One Markdown file: 10 MB maximum.
- One attachment: the same 25 MB limit and signature checks used by ordinary
  Brain uploads.
- Symlinks, absolute paths, traversal, unlisted files, duplicate entries,
  malformed UTF-8, corrupt hashes, cycles, and unsupported collection
  relationships are rejected before any note is created.
