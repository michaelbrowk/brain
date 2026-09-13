// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { getMarkdown } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it } from "vitest";

import { taskCheckbox } from "./task-checkbox";

const editors = new WeakMap<EditorView, Editor>();
const open: Editor[] = [];

/** Mount the real editor on the real preset stack. The NodeView is only worth
 *  testing against the schema it attaches to, so nothing here is a stub. */
async function mountEditor(markdown: string): Promise<EditorView> {
  const root = document.createElement("div");
  document.body.append(root);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(gfm)
    .use(taskCheckbox)
    .create();
  open.push(editor);
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  editors.set(view, editor);
  return view;
}

function serialize(view: EditorView): string {
  return editors.get(view)!.action(getMarkdown());
}

function box(view: EditorView): HTMLButtonElement {
  return view.dom.querySelector<HTMLButtonElement>("button[role='checkbox']")!;
}

function boxes(view: EditorView): HTMLButtonElement[] {
  return [...view.dom.querySelectorAll<HTMLButtonElement>("button[role='checkbox']")];
}

/** Put the caret at the end of the nth paragraph and press Enter through the
 *  editor's own keymap, so the test exercises the binding and not a command. */
function enterAtEndOfLine(view: EditorView, index: number) {
  const starts: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph") starts.push(pos + 1 + node.content.size);
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, starts[index])));
  view.someProp("handleKeyDown", (handler) =>
    handler(view, new KeyboardEvent("keydown", { key: "Enter" })),
  );
}

afterEach(async () => {
  while (open.length) await open.pop()!.destroy();
  document.body.replaceChildren();
});

describe("the note checkbox", () => {
  it("renders a button with role checkbox and aria-checked for a task list item", async () => {
    const view = await mountEditor("- [ ] water the plants\n- [x] call the bank\n");
    const boxes = view.dom.querySelectorAll<HTMLButtonElement>("button[role='checkbox']");
    expect(boxes).toHaveLength(2);
    expect(boxes[0].getAttribute("aria-checked")).toBe("false");
    expect(boxes[1].getAttribute("aria-checked")).toBe("true");
  });

  it("toggles the document, not only the DOM", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    box(view).click();
    expect(serialize(view)).toBe("* [x] water the plants\n");
    expect(box(view).getAttribute("aria-checked")).toBe("true");
  });

  it("toggles back to unchecked on a second press", async () => {
    const view = await mountEditor("- [x] water the plants\n");
    box(view).click();
    expect(serialize(view)).toBe("* [ ] water the plants\n");
  });

  it("renders no input element anywhere in the editor", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    expect(view.dom.querySelector("input")).toBeNull();
  });

  it("leaves a plain bullet alone", async () => {
    const view = await mountEditor("- water the plants\n");
    expect(view.dom.querySelector("button[role='checkbox']")).toBeNull();
    expect(view.dom.querySelector("li")?.hasAttribute("data-checked")).toBe(false);
  });

  it("is reachable from the keyboard and toggles on Space", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    const button = box(view);
    expect(button.tabIndex).toBe(0);
    button.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(serialize(view)).toBe("* [x] water the plants\n");
  });

  it("says what is being ticked rather than the word checkbox", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    expect(box(view).getAttribute("aria-label")).toBe("water the plants");
  });

  it("gives a nested task its own control and ticks only the one pressed", async () => {
    const view = await mountEditor("- [ ] parent\n  - [x] child\n");
    expect(boxes(view)).toHaveLength(2);
    boxes(view)[1].click();
    expect(serialize(view)).toBe("* [ ] parent\n  * [ ] child\n");
  });

  it("labels a parent with its own line, not with its children", async () => {
    const view = await mountEditor("- [ ] water the plants\n  - [x] fill the can\n  - [ ] open the window\n");
    const [parent, child] = boxes(view);
    expect(parent.getAttribute("aria-label")).toBe("water the plants");
    expect(parent.getAttribute("aria-label")).not.toContain("fill the can");
    expect(parent.getAttribute("aria-label")).not.toContain("open the window");
    expect(child.getAttribute("aria-label")).toBe("fill the can");
  });

  it("labels an item with more than one block with its first line only", async () => {
    const view = await mountEditor("- [ ] first line\n\n  second paragraph\n");
    expect(box(view).getAttribute("aria-label")).toBe("first line");
  });

  it("splits a done task into a task that is not done", async () => {
    const view = await mountEditor("- [x] call the bank\n");
    enterAtEndOfLine(view, 0);
    expect(serialize(view)).toBe("* [x] call the bank\n\n* [ ] <br />\n");
    expect(boxes(view).map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  // Split inside one word, so the seam carries no space for the serializer to
  // escape and the assertion is about the attribute and nothing else.
  it("splits a done task from the middle without carrying the tick across", async () => {
    const view = await mountEditor("- [x] paperwork\n");
    let lineStart = -1;
    view.state.doc.descendants((node, pos) => {
      if (lineStart < 0 && node.type.name === "paragraph") lineStart = pos + 1;
    });
    const caret = lineStart + "paper".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)));
    view.someProp("handleKeyDown", (handler) =>
      handler(view, new KeyboardEvent("keydown", { key: "Enter" })),
    );
    expect(serialize(view)).toBe("* [x] paper\n\n* [ ] work\n");
  });

  it("leaves the preset's Enter alone on an unchecked task and on a plain bullet", async () => {
    const task = await mountEditor("- [ ] one\n");
    enterAtEndOfLine(task, 0);
    expect(serialize(task)).toBe("* [ ] one\n\n* [ ] <br />\n");

    const bullet = await mountEditor("- one\n");
    enterAtEndOfLine(bullet, 0);
    expect(serialize(bullet)).toBe("* one\n\n* <br />\n");
    expect(bullet.dom.querySelector("button[role='checkbox']")).toBeNull();
  });

  it("keeps the item's text editable next to the control", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    expect(box(view).getAttribute("contenteditable")).toBe("false");
    expect(view.dom.textContent).toContain("water the plants");
  });
});
