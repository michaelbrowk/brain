// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Slice } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_LINK_FIELD_EVENT } from "@/lib/editor-events";
import { attachmentRefs } from "./attachment-refs";
import { editingCore } from "./editing-core";
import { linkPreviewPlugin } from "./link-preview";
import { pageRef, setPageRefOrigin } from "./page-ref";
import { typedUrls } from "./typed-url";
import {
  linkRangeAt,
  pasteUrlOverSelection,
  removeLink,
  setLinkHref,
  webHrefFromInput,
  webLinks,
} from "./web-link";

type Mounted = { view: EditorView; markdown: () => string; destroy: () => Promise<void> };
const mounted: Mounted[] = [];

/** The editor's own stack, cut to what a web link meets: the presets, the
 *  extended link schema, the caret core, page refs (the internal links this
 *  must leave alone), the link card (whose paste this runs before), history
 *  and the clipboard, in the order `milkdown-editor.tsx` uses them. */
async function mount(markdown: string, unfurl = true): Promise<Mounted> {
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
    .use(attachmentRefs)
    .use(editingCore)
    .use(webLinks)
    .use(typedUrls)
    .use(pageRef)
    .use(linkPreviewPlugin(unfurl))
    .use(history)
    .use(clipboard)
    .create();
  const view = editor.ctx.get(editorViewCtx);
  await Promise.resolve();
  const result: Mounted = {
    view,
    markdown: () => editor.ctx.get(serializerCtx)(view.state.doc).trim(),
    destroy: async () => {
      await editor.destroy();
      root.remove();
    },
  };
  mounted.push(result);
  return result;
}

afterEach(async () => {
  while (mounted.length) await mounted.pop()!.destroy();
  setPageRefOrigin("");
});

/** The position just after the first occurrence of `text`. */
function after(view: EditorView, text: string) {
  let found = -1;
  view.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text) + text.length;
    }
    return true;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function select(view: EditorView, text: string) {
  const to = after(view, text);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to - text.length, to)));
}

function caret(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function paste(view: EditorView, text: string) {
  const data = { getData: (type: string) => (type === "text/plain" ? text : "") };
  const event = { clipboardData: data, preventDefault() {} } as unknown as ClipboardEvent;
  return view.someProp("handlePaste", (handle) => handle(view, event, Slice.empty)) ?? false;
}

/** One character at a time, the way a keyboard arrives, so an input rule
 *  sees each key as the browser would hand it over. */
function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const insert = () => view.state.tr.insertText(char, from, to);
    const handled = view.someProp("handleTextInput", (handle) => handle(view, from, to, char, insert));
    if (!handled) view.dispatch(insert());
  }
}

function key(view: EditorView, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  return view.someProp("handleKeyDown", (handle) => handle(view, event)) ?? false;
}

/** Every linked run in the document: its words and its address. */
function links(view: EditorView) {
  const found: Array<{ text: string; href: string }> = [];
  view.state.doc.descendants((node) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "link");
    if (!mark) return;
    const last = found[found.length - 1];
    if (last && last.href === mark.attrs.href && last.text !== node.text) {
      // adjacent text nodes under one mark differ only by another mark
      last.text += node.text ?? "";
      return;
    }
    found.push({ text: node.text ?? "", href: String(mark.attrs.href) });
  });
  return found;
}

describe("a URL pasted over selected words", () => {
  it("links the words and keeps them, and the file reads them back linked", async () => {
    const { view, markdown } = await mount("read the spec today");
    select(view, "the spec");
    expect(paste(view, "https://example.com/spec")).toBe(true);
    expect(view.state.doc.textContent).toBe("read the spec today");
    expect(links(view)).toEqual([{ text: "the spec", href: "https://example.com/spec" }]);
    expect(markdown()).toBe("read [the spec](https://example.com/spec) today");

    const again = await mount(markdown());
    expect(again.markdown()).toBe("read [the spec](https://example.com/spec) today");
    expect(links(again.view)).toEqual([{ text: "the spec", href: "https://example.com/spec" }]);
  });

  it("links the words in a heading and in a list item too", async () => {
    const { view, markdown } = await mount("## Read the spec\n\n* see the spec");
    select(view, "the spec");
    expect(paste(view, "https://example.com/spec")).toBe(true);
    caret(view, 1);
    select(view, "see the spec");
    expect(paste(view, "https://example.com/other")).toBe(true);
    expect(markdown()).toBe(
      "## Read [the spec](https://example.com/spec)\n\n* [see the spec](https://example.com/other)",
    );
  });

  it("gives the address a scheme the file can follow, and keeps a mail address", async () => {
    const { view } = await mount("ask the team");
    select(view, "the team");
    expect(paste(view, "www.example.com/team")).toBe(true);
    expect(links(view)).toEqual([{ text: "the team", href: "http://www.example.com/team" }]);
    select(view, "ask");
    expect(paste(view, "someone@example.com")).toBe(true);
    expect(links(view)[0]).toEqual({ text: "ask", href: "mailto:someone@example.com" });
  });

  it("leaves the paste alone where nothing is selected, where the text is not one URL, in code, and across lines", async () => {
    const { view, markdown } = await mount("alpha\n\nomega\n\n```\ncode\n```");
    expect(pasteUrlOverSelection(view.state, "https://example.com")).toBeNull();
    select(view, "alpha");
    expect(pasteUrlOverSelection(view.state, "https://example.com and more")).toBeNull();
    expect(pasteUrlOverSelection(view.state, "javascript:alert(1)")).toBeNull();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, after(view, "omega"))));
    expect(pasteUrlOverSelection(view.state, "https://example.com")).toBeNull();
    select(view, "code");
    expect(pasteUrlOverSelection(view.state, "https://example.com")).toBeNull();
    expect(markdown()).toBe("alpha\n\nomega\n\n```\ncode\n```");
  });

  it("runs before the link card, so the card never replaces selected words", async () => {
    const { view } = await mount("the whole line");
    select(view, "the whole line");
    expect(paste(view, "https://example.com/x")).toBe(true);
    expect(view.state.doc.textContent).toBe("the whole line");
    expect(links(view)).toEqual([{ text: "the whole line", href: "https://example.com/x" }]);
  });
});

describe("a URL typed into the line", () => {
  it("becomes a link when the space after it is typed, and the space stays plain", async () => {
    const { view, markdown } = await mount("");
    type(view, "see https://example.com/a?b=1 now");
    expect(links(view)).toEqual([{ text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" }]);
    expect(view.state.doc.textContent).toBe("see https://example.com/a?b=1 now");
    expect(markdown()).not.toContain("\\");

    const again = await mount(markdown());
    expect(links(again.view)).toEqual([{ text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" }]);
  });

  it("leaves trailing punctuation and an unbalanced bracket outside the link", async () => {
    const { view } = await mount("");
    type(view, "read https://example.com/a. ");
    type(view, "(see https://example.com/b) ");
    type(view, "and https://example.com/c?x=(1) ");
    type(view, "or www.example.com, ");
    expect(links(view)).toEqual([
      { text: "https://example.com/a", href: "https://example.com/a" },
      { text: "https://example.com/b", href: "https://example.com/b" },
      { text: "https://example.com/c?x=(1)", href: "https://example.com/c?x=(1)" },
      { text: "www.example.com", href: "http://www.example.com" },
    ]);
  });

  it("is linked by Enter as well, before the line splits", async () => {
    const { view } = await mount("");
    type(view, "https://example.com/enter");
    key(view, "Enter");
    expect(view.state.doc.childCount).toBeGreaterThanOrEqual(2);
    expect(links(view)).toEqual([{ text: "https://example.com/enter", href: "https://example.com/enter" }]);
  });

  it("does nothing in code, inside a link that is already there, or for words with a dot in them", async () => {
    const { view } = await mount("```\n\n```\n\n[docs](https://example.com/docs)");
    caret(view, 1);
    type(view, "https://example.com/code ");
    expect(links(view)).toEqual([{ text: "docs", href: "https://example.com/docs" }]);
    caret(view, after(view, "docs"));
    type(view, " https://example.com/more ");
    expect(links(view)).toEqual([{ text: "docs https://example.com/more ", href: "https://example.com/docs" }]);
    caret(view, view.state.doc.content.size - 1);
    type(view, " e.g. file.txt ");
    expect(links(view)).toHaveLength(1);
  });
});

describe("the link under the caret", () => {
  it("is found with its whole extent and address, and only for a web address", async () => {
    const { view } = await mount("a [bold words](https://example.com/x) b [page](/p/abc#words) c");
    const inside = after(view, "bold");
    const range = linkRangeAt(view.state, inside);
    expect(range).toEqual({ from: 3, to: 13, href: "https://example.com/x" });
    expect(linkRangeAt(view.state, 1)).toBeNull();
    expect(linkRangeAt(view.state, after(view, "pag"))?.href).toBe("/p/abc#words");
  });

  it("takes a new address over its whole extent and keeps the words, or goes away", async () => {
    const { view, markdown } = await mount("a [the **old** link](https://example.com/old) b");
    // The serializer writes a link around mixed marks as three links today
    // (C5, B2's); what this holds is that only the address changed.
    const before = markdown();
    const range = linkRangeAt(view.state, after(view, "the"))!;
    view.dispatch(setLinkHref(view.state, range, "https://example.com/new"));
    expect(markdown()).toBe(before.split("https://example.com/old").join("https://example.com/new"));
    expect(links(view)).toEqual([{ text: "the old link", href: "https://example.com/new" }]);
    expect(view.state.doc.textContent).toBe("a the old link b");

    view.dispatch(removeLink(view.state, linkRangeAt(view.state, after(view, "the"))!));
    expect(markdown()).toBe("a the **old** link b");
  });
});

describe("the field's address", () => {
  it("reads what a person types as a web address, or refuses it", () => {
    expect(webHrefFromInput("https://example.com/a")).toBe("https://example.com/a");
    expect(webHrefFromInput("  http://example.com ")).toBe("http://example.com");
    expect(webHrefFromInput("www.example.com/a")).toBe("http://www.example.com/a");
    expect(webHrefFromInput("example.com/path")).toBe("https://example.com/path");
    expect(webHrefFromInput("docs.example.co.uk")).toBe("https://docs.example.co.uk");
    expect(webHrefFromInput("someone@example.com")).toBe("mailto:someone@example.com");
    expect(webHrefFromInput("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(webHrefFromInput("Target Toolbar")).toBeNull();
    expect(webHrefFromInput("the spec")).toBeNull();
    expect(webHrefFromInput("e.g.")).toBeNull();
    expect(webHrefFromInput("javascript:alert(1)")).toBeNull();
    expect(webHrefFromInput("https://exa mple.com")).toBeNull();
    expect(webHrefFromInput("")).toBeNull();
  });
});

describe("Mod-Shift-k", () => {
  it("asks the toolbar for the link field and takes the key", async () => {
    const { view } = await mount("words");
    const asked = vi.fn();
    window.addEventListener(EDITOR_LINK_FIELD_EVENT, asked);
    try {
      select(view, "words");
      // jsdom is no Mac to the keymap, so Mod is Ctrl here.
      expect(key(view, "k", { ctrlKey: true, shiftKey: true })).toBe(true);
      expect(asked).toHaveBeenCalledTimes(1);
      expect(key(view, "k", { ctrlKey: true })).toBe(false);
      expect(asked).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(EDITOR_LINK_FIELD_EVENT, asked);
    }
  });
});
