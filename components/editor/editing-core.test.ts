import { Schema } from "@milkdown/kit/prose/model";
import {
  EditorState,
  NodeSelection,
  TextSelection,
} from "@milkdown/kit/prose/state";
import { DecorationSet } from "@milkdown/kit/prose/view";
import { describe, expect, it, vi } from "vitest";
import {
  acceptsTypedText,
  createSlashHintPlugin,
  createTrailingParagraphPlugin,
  firstEmptyBlockPos,
  focusedWithoutCaret,
  focusFirstEmptyBlock,
  settleFocusCaret,
  needsTrailingParagraph,
  redirectTrailingPageRefTextInput,
  TRAILING_PARAGRAPH_TRANSACTION_META,
  writableCaretPos,
} from "./editing-core";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    empty_block: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block" },
    text: { group: "inline" },
    page_ref: { atom: true, group: "inline", inline: true },
    horizontal_rule: { group: "block" },
  },
});

const paragraph = schema.nodes.paragraph;
const pageRef = schema.nodes.page_ref;

describe("needsTrailingParagraph", () => {
  it("adds a writable line after a standalone trailing page ref", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
    ]);

    expect(needsTrailingParagraph(doc, paragraph)).toBe(true);
  });

  it("materializes that line through the editor transaction", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      plugins: [createTrailingParagraphPlugin()],
    });

    const result = state.applyTransaction(state.tr.setMeta("test", true));

    expect(result.transactions).toHaveLength(2);
    expect(result.state.doc.childCount).toBe(2);
    expect(result.state.doc.lastChild?.type).toBe(paragraph);
    expect(result.state.doc.lastChild?.content.size).toBe(0);
    expect(
      result.transactions[1]?.getMeta(TRAILING_PARAGRAPH_TRANSACTION_META),
    ).toBe(true);
    expect(result.transactions[1]?.getMeta("addToHistory")).toBe(false);
  });

  it("keeps an existing empty trailing paragraph", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
      paragraph.create(),
    ]);

    expect(needsTrailingParagraph(doc, paragraph)).toBe(false);
  });

  it("routes the next typed character into the writable line", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
      paragraph.create(),
    ]);
    const state = EditorState.create({ schema, doc });

    // A freshly focused contenteditable can leave ProseMirror's selection in
    // the standalone page-ref paragraph even though the visible caret is below
    // it. The next input must start the real trailing paragraph.
    const transaction = redirectTrailingPageRefTextInput(state, "/");

    expect(transaction).not.toBeNull();
    const next = state.apply(transaction!);
    expect(next.doc.lastChild?.textContent).toBe("/");
    expect(next.doc.firstChild?.textContent).toBe("");
    expect(next.selection.$from.parent).toBe(next.doc.lastChild);
    expect(next.selection.$from.parentOffset).toBe(1);
  });

  it("does not split ordinary text or mixed page-ref paragraphs", () => {
    const text = schema.text("Notes ");
    const ordinary = schema.nodes.doc.create(null, [paragraph.create(null, text)]);
    const mixed = schema.nodes.doc.create(null, [
      paragraph.create(null, [text, pageRef.create()]),
    ]);

    expect(needsTrailingParagraph(ordinary, paragraph)).toBe(false);
    expect(needsTrailingParagraph(mixed, paragraph)).toBe(false);
  });

  it("adds a writable line after a trailing block atom", () => {
    const doc = schema.nodes.doc.create(null, [schema.nodes.horizontal_rule.create()]);

    expect(needsTrailingParagraph(doc, paragraph)).toBe(true);
  });
});

describe("slash hint", () => {
  const plugin = createSlashHintPlugin();

  function hintedAt(doc: ReturnType<typeof schema.nodes.doc.create>, pos: number) {
    const base = EditorState.create({ schema, doc, plugins: [plugin] });
    const state = base.apply(base.tr.setSelection(TextSelection.create(doc, pos)));
    const decorations = plugin.props.decorations?.call(plugin, state);
    return decorations instanceof DecorationSet ? decorations.find().length : 0;
  }

  it("marks the empty paragraph the caret sits in", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create(null, schema.text("Agenda")),
      schema.nodes.paragraph.create(),
    ]);
    // heading node spans 0..8, the paragraph opens at 8, caret inside at 9
    expect(hintedAt(doc, 9)).toBe(1);
  });

  it("marks an empty ::empty-block the same way — templates are built from them", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create(null, schema.text("Agenda")),
      schema.nodes.empty_block.create(),
    ]);
    expect(hintedAt(doc, 9)).toBe(1);
  });

  it("stays quiet in headings and lines with content", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create(null, schema.text("Agenda")),
      schema.nodes.paragraph.create(null, schema.text("x")),
    ]);
    expect(hintedAt(doc, 1)).toBe(0);
    expect(hintedAt(doc, 9)).toBe(0);
  });
});

describe("template caret", () => {
  const templateDoc = () =>
    schema.nodes.doc.create(null, [
      schema.nodes.heading.create(null, schema.text("Attendees")),
      schema.nodes.empty_block.create(),
      schema.nodes.heading.create(null, schema.text("Agenda")),
      schema.nodes.empty_block.create(),
    ]);

  it("finds the writable line under the first heading", () => {
    // heading "Attendees" spans 0..11, the empty block opens at 11, caret at 12
    expect(firstEmptyBlockPos(templateDoc())).toBe(12);
  });

  it("skips filled sections and reports none when every section has text", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create(null, schema.text("Agenda")),
      schema.nodes.empty_block.create(null, schema.text("x")),
      schema.nodes.heading.create(null, schema.text("Notes")),
      schema.nodes.empty_block.create(),
    ]);
    expect(firstEmptyBlockPos(doc)).toBe(19);
    expect(
      firstEmptyBlockPos(
        schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("x"))]),
      ),
    ).toBeNull();
  });

  it("places the caret there, focuses, and lights the slash hint", () => {
    let state = EditorState.create({
      schema,
      doc: templateDoc(),
      plugins: [createSlashHintPlugin()],
    });
    let focused = false;
    const view = {
      get state() {
        return state;
      },
      dispatch(tr: ReturnType<EditorState["tr"]["setMeta"]>) {
        state = state.apply(tr);
      },
      focus() {
        focused = true;
      },
    };

    expect(focusFirstEmptyBlock(view)).toBe(true);
    expect(focused).toBe(true);
    expect(state.selection.from).toBe(12);
    expect(state.selection.$from.parent.type.name).toBe("empty_block");
    const plugin = createSlashHintPlugin();
    const decorations = plugin.props.decorations?.call(plugin, state);
    expect(decorations instanceof DecorationSet ? decorations.find().length : 0).toBe(1);
  });

  it("leaves a page without empty sections alone", () => {
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, schema.text("x"))]),
    });
    const dispatch = vi.fn();
    const focus = vi.fn();
    expect(focusFirstEmptyBlock({ state, dispatch, focus })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});

describe("a caret handed the editor from outside", () => {
  it("reads an empty selection, and one outside the editor, as no caret", () => {
    const dom = { contains: (node: Node | null) => node === ("inside" as unknown as Node) } as
      unknown as HTMLElement;

    expect(focusedWithoutCaret(dom, null)).toBe(true);
    expect(focusedWithoutCaret(dom, { anchorNode: null })).toBe(true);
    expect(
      focusedWithoutCaret(dom, { anchorNode: "outside" as unknown as Node }),
    ).toBe(true);
    expect(
      focusedWithoutCaret(dom, { anchorNode: "inside" as unknown as Node }),
    ).toBe(false);
  });

  it("does not count a lone page-ref row as a line that can take a key", () => {
    expect(acceptsTypedText(paragraph.create(null, pageRef.create()))).toBe(false);
    expect(acceptsTypedText(paragraph.create())).toBe(true);
    expect(acceptsTypedText(paragraph.create(null, schema.text("x")))).toBe(true);
    expect(
      acceptsTypedText(paragraph.create(null, [pageRef.create(), schema.text(" note")])),
    ).toBe(true);
    expect(acceptsTypedText(schema.nodes.horizontal_rule.create())).toBe(false);
  });

  it("moves off a page-ref row onto the writable line the document keeps", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
      paragraph.create(),
    ]);
    const base = EditorState.create({ schema, doc });
    const onPageRefRow = base.apply(
      base.tr.setSelection(TextSelection.create(doc, 1)),
    );

    // the page-ref row opens at 0 and is 3 wide, so the writable line's first
    // text position is 4
    expect(writableCaretPos(onPageRefRow)).toBe(4);
  });

  it("leaves a selection that can already take a key where it is", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
      paragraph.create(null, schema.text("prose")),
    ]);
    const base = EditorState.create({ schema, doc });
    const inProse = base.apply(base.tr.setSelection(TextSelection.create(doc, 5)));

    expect(writableCaretPos(inProse)).toBe(null);
  });

  it("stays out of columns, callouts and cells — it only walks the top level", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
      paragraph.create(null, pageRef.create()),
    ]);
    const base = EditorState.create({ schema, doc });
    const onFirstRow = base.apply(base.tr.setSelection(TextSelection.create(doc, 1)));

    expect(writableCaretPos(onFirstRow)).toBe(null);
  });

  it("leaves a rule the reader selected where it is, far down the page", () => {
    // A node selection is a selection the reader made, not a missing caret.
    // Sending it to the first line moved them off screen without a scroll.
    const blocks = [];
    for (let line = 0; line < 44; line += 1) {
      blocks.push(paragraph.create(null, schema.text(`line ${line}`)));
    }
    blocks.push(schema.nodes.horizontal_rule.create());
    blocks.push(paragraph.create());
    const doc = schema.nodes.doc.create(null, blocks);
    const rulePos = doc.content.size - 1 - 2;
    const base = EditorState.create({ schema, doc });
    const onRule = base.apply(
      base.tr.setSelection(NodeSelection.create(doc, rulePos)),
    );

    expect(onRule.selection).toBeInstanceOf(NodeSelection);
    expect(writableCaretPos(onRule)).toBe(null);
  });

  it("leaves a range the reader drew alone", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, schema.text("prose")),
      paragraph.create(null, pageRef.create()),
    ]);
    const base = EditorState.create({ schema, doc });
    const range = base.apply(base.tr.setSelection(TextSelection.create(doc, 1, 4)));

    expect(writableCaretPos(range)).toBe(null);
  });

  it("moves a caret on a page row in the middle to the line beside it, not the first line", () => {
    // Twenty-nine lines of prose, a page row, then more prose. A caret on
    // that row used to land on line 0 — the first writable block of the
    // document — and the next keys went in off screen.
    const blocks = [];
    for (let line = 0; line < 29; line += 1) {
      blocks.push(paragraph.create(null, schema.text(`line ${line}`)));
    }
    const rowIndex = blocks.length;
    blocks.push(paragraph.create(null, pageRef.create()));
    blocks.push(paragraph.create(null, schema.text("after")));
    blocks.push(paragraph.create(null, schema.text("later")));
    const doc = schema.nodes.doc.create(null, blocks);
    let rowPos = 0;
    for (let index = 0; index < rowIndex; index += 1) {
      rowPos += doc.child(index).nodeSize;
    }
    const base = EditorState.create({ schema, doc });
    const onRow = base.apply(
      base.tr.setSelection(TextSelection.create(doc, rowPos + 1)),
    );

    // the row is 3 wide; the line after it opens at rowPos + 3, caret at + 4
    expect(writableCaretPos(onRow)).toBe(rowPos + 4);
    const landed = doc.resolve(rowPos + 4).parent;
    expect(landed.textContent).toBe("after");
  });

  it("takes the line before the row when nothing after it can take a key", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, schema.text("before")),
      paragraph.create(null, pageRef.create()),
      schema.nodes.horizontal_rule.create(),
    ]);
    const base = EditorState.create({ schema, doc });
    const onRow = base.apply(
      base.tr.setSelection(TextSelection.create(doc, 9)),
    );

    expect(writableCaretPos(onRow)).toBe(1);
  });
});

describe("what one focus does", () => {
  /** A view stub: the DOM selection it reports, and the document selection
   *  it holds. `inside` is any node the editor's dom contains. */
  function stubView(
    state: EditorState,
    domSelection: "none" | "inside",
  ) {
    const inside = "inside" as unknown as Node;
    const dispatch = vi.fn((tr: ReturnType<EditorState["tr"]["setMeta"]>) => {
      current = current.apply(tr);
    });
    let current = state;
    const view = {
      isDestroyed: false,
      hasFocus: () => true,
      dom: {
        contains: (node: Node | null) => node === inside,
        ownerDocument: {
          getSelection: () => ({
            anchorNode: domSelection === "inside" ? inside : null,
          }),
        },
      } as unknown as HTMLElement,
      get state() {
        return current;
      },
      dispatch,
      focus: vi.fn(),
    };
    return { view, dispatch, focus: view.focus };
  }

  const pageRefFirst = () =>
    schema.nodes.doc.create(null, [
      paragraph.create(null, pageRef.create()),
      paragraph.create(),
    ]);

  it("leaves a selection the DOM already holds alone — it is the reader's", () => {
    // Playwright's fill, a click, a select-all: the browser has a selection
    // and ProseMirror has not read it yet. Writing the document's stale
    // caret over it sent the typed text to the end of the old paragraph.
    const doc = pageRefFirst();
    const base = EditorState.create({ schema, doc });
    const onPageRefRow = base.apply(
      base.tr.setSelection(TextSelection.create(doc, 1)),
    );
    const { view, dispatch, focus } = stubView(onPageRefRow, "inside");

    expect(settleFocusCaret(view)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("puts a caret on the writable line when the DOM holds none and the document's cannot type", () => {
    const doc = pageRefFirst();
    const base = EditorState.create({ schema, doc });
    const onPageRefRow = base.apply(
      base.tr.setSelection(TextSelection.create(doc, 1)),
    );
    const { view, dispatch, focus } = stubView(onPageRefRow, "none");

    expect(settleFocusCaret(view)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(view.state.selection.from).toBe(4);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not touch the DOM for a rule the reader selected, even with no DOM caret", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph.create(null, schema.text("prose")),
      schema.nodes.horizontal_rule.create(),
      paragraph.create(),
    ]);
    const base = EditorState.create({ schema, doc });
    const onRule = base.apply(base.tr.setSelection(NodeSelection.create(doc, 7)));
    const { view, dispatch, focus } = stubView(onRule, "none");

    expect(settleFocusCaret(view)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });
});
