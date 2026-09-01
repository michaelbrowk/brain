#!/usr/bin/env node
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

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
    "window", "document", "navigator", "Node", "Text", "HTMLElement",
    "Element", "DOMParser", "XMLSerializer", "MutationObserver", "CustomEvent",
    "Event", "KeyboardEvent", "MouseEvent", "PointerEvent",
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

async function importCallout() {
  const sourcePath = join(repoRoot, "components/editor/callout.ts");
  const source = await readFile(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });
  const tempDir = await mkdtemp(join(tmpdir(), "brain-reviewed-markup-roundtrip-"));
  await symlink(join(repoRoot, "node_modules"), join(tempDir, "node_modules"), "dir");
  const tempFile = join(tempDir, "callout.mjs");
  await writeFile(tempFile, output.outputText, "utf8");
  return {
    module: await import(`${pathToFileURL(tempFile).href}?t=${Date.now()}`),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

const normalize = (markdown) => markdown.replace(/\r\n?/g, "\n").trim();

const CASES = [
  {
    name: "reviewed callout with a ZWJ emoji grapheme",
    markdown: [
      ':::callout{icon="👨🏽‍💻"}',
      "Exact **body**",
      "",
      "* first",
      "",
      "* second",
      ":::",
    ].join("\n"),
    visibleTokens: [],
  },
  {
    name: "reviewed callout with a flag grapheme",
    markdown: [
      ':::callout{icon="🇺🇦"}',
      "One line",
      ":::",
    ].join("\n"),
    visibleTokens: [],
  },
  {
    name: "reviewed escaped literal tags",
    markdown: [
      "prefix \\<insert-here/> suffix",
      "",
      "prefix \\</content>",
      "",
      "\\</invoke>",
    ].join("\n"),
    visibleTokens: ["<insert-here/>", "</content>", "</invoke>"],
  },
];

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importCallout();
  const { callout } = loaded.module;
  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  let failures = 0;
  try {
    for (const testCase of CASES) {
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
          .use(callout)
          .create();
        const output = editor.action(getMarkdown());
        const visible = root.textContent ?? "";
        const outsideCode = root.cloneNode(true);
        for (const code of outsideCode.querySelectorAll("code")) code.remove();
        const visibleProse = outsideCode.textContent ?? "";
        if (
          normalize(output) === normalize(testCase.markdown) &&
          testCase.visibleTokens.every(
            (token) => visible.includes(token) && visibleProse.includes(token),
          )
        ) {
          console.log(`OK   ${testCase.name}`);
        } else {
          failures += 1;
          console.log(`DIFF ${testCase.name}`);
          console.log(`expected: ${JSON.stringify(normalize(testCase.markdown))}`);
          console.log(`actual:   ${JSON.stringify(normalize(output))}`);
        }
      } catch (error) {
        failures += 1;
        console.log(
          `ERR  ${testCase.name}: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
        );
      } finally {
        if (editor) await editor.destroy();
        root.remove();
      }
    }
  } finally {
    await loaded.cleanup();
    dom.window.close();
  }
  console.log(
    `\nSummary: ${CASES.length - failures} OK, ${failures} DIFF/ERR of ${CASES.length}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
