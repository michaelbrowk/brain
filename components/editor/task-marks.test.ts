// @vitest-environment jsdom

/** The task marks' fast path (`task-checkbox.ts`, the promote plugin's
 *  `apply`): a transaction that touches no task line maps the marks instead
 *  of rebuilding them from every item. Mapped must equal rebuilt, in every
 *  shape a page takes while it is typed into. */

import { TextSelection } from "@milkdown/kit/prose/state";
import type { DecorationSet } from "@milkdown/kit/prose/view";
import { redo, undo } from "@milkdown/kit/prose/history";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountFullStack, type MountedStack } from "./editor-stack.harness";
import { setPageRefOrigin, syncLivePageInfo } from "./page-ref";
import { promoteKey } from "./task-checkbox";

/** Every mark as position and key, which is what the view draws from. */
function marks(set: DecorationSet): string[] {
  return set.find().map((d) => `${d.from}:${String((d.spec as { key?: string }).key)}`);
}

describe("task marks: mapped equals rebuilt", () => {
  let stack: MountedStack;

  beforeEach(async () => {
    window.history.replaceState({}, "", "/p/page1");
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ tasks: [] }) }));
    stack = await mountFullStack(
      ["intro paragraph", "- [ ] first task", "- [ ] second task", "- plain item", "outro"].join(
        "\n\n",
      ),
    );
  });
  afterEach(() => {
    stack.editor.destroy();
    vi.unstubAllGlobals();
    syncLivePageInfo();
    setPageRefOrigin("");
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  const textPos = (needle: string) => {
    let found = -1;
    stack.view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.isText && node.text?.includes(needle)) {
        found = pos + node.text.indexOf(needle);
      }
      return found < 0;
    });
    if (found < 0) throw new Error(`no text ${needle}`);
    return found;
  };
  const blockPos = (type: string, needle: string) => {
    let found = -1;
    stack.view.state.doc.descendants((node, pos) => {
      if (found < 0 && node.type.name === type && node.textContent.includes(needle)) found = pos;
      return found < 0;
    });
    if (found < 0) throw new Error(`no ${type} ${needle}`);
    return found;
  };
  const current = () => marks(promoteKey.getState(stack.view.state)!.decorations);
  /** A `day` message rebuilds the marks from every item, nothing else moved. */
  const rebuilt = () => {
    const { view } = stack;
    view.dispatch(view.state.tr.setMeta(promoteKey, { kind: "day" }).setMeta("addToHistory", false));
    return current();
  };
  const caretAt = (pos: number) =>
    stack.view.dispatch(stack.view.state.tr.setSelection(TextSelection.create(stack.view.state.doc, pos)));

  it("after typing above the tasks, which maps the marks", () => {
    const { view } = stack;
    expect(current()).toHaveLength(2);
    caretAt(textPos("intro") + 5);
    view.dispatch(view.state.tr.insertText("xxx"));
    const mapped = current();
    expect(mapped).toEqual(rebuilt());
    expect(mapped.every((mark) => mark.endsWith(":off"))).toBe(true);
  });

  it("when the caret enters a task line and leaves it again", () => {
    caretAt(textPos("first") + 2);
    expect(current().filter((mark) => mark.endsWith(":on"))).toHaveLength(1);
    expect(current()).toEqual(rebuilt());
    caretAt(textPos("intro") + 1);
    expect(current().some((mark) => mark.endsWith(":on"))).toBe(false);
    expect(current()).toEqual(rebuilt());
  });

  it("after a box is ticked, after a line is split above, after a task arrives above", () => {
    const { view } = stack;
    const itemPos = blockPos("list_item", "second");
    const item = view.state.doc.nodeAt(itemPos)!;
    view.dispatch(view.state.tr.setNodeMarkup(itemPos, undefined, { ...item.attrs, checked: true }));
    expect(current()).toEqual(rebuilt());

    // Enter in the intro paragraph: structural, so a rebuild, and the keys
    // stay because they name the line's place rather than its position.
    const before = current().map((mark) => mark.split(":").slice(1).join(":"));
    view.dispatch(view.state.tr.split(textPos("intro") + 5));
    expect(current().map((mark) => mark.split(":").slice(1).join(":"))).toEqual(before);
    expect(current()).toEqual(rebuilt());

    const schema = view.state.schema;
    const listPos = blockPos("bullet_list", "first");
    const firstItem = view.state.doc.nodeAt(listPos)!.firstChild!;
    const newItem = schema.nodes.list_item.create(
      firstItem.attrs,
      schema.nodes.paragraph.create(null, schema.text("zero task")),
    );
    view.dispatch(view.state.tr.insert(listPos + 1, newItem));
    expect(current()).toHaveLength(3);
    expect(current()).toEqual(rebuilt());
  });

  it("with a menu open on a line while text is typed above it", () => {
    const { view } = stack;
    const secondPos = blockPos("list_item", "second");
    view.dispatch(
      view.state.tr.setMeta(promoteKey, { kind: "open", pos: secondPos }).setMeta("addToHistory", false),
    );
    caretAt(textPos("intro") + 1);
    view.dispatch(view.state.tr.insertText("yy"));
    expect(promoteKey.getState(view.state)!.open).toBe(secondPos + 2);
    expect(current()).toEqual(rebuilt());
  });

  it("through undo and redo", () => {
    const { view } = stack;
    caretAt(textPos("intro") + 5);
    view.dispatch(view.state.tr.insertText("xxx"));
    undo(view.state, view.dispatch);
    expect(current()).toEqual(rebuilt());
    redo(view.state, view.dispatch);
    expect(current()).toEqual(rebuilt());
  });
});
