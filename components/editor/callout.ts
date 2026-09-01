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

const DEFAULT_ICON = "💡";
const DEFAULT_TEXT = "Callout";
export const CALLOUT_EMOJI_EVENT = "brain-callout-emoji";

export interface CalloutEmojiEventDetail {
  pos: number;
  left: number;
  top: number;
}

function readIcon(value: unknown) {
  return typeof value === "string" && value.trim() ? value : DEFAULT_ICON;
}

export const remarkCalloutDirective = $remark(
  "remarkCalloutDirective",
  () => remarkDirectivePlugin,
);

export const calloutSchema = $nodeSchema("callout", () => ({
  content: "block+",
  group: "block",
  defining: true,
  attrs: {
    icon: { default: DEFAULT_ICON },
  },
  parseDOM: [
    {
      tag: 'div[data-callout="true"]',
      getAttrs: (dom) => ({
        icon: dom instanceof HTMLElement ? readIcon(dom.getAttribute("data-callout-icon")) : DEFAULT_ICON,
      }),
    },
  ],
  toDOM: (node: ProseNode): DOMOutputSpec => [
    "div",
    {
      "data-callout": "true",
      "data-callout-icon": node.attrs.icon,
      class: "brain-callout",
    },
    [
      "button",
      {
        type: "button",
        class: "brain-callout-icon",
        contenteditable: "false",
        "aria-label": "Change callout icon",
      },
      node.attrs.icon,
    ],
    ["div", { class: "brain-callout-content" }, 0],
  ],
  parseMarkdown: {
    match: ({ type, name }: { type: string; name?: string }) =>
      type === "containerDirective" && name === "callout",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      const attributes = node.attributes as { icon?: unknown } | undefined;
      state
        .openNode(type, { icon: readIcon(attributes?.icon) })
        .next(node.children)
        .closeNode();
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "callout",
    runner: (state: SerializerState, node: ProseNode) => {
      state
        .openNode("containerDirective", undefined, {
          name: "callout",
          attributes: { icon: readIcon(node.attrs.icon) },
        })
        .next(node.content)
        .closeNode();
    },
  },
}));

export const calloutView = $view(calloutSchema.node, () => ((
  initialNode: ProseNode,
  _view,
  getPos,
): NodeView => {
  let node = initialNode;

  const dom = document.createElement("div");
  dom.className = "brain-callout";
  dom.setAttribute("data-callout", "true");

  const iconButton = document.createElement("button");
  iconButton.type = "button";
  iconButton.className = "brain-callout-icon";
  iconButton.setAttribute("contenteditable", "false");
  iconButton.setAttribute("aria-label", "Change callout icon");
  iconButton.title = "Change callout icon";

  const contentDOM = document.createElement("div");
  contentDOM.className = "brain-callout-content";

  dom.append(iconButton, contentDOM);

  const render = (nextNode: ProseNode) => {
    node = nextNode;
    const icon = readIcon(node.attrs.icon);
    dom.setAttribute("data-callout-icon", icon);
    iconButton.textContent = icon;
  };

  const isInContent = (target: Node) =>
    target === contentDOM || contentDOM.contains(target);

  const onPointerDown = (event: PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const onClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const pos = getPos();
    if (typeof pos !== "number") return;

    const rect = iconButton.getBoundingClientRect();
    iconButton.dispatchEvent(
      new CustomEvent<CalloutEmojiEventDetail>(CALLOUT_EMOJI_EVENT, {
        bubbles: true,
        detail: {
          pos,
          left: event.clientX || rect.left,
          top: event.clientY || rect.bottom,
        },
      }),
    );
  };

  iconButton.addEventListener("pointerdown", onPointerDown);
  iconButton.addEventListener("click", onClick);
  render(initialNode);

  return {
    dom,
    contentDOM,
    update: (updatedNode: ProseNode) => {
      if (updatedNode.type.name !== "callout") return false;
      render(updatedNode);
      return true;
    },
    ignoreMutation: (mutation: ViewMutationRecord) => !isInContent(mutation.target),
    stopEvent: (event: Event) => {
      const target = event.target;
      return target instanceof Node && iconButton.contains(target);
    },
    destroy: () => {
      iconButton.removeEventListener("pointerdown", onPointerDown);
      iconButton.removeEventListener("click", onClick);
    },
  };
}) satisfies NodeViewConstructor);

export const insertCalloutCommand = $command<unknown, "InsertCallout">(
  "InsertCallout",
  (ctx) => (payload) => (state, dispatch) => {
    const icon = typeof payload === "string" ? payload : DEFAULT_ICON;
    const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(DEFAULT_TEXT));
    const node = calloutSchema.type(ctx).create({ icon: readIcon(icon) }, paragraph);

    if (!dispatch) return true;
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  },
);

export const callout = [remarkCalloutDirective, calloutSchema, calloutView, insertCalloutCommand].flat();
