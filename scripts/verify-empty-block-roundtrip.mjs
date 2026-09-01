#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createBundledEditorSourceLoader } from "./lib/bundled-editor-source.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const COUNT = 57;
const INPUT = Array.from({ length: COUNT }, () => "::empty-block").join("\n\n");
const normalize = (markdown) => markdown.replace(/\r\n?/g, "\n").trim();

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

async function installDomGlobals() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  for (const name of ["window", "document", "navigator", "Node", "Text", "HTMLElement", "Element", "DOMParser", "XMLSerializer", "MutationObserver", "CustomEvent", "Event", "KeyboardEvent", "MouseEvent"]) {
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

/** Bundled through esbuild like the other editor harnesses, so each plugin's
 *  local imports (`@/lib/...`) resolve — a lone transpile of `columns.ts` no
 *  longer does. */
async function importEditorPlugins() {
  const loader = await createBundledEditorSourceLoader(
    repoRoot,
    "brain-empty-block-roundtrip-",
  );
  const modules = {};
  for (const name of ["columns", "empty-block"]) {
    modules[name] = await loader.load(
      `components/editor/${name}.ts`,
      `${name}.mjs`,
    );
  }
  return { modules, cleanup: loader.cleanup };
}

async function main() {
  const dom = await installDomGlobals();
  const loaded = await importEditorPlugins();
  const { columns } = loaded.modules["columns"];
  const { emptyBlocks } = loaded.modules["empty-block"];
  const [{ Editor, defaultValueCtx, rootCtx }, { commonmark }, { gfm }, { getMarkdown }] = await Promise.all([
    import("@milkdown/kit/core"),
    import("@milkdown/kit/preset/commonmark"),
    import("@milkdown/kit/preset/gfm"),
    import("@milkdown/kit/utils"),
  ]);
  const render = async (markdown) => {
    const root = document.createElement("div");
    document.body.append(root);
    let editor = null;
    try {
      editor = await Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
      }).use(commonmark).use(gfm).use(columns).use(emptyBlocks).create();
      return {
        markdown: editor.action(getMarkdown()),
        domCount: root.querySelectorAll('p[data-empty-block="true"]').length,
        strongCount: root.querySelectorAll("strong").length,
        inlineCodeTexts: [...root.querySelectorAll("code")].map(
          (element) => element.textContent ?? "",
        ),
        linkHrefs: [...root.querySelectorAll("a")].map(
          (element) => element.getAttribute("href") ?? "",
        ),
      };
    } finally {
      if (editor) await editor.destroy();
      root.remove();
    }
  };
  const richLabel = "**bold** and [link](https://x.test/a_(b)) and \\*escaped\\* and `code`";
  const occurrences = (value, needle) => value.split(needle).length - 1;
  const cases = [
    {
      name: `${COUNT} leafDirective empty blocks`,
      input: INPUT,
      check: (first, second) =>
        normalize(first.markdown) === INPUT &&
        normalize(second.markdown) === INPUT &&
        (first.markdown.match(/^::empty-block$/gm)?.length ?? 0) === COUNT &&
        first.domCount === COUNT &&
        second.domCount === COUNT,
    },
    {
      name: "leafDirective label stays literal and stable",
      input: "::empty-block[label]",
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes("empty-block") &&
        first.markdown.includes("label") &&
        second.markdown === first.markdown,
    },
    {
      name: "leafDirective attributes stay literal and stable",
      input: "::empty-block{kind=source}",
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes("empty-block") &&
        first.markdown.includes("kind") &&
        first.markdown.includes("source") &&
        second.markdown === first.markdown,
    },
    {
      name: "leafDirective label and attributes stay literal and stable",
      input: "::empty-block[label]{kind=source}",
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes("empty-block") &&
        first.markdown.includes("label") &&
        first.markdown.includes("kind") &&
        first.markdown.includes("source") &&
        second.markdown === first.markdown,
    },
    {
      name: "textDirective empty-block is literal and stable",
      input: ":empty-block[label]{kind=source}",
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes("empty-block") &&
        first.markdown.includes("label") &&
        first.markdown.includes("kind") &&
        first.markdown.includes("source") &&
        second.markdown === first.markdown,
    },
    ...["Meeting at 14:00", "Ratio 1:2"].map((text) => ({
      name: `ordinary colon prose stays plain and byte-stable: ${text}`,
      input: `${text}\n`,
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.inlineCodeTexts.length === 0 &&
        second.inlineCodeTexts.length === 0 &&
        first.markdown === `${text}\n` &&
        second.markdown === `${text}\n`,
    })),
    {
      name: "rich textDirective keeps label semantics without whole-source code",
      input: `:generic[${richLabel}]{kind=source}`,
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes(":generic") &&
        first.markdown.includes("**bold**") &&
        first.markdown.includes("\\*escaped\\*") &&
        first.markdown.includes("`code`") &&
        first.markdown.includes("kind=source") &&
        !/^`{1,2}:generic/.test(first.markdown) &&
        first.strongCount === 1 &&
        second.strongCount === 1 &&
        first.linkHrefs.includes("https://x.test/a_(b)") &&
        second.linkHrefs.includes("https://x.test/a_(b)") &&
        first.inlineCodeTexts.includes("code") &&
        second.inlineCodeTexts.includes("code") &&
        second.markdown === first.markdown,
    },
    {
      name: "escaped leafDirective spelling is literal and stable",
      input: "\\::empty-block",
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes("empty-block") &&
        second.markdown === first.markdown,
    },
    {
      name: "containerDirective empty-block is literal and stable",
      input: [":::empty-block[label]{kind=source}", "container body", ":::"].join("\n"),
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes("empty-block") &&
        first.markdown.includes("label") &&
        first.markdown.includes("kind") &&
        first.markdown.includes("source") &&
        first.markdown.includes("container body") &&
        second.markdown === first.markdown,
    },
    ...[
      {
        name: "unclosed generic container keeps a one-line body once",
        input: [":::generic", "one-line body"].join("\n"),
        bodies: ["one-line body"],
      },
      {
        name: "unclosed generic container keeps multi-paragraph body once",
        input: [
          ":::generic",
          "first paragraph",
          "",
          "second paragraph",
        ].join("\n"),
        bodies: ["first paragraph", "second paragraph"],
      },
      {
        name: "unclosed known-name foreign container keeps body once",
        input: [":::cols{foreign=value}", "foreign body"].join("\n"),
        bodies: ["foreign body"],
      },
    ].map(({ name, input, bodies }) => ({
      name,
      input,
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        bodies.every(
          (body) =>
            occurrences(first.markdown, body) === 1 &&
            occurrences(second.markdown, body) === 1,
        ) &&
        first.markdown.includes("foreign=value") ===
          input.includes("foreign=value") &&
        second.markdown === first.markdown,
    })),
    ...[
      {
        name: "generic leafDirective keeps exact rich label source",
        input: `::generic[${richLabel}]{kind=source}`,
        expectedSyntax: `::generic[${richLabel}]{kind=source}`,
      },
      {
        name: "generic containerDirective keeps exact rich label source",
        input: [`:::generic[${richLabel}]{kind=source}`, "container body", ":::"].join("\n"),
        expectedSyntax: `:::generic[${richLabel}]{kind=source}`,
      },
      {
        name: "known container with foreign properties keeps exact rich label source",
        input: [`:::cols[${richLabel}]{foreign=value}`, "container body", ":::"].join("\n"),
        expectedSyntax: `:::cols[${richLabel}]{foreign=value}`,
      },
    ].map(({ name, input, expectedSyntax }) => ({
      name,
      input,
      check: (first, second) =>
        first.domCount === 0 &&
        second.domCount === 0 &&
        first.markdown.includes(expectedSyntax) &&
        first.markdown.includes("**bold**") &&
        first.markdown.includes("[link](https://x.test/a_(b))") &&
        first.markdown.includes("\\*escaped\\*") &&
        first.markdown.includes("`code`") &&
        first.markdown.includes("kind") === input.includes("kind") &&
        first.markdown.includes("source") === input.includes("source") &&
        first.markdown.includes("foreign") === input.includes("foreign") &&
        first.markdown.includes("value") === input.includes("value") &&
        first.markdown.includes("container body") ===
          input.includes("container body") &&
        second.markdown === first.markdown,
    })),
  ];
  let failures = 0;
  try {
    for (const testCase of cases) {
      try {
        const first = await render(testCase.input);
        const second = await render(first.markdown);
        const ok = testCase.check(first, second);
        console.log(`${ok ? "OK" : "DIFF"}  ${testCase.name}`);
        if (!ok) {
          failures += 1;
          console.log(`  pass1: ${JSON.stringify(first.markdown)}`);
          console.log(`  pass2: ${JSON.stringify(second.markdown)}`);
        }
      } catch (error) {
        failures += 1;
        console.log(`ERR  ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await loaded.cleanup();
    dom.window.close();
  }
  console.log(`\nSummary: ${cases.length - failures} OK, ${failures} DIFF/ERR of ${cases.length}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
