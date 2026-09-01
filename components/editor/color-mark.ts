import type { MarkdownNode, Root } from "@milkdown/kit/transformer";
import type { MarkType } from "@milkdown/kit/prose/model";
import type { Command } from "@milkdown/kit/prose/state";

import { $command, $markSchema, $remark } from "@milkdown/kit/utils";

const colorNames = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "gray",
  "brown",
] as const;

export type ColorName = (typeof colorNames)[number];
type ColorPayload = ColorName | null;

const colorNameSet = new Set<string>(colorNames);

function isColorName(value: unknown): value is ColorName {
  return typeof value === "string" && colorNameSet.has(value);
}

function getSpanAttrs(dom: Node) {
  if (!(dom instanceof HTMLElement)) return false;

  const color = dom.getAttribute("data-color");
  if (!isColorName(color)) return false;

  return { color };
}

function getHighlightAttrs(dom: Node) {
  if (!(dom instanceof HTMLElement)) return false;

  const bg = dom.getAttribute("data-bg");
  if (!isColorName(bg)) return false;

  return { bg };
}

function getMarkdownAttr(node: MarkdownNode, name: "color" | "bg") {
  const value = node[name];
  return isColorName(value) ? value : null;
}

export const textColorSchema = $markSchema("textColor", () => ({
  attrs: {
    color: { validate: "string" },
  },
  parseDOM: [
    {
      tag: "span[data-color]",
      getAttrs: getSpanAttrs,
    },
  ],
  toDOM: (mark) => ["span", { "data-color": mark.attrs.color }],
  parseMarkdown: {
    match: (node) => node.type === "textColor" && isColorName(node.color),
    runner: (state, node, markType) => {
      const color = getMarkdownAttr(node, "color");
      if (!color) return;

      state.openMark(markType, { color });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "textColor",
    runner: (state, mark) => {
      const color = mark.attrs.color;
      if (isColorName(color)) {
        state.withMark(mark, "textColor", undefined, { color });
      }
    },
  },
}));

export const textHighlightSchema = $markSchema("textHighlight", () => ({
  attrs: {
    bg: { validate: "string" },
  },
  parseDOM: [
    {
      tag: "span[data-bg]",
      getAttrs: getHighlightAttrs,
    },
  ],
  toDOM: (mark) => ["span", { "data-bg": mark.attrs.bg }],
  parseMarkdown: {
    match: (node) => node.type === "textHighlight" && isColorName(node.bg),
    runner: (state, node, markType) => {
      const bg = getMarkdownAttr(node, "bg");
      if (!bg) return;

      state.openMark(markType, { bg });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === "textHighlight",
    runner: (state, mark) => {
      const bg = mark.attrs.bg;
      if (isColorName(bg)) {
        state.withMark(mark, "textHighlight", undefined, { bg });
      }
    },
  },
}));

function setNamedMark(markType: MarkType, attrs: { color?: ColorName; bg?: ColorName } | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;

    if (!dispatch) return true;

    const tr = state.tr;
    if (attrs === null) {
      if (empty) tr.removeStoredMark(markType);
      else tr.removeMark(from, to, markType);

      dispatch(tr.scrollIntoView());
      return true;
    }

    const mark = markType.create(attrs);
    if (empty) {
      tr.removeStoredMark(markType).addStoredMark(mark);
    } else {
      tr.removeMark(from, to, markType).addMark(from, to, mark);
    }

    dispatch(tr.scrollIntoView());
    return true;
  };
}

export const setTextColorCommand = $command<ColorPayload, "SetTextColor">(
  "SetTextColor",
  (ctx) => (color) => {
    if (color == null) return setNamedMark(textColorSchema.type(ctx), null);
    if (!isColorName(color)) return () => false;

    return setNamedMark(textColorSchema.type(ctx), { color });
  },
);

export const setHighlightCommand = $command<ColorPayload, "SetHighlight">(
  "SetHighlight",
  (ctx) => (bg) => {
    if (bg == null) return setNamedMark(textHighlightSchema.type(ctx), null);
    if (!isColorName(bg)) return () => false;

    return setNamedMark(textHighlightSchema.type(ctx), { bg });
  },
);

type SpanAttrs = {
  color?: ColorName;
  bg?: ColorName;
};

type ProcessorLike = {
  data: {
    (key: string): unknown;
    (key: string, value: unknown): unknown;
  };
};

type PhrasingState = {
  enter: (name: string) => () => void;
  containerPhrasing: (node: MarkdownNode, info: unknown) => string;
};

const openSpanRegex = /^<span\b([^>]*)>$/i;
const closeSpanRegex = /^<\/span\s*>$/i;
const attrRegex = /\s([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

function readSpanAttrs(value: unknown): SpanAttrs | null {
  if (typeof value !== "string") return null;

  const match = value.trim().match(openSpanRegex);
  if (!match) return null;

  const attrs: SpanAttrs = {};
  const attrText = match[1] ?? "";
  attrRegex.lastIndex = 0;

  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRegex.exec(attrText))) {
    const name = attrMatch[1]?.toLowerCase();
    const rawValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4];

    if (name === "data-color" && isColorName(rawValue)) attrs.color = rawValue;
    if (name === "data-bg" && isColorName(rawValue)) attrs.bg = rawValue;
  }

  return attrs.color || attrs.bg ? attrs : null;
}

function isOpeningSpan(node: MarkdownNode) {
  return node.type === "html" && typeof node.value === "string" && openSpanRegex.test(node.value.trim());
}

function isClosingSpan(node: MarkdownNode) {
  return node.type === "html" && typeof node.value === "string" && closeSpanRegex.test(node.value.trim());
}

function cloneWithChildren(node: MarkdownNode, children: MarkdownNode[]) {
  return {
    ...node,
    children,
  };
}

function markNode(type: "textColor" | "textHighlight", attrName: "color" | "bg", attrValue: ColorName, children: MarkdownNode[]): MarkdownNode {
  return {
    type,
    [attrName]: attrValue,
    children,
  };
}

function wrapSpanChildren(attrs: SpanAttrs, children: MarkdownNode[]) {
  let wrapped = children;

  if (attrs.bg) {
    wrapped = [markNode("textHighlight", "bg", attrs.bg, wrapped)];
  }

  if (attrs.color) {
    wrapped = [markNode("textColor", "color", attrs.color, wrapped)];
  }

  return wrapped;
}

function transformChildren(children: MarkdownNode[]): MarkdownNode[] {
  const transformed: MarkdownNode[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const child = transformNode(children[index]);
    const spanAttrs = readSpanAttrs(child.value);

    if (child.type !== "html" || !spanAttrs) {
      transformed.push(child);
      continue;
    }

    const inner: MarkdownNode[] = [];
    let depth = 1;
    let closeIndex = -1;

    for (let cursor = index + 1; cursor < children.length; cursor += 1) {
      const next = transformNode(children[cursor]);

      if (isOpeningSpan(next)) depth += 1;
      if (isClosingSpan(next)) depth -= 1;

      if (depth === 0) {
        closeIndex = cursor;
        break;
      }

      inner.push(next);
    }

    if (closeIndex === -1) {
      transformed.push(child);
      continue;
    }

    transformed.push(...wrapSpanChildren(spanAttrs, transformChildren(inner)));
    index = closeIndex;
  }

  return transformed;
}

function transformNode(node: MarkdownNode): MarkdownNode {
  if (!node.children) return node;

  return cloneWithChildren(node, transformChildren(node.children));
}

function transformColorSpanHtml(tree: Root) {
  const root = tree as unknown as MarkdownNode;
  if (root.children) root.children = transformChildren(root.children);
}

function phrasing(state: unknown, node: MarkdownNode, info: unknown) {
  return (state as PhrasingState).containerPhrasing(node, info);
}

function singleChild(node: MarkdownNode, type: "textColor" | "textHighlight") {
  const [child] = node.children ?? [];
  if ((node.children?.length ?? 0) !== 1 || child?.type !== type || !child.children) {
    return null;
  }

  return child;
}

function spanMarkdown(attrs: SpanAttrs, content: string) {
  const attrText = [
    attrs.color ? `data-color="${attrs.color}"` : null,
    attrs.bg ? `data-bg="${attrs.bg}"` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return `<span ${attrText}>${content}</span>`;
}

function sameSpanAttrs(left: SpanAttrs, right: SpanAttrs) {
  return left.color === right.color && left.bg === right.bg;
}

function commonSpanAttrs(left: SpanAttrs, right: SpanAttrs): SpanAttrs {
  return {
    color: left.color === right.color ? left.color : undefined,
    bg: left.bg === right.bg ? left.bg : undefined,
  };
}

function containsSpanAttrs(attrs: SpanAttrs, subset: SpanAttrs) {
  return (
    (!subset.color || attrs.color === subset.color) &&
    (!subset.bg || attrs.bg === subset.bg)
  );
}

function subtractSpanAttrs(attrs: SpanAttrs, subset: SpanAttrs): SpanAttrs {
  return {
    color: attrs.color && attrs.color !== subset.color ? attrs.color : undefined,
    bg: attrs.bg && attrs.bg !== subset.bg ? attrs.bg : undefined,
  };
}

function hasSpanAttr(attrs: SpanAttrs) {
  return Boolean(attrs.color || attrs.bg);
}

function mergeSpanAttrs(left: SpanAttrs, right: SpanAttrs) {
  return {
    color: left.color ?? right.color,
    bg: left.bg ?? right.bg,
  };
}

function withoutEmptyText(children: MarkdownNode[]) {
  return children.filter(
    (child) => !(child.type === "text" && typeof child.value === "string" && child.value.length === 0),
  );
}

function unwrapSpanNode(node: MarkdownNode): { attrs: SpanAttrs; children: MarkdownNode[] } | null {
  if (node.type !== "textColor" && node.type !== "textHighlight") return null;

  const attrName = node.type === "textColor" ? "color" : "bg";
  const attrValue = getMarkdownAttr(node, attrName);
  if (!attrValue || !node.children) return null;

  const attrs: SpanAttrs = { [attrName]: attrValue };
  const children = withoutEmptyText(node.children);
  const nested = children.length === 1 ? unwrapSpanNode(children[0]) : null;

  if (nested) {
    return {
      attrs: mergeSpanAttrs(attrs, nested.attrs),
      children: nested.children,
    };
  }

  return { attrs, children };
}

function extractMarkedUnit(node: MarkdownNode): { attrs: SpanAttrs; nodes: MarkdownNode[] } | null {
  const unwrapped = unwrapSpanNode(node);
  if (unwrapped) return { attrs: unwrapped.attrs, nodes: unwrapped.children };

  if (!node.children?.length) return null;

  const extracted = node.children.map(extractMarkedUnit);
  const first = extracted[0];
  if (!first || extracted.some((child) => !child || !sameSpanAttrs(first.attrs, child.attrs))) {
    return null;
  }

  return {
    attrs: first.attrs,
    nodes: [cloneWithChildren(node, extracted.flatMap((child) => child?.nodes ?? []))],
  };
}

function isWhitespaceText(node: MarkdownNode) {
  return node.type === "text" && typeof node.value === "string" && /^\s+$/.test(node.value);
}

function findNextMarked(children: MarkdownNode[], start: number) {
  for (let index = start; index < children.length; index += 1) {
    if (isWhitespaceText(children[index])) continue;

    return extractMarkedUnit(children[index]);
  }

  return null;
}

function wrapRemainingAttrs(attrs: SpanAttrs, nodes: MarkdownNode[]) {
  return hasSpanAttr(attrs) ? wrapSpanChildren(attrs, nodes) : nodes;
}

function groupSpanChildren(children: MarkdownNode[]) {
  const grouped: MarkdownNode[] = [];

  for (let index = 0; index < children.length;) {
    const extracted = extractMarkedUnit(children[index]);
    if (!extracted || !hasSpanAttr(extracted.attrs)) {
      grouped.push(children[index]);
      index += 1;
      continue;
    }

    const nextMarked = findNextMarked(children, index + 1);
    const commonAttrs = nextMarked ? commonSpanAttrs(extracted.attrs, nextMarked.attrs) : {};
    const groupAttrs = hasSpanAttr(commonAttrs) ? commonAttrs : extracted.attrs;
    const groupNodes = wrapRemainingAttrs(
      subtractSpanAttrs(extracted.attrs, groupAttrs),
      extracted.nodes,
    );
    index += 1;

    while (index < children.length) {
      const next = extractMarkedUnit(children[index]);
      if (next && containsSpanAttrs(next.attrs, groupAttrs)) {
        groupNodes.push(...wrapRemainingAttrs(subtractSpanAttrs(next.attrs, groupAttrs), next.nodes));
        index += 1;
        continue;
      }

      const afterWhitespace = children[index + 1] ? extractMarkedUnit(children[index + 1]) : null;
      if (
        isWhitespaceText(children[index]) &&
        afterWhitespace &&
        containsSpanAttrs(afterWhitespace.attrs, groupAttrs)
      ) {
        groupNodes.push(children[index]);
        index += 1;
        continue;
      }

      break;
    }

    grouped.push(...wrapSpanChildren(groupAttrs, groupNodes));
  }

  return grouped;
}

function handleParagraph(node: MarkdownNode, _parent: unknown, state: unknown, info: unknown) {
  const phrasingState = state as PhrasingState;
  const exit = phrasingState.enter("paragraph");
  const subexit = phrasingState.enter("phrasing");
  const value = phrasingState.containerPhrasing(
    cloneWithChildren(node, groupSpanChildren(node.children ?? [])),
    info,
  );

  subexit();
  exit();

  return value;
}

function handleTextColor(node: MarkdownNode, _parent: unknown, state: unknown, info: unknown) {
  const color = getMarkdownAttr(node, "color");
  if (!color) return phrasing(state, node, info);

  const highlight = singleChild(node, "textHighlight");
  const bg = highlight ? getMarkdownAttr(highlight, "bg") : null;
  if (highlight && bg) {
    return spanMarkdown({ color, bg }, phrasing(state, cloneWithChildren(node, highlight.children ?? []), info));
  }

  return spanMarkdown({ color }, phrasing(state, node, info));
}

function handleTextHighlight(node: MarkdownNode, _parent: unknown, state: unknown, info: unknown) {
  const bg = getMarkdownAttr(node, "bg");
  if (!bg) return phrasing(state, node, info);

  const colorNode = singleChild(node, "textColor");
  const color = colorNode ? getMarkdownAttr(colorNode, "color") : null;
  if (colorNode && color) {
    return spanMarkdown({ color, bg }, phrasing(state, cloneWithChildren(node, colorNode.children ?? []), info));
  }

  return spanMarkdown({ bg }, phrasing(state, node, info));
}

const colorSpanRemark = $remark("remark-color-span", () => function colorSpanRemarkPlugin(this: ProcessorLike) {
  const extension = {
    handlers: {
      paragraph: handleParagraph,
      textColor: handleTextColor,
      textHighlight: handleTextHighlight,
    },
  };
  const current = this.data("toMarkdownExtensions");
  const extensions = Array.isArray(current) ? current : [];

  this.data("toMarkdownExtensions", [...extensions, extension]);

  return transformColorSpanHtml;
});

export const colorMarks = [
  colorSpanRemark,
  textColorSchema,
  textHighlightSchema,
  setTextColorCommand,
  setHighlightCommand,
].flat();
