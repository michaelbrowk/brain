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
- `manifest.json` contains only page hierarchy and supported Brain metadata.
- Links between exported pages point at the packaged Markdown files.
- Local attachments and covers are copied into `assets/` and referenced with
  relative links.
- The manifest carries a SHA-256 digest and exact byte size for every asset.

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
3. Review the page and attachment counts.
4. Choose **Import new pages**.

Import never overwrites an existing page. Brain allocates fresh page and asset
ids, rebuilds hierarchy, and rewrites packaged links to those new ids. If page
creation fails, the newly created root pages are moved to Trash; existing notes
are not changed.

## Limits and trust boundary

- Compressed archive: 100 MB maximum.
- Unpacked archive: 256 MB maximum.
- Pages: 5,000 maximum.
- Files: 6,000 maximum.
- One Markdown file: 10 MB maximum.
- One attachment: the same 25 MB limit and signature checks used by ordinary
  Brain uploads.
- Symlinks, absolute paths, traversal, unlisted files, duplicate entries,
  malformed UTF-8, corrupt hashes, cycles, and unsupported collection
  relationships are rejected before any note is created.
