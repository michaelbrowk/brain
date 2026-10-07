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
import { editingCore, outdentCode } from "./editing-core";
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

describe("Escape", () => {
  // Tab stays in the page, so the keyboard needs another way out of it
  // (WCAG 2.1.2): Escape moves the focus on to what follows the editor.
  it("moves the focus to the first control after the editor", async () => {
    const before = document.createElement("button");
    document.body.prepend(before);
    const { editor, view } = await mount("prose");
    const after = document.createElement("button");
    const hidden = document.createElement("button");
    hidden.disabled = true;
    document.body.append(hidden, after);
    select(view, "pro");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(after);
    await editor.destroy();
  });

  it("leaves the focus alone when a menu took the Escape first", async () => {
    const { editor, view } = await mount("prose");
    document.body.append(document.createElement("button"));
    const menu = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", menu, true);
    try {
      view.dom.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(view.dom);
    } finally {
      document.removeEventListener("keydown", menu, true);
      await editor.destroy();
    }
  });
});

describe("the edges of Tab", () => {
  it("leaves alone a line the selection only touches at its very start", async () => {
    const { editor, view, markdownNow } = await mount("```\naa\nbb\n```");
    // From inside the first line to the first position of the second.
    const start = view.state.doc.firstChild ? 1 : 0;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, start + 1, start + 3)),
    );
    expect(key(view)).toBe(true);
    expect(markdownNow()).toContain("```\n  aa\nbb\n```");
    await editor.destroy();
  });

  it("outdents a one-space and a tab indent as well as two spaces", async () => {
    const { editor, view, markdownNow } = await mount("```\n a\n\tb\n```");
    select(view, "a", "b");
    expect(key(view, true)).toBe(true);
    expect(markdownNow()).toContain("```\na\nb\n```");
    await editor.destroy();
  });

  it("keeps Shift-Tab in a code block even with nothing to outdent", async () => {
    const { editor, view } = await mount("```\na\n```");
    select(view, "a");
    expect(outdentCode(view.state, view.dispatch, view)).toBe(true);
    await editor.destroy();
  });

  it("indents a code block inside a list item instead of nesting the item", async () => {
    const { editor, view, markdownNow } = await mount("- one\n- two\n\n  ```\n  code\n  ```");
    select(view, "code");
    expect(key(view)).toBe(true);
    expect(markdownNow()).toContain("code  ");
    let lists = 0;
    view.state.doc.descendants((node) => {
      if (node.type.name === "bullet_list") lists += 1;
    });
    expect(lists).toBe(1);
    await editor.destroy();
  });

  it("lets Tab go once the page stops being editable, focus or not", async () => {
    const { editor, view } = await mount("prose");
    select(view, "pro");
    expect(document.activeElement).toBe(view.dom);
    view.setProps({ editable: () => false });
    expect(key(view)).toBe(false);
    await editor.destroy();
  });
});
