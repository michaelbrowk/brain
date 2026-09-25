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
  which parent to read, which page is `Words`, and the two scripts that tell a
  word from its translation. Nothing else is in `state` — the words themselves
  live on the `Words` page, which is the one copy.
- The parent defaults to the app page's own parent. The picker in the head
  changes it, and a change is a `state.set`.
- The two scripts are two more selects in the head, and a change there is a
  `state.set` too. Changing either one re-reads every source page, because the
  pair is what decides whether a line is a pair at all.
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
- A page the frame has already read is not read again while its `updated` in
  the tree has not moved, which is what keeps a reload of sixty-six pages off
  the request budget. The cache is in memory and belongs to the frame, so
  closing the app or reloading Brain reads every page again. Changing either
  script drops it, because the rows it holds are the answer to the old
  question.
- A line ending in a full stop is held to a shorter length before it counts as
  a pair, so `adios — пока.` is a word and `I am learning - slowly.` is not.

## What counts as a word

The reader takes a pair on a bargain: the language being learned is on the left
and the owner's own is on the right, and the two are told apart by the script
they are written in. A pair counts only when the left side carries a letter of
the word script and the right side carries a letter of the translation script.
That single rule is what keeps a grammar table out of the deck, because a
conjugation (`tener | tengo`) is Spanish on both sides and a numbering column
(`1-е | -ar`) is Russian on both. Two smaller rules sit beside it: emphasis
marks (`**`, `*`, `_`, backticks) come off both sides before anything else,
while parentheses and a leading `¿` or `¡` stay because they are spelling
rather than markup, and a table's header row is found by position — it is the
row above the `| --- |` rule row, whatever language its cells are in — with the
old English list of column names kept only for a table somebody wrote without a
rule row.

**The two scripts are the owner's to name.** They sit in the head beside the
"Words from" picker, they live in `state` as `wordScript` and
`translationScript`, and the default is `Latin` against `any other than the
word's`, which is the bargain Michael's own notebook was measured on. The
choices are Latin, Cyrillic, Greek, Arabic, Hebrew, Han, Kana and Hangul, and
the translation side has one more: **any other than the word's**, spelled
`not-<script>` in `state`, which is any letter of any script but that one. The
word side is offered no such choice, because two sides that each meant
"anything but the other one" would between them mean nothing.

Naming the pair is what opens the reader to a notebook it used to return
nothing from: `Latin` against `Latin` reads a Spanish-and-English notebook,
`Cyrillic` against `Latin` reads one written the other way round.

The rule is exactly this and nothing more: **the word side must carry a letter
of the word script and the translation side a letter of the translation
script.** Neither side has to carry only its own, and that is deliberate —
`Acostarse (me acuesto)` and every pair the owner glossed in their own language
depend on it.

## What this gets wrong

Three misreads are known and measured, and each one is a row in
`vocabulary.test.ts` rather than a rule waiting to be written.

| The row | What happens | Why it is left alone |
| --- | --- | --- |
| a long phrase with a full stop after it | dropped, because the stop holds the line to the shorter length | the guard is what keeps `I am learning - slowly.` out, and a phrase that long is rarer than a sentence with a dash in it |
| `tú (твой)` against `tu (без акцента!)` | drilled as a word, though it is a row out of a possessives table | both sides carry both scripts, so the pair of scripts cannot separate them. Asking the translation side to carry only its own script would cost every glossed pair |
| `1-е` against `-ar`, with the pair reversed to `Cyrillic` against `Latin` | drilled as a word, though it is a numbering column | a numbering column in a Russian notebook is the same two scripts a vocabulary row is. The reader is told which scripts, not which tables |

A row the trainer got wrong is a row the owner can correct on the `Words` page,
and the correction survives, because the app merges that page rather than
replacing it. Deleting the row does not keep the word away: it is still on its
source page, and the next reload finds it again as new. Marking it Easy is what
takes a word out of the rotation for good.

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
