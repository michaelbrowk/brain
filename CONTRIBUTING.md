# Contributing

Brain is a self-hosted notes app maintained by one person. The fastest way to
get a change in is to keep it narrow.

## What lands easily

- **Bug reports.** A failing case beats a description. Say what you ran, what
  happened, and what you expected instead.
- **Focused fixes.** One defect per pull request, with a test that fails
  without the change.
- **Documentation that was wrong** — above all, anything in this file or the
  README that did not work when you followed it.

## What to discuss first

Anything that moves the architecture: a second storage layer, a different
editor, a dependency that brings its own runtime, a rewrite of `lib/store/`.
Open a discussion before writing the code. `PRODUCT.md` holds the constraints
those parts answer to, and a pull request that argues with them is a slow way
to find that out.

One thing that looks like a cleanup and is not — the `xlsx` dependency pinned
to a vendor tarball. The README's Dependencies section says why, and the pin
stays.

## The local loop

Node 22 and pnpm 11, the versions `package.json` pins. Two more binaries have
to be on `PATH`: **ripgrep**, which search runs for real rather than mocking,
and **python3**, which runs the operational tests. Without either, `pnpm check`
fails on a step that has nothing to do with your change.

```bash
pnpm install
cp .env.example .env.local   # NOTES_ROOT, AUTH_SECRET, AUTH_PASSWORD_HASH
pnpm dev                     # http://localhost:3000, not the container's 3020
```

Run the gate before every push:

```bash
pnpm check
```

That is the typecheck, the linter, the unit tests, the editor round-trips, the
operational Python tests, the mail-egress worker's own gate, and the checks
that keep private paths and undocumented environment variables out.

Browser tests are separate and slower. The first run has to fetch the browser:

```bash
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

`pnpm install` also installs the repository's git hooks, through the `prepare`
script. pnpm skips `prepare` when the lockfile has not changed, so a checkout
you already had is not armed until you run it yourself:

```bash
pnpm run prepare
```

## What CI runs

A pull request runs the cheap gate: `pnpm install`, a gitleaks scan of the
working tree, and `pnpm check`. The scan carries no push-only guard, so a
secret on a branch fails before anyone reviews it rather than after. A pull
request whose every changed file sits in `ci.yml`'s `paths-ignore` list —
`README.md`, `PRODUCT.md`, `docs/design/**` and the few others named there —
runs nothing at all.

A merge to `main` runs that plus `scripts/verify-ops.sh`, a compact browser
suite (`pnpm test:e2e:release`), `pnpm build`, and the standalone and
mail-service smokes. Each of those steps is guarded
`if: github.event_name == 'push'`, which is deliberate and which means a green
pull request is not yet a green `main`.

Neither event smokes the container. `release.yml` boots the image and the
Compose sample on a `v*` tag, so a change under `ops/docker/` reaches `main`
with nothing having run it — say so in the pull request. `pnpm smoke:compose`
is that same smoke locally, against an image you built yourself. It reads two
variables and refuses to start without either:

```bash
BRAIN_SMOKE_IMAGE=brain-smoke:local BRAIN_SMOKE_COMMIT=$(git rev-parse HEAD) pnpm smoke:compose
```

`BRAIN_SMOKE_IMAGE` is the tag you built; `BRAIN_SMOKE_COMMIT` is the 40-hex
commit the running container has to report back.

## Commit messages

The history reads `type(scope): what changed`, one sentence, lowercase after
the colon, no ticket numbers and no full stop:

```
fix(store): a rename keeps the id when the folder already exists
docs(deploy): record the rollback the canary proved
```

Several small commits beat one commit holding everything.

## Where to ask

Questions and proposals go to
[Discussions](https://github.com/michaelbrowk/brain/discussions), defects to
[Issues](https://github.com/michaelbrowk/brain/issues). Report anything that
looks like a security problem privately, through GitHub's **Report a
vulnerability** button on the Security tab, rather than in a public issue. That
button is there only while private reporting is switched on — if it is not,
open an issue saying you have a report and nothing else.

Opening a pull request means your contribution ships under the MIT licence in
`LICENSE`.
