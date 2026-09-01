import type {
  DOMOutputSpec,
  Node as ProseNode,
  NodeType,
} from "@milkdown/kit/prose/model";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $nodeSchema, $remark } from "@milkdown/kit/utils";
import remarkDirectivePlugin from "remark-directive";

export const EMPTY_BLOCK_DIRECTIVE = "empty-block";
export const EMPTY_BLOCK_MARKDOWN = `::${EMPTY_BLOCK_DIRECTIVE}`;

type EmptyBlockMarkdownNode = MarkdownNode & {
  type: "leafDirective";
  name: typeof EMPTY_BLOCK_DIRECTIVE;
  attributes?: Record<string, string>;
};

/** Only the canonical source spelling is owned by the empty-block primitive.
 * Directive labels/attributes carry user data and must stay literal prose. */
export function isCanonicalEmptyBlockMarkdownNode(
  node: MarkdownNode,
): node is EmptyBlockMarkdownNode {
  const start = node.position?.start;
  const end = node.position?.end;
  const sourceWidth =
    typeof start?.offset === "number" && typeof end?.offset === "number"
      ? end.offset - start.offset
      : start?.line === end?.line &&
          typeof start?.column === "number" &&
          typeof end?.column === "number"
        ? end.column - start.column
        : undefined;
  return (
    node.type === "leafDirective" &&
    node.name === EMPTY_BLOCK_DIRECTIVE &&
    (node.children?.length ?? 0) === 0 &&
    Object.keys(node.attributes ?? {}).length === 0 &&
    sourceWidth === EMPTY_BLOCK_MARKDOWN.length
  );
}

/** CommonMark collapses repeated blank lines. This textblock stores one
 * explicit empty paragraph; once text is entered it becomes normal Markdown. */
export const remarkEmptyBlockDirective = $remark(
  "remarkEmptyBlockDirective",
  () => remarkDirectivePlugin,
);

export const emptyBlockSchema = $nodeSchema("empty_block", () => ({
  content: "inline*",
  group: "block",
  defining: false,
  parseDOM: [{ tag: 'p[data-empty-block="true"]' }],
  toDOM: (): DOMOutputSpec => [
    "p",
    { "data-empty-block": "true", class: "brain-empty-block" },
    0,
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => isCanonicalEmptyBlockMarkdownNode(node),
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      if (!isCanonicalEmptyBlockMarkdownNode(node)) return;
      state.openNode(type).next(node.children ?? []).closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "empty_block",
    runner: (state: SerializerState, node: ProseNode) => {
      if (node.content.size === 0) {
        state.addNode("leafDirective", [], undefined, {
          name: EMPTY_BLOCK_DIRECTIVE,
        });
        return;
      }
      state.openNode("paragraph").next(node.content).closeNode();
    },
  },
}));

export const emptyBlocks = [remarkEmptyBlockDirective, emptyBlockSchema].flat();
