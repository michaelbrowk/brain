import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { describe, expect, it } from "vitest";
import { projectMarkdownSearchText } from "@/lib/search-navigation";
import {
  createSearchHighlightPlugin,
  resolveSearchTextTarget,
  searchHighlightPluginKey,
} from "./search-highlight";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    page_ref: {
      inline: true,
      atom: true,
      group: "inline",
      attrs: { id: { default: "" }, label: { default: "" } },
    },
  },
});

function paragraph(text: string) {
  return schema.nodes.paragraph.create(null, schema.text(text));
}

function pageRef(id: string, label: string) {
  return schema.nodes.page_ref.create({ id, label });
}

describe("search highlight resolution", () => {
  it("uses occurrence and context to select only the intended duplicate", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph("Needle in the first place"),
      paragraph("Needle in the selected place"),
    ]);

    const result = resolveSearchTextTarget(doc, {
      exact: "Needle",
      occurrence: 1,
      before: "Needle in the first place ",
      after: " in the selected place",
    });

    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    expect(result.ranges).toHaveLength(1);
    expect(
      doc.textBetween(
        result.ranges[0].from,
        result.ranges[0].to,
      ),
    ).toBe("Needle");
    expect(result.ranges[0].from).toBeGreaterThan(doc.firstChild!.nodeSize);
  });

  it("fails closed when a stale target is missing or ambiguous", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph("Needle left"),
      paragraph("Needle right"),
    ]);

    expect(
      resolveSearchTextTarget(doc, {
        exact: "Gone",
        occurrence: 0,
        before: "",
        after: "",
      }).status,
    ).toBe("missing");
    expect(
      resolveSearchTextTarget(doc, {
        exact: "Needle",
        occurrence: 4,
        before: "",
        after: "",
      }).status,
    ).toBe("ambiguous");
  });

  it.each([
    "- Needle in a bullet",
    "1. Needle in an ordered item",
    "- [ ] Needle in an open task",
    "- [x] Needle in a completed task",
  ])("resolves projected list text in the editor: %s", (markdown) => {
    const visible = projectMarkdownSearchText(markdown);
    const doc = schema.nodes.doc.create(null, [paragraph(visible)]);
    const result = resolveSearchTextTarget(doc, {
      exact: "Needle",
      occurrence: 0,
      before: "",
      after: visible.slice("Needle".length),
    });

    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    expect(
      doc.textBetween(result.ranges[0].from, result.ranges[0].to),
    ).toBe("Needle");
  });

  it("resolves and decorates the visible label of an atomic page ref", () => {
    const ref = pageRef("project-atlas", "Project Atlas");
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, ref),
    ]);
    const result = resolveSearchTextTarget(doc, {
      exact: "Project Atlas",
      occurrence: 0,
      before: "",
      after: "",
    });

    expect(result).toEqual({
      status: "exact",
      ranges: [
        {
          from: 1,
          to: 2,
          kind: "node",
        },
      ],
    });
    if (result.status !== "exact") return;

    const plugin = createSearchHighlightPlugin();
    const initial = EditorState.create({ schema, doc, plugins: [plugin] });
    const highlighted = initial.apply(
      initial.tr.setMeta(searchHighlightPluginKey, {
        type: "show",
        requestId: 8,
        ranges: result.ranges,
      }),
    );
    expect(
      searchHighlightPluginKey
        .getState(highlighted)
        ?.decorations.find()
        .map(({ from, to }) => ({ from, to })),
    ).toEqual([{ from: 1, to: 2 }]);
    expect(highlighted.doc.eq(initial.doc)).toBe(true);
  });

  it("uses page-ref visible text as nearby match context", () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("Before "),
        pageRef("project-atlas", "Project Atlas"),
        schema.text(" after Needle"),
      ]),
    ]);
    const result = resolveSearchTextTarget(doc, {
      exact: "Needle",
      occurrence: 0,
      before: "Before Project Atlas after ",
      after: "",
    });

    expect(result.status).toBe("exact");
    if (result.status !== "exact") return;
    expect(result.ranges).toEqual([
      {
        from: 16,
        to: 22,
        kind: "inline",
      },
    ]);
  });

  it("adds a decoration without changing Markdown state or the caret and clears on edit", () => {
    const doc = schema.nodes.doc.create(null, [
      paragraph("Before Needle after"),
    ]);
    const plugin = createSearchHighlightPlugin();
    const initial = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [plugin],
    });
    const resolution = resolveSearchTextTarget(doc, {
      exact: "Needle",
      occurrence: 0,
      before: "Before ",
      after: " after",
    });
    expect(resolution.status).toBe("exact");
    if (resolution.status !== "exact") return;

    const highlighted = initial.apply(
      initial.tr
        .setMeta(searchHighlightPluginKey, {
          type: "show",
          requestId: 7,
          ranges: resolution.ranges,
        })
        .setMeta("addToHistory", false),
    );

    expect(highlighted.doc.eq(initial.doc)).toBe(true);
    expect(highlighted.selection.eq(initial.selection)).toBe(true);
    expect(searchHighlightPluginKey.getState(highlighted)).not.toBeNull();

    const edited = highlighted.apply(highlighted.tr.insertText("!", 2));
    expect(searchHighlightPluginKey.getState(edited)).toBeNull();
  });
});
