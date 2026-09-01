# Brain — notes for an agent working here

Brain is a self-hosted notes app. Plain Markdown files in nested folders are
the only source of truth: a page is a folder with an `index.md`, its children
are subfolders, and every save is a git commit in the notes repository. A
Next.js app serves the editor, and an in-process MCP server lets an assistant
read and write the same files. `README.md` has the install path, `PRODUCT.md`
the constraints, `CONTRIBUTING.md` the human-facing loop.

Node 22 and pnpm 11, the versions `package.json` pins, plus **ripgrep** and
**python3** on `PATH` — step 5 below shells out to the first and step 6 is the
second, so a machine without them fails the gate on something that is not the
change.

## Run the gate

```bash
pnpm check
```

Eight steps, in this order, and all of them must pass:

1. `scripts/check-forbidden-paths.mjs` — no tracked path the publication
   denylist withholds (see below);
2. `scripts/check-env-docs.mjs` — every environment variable the code reads is
   documented in `.env.example`, and `.env.example` documents nothing unread;
3. `eslint`;
4. `tsc --noEmit` — strict;
5. `vitest run`;
6. the operational Python tests under `ops/`;
7. `scripts/run-roundtrips.mjs` — the editor round-trips;
8. the mail-egress worker's own gate.

Browser tests are separate: `pnpm test:e2e` for everything, `pnpm
test:e2e:release` for the compact set. Either needs the browser fetched once
first — `pnpm exec playwright install --with-deps chromium`. `pnpm ci:local` is
the whole thing, including the build and the smokes.

## Local-first

The exhaustive gate runs on the machine you are working on. A pull request
gets only `pnpm install`, a secret scan, and `pnpm check` on a hosted runner;
every build, browser and systemd step is guarded to pushes on `main`. So a
green pull request is not yet a green `main`, and "CI will catch it" is not
available here — run `pnpm check` yourself before you hand work back.
`docs/ci-local-first.md` has the reasoning and the exact split.

## The publication denylist

`scripts/publication-denylist.mjs` names paths that must not exist in this
repository. It exists because this tree is exported from a private one, and
the same list drives the export and the gate. Two consequences when you add a
file:

- A new path that matches the list fails step 1 of `pnpm check` — for example
  anything under `docs/design/mail/`, `docs/design/train/` or
  `docs/postmortems/`. Some of the screenshot scripts in `scripts/` and `e2e/`
  write into exactly those directories; their output is a local review
  artifact, not something to commit here.
- That refusal is what step 1 does in the published repository. In the private
  archive this tree is exported from, a `.publication-role` marker puts the
  same check in archive mode, where denied paths are expected to be tracked
  and the check instead audits that every listed one still exists — so a
  denied file added there is not refused, it simply never travels.
- Do not remove an entry to make the check pass. If a denied path is genuinely
  needed, say so in the pull request instead.

## Invariants — a change that breaks one of these is wrong

1. **One writer.** Only `lib/store` touches the notes filesystem. Routes and
   MCP both go through it; never write a note file from a route or component.
2. **The id is the handle, not the path.** Every page carries an immutable id
   in its frontmatter. Address pages by id. Folder names are cosmetic, and
   renaming a title does not move a folder.
3. **Hierarchy comes only from the folder tree.** Never record a parent in
   frontmatter; a second source of truth is the bug, not the fix.
4. **Mutations are serialized and the mutex is not reentrant.** Each leaf
   mutator in `lib/store/store.ts` runs inside `mutate(...)`. A wrapped method
   must never call another wrapped method — composites stay unwrapped and
   delegate. This closed a concurrent-create race; keep it closed.
5. **Atomic writes with a rev.** Writes go to a temp file and `rename()`.
   `writePage` takes an optional `rev`, and a mismatch is a 409, not a
   last-write-wins.
6. **Path jail.** Every path resolves through the index and is checked with
   `assertInRoot`. Never accept a raw path from a client.
7. **One reading of a body.** `lib/internal-page-link.ts` is the only rule for
   what counts as a page link, for the editor and the store alike. Do not add
   a second parser or a second link regex.

## Conventions

- **Round-trips are a gate, not a wish.** Add or change a custom editor block
  and you add or update its harness beside the others in `scripts/`.
  `scripts/run-roundtrips.mjs` discovers them by name, so
  `verify-<block>-roundtrip.mjs` runs with nothing to register. A file named
  anything else runs only if that script names it: today one does, the
  serializer's own `verify-serialize-idempotent.mjs`, appended by hand at the
  end of the list. A block that does not survive `markdown → editor →
  markdown` unchanged is a data-loss bug.
- **A new environment variable is documented in the same commit**, or step 2
  fails. The reverse is true too: delete the reader, delete the block.
- **Design tokens only.** Colours, sizes, radii and type live in
  `app/globals.css`, and `DESIGN.md` is the system they implement — read it
  before adding a token. The palette is ink on warm paper, and the only hues
  are the bounded ones `DESIGN.md` names; do not introduce another. Icons come
  from the Solar set through `scripts/gen-icons.mjs`; do not hand-draw an SVG
  or add a second icon set.
- **Motion is generous but honours `prefers-reduced-motion`**, with the full
  matrix, every time.
- **Tests sit beside the code** as `*.test.ts`. A fix arrives with the test
  that fails without it.
- **Commit messages** read `type(scope): what changed` — one sentence,
  lowercase after the colon, no full stop. Several small commits beat one
  large one.
- **Stay in scope.** Review the whole `git status` before handing work back,
  and leave nothing unrelated behind.
