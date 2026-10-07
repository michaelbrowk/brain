// @vitest-environment jsdom

import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { tableBlock } from "@milkdown/kit/component/table-block";
import { clipboard } from "@milkdown/kit/plugin/clipboard";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentLink } from "./attachments";
import { attachmentRefs } from "./attachment-refs";
import { callout } from "./callout";
import { columns, insertColumnsCommand } from "./columns";
import { editingCore } from "./editing-core";
import { emptyBlocks } from "./empty-block";
import { images } from "./image";
import { insertImage, insertInline, linkSelection } from "./insert-inline";
import { linkPreviewPlugin } from "./link-preview";
import { normalizeLegacy } from "./normalize";
import { createPageRef, pageRef, setPageRefOrigin, syncLivePageInfo } from "./page-ref";
import { slashMenuItems, slashQuery, visibleSlashItems } from "./slash-menu";
import { noNestedTables } from "./table-guard";
import { tableCells } from "./table-cell";
import { taskCheckboxMarkdown } from "./task-checkbox";
import { toggle } from "./toggle";

const ORIGIN = "https://brain.example";
/** A title with every character Markdown would read as syntax in a label. */
const TITLE = "Notes *draft* a]b [c] _d_ `e`";
const PAGE = { id: "abc123", title: TITLE };

/** The editor's own plugin order for everything an inline insertion meets. */
async function mount(markdown: string) {
  setPageRefOrigin(ORIGIN);
  syncLivePageInfo([PAGE, { id: "plain", title: "Plain" }]);
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

/** The position just after the first occurrence of `text` in a text node. */
function after(doc: ProseNode, text: string) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text) + text.length;
    }
    return true;
  });
  if (found < 0) throw new Error(`no text ${text}`);
  return found;
}

function caret(view: EditorView, pos: number) {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
}

function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f) =>
    f(view, from, to, text, () => view.state.tr.insertText(text, from, to)),
  );
  if (!handled) view.dispatch(view.state.tr.insertText(text, from, to));
}

function press(view: EditorView, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

function count(doc: ProseNode, name: string) {
  let found = 0;
  doc.descendants((node) => {
    if (node.type.name === name) found += 1;
  });
  return found;
}

/** Saved, opened again, saved again: the same bytes, and a ref still a ref. */
async function reopen(markdown: string) {
  const again = await mount(markdown);
  try {
    return { markdown: again.markdownNow(), refs: count(again.view.state.doc, "page_ref"), doc: again.view.state.doc };
  } finally {
    await again.editor.destroy();
  }
}

afterEach(() => {
  syncLivePageInfo();
  setPageRefOrigin("");
  document.body.replaceChildren();
});

const REF = String.raw`[📄 Notes \*draft\* a\]b \[c\] \_d\_ \`e\`](/p/abc123)`;

/** Each place a sentence can stand, with "alpha HERE omega" in it. */
const PLACES: Array<[string, string, (line: string) => string]> = [
  ["a paragraph", "paragraph", (line) => line],
  ["a heading", "heading", (line) => `## ${line}`],
  ["a list item", "list_item", (line) => `* ${line}`],
  ["a quote", "blockquote", (line) => `> ${line}`],
  ["a callout", "callout", (line) => `:::callout{icon="💡"}\n${line}\n:::`],
  ["a toggle's body", "toggle", (line) => `:::toggle{summary="S"}\n${line}\n:::`],
  ["a column", "col", (line) => `::::cols\n:::col\n${line}\n:::\n\n:::col\nR\n:::\n::::`],
  ["a table cell", "table_cell", (line) => `| h |\n| - |\n| ${line} |`],
];

describe("a page ref placed at the caret", () => {
  for (const [name, container, wrap] of PLACES) {
    it(`stays in the line in ${name}, and the file reads it back`, async () => {
      const { editor, view, markdownNow } = await mount(wrap("alpha HERE omega"));
      try {
        const blocksBefore = view.state.doc.childCount;
        const containers = count(view.state.doc, container);
        caret(view, after(view.state.doc, "HERE"));
        const tr = insertInline(view.state, createPageRef(view.state.schema, PAGE));
        expect(tr).not.toBeNull();
        view.dispatch(tr!);
        type(view, "!");

        expect(view.state.doc.childCount).toBe(blocksBefore);
        expect(count(view.state.doc, container)).toBe(containers);
        const saved = markdownNow();
        expect(saved).toContain(`alpha HERE${REF}! omega`);
        const back = await reopen(saved);
        expect(back.markdown).toBe(saved);
        expect(back.refs).toBe(1);
      } finally {
        await editor.destroy();
      }
    });
  }

  it("replaces the [[query it was picked from, and one undo takes it back out", async () => {
    const { editor, view, markdownNow } = await mount("alpha [[Not omega");
    try {
      const to = after(view.state.doc, "[[Not");
      caret(view, to);
      const before = view.state.doc;
      view.dispatch(insertInline(view.state, createPageRef(view.state.schema, PAGE), { from: to - 5, to })!);
      expect(markdownNow()).toBe(`alpha ${REF} omega`);

      undo(view.state, view.dispatch);
      expect(view.state.doc.eq(before)).toBe(true);
    } finally {
      await editor.destroy();
    }
  });

  it("on an empty line is a row, and the caret goes to a line after it", async () => {
    const { editor, view, markdownNow } = await mount("Intro\n\nOutro");
    try {
      caret(view, after(view.state.doc, "Intro"));
      press(view, "Enter");
      view.dispatch(insertInline(view.state, createPageRef(view.state.schema, PAGE))!);
      expect(markdownNow()).toBe(`Intro\n\n${REF}\n\n<br />\n\nOutro`);
      type(view, "next");

      expect(markdownNow()).toBe(`Intro\n\n${REF}\n\nnext\n\nOutro`);
      const back = await reopen(markdownNow());
      expect(back.refs).toBe(1);
    } finally {
      await editor.destroy();
    }
  });

  it("alone in a cell is followed by a space the next words go after", async () => {
    const { editor, view, markdownNow } = await mount("| h |\n| - |\n| x |");
    try {
      const pos = after(view.state.doc, "x");
      view.dispatch(
        insertInline(view.state, createPageRef(view.state.schema, PAGE), { from: pos - 1, to: pos })!,
      );
      type(view, "tail");
      expect(count(view.state.doc, "table")).toBe(1);
      expect(markdownNow()).toContain(`| ${REF} tail |`);
    } finally {
      await editor.destroy();
    }
  });

  it("is refused where the line holds only text, and nothing changes", async () => {
    const { editor, view } = await mount("```\ncode\n```");
    try {
      caret(view, after(view.state.doc, "co"));
      expect(insertInline(view.state, createPageRef(view.state.schema, PAGE))).toBeNull();
    } finally {
      await editor.destroy();
    }
  });
});

describe("Link to page over selected words", () => {
  it("links the words and keeps them, through a save and an open", async () => {
    const { editor, view, markdownNow } = await mount("read the spec today");
    try {
      const to = after(view.state.doc, "the spec");
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, to - "the spec".length, to)),
      );
      view.dispatch(linkSelection(view.state, "/p/abc123")!);
      expect(markdownNow()).toBe("read [the spec](/p/abc123) today");

      const back = await reopen(markdownNow());
      expect(back.markdown).toBe("read [the spec](/p/abc123) today");
      expect(back.refs).toBe(0);
      expect(back.doc.textContent).toBe("read the spec today");
    } finally {
      await editor.destroy();
    }
  });
});

describe("which page links read as refs", () => {
  it("a row, the serializer's label and the current title are refs; other words stay words", async () => {
    const back = await reopen(
      [
        "[Stale row](/p/plain)",
        "see [📄 Old title](/p/plain) here",
        "see [Plain](/p/plain) here",
        "see [the plan](/p/plain) here",
      ].join("\n\n"),
    );
    expect(back.refs).toBe(3);
    expect(back.markdown).toBe(
      [
        "[📄 Plain](/p/plain)",
        "see [📄 Plain](/p/plain) here",
        "see [📄 Plain](/p/plain) here",
        "see [the plan](/p/plain) here",
      ].join("\n\n"),
    );
  });
});

describe("Enter on a page row", () => {
  it("with the caret before the ref writes on a line below the row", async () => {
    const { editor, view, markdownNow } = await mount(`Intro\n\n${REF}\n\nOutro`);
    try {
      let rowStart = -1;
      view.state.doc.forEach((node, offset) => {
        if (node.firstChild?.type.name === "page_ref") rowStart = offset + 1;
      });
      caret(view, rowStart);
      expect(press(view, "Enter")).toBe(true);
      type(view, "below");
      expect(markdownNow()).toBe(`Intro\n\n${REF}\n\nbelow\n\nOutro`);
    } finally {
      await editor.destroy();
    }
  });
});

describe("an image from the picker", () => {
  it("replaces the empty line and leaves the caret on the line after it", async () => {
    const { editor, view, markdownNow } = await mount("first\n\nlast");
    try {
      caret(view, after(view.state.doc, "first"));
      press(view, "Enter");
      view.dispatch(insertImage(view.state, { src: "/_attachments/a.png" })!);
      // The empty line the caret waits on is a line the page shows, and the
      // file keeps it the way it keeps every empty line between blocks.
      expect(markdownNow()).toBe("first\n\n![](/_attachments/a.png)\n\n<br />\n\nlast");
      expect((await reopen(markdownNow())).markdown).toBe(markdownNow());
      type(view, "after");

      expect(count(view.state.doc, "brain_image")).toBe(1);
      expect(markdownNow()).toBe("first\n\n![](/_attachments/a.png)\n\nafter\n\nlast");
      expect((await reopen(markdownNow())).markdown).toBe(markdownNow());
    } finally {
      await editor.destroy();
    }
  });

  it("in a table cell is an inline image in that cell", async () => {
    const { editor, view, markdownNow } = await mount("| h |\n| - |\n| x |");
    try {
      caret(view, after(view.state.doc, "x"));
      view.dispatch(insertImage(view.state, { src: "/_attachments/a.png" })!);
      expect(count(view.state.doc, "table")).toBe(1);
      expect(markdownNow()).toContain("| x![](/_attachments/a.png) |");
    } finally {
      await editor.destroy();
    }
  });
});

describe("an attachment from the picker", () => {
  it("goes where the caret is, and the next words are not part of its name", async () => {
    const { editor, view, markdownNow } = await mount("alpha  omega");
    try {
      caret(view, after(view.state.doc, "alpha "));
      const file = { url: "/_attachments/x.pdf", name: "a]b *c*.pdf" };
      view.dispatch(insertInline(view.state, attachmentLink(view.state.schema, file))!);
      type(view, " more");

      expect(view.state.doc.childCount).toBe(1);
      const saved = markdownNow();
      expect(saved).toBe(String.raw`alpha [📎 a\]b \*c\*.pdf](/_attachments/x.pdf) more omega`);
      expect((await reopen(saved)).markdown).toBe(saved);
    } finally {
      await editor.destroy();
    }
  });
});

describe("the slash menu", () => {
  it("reads a query in any script", () => {
    expect(slashQuery("/фото")).toBe("фото");
    expect(slashQuery("/image")).toBe("image");
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/two words")).toBeNull();
    expect(slashQuery("text /x")).toBeNull();
    const items = visibleSlashItems(slashMenuItems({ upload: {} }), {
      query: "фото",
      inTable: false,
      inQuote: false,
    });
    expect(items.map((item) => item.label)).toEqual(["Image"]);
  });

  it("puts columns in place of the empty line with the caret in the left one", async () => {
    const { editor, view, markdownNow } = await mount("first");
    try {
      caret(view, after(view.state.doc, "first"));
      press(view, "Enter");
      editor.action((ctx) => ctx.get(commandsCtx).call(insertColumnsCommand.key));
      type(view, "left");
      expect(view.state.selection.$from.node(-1).type.name).toBe("col");
      expect(view.state.selection.$from.index(-2)).toBe(0);
      expect(markdownNow()).toMatch(/^first\n\n::::cols\n:::col\nleft\n:::\n/);
    } finally {
      await editor.destroy();
    }
  });
});
