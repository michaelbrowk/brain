#!/usr/bin/env node
// The converter's structured golden output must survive the exact editor plugin
// stack. Unknown Notion blocks are fenced markers, never silently discarded.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundledEditorSourceLoader } from "./lib/bundled-editor-source.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const PLUGIN_FILES = [
  "normalize",
  "color-mark",
  "columns",
  "empty-block",
  "callout",
  "toggle",
  "image",
  "math",
  "page-ref",
];

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

async function installDomGlobals() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  for (const name of [
    "window",
    "document",
    "navigator",
    "Node",
    "Text",
    "HTMLElement",
    "Element",
    "DOMParser",
    "XMLSerializer",
    "MutationObserver",
    "CustomEvent",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
  ]) {
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

async function importPlugins() {
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-notion-roundtrip-",
  );
  const modules = {};
  for (const name of PLUGIN_FILES) {
    modules[name] = await loader.load(
      `components/editor/${name}.ts`,
      `${name}.mjs`,
    );
  }
  return {
    modules,
    cleanup: loader.cleanup,
  };
}

const normalize = (markdown) => markdown.replace(/\r\n?/g, "\n").trim();

async function renderMarkdown(Editor, defaultValueCtx, editorViewCtx, rootCtx, commonmark, gfm, getMarkdown, plugins, input, expectedPageRefs) {
  const root = document.createElement("div");
  document.body.append(root);
  let editor = null;
  try {
    editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, input);
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
    return editor.action(getMarkdown()).replace(/\r\n?/g, "\n").trimEnd();
  } finally {
    if (editor) await editor.destroy();
    root.remove();
  }
}

async function main() {
  const fixture = normalize(
    await readFile(
      join(repoRoot, "lib/notion/__fixtures__/structured.md"),
      "utf8",
    ),
  );
  const dom = await installDomGlobals();
  const loaded = await importPlugins();
  const m = loaded.modules;
  m["page-ref"].setPageRefOrigin("http://brain.local");
  const [
    { Editor, defaultValueCtx, editorViewCtx, rootCtx },
    { commonmark },
    { gfm },
    { getMarkdown },
  ] = await Promise.all([
    import("@milkdown/kit/core"),
    import("@milkdown/kit/preset/commonmark"),
    import("@milkdown/kit/preset/gfm"),
    import("@milkdown/kit/utils"),
  ]);
  const plugins = [
    m.normalize.normalizeLegacy,
    m["color-mark"].colorMarks,
    m.columns.columns,
    m["empty-block"].emptyBlocks,
    m.callout.callout,
    m.toggle.toggle,
    m.image.images,
    m.math.math,
    m["page-ref"].pageRef,
  ];
  let failure = 0;
  try {
    const output = normalize(
      await renderMarkdown(
        Editor,
        defaultValueCtx,
        editorViewCtx,
        rootCtx,
        commonmark,
        gfm,
        getMarkdown,
        plugins,
        fixture,
        1,
      ),
    );
    if (output === fixture) {
      console.log("OK   structured Notion golden fixture");
    } else {
      failure = 1;
      console.log("DIFF structured Notion golden fixture");
      console.log("--- expected ---\n" + fixture);
      console.log("--- got ---\n" + output);
    }

    const whitespace = ["::empty-block", "", "::empty-block"].join("\n");
    const firstCycle = await renderMarkdown(
      Editor,
      defaultValueCtx,
      editorViewCtx,
      rootCtx,
      commonmark,
      gfm,
      getMarkdown,
      plugins,
      whitespace,
      0,
    );
    const secondCycle = await renderMarkdown(
      Editor,
      defaultValueCtx,
      editorViewCtx,
      rootCtx,
      commonmark,
      gfm,
      getMarkdown,
      plugins,
      firstCycle,
      0,
    );
    if (
      secondCycle === firstCycle &&
      (secondCycle.match(/^::empty-block$/gm)?.length ?? 0) === 2
    ) {
      console.log("OK   whitespace/empty Notion two-cycle fixture");
    } else {
      failure += 1;
      console.log("DIFF whitespace/empty Notion two-cycle fixture");
      console.log("--- first cycle ---\n" + firstCycle);
      console.log("--- second cycle ---\n" + secondCycle);
    }
  } catch (error) {
    failure += 1;
    console.log(
      `ERR  structured Notion golden fixture: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await loaded.cleanup();
    dom.window.close();
  }
  console.log(`\nSummary: ${2 - failure} OK, ${failure} DIFF/ERR of 2`);
  process.exitCode = failure;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
