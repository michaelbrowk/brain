#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundledEditorSourceLoader } from "./lib/bundled-editor-source.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const setGlobal = (n, v) => Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true });

async function installDomGlobals() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const n of ["window","document","navigator","Node","Text","HTMLElement","Element","DOMParser","XMLSerializer","MutationObserver","CustomEvent","Event","KeyboardEvent","MouseEvent"]) setGlobal(n, dom.window[n]);
  for (const n of ["getSelection","requestAnimationFrame","cancelAnimationFrame","addEventListener","removeEventListener","dispatchEvent"]) setGlobal(n, dom.window[n].bind(dom.window));
  return dom;
}

const normalize = (md) => md.replace(/\r\n?/g, "\n").trim();

async function main() {
  const dom = await installDomGlobals();
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-pageref-",
  );
  const { pageRef, setPageRefOrigin } = await loader.load(
    "components/editor/page-ref.ts",
    "page-ref.mjs",
  );
  setPageRefOrigin("http://brain.local");

  const [{ Editor, defaultValueCtx, editorViewCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] = await Promise.all([
    import("@milkdown/kit/core"), import("@milkdown/kit/preset/commonmark"), import("@milkdown/kit/preset/gfm"), import("@milkdown/kit/utils"),
  ]);

  const cases = [
    { name: "internal page link", markdown: "See [Page Title](/p/abc123) here", pageRefs: 1 },
    { name: "page link with emoji", markdown: "[🦊 People](/p/def456)", pageRefs: 1 },
    { name: "external link untouched", markdown: "Visit [Google](https://google.com) now", pageRefs: 0 },
    { name: "mixed", markdown: "[Home](/p/h1) and [Docs](https://x.com) and [Wiki](/p/w2)", pageRefs: 2 },
  ];

  let failures = 0;
  try {
    for (const t of cases) {
      const root = document.createElement("div"); document.body.append(root);
      let editor = null;
      try {
        editor = await Editor.make().config((ctx) => { ctx.set(rootCtx, root); ctx.set(defaultValueCtx, t.markdown); }).use(commonmark).use(gfm).use(pageRef).create();
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        let pageRefNodes = 0;
        view.state.doc.descendants((node) => {
          if (node.type.name === "page_ref") pageRefNodes += 1;
        });
        const pageRefDom = root.querySelectorAll("a.brain-page-ref").length;
        if (pageRefNodes !== t.pageRefs || pageRefDom !== t.pageRefs) {
          throw new Error(
            `expected ${t.pageRefs} page_ref nodes/DOM, got ${pageRefNodes}/${pageRefDom}`,
          );
        }
        const out = editor.action(getMarkdown());
        if (normalize(out) === normalize(t.markdown)) console.log(`OK   ${t.name}`);
        else { failures++; console.log(`DIFF ${t.name}\n  exp: ${normalize(t.markdown)}\n  got: ${normalize(out)}`); }
      } catch (e) { failures++; console.log(`ERR  ${t.name}: ${e.message?.slice(0,160)}`); }
      finally { if (editor) await editor.destroy(); root.remove(); }
    }
  } finally { await loader.cleanup(); dom.window.close(); }
  console.log(`\nSummary: ${cases.length - failures} OK, ${failures} DIFF/ERR of ${cases.length}`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : String(e)); process.exitCode = 1; });
