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
  hrefForWords,
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

/** The block shape of the document, for comparing two editors. */
function shape(view: EditorView) {
  const out: string[] = [];
  view.state.doc.descendants((node) => {
    if (!node.isText) out.push(node.type.name);
  });
  return out.join(" ");
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

describe("a page URL over selected words (round 2, H1)", () => {
  it("pasted, absolute or relative, links the words to the page with the words marker, and a reload keeps them", async () => {
    const { view, markdown } = await mount("some words here and more words too");
    select(view, "words");
    expect(paste(view, "http://brain.local/p/abc123")).toBe(true);
    expect(links(view)).toEqual([{ text: "words", href: "/p/abc123#words" }]);
    caret(view, 1);
    select(view, "more words");
    expect(paste(view, "/p/plain")).toBe(true);
    expect(links(view)).toEqual([
      { text: "words", href: "/p/abc123#words" },
      { text: "more words", href: "/p/plain#words" },
    ]);
    expect(markdown()).toBe("some [words](/p/abc123#words) here and [more words](/p/plain#words) too");

    const again = await mount(markdown());
    expect(again.view.state.doc.textContent).toBe("some words here and more words too");
    let refs = 0;
    again.view.state.doc.descendants((node) => {
      if (node.type.name === "page_ref") refs += 1;
    });
    expect(refs).toBe(0);
  });

  it("is what the field writes too: hrefForWords maps a page address to the marker and leaves the web alone", () => {
    const origin = "http://brain.local";
    expect(hrefForWords("http://brain.local/p/abc123", origin)).toBe("/p/abc123#words");
    expect(hrefForWords("/p/abc123", origin)).toBe("/p/abc123#words");
    expect(hrefForWords("http://brain.local/p/abc123#words", origin)).toBe("/p/abc123#words");
    expect(hrefForWords("https://example.com/a", origin)).toBe("https://example.com/a");
    expect(hrefForWords("example.com", origin)).toBe("https://example.com");
    expect(hrefForWords("the spec", origin)).toBeNull();
  });
});

describe("what a paste takes (round 2, L4, M13, M14)", () => {
  it("takes Brain's own clipboard form <https://…> and a selection across two paragraphs", async () => {
    const { view, markdown } = await mount("one two\n\nthree four");
    select(view, "two");
    expect(paste(view, "<https://example.com/angle>")).toBe(true);
    expect(links(view)).toEqual([{ text: "two", href: "https://example.com/angle" }]);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, after(view, "three"))),
    );
    expect(paste(view, "https://example.com/across")).toBe(true);
    expect(markdown()).toBe(
      "[one](https://example.com/across) [two](https://example.com/across)\n\n[three](https://example.com/across) four",
    );
  });

  it("leaves words pasted over a selection alone: a file name is not an address", async () => {
    const { view } = await mount("some words here");
    select(view, "words");
    expect(pasteUrlOverSelection(view.state, "notes.txt")).toBeNull();
    expect(pasteUrlOverSelection(view.state, "readme.md")).toBeNull();
  });

  it("refuses an address with a space even where the URL parser would encode it", () => {
    expect(webHrefFromInput("https://example.com/x y")).toBeNull();
    expect(webHrefFromInput("www.example.com/x y")).toBeNull();
  });
});

describe("the link under the caret at a boundary (round 2, L2, M3, M4)", () => {
  it("belongs to the link the caret leaves, as typing there does, and to the next one at a line's start", async () => {
    const { view } = await mount(
      "[aaa](https://a.example)[bbb](https://b.example) tail [ccc](https://c.example)",
    );
    expect(linkRangeAt(view.state, after(view, "aaa"))?.href).toBe("https://a.example");
    expect(linkRangeAt(view.state, after(view, "bbb"))?.href).toBe("https://b.example");
    expect(linkRangeAt(view.state, after(view, "bb"))?.href).toBe("https://b.example");
    expect(linkRangeAt(view.state, 1)?.href).toBe("https://a.example");
    // A click lands at the start of a link that follows plain words.
    expect(linkRangeAt(view.state, after(view, "tail "))?.href).toBe("https://c.example");
    expect(linkRangeAt(view.state, after(view, "tai"))).toBeNull();
  });

  it("keeps the link's title through a rewrite of its address", async () => {
    const { view, markdown } = await mount('[word](https://a.example "The Title") tail');
    const range = linkRangeAt(view.state, after(view, "wo"))!;
    view.dispatch(setLinkHref(view.state, range, "https://b.example"));
    expect(markdown()).toBe('[word](https://b.example "The Title") tail');
  });
});

describe("a typed address, round 2 (L1, L3, M3, M5, M6, M20)", () => {
  it("is linked after the delimiters GFM allows, and not mid-word", async () => {
    const { view } = await mount("");
    type(
      view,
      "see (https://a.example) *https://b.example* _https://c.example_ ~https://d.example~ foo.https://e.example ",
    );
    expect(links(view).map((l) => l.href)).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
      "https://d.example",
    ]);
  });

  it("Backspace right after the space takes the link back out, as every input rule's does", async () => {
    const { view } = await mount("");
    type(view, "see https://a.example ");
    expect(links(view)).toHaveLength(1);
    expect(key(view, "Backspace")).toBe(true);
    expect(view.state.doc.textContent).toBe("see https://a.example");
    expect(links(view)).toEqual([]);
  });

  it("alone on its line, Enter draws the card a paste draws, with the caret on the line after", async () => {
    const typed = await mount("");
    type(typed.view, "https://a.example");
    expect(key(typed.view, "Enter")).toBe(true);
    const pasted = await mount("");
    paste(pasted.view, "https://a.example");
    expect(shape(typed.view)).toBe(shape(pasted.view));
    expect(shape(typed.view)).toContain("link_card");
    expect(typed.markdown()).toBe(pasted.markdown());
    expect(typed.view.state.selection.from).toBe(pasted.view.state.selection.from);

    // Without the card capability the address stays an inline link and
    // Enter splits the line as it always did.
    const plain = await mount("", false);
    type(plain.view, "https://a.example");
    expect(key(plain.view, "Enter")).toBe(false);
    expect(links(plain.view)).toEqual([{ text: "https://a.example", href: "https://a.example" }]);
  });

  it("does nothing inside inline code, and nothing for Enter with a modifier", async () => {
    const code = await mount("`code https://a.example` tail");
    caret(code.view, after(code.view, "a.example"));
    type(code.view, " ");
    expect(links(code.view)).toEqual([]);

    const { view } = await mount("see https://b.example");
    caret(view, after(view, "b.example"));
    expect(key(view, "Enter", { metaKey: true })).toBe(false);
    expect(links(view)).toEqual([]);
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
