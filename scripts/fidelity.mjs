#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const MAX_BYTES = 100 * 1024;
const DEFAULT_SAMPLE = 30;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);

function usage() {
  console.error("Usage: node scripts/fidelity.mjs <corpus-dir> [--sample N]");
}

function parseArgs(argv) {
  let corpusDir = null;
  let sample = DEFAULT_SAMPLE;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sample") {
      const next = argv[index + 1];
      if (!next || !/^\d+$/.test(next)) {
        throw new Error("--sample requires a positive integer");
      }
      sample = Number(next);
      index += 1;
    } else if (arg.startsWith("--sample=")) {
      const value = arg.slice("--sample=".length);
      if (!/^\d+$/.test(value)) {
        throw new Error("--sample requires a positive integer");
      }
      sample = Number(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!corpusDir) {
      corpusDir = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!corpusDir) {
    throw new Error("Missing corpus directory");
  }
  if (!Number.isSafeInteger(sample) || sample < 1) {
    throw new Error("--sample requires a positive integer");
  }

  return { corpusDir, sample };
}

async function findMarkdownFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        return;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
        return;
      }
      const info = await stat(path);
      if (info.size <= MAX_BYTES) {
        files.push(path);
      }
    }));
  }

  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function sampleFiles(files, sampleSize) {
  if (files.length <= sampleSize) {
    return files;
  }

  const selected = [];
  const used = new Set();
  const step = files.length / sampleSize;

  for (let index = 0; index < sampleSize; index += 1) {
    let fileIndex = Math.floor(index * step);
    while (used.has(fileIndex) && fileIndex < files.length - 1) {
      fileIndex += 1;
    }
    used.add(fileIndex);
    selected.push(files[fileIndex]);
  }

  return selected;
}

function stripFrontmatter(markdown) {
  const withoutBom = markdown.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r\n|\n|\r/);
  if (lines[0]?.trim() !== "---") {
    return withoutBom;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "---" || line === "...") {
      return lines.slice(index + 1).join("\n").replace(/^\n/, "");
    }
  }

  return withoutBom;
}

function normalizeSetextHeadings(markdown) {
  const lines = markdown.split("\n");
  const normalized = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = lines[index + 1];
    if (
      line.trim() &&
      marker &&
      /^(?:=+|-+)\s*$/.test(marker.trim()) &&
      !/^\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~)/.test(line) &&
      !line.includes("|")
    ) {
      const level = marker.trim().startsWith("=") ? "#" : "##";
      normalized.push(`${level} ${line.trim()}`);
      index += 1;
    } else {
      normalized.push(line);
    }
  }

  return normalized.join("\n");
}

function normalizeTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || !trimmed.includes("|")) {
    return line;
  }

  const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
  return `| ${cells.join(" | ")} |`;
}

function normalizeEmphasis(markdown) {
  return markdown
    .replace(/(^|[^\w])__([^_\n]+?)__(?=$|[^\w])/g, "$1**$2**")
    .replace(/(^|[^\w])_([^_\n]+?)_(?=$|[^\w])/g, "$1*$2*");
}

function normalizeMarkdown(markdown) {
  let normalized = markdown
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");

  normalized = normalizeSetextHeadings(normalized);
  normalized = normalized.replace(/^(\s*)[*+](\s+)/gm, "$1-$2");
  normalized = normalizeEmphasis(normalized);
  normalized = normalized.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, "$1");
  normalized = normalized.split("\n").map(normalizeTableLine).join("\n");
  normalized = normalized.replace(/\n{3,}/g, "\n\n");

  return normalized.trim();
}

function firstDifferingPairs(before, after, limit = 3) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const pairs = [];

  for (let index = 0; index < max && pairs.length < limit; index += 1) {
    const beforeLine = beforeLines[index] ?? "";
    const afterLine = afterLines[index] ?? "";
    if (beforeLine !== afterLine) {
      pairs.push({
        line: index + 1,
        before: beforeLine,
        after: afterLine,
      });
    }
  }

  return pairs;
}

function printDiffPairs(pairs) {
  for (const pair of pairs) {
    console.log(`@@ line ${pair.line} @@`);
    console.log(`- ${pair.before}`);
    console.log(`+ ${pair.after}`);
  }
}

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

async function createMilkdownRoundTripper() {
  const dom = await installDomGlobals();
  const [
    { Editor, defaultValueCtx, rootCtx },
    { commonmark },
    { gfm },
    { getMarkdown },
  ] = await Promise.all([
    import("@milkdown/kit/core"),
    import("@milkdown/kit/preset/commonmark"),
    import("@milkdown/kit/preset/gfm"),
    import("@milkdown/kit/utils"),
  ]);

  async function roundTrip(markdown) {
    const root = document.createElement("div");
    document.body.append(root);
    let editor = null;

    try {
      editor = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, markdown);
        })
        .use(commonmark)
        .use(gfm)
        .create();

      return editor.action(getMarkdown());
    } finally {
      if (editor) {
        await editor.destroy();
      }
      root.remove();
    }
  }

  await roundTrip("# probe\n\n- ok\n");

  return {
    name: "milkdown",
    roundTrip,
    close: () => dom.window.close(),
  };
}

async function importFromRequireBase(baseUrl, packageName) {
  const require = createRequire(baseUrl);
  const resolved = require.resolve(packageName);
  return import(pathToFileURL(resolved).href);
}

async function createRemarkRoundTripper() {
  const kitCoreUrl = await import.meta.resolve("@milkdown/kit/core");
  const kitRoot = dirname(dirname(fileURLToPath(kitCoreUrl)));
  const milkdownScope = dirname(kitRoot);
  const milkdownCoreUrl = pathToFileURL(join(milkdownScope, "core/lib/index.js")).href;
  const milkdownGfmUrl = pathToFileURL(join(milkdownScope, "preset-gfm/lib/index.js")).href;
  const [
    { unified },
    { default: remarkParse },
    { default: remarkGfm },
    { default: remarkStringify },
  ] = await Promise.all([
    importFromRequireBase(milkdownCoreUrl, "unified"),
    importFromRequireBase(milkdownCoreUrl, "remark-parse"),
    importFromRequireBase(milkdownGfmUrl, "remark-gfm"),
    importFromRequireBase(milkdownCoreUrl, "remark-stringify"),
  ]);

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkStringify);

  return {
    name: "remark",
    roundTrip: async (markdown) => String(await processor.process(markdown)),
    close: () => {},
  };
}

function relativePath(path) {
  const rel = relative(repoRoot, path);
  return rel.startsWith("..") ? path : rel;
}

async function main() {
  const { corpusDir, sample } = parseArgs(process.argv.slice(2));
  const corpusInfo = await stat(corpusDir);
  if (!corpusInfo.isDirectory()) {
    throw new Error(`Corpus path is not a directory: ${corpusDir}`);
  }

  const files = sampleFiles(await findMarkdownFiles(corpusDir), sample);
  let engine;

  try {
    engine = await createMilkdownRoundTripper();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`FALLBACK: remark proxy (Milkdown headless failed: ${reason})`);
    engine = await createRemarkRoundTripper();
  }

  const results = [];

  try {
    for (const file of files) {
      const displayPath = relativePath(file);
      try {
        const raw = await readFile(file, "utf8");
        const input = stripFrontmatter(raw);
        const output = await engine.roundTrip(input);
        const normalizedInput = normalizeMarkdown(input);
        const normalizedOutput = normalizeMarkdown(output);

        if (normalizedInput === normalizedOutput) {
          console.log(`OK ${displayPath}`);
          results.push({ status: "OK", path: displayPath });
        } else {
          console.log(`DIFF ${displayPath}`);
          printDiffPairs(firstDifferingPairs(normalizedInput, normalizedOutput));
          results.push({ status: "DIFF", path: displayPath });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`ERROR ${displayPath}: ${message}`);
        results.push({ status: "ERROR", path: displayPath });
      }
    }
  } finally {
    engine?.close();
  }

  const ok = results.filter((result) => result.status === "OK").length;
  const diff = results.filter((result) => result.status === "DIFF").length;
  const error = results.filter((result) => result.status === "ERROR").length;
  const failures = results.filter((result) => result.status !== "OK");

  console.log("");
  console.log("Summary:");
  console.log(`${ok} OK, ${diff} DIFF, ${error} ERROR of ${results.length}`);
  if (failures.length) {
    console.log("DIFF/ERROR files:");
    for (const failure of failures) {
      console.log(`${failure.status} ${failure.path}`);
    }
  } else {
    console.log("DIFF/ERROR files: none");
  }

  process.exitCode = diff === 0 && error === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  usage();
  process.exitCode = 1;
});
