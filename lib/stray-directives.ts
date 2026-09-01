/** Stray directives, and what every reader of a body does with them.
 *
 *  remark-directive greedily parses `:word` in plain prose as a textDirective —
 *  "Meeting at 14:00" produced `textDirective{name:"00"}`, which no schema
 *  matches, so the whole PAGE failed to load ("Cannot match target parser").
 *  The editor answers by turning every directive Brain does not own back into
 *  literal prose before Milkdown sees the tree: a foreign container such as
 *  `:::toggle{title="T"}` from MCP `write_page` or a Notion import becomes an
 *  inline-code line, its body is hoisted to the lane it sat in, and its closer
 *  becomes another inline-code line.
 *
 *  That hoisting changes which paragraphs are rows of the page. A standalone
 *  `[Page](/p/x)` inside such a container is a row to the editor, and the
 *  editor numbers rows by document order, so anything that reads the same
 *  Markdown on the server and binds a request to "row n" has to hoist exactly
 *  the same way — `lib/page-ref-nesting.ts` parses raw mdast and once counted
 *  the container as one opaque block, and removed row n of a different list
 *  from the disk. This module is the one walk both sides run. It is free of
 *  Milkdown so the server can use it; `components/editor/columns.ts` wraps it
 *  as the remark plugin. */

/** Ownership is AST-type-specific. In particular, `empty-block` is a valid
 *  leaf directive only; accepting `:empty-block` or `:::empty-block` here lets
 *  an AST node reach a schema that cannot parse it and crashes the editor. */
const KNOWN_CONTAINER_DIRECTIVES = new Set([
  "cols",
  "col",
  "callout",
  "toggle",
]);

export type StrayDirectiveNode = {
  type: string;
  name?: string;
  value?: string;
  attributes?: Record<string, string>;
  children?: StrayDirectiveNode[];
  data?: { directiveLabel?: boolean };
  position?: {
    start?: { line?: number; column?: number; offset?: number };
    end?: { line?: number; column?: number; offset?: number };
  };
};

const EMPTY_BLOCK_MARKDOWN = "::empty-block";

function isCanonicalEmptyBlockDirective(node: StrayDirectiveNode): boolean {
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
    node.name === "empty-block" &&
    (node.children?.length ?? 0) === 0 &&
    Object.keys(node.attributes ?? {}).length === 0 &&
    sourceWidth === EMPTY_BLOCK_MARKDOWN.length
  );
}

function literalLeafDirective(node: StrayDirectiveNode, source: string | undefined): StrayDirectiveNode {
  let literal = directiveSource(node, source) ?? directiveOpening("::", node, node.children ?? []);
  if (
    source === undefined &&
    Object.keys(node.attributes ?? {}).length === 0 &&
    node.name === "empty-block" &&
    (node.children?.length ?? 0) === 0
  ) {
    // remark-directive erases the distinction between empty [] and {}. Keep
    // the non-canonical source visibly non-canonical instead of consuming it.
    literal += "{}";
  }
  // Inline code is the one Markdown form where directive punctuation cannot
  // be reinterpreted on the second parse. The whole payload stays visible.
  return {
    type: "paragraph",
    children: [{ type: "inlineCode", value: literal }],
  };
}

function directiveOpening(
  marker: ":" | "::" | ":::",
  node: StrayDirectiveNode,
  labelNodes: readonly StrayDirectiveNode[],
): string {
  let literal = `${marker}${node.name ?? ""}`;
  if (labelNodes.length > 0) {
    literal += `[${labelNodes.map(directiveLabelText).join("")}]`;
  }
  return literal + directiveAttributes(node);
}

function directiveAttributes(node: StrayDirectiveNode): string {
  const attributes = Object.entries(node.attributes ?? {});
  return attributes.length > 0
    ? `{${attributes
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(" ")}}`
    : "";
}

function literalTextDirective(
  node: StrayDirectiveNode,
  source: string | undefined,
): StrayDirectiveNode[] {
  const children = node.children ?? [];
  const literal =
    directiveSource(node, source) ?? directiveOpening(":", node, children);
  // remark-directive greedily recognizes ordinary prose fragments such as
  // `14:00` and `1:2`. A plain text node merges back into the surrounding prose
  // and therefore keeps both the rendered text and serialized bytes unchanged.
  if (children.length === 0) return [{ type: "text", value: literal }];

  const nodeStart = node.position?.start?.offset;
  const nodeEnd = node.position?.end?.offset;
  const labelStart = children[0].position?.start?.offset;
  const labelEnd = children.at(-1)?.position?.end?.offset;
  const hasExactSegments =
    source !== undefined &&
    typeof nodeStart === "number" &&
    typeof nodeEnd === "number" &&
    typeof labelStart === "number" &&
    typeof labelEnd === "number" &&
    nodeStart <= labelStart &&
    labelStart <= labelEnd &&
    labelEnd <= nodeEnd &&
    nodeEnd <= source.length;
  const prefix = hasExactSegments
    ? source.slice(nodeStart, labelStart)
    : `:${node.name ?? ""}[`;
  const suffix = hasExactSegments
    ? source.slice(labelEnd, nodeEnd)
    : `]${directiveAttributes(node)}`;

  // Keep delimiter punctuation as literal text while retaining the original
  // rich label nodes. Strong/emphasis, links (including destinations), and
  // inline code remain semantic editor content instead of code-styled source.
  return [
    ...(prefix ? [{ type: "text", value: prefix }] : []),
    ...children,
    ...(suffix ? [{ type: "text", value: suffix }] : []),
  ];
}

function containerLabelAndBody(node: StrayDirectiveNode): {
  hasLabel: boolean;
  label: StrayDirectiveNode[];
  body: StrayDirectiveNode[];
} {
  const children = node.children ?? [];
  const hasLabel = children[0]?.data?.directiveLabel === true;
  const label = hasLabel
    ? children[0].children ?? []
    : [];
  return { hasLabel, label, body: hasLabel ? children.slice(1) : children };
}

function literalContainerDirective(node: StrayDirectiveNode, source: string | undefined): StrayDirectiveNode[] {
  const { label, body } = containerLabelAndBody(node);
  const literalSource = directiveSource(node, source);
  const sourceLines = literalSource?.split(/\r?\n/);
  const opening = sourceLines?.[0] ?? directiveOpening(":::", node, label);
  const closing = explicitContainerClosing(sourceLines);
  const literal: StrayDirectiveNode[] = [
    {
      type: "paragraph",
      children: [
        { type: "inlineCode", value: opening },
      ],
    },
    ...body,
  ];
  if (closing !== undefined) {
    literal.push({
      type: "paragraph",
      children: [{ type: "inlineCode", value: closing }],
    });
  }
  return literal;
}

/** The explicit closing line of a container directive's source, or undefined
 *  when the container runs to the end of its parent unclosed. */
export function explicitContainerClosing(
  sourceLines: readonly string[] | undefined,
): string | undefined {
  if (!sourceLines || sourceLines.length < 2) return undefined;
  const opening = /^ {0,3}(:{3,})[^:\s]/.exec(sourceLines[0]);
  const closing = /^ {0,3}(:{3,})[ \t]*$/.exec(sourceLines.at(-1) ?? "");
  if (!opening || !closing || closing[1].length < opening[1].length) {
    return undefined;
  }
  return sourceLines.at(-1);
}

function directiveSource(node: StrayDirectiveNode, source: string | undefined): string | undefined {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (
    source === undefined ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end < start ||
    end > source.length
  ) {
    return undefined;
  }
  return source.slice(start, end);
}

function isKnownContainerDirective(node: StrayDirectiveNode): boolean {
  const { hasLabel } = containerLabelAndBody(node);
  if (hasLabel) return false;
  const keys = Object.keys(node.attributes ?? {});
  if (node.name === "cols" || node.name === "col") return keys.length === 0;
  if (node.name === "callout") {
    return keys.every((key) => key === "icon");
  }
  if (node.name === "toggle") {
    return keys.every((key) => key === "summary");
  }
  return false;
}

function directiveLabelText(node: StrayDirectiveNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(directiveLabelText).join("");
}

/** Rewrite every directive Brain does not own into literal prose, in place.
 *  `source` is the Markdown the tree was parsed from; with it the literal is
 *  the exact bytes, without it the directive is respelled. */
export function stripStrayDirectiveNodes(
  tree: unknown,
  source: string | undefined,
): void {
  const walk = (node: StrayDirectiveNode) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.flatMap((child): StrayDirectiveNode[] => {
      walk(child);
      // Brain owns no text directives. Preserve every one as literal prose.
      if (child.type === "textDirective") {
        return literalTextDirective(child, source);
      }
      if (child.type === "leafDirective") {
        if (isCanonicalEmptyBlockDirective(child)) return [child];
        return [literalLeafDirective(child, source)];
      }
      if (
        child.type === "containerDirective" &&
        (!KNOWN_CONTAINER_DIRECTIVES.has(child.name ?? "") ||
          !isKnownContainerDirective(child))
      ) {
        return literalContainerDirective(child, source);
      }
      return [child];
    });
  };
  walk(tree as StrayDirectiveNode);
}
