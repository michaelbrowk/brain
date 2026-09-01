#!/usr/bin/env node
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

/** The other editor harnesses bundle through esbuild so a plugin's own local
 *  imports — `@/lib/...` included — travel with it. `columns.ts` gained one
 *  (`lib/stray-directives.ts`, the walk the server shares) and a lone
 *  transpile of the file stopped resolving. */
async function importColumns() {
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-columns-roundtrip-",
  );
  return {
    module: await loader.load("components/editor/columns.ts", "columns.mjs"),
    cleanup: loader.cleanup,
  };
}

const normalize = (md) => md.replace(/\r\n?/g, "\n").trim();

// canonical (serializer) format — this is what the app must write so a load
// followed by an edit produces zero drift
const CASE1 = [
  "::::cols", ":::col", "## Calendars", "", "[2026](/p/abc123)", ":::", "",
  ":::col", "## Culture", "", "[People](/p/def456)", ":::", "::::",
].join("\n");

const CASE2 = [
  "::::cols", ":::col", "Some note text here", "", "[Page](/p/xyz789)", ":::", "",
  ":::col", "Second column", ":::", "::::",
].join("\n");


const CASE3 = [
  "::::cols", ":::col", "## Calendars", "", "[📅 2026](/p/a1)", "",
  "## Beds", "", "[🌱 Seedlings](/p/a2)", "", "[🌿 Cuttings](/p/a3)", ":::", "",
  ":::col", "## Orders", "", "[Seed Orders](/p/b1)", "",
  "## Trials", "", "[North Bed](/p/b2)", ":::", "::::",
].join("\n");

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importColumns();
  const { columns } = loaded.module;

  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const cases = [
    { name: "two columns: headings + links", markdown: CASE1 },
    { name: "columns: prose + link", markdown: CASE2 },
    { name: "broom output: multi-section 2-col", markdown: CASE3 },
  ];

  let failures = 0;
  try {
    for (const testCase of cases) {
      const root = document.createElement("div");
      document.body.append(root);
      let editor = null;
      try {
        editor = await Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, testCase.markdown);
          })
          .use(commonmark)
          .use(gfm)
          .use(columns)
          .create();
        const output = editor.action(getMarkdown());
        if (normalize(output) === normalize(testCase.markdown)) {
          console.log(`OK   ${testCase.name}`);
        } else {
          failures += 1;
          console.log(`DIFF ${testCase.name}`);
          console.log("--- expected ---\n" + normalize(testCase.markdown));
          console.log("--- got ---\n" + normalize(output));
        }
      } catch (e) {
        failures += 1;
        console.log(`ERR  ${testCase.name}: ${e.message?.slice(0, 200)}`);
      } finally {
        if (editor) await editor.destroy();
        root.remove();
      }
    }
  } finally {
    await loaded.cleanup();
    dom.window.close();
  }
  console.log(`\nSummary: ${cases.length - failures} OK, ${failures} DIFF/ERR of ${cases.length}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
});
