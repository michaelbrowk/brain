import type {
  Node as ProseNode,
  NodeType,
  ResolvedPos,
} from "@milkdown/kit/prose/model";
import type { MarkdownNode, ParserState, SerializerState } from "@milkdown/kit/transformer";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import remarkDirectivePlugin from "remark-directive";
import { stripStrayDirectiveNodes } from "@/lib/stray-directives";

/** Notion-style column layout.
 *
 *  Stored as remark container directives so it round-trips through plain
 *  markdown reliably:
 *
 *    :::cols
 *    :::col
 *    ## Calendars
 *    [📅 2026](/p/…)
 *    :::
 *    :::col
 *    ## Culture
 *    :::
 *    :::
 *
 *  `cols` holds `col+`, each `col` holds normal block content — so headings,
 *  links, and prose live inside a column and drag/edit like anywhere else. */

export const remarkDirective = $remark("remarkDirective", () => remarkDirectivePlugin);

function sourceText(file: unknown): string | undefined {
  const value = (file as { value?: unknown } | undefined)?.value;
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return undefined;
}

/** The editor's half of `lib/stray-directives.ts`: every directive Brain does
 *  not own becomes literal prose before Milkdown sees the tree. The walk lives
 *  in `lib/` because the server has to hoist the same rows out of the same
 *  containers when it binds a request to "row n" of a body. */
export const stripStrayDirectives = $remark(
  "stripStrayDirectives",
  () => () => (tree: unknown, file: unknown) => {
    stripStrayDirectiveNodes(tree, sourceText(file));
  },
);

export const colsSchema = $nodeSchema("cols", () => ({
  content: "col+",
  group: "block",
  selectable: false,
  parseDOM: [{ tag: 'div[data-cols="true"]' }],
  toDOM: () => ["div", { "data-cols": "true", class: "brain-cols" }, 0],
  parseMarkdown: {
    match: (node: MarkdownNode) =>
      node.type === "containerDirective" && node.name === "cols",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.openNode(type).next(node.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "cols",
    runner: (state: SerializerState, node: ProseNode) => {
      state.openNode("containerDirective", undefined, { name: "cols" }).next(node.content).closeNode();
    },
  },
}));

export const colSchema = $nodeSchema("col", () => ({
  content: "block+",
  defining: true,
  // NB: not `isolating` — that made a column a hard drag/selection boundary, so
  // blocks couldn't be dragged in/out/between columns (the People page felt like
  // drag was fully broken)
  parseDOM: [{ tag: 'div[data-col="true"]' }],
  toDOM: () => ["div", { "data-col": "true", class: "brain-col" }, 0],
  parseMarkdown: {
    match: (node: MarkdownNode) =>
      node.type === "containerDirective" && node.name === "col",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.openNode(type).next(node.children).closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "col",
    runner: (state: SerializerState, node: ProseNode) => {
      state.openNode("containerDirective", undefined, { name: "col" }).next(node.content).closeNode();
    },
  },
}));

export const COLS_SELECTOR = 'div[data-cols="true"]';
export const COL_SELECTOR = 'div[data-col="true"]';

/** A **block lane** is a container that only places blocks — the document
 *  itself, and a column inside a `cols` row. A lane carries no meaning of its
 *  own, so a block sitting directly in one is still a plain block of the page:
 *  a heading is a section heading, a page reference on its own line is a row of
 *  this page's children. Two columns are one page laid out in two lanes.
 *
 *  Every other block container says something about what it holds — a list item
 *  is an item, a quote is quoted, a callout is an aside, a toggle is folded
 *  detail, a table cell is a cell. A page link inside one of those is part of
 *  that content, not a row of the page, and gestures that restructure the page
 *  must leave it alone.
 *
 *  Lane-ness runs all the way up: a `cols` row inside a callout is the callout's
 *  content, so its columns are lanes of the aside, not of the page.
 *
 *  Two mirrors of one rule, because a drag hit-tests DOM while the mutation it
 *  arms edits the document. `parseDOM`/`toDOM` above are what keeps them the
 *  same rule — a `col` is `div[data-col]` inside `div[data-cols]`, nothing
 *  else — so the two must be changed together. */
export function isBlockLaneDepth($pos: ResolvedPos, depth: number): boolean {
  if (depth < 0 || depth > $pos.depth) return false;
  const node = $pos.node(depth);
  if (node.type.name === "doc") return depth === 0;
  return (
    depth >= 2 &&
    node.type.name === "col" &&
    $pos.node(depth - 1).type.name === "cols" &&
    isBlockLaneDepth($pos, depth - 2)
  );
}

export function isBlockLaneElement(
  editor: HTMLElement,
  element: Element | null | undefined,
): boolean {
  if (!element) return false;
  if (element === editor) return true;
  if (!editor.contains(element) || !element.matches(COL_SELECTOR)) return false;
  const row = element.parentElement;
  return (
    !!row?.matches(COLS_SELECTOR) && isBlockLaneElement(editor, row.parentElement)
  );
}

export const columns = [remarkDirective, stripStrayDirectives, colsSchema, colSchema].flat();
