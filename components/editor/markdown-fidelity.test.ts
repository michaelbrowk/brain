// @vitest-environment jsdom

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener } from "@milkdown/kit/plugin/listener";
import { sinkListItem } from "@milkdown/kit/prose/schema-list";
import { Selection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentRefs } from "./attachment-refs";
import { callout } from "./callout";
import { colorMarks } from "./color-mark";
import { columns } from "./columns";
import { editingCore } from "./editing-core";
import { emptyBlocks } from "./empty-block";
import { images } from "./image";
import { markdownFidelity } from "./markdown-fidelity";
import { math } from "./math";
import { normalizeLegacy } from "./normalize";
import { pageRef, setPageRefOrigin } from "./page-ref";
import { tableCells } from "./table-cell";
import { noNestedTables } from "./table-guard";
import { taskCheckboxMarkdown } from "./task-checkbox";
import { toggle } from "./toggle";

const editors: Editor[] = [];

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

/** The editor's own stack, in the order `milkdown-editor.tsx` applies it, so
 *  what serializes here is what a save writes. */
async function mount(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  setPageRefOrigin("http://brain.local");
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
    .use(colorMarks)
    .use(columns)
    .use(emptyBlocks)
    .use(callout)
    .use(toggle)
    .use(images)
    .use(math)
    .use(markdownFidelity)
    .use(pageRef)
    .use(listener)
    .create();
  editors.push(editor);
  const view = editor.ctx.get(editorViewCtx) as EditorView;
  const serialize = () => editor.ctx.get(serializerCtx)(view.state.doc).trimEnd();
  return { editor, view, serialize };
}

function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char));
  }
}

function press(view: EditorView, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

function caretAtEnd(view: EditorView) {
  view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));
}

/** The caret right after the given words, wherever the textblock is. */
function caretAfter(view: EditorView, words: string) {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(words)) {
      at = pos + node.text.indexOf(words) + words.length;
    }
  });
  if (at < 0) throw new Error(`no text ${JSON.stringify(words)}`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

const fixtureDir = path.join(process.cwd(), "scripts", "fixtures", "fidelity");

describe("the first serialize of a hand-written file is the file", () => {
  // One fixture per shape, the same files the gate runs: a shape that
  // regresses fails here with its name.
  for (const name of readdirSync(fixtureDir).filter((n) => n.endsWith(".md")).sort()) {
    it(`keeps ${name.replace(/\.md$/, "")}`, async () => {
      const input = readFileSync(path.join(fixtureDir, name), "utf8").trimEnd();
      const first = await mount(input);
      const once = first.serialize();
      expect(once).toBe(input);
      // and the serializer stays a fixed point on what it wrote
      const second = await mount(once);
      expect(second.serialize()).toBe(once);
    });
  }
});

describe("what the editor writes for what was typed here", () => {
  it("writes a typed list with - and keeps it tight, its nested list too", async () => {
    const { view, serialize } = await mount("- one");
    caretAfter(view, "one");
    press(view, "Enter");
    type(view, "two");
    press(view, "Enter");
    sinkListItem(view.state.schema.nodes.list_item!)(view.state, view.dispatch);
    type(view, "nested");

    expect(serialize()).toBe("- one\n- two\n  - nested");
  });

  it("writes an empty plain item as - and an empty cell as nothing", async () => {
    const { serialize } = await mount("-\n- item\n\n| a | b |\n| --- | --- |\n|  | 2 |");
    expect(serialize()).toBe("-\n- item\n\n| a | b |\n| --- | --- |\n|  | 2 |");
  });

  it("keeps <br /> on an empty task item, which GFM needs to see a task", async () => {
    const { serialize } = await mount("- [ ] <br />");
    expect(serialize()).toBe("- [ ] <br />");
  });

  it("keeps an empty line the writer made between blocks, in either spelling", async () => {
    // Typed here, an empty line is Brain's own explicit block; arrived as
    // `<br />`, it stays `<br />`. Neither is invented for an empty item.
    const { view, serialize } = await mount("a");
    caretAtEnd(view);
    press(view, "Enter");
    press(view, "Enter");
    type(view, "b");
    expect(serialize()).toBe("a\n\n::empty-block\n\nb");

    const loaded = await mount("a\n\n<br />\n\nb");
    expect(loaded.serialize()).toBe("a\n\n<br />\n\nb");
  });

  it("writes an edited table in the padded form and keeps an untouched one", async () => {
    const { view, serialize } = await mount("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |");
    let cell = -1;
    view.state.doc.descendants((node, pos) => {
      if (cell < 0 && node.type.name === "table_cell" && node.textContent === "1") cell = pos;
    });
    view.dispatch(view.state.tr.insertText("one", cell + 2, cell + 3));

    expect(serialize()).toBe("| a   | b |\n| --- | - |\n| one | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |");
  });

  it("writes a new divider as ---, and *** inside a list item", async () => {
    const { serialize } = await mount("a\n\n---\n\nb");
    expect(serialize()).toBe("a\n\n---\n\nb");
    const inList = await mount("- a\n\n  ***\n\n  b");
    expect(inList.serialize()).toBe("- a\n\n  ***\n\n  b");
  });

  it("keeps a page ref's spacer rule under the new text handler", async () => {
    const { serialize } = await mount("- [Page](/p/abc123) ");
    expect(serialize()).toBe("- [Page](/p/abc123)");
  });

  it("still escapes what would read as syntax", async () => {
    const { serialize } = await mount("a \\* b and \\_x\\_ and a \\<b\n\n\\# not a heading\n\n\\- not an item");
    expect(serialize()).toBe("a \\* b and \\_x\\_ and a \\<b\n\n\\# not a heading\n\n\\- not an item");
  });
});
