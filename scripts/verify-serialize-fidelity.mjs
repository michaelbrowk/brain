#!/usr/bin/env node
// Serialization fidelity: the FIRST serialize of a document must be the
// document. `verify-serialize-idempotent.mjs` proves the serializer reaches a
// fixed point; this gate proves the fixed point is the writer's own bytes, so
// the first save of a hand-written or imported file changes only what the
// edit changed. Every byte the serializer moves is listed, line by line.
//
// Runs the fixture files in `scripts/fixtures/fidelity/` (one Markdown shape
// each); point NOTES_DIR at a read-only copy of real notes (folders with
// index.md) to sweep production content too. BRAIN_FIDELITY_BASELINE=1 runs
// the stack without Brain's serializer configuration, to measure what it
// buys.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundledEditorSourceLoader } from "./lib/bundled-editor-source.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const fixtureDir = join(scriptDir, "fixtures", "fidelity");

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

// The editor's own stack, in the order `milkdown-editor.tsx` applies it, so
// what this gate serializes is what a save writes.
const PLUGIN_FILES = [
  "task-checkbox", "attachment-refs", "table-guard", "table-cell", "normalize", "editing-core",
  "color-mark", "columns", "empty-block", "callout", "toggle", "image", "math", "page-ref",
  "markdown-fidelity", "load-guard",
];

async function importPlugins() {
  const loader = await createBundledEditorSourceLoader(repoRoot, "brain-fidelity-");
  const modules = {};
  for (const name of PLUGIN_FILES) {
    if (name === "markdown-fidelity" && process.env.BRAIN_FIDELITY_BASELINE === "1") continue;
    modules[name] = await loader.load(`components/editor/${name}.ts`, `${name}.mjs`);
  }
  return { modules, cleanup: loader.cleanup };
}

// The body the editor sees: frontmatter off, CRLF folded, trailing whitespace
// trimmed, which is what `lib/page-markdown.ts` compares on the first flush.
function bodyOf(raw) {
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  const body = m ? raw.slice(m[0].length) : raw;
  return body.replace(/\r\n?/g, "\n");
}
const canonical = (md) => md.trimEnd().replace(/^\n+/, "");

async function collectNotes(root, dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "_attachments") {
      await collectNotes(root, p, out);
    } else if (e.name === "index.md") {
      out.push({ name: `note ${relative(root, p)}`, md: bodyOf(await readFile(p, "utf8")) });
    }
  }
}

async function collectFixtures() {
  const out = [];
  for (const name of (await readdir(fixtureDir)).filter((n) => n.endsWith(".md")).sort()) {
    out.push({ name: `fixture ${name}`, md: bodyOf(await readFile(join(fixtureDir, name), "utf8")) });
  }
  return out;
}

function diffLines(input, output) {
  const A = input.split("\n");
  const B = output.split("\n");
  const lines = [];
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) lines.push({ line: i + 1, input: A[i], output: B[i] });
  }
  return lines;
}

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importPlugins();
  const m = loaded.modules;
  m["page-ref"].setPageRefOrigin("http://brain.local");

  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark, syncHeadingIdPlugin }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const plugins = [
    commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin),
    gfm,
    m["task-checkbox"].taskCheckboxMarkdown,
    m["attachment-refs"].attachmentRefs,
    m["table-guard"].noNestedTables,
    m["table-cell"].tableCells,
    m["normalize"].normalizeLegacy,
    m["editing-core"].editingCore,
    m["color-mark"].colorMarks,
    m["columns"].columns,
    m["empty-block"].emptyBlocks,
    m["callout"].callout,
    m["toggle"].toggle,
    m["image"].images,
    m["math"].math,
    m["markdown-fidelity"]?.markdownFidelity ?? [],
    m["page-ref"].pageRef,
  ].flat();

  const cases = await collectFixtures();
  if (process.env.NOTES_DIR) {
    const real = [];
    await collectNotes(process.env.NOTES_DIR, process.env.NOTES_DIR, real);
    console.log(`NOTES_DIR: +${real.length} real notes`);
    cases.push(...real.filter((c) => c.md.trim().length > 0));
  }

  const serialize = async (md) => {
    const root = document.createElement("div");
    document.body.append(root);
    let editor = null;
    let dropped = 0;
    try {
      editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, md);
        })
        .use(plugins)
        .use(m["load-guard"].loadGuard((count) => { dropped = count; }))
        .create();
      if (dropped > 0) throw new Error(`the load dropped ${dropped} node(s)`);
      return editor.action(getMarkdown());
    } finally {
      if (editor) await editor.destroy();
      root.remove();
    }
  };

  let failures = 0;
  let movedLines = 0;
  try {
    for (const c of cases) {
      try {
        const input = canonical(c.md);
        const output = canonical(await serialize(c.md));
        if (input === output) {
          console.log(`OK   ${c.name}`);
          continue;
        }
        failures += 1;
        const lines = diffLines(input, output);
        movedLines += lines.length;
        console.log(`DIFF ${c.name} (${lines.length} line${lines.length === 1 ? "" : "s"} moved)`);
        for (const d of lines.slice(0, 12)) {
          console.log(`  line ${d.line}:`);
          console.log(`    in : ${JSON.stringify(d.input)}`);
          console.log(`    out: ${JSON.stringify(d.output)}`);
        }
        if (lines.length > 12) console.log(`  … ${lines.length - 12} more`);
      } catch (e) {
        failures += 1;
        console.log(`ERR  ${c.name}: ${e.message?.slice(0, 200)}`);
      }
    }
  } finally {
    await loaded.cleanup();
    dom.window.close();
  }
  console.log(
    `\nSummary: ${cases.length - failures} OK, ${failures} DIFF/ERR of ${cases.length} (${movedLines} lines moved)`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
});
