// @vitest-environment jsdom

/** A write to the open page from somewhere else (another device, an agent
 *  through MCP) reaches the editor as one replace over the range that
 *  differs, through the whole plugin stack. The caret stays on its words,
 *  the view keeps the DOM of every block the write did not touch, and the
 *  write is not an undo step: the writer's own steps stay undoable around
 *  it. */

import { parserCtx } from "@milkdown/kit/core";
import { undo, undoDepth } from "@milkdown/kit/prose/history";
import { TextSelection, type Transaction } from "@milkdown/kit/prose/state";
import { ReplaceStep } from "@milkdown/kit/prose/transform";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountFullStack, type MountedStack } from "./editor-stack.harness";
import { applyExternalMarkdown, EXTERNAL_WRITE_META } from "./external-write";
import { setPageRefOrigin, syncLivePageInfo } from "./page-ref";

const BASE = ["First paragraph.", "Second paragraph.", "Third paragraph."].join("\n\n");

describe("an external write applied in place", () => {
  let stack: MountedStack;

  beforeEach(async () => {
    window.history.replaceState({}, "", "/p/page1");
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ tasks: [] }) }));
    stack = await mountFullStack(BASE);
  });
  afterEach(() => {
    stack.editor.destroy();
    vi.unstubAllGlobals();
    syncLivePageInfo();
    setPageRefOrigin("");
    document.body.replaceChildren();
    window.history.replaceState({}, "", "/");
  });

  const parse = (markdown: string) => stack.editor.ctx.get(parserCtx)(markdown);
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
  const caretAt = (pos: number) =>
    stack.view.dispatch(
      stack.view.state.tr.setSelection(TextSelection.create(stack.view.state.doc, pos)),
    );
  /** Every transaction the view applies from now on. */
  const recordTransactions = () => {
    const seen: Transaction[] = [];
    stack.view.setProps({
      // Appended transactions too: a plugin answering the write with a
      // change of its own would be counted as the writer's edit.
      dispatchTransaction: (tr) => {
        const { state, transactions } = stack.view.state.applyTransaction(tr);
        seen.push(...transactions);
        stack.view.updateState(state);
      },
    });
    return seen;
  };

  it("replaces only the differing range and keeps the caret on its words", () => {
    caretAt(textPos("Third") + 3);
    const thirdDom = stack.view.nodeDOM(textPos("Third") - 1);
    const seen = recordTransactions();
    const next = [
      "First paragraph, edited on the phone.",
      "Second paragraph.",
      "Third paragraph.",
    ].join("\n\n");

    expect(applyExternalMarkdown(stack.view, parse, next)).toBe("applied");

    expect(stack.serialize().trim()).toBe(next);
    // The caret is still after "Thi", though everything before it moved.
    expect(stack.view.state.selection.head).toBe(textPos("Third") + 3);
    // One replace, inside the first paragraph, and nothing else redrawn.
    const external = seen.filter((tr) => tr.getMeta(EXTERNAL_WRITE_META) === true);
    expect(external).toHaveLength(1);
    const steps = external[0].steps;
    expect(steps).toHaveLength(1);
    const step = steps[0] as ReplaceStep;
    expect(step).toBeInstanceOf(ReplaceStep);
    const firstEnd = stack.view.state.doc.child(0).nodeSize;
    expect((step as unknown as { to: number }).to).toBeLessThanOrEqual(firstEnd);
    expect(stack.view.nodeDOM(textPos("Third") - 1)).toBe(thirdDom);
    // Nothing in the stack answered with an edit of the writer's own.
    expect(
      seen.filter(
        (tr) =>
          tr.docChanged &&
          tr.getMeta(EXTERNAL_WRITE_META) !== true &&
          tr.getMeta("addToHistory") !== false,
      ),
    ).toHaveLength(0);
  });

  it("is not an undo step, and the writer's own step stays undoable", () => {
    const end = textPos("Third paragraph.") + "Third paragraph.".length;
    stack.view.dispatch(stack.view.state.tr.insertText(" Mine.", end));
    expect(undoDepth(stack.view.state)).toBe(1);
    const next = [
      "First paragraph, edited by an agent.",
      "Second paragraph.",
      "Third paragraph. Mine.",
    ].join("\n\n");

    expect(applyExternalMarkdown(stack.view, parse, next)).toBe("applied");
    expect(undoDepth(stack.view.state)).toBe(1);

    undo(stack.view.state, stack.view.dispatch);
    expect(stack.serialize().trim()).toBe(
      ["First paragraph, edited by an agent.", "Second paragraph.", "Third paragraph."].join(
        "\n\n",
      ),
    );
  });

  it("changes nothing when the body is the one the editor holds", () => {
    const seen = recordTransactions();
    expect(applyExternalMarkdown(stack.view, parse, BASE)).toBe("unchanged");
    expect(seen.filter((tr) => tr.docChanged)).toHaveLength(0);
  });

  it("refuses a view that takes no edits, so the caller remounts instead", () => {
    stack.view.setProps({ editable: () => false });
    expect(applyExternalMarkdown(stack.view, parse, "Something else.")).toBe("refused");
    expect(stack.serialize().trim()).toBe(BASE);
  });

  it("applies structural changes: blocks added, removed and retyped", () => {
    caretAt(textPos("Third") + 2);
    const next = [
      "# A heading now",
      "- Second paragraph.",
      "New block in the middle.",
      "Third paragraph.",
    ].join("\n\n");
    expect(applyExternalMarkdown(stack.view, parse, next)).toBe("applied");
    expect(stack.serialize().trim()).toBe(next);
    expect(stack.view.state.selection.head).toBe(textPos("Third") + 2);
  });
});
