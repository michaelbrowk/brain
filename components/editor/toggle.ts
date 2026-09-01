import type {
  DOMOutputSpec,
  Node as ProseNode,
  NodeType,
} from "@milkdown/kit/prose/model";
import type { NodeView, NodeViewConstructor, ViewMutationRecord } from "@milkdown/kit/prose/view";
import type {
  MarkdownNode,
  ParserState,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $command, $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import remarkDirectivePlugin from "remark-directive";

const DEFAULT_SUMMARY = "Toggle";
const DEFAULT_TEXT = "Hidden content";

function readSummary(value: unknown) {
  return typeof value === "string" && value.trim() ? value : DEFAULT_SUMMARY;
}

function createToggleArrow() {
  const arrow = document.createElement("span");
  arrow.className = "brain-toggle-arrow";
  arrow.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m9 5l6 7l-6 7");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-width", "1.5");

  svg.append(path);
  arrow.append(svg);
  return arrow;
}

export const remarkToggleDirective = $remark(
  "remarkToggleDirective",
  () => remarkDirectivePlugin,
);

export const toggleSchema = $nodeSchema("toggle", () => ({
  content: "block+",
  group: "block",
  defining: true,
  isolating: true,
  attrs: {
    summary: { default: DEFAULT_SUMMARY },
  },
  parseDOM: [
    {
      tag: 'details[data-toggle="true"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return { summary: DEFAULT_SUMMARY };
        const summary = dom.querySelector("summary .brain-toggle-summary")?.textContent;
        return { summary: readSummary(summary) };
      },
    },
  ],
  toDOM: (node: ProseNode): DOMOutputSpec => [
    "details",
    {
      "data-toggle": "true",
      class: "brain-toggle",
    },
    [
      "summary",
      { class: "brain-toggle-head", contenteditable: "false" },
      [
        "span",
        { class: "brain-toggle-arrow", "aria-hidden": "true" },
        [
          "http://www.w3.org/2000/svg svg",
          {
            viewBox: "0 0 24 24",
            width: "16",
            height: "16",
            fill: "none",
          },
          [
            "path",
            {
              d: "m9 5l6 7l-6 7",
              stroke: "currentColor",
              "stroke-linecap": "round",
              "stroke-linejoin": "round",
              "stroke-width": "1.5",
            },
          ],
        ],
      ],
      ["span", { class: "brain-toggle-summary" }, node.attrs.summary],
    ],
    ["div", { class: "brain-toggle-content" }, 0],
  ],
  parseMarkdown: {
    match: ({ type, name }: { type: string; name?: string }) =>
      type === "containerDirective" && name === "toggle",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      const attributes = node.attributes as { summary?: unknown } | undefined;
      state
        .openNode(type, { summary: readSummary(attributes?.summary) })
        .next(node.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "toggle",
    runner: (state: SerializerState, node: ProseNode) => {
      state
        .openNode("containerDirective", undefined, {
          name: "toggle",
          attributes: { summary: readSummary(node.attrs.summary) },
        })
        .next(node.content)
        .closeNode();
    },
  },
}));

export const toggleView = $view(toggleSchema.node, () => ((initialNode: ProseNode): NodeView => {
  const details = document.createElement("details");
  details.className = "brain-toggle";
  details.setAttribute("data-toggle", "true");
  details.open = true;

  const summary = document.createElement("summary");
  summary.className = "brain-toggle-head";
  summary.setAttribute("contenteditable", "false");

  const summaryText = document.createElement("span");
  summaryText.className = "brain-toggle-summary";

  const contentDOM = document.createElement("div");
  contentDOM.className = "brain-toggle-content";

  summary.append(createToggleArrow(), summaryText);
  details.append(summary, contentDOM);

  const render = (node: ProseNode) => {
    summaryText.textContent = readSummary(node.attrs.summary);
  };

  const isInContent = (target: Node) =>
    target === contentDOM || contentDOM.contains(target);

  render(initialNode);

  return {
    dom: details,
    contentDOM,
    update: (node: ProseNode) => {
      if (node.type.name !== "toggle") return false;
      render(node);
      return true;
    },
    ignoreMutation: (mutation: ViewMutationRecord) => {
      if (isInContent(mutation.target)) return false;
      if (mutation.type === "attributes" && mutation.target === details) return true;
      if (mutation.target === summary || summary.contains(mutation.target)) return true;
      return true;
    },
    stopEvent: (event: Event) => {
      const target = event.target;
      return target instanceof Node && summary.contains(target);
    },
  };
}) satisfies NodeViewConstructor);

export const insertToggleCommand = $command<unknown, "InsertToggle">(
  "InsertToggle",
  (ctx) => (payload) => (state, dispatch) => {
    const summary = typeof payload === "string" ? payload : DEFAULT_SUMMARY;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(DEFAULT_TEXT));
    const node = toggleSchema.type(ctx).create({ summary: readSummary(summary) }, paragraph);

    if (!dispatch) return true;
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  },
);

export const toggle = [remarkToggleDirective, toggleSchema, toggleView, insertToggleCommand].flat();
