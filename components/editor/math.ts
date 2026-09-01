import type { Node as ProseNode, NodeType } from "@milkdown/kit/prose/model";
import type { MarkdownNode, ParserState, Root, SerializerState } from "@milkdown/kit/transformer";
import { $command, $inputRule, $nodeSchema, $remark } from "@milkdown/kit/utils";
import { nodeRule } from "@milkdown/kit/prose";

type MutableMarkdownNode = MarkdownNode & {
  children?: MutableMarkdownNode[];
  value?: string;
};

type RemarkProcessor = {
  data: () => {
    toMarkdownExtensions?: unknown[];
  };
};

type ToMarkdownHandler = ((node: MutableMarkdownNode) => string) & {
  peek?: () => string;
};

type PositionedMarkdownNode = MutableMarkdownNode & {
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

const INLINE_MATH_NODE = "brainInlineMath";
const BLOCK_MATH_NODE = "brainBlockMath";

function isEscaped(value: string, index: number) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function isSingleDollar(value: string, index: number) {
  return (
    value[index] === "$" &&
    value[index - 1] !== "$" &&
    value[index + 1] !== "$" &&
    !isEscaped(value, index)
  );
}

function findSingleDollar(value: string, from: number) {
  for (let index = from; index < value.length; index += 1) {
    if (isSingleDollar(value, index)) return index;
  }
  return -1;
}

/** Undo markdown source encoding for text that goes back into an mdast text
 *  node. Math detection runs on the RAW source slice (to honour `\$`), but an
 *  mdast text node holds DECODED content — feeding it raw text made
 *  remark-stringify escape the escapes (`\[` → `\\\[`, `&#x20;` → `\&#x20;`),
 *  so every open+save cycle rewrote lines the user never touched and minted
 *  phantom revs. */
function decodeInlineRaw(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(
      /&(amp|lt|gt|quot|apos);/g,
      (_, n) =>
        (({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }) as Record<string, string>)[n],
    )
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

/** Split raw text around `$…$` pairs. Returns null when there is no inline
 *  math — the caller must keep the ORIGINAL (already-decoded) node untouched. */
function splitInlineMath(value: string): MutableMarkdownNode[] | null {
  const nodes: MutableMarkdownNode[] = [];
  let cursor = 0;
  let found = false;

  while (cursor < value.length) {
    const start = findSingleDollar(value, cursor);
    if (start < 0) break;

    const end = findSingleDollar(value, start + 1);
    if (end < 0) break;

    const math = value.slice(start + 1, end);
    if (!math || /^\s+$/.test(math)) {
      cursor = start + 1;
      continue;
    }

    if (start > cursor)
      nodes.push({ type: "text", value: decodeInlineRaw(value.slice(cursor, start)) });
    nodes.push({ type: INLINE_MATH_NODE, value: math });
    found = true;
    cursor = end + 1;
  }

  if (!found) return null;
  if (cursor < value.length)
    nodes.push({ type: "text", value: decodeInlineRaw(value.slice(cursor)) });
  return nodes;
}

function blockMathValue(value: string) {
  const match = /^\$\$([\s\S]*?)\$\$$/.exec(value);
  if (!match) return null;

  let math = match[1] ?? "";
  if (math.startsWith("\n")) math = math.slice(1);
  if (math.endsWith("\n")) math = math.slice(0, -1);
  return math;
}

function rawNodeValue(node: MutableMarkdownNode, source: string) {
  const positioned = node as PositionedMarkdownNode;
  const start = positioned.position?.start?.offset;
  const end = positioned.position?.end?.offset;
  if (typeof start === "number" && typeof end === "number" && end >= start) {
    return source.slice(start, end);
  }
  return typeof node.value === "string" ? node.value : "";
}

function asBlockMath(node: MutableMarkdownNode, source: string): MutableMarkdownNode | null {
  if (node.type !== "paragraph" || node.children?.length !== 1) return null;

  const child = node.children[0];
  if (child?.type !== "text" || typeof child.value !== "string") return null;

  const value = blockMathValue(rawNodeValue(child, source));
  if (value == null) return null;

  return { type: BLOCK_MATH_NODE, value };
}

function transformMath(node: MutableMarkdownNode, source: string) {
  if (!Array.isArray(node.children)) return;

  const children: MutableMarkdownNode[] = [];
  for (const child of node.children) {
    const blockMath = asBlockMath(child, source);
    if (blockMath) {
      children.push(blockMath);
      continue;
    }

    transformMath(child, source);

    if (child.type === "text" && typeof child.value === "string") {
      children.push(...(splitInlineMath(rawNodeValue(child, source)) ?? [child]));
    } else if (Array.isArray(child.children) && child.type !== "code") {
      child.children = child.children.flatMap(
        (grandchild) =>
          (grandchild.type === "text" && typeof grandchild.value === "string"
            ? splitInlineMath(rawNodeValue(grandchild, source))
            : null) ?? [grandchild],
      );
      children.push(child);
    } else {
      children.push(child);
    }
  }

  node.children = children;
}

function getMathAttr(value: unknown) {
  return typeof value === "string" ? value : "";
}

function blockMarkdown(value: string) {
  return value.includes("\n") ? `$$\n${value}\n$$` : `$$${value}$$`;
}

const inlineMathToMarkdown: ToMarkdownHandler = (node) => `$${getMathAttr(node.value)}$`;
inlineMathToMarkdown.peek = () => "$";

function mathToMarkdownExtension() {
  return {
    handlers: {
      [INLINE_MATH_NODE]: inlineMathToMarkdown,
      [BLOCK_MATH_NODE]: (node: MutableMarkdownNode) => blockMarkdown(getMathAttr(node.value)),
    },
  };
}

export const remarkMathFallback = $remark("brainMathFallback", () => function brainMathFallback(this: RemarkProcessor) {
  const data = this.data();
  const toMarkdownExtensions = data.toMarkdownExtensions ?? (data.toMarkdownExtensions = []);
  toMarkdownExtensions.push(mathToMarkdownExtension());

  return (tree: Root, file: { value?: unknown }) => {
    const source = typeof file.value === "string" ? file.value : "";
    transformMath(tree as unknown as MutableMarkdownNode, source);
  };
});

export const mathInlineSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  attrs: {
    value: { default: "" },
  },
  parseDOM: [
    {
      tag: 'span[data-brain-math-inline="true"]',
      getAttrs: (dom) => ({
        value: dom instanceof HTMLElement ? getMathAttr(dom.getAttribute("data-value")) : "",
      }),
    },
  ],
  toDOM: (node: ProseNode) => [
    "span",
    {
      "data-brain-math-inline": "true",
      "data-value": getMathAttr(node.attrs.value),
      class: "brain-math-inline",
      contenteditable: "false",
    },
    ["code", getMathAttr(node.attrs.value)],
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === INLINE_MATH_NODE,
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.addNode(type, { value: getMathAttr(node.value) });
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "math_inline",
    runner: (state: SerializerState, node: ProseNode) => {
      state.addNode(INLINE_MATH_NODE, undefined, getMathAttr(node.attrs.value));
    },
  },
}));

export const mathBlockSchema = $nodeSchema("math_block", () => ({
  content: "text*",
  group: "block",
  marks: "",
  code: true,
  defining: true,
  isolating: true,
  parseDOM: [{ tag: 'pre[data-brain-math-block="true"]', preserveWhitespace: "full" }],
  toDOM: () => [
    "pre",
    {
      "data-brain-math-block": "true",
      class: "brain-math-block",
      spellcheck: "false",
    },
    ["code", 0],
  ],
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === BLOCK_MATH_NODE,
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.openNode(type);
      const value = getMathAttr(node.value);
      if (value) state.addText(value);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "math_block",
    runner: (state: SerializerState, node: ProseNode) => {
      state.addNode(BLOCK_MATH_NODE, undefined, node.textContent);
    },
  },
}));

export const insertMathBlockCommand = $command<unknown, "InsertMathBlock">(
  "InsertMathBlock",
  (ctx) => (payload) => (state, dispatch) => {
    const value = typeof payload === "string" ? payload : "";
    const content = value ? state.schema.text(value) : undefined;
    const node = mathBlockSchema.type(ctx).create(null, content);

    if (!dispatch) return true;
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  },
);

export const mathInlineInputRule = $inputRule((ctx) =>
  nodeRule(/(?:\$)([^$]+)(?:\$)$/, mathInlineSchema.type(ctx), {
    getAttr: (match) => ({
      value: match[1] ?? "",
    }),
  }),
);

export const math = [
  remarkMathFallback,
  mathInlineSchema,
  mathBlockSchema,
  insertMathBlockCommand,
  mathInlineInputRule,
].flat();
