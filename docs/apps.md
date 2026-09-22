# Building an app for Brain

An app page is a page whose body is an HTML application the owner runs inside
Brain. The page is an ordinary note — it has a title, an icon, a parent, a
body the owner reads — and beside its `index.md` sits an `app/` folder holding
one HTML file, its assets and its memory. The shell draws the page head and
then, in place of the editor, an `<iframe>` with an opaque origin serving that
file. Everything the app can reach goes through one `postMessage` bridge whose
writes are authorised on the server against a list the app does not control.

This document is for the agent building one. `docs/mcp-tools.md` has the three
tools; this has the rules, the protocol and the kit.

## When to build one, and when not to

**An app is the last resort, not a shortcut.** Build one only when the owner
asked for an app, or when what they asked for
cannot be done with the notebook's own means — a page, a table, a checklist,
tasks, mail, a collection view — and say which it was before you build.

Do not build an app to work around a missing Brain feature without naming the
gap. If the owner wants something Brain cannot do yet, the right move is a page
plus a note to the owner saying what is missing. An app built quietly around a
gap is a feature the owner now maintains alone, in a file nobody else reads.

An app is the right answer when the thing is genuinely interactive and genuinely
theirs: a flashcard trainer that grades an answer, a scoring sheet that computes,
a small game, a tool with a keyboard loop. It is the wrong answer for anything
that is a document with a nice layout.

`create_app_page` takes a required `reason`: the owner's own request, in one
line, in their words. It is kept in the page's frontmatter as `app.reason` and
drawn in the page head under "Built by Claude", so the owner can always see why
an app appeared under their notes. It never reaches the activity log or the
notification bell — that log is a redaction boundary and carries ids only.

## What is on disk

```
<page folder>/
  index.md            the page: frontmatter with `kind: app` and an `app` map,
                      and the description the owner reads
  app/
    index.html        the entry, the one path an app is served from
    assets/           images, fonts, audio, anything but markdown
    state.json        the app's own memory, written through the bridge
```

`app/` is reserved: Brain never walks it looking for pages. An asset may not be
named `*.md` at any depth, because an older Brain, or another clone of the notes
folder, would read one as a phantom child page.

The `app` map in the frontmatter:

| Field | What it is |
| --- | --- |
| `entry` | always `app/index.html` |
| `version` | the app's own version, yours to bump on a rebuild |
| `builtBy` | the name of the connection that built it, not a string you choose |
| `builtAt` | when |
| `owns` | the ids of the child pages this app may write. Nothing else is writable |
| `state` | whether the app has kept any state |
| `reason` | the owner's own request, one line |

## The frame, and what it cannot do

The frame is sandboxed with `allow-scripts allow-forms allow-modals` and no
`allow-same-origin`, so its origin is opaque: no cookies, no shared storage, no
reading Brain's DOM, no calling Brain's API as the owner. On top of that the
content policy is:

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src blob: data: <origin>/api/app/<id>/t/;
font-src data: <origin>/api/app/<id>/t/;
media-src data: <origin>/api/app/<id>/t/;
connect-src 'none'; frame-ancestors <origin>; base-uri 'none'; form-action 'none'
```

The entry is served under a per-session token, at
`/api/app/<id>/t/<token>/index.html`, and its assets sit beside it at
`/api/app/<id>/t/<token>/assets/…`. The token changes every time the frame is
mounted, and it expires and is re-minted while the frame is still open, so no
path an app could write down stays valid for long and the policy names `/t/`
rather than any one grant. **This is why an asset is addressed relatively and
can be addressed no other way.**

Three things follow, and each of them is a way an app breaks silently if you
forget it.

- **`connect-src 'none'` means the app has no network.** No `fetch`, no `XHR`,
  no `WebSocket`, no `EventSource`. Not to another site and not to Brain
  either. Everything goes through the bridge below. An app that needs a CDN
  does not work; inline the library into the entry instead.
- **Every library, stylesheet and script is inlined into the one file.** That
  is why `script-src` and `style-src` allow inline: the entry is an inline
  script and an inline stylesheet. There is no second file to load.
- **An asset is addressed relatively.** Write `assets/card.png`, never
  `/api/app/<id>/assets/card.png` and never an absolute URL. The path the
  frame is actually served from carries a token the app cannot know, so a
  written-out path is wrong on the next mount even when it is right on this
  one, and a request the policy blocks inside an opaque-origin frame reaches
  no console the owner will ever open: the app simply paints nothing.

A `data:` URI works everywhere an asset does, so a handful of small icons can
live in the entry with no asset at all.

## The bridge

The kit gives you `window.brain`, whose methods return promises. Underneath, each
one is a `postMessage` the host validates, rate-limits and answers. The rate is
**30 requests a second per frame**; past it the answer is `too_many`.

| Request | Kit method | Answers | Can refuse |
| --- | --- | --- | --- |
| `hello` | `brain.ready` | `{ theme, page, kit: { tokens } }` | nothing |
| `read.tree` | `brain.readTree()` | `{ tree }`, the whole page tree as a flat list | `store_failed` |
| `read.page` | `brain.readPage(id)` | `{ meta, markdown, rev }` | `not_found`, `store_failed` |
| `read.pages` | `brain.readPages(query)` | `{ hits }`, matching pages with snippets | `store_failed` |
| `write.page` | `brain.writePage(id, markdown, rev)` | `{ rev }`, the new one | `not_owned`, `rev_conflict`, `too_large`, `not_found`, `store_failed` |
| `create.page` | `brain.createPage(title, markdown, icon)` | `{ id }`, and the app now owns it | `bad_request`, `too_large`, `store_failed` |
| `state.get` | `brain.getState()` | `{ state }`, where `state` is `null` when none was kept. Always the object, never a bare `null` | `store_failed` |
| `state.set` | `brain.setState(json)` | `{ ok: true }` | `too_large`, `store_failed` |
| `open` | `brain.open(id)` | `{ ok: true }`, and Brain navigates to the page | nothing |
| `toast` | `brain.toast(text)` | `{ ok: true }` | nothing |

A refusal arrives as a rejected promise whose `Error` carries a `reason`
property holding one of those codes. Branch on `reason`, not on the sentence.

**`write.page` only writes a page in `owns`.** Not the app's own page, whose body
is the description the owner reads, and not a descendant that is not in the
list. The check runs on the server against the frontmatter, so nothing the frame
says can widen it. A page moved out of the app's subtree stops being writable,
which is how an owner takes a page back.

**`create.page` makes a child of the app and adds it to `owns`** in the same
request, up to 64 pages. That is the only way the list grows.

Two events arrive unasked, and `brain.on` is how you hear them:

```js
brain.on("theme", (theme) => { /* "light" or "dark" */ });
brain.on("visibility", (visible) => { /* the tab or the canvas */ });
```

The kit already applies the tokens on a theme change, so an app that reads its
colours from `var(--…)` needs no theme handler at all. Take one when you paint
to a canvas and have to redraw.

## The limits

| Thing | Cap |
| --- | --- |
| the entry, `app/index.html` | 2 MiB |
| all assets together | 10 MiB |
| `app/state.json` | 256 KiB |
| pages one app may own | 64 |
| bridge requests | 30 a second |

A write over a cap is refused whole with `too_large` and nothing is written. The
entry cap is generous rather than a budget to fill: two megabytes is a large
document with its libraries already inlined.

`state.json` is the app's memory across devices, not a database. It is read once
at start and written when something changes. Do not write it on every keystroke:
each write is a commit to the notes folder's git history.

## The kit

Ask for it with one line in the `<head>`:

```html
<link rel="brain-kit">
```

Brain replaces that link at serve time with the kit's stylesheet and its
bridge client. It cannot be fetched — the policy above forbids the frame
loading a stylesheet of its own — so this is the only way to get it, and an
entry that carries the link needs no `color-scheme` declaration of its own
because the kit makes one.

The kit's classes are Brain's own, so an app built with them and the shell
around it describe the same registers and the same controls.

| Class | What it is |
| --- | --- |
| `.text-title` | 30px / 700. One per screen |
| `.text-body` | 16px / 400. Everything the owner reads |
| `.text-caption` | 12px, muted. Under a thing, about that thing |
| `.text-label` | 11px / 600, muted. Over a group, naming it |
| `.btn` | a button, 44px tall. `data-primary` for the one that matters |
| `.field` | an input or a textarea, 44px tall, 16px text so iOS does not zoom |
| `.chip` | a small standing label, 28px |
| `.card` | a raised block on `--surface` |
| `.row` | one line of a list, 44px tall, hairline between siblings |

Every value in them is a token. The host reads the live computed properties off
Brain's own document and hands them over at `hello` and again on every theme
change, and the kit writes them onto the frame's `:root`, which is why a theme
flip repaints an app with no reload. The ones worth knowing:

`--paper` and `--surface` for grounds, `--ink` through `--ink-4` for text from
full strength to faintest, `--hair` and `--hair-strong` for lines, `--blue` for
the accent, `--fill-tint` / `--fill-hover` / `--fill-active` for control
backgrounds, `--r-xs` through `--r-xl` for radii, `--font-sf` for the type, and
`--ease-out` for motion.

```html
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="brain-kit">
<h1 class="text-title">Spanish</h1>
<div class="card">
  <p class="text-body" id="word"></p>
  <button class="btn" data-primary id="next">Next</button>
</div>
<script>
  async function start() {
    const saved = await brain.getState();
    const word = document.getElementById("word");
    word.textContent = (saved.state && saved.state.word) || "hola";
    document.getElementById("next").onclick = async () => {
      word.textContent = "adios";
      await brain.setState({ word: "adios" });
      brain.toast("Saved");
    };
  }
  // The entry is a classic script, so `await` lives inside a function and
  // never at the top level, where it is a SyntaxError that takes the whole
  // block with it. `brain.ready` settles once the host has answered the
  // kit's first hello, and it rejects after five seconds if nothing does.
  brain.ready.then(start, () => {
    document.getElementById("word").textContent = "Brain did not answer. Reload the page.";
  });
</script>
```

Two things in that block are the whole shape of an app. Everything starts from
`brain.ready`, because the tokens are not on the page until the host has
answered. And `await` sits inside a function: the entry is a classic script,
not a module, so a top-level `await` is a SyntaxError that silently takes
every line of the block with it.

## The design rules

Brain looks the way it does because it refuses things. An app inside it follows
the same refusals.

- **Monochrome.** Ink on paper, the whole range of `--ink` for hierarchy.
  Colour is not how you show structure.
- **One accent, and it is `--blue`.** A second accent is a decision the owner
  did not make. Use it for the one thing on the screen that matters, and for
  nothing else.
- **No dashboards.** No KPI tiles, no gauge, no sparkline row, no four-up grid
  of numbers in boxes. An app does one thing and shows that thing.
- **Dark comes free, through the tokens.** Do not write a second palette, do
  not branch on the theme in JavaScript, and **never hard-code a colour**: read
  every one from `var(--…)` and both themes are already correct.
- **44px touch targets.** The frame is the same width as the page on a phone,
  and the kit's controls are already 44px. Anything you draw yourself matches.
- **Type from the four registers.** Adding a fifth size is a design decision,
  not a styling shortcut.

## The lint

`create_app_page` and `write_app_page` run the entry through a lint before
anything is written, and a refusal answers `lint_failed` with the rule and the
1-based line number. It stops at the first finding: fix it and call again.

It cannot judge taste, and does not try. An ugly app passes. Three rules:

| Rule | What it caught | Why it is a rule |
| --- | --- | --- |
| `color_scheme` | the entry declares no `color-scheme` and asks for no kit | without one the frame paints in the browser's default scheme and ignores the owner's dark theme |
| `hard_coded_colour` | a `#hex`, `rgb(`, `hsl(`, `oklch(` or the like outside a `var(…)`, and a named CSS colour used as a declaration's value | a written colour cannot follow a theme. A colour inside a `var()` fallback is fine, because that is the token path |
| `external_resource` | an `@import`, a `url()`, or a `src` / `srcset` / `href` / `data` / `poster` / `action` / `formaction` / `ping` / `background` pointing at another origin, at a protocol-relative host or at an absolute path | the frame's policy blocks it with nothing said, so the app loads and paints nothing, and the lint is the only place anybody can be told |

A comment hides nothing: the lint blanks every `<!-- … -->` before the first
rule runs, so a commented-out `color-scheme` does not satisfy one and a
commented-out kit link does not carry the rest of its line past the others.
An attribute value may be unquoted, single-quoted or double-quoted and is read
the same way either way, and an `href` to another site is refused along with
the rest — an app links out through `brain.open(id)` or not at all.

**Named colours.** `background: red`, `color: white` and `border: 1px solid black`
are refused, in a `<style>` block and in a `style=` attribute, which is where
the browser reads a value as a colour. The same word anywhere else — in prose,
in a class name, in a JavaScript string — passes, and so do `transparent`,
`currentcolor` and the CSS-wide keywords, because none of those fixes a value.
What the lint cannot catch is a colour assembled from halves at runtime, so it
is a guard and not a proof.

**A `#` that is a name.** `href="#dead"`, `url(#face)`, `querySelector("#abc")`,
an `id=` and an `aria-*=` fragment are all read as names rather than as hex. A
bare `#abc` in a JavaScript string is still refused, because nothing can tell
what it is for once it sits in quotes on its own. Read the token instead:
`getComputedStyle(document.documentElement).getPropertyValue("--ink")`.

`data:` URIs and the app's own `assets/…` names pass all three rules.

## Rebuilding

`read_app_page` answers the entry, the asset names and the `rev`.
`write_app_page` takes that `rev` and replaces the entry and the assets, keeping
`owns`, keeping `state` and bumping `version`. It never takes an `owns` list: a
rebuild is a new entry for the same app, and widening what the frame may write
is the owner's business, not the rebuild's.

`owns` and `state` are read inside the store's own lock, not from what the
rebuild read before it started, so a page the running frame created while the
rebuild was writing is still owned when it finishes. `builtBy` and `builtAt`
are restamped, so the page head names the connection that built it last.

Assets left out of a rebuild are kept. An empty `assets` array is how an app
clears them, which is a caller saying so rather than a caller forgetting to
mention them. An asset's bytes are padded base64 on their own: no `data:`
prefix, no whitespace, no url-safe characters. Anything else is refused as
`bad_request` naming the asset, rather than written as the noise it decodes
to.

To change the description the owner reads, use `write_page` on the app page like
any other page.
