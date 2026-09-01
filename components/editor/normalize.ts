import { $remark } from "@milkdown/kit/utils";

/** Legacy-source normalization at parse time, so the FIRST serialize is
 *  already a fixed point (no phantom rev on the next open+save).
 *
 *  Notion exports task items as `-  [x] text` (two spaces) — gfm doesn't
 *  recognize that as a checkbox, so the item rendered as literal "[x] text"
 *  and re-serialized differently on every pass. Promote the literal prefix to
 *  a real checked/unchecked flag, and drop insignificant leading whitespace in
 *  paragraph text (markdown ignores it; keeping it made serialize drift). */

type LooseNode = {
  type: string;
  value?: string;
  checked?: boolean | null;
  children?: LooseNode[];
};

const CHECKBOX = /^\s*\[([ xX])\]\s+/;

/** A text node emptied by normalization must be dropped — ProseMirror forbids
 *  empty text nodes and the whole page would fail to parse. */
function dropIfEmptied(parent: LooseNode, child: LooseNode) {
  if (child.type === "text" && child.value === "" && Array.isArray(parent.children)) {
    parent.children = parent.children.filter((c) => c !== child);
  }
}

function normalizeTree(node: LooseNode) {
  if (!Array.isArray(node.children)) return;

  for (const child of node.children) normalizeTree(child);

  if (node.type === "listItem" && (node.checked === null || node.checked === undefined)) {
    const para = node.children[0];
    const text = para?.type === "paragraph" ? para.children?.[0] : undefined;
    if (para && text?.type === "text" && typeof text.value === "string") {
      const m = CHECKBOX.exec(text.value);
      if (m) {
        node.checked = m[1] !== " ";
        text.value = text.value.slice(m[0].length);
        dropIfEmptied(para, text);
      }
    }
  }

  if (node.type === "paragraph") {
    // trim the first TEXT descendant, descending through inline wrappers —
    // `[ label](url)` keeps its leading space inside the link node, and
    // stringify pushed it back out as line-leading whitespace (drift)
    let parent: LooseNode = node;
    let first = node.children[0];
    while (
      first &&
      first.type !== "text" &&
      ["link", "emphasis", "strong", "delete"].includes(first.type) &&
      Array.isArray(first.children)
    ) {
      parent = first;
      first = first.children[0];
    }
    if (first?.type === "text" && typeof first.value === "string") {
      first.value = first.value.replace(/^[ \t]+/, "");
      dropIfEmptied(parent, first);
    }
  }
}

export const normalizeLegacy = $remark(
  "brainNormalizeLegacy",
  () => () => (tree: unknown) => {
    normalizeTree(tree as LooseNode);
  },
);
