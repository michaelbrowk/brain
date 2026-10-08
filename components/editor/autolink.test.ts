// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { listener } from "@milkdown/kit/plugin/listener";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentRefs } from "./attachment-refs";
import { autolink } from "./autolink";
import { markdownFidelity } from "./markdown-fidelity";

const editors: Editor[] = [];

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
});

async function mount(markdown: string) {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(gfm)
    .use(attachmentRefs)
    .use(markdownFidelity)
    .use(autolink)
    .use(listener)
    .create();
  editors.push(editor);
  const view = editor.ctx.get(editorViewCtx) as EditorView;
  const serialize = () => editor.ctx.get(serializerCtx)(view.state.doc).trimEnd();
  return { editor, view, serialize };
}

/** Type through the input-rule path, one character at a time, as a key
 *  press reaches the editor. */
function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp("handleTextInput", (f) =>
      f(view, from, to, char, () => view.state.tr.insertText(char, from, to)),
    );
    if (!handled) view.dispatch(view.state.tr.insertText(char));
  }
}

function caretAtEnd(view: EditorView) {
  const end = view.state.doc.content.size - 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
}

function linksIn(view: EditorView): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  view.state.doc.descendants((node) => {
    const mark = node.marks.find((m) => m.type.name === "link");
    if (node.isText && mark) out.push({ text: node.text ?? "", href: String(mark.attrs.href) });
  });
  return out;
}

describe("typed URLs become links as they are typed", () => {
  it("links an https address on the space after it, and the file keeps it bare", async () => {
    const { view, serialize } = await mount("see");
    caretAtEnd(view);
    type(view, " https://example.com/path?q=1 here");

    expect(linksIn(view)).toEqual([
      { text: "https://example.com/path?q=1", href: "https://example.com/path?q=1" },
    ]);
    expect(serialize()).toBe("see https://example.com/path?q=1 here");
  });

  it("links a www address and an email, with the address GFM would read", async () => {
    const { view, serialize } = await mount("mail");
    caretAtEnd(view);
    type(view, " me@example.com or www.example.org today");

    expect(linksIn(view)).toEqual([
      { text: "me@example.com", href: "mailto:me@example.com" },
      { text: "www.example.org", href: "http://www.example.org" },
    ]);
    expect(serialize()).toBe("mail me@example.com or www.example.org today");
  });

  it("leaves trailing punctuation outside the link", async () => {
    const { view } = await mount("visit");
    caretAtEnd(view);
    type(view, " https://example.com. ");

    expect(linksIn(view)).toEqual([{ text: "https://example.com", href: "https://example.com" }]);
  });

  it("does not link inside code", async () => {
    const { view } = await mount("```\nx\n```");
    const code = view.state.doc.firstChild!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, code.nodeSize - 1)));
    type(view, " https://example.com ");

    expect(linksIn(view)).toEqual([]);
  });
});
