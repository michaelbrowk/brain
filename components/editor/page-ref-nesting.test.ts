// @vitest-environment jsdom

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Schema } from "@milkdown/kit/prose/model";
import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import {
  decodePageRefDragPayload,
  encodePageRefDragPayload,
  findRemovedStandalonePageRef,
  freezeAcceptedPageRefNesting,
  resolvePageRefNestingIntent,
  resolveStandalonePageRefDom,
  standalonePageRefAnchors,
  validatePageRefNestingTarget,
} from "./page-ref-nesting";

function treeNode(
  id: string,
  parentId: string | null,
  children: TreeNode[] = [],
  extra: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    parentId,
    title: id,
    order: id,
    created: "2026-08-03T00:00:00.000Z",
    updated: "2026-08-03T00:00:00.000Z",
    hasChildren: children.length > 0,
    children,
    ...extra,
  };
}

describe("page-ref external drag contract", () => {
  it("round-trips only bounded page-ref payloads", () => {
    expect(
      decodePageRefDragPayload(
        encodePageRefDragPayload({
          id: "page_123",
          occurrence: 2,
          label: "  Page title  ",
        }),
      ),
    ).toEqual({ id: "page_123", occurrence: 2, label: "Page title" });
    expect(decodePageRefDragPayload("not json")).toBeNull();
    expect(
      decodePageRefDragPayload(JSON.stringify({ id: "bad.id", occurrence: 0 })),
    ).toBeNull();
    expect(
      decodePageRefDragPayload(JSON.stringify({ id: "page", occurrence: -1 })),
    ).toBeNull();
    expect(
      decodePageRefDragPayload(
        JSON.stringify({ id: "page", occurrence: 0, label: "x".repeat(1_025) }),
      ),
    ).toBeNull();
  });

  it("uses one structural preflight for valid and invalid sidebar targets", () => {
    const descendant = treeNode("descendant", "source");
    const source = treeNode("source", "parent", [descendant]);
    const target = treeNode("target", "parent");
    const collection = treeNode("collection", "parent", [], {
      collection: {} as TreeNode["collection"],
    });
    const parent = treeNode("parent", null, [source, target, collection]);
    const tree = [parent];
    const dragged = { id: "source", occurrence: 0 };

    expect(
      validatePageRefNestingTarget({
        tree,
        pageId: "parent",
        source: dragged,
        targetId: "target",
        scope: "tree",
      }),
    ).toEqual({ valid: true, cleanupRetry: false });

    for (const targetId of ["source", "descendant", "parent", "collection"]) {
      expect(
        validatePageRefNestingTarget({
          tree,
          pageId: "parent",
          source: dragged,
          targetId,
          scope: "tree",
        }).valid,
        targetId,
      ).toBe(false);
    }
    expect(
      validatePageRefNestingTarget({
        tree,
        pageId: "parent",
        source: { id: "source", occurrence: -1 },
        targetId: "target",
        scope: "tree",
      }).valid,
    ).toBe(false);
  });

  it("allows a visible page block to move onto any safe sidebar page", () => {
    const source = treeNode("source", "original-parent");
    const originalParent = treeNode("original-parent", null, [source]);
    const refOwner = treeNode("ref-owner", null);
    const target = treeNode("target", null);

    expect(
      validatePageRefNestingTarget({
        tree: [originalParent, refOwner, target],
        pageId: refOwner.id,
        source: { id: source.id, occurrence: 0 },
        targetId: target.id,
        scope: "tree",
      }),
    ).toEqual({ valid: true, cleanupRetry: false });
  });

  it("rejects a reference owned by a descendant of the moved page", () => {
    const refOwner = treeNode("ref-owner", "source");
    const source = treeNode("source", null, [refOwner]);
    const target = treeNode("target", null);

    expect(
      validatePageRefNestingTarget({
        tree: [source, target],
        pageId: refOwner.id,
        source: { id: source.id, occurrence: 0 },
        targetId: target.id,
        scope: "tree",
      }),
    ).toEqual({ valid: false, cleanupRetry: false });
  });

  it("blocks serialization and marks the source pending synchronously", async () => {
    const editor = document.createElement("div");
    const source = document.createElement("a");
    editor.setAttribute("contenteditable", "true");
    editor.append(source);
    document.body.append(editor);
    let resolve!: (value: boolean) => void;
    const result = new Promise<boolean>((next) => {
      resolve = next;
    });
    const onAccepted = vi.fn();
    const onFrozenChange = vi.fn();

    freezeAcceptedPageRefNesting({
      editor,
      source,
      request: { operationId: "move-1", result },
      onAccepted,
      onFrozenChange,
    });

    expect(onAccepted).toHaveBeenCalledOnce();
    expect(onFrozenChange).toHaveBeenNthCalledWith(1, true);
    expect(editor.getAttribute("contenteditable")).toBe("false");
    expect(editor.getAttribute("aria-busy")).toBe("true");
    expect(source.getAttribute("data-page-ref-nest-pending")).toBe("true");

    resolve(true);
    await result;
    await Promise.resolve();
    expect(onFrozenChange).toHaveBeenLastCalledWith(false);
    expect(editor.getAttribute("contenteditable")).toBe("true");
    expect(editor.hasAttribute("aria-busy")).toBe(false);
    expect(source.hasAttribute("data-page-ref-nest-pending")).toBe(false);
    editor.remove();
  });
});

const base = {
  sourceId: "source",
  targetId: "target",
  targetLeft: 200,
  targetTop: 100,
  targetWidth: 160,
  targetHeight: 40,
};

describe("resolvePageRefNestingIntent", () => {
  it("treats only the target's centre as a nesting drop", () => {
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 280, clientY: 120 }),
    ).toEqual({ sourceId: "source", targetId: "target" });
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 280, clientY: 111 }),
    ).toBeNull();
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 280, clientY: 129 }),
    ).toBeNull();
  });

  it("keeps the 20px side zones exclusive to column drops", () => {
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 220, clientY: 120 }),
    ).toBeNull();
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 340, clientY: 120 }),
    ).toBeNull();
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 221, clientY: 120 }),
    ).toEqual({ sourceId: "source", targetId: "target" });
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 339, clientY: 120 }),
    ).toEqual({ sourceId: "source", targetId: "target" });
  });

  it("includes the exact vertical centre-zone bounds", () => {
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 280, clientY: 112 }),
    ).toEqual({ sourceId: "source", targetId: "target" });
    expect(
      resolvePageRefNestingIntent({ ...base, clientX: 280, clientY: 128 }),
    ).toEqual({ sourceId: "source", targetId: "target" });
  });

  it("never nests a page into itself", () => {
    expect(
      resolvePageRefNestingIntent({
        ...base,
        targetId: "source",
        clientX: 280,
        clientY: 120,
      }),
    ).toBeNull();
  });

  it("rejects missing ids and invalid target geometry", () => {
    expect(
      resolvePageRefNestingIntent({
        ...base,
        sourceId: "",
        clientX: 280,
        clientY: 120,
      }),
    ).toBeNull();
    expect(
      resolvePageRefNestingIntent({
        ...base,
        targetHeight: 0,
        clientX: 280,
        clientY: 120,
      }),
    ).toBeNull();
    expect(
      resolvePageRefNestingIntent({
        ...base,
        targetWidth: 40,
        clientX: 220,
        clientY: 120,
      }),
    ).toBeNull();
    expect(
      resolvePageRefNestingIntent({
        ...base,
        clientX: Number.NaN,
        clientY: 120,
      }),
    ).toBeNull();
  });
});

describe("resolveStandalonePageRefDom", () => {
  function fixture() {
    const editor = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.className = "brain-page-ref-only";
    const anchor = document.createElement("a");
    anchor.dataset.pageRef = "target";
    anchor.href = "/p/target";
    anchor.textContent = "Target page";
    paragraph.append(anchor);
    editor.append(paragraph);
    document.body.append(editor);
    return { editor, paragraph, anchor };
  }

  it("resolves the title anchor and empty area of the same standalone row", () => {
    const { editor, paragraph, anchor } = fixture();
    expect(resolveStandalonePageRefDom(editor, anchor)).toMatchObject({
      id: "target",
      element: anchor,
      paragraph,
    });
    expect(resolveStandalonePageRefDom(editor, paragraph)).toMatchObject({
      id: "target",
      element: anchor,
      paragraph,
    });
  });

  it("rejects page refs nested below a non-root container", () => {
    const { editor, paragraph, anchor } = fixture();
    const column = document.createElement("div");
    editor.replaceChildren(column);
    column.append(paragraph);
    expect(resolveStandalonePageRefDom(editor, anchor)).toBeNull();
  });

  /** `data-cols` > `data-col` is what `columns.ts` renders. Rebuilt by hand
   *  here so the hit contract is tested against the markup, not the schema. */
  function lane(editor: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.dataset.cols = "true";
    const column = document.createElement("div");
    column.dataset.col = "true";
    row.append(column);
    editor.append(row);
    return column;
  }

  it("resolves a row that lives in a column lane", () => {
    const { editor, paragraph, anchor } = fixture();
    lane(editor).append(paragraph);
    expect(resolveStandalonePageRefDom(editor, anchor)).toMatchObject({
      id: "target",
      element: anchor,
      paragraph,
    });
    expect(resolveStandalonePageRefDom(editor, paragraph)).toMatchObject({
      id: "target",
    });
  });

  it("rejects a column that is not part of a columns row", () => {
    const { editor, paragraph, anchor } = fixture();
    const stray = document.createElement("div");
    stray.dataset.col = "true";
    editor.append(stray);
    stray.append(paragraph);
    expect(resolveStandalonePageRefDom(editor, anchor)).toBeNull();
  });

  it("rejects a column lane that belongs to an aside, not to the page", () => {
    const { editor, paragraph, anchor } = fixture();
    const callout = document.createElement("div");
    callout.dataset.callout = "true";
    editor.append(callout);
    const column = lane(callout);
    column.append(paragraph);
    expect(resolveStandalonePageRefDom(editor, anchor)).toBeNull();
  });

  it("numbers every row across lanes in document order", () => {
    const editor = document.createElement("div");
    document.body.append(editor);
    const row = (id: string, parent: HTMLElement) => {
      const paragraph = document.createElement("p");
      paragraph.className = "brain-page-ref-only";
      const anchor = document.createElement("a");
      anchor.dataset.pageRef = id;
      paragraph.append(anchor);
      parent.append(paragraph);
      return anchor;
    };
    const top = row("dup", editor);
    const columnRow = document.createElement("div");
    columnRow.dataset.cols = "true";
    editor.append(columnRow);
    const left = document.createElement("div");
    left.dataset.col = "true";
    const right = document.createElement("div");
    right.dataset.col = "true";
    columnRow.append(left, right);
    const inLeft = row("dup", left);
    const other = row("elsewhere", right);
    const inRight = row("dup", right);

    expect(standalonePageRefAnchors(editor)).toEqual([
      top,
      inLeft,
      other,
      inRight,
    ]);
    expect(
      standalonePageRefAnchors(editor).filter(
        (anchor) => anchor.dataset.pageRef === "dup",
      ),
    ).toEqual([top, inLeft, inRight]);
    editor.remove();
  });
});

const pageRefSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    page_ref: {
      atom: true,
      inline: true,
      group: "inline",
      attrs: { id: {}, label: { default: "" } },
    },
    // The layout a page row can live in, and one that it cannot.
    cols: { content: "col+", group: "block" },
    col: { content: "block+" },
    callout: { content: "block+", group: "block" },
    text: { group: "inline" },
  },
});
const cols = (...lanes: ProseNode[][]) =>
  pageRefSchema.node(
    "cols",
    null,
    lanes.map((blocks) => pageRefSchema.node("col", null, blocks)),
  );

const standaloneRef = (id: string, label: string) =>
  pageRefSchema.node("paragraph", null, [
    pageRefSchema.node("page_ref", { id, label }),
  ]);
const prose = (value: string) =>
  pageRefSchema.node("paragraph", null, pageRefSchema.text(value));

describe("findRemovedStandalonePageRef", () => {
  it("binds a text-selection deletion to the exact duplicate occurrence", () => {
    const first = standaloneRef("target", "First");
    const middle = prose("Middle");
    const second = standaloneRef("target", "Second");
    const before = pageRefSchema.node("doc", null, [first, middle, second]);
    const after = pageRefSchema.node("doc", null, [first, middle]);
    const secondPosition = first.nodeSize + middle.nodeSize;

    expect(
      findRemovedStandalonePageRef(
        before,
        after,
        secondPosition,
        secondPosition + second.nodeSize,
      ),
    ).toEqual({ id: "target", occurrence: 1, label: "Second" });
  });

  it("does not treat changing a standalone ref into an inline mention as removal", () => {
    const ref = pageRefSchema.node("page_ref", {
      id: "target",
      label: "Target",
    });
    const before = pageRefSchema.node("doc", null, [
      pageRefSchema.node("paragraph", null, [ref]),
    ]);
    const after = pageRefSchema.node("doc", null, [
      pageRefSchema.node("paragraph", null, [
        pageRefSchema.text("See "),
        ref,
      ]),
    ]);

    expect(findRemovedStandalonePageRef(before, after, 1, 1)).toBeNull();
  });

  it("does not intercept deletion of an inline page mention", () => {
    const before = pageRefSchema.node("doc", null, [
      pageRefSchema.node("paragraph", null, [
        pageRefSchema.text("See "),
        pageRefSchema.node("page_ref", {
          id: "target",
          label: "Target",
        }),
      ]),
    ]);
    const after = pageRefSchema.node("doc", null, [prose("See ")]);

    expect(findRemovedStandalonePageRef(before, after, 5, 6)).toBeNull();
  });
});

describe("findRemovedStandalonePageRef across lanes", () => {
  it("binds a deletion inside a column to its document-order occurrence", () => {
    const top = standaloneRef("target", "Top");
    const left = standaloneRef("target", "Left");
    const right = standaloneRef("target", "Right");
    const layout = cols([left], [prose("Keep"), right]);
    const before = pageRefSchema.node("doc", null, [top, layout]);
    const after = pageRefSchema.node("doc", null, [
      top,
      cols([left], [prose("Keep")]),
    ]);
    // doc > cols(+1) > col(+1) > [Keep] > right
    const rightPos =
      top.nodeSize + 2 + pageRefSchema.node("col", null, [left]).nodeSize + 1 +
      prose("Keep").nodeSize;

    expect(
      findRemovedStandalonePageRef(
        before,
        after,
        rightPos,
        rightPos + right.nodeSize,
      ),
    ).toEqual({ id: "target", occurrence: 2, label: "Right" });
  });

  it("never treats a reference inside an aside as a page row", () => {
    const inside = standaloneRef("target", "Aside");
    const before = pageRefSchema.node("doc", null, [
      pageRefSchema.node("callout", null, [inside]),
    ]);
    const after = pageRefSchema.node("doc", null, [
      pageRefSchema.node("callout", null, [prose("empty")]),
    ]);

    expect(findRemovedStandalonePageRef(before, after, 1, 1 + inside.nodeSize))
      .toBeNull();
  });
});
