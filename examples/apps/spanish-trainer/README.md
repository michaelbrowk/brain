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
- Every answer writes `Words` through `write.page`, reading the rev back first.
  One conflict is retried once, because the owner may have the page open.

## How the e2e seeds it

`e2e/apps.spec.ts` reads `index.html` off disk and sends it to
`create_app_page` over MCP, with `owns: [{ title: "Words" }]`, the way an agent
would. Nothing about the trainer is special to the test, which is the point:
the case fails if the tool, the frame, the kit or the bridge is wrong.

A shared copy of the trainer runs the same entry with the writes absent. It
reads inside the shared subtree, refuses every write with `read_only`, and the
trainer says so in its own status line rather than pretending the answer was
saved.
