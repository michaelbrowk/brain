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
  for (const name of ["window","document","navigator","Node","Text","HTMLElement","Element","DOMParser","XMLSerializer","MutationObserver","CustomEvent","Event","KeyboardEvent","MouseEvent","PointerEvent"]) {
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

/** image.ts imports the generated Solar module through the `@/` alias, so it
 *  needs the bundling loader (same as the embed round-trip) rather than a
 *  single-file transpile. */
async function importImages() {
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-image-roundtrip-",
  );
  return {
    module: await loader.load("components/editor/image.ts", "image.mjs"),
    cleanup: loader.cleanup,
  };
}

const normalize = (md) => md.replace(/\r\n?/g, "\n").trim();

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importImages();
  const { images } = loaded.module;

  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const cases = [
    { name: "image: caption only", markdown: "![c](u)" },
    { name: "image: width + center align", markdown: '![c](u "w=320 align=center")' },
    { name: "image: plain empty caption", markdown: "![](u)" },
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
          .use(images)
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
