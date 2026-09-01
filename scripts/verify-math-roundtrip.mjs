#!/usr/bin/env node
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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

async function importMath() {
  const sourcePath = join(repoRoot, "components/editor/math.ts");
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
  const tempDir = await mkdtemp(join(tmpdir(), "brain-math-roundtrip-"));
  await symlink(join(repoRoot, "node_modules"), join(tempDir, "node_modules"), "dir");
  const tempFile = join(tempDir, "math.mjs");
  await writeFile(tempFile, output.outputText, "utf8");
  return {
    module: await import(`${pathToFileURL(tempFile).href}?t=${Date.now()}`),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

const normalize = (md) => md.replace(/\r\n?/g, "\n").trim();

const CASE1 = "inline $a^2+b^2$ text";
const CASE2 = "$$\\int_0^1 x\\,dx$$";

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importMath();
  const { math } = loaded.module;

  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const cases = [
    { name: "math: inline dollar", markdown: CASE1 },
    { name: "math: block dollar fence", markdown: CASE2 },
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
          .use(math)
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
