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
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://brain.local/",
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
  for (const name of [
    "getSelection",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
  ]) {
    setGlobal(name, dom.window[name].bind(dom.window));
  }
  setGlobal("fetch", async (input) => {
    const requestUrl = new URL(String(input), "http://brain.local/");
    const url = requestUrl.searchParams.get("url") ?? "https://example.com";
    return new Response(
      JSON.stringify({
        title: "Example Preview",
        description: "A deterministic local unfurl response.",
        siteName: "example.com",
        url,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  return dom;
}

async function importEditorSources() {
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-embed-roundtrip-",
  );

  return {
    linkPreview: (
      await loader.load(
        "components/editor/link-preview.ts",
        "link-preview.mjs",
      )
    ).linkPreview,
    pageRefModule: await loader.load(
      "components/editor/page-ref.ts",
      "page-ref.mjs",
    ),
    cleanup: loader.cleanup,
  };
}

const normalize = (md) => md.replace(/\r\n?/g, "\n").trim();

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importEditorSources();
  loaded.pageRefModule.setPageRefOrigin("http://brain.local");

  const [{ Editor, defaultValueCtx, editorViewCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const cases = [
    {
      name: "bare URL becomes canonical autolink",
      markdown: "https://example.com/path?x=1",
      expected: "<https://example.com/path?x=1>",
    },
    {
      name: "existing autolink unchanged",
      markdown: "<https://example.com/path?x=1>",
      expected: "<https://example.com/path?x=1>",
    },
    {
      name: "url-labeled markdown link keeps canonical clean link",
      markdown: "[https://example.com/path?x=1](https://example.com/path?x=1)",
      expected: "<https://example.com/path?x=1>",
    },
    {
      name: "titled external link is not an embed candidate",
      markdown: "[Example](https://example.com)",
      expected: "[Example](https://example.com)",
    },
    {
      name: "internal page ref remains page ref markdown",
      markdown: "[Page](/p/abc123)",
      expected: "[Page](/p/abc123)",
      pageRefs: 1,
    },
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
          .use(loaded.pageRefModule.pageRef)
          .use(loaded.linkPreview)
          .create();
        if (testCase.pageRefs !== undefined) {
          const view = editor.action((ctx) => ctx.get(editorViewCtx));
          let pageRefNodes = 0;
          view.state.doc.descendants((node) => {
            if (node.type.name === "page_ref") pageRefNodes += 1;
          });
          const pageRefDom = root.querySelectorAll("a.brain-page-ref").length;
          if (
            pageRefNodes !== testCase.pageRefs ||
            pageRefDom !== testCase.pageRefs
          ) {
            throw new Error(
              `expected ${testCase.pageRefs} page_ref nodes/DOM, got ${pageRefNodes}/${pageRefDom}`,
            );
          }
        }
        const output = editor.action(getMarkdown());
        if (normalize(output) === normalize(testCase.expected)) {
          console.log(`OK   ${testCase.name}`);
        } else {
          failures += 1;
          console.log(`DIFF ${testCase.name}`);
          console.log(`  exp: ${normalize(testCase.expected)}`);
          console.log(`  got: ${normalize(output)}`);
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
