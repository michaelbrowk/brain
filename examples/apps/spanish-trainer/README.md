# The Spanish trainer

The first app built for Brain, and the one the browser tests seed. It reads the
pages under one parent the owner picks, takes every `word / translation` pair
out of them, and drills the ones that are due. What it knows is kept on its own
`Words` page — a markdown table the owner can read and correct like any other
page — and that page is the only one the app is allowed to write.

Read `docs/apps.md` first if you are building one of your own. This is that
document with the argument taken out and the code left in.

## The files

| File | What it is |
| --- | --- |
| `index.html` | the entry, the one file Brain serves. It carries `vocabulary.js` inlined |
| `vocabulary.js` | the vocabulary reader and the `Words` table, unit-tested in `vocabulary.test.ts` |
| `build.mjs` | copies `vocabulary.js` into `index.html` between the two markers |
| `entry.test.ts` | lints the entry, and pins that it still carries the module's current text |

An app in the wild is one file and an agent writes it as one file. The module is
separate here only so it can be tested, and `entry.test.ts` fails the moment the
entry and the module disagree. After changing `vocabulary.js`:

```bash
node examples/apps/spanish-trainer/build.mjs
```

## How it behaves

- It asks the kit for `hello`, then reads the settings it kept in `state`:
  which parent to read, and which page is `Words`. Nothing else is in `state` —
  the words themselves live on the `Words` page, which is the one copy.
- The parent defaults to the app page's own parent. The picker in the head
  changes it, and a change is a `state.set`.
- A card shows the word, Show reveals the translation, and the three answers
  are Again, Good and Easy. Again puts the word back in this session, Good
  pushes it out by `2 ** seen` days, Easy marks it known and takes it out of
  the rotation. A known word is never drawn again.
- Every answer writes `Words` through `write.page`, reading the page back
  first and merging it rather than replacing it: the owner owns the words,
  the app owns the schedule of what it answered in this session. One conflict
  is retried once, because the owner may have the page open in the editor.
- Source pages are read paced under the bridge's thirty requests a second, and
  whatever still could not be read is counted and said out loud, because a page
  silently missing from a deck is a word the owner thinks they have finished.
- A line ending in a full stop is held to a shorter length before it counts as
  a pair, so `adios — goodbye.` is a word and `I am learning - slowly.` is not.
  A long phrase with a full stop after it is the case this gets wrong.

## How the e2e seeds it

`e2e/apps.spec.ts` reads `index.html` off disk and seeds it through
`POST /api/portable/import`, with the `Words` page as a child the app owns.

It does **not** go through `create_app_page`, and the reason is worth knowing
before this file is copied as a template. `/api/mcp` waits for a real `https://`
origin, which `.env.example` states as product behaviour, and the browser
harness serves `http://127.0.0.1:<port>` — the same value its share links and
the frame's own policy are built from. MCP is therefore off in that harness by
design, and the portable import is the other surface reaching the same store
writers. The three tools themselves are covered by
`app/api/mcp/app-tools.test.ts`.

Nothing about the trainer is special to the test, which is the point: the case
fails if the frame, the kit or the bridge is wrong.

A shared copy of the trainer runs the same entry with the writes absent. It
reads inside the shared subtree, refuses every write with `read_only`, and the
trainer says so in its own status line rather than pretending the answer was
saved.
