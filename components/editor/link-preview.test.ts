// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx, serializerCtx } from "@milkdown/kit/core";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { Slice } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callout } from "./callout";
import { editingCore } from "./editing-core";
import { linkPreviewPlugin } from "./link-preview";
import { pageRef, setPageRefOrigin } from "./page-ref";

const URL_TEXT = "https://example.com/post";

type Mounted = { view: EditorView; markdown: () => string; destroy: () => Promise<void> };
const mounted: Mounted[] = [];

/** The editor's own stack, cut to the plugins a link card meets: the
 *  presets, the caret core, page refs (the internal links a card must not
 *  claim), callouts (a container a card may sit in), history and the
 *  clipboard, in the order `milkdown-editor.tsx` uses them. */
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
    .use(editingCore)
    .use(callout)
    .use(pageRef)
    .use(linkPreviewPlugin(unfurl))
    .use(history)
    .use(clipboard)
    .create();
  const view = editor.ctx.get(editorViewCtx);
  // The trailing paragraph is added on a microtask after mount.
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

function blockNames(view: EditorView) {
  const names: string[] = [];
  view.state.doc.forEach((node) => names.push(node.type.name));
  return names;
}

function key(view: EditorView, name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (handle) => handle(view, event)) ?? false;
}

function paste(view: EditorView, text: string) {
  const data = { getData: (type: string) => (type === "text/plain" ? text : "") };
  const event = { clipboardData: data, preventDefault() {} } as unknown as ClipboardEvent;
  return view.someProp("handlePaste", (handle) => handle(view, event, Slice.empty)) ?? false;
}

function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection;
  const insert = () => view.state.tr.insertText(text, from, to);
  const handled = view.someProp("handleTextInput", (handle) => handle(view, from, to, text, insert));
  if (!handled) view.dispatch(insert());
}

function caretAt(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

/** The position just inside the block at `index` of the document. */
function startOf(view: EditorView, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += view.state.doc.child(i).nodeSize;
  return pos + 1;
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ title: "Post", description: "A post" }), { status: 200 }),
  );
});

afterEach(async () => {
  for (const m of mounted.splice(0)) await m.destroy();
  vi.restoreAllMocks();
});

describe("link card: a URL alone on its line", () => {
  it("is a node of its own, drawn as the card, and stored as the same Markdown", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>`);
    expect(blockNames(view)).toEqual(["link_card", "paragraph"]);
    expect(view.dom.querySelectorAll(".brain-embed")).toHaveLength(1);
    // No hidden paragraph holding the URL text: nothing invisible to type into.
    expect(view.dom.querySelector(".brain-embed-source")).toBeNull();
    expect(markdown()).toBe(`<${URL_TEXT}>`);
  });

  it("opens every spelling of a bare link unchanged in the stored canonical form", async () => {
    for (const [input, expected] of [
      [URL_TEXT, `<${URL_TEXT}>`],
      [`<${URL_TEXT}>`, `<${URL_TEXT}>`],
      [`[${URL_TEXT}](${URL_TEXT})`, `<${URL_TEXT}>`],
      [`[${URL_TEXT}/](${URL_TEXT})`, `[${URL_TEXT}/](${URL_TEXT})`],
      [`[${URL_TEXT}](${URL_TEXT} "Title")`, `[${URL_TEXT}](${URL_TEXT} "Title")`],
    ]) {
      const { view, markdown } = await mount(`before\n\n${input}\n\nafter`);
      expect(blockNames(view), input).toEqual(["paragraph", "link_card", "paragraph"]);
      expect(markdown(), input).toBe(`before\n\n${expected}\n\nafter`);
    }
  });

  it("is a card inside a container and a later list paragraph, a link where a card cannot stand", async () => {
    const source = [
      `> ${URL_TEXT}`,
      "",
      `- ${URL_TEXT}`,
      "",
      `  ${URL_TEXT}`,
      "",
      ':::callout{icon="💡"}',
      URL_TEXT,
      ":::",
      "",
      `# ${URL_TEXT}`,
      "",
      `[Page](/p/abc123)`,
      "",
      `see ${URL_TEXT}`,
    ].join("\n");
    const { view, markdown } = await mount(source);
    const cards: string[] = [];
    view.state.doc.descendants((node, _pos, parent) => {
      if (node.type.name === "link_card") cards.push(parent?.type.name ?? "");
    });
    expect(cards).toEqual(["blockquote", "list_item", "callout"]);
    const again = await mount(markdown());
    expect(again.markdown()).toBe(markdown());
    expect(markdown()).toContain(`<${URL_TEXT}>`);
    expect(markdown()).toContain("[Page](/p/abc123)");
  });

  it("is no card at all without the unfurl capability, and asks nothing of /api/unfurl", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const { view, markdown } = await mount(`<${URL_TEXT}>`, false);
    expect(blockNames(view)[0]).toBe("paragraph");
    expect(view.dom.querySelector(".brain-embed")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(markdown()).toBe(`<${URL_TEXT}>`);
  });

  it("keeps a writable line after a card that ends the page", async () => {
    const { view } = await mount(`text\n\n<${URL_TEXT}>`);
    expect(blockNames(view)).toEqual(["paragraph", "link_card", "paragraph"]);
    expect(view.state.doc.lastChild?.content.size).toBe(0);
  });
});

describe("link card: pasting a URL", () => {
  it("on an empty line makes the card and leaves the caret on the line after it", async () => {
    const { view, markdown } = await mount("");
    caretAt(view, 1);
    expect(paste(view, URL_TEXT)).toBe(true);
    expect(blockNames(view)).toEqual(["link_card", "paragraph"]);
    expect(view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(view.state.selection.from).toBe(startOf(view, 1));
    type(view, "typed");
    expect(markdown()).toBe(`<${URL_TEXT}>\n\ntyped`);
  });

  it("then Enter opens a new line below the card, never above it", async () => {
    const { view, markdown } = await mount("");
    caretAt(view, 1);
    paste(view, URL_TEXT);
    key(view, "Enter");
    type(view, "next line");
    // The caret was already on the line after the card, so Enter adds a blank
    // line between them. What matters is where the words went: below.
    expect(blockNames(view)).toEqual(["link_card", "paragraph", "paragraph"]);
    expect(markdown().startsWith(`<${URL_TEXT}>`)).toBe(true);
    expect(markdown().endsWith("\n\nnext line")).toBe(true);
  });

  it("on an empty line above prose gives the caret a line of its own", async () => {
    const { view, markdown } = await mount("prose");
    view.dispatch(view.state.tr.insert(0, view.state.schema.nodes.paragraph.create()));
    caretAt(view, 1);
    paste(view, URL_TEXT);
    type(view, "x");
    expect(markdown()).toBe(`<${URL_TEXT}>\n\nx\n\nprose`);
  });

  it("mid-sentence stays an inline link in the sentence", async () => {
    const { view, markdown } = await mount("hello world");
    caretAt(view, 7);
    paste(view, URL_TEXT);
    expect(blockNames(view)).toEqual(["paragraph"]);
    expect(markdown()).toBe(`hello <${URL_TEXT}>world`);
  });

  it("over a selected card replaces its URL", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>`);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    paste(view, "https://example.org/other");
    expect(markdown()).toBe("<https://example.org/other>");
  });
});

describe("link card: the caret around it", () => {
  it("Enter on a selected card, even the page's first block, adds the line below it", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>\n\nafter`);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    expect(key(view, "Enter")).toBe(true);
    type(view, "between");
    expect(markdown()).toBe(`<${URL_TEXT}>\n\nbetween\n\nafter`);
  });

  it("Backspace from the line after opens the URL for editing, and leaving it draws the card again", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>\n\nafter`);
    caretAt(view, startOf(view, 1));
    expect(key(view, "Backspace")).toBe(true);
    expect(blockNames(view)).toEqual(["paragraph", "paragraph"]);
    expect(view.state.selection.from).toBe(1 + URL_TEXT.length);
    // Opening it changes nothing on disk.
    expect(markdown()).toBe(`<${URL_TEXT}>\n\nafter`);

    // The browser deletes characters in text on its own; this is that edit.
    const end = view.state.selection.from;
    view.dispatch(view.state.tr.delete(end - "post".length, end));
    type(view, "page");
    expect(markdown()).toBe("<https://example.com/page>\n\nafter");

    caretAt(view, view.state.doc.content.size - 1);
    expect(blockNames(view)).toEqual(["link_card", "paragraph"]);
    expect(markdown()).toBe("<https://example.com/page>\n\nafter");
  });

  it("Backspace on the empty line after the card removes that line on the way in", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>`);
    caretAt(view, startOf(view, 1));
    key(view, "Backspace");
    expect(blockNames(view)).toEqual(["paragraph"]);
    expect(view.state.selection.from).toBe(1 + URL_TEXT.length);
    expect(markdown()).toBe(`<${URL_TEXT}>`);
  });

  it("a selected card is deleted by Backspace", async () => {
    const { view, markdown } = await mount(`before\n\n<${URL_TEXT}>\n\nafter`);
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, startOf(view, 1) - 1)),
    );
    key(view, "Backspace");
    expect(markdown()).toBe("before\n\nafter");
  });

  it("typing above a card does not redraw it", async () => {
    const { view } = await mount(`top\n\n<${URL_TEXT}>\n\nbottom`);
    const before = view.dom.querySelector(".brain-embed");
    expect(before).not.toBeNull();
    caretAt(view, 2);
    type(view, "y");
    expect(view.dom.querySelector(".brain-embed")).toBe(before);
  });
});

describe("a click below the last block", () => {
  it("puts the caret on the writable line after a card that ends the page", async () => {
    const { view } = await mount(`<${URL_TEXT}>`);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, 0)));
    const bottom = view.dom.getBoundingClientRect().bottom;
    document.body.dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, clientY: bottom + 40 }),
    );
    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.from).toBe(startOf(view, 1));
  });
});

describe("link card: pasting several lines", () => {
  // The clipboard plugin carries pasted Markdown through the schema's DOM,
  // so this is also the card's toDOM read back by its parseDOM.
  it("reads a URL line among them as a card", async () => {
    const { view, markdown } = await mount("");
    caretAt(view, 1);
    paste(view, `intro\n\n${URL_TEXT}\n\noutro`);
    expect(blockNames(view).slice(0, 3)).toEqual(["paragraph", "link_card", "paragraph"]);
    expect(markdown()).toBe(`intro\n\n<${URL_TEXT}>\n\noutro`);
  });
});

describe("link card: words typed after an opened URL", () => {
  it("stay visible words: a line with a space is never a card, and its href is never the words", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>\n\nnext`);
    caretAt(view, startOf(view, 1));
    key(view, "Backspace");
    type(view, " see this");
    caretAt(view, view.state.doc.content.size - 1);
    expect(blockNames(view)).toEqual(["paragraph", "paragraph"]);
    expect(view.state.doc.firstChild?.textContent).toBe(`${URL_TEXT} see this`);
    expect(markdown()).not.toContain("see%20this");
    expect(markdown()).not.toContain("<https://example.com/post see this>");
    const again = await mount(markdown());
    expect(blockNames(again.view)[0]).toBe("paragraph");
    expect(again.view.dom.textContent).toContain("see this");
  });

  it("a stored link whose text and href hold a space opens as a link, not a card", async () => {
    const { view } = await mount(
      "[https://example.com/post see this](<https://example.com/post see this>)\n\nnext",
    );
    expect(blockNames(view)[0]).toBe("paragraph");
    expect(view.dom.querySelector(".brain-embed")).toBeNull();
    expect(view.dom.textContent).toContain("see this");
  });

  it("a pasted URL with a space in it is not a card", async () => {
    const { view } = await mount("");
    caretAt(view, 1);
    paste(view, "https://example.com/a b");
    expect(view.dom.querySelector(".brain-embed")).toBeNull();
  });
});

describe("link card: an opened URL edited through an IME", () => {
  function openAfterCard(view: EditorView) {
    caretAt(view, startOf(view, 1));
    key(view, "Backspace");
  }

  function compose(view: EditorView, text: string, from: number, to = from) {
    const tr = view.state.tr.insertText(text, from, to).setMeta("composition", 1);
    view.dispatch(tr);
  }

  function hrefOfFirstLine(view: EditorView) {
    const child = view.state.doc.firstChild?.firstChild;
    const mark = child?.marks.find((m) => m.type.name === "link");
    return mark?.attrs.href;
  }

  it("leaving the line draws the card for the text that is there", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>\n\nnext`);
    openAfterCard(view);
    compose(view, "/x", view.state.selection.from);
    caretAt(view, view.state.doc.content.size - 1);
    expect(blockNames(view)).toEqual(["link_card", "paragraph"]);
    expect(markdown()).toBe(`<${URL_TEXT}/x>\n\nnext`);
  });

  it("a host replaced by composition is the host saved, never the old one", async () => {
    const { view, markdown } = await mount(`<${URL_TEXT}>\n\nnext`);
    openAfterCard(view);
    const start = 1 + "https://".length;
    compose(view, "evil", start, start + "example".length);
    caretAt(view, view.state.doc.content.size - 1);
    expect(markdown()).toBe("<https://evil.com/post>\n\nnext");
  });

  it("the caret moving after the composition ends brings the href up to the text", async () => {
    const { view } = await mount(`<${URL_TEXT}>\n\nnext`);
    openAfterCard(view);
    compose(view, "/x", view.state.selection.from);
    expect(hrefOfFirstLine(view)).toBe(URL_TEXT);
    caretAt(view, 3);
    expect(hrefOfFirstLine(view)).toBe(`${URL_TEXT}/x`);
  });
});

describe("link card: Backspace and leaving, at the edges", () => {
  it("Backspace inside the line after a card deletes a character, the card stays", async () => {
    const { view } = await mount(`<${URL_TEXT}>\n\nafter`);
    caretAt(view, startOf(view, 1) + 2);
    expect(key(view, "Backspace")).toBe(false);
    expect(blockNames(view)).toEqual(["link_card", "paragraph"]);
  });

  it("opening and leaving a trailing-slash card without an edit keeps its spelling", async () => {
    const source = "[https://example.com/a/](https://example.com/a)\n\nnext";
    const { view, markdown } = await mount(source);
    caretAt(view, startOf(view, 1));
    key(view, "Backspace");
    caretAt(view, view.state.doc.content.size - 1);
    expect(blockNames(view)).toEqual(["link_card", "paragraph"]);
    expect(markdown()).toBe(source);
  });

  it("editing a titled card keeps its title", async () => {
    const { view, markdown } = await mount(`[${URL_TEXT}](${URL_TEXT} "Title")\n\nnext`);
    caretAt(view, startOf(view, 1));
    key(view, "Backspace");
    type(view, "/x");
    caretAt(view, view.state.doc.content.size - 1);
    expect(markdown()).toBe(`[${URL_TEXT}/x](${URL_TEXT}/x "Title")\n\nnext`);
  });
});
