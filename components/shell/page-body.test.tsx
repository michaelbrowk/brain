// @vitest-environment jsdom

// PageBody composes the editor `key` and hands Shell's flush registration
// straight to the editor. A wrong key here either keeps a stale editor
// alive across a page switch / history restore or remounts it on every
// keystroke; a re-wrapped `registerFlush` breaks the flush-before-save
// contract. PageBody has no hooks, so the element tree it returns is
// inspected directly — the key is read off the editor element itself.

import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/lib/store/types";
import { PageBody, type PageBodyProps } from "./page-body";

vi.mock("next/dynamic", () => ({
  default: () =>
    function FakeEditor() {
      return null;
    },
}));

const STAMP = "2026-08-01T08:00:00.000Z";

function node(id: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id,
    parentId: null,
    title: id,
    order: id,
    created: STAMP,
    updated: STAMP,
    hasChildren: false,
    children: [],
    ...extra,
  };
}

function baseProps(overrides: Partial<PageBodyProps> = {}): PageBodyProps {
  const registerFlush = vi.fn(() => () => {});
  return {
    page: {
      id: "alpha",
      title: "Alpha",
      stickers: [],
      markdown: "# Alpha",
      rev: "rev-1",
    },
    currentNode: node("alpha"),
    isBoard: false,
    isCollection: false,
    onSelect: vi.fn(),
    onMoveCard: vi.fn(),
    onAddCard: vi.fn(),
    onAddColumn: vi.fn(),
    onRenameColumn: vi.fn(),
    onDeleteColumn: vi.fn(),
    onSetTags: vi.fn(),
    contextMenu: {
      onAddChild: vi.fn(),
      onRename: vi.fn(),
      onCopyLink: vi.fn(),
      onDuplicate: vi.fn(),
      onDialogIntent: vi.fn(),
      onMoveRequest: vi.fn(),
      onTogglePin: vi.fn(),
      onDelete: vi.fn(),
    },
    onEditorContextMenuCapture: vi.fn(),
    editorEpoch: 0,
    nestingEditor: null,
    pageRefRestorePending: false,
    editorValue: "# Alpha",
    onChange: vi.fn(),
    onEditorDirty: vi.fn(),
    onEditorSerialized: vi.fn(),
    registerFlush,
    pages: [],
    searchHighlight: null,
    onSearchHighlightStatus: vi.fn(),
    onReparentPageRef: vi.fn(() => null),
    onRequestRemovePageRef: vi.fn(),
    onCreatePageAtCursor: vi.fn(async () => {}),
    subpages: [],
    ...overrides,
  };
}

/** The editor element inside the tree PageBody returns for a plain page:
 *  PageContextMenu → div → [MilkdownEditor, Subpages]. */
function editorElement(props: PageBodyProps): ReactElement<
  Record<string, unknown>
> {
  const menu = PageBody(props) as ReactElement<{ children: ReactElement }>;
  const host = menu.props.children as ReactElement<{
    children: ReactElement[];
  }>;
  const [editor] = host.props.children;
  if (!isValidElement(editor)) throw new Error("editor element missing");
  return editor as ReactElement<Record<string, unknown>>;
}

describe("PageBody editor key", () => {
  it("composes page id, epoch, nesting and restore state", () => {
    expect(editorElement(baseProps()).key).toBe("ed-alpha-0-ready-editable");
  });

  it("changes with the page", () => {
    const props = baseProps({
      page: { ...baseProps().page, id: "beta" },
      currentNode: node("beta"),
    });
    expect(editorElement(props).key).toBe("ed-beta-0-ready-editable");
  });

  it("changes with a history restore (editorEpoch)", () => {
    expect(editorElement(baseProps({ editorEpoch: 3 })).key).toBe(
      "ed-alpha-3-ready-editable",
    );
  });

  it("changes while a page-ref nesting operation targets this page only", () => {
    const nesting = { pageId: "alpha", sourceId: "ref", occurrence: 0 };
    expect(editorElement(baseProps({ nestingEditor: nesting })).key).toBe(
      "ed-alpha-0-nesting-editable",
    );
    expect(
      editorElement(
        baseProps({ nestingEditor: { ...nesting, pageId: "other" } }),
      ).key,
    ).toBe("ed-alpha-0-ready-editable");
  });

  it("changes while a removed page-ref is being restored", () => {
    const editor = editorElement(baseProps({ pageRefRestorePending: true }));
    expect(editor.key).toBe("ed-alpha-0-ready-restoring");
    expect(editor.props.mutationsFrozen).toBe(true);
  });

  it("does not change with the editor value", () => {
    expect(editorElement(baseProps({ editorValue: "# Alpha\n\nmore" })).key).toBe(
      editorElement(baseProps()).key,
    );
  });
});

describe("PageBody editor wiring", () => {
  it("passes Shell's registerFlush through by identity", () => {
    const props = baseProps();
    expect(editorElement(props).props.registerFlush).toBe(props.registerFlush);
  });

  it("binds onChange / onDirty / onSerialized to the rendered page id", () => {
    const props = baseProps();
    const editor = editorElement(props).props as {
      onChange: (md: string) => void;
      onDirty: () => void;
      onSerialized: () => void;
    };
    editor.onChange("# Alpha edited");
    editor.onDirty();
    editor.onSerialized();
    expect(props.onChange).toHaveBeenCalledWith("alpha", "# Alpha edited");
    expect(props.onEditorDirty).toHaveBeenCalledWith("alpha");
    expect(props.onEditorSerialized).toHaveBeenCalledWith("alpha");
  });

  it("hands the search highlight to the editor only for its own page", () => {
    const highlight: NonNullable<PageBodyProps["searchHighlight"]> = {
      requestId: 1,
      pageId: "alpha",
      target: { exact: "Alpha", occurrence: 0, before: "", after: "" },
    };
    expect(
      editorElement(baseProps({ searchHighlight: highlight })).props
        .searchHighlight,
    ).toBe(highlight);
    expect(
      editorElement(
        baseProps({ searchHighlight: { ...highlight, pageId: "beta" } }),
      ).props.searchHighlight,
    ).toBeNull();
  });
});
