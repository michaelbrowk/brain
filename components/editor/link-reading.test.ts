// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { tableBlock } from "@milkdown/kit/component/table-block";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it } from "vitest";
import { renderReadOnly } from "@/lib/render-md";
import { attachmentRefs } from "./attachment-refs";
import { callout } from "./callout";
import { columns } from "./columns";
import { editingCore } from "./editing-core";
import { emptyBlocks } from "./empty-block";
import { images } from "./image";
import { linkPreviewPlugin } from "./link-preview";
import { normalizeLegacy } from "./normalize";
import { pageRef, setPageRefOrigin, syncLivePageInfo } from "./page-ref";
import { noNestedTables } from "./table-guard";
import { tableCells } from "./table-cell";
import { taskCheckboxMarkdown } from "./task-checkbox";
import { toggle } from "./toggle";

/** EVERY LINK A NOTE ALREADY HOLDS READS AS IT DID.
 *
 *  The words "Link to page" links are marked by an address no other writer
 *  uses (`linkedWordsHref`), so nothing already in a note may read any
 *  differently for it: not a chip, not a stale label, not a titled link a
 *  copied chip left behind. `__fixtures__/link-reading-main.txt` is what the
 *  editor and the share renderer made of each shape before the marker
 *  existed (0.21 main, 7079c90), byte for byte. */

const ORIGIN = "https://brain.example";

async function mount(markdown: string) {
  setPageRefOrigin(ORIGIN);
  syncLivePageInfo([
    { id: "abc123", title: "Renamed", icon: "🦊" },
    { id: "p2", title: "Two" },
  ]);
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(gfm)
    .use(taskCheckboxMarkdown)
    .use(attachmentRefs)
    .use(noNestedTables)
    .use(tableCells)
    .use(normalizeLegacy)
    .use(editingCore)
    .use(columns)
    .use(emptyBlocks)
    .use(callout)
    .use(toggle)
    .use(images)
    .use(pageRef)
    .use(linkPreviewPlugin(true))
    .use(tableBlock)
    .use(history)
    .use(clipboard)
    .use(listener)
    .create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
  const markdownNow = () => editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc)).trim();
  return { editor, view, markdownNow };
}

function describeDoc(doc: ProseNode) {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === "page_ref") out.push(`REF(${node.attrs.id})`);
    else if (node.isText) {
      const link = node.marks.find((mark) => mark.type.name === "link");
      out.push(
        link
          ? `LINK[${node.text}→${link.attrs.href}${link.attrs.title ? ` t=${link.attrs.title}` : ""}]`
          : JSON.stringify(node.text),
      );
    }
    return true;
  });
  return out.join(" ");
}

function share(markdown: string) {
  return renderReadOnly(markdown, {
    shareNavigation: {
      rootId: "root",
      isAllowedPage: () => true,
      pageLabel: (id) => (id === "abc123" ? { title: "Renamed", icon: "🦊" } : null),
    },
  });
}

async function reading(markdown: string) {
  const { editor, view, markdownNow } = await mount(markdown);
  try {
    return `IN  ${JSON.stringify(markdown)}\n  doc ${describeDoc(view.state.doc)}\n  ser ${JSON.stringify(markdownNow())}\n  shr ${share(markdown).replace(/\n/g, " ").slice(0, 300)}`;
  } finally {
    await editor.destroy();
  }
}

const SHAPES = [
  "See [Old label](/p/abc123) mid-sentence.",
  "[Old label](/p/abc123)",
  "- [🦊 Old](/p/abc123)",
  "[🧪 Emoji label](/p/abc123) and text",
  'See [Notion title](/p/abc123 "Notion title") here.',
  '[Notion title](/p/abc123 "Notion title")',
  'See [x](/p/abc123 "a different tooltip") here.',
  "See [x](/p/abc123 '') here.",
  "See [x](https://brain.example/p/abc123) here.",
  'See [x](https://brain.example/p/abc123 "x") here.',
  "See [x](/p/abc123#heading) here.",
  "See [x](/p/abc123?x=1) here.",
  "| a | b |\n| - | - |\n| [Old](/p/abc123) | c |",
  '| a | b |\n| - | - |\n| [w](/p/abc123 "w") | c |',
  'See [x][r] here.\n\n[r]: /p/abc123 "t"',
  "<https://brain.example/p/abc123>",
];

afterEach(() => {
  syncLivePageInfo();
  setPageRefOrigin("");
  document.body.replaceChildren();
});

describe("how a note's page links read", () => {
  it("reads every shape a note already holds exactly as main did, in the editor and on a share", async () => {
    const lines: string[] = [];
    for (const shape of SHAPES) lines.push(await reading(shape));
    const main = readFileSync(path.join(__dirname, "__fixtures__/link-reading-main.txt"), "utf8");
    expect(`${lines.join("\n")}\n`).toBe(main);
  });

  it("keeps linked words as words, links them on a share, and opens them as the page's", async () => {
    expect(await reading("See [the spec](/p/abc123#words) here.")).toBe(
      [
        'IN  "See [the spec](/p/abc123#words) here."',
        '  doc "See " LINK[the spec→/p/abc123#words] " here."',
        '  ser "See [the spec](/p/abc123#words) here."',
        '  shr <p>See <a href="/share/root?page=abc123">the spec</a> here.</p> ',
      ].join("\n"),
    );
  });
});
