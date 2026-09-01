import type {
  Node as ProseNode,
  NodeType,
} from "@milkdown/kit/prose/model";
import type { EditorView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import type {
  JSONRecord,
  MarkdownNode,
  ParserState,
  Root,
  SerializerState,
} from "@milkdown/kit/transformer";
import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { SOLAR } from "@/components/ui/solar-icons.generated";

type ImageAlign = "left" | "center" | "right";

const ALIGNMENTS = ["left", "center", "right"] as const;
const MIN_IMAGE_WIDTH = 120;

/** Solar glyphs for the alignment chrome (inline SVG — this NodeView is
 *  plain DOM, not React, so it cannot mount <Icon/>). */
const ALIGN_ICONS: Record<ImageAlign, string> = {
  left: "align-left-linear",
  center: "align-horizontal-center-linear",
  right: "align-right-linear",
};

function alignIconSvg(align: ImageAlign) {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">${SOLAR[ALIGN_ICONS[align]] ?? ""}</svg>`;
}

function isImageAlign(value: unknown): value is ImageAlign {
  return typeof value === "string" && ALIGNMENTS.includes(value as ImageAlign);
}

function readWidth(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

function parseLayoutTitle(title: unknown): { width: number | null; align: ImageAlign | null } {
  if (typeof title !== "string" || !title.trim()) return { width: null, align: null };

  let width: number | null = null;
  let align: ImageAlign | null = null;

  for (const part of title.trim().split(/\s+/)) {
    const widthMatch = /^w=(\d+)(?:px)?$/.exec(part);
    if (widthMatch) {
      width = Number(widthMatch[1]);
      continue;
    }

    const alignMatch = /^align=(left|center|right)$/.exec(part);
    if (alignMatch) align = alignMatch[1] as ImageAlign;
  }

  return { width: readWidth(width), align };
}

function readLegacyTitle(title: unknown) {
  if (typeof title !== "string" || !title.trim()) return null;
  const layout = parseLayoutTitle(title);
  return layout.width || layout.align ? null : title;
}

function layoutTitle(width: unknown, align: unknown) {
  const parts: string[] = [];
  const safeWidth = readWidth(width);
  if (safeWidth) parts.push(`w=${safeWidth}`);
  if (isImageAlign(align)) parts.push(`align=${align}`);
  return parts.length ? parts.join(" ") : undefined;
}

function attrsFromMarkdownImage(node: MarkdownNode) {
  const layout = parseLayoutTitle(node.title);
  return {
    src: typeof node.url === "string" ? node.url : "",
    alt: typeof node.alt === "string" ? node.alt : "",
    width: layout.width,
    align: layout.align,
    title: readLegacyTitle(node.title),
  };
}

function walkStandaloneImages(node: MarkdownNode) {
  if (!Array.isArray(node.children)) return;

  node.children = node.children.map((child) => {
    if (child?.type === "image") return { ...child, type: "brainImage" };

    if (child?.type === "paragraph") {
      if (
        Array.isArray(child.children) &&
        child.children.length === 1 &&
        child.children[0]?.type === "image"
      ) {
        return { ...child.children[0], type: "brainImage" };
      }
      return child;
    }

    walkStandaloneImages(child);
    return child;
  });
}

export const remarkBrainImage = $remark("remarkBrainImage", () => () => (tree: Root) => {
  walkStandaloneImages(tree as unknown as MarkdownNode);
});

export const brainImageSchema = $nodeSchema("brain_image", () => ({
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  defining: true,
  // NB: not `isolating` — an atom needs no content boundary, and isolating
  // blocked the caret from crossing/landing around a trailing image
  attrs: {
    src: { default: "" },
    alt: { default: "" },
    width: { default: null },
    align: { default: null },
    title: { default: null },
  },
  parseDOM: [
    {
      tag: 'figure[data-brain-image="true"]',
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const img = dom.querySelector("img");
        const width = Number(dom.getAttribute("data-width"));
        const align = dom.getAttribute("data-align");
        return {
          src: img?.getAttribute("src") || "",
          alt: dom.querySelector("figcaption")?.textContent || img?.getAttribute("alt") || "",
          width: readWidth(width),
          align: isImageAlign(align) ? align : null,
          title: readLegacyTitle(img?.getAttribute("title")),
        };
      },
    },
    {
      tag: "img[src]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        const layout = parseLayoutTitle(dom.getAttribute("title"));
        return {
          src: dom.getAttribute("src") || "",
          alt: dom.getAttribute("alt") || "",
          width: layout.width,
          align: layout.align,
          title: readLegacyTitle(dom.getAttribute("title")),
        };
      },
    },
  ],
  toDOM: (node) => {
    const width = readWidth(node.attrs.width);
    const align = isImageAlign(node.attrs.align) ? node.attrs.align : null;
    return [
      "figure",
      {
        "data-brain-image": "true",
        "data-width": width ? String(width) : null,
        "data-align": align,
        class: "brain-image",
      },
      ["img", { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
      ["figcaption", { class: "brain-image-caption" }, node.attrs.alt],
    ];
  },
  parseMarkdown: {
    match: (node: MarkdownNode) => node.type === "brainImage",
    runner: (state: ParserState, node: MarkdownNode, type: NodeType) => {
      state.addNode(type, attrsFromMarkdownImage(node));
    },
  },
  toMarkdown: {
    match: (node: ProseNode) => node.type.name === "brain_image",
    runner: (state: SerializerState, node: ProseNode) => {
      const title = layoutTitle(node.attrs.width, node.attrs.align) ?? node.attrs.title;
      const imageNode: JSONRecord = {
        url: typeof node.attrs.src === "string" ? node.attrs.src : "",
        alt: typeof node.attrs.alt === "string" ? node.attrs.alt : "",
      };
      if (typeof title === "string" && title) imageNode.title = title;

      state.openNode("paragraph");
      state.addNode("image", undefined, undefined, imageNode);
      state.closeNode();
    },
  },
}));

export const brainImageView = $view(brainImageSchema.node, () => ((
  initialNode: ProseNode,
  view: EditorView,
  getPos: () => number | undefined,
) => {
  let node = initialNode;
  let cleanupResize: (() => void) | null = null;
  let dragWidth: number | null = null;

  const figure = document.createElement("figure");
  figure.className = "brain-image";
  figure.setAttribute("data-brain-image", "true");
  figure.setAttribute("contenteditable", "false");

  const frame = document.createElement("div");
  frame.className = "brain-image-frame";

  const img = document.createElement("img");
  img.draggable = true;

  const alignControls = document.createElement("div");
  alignControls.className = "brain-image-align brain-image-chrome";
  alignControls.setAttribute("aria-label", "Image alignment");
  alignControls.setAttribute("contenteditable", "false");

  const alignButtons = new Map<ImageAlign, HTMLButtonElement>();
  for (const align of ALIGNMENTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "brain-image-align-button";
    button.dataset.align = align;
    button.title = `Align ${align}`;
    button.setAttribute("aria-label", `Align ${align}`);
    button.innerHTML = alignIconSvg(align);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      updateAttrs({ align });
      view.focus();
    });
    alignButtons.set(align, button);
    alignControls.append(button);
  }

  const handle = document.createElement("div");
  handle.className = "brain-image-resize brain-image-chrome";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize image");
  handle.setAttribute("contenteditable", "false");

  const caption = document.createElement("figcaption");
  caption.className = "brain-image-caption";
  caption.setAttribute("contenteditable", "false");

  frame.append(img, alignControls, handle);
  figure.append(frame, caption);

  function updateAttrs(attrs: Partial<{ width: number | null; align: ImageAlign | null }>) {
    if (!view.editable) return;
    const pos = getPos();
    if (typeof pos !== "number") return;
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "brain_image") return;
    view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }).scrollIntoView());
  }

  function maxWidth() {
    const parent = figure.parentElement;
    const parentWidth = parent?.getBoundingClientRect().width || view.dom.getBoundingClientRect().width;
    return Math.max(MIN_IMAGE_WIDTH, Math.floor(parentWidth));
  }

  function applyWidth(width: number | null) {
    if (width) {
      const safeWidth = Math.min(width, maxWidth());
      figure.style.width = `${safeWidth}px`;
      img.style.width = "100%";
      figure.dataset.width = String(safeWidth);
    } else {
      figure.style.removeProperty("width");
      img.style.removeProperty("width");
      delete figure.dataset.width;
    }
  }

  function render(nextNode: ProseNode) {
    node = nextNode;
    const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
    const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
    const width = readWidth(node.attrs.width);
    const align = isImageAlign(node.attrs.align) ? node.attrs.align : null;

    img.src = src;
    img.alt = alt;
    caption.textContent = alt;
    caption.hidden = !alt;
    figure.dataset.align = align || "left";
    for (const [buttonAlign, button] of alignButtons) {
      button.dataset.active = buttonAlign === align ? "true" : "false";
    }
    applyWidth(dragWidth ?? width);
  }

  handle.addEventListener("pointerdown", (event) => {
    if (!view.editable) return;
    event.preventDefault();
    event.stopPropagation();

    const pointerEvent = event as PointerEvent;
    const startX = pointerEvent.clientX;
    const startWidth = img.getBoundingClientRect().width || readWidth(node.attrs.width) || MIN_IMAGE_WIDTH;
    const limit = maxWidth();

    const onMove = (moveEvent: PointerEvent) => {
      dragWidth = Math.max(MIN_IMAGE_WIDTH, Math.min(limit, Math.round(startWidth + moveEvent.clientX - startX)));
      applyWidth(dragWidth);
    };

    const clearListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      cleanupResize = null;
    };

    const onUp = () => {
      clearListeners();
      const width = dragWidth;
      dragWidth = null;
      if (width) updateAttrs({ width });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    cleanupResize = () => {
      clearListeners();
      dragWidth = null;
    };
  });

  render(initialNode);

  return {
    dom: figure,
    update: (updatedNode: ProseNode) => {
      if (updatedNode.type.name !== "brain_image") return false;
      render(updatedNode);
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => {
      const target = event.target;
      return target instanceof HTMLElement && Boolean(target.closest(".brain-image-chrome"));
    },
    selectNode: () => {
      figure.dataset.selected = "true";
    },
    deselectNode: () => {
      figure.dataset.selected = "false";
    },
    destroy: () => {
      if (cleanupResize) cleanupResize();
    },
  };
}) satisfies NodeViewConstructor);

export const images = [remarkBrainImage, brainImageSchema, brainImageView].flat();
