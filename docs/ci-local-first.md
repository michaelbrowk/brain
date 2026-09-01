# Local-first CI

Brain runs the exhaustive gate on the developer machine. GitHub verifies and
packages the exact merge commit once, when it reaches `main`.

## Before opening a pull request

Run the complete local gate:

```bash
pnpm ci:local
```

It runs type checks, unit and operational tests, Markdown round-trips, a
production build, standalone smokes, and the full Playwright suite.

During implementation, use the smaller commands:

```bash
pnpm check
pnpm test:e2e:release
```

`test:e2e:release` is the compact browser gate, and it is exactly
`playwright test --grep @release`. It selects whatever carries `@release` in
its Playwright title, wherever in `e2e/` that title lives — today 44 tests
across eight spec files. Read the current set from the runner, never from a
list in prose:

```bash
pnpm exec playwright test --grep @release --list
```

Six of them are the core editor journeys, and they all sit in
`e2e/critical-flows.spec.ts`:

- login, autosave, leaving a page, returning, search, and narrow viewports
- repeated page-reference reordering
- page-reference nesting and failed-move safety
- page-reference nesting inside a column layout, in one lane and across two
- pinned roots and concise Home/Search behavior
- editor and public-share appearance parity

The rest came later and are grouped by surface rather than by journey: the
design stand (`design-audit`), Mail's panes, reader layout and undo
(`mail-client`, `mail-reader-layout`), breadcrumbs, subpage filing, tree
moves, and the phantom-draft guards. Keep the set small. Add a test to it only
when its failure could make Brain unsafe to release.

The column line reads like a duplicate of the one above it and is not. Nesting
worked everywhere the gate looked and nowhere it did not: a page laid out in
columns offered no way to put one page inside another at all, and the gate did
not see it because no journey ever dragged anything inside a lane. A layout
this common is its own place for a journey to break.

`ops/ci-cost-guardrails.test.ts` pins the six above, by count and by exact
title, and it reads no other spec file. Dropping one of them or renaming it
fails that test. Adding `@release` to a test in any of the other seven files
does not: it widens the gate that runs on every push to `main` with nothing
standing in the way. Treat a new tag as a cost decision and say so in the pull
request.

## What GitHub runs

Pull requests run the cheap hosted gate: `pnpm install`, an apt install of
`ripgrep`, a gitleaks scan of the working tree, and `pnpm check` (type safety,
unit tests, round-trips, mail-egress). The scan carries no push-only guard on
purpose, so a secret on a branch fails before anyone reviews it rather than
after. Every build, browser, packaging, and systemd-verify step is guarded
`if: github.event_name == 'push'`, so a pull request never boots a browser and
a green pull request is not yet a green `main`. The full local gate
(`pnpm ci:local`) still runs the browser journeys before a merge.

A push to `main` uses one runner for the code gate, Linux build, standalone
smokes, and the compact `@release` browser gate. It produces no artifact:
releases are cut with `pnpm release <version>` and built by the `Release`
workflow (see `docs/release-checklist.md`).

A push of a `v*` tag runs the separate `Release` workflow: the same
operational gate (`scripts/verify-ops.sh`), `pnpm check`, the compact browser
gate, build, both smokes, then packaging through
`scripts/build-release.mjs --layout release` and a draft GitHub Release.
Nothing is published by the runner.

The full Playwright suite runs:

- manually from the separate `Full E2E` workflow
- every Saturday at 03:17 UTC
- locally through `pnpm ci:local`

This keeps broad regression coverage without spending a second runner and a
second dependency install on every release. Keeping it in a separate workflow
also means manual and scheduled QA runs cannot replace the canonical `CI`
push-run that the deploy puller verifies.

## Deploy safety

The server installs published GitHub Releases through the puller's release
source (`docs/deploy-puller.md`). The CI-artifact source is retired with the
puller in E.
