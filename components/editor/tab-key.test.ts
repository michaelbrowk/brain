// @vitest-environment jsdom

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editingCore } from "./editing-core";
import { tableCells } from "./table-cell";

async function mount(markdown: string, editable = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.update(editorViewOptionsCtx, (prev) => ({ ...prev, editable: () => editable }));
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(gfm)
    .use(tableCells)
    .use(editingCore)
    .create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx)) as EditorView;
  view.dom.focus();
  const markdownNow = () =>
    editor.action((ctx) => ctx.get(serializerCtx)(view.state.doc)).trim();
  return { editor, view, markdownNow };
}

/** Select from the end of `from` to the end of `to`, both texts in the doc. */
function select(view: EditorView, from: string, to = from) {
  const at = (text: string) => {
    let found = -1;
    view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text?.includes(text)) {
        found = pos + node.text.indexOf(text) + text.length;
      }
    });
    if (found < 0) throw new Error(`no text ${text}`);
    return found;
  };
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, at(from), at(to))),
  );
}

function key(view: EditorView, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

// Focusing the editor makes ProseMirror measure the caret, which jsdom
// cannot do: a zero box everywhere is enough for these keys.
const box = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
beforeEach(() => {
  for (const proto of [Element.prototype, Range.prototype]) {
    Object.assign(proto, {
      getClientRects: () => [box],
      getBoundingClientRect: () => box,
    });
  }
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("Tab in a code block", () => {
  it("indents at the caret and Shift-Tab takes the indent back off the line", async () => {
    const { editor, view, markdownNow } = await mount("```\nif (x) {\nrun();\n}\n```");
    select(view, "if (x) {\n");
    expect(key(view)).toBe(true);
    expect(markdownNow()).toContain("if (x) {\n  run();\n}");
    expect(key(view, true)).toBe(true);
    expect(markdownNow()).toContain("if (x) {\nrun();\n}");
    // Nothing left to take off: the key is still the editor's.
    expect(key(view, true)).toBe(true);
    expect(markdownNow()).toContain("if (x) {\nrun();\n}");
    await editor.destroy();
  });

  it("indents and outdents every line a selection covers", async () => {
    const { editor, view, markdownNow } = await mount("```\na\nb\nc\n```");
    select(view, "a", "c");
    expect(key(view)).toBe(true);
    expect(markdownNow()).toContain("  a\n  b\n  c");
    expect(key(view, true)).toBe(true);
    expect(markdownNow()).toContain("```\na\nb\nc\n```");
    await editor.destroy();
  });
});

describe("Tab outside a code block or a table", () => {
  it("never moves the focus out of a paragraph or a heading", async () => {
    const { editor, view, markdownNow } = await mount("# Head\n\nprose");
    select(view, "pro");
    expect(key(view)).toBe(true);
    expect(key(view, true)).toBe(true);
    select(view, "He");
    expect(key(view)).toBe(true);
    expect(markdownNow()).toBe("# Head\n\nprose");
    await editor.destroy();
  });

  it("still nests a list item, and keeps the key where there is nothing to nest under", async () => {
    const { editor, view } = await mount("- one\n- two");
    const lists = () => {
      let n = 0;
      view.state.doc.descendants((node) => {
        if (node.type.name === "bullet_list") n += 1;
      });
      return n;
    };
    select(view, "one");
    expect(key(view)).toBe(true);
    expect(lists()).toBe(1);
    select(view, "two");
    expect(key(view)).toBe(true);
    expect(lists()).toBe(2);
    expect(key(view, true)).toBe(true);
    expect(lists()).toBe(1);
    await editor.destroy();
  });

  it("leaves Tab to the browser on a page that cannot be edited", async () => {
    const { editor, view } = await mount("prose", false);
    select(view, "pro");
    expect(key(view)).toBe(false);
    await editor.destroy();
  });

  it("leaves Tab to the browser when a control inside the page has the focus", async () => {
    const { editor, view } = await mount("prose");
    const button = document.createElement("button");
    view.dom.append(button);
    button.focus();
    expect(key(view)).toBe(false);
    await editor.destroy();
  });
});
