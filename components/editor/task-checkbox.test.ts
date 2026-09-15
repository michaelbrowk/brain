// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from "@milkdown/kit/core";
import { history, undoCommand } from "@milkdown/kit/plugin/history";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { callCommand, getMarkdown } from "@milkdown/kit/utils";
import { afterEach, describe, expect, it } from "vitest";

import { parseTaskLines } from "@/lib/tasks/task-lines";

import {
  ensureTaskCommand,
  selectionIsTask,
  taskCheckbox,
  toggleTaskCommand,
} from "./task-checkbox";

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
    .use(history)
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

/** The start of every textblock in the document, which is one line per entry
 *  for every note these tests write. */
function lineStarts(view: EditorView): number[] {
  const starts: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) starts.push(pos + 1);
  });
  return starts;
}

function caretInLine(view: EditorView, index: number) {
  const at = lineStarts(view)[index];
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
}

function selectLines(view: EditorView, first: number, last: number) {
  const starts = lineStarts(view);
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, starts[first], starts[last]),
    ),
  );
}

// The command plugins take their key from the editor that mounted them, so a
// press reads `.key` here and never at module load.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function press(view: EditorView, command: any, payload?: unknown) {
  editors.get(view)!.action(callCommand(command.key, payload));
}

function undo(view: EditorView) {
  editors.get(view)!.action(callCommand(undoCommand.key));
}

/** What the store reads and what the reader sees, counted the same way. A
 *  line the editor draws a checkbox on that `parseTaskLines` cannot see is
 *  what made every + Task on a page answer "This note could not be read". */
function agreesWithTheStore(view: EditorView) {
  expect(parseTaskLines(serialize(view))).toHaveLength(boxes(view).length);
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

  it("holds no control byte, so grep can still read the file", async () => {
    // A literal NUL used to sit in the promote plugin's item separator. git
    // samples the first 8 KB and diffed the file as text, but `grep`,
    // `ripgrep` and every wrapper that shells out to one classify the WHOLE
    // file as binary and answer "Binary file … matches" with no lines. This
    // is the one file in `components/editor/` that reaches the share bundle,
    // so it is the one an audit of that directory must not skip.
    const source = readFileSync(
      path.join(process.cwd(), "components/editor/task-checkbox.ts"),
    );
    const control = [...source].filter(
      (byte) => byte < 9 || (byte > 13 && byte < 32),
    );
    expect(control).toEqual([]);
  });
});

/** THE PRESS, AGAINST THE REAL EDITOR.
 *
 *  One rule, in every shape a line can have: the command acts on the blocks
 *  the selection touches, in place, and nowhere else. The assertions are the
 *  markdown the note would be saved as, because that is the only text the
 *  store and the next reader ever see.
 */
describe("the Task command", () => {
  it("makes the only bullet of a list a task where it stands", async () => {
    const view = await mountEditor("- water the plants\n");
    caretInLine(view, 0);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* [ ] water the plants\n");
    expect(boxes(view)).toHaveLength(1);
    agreesWithTheStore(view);
  });

  it("makes the first bullet of a list a task without taking the list with it", async () => {
    const view = await mountEditor("- first\n- second\n- third\n");
    caretInLine(view, 0);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* [ ] first\n\n* second\n\n* third\n");
    agreesWithTheStore(view);
  });

  it("makes a later bullet a task in place, neither nested nor taking its sibling", async () => {
    const view = await mountEditor("- first\n- second\n- third\n");
    caretInLine(view, 1);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* first\n\n* [ ] second\n\n* third\n");
    expect(boxes(view)).toHaveLength(1);
    agreesWithTheStore(view);
  });

  it("makes the last bullet a task in place", async () => {
    const view = await mountEditor("- first\n- second\n- third\n");
    caretInLine(view, 2);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* first\n\n* second\n\n* [ ] third\n");
    agreesWithTheStore(view);
  });

  it("moves an ordered item to a bullet task line the store can read", async () => {
    const view = await mountEditor("1. first\n");
    caretInLine(view, 0);

    press(view, ensureTaskCommand);

    // `1. [ ] first` is a checkbox to the editor and prose to the store.
    expect(serialize(view)).toBe("* [ ] first\n");
    expect(boxes(view)).toHaveLength(1);
    agreesWithTheStore(view);
  });

  it("splits an ordered list around the item the press was on", async () => {
    const view = await mountEditor("1. first\n2. second\n3. third\n");
    caretInLine(view, 1);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("1. first\n\n* [ ] second\n\n2. third\n");
    expect(boxes(view)).toHaveLength(1);
    agreesWithTheStore(view);
  });

  it("turns a paragraph into a task line and puts the caret in it", async () => {
    const view = await mountEditor("water the plants\n");
    caretInLine(view, 0);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* [ ] water the plants\n");
    expect(selectionIsTask(view.state)).toBe(true);
    agreesWithTheStore(view);
  });

  it("leaves a line that is already a task exactly as it is", async () => {
    const view = await mountEditor("- [x] call the bank\n");
    caretInLine(view, 0);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* [x] call the bank\n");
    expect(boxes(view)[0].getAttribute("aria-checked")).toBe("true");
  });

  it("takes a task back to a paragraph on the second press, never to a bullet", async () => {
    const view = await mountEditor("- [ ] water the plants\n");
    caretInLine(view, 0);

    press(view, toggleTaskCommand);
    expect(serialize(view)).toBe("water the plants\n");
    expect(boxes(view)).toHaveLength(0);

    press(view, toggleTaskCommand);
    expect(serialize(view)).toBe("* [ ] water the plants\n");
    agreesWithTheStore(view);
  });

  it("takes a done task back to a paragraph and then to a fresh, undone one", async () => {
    const view = await mountEditor("- [x] call the bank\n");
    caretInLine(view, 0);

    press(view, toggleTaskCommand);
    expect(serialize(view)).toBe("call the bank\n");

    press(view, toggleTaskCommand);
    expect(serialize(view)).toBe("* [ ] call the bank\n");
  });

  it("never drops the tick on a press that leaves the line a task", async () => {
    const view = await mountEditor("- [x] done\n\nplain\n");
    selectLines(view, 0, 1);

    // Not every line is a task, so the press makes them all tasks: the one
    // that already is keeps the tick it was given.
    press(view, toggleTaskCommand);

    expect(serialize(view)).toBe("* [x] done\n\n- [ ] plain\n");
    agreesWithTheStore(view);
  });

  it("lifts a nested task to a paragraph in one press, keeping its text and children", async () => {
    const view = await mountEditor("- [ ] parent\n  - [x] child\n    - [ ] grandchild\n");
    caretInLine(view, 1);

    press(view, toggleTaskCommand);

    expect(serialize(view)).toBe("* [ ] parent\n\nchild\n\n* [ ] grandchild\n");
    agreesWithTheStore(view);
  });

  it("turns a plain bullet into a task rather than into a paragraph", async () => {
    const view = await mountEditor("- water the plants\n");
    caretInLine(view, 0);

    press(view, toggleTaskCommand);

    expect(serialize(view)).toBe("* [ ] water the plants\n");
    agreesWithTheStore(view);
  });

  it("converts every block a selection touches, into one list", async () => {
    const view = await mountEditor("first\n\nsecond\n\nthird\n");
    selectLines(view, 0, 2);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* [ ] first\n* [ ] second\n* [ ] third\n");
    expect(boxes(view)).toHaveLength(3);
    agreesWithTheStore(view);
  });

  it("leaves the bullets a mixed selection never reached alone", async () => {
    const view = await mountEditor("intro\n\n- first\n- second\n");
    selectLines(view, 0, 1);

    press(view, ensureTaskCommand);

    expect(serialize(view)).toBe("* [ ] intro\n\n- [ ] first\n\n- second\n");
    expect(boxes(view)).toHaveLength(2);
    agreesWithTheStore(view);
  });

  it("agrees with the pressed state the toolbar draws, mixed selection and all", async () => {
    const mixed = await mountEditor("- [ ] done\n\nplain\n");
    selectLines(mixed, 0, 1);
    expect(selectionIsTask(mixed.state)).toBe(false);
    press(mixed, toggleTaskCommand);
    // Not pressed, so the press makes tasks.
    expect(serialize(mixed)).toBe("* [ ] done\n\n- [ ] plain\n");

    const both = await mountEditor("- [ ] one\n- [x] two\n");
    selectLines(both, 0, 1);
    expect(selectionIsTask(both.state)).toBe(true);
    press(both, toggleTaskCommand);
    // Pressed, so the press takes them back.
    expect(serialize(both)).toBe("one\n\ntwo\n");
  });

  it("reads a plain bullet as no task at all", async () => {
    const view = await mountEditor("- water the plants\n");
    caretInLine(view, 0);
    expect(selectionIsTask(view.state)).toBe(false);
  });

  it("removes the slash trigger and converts in one transaction", async () => {
    const view = await mountEditor("/task\n");
    const end = 1 + view.state.doc.firstChild!.content.size;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));

    press(view, ensureTaskCommand, { from: 1, to: end });

    expect(serialize(view)).toBe("* [ ] <br />\n");
    expect(selectionIsTask(view.state)).toBe(true);
    view.dispatch(view.state.tr.insertText("water the plants", view.state.selection.from));
    expect(serialize(view)).toBe("* [ ] water the plants\n");

    undo(view);
    undo(view);
    // One undo for the typing, one for the press: the trigger the reader
    // typed comes back with the line it became.
    expect(serialize(view)).toBe("/task\n");
  });

  it("keeps the count going in the tail of a split ordered list", async () => {
    const view = await mountEditor("3. a\n4. b\n5. c\n");
    caretInLine(view, 1);

    press(view, ensureTaskCommand);

    // Two numbered lines are left and they read as two, rather than the tail
    // restarting at the number the head began with.
    expect(serialize(view)).toBe("3. a\n\n* [ ] b\n\n4. c\n");
    agreesWithTheStore(view);
  });

  it("leaves the siblings below a lifted task in the list they were in", async () => {
    const view = await mountEditor("- [ ] p\n  - [ ] one\n  - [ ] two\n  - [ ] three\n");
    caretInLine(view, 1);

    press(view, toggleTaskCommand);

    // `two` and `three` were never touched: they stay under `p`, at the depth
    // the reader put them at. Only the pressed line leaves the list.
    // The two-space indent is the nesting: both are still items of `p`'s own
    // list. The blank lines are the serializer's, and section 5 of the review
    // has them: a parsed list carries its `spread` as a string and comes back
    // loose whatever it was.
    expect(serialize(view)).toBe("* [ ] p\n  * [ ] two\n\n  * [ ] three\n\none\n");
    expect(boxes(view)).toHaveLength(3);
    agreesWithTheStore(view);
  });

  it("leaves a heading inside a selection a heading, and converts the lines around it", async () => {
    const view = await mountEditor("a\n\n# H\n\nb\n");
    selectLines(view, 0, 2);

    press(view, ensureTaskCommand);

    // A heading pressed on its own is left alone, so a heading caught in a
    // longer selection is left alone too. It used to be swallowed as the
    // second block of the task above it and stop being its own line.
    expect(serialize(view)).toBe("* [ ] a\n\n# H\n\n* [ ] b\n");
    expect(boxes(view)).toHaveLength(2);
    agreesWithTheStore(view);
  });

  it("refuses a line inside a quote, either press", async () => {
    const view = await mountEditor("> quoted\n");
    caretInLine(view, 0);

    press(view, ensureTaskCommand);
    expect(serialize(view)).toBe("> quoted\n");

    press(view, toggleTaskCommand);
    // `> * [ ] quoted` draws a checkbox the store cannot read, and one of
    // those on a page refuses + Task for the whole note.
    expect(serialize(view)).toBe("> quoted\n");
    expect(boxes(view)).toHaveLength(0);
    agreesWithTheStore(view);
  });

  it("leaves the trigger a quote refuses where the reader typed it", async () => {
    const view = await mountEditor("> /task\n");
    const start = lineStarts(view)[0];
    const end = start + "/task".length;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));

    press(view, ensureTaskCommand, { from: start, to: end });

    expect(serialize(view)).toBe("> /task\n");
  });

  it("comes back in one undo, whatever shape the line was", async () => {
    const bullet = await mountEditor("- first\n- second\n");
    caretInLine(bullet, 1);
    press(bullet, ensureTaskCommand);
    undo(bullet);
    expect(serialize(bullet)).toBe("* first\n\n* second\n");

    const ordered = await mountEditor("1. first\n2. second\n");
    caretInLine(ordered, 0);
    press(ordered, ensureTaskCommand);
    undo(ordered);
    expect(serialize(ordered)).toBe("1. first\n2. second\n");

    const nested = await mountEditor("- [ ] parent\n  - [x] child\n");
    caretInLine(nested, 1);
    press(nested, toggleTaskCommand);
    undo(nested);
    expect(serialize(nested)).toBe("* [ ] parent\n  * [x] child\n");
  });
});
