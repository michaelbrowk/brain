#!/usr/bin/env bash
# Exports the tree the way the cutover will, then proves the result stands on
# its own: it installs, it type-checks, it tests, and it tracks nothing denied.
#
# The order below is the point. `git init` runs BEFORE `pnpm install` so that
# `prepare` finds a checkout and really sets core.hooksPath — the same thing it
# does for a stranger who clones the public repository. Installing first would
# make install-hooks.mjs take its no-checkout exit, and the run would prove
# nothing about the path everybody else takes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

allow_dirty=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-dirty) allow_dirty=1 ;;
    *)
      printf 'usage: %s [--allow-dirty]\n' "$0" >&2
      exit 64
      ;;
  esac
  shift
done

# Refused before anything is exported or installed, so a refusal costs nothing.
# scripts/export-public.mjs refuses the same tree for the same reason — the
# guard has to live on the export because that is the command the cutover runs
# — and scripts/release.mjs refuses one too. Repeated here so a refusal happens
# before the temp directory and the install, not after: export-public.mjs takes
# its file LIST from the index (`git ls-files`) and its BYTES from the working
# tree, so a dirty tree verifies a hybrid of the two that nobody can check out. At the cutover the export becomes the public repository
# in one initial commit, and there is no second chance at what it contains.
if [ "$allow_dirty" -eq 0 ]; then
  dirty="$(git -C "$root" status --porcelain --untracked-files=normal)"
  if [ -n "$dirty" ]; then
    {
      echo "refusing to verify a dirty working tree:"
      echo "$dirty"
      echo
      echo "The export reads the git index, not HEAD, so what this would verify is"
      echo "neither your working tree nor any commit. Commit or stash first."
      echo "--allow-dirty exists for iterating and is never right for the cutover."
    } >&2
    exit 1
  fi
fi

destination="$(mktemp -d "${TMPDIR:-/tmp}/brain-public-XXXXXX")/tree"

echo "exporting to $destination"
export_flags=()
if [ "$allow_dirty" -eq 1 ]; then
  export_flags+=(--allow-dirty)
fi
exported="$(node "$root/scripts/export-public.mjs" "${export_flags[@]+"${export_flags[@]}"}" "$destination" | tee /dev/stderr | sed -n "s/^exported \([0-9]*\) files.*/\1/p")"
if [[ -z "$exported" ]]; then
  echo "could not read the exported file count from the export" >&2
  exit 1
fi

cd "$destination"
git init -q -b main
# --force, because the exported tree carries files the archive itself keeps
# only by force: .gitignore matches `.env*` and `/*.mjs`, so a plain `git add`
# silently drops .env.example, eslint.config.mjs and postcss.config.mjs. They
# stay on disk, so every gate below still passes — the loss only appears when
# somebody clones the published repository and finds no lint config and no
# .env.example for the README's first instruction.
git add --force -A
git -c user.email=export@example.com -c user.name=export commit -qm "initial"

# The count is the assertion. A gate that reads the working tree cannot see a
# file that failed to reach the index, so compare what git tracks against what
# the export said it wrote.
tracked="$(git ls-files | wc -l | tr -d " ")"
if [[ "$tracked" != "$exported" ]]; then
  echo "the commit tracks $tracked files but the export wrote $exported" >&2
  git status --porcelain --ignored | grep "^!!" >&2 || true
  exit 1
fi

echo "installing"
pnpm install --frozen-lockfile

echo "gating"
node scripts/check-forbidden-paths.mjs --mode=public
node scripts/check-env-docs.mjs
pnpm check

echo "public export verified at $destination"
