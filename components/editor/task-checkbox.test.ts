// @vitest-environment jsdom

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
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

  it("gives a nested task its own control and leaves the parent's text alone", async () => {
    const view = await mountEditor("- [ ] parent\n  - [x] child\n");
    const boxes = view.dom.querySelectorAll<HTMLButtonElement>("button[role='checkbox']");
    expect(boxes).toHaveLength(2);
    boxes[1].click();
    expect(serialize(view)).toBe("* [ ] parent\n  * [ ] child\n");
  });

  it("keeps the item's text editable next to the control", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    expect(box(view).getAttribute("contenteditable")).toBe("false");
    expect(view.dom.textContent).toContain("water the plants");
  });
});
