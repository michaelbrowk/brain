#!/usr/bin/env node
// Serialization idempotency: for any document the editor can load,
// serialize(parse(md)) must be a FIXED POINT — feeding the serializer's own
// output back through parse+serialize yields the identical bytes. If it
// doesn't, every open-then-autosave cycle mints a new rev without the user
// typing anything, which surfaces as phantom 409 conflicts across tabs/MCP.
//
// Runs the built-in fixture set; point NOTES_DIR at a copy of real notes
// (folders with index.md) to sweep production content too.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  for (const name of ["window","document","navigator","Node","Text","HTMLElement","Element","DOMParser","XMLSerializer","MutationObserver","CustomEvent","Event","KeyboardEvent","MouseEvent"]) {
    setGlobal(name, dom.window[name]);
  }
  setGlobal("getSelection", dom.window.getSelection.bind(dom.window));
  setGlobal("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  setGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  setGlobal("addEventListener", dom.window.addEventListener.bind(dom.window));
  setGlobal("removeEventListener", dom.window.removeEventListener.bind(dom.window));
  setGlobal("dispatchEvent", dom.window.dispatchEvent.bind(dom.window));
  return dom;
}

const PLUGIN_FILES = [
  "normalize", "color-mark", "columns", "empty-block", "callout", "toggle", "image", "math", "page-ref",
];

async function importPlugins() {
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-idempotent-",
  );
  const modules = {};
  for (const name of PLUGIN_FILES) {
    modules[name] = await loader.load(
      `components/editor/${name}.ts`,
      `${name}.mjs`,
    );
  }
  return { modules, cleanup: loader.cleanup };
}

// fixtures cover every construct the editor can write
const FIXTURES = [
  {
    name: "57 explicit empty blocks",
    md: Array.from({ length: 57 }, () => "::empty-block").join("\n\n"),
  },
  {
    name: "prose + headings + lists + quote",
    md: [
      "# Title", "", "Some **bold** and _italic_ and `code` text.", "",
      "## Section", "", "- one", "- two", "  - nested", "", "1. first", "2. second", "",
      "> a quote block", "", "---", "", "Final paragraph.",
    ].join("\n"),
  },
  {
    name: "gfm table + code fence + task list",
    md: [
      "| a | b |", "| - | - |", "| 1 | 2 |", "",
      "```ts", "const x = 1;", "```", "",
      "- [ ] todo", "- [x] done",
    ].join("\n"),
  },
  {
    name: "callout + toggle + columns",
    pageRefs: 1,
    md: [
      ':::callout{icon="💡"}', "Idea text here", ":::", "",
      ':::toggle{summary="Details"}', "Hidden content", ":::", "",
      "::::cols", ":::col", "## Left", "", "[Page](/p/abc123)", ":::", "",
      ":::col", "## Right", "", "Prose here", ":::", "::::",
    ].join("\n"),
  },
  {
    name: "image + math + page refs + links",
    pageRefs: 1,
    md: [
      "![](/_attachments/pic1.png)", "",
      "$$", "E = mc^2", "$$", "",
      "[🦊 People](/p/people01)", "",
      "A [link](https://example.com) inline and an image:", "",
      "![alt text](/_attachments/pic2.jpg)",
    ].join("\n"),
  },
];

async function collectNotes(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "_attachments") {
      await collectNotes(p, out);
    } else if (e.name === "index.md") {
      const raw = await readFile(p, "utf8");
      // strip frontmatter (--- fenced) — the editor only ever sees the body
      const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
      out.push({ name: p, md: (m ? raw.slice(m[0].length) : raw).trim() });
    }
  }
}

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importPlugins();
  const m = loaded.modules;
  m["page-ref"].setPageRefOrigin("http://brain.local");

  const [{ Editor, defaultValueCtx, editorViewCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const plugins = [
    m["normalize"].normalizeLegacy,
    m["color-mark"].colorMarks,
    m["columns"].columns,
    m["empty-block"].emptyBlocks,
    m["callout"].callout,
    m["toggle"].toggle,
    m["image"].images,
    m["math"].math,
    m["page-ref"].pageRef,
  ];

  const cases = [...FIXTURES];
  if (process.env.NOTES_DIR) {
    const real = [];
    await collectNotes(process.env.NOTES_DIR, real);
    console.log(`NOTES_DIR: +${real.length} real notes`);
    cases.push(...real.filter((c) => c.md.length > 0));
  }

  const serialize = async (md, expectedPageRefs) => {
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
        .use(plugins.flat())
        .create();
      if (expectedPageRefs !== undefined) {
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        let pageRefNodes = 0;
        view.state.doc.descendants((node) => {
          if (node.type.name === "page_ref") pageRefNodes += 1;
        });
        const pageRefDom = root.querySelectorAll("a.brain-page-ref").length;
        if (
          pageRefNodes !== expectedPageRefs ||
          pageRefDom !== expectedPageRefs
        ) {
          throw new Error(
            `expected ${expectedPageRefs} page_ref nodes/DOM, got ${pageRefNodes}/${pageRefDom}`,
          );
        }
      }
      return editor.action(getMarkdown());
    } finally {
      if (editor) await editor.destroy();
      root.remove();
    }
  };

  // The hard invariant: serialization must reach a FIXED POINT. A one-time
  // normalization (pass1 ≠ pass2, pass2 === pass3) is allowed — one extra rev
  // per legacy page, once ever. Endless drift (pass2 ≠ pass3) fails the gate:
  // that's the class that mints a new rev on every open+save forever.
  let failures = 0;
  let normalized = 0;
  const diffLine = (a, b, la, lb) => {
    const A = a.split("\n");
    const B = b.split("\n");
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      if (A[i] !== B[i]) {
        console.log(`  line ${i + 1}:`);
        console.log(`  ${la}: ${JSON.stringify(A[i])}`);
        console.log(`  ${lb}: ${JSON.stringify(B[i])}`);
        return;
      }
    }
  };
  try {
    for (const c of cases) {
      try {
        const out1 = await serialize(c.md, c.pageRefs);
        const out2 = await serialize(out1, c.pageRefs);
        if (out1 === out2) {
          console.log(`OK   ${c.name}`);
          continue;
        }
        const out3 = await serialize(out2, c.pageRefs);
        if (out2 === out3) {
          normalized += 1;
          console.log(`NORM ${c.name} (one-time normalization, then stable)`);
          diffLine(out1, out2, "pass1", "pass2");
        } else {
          failures += 1;
          console.log(`DRIFT ${c.name} (never converges)`);
          diffLine(out2, out3, "pass2", "pass3");
        }
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
    `\nSummary: ${cases.length - failures - normalized} OK, ${normalized} NORM, ${failures} DRIFT/ERR of ${cases.length}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
});
