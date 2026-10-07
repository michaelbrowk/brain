// @vitest-environment jsdom

import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark, syncHeadingIdPlugin } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener } from "@milkdown/kit/plugin/listener";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { afterEach, describe, expect, it } from "vitest";
import { callout, insertCalloutCommand } from "./callout";
import { columns } from "./columns";
import { editingCore } from "./editing-core";
import { emptyBlocks } from "./empty-block";
import { insertToggleCommand, toggle, toggleMemoryCtx } from "./toggle";

const editors: Editor[] = [];

afterEach(async () => {
  for (const editor of editors.splice(0)) await editor.destroy();
  document.body.replaceChildren();
  localStorage.clear();
});

/** The editor's own plugin stack for these two blocks, in the order
 *  `milkdown-editor.tsx` applies it. */
async function mount(markdown: string, memoryKey = "") {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
      ctx.set(toggleMemoryCtx.key, memoryKey);
    })
    .use(commonmark.filter((plugin) => plugin !== syncHeadingIdPlugin))
    .use(gfm)
    .use(editingCore)
    .use(columns)
    .use(emptyBlocks)
    .use(callout)
    .use(toggle)
    .use(history)
    .use(listener)
    .create();
  editors.push(editor);
  const view = editor.ctx.get(editorViewCtx) as EditorView;
  const serialize = () => editor.ctx.get(serializerCtx)(view.state.doc).trimEnd();
  return { editor, view, root, serialize };
}

/** The line the slash menu leaves behind: "/callout" already deleted, the
 *  caret on an empty paragraph after some text. */
async function mountAtEmptyLine() {
  const mounted = await mount("Before");
  const { view } = mounted;
  const tr = view.state.tr.insert(
    view.state.doc.content.size,
    view.state.schema.nodes.paragraph.create(),
  );
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)));
  return mounted;
}

function type(view: EditorView, text: string) {
  const { from, to } = view.state.selection;
  const handled = view.someProp("handleTextInput", (f) => f(view, from, to, text, () => view.state.tr.insertText(text, from, to)));
  if (!handled) view.dispatch(view.state.tr.insertText(text));
}

function press(view: EditorView, key: string) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  return view.someProp("handleKeyDown", (f) => f(view, event)) ?? false;
}

/** The browser fires a details element's `toggle` event in a task of its own. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function caretParent(view: EditorView) {
  return view.state.selection.$from.parent.type.name;
}

describe("inserting a callout", () => {
  it("leaves an empty line with the caret in it, so typing is the body", async () => {
    const { editor, view, serialize } = await mountAtEmptyLine();
    editor.ctx.get(commandsCtx).call(insertCalloutCommand.key);

    expect(caretParent(view)).toBe("paragraph");
    expect(view.state.selection.$from.node(-1).type.name).toBe("callout");
    expect(view.state.selection.$from.parent.content.size).toBe(0);

    type(view, "note body");
    expect(serialize()).toBe('Before\n\n:::callout{icon="💡"}\nnote body\n:::');
  });

  it("shows the hint on the empty line instead of writing a word into it", async () => {
    const { editor, view, root } = await mountAtEmptyLine();
    editor.ctx.get(commandsCtx).call(insertCalloutCommand.key);
    const line = root.querySelector(".brain-callout-content > p");
    expect(line?.textContent).toBe("");
    expect(line?.classList.contains("brain-slash-hint")).toBe(true);
    expect(view.state.doc.textContent).toBe("Before");
  });
});

describe("inserting a toggle", () => {
  it("puts the caret in the title, and Enter moves it into the body", async () => {
    const { editor, view, serialize } = await mountAtEmptyLine();
    editor.ctx.get(commandsCtx).call(insertToggleCommand.key);

    expect(caretParent(view)).toBe("toggle_summary");
    type(view, "Summary");
    expect(press(view, "Enter")).toBe(true);
    expect(caretParent(view)).toBe("paragraph");
    expect(view.state.selection.$from.node(-1).type.name).toBe("toggle");
    type(view, "body");

    expect(serialize()).toBe('Before\n\n:::toggle{summary="Summary"}\nbody\n:::');
    expect(view.state.doc.textContent).toBe("BeforeSummarybody");
  });

  it("refuses the browser's own split of the title, as iOS sends it", async () => {
    const { editor, view, serialize } = await mountAtEmptyLine();
    editor.ctx.get(commandsCtx).call(insertToggleCommand.key);
    type(view, "Summary");

    const split = new InputEvent("beforeinput", {
      inputType: "insertParagraph",
      bubbles: true,
      cancelable: true,
    });
    view.dom.dispatchEvent(split);
    expect(split.defaultPrevented).toBe(true);
    expect(caretParent(view)).toBe("paragraph");
    // ProseMirror's replay of the held-back iOS Enter changes nothing
    const doc = view.state.doc;
    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc).toBe(doc);
    type(view, "body");
    expect(serialize()).toBe('Before\n\n:::toggle{summary="Summary"}\nbody\n:::');
  });

  it("draws the title placeholder without putting it in the file", async () => {
    const { editor, root, serialize } = await mountAtEmptyLine();
    editor.ctx.get(commandsCtx).call(insertToggleCommand.key);
    const title = root.querySelector(".brain-toggle-summary");
    expect(title?.textContent).toBe("");
    expect(root.querySelector(".brain-toggle-head")?.classList.contains("is-empty")).toBe(true);
    expect(serialize()).not.toContain("Toggle");
    expect(serialize()).not.toContain("Hidden content");
  });

  it("keeps an untitled toggle untitled across a reload", async () => {
    const { editor, serialize } = await mountAtEmptyLine();
    editor.ctx.get(commandsCtx).call(insertToggleCommand.key);
    const saved = serialize();
    expect(saved).toContain(":::toggle{summary}");
    const reopened = await mount(saved);
    expect(reopened.view.state.doc.child(1).firstChild?.textContent).toBe("");
    expect(reopened.serialize()).toBe(saved);
  });
});

describe("the toggle title", () => {
  it("is text the writer edits, and the edit is saved", async () => {
    const { view, root, serialize } = await mount(':::toggle{summary="Details"}\nHidden\n:::');
    const title = root.querySelector(".brain-toggle-summary");
    expect(title?.textContent).toBe("Details");
    expect(title?.closest("[contenteditable='false']")).toBeNull();

    // the end of the title: toggle opens at 0, the title's text starts at 2
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2 + "Details".length)));
    type(view, " and more");
    expect(serialize()).toBe(':::toggle{summary="Details and more"}\nHidden\n:::');
  });

  it("opens existing notes exactly as they were written", async () => {
    for (const markdown of [
      ':::toggle{summary="Details"}\nHidden\n:::',
      ':::toggle{summary="Two words"}\nFirst\n\nSecond\n:::',
      '::::toggle{summary="Outer"}\n:::callout{icon="💡"}\nIn\n:::\n::::',
    ]) {
      const { serialize } = await mount(markdown);
      expect(serialize()).toBe(markdown);
    }
  });

  it("keeps the old default title for a toggle written without one", async () => {
    const { root, serialize } = await mount(":::toggle\nx\n:::");
    expect(root.querySelector(".brain-toggle-summary")?.textContent).toBe("Toggle");
    expect(serialize()).toBe(':::toggle{summary="Toggle"}\nx\n:::');
  });

  it("does not open the slash menu's block conversions inside the title", async () => {
    const { root } = await mount(':::toggle{summary="Details"}\nHidden\n:::');
    // the slash menu only reads a paragraph, and the title is not one
    expect(root.querySelector(".brain-toggle-summary")?.closest("p")).toBeNull();
  });
});

describe("the toggle's open state", () => {
  it("survives a remount of the same page", async () => {
    const markdown = ':::toggle{summary="A"}\nx\n:::\n\n:::toggle{summary="B"}\ny\n:::';
    const first = await mount(markdown, "page-1");
    const toggles = first.root.querySelectorAll<HTMLDetailsElement>("details.brain-toggle");
    expect([...toggles].map((t) => t.open)).toEqual([true, true]);

    toggles[1].querySelector<HTMLButtonElement>(".brain-toggle-arrow")!.click();
    await settle();
    expect(toggles[1].open).toBe(false);
    expect(first.serialize()).toBe(markdown);

    const second = await mount(markdown, "page-1");
    const again = second.root.querySelectorAll<HTMLDetailsElement>("details.brain-toggle");
    expect([...again].map((t) => t.open)).toEqual([true, false]);

    const otherPage = await mount(markdown, "page-2");
    const other = otherPage.root.querySelectorAll<HTMLDetailsElement>("details.brain-toggle");
    expect([...other].map((t) => t.open)).toEqual([true, true]);
  });

  it("is never a change to the document", async () => {
    const { view, root } = await mount(':::toggle{summary="A"}\nx\n:::', "page-1");
    const before = view.state.doc;
    root.querySelector<HTMLButtonElement>(".brain-toggle-arrow")!.click();
    await settle();
    expect(view.state.doc).toBe(before);
  });

  it("follows the toggle when its title is renamed", async () => {
    const markdown = ':::toggle{summary="A"}\nx\n:::';
    const first = await mount(markdown, "page-1");
    first.root.querySelector<HTMLButtonElement>(".brain-toggle-arrow")!.click();
    await settle();
    first.view.dispatch(first.view.state.tr.setSelection(TextSelection.create(first.view.state.doc, 3)));
    type(first.view, "2");
    const renamed = first.serialize();
    expect(renamed).toBe(':::toggle{summary="A2"}\nx\n:::');

    const second = await mount(renamed, "page-1");
    expect(second.root.querySelector<HTMLDetailsElement>("details.brain-toggle")!.open).toBe(false);
  });
});

describe("a callout and a toggle nested in each other", () => {
  it("round-trips from the editor without a stray fence", async () => {
    const { editor, view, serialize } = await mountAtEmptyLine();
    const commands = editor.ctx.get(commandsCtx);
    commands.call(insertToggleCommand.key);
    type(view, "Outer");
    press(view, "Enter");
    commands.call(insertCalloutCommand.key);
    type(view, "In");
    const saved = serialize();
    expect(saved).toBe('Before\n\n::::toggle{summary="Outer"}\n:::callout{icon="💡"}\nIn\n:::\n::::');
    const reopened = await mount(saved);
    expect(reopened.view.state.doc.toString()).toBe(view.state.doc.toString());
    expect(reopened.serialize()).toBe(saved);
  });

  it("reads fences of one length as the nesting the writer meant", async () => {
    const cases: Array<[string, string]> = [
      [
        ':::toggle{summary="Outer"}\n:::callout{icon="💡"}\nIn\n:::\n:::',
        '::::toggle{summary="Outer"}\n:::callout{icon="💡"}\nIn\n:::\n::::',
      ],
      [
        ':::callout{icon="💡"}\n:::toggle{summary="T"}\nx\n:::\n:::',
        '::::callout{icon="💡"}\n:::toggle{summary="T"}\nx\n:::\n::::',
      ],
      [
        ':::toggle{summary="Outer"}\n:::callout{icon="💡"}\nIn\n:::\nafter\n:::\n\nnext',
        '::::toggle{summary="Outer"}\n:::callout{icon="💡"}\nIn\n:::\n\nafter\n::::\n\nnext',
      ],
    ];
    for (const [written, expected] of cases) {
      const { serialize } = await mount(written);
      const saved = serialize();
      expect(saved).not.toContain("\\:::");
      expect(saved).toBe(expected);
      expect((await mount(saved)).serialize()).toBe(saved);
    }
  });
});
