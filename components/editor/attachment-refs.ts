"use client";

import { imageSchema, linkSchema } from "@milkdown/kit/preset/commonmark";
import type { Mark, Node as ProseNode } from "@milkdown/kit/prose/model";
import type { MarkViewConstructor, NodeViewConstructor } from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";
import { attachmentSrc, bareAttachmentSrc, noteAttachmentLoadFailure } from "./attachment-src";

/**
 * The two other places an attachment path reaches the screen: commonmark's
 * inline image (an image that is not alone in its paragraph) and the link
 * mark (`[📎 name](/_attachments-v2/…)`). Each gets the same pair of gates
 * the block image in image.ts has: parseDOM takes the access triple back out,
 * the view puts it in at display time. toDOM is left as the preset wrote it,
 * bare, because it feeds the clipboard.
 */
export const inlineImageSchema = imageSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  parseDOM: [
    {
      tag: "img[src]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          src: bareAttachmentSrc(dom.getAttribute("src") || ""),
          alt: dom.getAttribute("alt") || "",
          title: dom.getAttribute("title") || dom.getAttribute("alt") || "",
        };
      },
    },
  ],
}));

export const inlineImageView = $view(imageSchema.node, () => ((initialNode: ProseNode) => {
  const img = document.createElement("img");
  let src = "";
  img.addEventListener("error", () => noteAttachmentLoadFailure(img, src));
  const render = (node: ProseNode) => {
    src = typeof node.attrs.src === "string" ? node.attrs.src : "";
    img.src = attachmentSrc(src);
    img.alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
    if (typeof node.attrs.title === "string" && node.attrs.title) {
      img.title = node.attrs.title;
    } else {
      img.removeAttribute("title");
    }
  };
  render(initialNode);
  return {
    dom: img,
    update: (node: ProseNode) => {
      if (node.type !== initialNode.type) return false;
      render(node);
      return true;
    },
  };
}) satisfies NodeViewConstructor);

export const attachmentLinkSchema = linkSchema.extendSchema((prev) => (ctx) => ({
  ...prev(ctx),
  parseDOM: [
    {
      tag: "a[href]",
      getAttrs: (dom) => {
        if (!(dom instanceof HTMLElement)) return false;
        return {
          href: bareAttachmentSrc(dom.getAttribute("href") || ""),
          title: dom.getAttribute("title"),
        };
      },
    },
  ],
}));

export const attachmentLinkView = $view(linkSchema.mark, () => ((mark: Mark) => {
  const anchor = document.createElement("a");
  const href = typeof mark.attrs.href === "string" ? mark.attrs.href : "";
  anchor.setAttribute("href", attachmentSrc(href));
  if (typeof mark.attrs.title === "string" && mark.attrs.title) {
    anchor.title = mark.attrs.title;
  }
  return { dom: anchor, contentDOM: anchor };
}) satisfies MarkViewConstructor);

export const attachmentRefs = [
  inlineImageSchema,
  inlineImageView,
  attachmentLinkSchema,
  attachmentLinkView,
].flat();
