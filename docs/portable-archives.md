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
tasks/
  t000001.md
assets/
  <stored attachment name>
```

- Every note remains a separate plain Markdown file.
- `manifest.json` contains page hierarchy, supported Brain metadata, and every
  task record.
- A file under `tasks/` holds the body one task file has under its
  frontmatter. Most tasks have none, and those get no file.
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

Every task record travels whole: its title, its `when`, its `deadline`, its
category, its repeat rule and that rule's completion log, its completion and
the instant of it, and, for a task linked to a checkbox, the page and the
anchor that find that checkbox. A task in no list still travels, because the
archive is the notebook and not the screen.

- A task keeps its own id, unless the receiving notebook already holds that id.
  An import never overwrites what is there, so a clash takes a fresh id and
  both records live. Importing one archive twice makes two copies of
  everything, tasks and pages alike.
- A task linked to a page the archive carries points at that page's new id
  after the import.
- A task naming a page the archive does not carry is imported detached. It
  keeps its schedule and its last known title, and it is never dropped. A task
  on a page in the Trash arrives this way, because the Trash does not travel.
- A subtree export carries the tasks of the pages it carries. A whole notebook
  export carries every task the notebook has, including a task on a trashed
  page and a completion older than the 30 day Logbook window.
- A body written by hand under a task's frontmatter is carried in `tasks/` and
  restored byte for byte, a leading `---` fence and a missing trailing newline
  included. A body that is only whitespace is treated as no body.
- Two records in one archive may hold the same id. The second one imported
  takes a fresh id, so both land and neither is overwritten.

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

Import never overwrites an existing page or task. Brain allocates fresh page
and asset ids, keeps a task's own id unless that id is taken, rebuilds
hierarchy, and rewrites packaged links to those new ids. If page or task
creation fails, the newly created tasks are removed and the newly created root
pages are moved to Trash; existing notes are not changed.

## Limits and trust boundary

- Compressed archive: 100 MB maximum.
- Unpacked archive: 256 MB maximum.
- Pages: 5,000 maximum.
- Tasks: 20,000 maximum.
- Files: 6,000 maximum.
- One Markdown file, and one task body: 10 MB maximum.
- One attachment: the same 25 MB limit and signature checks used by ordinary
  Brain uploads.
- Symlinks, absolute paths, traversal, unlisted files, duplicate entries,
  malformed UTF-8, corrupt hashes, cycles, and unsupported collection
  relationships are rejected before any note is created.
