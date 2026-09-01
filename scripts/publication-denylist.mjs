// The single source of truth for what never reaches the public repository.
// Read by scripts/export-public.mjs, by scripts/check-forbidden-paths.mjs, and
// by the acceptance export.

// Exact repo-relative paths.
export const DENIED_PATHS = [
  // The marker that tells scripts/check-forbidden-paths.mjs which repository it
  // is standing in. Denied, so the export never carries it and the exported
  // tree reads as the public one — which is what lets package.json's check step
  // stay flag-free and be correct in both repositories. Denied as an exact path
  // rather than a prefix on purpose: the drift audit then also watches it, so
  // the archive cannot lose its own role file without the gate saying so.
  ".publication-role",
  // Maintainer-only working files. AGENTS.md itself is kept and public: the
  // export is a filter, never a transformer, so a file that has to travel is
  // tracked under the name it will have there, and its private counterpart
  // sits beside it at a denied path of its own.
  "AGENTS.private.md",
  "CLAUDE-SMTP-RISK-REVIEW.md",
  "design-qa.md",
  ".impeccable/design.json",
  // Assertions that read the real tree, so they hold in the source repository
  // and not in an export. Their tree-agnostic siblings drive the same modules
  // over synthetic repositories and stay in scripts/check-forbidden-paths.test.ts
  // and scripts/export-public.test.ts, which do travel.
  "scripts/publication-archive.test.ts",
  // A list of banned literals, and the only test that reads it. The sweep runs
  // here, over the very set the export produces, so the check happens without
  // the list itself having to travel.
  "scripts/owner-literals.mjs",
  "scripts/owner-literals.test.ts",
  // Design frames shot against fixtures that are no longer used. A title
  // rendered into a PNG is pixels, not text, and no sweep of the source can
  // reach it.
  //
  // The rule, for captures still to come: a frame that renders the page list
  // is denied unless it was shot against the dev stand's sample tree or an
  // equally neutral seed. These pairs are denied whole rather than left as an
  // orphan half, because their "before" halves captured code that no longer
  // exists and cannot be re-shot.
  "docs/design/shell/dialog-move-dark-after.png",
  "docs/design/shell/dialog-move-dark-before.png",
  "docs/design/shell/dialog-move-light-after.png",
  "docs/design/shell/dialog-move-light-before.png",
  "docs/design/shell/palette-mobile-empty-dark-after.png",
  "docs/design/shell/palette-mobile-empty-dark-before.png",
  "docs/design/shell/palette-mobile-empty-light-after.png",
  "docs/design/shell/palette-mobile-empty-light-before.png",
  "docs/design/shell/palette-mobile-query-dark-after.png",
  "docs/design/shell/palette-mobile-query-dark-before.png",
  "docs/design/shell/palette-mobile-query-light-after.png",
  "docs/design/shell/palette-mobile-query-light-before.png",
  // Design analyses written against those same fixtures (their frames are
  // denied by prefix).
  "docs/design/phase0-contrast.md",
  "docs/design/phase1-contrast.md",
  "docs/design/phase1-hover.md",
  "docs/design/train-perf.md",
  // The Notion operator. Its generic dependencies — snapshot.ts,
  // reviewed-markup.ts, private-operator-file.ts — stay, because modules that
  // do travel import them.
  "lib/notion/export-directory.ts",
  "lib/notion/export-directory.test.ts",
  "lib/notion/operator-bindings.ts",
  "lib/notion/operator-bindings.test.ts",
  "lib/notion/operator-plan.ts",
  "lib/notion/operator-plan.test.ts",
  "lib/notion/operator-source.ts",
  "lib/notion/operator-source.test.ts",
  "lib/notion/channel-asset-bindings.ts",
  "lib/notion/channel-asset-bindings.test.ts",
  "lib/notion/reviewed-markup-source.test.ts",
  "scripts/notion-generic.ts",
  "scripts/notion-generic.test.ts",
];

// Two entries this list used to carry and deliberately does not, recorded here
// because the removal was a judgement rather than an oversight.
//
// docs/mail-account-connect-operations.md and docs/mail-egress-operations.md
// are the operator runbooks for the installer the public release already
// ships. scripts/build-release.mjs stages both into brain-mail-ops/ inside the
// signed artifact and ops/install-brain-mail.sh lays them down under
// /opt/brain/share, so denying them does not withhold a private document, it
// breaks `pnpm release` in the public tree for want of a source file. Every
// hostname in them is example.invalid or an angle-bracket placeholder and
// every path is a Brain install path, so they carry nothing to withhold, and
// anyone installing Brain Mail on their own server needs both.

// Repo-relative directory prefixes. Every entry ends in "/" so a sibling file
// is never denied by a shared name stem.
export const DENIED_PREFIXES = [
  "docs/design/phase0/",
  "docs/design/phase1/",
  "docs/design/train/",
  "docs/design/tree/",
  "docs/design/mail/",
  "docs/design/settings-content/",
  "docs/postmortems/",
  // Specs, plans and working notes, in both of the places they are written. A
  // prefix rather than exact paths, because the drift audit checks that every
  // DENIED_PATHS entry still exists and git tracks nothing under this one.
  "docs/superpowers/",
  ".superpowers/",
];

// The trailing "/" is what keeps a prefix from denying a sibling file by a
// shared name stem, so the data enforces it at load rather than a test.
for (const prefix of DENIED_PREFIXES) {
  if (!prefix.endsWith("/")) {
    throw new Error(`DENIED_PREFIXES entry must end in "/": ${prefix}`);
  }
}

export function isDenied(repoRelativePath) {
  if (DENIED_PATHS.includes(repoRelativePath)) return true;
  return DENIED_PREFIXES.some((prefix) => repoRelativePath.startsWith(prefix));
}
