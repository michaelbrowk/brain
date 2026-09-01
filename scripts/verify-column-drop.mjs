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

async function importEditorModules() {
  const tempDir = await mkdtemp(join(tmpdir(), "brain-column-drop-"));
  await symlink(join(repoRoot, "node_modules"), join(tempDir, "node_modules"), "dir");

  const importTs = async (relativePath, filename) => {
    const sourcePath = join(repoRoot, relativePath);
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
    const tempFile = join(tempDir, filename);
    await writeFile(tempFile, output.outputText, "utf8");
    return import(`${pathToFileURL(tempFile).href}?t=${Date.now()}`);
  };

  return {
    columns: await importTs("components/editor/columns.ts", "columns.mjs"),
    columnDrop: await importTs("components/editor/column-drop.ts", "column-drop.mjs"),
    cleanup: () => rm(tempDir, { recursive: true, force: true }),
  };
}

const normalize = (md) => md.replace(/\r\n?/g, "\n").trim();

function blockPos(doc, text) {
  let found = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isBlock && node.type.name !== "cols" && node.type.name !== "col" && node.textContent === text) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found === null) throw new Error(`Could not find block: ${text}`);
  return found;
}

function columnPosForBlock(doc, text) {
  const pos = blockPos(doc, text);
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.name === "col") return $pos.before(depth);
  }
  throw new Error(`Block is not inside a column: ${text}`);
}

async function createHarness(markdown, modules) {
  const root = document.createElement("div");
  document.body.append(root);

  const editor = await modules.Editor.make()
    .config((ctx) => {
      ctx.set(modules.rootCtx, root);
      ctx.set(modules.defaultValueCtx, markdown);
    })
    .use(modules.commonmark)
    .use(modules.gfm)
    .use(modules.columns)
    .create();

  return {
    root,
    editor,
    view: editor.action((ctx) => ctx.get(modules.editorViewCtx)),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
}

async function roundTrip(markdown, modules) {
  const harness = await createHarness(markdown, modules);
  try {
    return harness.editor.action(modules.getMarkdown());
  } finally {
    await harness.destroy();
  }
}

async function runDrop(testCase, modules, performColumnDrop) {
  const harness = await createHarness(testCase.markdown, modules);
  try {
    const draggedFrom = blockPos(harness.view.state.doc, testCase.dragged);
    const targetPos = blockPos(harness.view.state.doc, testCase.target);
    const tr = performColumnDrop(harness.view.state, draggedFrom, targetPos, testCase.side);
    if (!tr) throw new Error("performColumnDrop returned null");
    harness.view.dispatch(tr);

    const output = harness.editor.action(modules.getMarkdown());
    if (normalize(output) !== normalize(testCase.expected)) {
      throw new Error(
        `markdown mismatch\n--- expected ---\n${normalize(testCase.expected)}\n--- got ---\n${normalize(output)}`,
      );
    }

    const reparsed = await roundTrip(output, modules);
    if (normalize(reparsed) !== normalize(output)) {
      throw new Error(
        `roundtrip mismatch\n--- first serialize ---\n${normalize(output)}\n--- second serialize ---\n${normalize(reparsed)}`,
      );
    }
  } finally {
    await harness.destroy();
  }
}

async function runMove(testCase, modules, performColumnMove) {
  const harness = await createHarness(testCase.markdown, modules);
  try {
    const draggedFrom = blockPos(harness.view.state.doc, testCase.dragged);
    const targetColPos = columnPosForBlock(harness.view.state.doc, testCase.targetColumnBlock);
    const targetCol = harness.view.state.doc.nodeAt(targetColPos);
    if (!targetCol) throw new Error("Could not resolve target column");
    const targetInsertPos = targetColPos + targetCol.nodeSize - 1;
    const tr = performColumnMove(
      harness.view.state,
      draggedFrom,
      targetColPos,
      targetInsertPos,
    );
    if (!tr) throw new Error("performColumnMove returned null");
    harness.view.dispatch(tr);

    const output = harness.editor.action(modules.getMarkdown());
    if (normalize(output) !== normalize(testCase.expected)) {
      throw new Error(
        `markdown mismatch\n--- expected ---\n${normalize(testCase.expected)}\n--- got ---\n${normalize(output)}`,
      );
    }

    const reparsed = await roundTrip(output, modules);
    if (normalize(reparsed) !== normalize(output)) {
      throw new Error(
        `roundtrip mismatch\n--- first serialize ---\n${normalize(output)}\n--- second serialize ---\n${normalize(reparsed)}`,
      );
    }
  } finally {
    await harness.destroy();
  }
}

const CASES = [
  {
    name: "doc block to right edge creates two columns",
    markdown: ["A", "", "B"].join("\n"),
    dragged: "A",
    target: "B",
    side: "right",
    expected: [
      "::::cols",
      ":::col",
      "B",
      ":::",
      "",
      ":::col",
      "A",
      ":::",
      "::::",
    ].join("\n"),
  },
  {
    name: "outside paragraph joins existing cols as third col",
    markdown: [
      "::::cols",
      ":::col",
      "A",
      ":::",
      "",
      ":::col",
      "B",
      ":::",
      "::::",
      "",
      "C",
    ].join("\n"),
    dragged: "C",
    target: "B",
    side: "right",
    expected: [
      "::::cols",
      ":::col",
      "A",
      ":::",
      "",
      ":::col",
      "B",
      ":::",
      "",
      ":::col",
      "C",
      ":::",
      "::::",
    ].join("\n"),
  },
  {
    name: "dragging only block out of a col unwraps the old cols",
    markdown: [
      "::::cols",
      ":::col",
      "A",
      ":::",
      "",
      ":::col",
      "B",
      ":::",
      "::::",
      "",
      "C",
    ].join("\n"),
    dragged: "A",
    target: "C",
    side: "right",
    expected: [
      "B",
      "",
      "::::cols",
      ":::col",
      "C",
      ":::",
      "",
      ":::col",
      "A",
      ":::",
      "::::",
    ].join("\n"),
  },
];

const MOVE_CASES = [
  {
    name: "moving the only right block into the left column unwraps to one flow",
    markdown: [
      "::::cols",
      ":::col",
      "123123",
      ":::",
      "",
      ":::col",
      "## Привет",
      ":::",
      "::::",
    ].join("\n"),
    dragged: "Привет",
    targetColumnBlock: "123123",
    expected: ["123123", "", "## Привет"].join("\n"),
  },
  {
    name: "moving one of two right blocks keeps two non-empty columns",
    markdown: [
      "::::cols",
      ":::col",
      "A",
      ":::",
      "",
      ":::col",
      "B",
      "",
      "C",
      ":::",
      "::::",
    ].join("\n"),
    dragged: "C",
    targetColumnBlock: "A",
    expected: [
      "::::cols",
      ":::col",
      "A",
      "",
      "C",
      ":::",
      "",
      ":::col",
      "B",
      ":::",
      "::::",
    ].join("\n"),
  },
  {
    name: "moving the only left block into the right column maps positions safely",
    markdown: [
      "::::cols",
      ":::col",
      "A",
      ":::",
      "",
      ":::col",
      "B",
      ":::",
      "::::",
    ].join("\n"),
    dragged: "A",
    targetColumnBlock: "B",
    expected: ["B", "", "A"].join("\n"),
  },
];

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importEditorModules();
  const { columns } = loaded.columns;
  const { performColumnDrop, performColumnMove } = loaded.columnDrop;

  const [{ Editor, defaultValueCtx, editorViewCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] =
    await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/preset/gfm"),
      import("@milkdown/kit/utils"),
    ]);

  const modules = { Editor, defaultValueCtx, editorViewCtx, rootCtx, commonmark, gfm, getMarkdown, columns };

  let failures = 0;
  try {
    for (const testCase of CASES) {
      try {
        await runDrop(testCase, modules, performColumnDrop);
        console.log(`OK   ${testCase.name}`);
      } catch (e) {
        failures += 1;
        console.log(`ERR  ${testCase.name}: ${e.message?.slice(0, 1200)}`);
      }
    }
    for (const testCase of MOVE_CASES) {
      try {
        await runMove(testCase, modules, performColumnMove);
        console.log(`OK   ${testCase.name}`);
      } catch (e) {
        failures += 1;
        console.log(`ERR  ${testCase.name}: ${e.message?.slice(0, 1200)}`);
      }
    }
  } finally {
    await loaded.cleanup();
    dom.window.close();
  }

  const total = CASES.length + MOVE_CASES.length;
  console.log(`\nSummary: ${total - failures} OK, ${failures} DIFF/ERR of ${total}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e));
  process.exitCode = 1;
});
