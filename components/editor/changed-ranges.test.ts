import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { describe, expect, it } from "vitest";
import {
  changedTopLevelRanges,
  editsStayInsideTextblocks,
  removedContentHas,
} from "./changed-ranges";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    heading: { content: "inline*", group: "block", attrs: { level: { default: 1 } } },
    page_ref: { atom: true, inline: true, group: "inline", attrs: { id: {} } },
    bullet_list: { content: "list_item+", group: "block" },
    list_item: { content: "paragraph+" },
    text: { group: "inline" },
  },
  marks: { strong: {} },
});

const p = (text: string) => schema.node("paragraph", null, schema.text(text));
const h = (text: string) => schema.node("heading", { level: 2 }, schema.text(text));
const ref = (id: string) => schema.node("paragraph", null, [schema.node("page_ref", { id })]);
const doc = (...blocks: ReturnType<typeof p>[]) => schema.node("doc", null, blocks);
const isHeading = (node: { type: { name: string } }) => node.type.name === "heading";

describe("changedTopLevelRanges", () => {
  it("names the one top-level block a keystroke lands in", () => {
    const state = EditorState.create({ doc: doc(p("one"), p("two"), p("three")) });
    // "one" spans 0..5, "two" 5..10.
    const tr = state.tr.insertText("x", 7);
    expect(changedTopLevelRanges(tr)).toEqual([{ from: 5, to: 11 }]);
  });

  it("covers a block inserted between blocks and merges neighbouring ranges", () => {
    const state = EditorState.create({ doc: doc(p("one"), p("two")) });
    const tr = state.tr.insert(5, p("new")).insertText("y", 2);
    expect(changedTopLevelRanges(tr)).toEqual([{ from: 0, to: 11 }]);
  });

  it("reports nothing for a mark step, which writes no position", () => {
    const state = EditorState.create({ doc: doc(p("one")) });
    const tr = state.tr.addMark(1, 4, schema.marks.strong.create());
    expect(changedTopLevelRanges(tr)).toEqual([]);
  });

  it("maps an early step's range through the steps after it", () => {
    const state = EditorState.create({ doc: doc(p("one"), p("two"), p("three")) });
    // Write into "three", then insert a block before it: the first range
    // must land on "three" where it now stands.
    const tr = state.tr.insertText("z", 12).insert(5, p("new"));
    expect(changedTopLevelRanges(tr)).toEqual([
      { from: 5, to: 10 },
      { from: 15, to: 23 },
    ]);
  });
});

describe("editsStayInsideTextblocks", () => {
  it("passes a keystroke inside a paragraph", () => {
    const state = EditorState.create({ doc: doc(h("Title"), p("body")) });
    expect(editsStayInsideTextblocks(state.tr.insertText("x", 9), isHeading)).toBe(true);
  });

  it("fails a keystroke inside an excluded block", () => {
    const state = EditorState.create({ doc: doc(h("Title"), p("body")) });
    expect(editsStayInsideTextblocks(state.tr.insertText("x", 2), isHeading)).toBe(false);
  });

  it("fails a split, a join, and a block type change", () => {
    const state = EditorState.create({ doc: doc(p("one"), p("two")) });
    expect(editsStayInsideTextblocks(state.tr.split(3), isHeading)).toBe(false);
    expect(editsStayInsideTextblocks(state.tr.delete(4, 6), isHeading)).toBe(false);
    expect(
      editsStayInsideTextblocks(state.tr.setBlockType(1, 1, schema.nodes.heading), isHeading),
    ).toBe(false);
  });

  it("fails an attribute step, whose map says nothing about what it changed", () => {
    const state = EditorState.create({ doc: doc(h("Title")) });
    expect(editsStayInsideTextblocks(state.tr.setNodeAttribute(0, "level", 3), isHeading)).toBe(
      false,
    );
  });

  it("passes a mark change", () => {
    const state = EditorState.create({ doc: doc(h("Title"), p("body")) });
    expect(
      editsStayInsideTextblocks(state.tr.addMark(8, 10, schema.marks.strong.create()), isHeading),
    ).toBe(true);
  });
});

describe("removedContentHas", () => {
  const isRef = (node: { type: { name: string } }) => node.type.name === "page_ref";

  it("sees a page ref inside a deleted row", () => {
    const state = EditorState.create({ doc: doc(p("one"), ref("a"), p("two")) });
    expect(removedContentHas(state.tr.delete(5, 8), isRef)).toBe(true);
  });

  it("ignores an insertion, which removes nothing", () => {
    const state = EditorState.create({ doc: doc(p("one"), ref("a")) });
    expect(removedContentHas(state.tr.insertText("x", 2), isRef)).toBe(false);
  });

  it("reads an attribute step as a rewrite of the node it changes", () => {
    const state = EditorState.create({ doc: doc(p("one"), ref("a")) });
    expect(removedContentHas(state.tr.setNodeAttribute(6, "id", "b"), isRef)).toBe(true);
    const titled = EditorState.create({ doc: doc(h("Title"), ref("a")) });
    expect(removedContentHas(titled.tr.setNodeAttribute(0, "level", 3), isRef)).toBe(false);
  });

  it("ignores a deletion that stops at the ref's edge", () => {
    const state = EditorState.create({ doc: doc(p("one"), ref("a"), p("two")) });
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 9, 12)).deleteSelection();
    expect(removedContentHas(tr, isRef)).toBe(false);
  });
});
