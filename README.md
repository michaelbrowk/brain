# Brain

A notes app you keep on your own server — plain Markdown files as the source
of truth, a fast MCP for Claude, and a minimalist monochrome web UI (Mac +
iPhone).

- **Storage:** folders-as-pages, one `index.md` per page (YAML frontmatter +
  body). The `.md` tree is canonical; nothing is locked in a database. Saves
  are committed to git four seconds after the last one, so a burst of typing
  lands as a single commit and history / undo / backup come for free.
- **Editor:** Milkdown (Markdown WYSIWYG) with page blocks, columns, callouts,
  toggles, first-class images, tables, and inline AI. Everything round-trips
  losslessly to Markdown (enforced by `pnpm roundtrips`).
- **MCP:** an in-process HTTP MCP server (same `lib/store` the web uses) so
  Claude reads/writes the same notes; the open editor live-syncs via SSE.
  Standard OAuth + PKCE gives each connected app explicit read, write, or
  import permission and lets the owner revoke it from Settings, once the
  trusted reverse proxy in `docs/mcp-oauth.md` is in front. Without one, a
  static `MCP_TOKEN` is the way in.
- **AI:** inline writing assist, auto emoji, and smart-sort via OpenRouter.
  Inline assist sends only the selected text, capped at 12,000 characters.
  Sorting and emoji send page titles and immutable ids, never note bodies.
- **Updates:** once a day the server asks GitHub for the latest release and
  shows it in Settings → Account, with a link to what changed. The request
  carries nothing about your instance beyond a user agent naming Brain, its
  version and the project URL. `BRAIN_UPDATE_CHECK=off` turns it off.
  Upgrading stays what the Install section says: change the image tag and
  pull.

## Install

Brain runs as two containers — the web app and the mail service — against a
folder of Markdown files you keep. You need Docker with Compose v2 (the
`docker compose` command, not the older `docker-compose`) and a 130 MB image
download. On macOS the Docker VM has to share the folder you point
`NOTES_ROOT` at: Docker Desktop shares `/Users`, `/private` and `/tmp` by
default, colima shares only your home directory unless it was started with
`--mount`.

```bash
mkdir brain-notes
curl -O https://raw.githubusercontent.com/michaelbrowk/brain/main/ops/docker/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/michaelbrowk/brain/main/.env.example
# fill in the first block of .env — NOTES_ROOT (the absolute path of
# brain-notes), AUTH_SECRET, AUTH_PASSWORD_HASH and BRAIN_PUBLIC_ORIGIN —
# then:
docker compose up -d
```

That compose file pins the current release. To upgrade, raise the tag and run
`docker compose up -d` again.

Open `http://localhost:3020`. The first screen is one password box — no
username, no sign-up — because a Brain has one owner, and the hash you put in
`.env` is the whole account. Log in with the password you hashed. The session
cookie is `Secure`, which Chrome, Firefox and Edge honour over
`http://localhost`; Safari does not, so on Safari put Brain behind HTTPS
before logging in.

`NOTES_ROOT` is the absolute path of the folder on the host that holds the
notes — the `mkdir` above. An empty one is fine — Brain makes it a git
repository on the first save — and it has to be writable by uid 1000, the
unprivileged user inside the image, which is why you create it rather than
leave it to Docker: on a Linux host Docker creates a missing bind path as
root, uid 1000 cannot write there, and the first page you create fails until
the folder is `chown 1000`. The `/opt/brain/notes` in the compose file is the
container side of that mount, not a value for `NOTES_ROOT`. Each page becomes
a folder holding an `index.md`, and the folder is named from the title the
page had when it was created (`untitled-2` when the name is taken) — a later
rename changes `title:` in the frontmatter and leaves the folder as it was, so
a page created as "Untitled" and renamed lives in `untitled/` for good. The +
button in the sidebar offers templates — Meeting notes, Person, Project, Daily
note, Reading notes — beside a blank page.

On colima's default vz + virtiofs mount no `chown` on the Mac achieves that
writability: the folder arrives inside the container owned by root whatever
its host owner and mode. There, give the notes a Docker named volume instead
of the bind — `brain-notes:/opt/brain/notes` in place of
`${NOTES_ROOT}:/opt/brain/notes`, plus `brain-notes: {}` under `volumes:` —
and accept that the notes then live in Docker's volume store inside the VM
rather than in a Mac folder. Either way, Brain refuses a folder uid 1000
cannot write at startup, and `docker compose logs web` names the fix.

`AUTH_SECRET` wants 32 or more random bytes (`openssl rand -hex 32`).
`AUTH_PASSWORD_HASH` takes a bcrypt hash of your login password, which the
Docker you already have can produce:

```bash
docker run --rm httpd:2.4-alpine htpasswd -nbBC 12 "" 'your password' \
  | tr -d ':\n' | sed 's/\$/$$/g'
```

Paste that whole output. The `sed` doubles every `$`, which is what a literal
dollar has to look like to survive Compose's own substitution when it reads
`.env` — an unescaped `$2y$12$…` reaches the container shortened, and the only
symptom is a password that never works.

`BRAIN_PUBLIC_ORIGIN` is the exact origin your browser shows — scheme, host,
port, no path or trailing slash. `.env.example` ships a placeholder you have
to edit. Trying Brain on this machine only: set `http://localhost:3020` —
notes, login, share links and IMAP mail accounts all work with it. Two things
wait for an `https://` origin — the MCP endpoint, whose route refuses to load
under `http://` even with a static `MCP_TOKEN` (the MCP panel in Settings
cannot load its details until then), and Gmail's Connect flow. The value also
has to match the address bar exactly: set `http://localhost:3020`, open
`http://127.0.0.1:3020`, and adding a mail account is refused.

Everything else `.env.example` documents is optional, including the OpenRouter
key the AI features need. The compose file publishes Brain on the loopback
only, so put a TLS terminator in front of it before it answers a network and
set `BRAIN_PUBLIC_ORIGIN` to that `https://` origin.
`ops/nginx/brain.conf.example` is that terminator, written for a host with
nothing in front of it.

The second container, `mail`, is Brain's mail client — Gmail or an IMAP
mailbox, behind the Mail entry in the sidebar, connected from Settings.
Nothing in notes depends on it. With it stopped, the web app starts and works
as before, and the Mail surface says "Mail couldn’t load" with a Try again
button. To run without it, delete the `mail` service and web's
`depends_on: [mail]` line from the compose file — Compose refuses a
`depends_on` that names a service the file no longer has.

Would rather run Brain under systemd than in containers? `docs/operations.md`
is that path start to finish, and it says which of its steps a new host skips.

**MCP over OAuth is not on after this.** `/oauth/register`, `/oauth/token` and
`/oauth/revoke` answer 503 until `BRAIN_EDGE_RATE_SECRET` is set and the nginx
in `docs/mcp-oauth.md` sits in front — they rate-limit per client address, they
will not take that address from a header a client can forge, and they fail
closed rather than guess. Until you have that, connect MCP clients with a
static bearer token: put a value in `MCP_TOKEN` (`openssl rand -hex 32` does),
and give the client that. Everything else, including the whole web app, works
without either.

### Stop, upgrade, remove

`docker compose stop` pauses Brain and `docker compose down` removes the
containers, and neither touches the notes: `NOTES_ROOT` is a bind mount, so
the folder and its git history stay where they are and the next
`docker compose up -d` picks them up. Upgrading is the tag bump in
[Upgrade and deploy](#upgrade-and-deploy). The compose file also declares four
named volumes for state that is not notes — connected MCP apps and their
grants, the sender-icon cache, the mail service's accounts and the key that
wraps their credentials — and `docker compose down -v` deletes those, which
forgets every connected app and every mail account and still leaves the notes
folder alone. To remove Brain entirely: `docker compose down -v`, delete the
compose file and `.env`, and `docker rmi ghcr.io/michaelbrowk/brain:<tag>`.
The notes folder is yours to keep.

## Develop

```bash
pnpm install
cp .env.example .env.local   # fill in the values below
pnpm dev                     # http://localhost:3000
```

The dev server takes Next's default port. The container image sets
`PORT=3020`, which is why the two numbers differ.

Gate before shipping:

```bash
pnpm check
```

Eight steps, all of which have to pass: the forbidden-path and
environment-documentation checks, the linter, the typecheck, the unit tests,
the operational Python tests, the editor round-trips, and the mail-egress
worker's own gate.

Browser smoke tests run separately with `pnpm test:e2e`. `pnpm ci:local` is the
whole thing, build and smokes included. Physical-device and production
acceptance checks live in `docs/release-checklist.md`, and `CONTRIBUTING.md`
has the rest of the loop.

### Dependencies

One dependency does not come from the npm registry, and the reason matters —
**please do not "clean this up"**:

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

SheetJS stopped publishing to npm after `0.18.5` (March 2022) and moved
distribution to its own CDN. The registry copy is therefore permanently behind
on security fixes: `0.18.5` carries two high-severity advisories —
[prototype pollution](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6),
patched in `0.19.3`, and
[ReDoS](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9), patched in
`0.20.2` — and no registry version exists that fixes either. The vendor's own
distribution is the only patched source.

Brain parses spreadsheets that arrive through import as well as ones the reader
drops into the editor, so that parser reads bytes nobody here wrote. An
unusual-looking pin is worth much less than a knowingly vulnerable parser.
`0.20.3` is the newest build the CDN serves.

## Environment

| Var                  | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `NOTES_ROOT`         | Absolute host path of the notes folder (git-backed source of truth) |
| `AUTH_SECRET`        | 32+ byte secret for cookies and domain-separated OAuth keys     |
| `AUTH_PASSWORD_HASH` | bcrypt hash of the login password                               |
| `BRAIN_PUBLIC_ORIGIN` | Exact origin the browser shows — `http://localhost:3020` for a local trial, `https://` before MCP and Gmail work |
| `MCP_TOKEN`          | Legacy full-access MCP token kept during the OAuth migration     |
| `BRAIN_EDGE_RATE_SECRET` | 256-bit edge proof shared only by nginx and Brain           |
| `BRAIN_OAUTH_STATE_DIR` | Optional OAuth state directory (default `/var/lib/brain/oauth`) |
| `BRAIN_READINESS_TOKEN` | 256-bit internal token for the deep deploy health probe      |
| `OPENROUTER_API_KEY` | OpenRouter key for AI features (emoji, smart-sort, assist) |
| `OPENROUTER_MODEL`   | Optional model override (default `openai/gpt-4o-mini`)          |
| `BRAIN_UPDATE_CHECK`  | `off` stops the daily release check (default: on)              |
| `BRAIN_UPDATE_STATE_DIR` | Where the update check keeps its answer (default `/var/lib/brain/update`) |

Human access = password → signed httpOnly cookie. MCP clients connect to
`/api/mcp`, discover Brain OAuth automatically, and open a Brain consent screen.
The legacy bearer token remains available only as a migration path. Details and
the operator checklist are in `docs/mcp-oauth.md`.

## Smart sort

Smart sort asks the model to group a page's children into themed sections, then
rewrites the page body as ordinary Markdown — `## Section` headings with the
children as page links. The model chooses the sections and nothing else. The
order inside a section is settled in code, in `lib/dated-sections.ts`.

A section whose titles carry dates reads **newest first**, the way the rest of
Brain reads dated things: the hub's activity feed, page history, Trash. Five
title shapes are recognised, and the first one that matches anywhere in the
title wins:

| Shape                                       | Example                              |
| ------------------------------------------- | ------------------------------------ |
| ISO                                         | `2026-08-25`                         |
| Dotted, day first, four-digit year          | `25.08.2026`                         |
| Russian day + month, genitive or nominative | `Урок 12 мая`, `Урок 9 марта 2026`   |
| English day + month                         | `Lesson 9 March`, `Lesson 9 Mar 2026` |
| English month + day                         | `Lesson March 9`, `Lesson Mar 9, 2026` |

Nothing else counts as a date — not a two-digit year, a range like `9-16 марта`,
a month with no day, or a relative word. A page whose title holds one of those
keeps the position it had.

**A title with no year** takes the year — of the one before, the one of, or the
one after the page's own `created` date — that lands it closest to when the page
was written. Lessons named only by day and month straddle New Year, and the
creation date is the only evidence Brain holds about which side of it a lesson
fell on. A page with no usable `created` stays undated rather than being guessed
into place.

**Undated pages never move.** A page whose title holds no date keeps the exact
position it had, and the dated pages are dealt back into the positions they
already occupied. A section with fewer than two dated pages is left alone.

## Portable data

**Settings → Data** downloads the complete Brain as ordinary Markdown plus
attachments. A page's actions menu can export just that page and its
descendants. Import always runs a read-only preflight first and creates fresh
pages instead of overwriting existing notes. The open format, limits, and
failure behavior are documented in `docs/portable-archives.md`.

## Upgrade and deploy

Most installs are the Compose one above: raise the image tag in the
`docker-compose.yml` you downloaded and run `docker compose up -d` again.
Nothing below is needed for that, and stopping or removing that install is in
[Stop, upgrade, remove](#stop-upgrade-remove).

A `v*` tag builds three things — `brain-<version>-linux-x64.tar.gz`,
`SHA256SUMS`, and `ghcr.io/michaelbrowk/brain` — and opens a draft GitHub
Release. Publishing that draft is what makes a version installable.

If you would rather run Brain under systemd than in a container, the repository
carries the whole path: `docs/operations.md` sets up the immutable-release
layout, the service user and the environment file, and `docs/deploy-puller.md`
sets up a root-owned timer that installs the latest **published** release with
a read-only token, rechecks release, tag commit and checksums before and after
the atomic switch, runs untrusted work in transient systemd cgroups, and
recovers fsynced pending-release and deployment-transaction state before
declaring a no-op. Pre-releases install only when pinned.

`pnpm deploy <version>` is the manual form of the same thing, for an operator
with ssh to that host: it runs the full gate, downloads both release assets,
verifies `SHA256SUMS`, lays the extracted tree down as a new immutable release,
switches the symlink atomically, checks authenticated deep health, and rolls
back on failure. It needs `BRAIN_DEPLOY_HOST` set to that host. Notes and
secrets stay outside every release.

## Architecture

- `lib/store/` — the storage core (frontmatter, atomic write, id↔path, tree,
  fractional order, path-jail, git-on-save, SSE events). One process, one writer.
- `app/api/` — thin route handlers over `lib/store` (+ `/api/mcp`,
  `/api/ai`, `/api/events`, and the Store-backed `/api/portable/export` and
  `/api/portable/import` archive routes).
- `lib/notion/` — pure Notion-block conversion plus stable source hashing.
  Live imports use the authenticated `notion_*` MCP reserve/upload/finalize
  lifecycle, so notes and attachments still have exactly one writer. The
  resumable operator protocol is documented in `docs/notion-import.md`.
- `components/editor/` — Milkdown plugins; each custom block has a
  `scripts/verify-*-roundtrip.mjs` harness.
- `components/shell.tsx` — the app shell (sidebar tree, editor host, dialogs).

## Licence

MIT, in `LICENSE`. `CONTRIBUTING.md` has the local loop, what CI runs on a pull
request, and where to ask a question.
