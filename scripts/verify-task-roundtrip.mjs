#!/usr/bin/env node
// Task-list round-trip: markdown -> editor -> markdown, byte for byte.
//
// The .md file is the source of truth, so the checkbox NodeView is only safe
// if ticking one changes nothing but the one bracket. Two invariants here:
//
//  1. Fidelity. Every case is parsed with the real preset stack plus the
//     NodeView and serialized back. The expected text is the serializer's
//     canonical form (`* [ ] text`, `[X]` folded to `[x]`, `-` and `+` folded
//     to `*`), which is what the editor has always written; the NodeView must
//     not move a single byte of it.
//  2. Idempotency. Feeding that output back through parse+serialize has to
//     return the identical bytes. `rev` is the sha1 of the raw file, so a
//     serializer that is not a fixed point mints a new rev on every open.
//
// Each case also states how many controls the document should carry, because a
// round-trip that passes with no NodeView mounted proves nothing.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createBundledEditorSourceLoader } from "./lib/bundled-editor-source.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

async function installDomGlobals() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const name of ["window","document","navigator","Node","Text","HTMLElement","Element","DOMParser","XMLSerializer","MutationObserver","CustomEvent","Event","KeyboardEvent","MouseEvent","PointerEvent"]) {
    if (dom.window[name]) setGlobal(name, dom.window[name]);
  }
  setGlobal("getSelection", dom.window.getSelection.bind(dom.window));
  setGlobal("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  setGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  setGlobal("addEventListener", dom.window.addEventListener.bind(dom.window));
  setGlobal("removeEventListener", dom.window.removeEventListener.bind(dom.window));
  setGlobal("dispatchEvent", dom.window.dispatchEvent.bind(dom.window));
  setGlobal("matchMedia", dom.window.matchMedia?.bind(dom.window) ?? (() => ({ matches: false })));
  return dom;
}

// Expected output, byte for byte, trailing newline included. Nothing rewrites
// it before the comparison: a `trimEnd()` on the output would have made the
// trailing-whitespace case pass whether or not the serializer drops the
// spaces, and stripping CR would have done the same to the CRLF case.
const out = (...rows) => rows.join("\n") + "\n";

// Left column is what a writer, Notion or another editor can hand us. Right
// column is the one canonical form the editor writes back.
const CASES = [
  { name: "unchecked", md: "- [ ] plain", want: out("* [ ] plain"), boxes: 1 },
  { name: "checked, star bullet", md: "* [x] star bullet", want: out("* [x] star bullet"), boxes: 1 },
  { name: "plus bullet", md: "+ [ ] plus bullet", want: out("* [ ] plus bullet"), boxes: 1 },
  { name: "capital X", md: "- [X] capital X", want: out("* [x] capital X"), boxes: 1 },
  {
    name: "nested",
    md: out("- [ ] nested parent", "  - [x] nested child"),
    want: out("* [ ] nested parent", "  * [x] nested child"),
    boxes: 2,
  },
  { name: "empty item", md: "- [ ] <br />", want: out("* [ ] <br />"), boxes: 1 },
  { name: "notion double space", md: "-  [x] notion double space", want: out("* [x] notion double space"), boxes: 1 },
  { name: "trailing whitespace", md: "- [ ] trailing whitespace   ", want: out("* [ ] trailing whitespace"), boxes: 1 },
  {
    name: "spread siblings",
    md: out("- [ ] item one", "", "- [ ] item two after a blank line (spread)"),
    want: out("* [ ] item one", "", "* [ ] item two after a blank line (spread)"),
    boxes: 2,
  },
  { name: "plain bullet", md: "- plain bullet, not a task", want: out("* plain bullet, not a task"), boxes: 0 },
  {
    name: "mixed list",
    md: out("- [ ] task", "- plain", "- [x] done"),
    want: out("* [ ] task", "", "* plain", "", "* [x] done"),
    boxes: 2,
  },
  {
    name: "ordered task",
    md: out("1. [ ] ordered one", "2. [x] ordered two"),
    want: out("1. [ ] ordered one", "2. [x] ordered two"),
    boxes: 2,
  },
  {
    name: "fenced code is not a task",
    md: out("```", "- [ ] not a task, it is code", "```"),
    want: out("```", "- [ ] not a task, it is code", "```"),
    boxes: 0,
  },
  {
    name: "CRLF normalises to LF",
    md: "- [ ] one\r\n- [x] two\r\n",
    want: out("* [ ] one", "", "* [x] two"),
    boxes: 2,
  },
  {
    name: "multi-block item",
    md: out("- [ ] first para", "", "  second para in the same item"),
    want: out("* [ ] first para", "", "  second para in the same item"),
    boxes: 1,
  },
];

// Pressing a control must move exactly one bracket and nothing else.
const TOGGLES = [
  {
    name: "toggle: tick the first of two",
    md: out("- [ ] one", "- [x] two"),
    press: 0,
    want: out("* [x] one", "", "* [x] two"),
  },
  {
    name: "toggle: untick a nested child",
    md: out("- [ ] parent", "  - [x] child"),
    press: 1,
    want: out("* [ ] parent", "  * [ ] child"),
  },
  {
    name: "toggle: an empty item keeps its placeholder",
    md: "- [ ] <br />",
    press: 0,
    want: out("* [x] <br />"),
  },
];

function diff(label, want, got) {
  const a = want.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log(`  ${label} line ${i + 1}:`);
      console.log(`    want: ${JSON.stringify(a[i])}`);
      console.log(`    got : ${JSON.stringify(b[i])}`);
      return;
    }
  }
}

async function main() {
  const dom = await installDomGlobals();
  const loader = await createBundledEditorSourceLoader(repoRoot, "brain-task-roundtrip-");
  const { taskCheckbox } = await loader.load(
    "components/editor/task-checkbox.ts",
    "task-checkbox.mjs",
  );

  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  // One editor per run, torn down after. `press` ticks the nth control before
  // serializing, which is the only way the transaction path gets tested.
  const run = async (md, press) => {
    const root = document.createElement("div");
    document.body.append(root);
    let editor = null;
    try {
      editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, md);
        })
        .use(commonmark)
        .use(gfm)
        .use(taskCheckbox)
        .create();
      const controls = root.querySelectorAll("button[role='checkbox']");
      if (press !== undefined) {
        if (!controls[press]) throw new Error(`no control at index ${press}`);
        controls[press].click();
      }
      return { md: editor.action(getMarkdown()), boxes: controls.length };
    } finally {
      if (editor) await editor.destroy();
      root.remove();
    }
  };

  let failures = 0;
  const total = CASES.length + TOGGLES.length;
  try {
    for (const c of CASES) {
      try {
        const first = await run(c.md);
        if (first.md !== c.want) {
          failures += 1;
          console.log(`DIFF ${c.name}`);
          diff("fidelity", c.want, first.md);
          continue;
        }
        if (first.boxes !== c.boxes) {
          failures += 1;
          console.log(`DIFF ${c.name}: expected ${c.boxes} control(s), the document rendered ${first.boxes}`);
          continue;
        }
        const second = await run(first.md);
        if (second.md !== first.md) {
          failures += 1;
          console.log(`DRIFT ${c.name} (serializer is not a fixed point)`);
          diff("idempotency", first.md, second.md);
          continue;
        }
        console.log(`OK   ${c.name}`);
      } catch (e) {
        failures += 1;
        console.log(`ERR  ${c.name}: ${e.message?.slice(0, 200)}`);
      }
    }

    for (const t of TOGGLES) {
      try {
        const pressed = await run(t.md, t.press);
        if (pressed.md !== t.want) {
          failures += 1;
          console.log(`DIFF ${t.name}`);
          diff("toggle", t.want, pressed.md);
          continue;
        }
        const again = await run(pressed.md);
        if (again.md !== pressed.md) {
          failures += 1;
          console.log(`DRIFT ${t.name} (serializer is not a fixed point)`);
          diff("idempotency", pressed.md, again.md);
          continue;
        }
        console.log(`OK   ${t.name}`);
      } catch (e) {
        failures += 1;
        console.log(`ERR  ${t.name}: ${e.message?.slice(0, 200)}`);
      }
    }
  } finally {
    await loader.cleanup();
    dom.window.close();
  }

  console.log(`\nSummary: ${total - failures} OK, ${failures} DIFF/DRIFT/ERR of ${total}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
});
