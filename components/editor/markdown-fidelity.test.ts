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
      // CRLF folded, as the store folds it before the editor sees a body.
      const input = readFileSync(path.join(fixtureDir, name), "utf8").replace(/\r\n?/g, "\n").trimEnd();
      const first = await mount(input);
      const once = first.serialize();
      expect(once).toBe(input);
      // and the serializer stays a fixed point on what it wrote
      const second = await mount(once);
      expect(second.serialize()).toBe(once);
    });
  }
});

describe("the schema is the preset's schema, with attributes added", () => {
  it("keeps paragraph the default block, so an empty page mounts and fills", async () => {
    const { view } = await mount("a");
    const { nodes } = view.state.schema;
    expect(nodes.doc!.contentMatch.defaultType?.name).toBe("paragraph");
    for (const name of ["doc", "blockquote", "callout", "toggle", "list_item", "table_cell"]) {
      expect(() => nodes[name]!.createAndFill(), name).not.toThrow();
    }
  });

  it("mounts an empty page, a whitespace page and a definition-only page", async () => {
    const empty = await mount("");
    type(empty.view, "typed");
    expect(empty.view.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(empty.serialize()).toBe("typed");

    const blank = await mount("   \n\n");
    expect(blank.serialize()).toBe("");

    const definition = await mount("[ref]: https://x.io");
    expect(definition.serialize()).toBe("");
  });

  it("gives Enter a paragraph, in a blockquote and in a callout", async () => {
    const quote = await mount("> quote");
    caretAfter(quote.view, "quote");
    press(quote.view, "Enter");
    type(quote.view, "typed");
    expect(quote.view.state.doc.firstChild?.lastChild?.type.name).toBe("paragraph");
    expect(quote.serialize()).toBe("> quote\n>\n> typed");

    const callout = await mount(':::callout{icon="💡"}\ntext\n:::');
    caretAfter(callout.view, "text");
    press(callout.view, "Enter");
    type(callout.view, "typed");
    expect(callout.view.state.doc.firstChild?.lastChild?.type.name).toBe("paragraph");
  });
});

describe("round three: links under one mark, empty items, cells, trailing spaces", () => {
  it("keeps two links to one address under one mark as two, across two saves", async () => {
    for (const input of [
      "**[a](https://x.io) [b](https://x.io)**",
      "**[Page](/p/abc123) [Page](/p/abc123)**",
    ]) {
      const first = await mount(input);
      const once = first.serialize();
      expect(once, input).toBe(input);
      const second = await mount(once);
      expect(second.serialize(), input).toBe(once);
      let links = 0;
      second.view.state.doc.descendants((node) => {
        if (node.type.name === "page_ref" || (node.isText && node.marks.some((m) => m.type.name === "link"))) links += 1;
      });
      expect(links, input).toBe(2);
    }
  });
});

describe("what an edit does to a kept shape", () => {
  it("writes an emptied setext heading as ATX, not an underline alone", async () => {
    const { view, serialize } = await mount("Title\n=====\n\nbody");
    const heading = view.state.doc.firstChild!;
    view.dispatch(view.state.tr.delete(1, 1 + heading.content.size));
    expect(serialize()).toBe("#\n\nbody");
  });

  it("writes a --- moved into a tight item as ***, which is not an underline", async () => {
    const { view, serialize } = await mount("- item\n- two\n\n---\n\nafter");
    let hr = -1;
    let itemEnd = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "hr") hr = pos;
      if (itemEnd < 0 && node.type.name === "paragraph" && node.textContent === "item") itemEnd = pos + node.nodeSize;
    });
    const rule = view.state.doc.nodeAt(hr)!;
    const tr = view.state.tr.delete(hr, hr + rule.nodeSize);
    tr.insert(itemEnd, rule);
    view.dispatch(tr);
    expect(serialize()).toBe("- item\n  ***\n- two\n\nafter");
  });

  it("writes a CRLF file's untouched table with the line endings folded", async () => {
    const { serialize } = await mount("a\r\n\r\n| a | b |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\nb");
    expect(serialize()).toBe("a\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nb");
  });

  it("keeps two links to one address as two, page refs included", async () => {
    const { serialize } = await mount("[a](https://x.io) [b](https://x.io)");
    expect(serialize()).toBe("[a](https://x.io) [b](https://x.io)");
    const refs = await mount("[Page](/p/abc123) [Page](/p/abc123)");
    expect(refs.serialize()).toBe("[Page](/p/abc123) [Page](/p/abc123)");
    expect(refs.view.state.doc.firstChild?.childCount).toBe(3);
  });

  it("keeps a bare address bare only where GFM would read it as one", async () => {
    const cases: [string, string][] = [
      ["word[https://x.io/a](https://x.io/a)", "word[https://x.io/a](https://x.io/a)"],
      ["[https://x.io/a.](https://x.io/a.)", "[https://x.io/a.](https://x.io/a.)"],
      ["[https://x.io/a](https://x.io/a)b", "[https://x.io/a](https://x.io/a)b"],
      ["*[https://x.io/a](https://x.io/a)*", "*https://x.io/a*"],
      ["see [https://x.io/a](https://x.io/a) now", "see https://x.io/a now"],
    ];
    for (const [input, want] of cases) {
      const { serialize } = await mount(input);
      expect(serialize(), input).toBe(want);
    }
  });

  it("keeps a leaf-directive lookalike escaped at a line start", async () => {
    const { serialize } = await mount("\\::name alone\n\n\\:::callout **a**");
    expect(serialize()).toBe("\\::name alone\n\n\\:::callout **a**");
  });
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

  it("keeps an empty line the writer made between blocks as <br />, typed or loaded", async () => {
    // Enter twice is an empty paragraph, which the preset writes as `<br />`
    // and reads back as one; arrived as `<br />`, it stays `<br />`.
    // Neither is invented for an empty item or cell.
    const { view, serialize } = await mount("a");
    caretAtEnd(view);
    press(view, "Enter");
    press(view, "Enter");
    type(view, "b");
    expect(serialize()).toBe("a\n\n<br />\n\nb");

    const loaded = await mount("a\n\n<br />\n\nb");
    expect(loaded.serialize()).toBe("a\n\n<br />\n\nb");
  });

  it("keeps an escaped fence lookalike a paragraph through a save", async () => {
    // The bytes may gain escapes (`\~\~\~`), the reading may not change: a
    // `~~~` that reopened as a fence swallowed the rest of the note.
    for (const input of ["\\~~~ **a**\n\nrest of note", "\\``` **a**\n\nrest of note"]) {
      const first = await mount(input);
      const written = first.serialize();
      const reopened = await mount(written);
      expect(reopened.view.state.doc.childCount, input).toBe(2);
      expect(reopened.view.state.doc.firstChild?.type.name, input).toBe("paragraph");
      expect(reopened.view.state.doc.textContent, input).toBe(input.replace(/\\/g, "").replace(/\*\*/g, "").replace("\n\n", ""));
      expect(reopened.serialize(), input).toBe(written);
    }
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
