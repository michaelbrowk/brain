import { internalPageLinkId } from "./internal-page-link";
import { fromMarkdown } from "mdast-util-from-markdown";

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

/** Collect semantic Markdown links, ignoring page-looking text in code.
 *
 *  This is the one answer to "does this body already link that page": a
 *  standalone row and a mention inside a sentence both count. The derived tail
 *  below the editor hides a child the body links anywhere, the editor refuses
 *  to file a page the body links anywhere, and a move or a nesting gesture
 *  appends a row only when the body links the page nowhere — so no path ever
 *  writes a second reference into a document that already has one. Without
 *  an origin only relative `/p/<id>` links can be recognised. */
export function referencedPageIds(
  markdown: string,
  currentOrigin: string | null,
): Set<string> {
  let root: MarkdownNode;
  try {
    root = fromMarkdown(markdown) as MarkdownNode;
  } catch {
    return new Set();
  }

  const definitions = new Map<string, string>();
  const collectDefinitions = (node: MarkdownNode) => {
    if (
      node.type === "definition" &&
      typeof node.identifier === "string" &&
      typeof node.url === "string"
    ) {
      const id = internalPageLinkId(node.url, currentOrigin);
      if (id) definitions.set(node.identifier, id);
    }
    node.children?.forEach(collectDefinitions);
  };
  collectDefinitions(root);

  const ids = new Set<string>();
  const collectLinks = (node: MarkdownNode) => {
    if (node.type === "link" && typeof node.url === "string") {
      const id = internalPageLinkId(node.url, currentOrigin);
      if (id) ids.add(id);
    } else if (
      node.type === "linkReference" &&
      typeof node.identifier === "string"
    ) {
      const id = definitions.get(node.identifier);
      if (id) ids.add(id);
    }
    node.children?.forEach(collectLinks);
  };
  collectLinks(root);
  return ids;
}

/** Direct children the body does not link yet. Without an origin (server
 *  render, hydration pass) no link can be classified, so the answer is "none"
 *  rather than "all": painting every child as a derived ref and collapsing
 *  the list once the browser origin arrives shows anchors that never belonged
 *  on the page. The list appears with the first client render. */
export function unreferencedDirectChildren<
  T extends { id: string; collectionRow?: unknown },
>(
  pages: readonly T[],
  markdown: string,
  currentOrigin: string | null,
): T[] {
  if (!currentOrigin) return [];
  const referencedIds = referencedPageIds(markdown, currentOrigin);
  return pages.filter(
    (child) => !child.collectionRow && !referencedIds.has(child.id),
  );
}
