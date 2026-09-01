import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { classifyInternalPageLink } from "./internal-page-link";

interface Replacement {
  start: number;
  end: number;
  value: string;
}

interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
}

interface MarkdownLinkNode extends MarkdownNode {
  type: "link";
  url: string;
  children: MarkdownNode[];
}

function isLink(node: MarkdownNode): node is MarkdownLinkNode {
  return (
    node.type === "link" &&
    typeof node.url === "string" &&
    Array.isArray(node.children)
  );
}

function literalLinkDestinationRange(
  markdown: string,
  node: MarkdownLinkNode,
): { start: number; end: number } | null {
  const nodeStart = node.position?.start.offset;
  const nodeEnd = node.position?.end.offset;
  if (nodeStart === undefined || nodeEnd === undefined) return null;

  const source = markdown.slice(nodeStart, nodeEnd);
  const lastChildEnd = node.children.at(-1)?.position?.end.offset;
  const searchFrom =
    lastChildEnd === undefined ? 0 : Math.max(0, lastChildEnd - nodeStart);
  const destinationOpener = source.indexOf("](", searchFrom);
  if (destinationOpener === -1) return null;

  const urlIndex = source.indexOf(node.url, destinationOpener + 2);
  if (urlIndex === -1) return null;

  const prefix = source.slice(destinationOpener + 2, urlIndex);
  const angleWrapped = /^[\t\n\r ]*<$/.test(prefix);
  const bare = /^[\t\n\r ]*$/.test(prefix);
  if (!angleWrapped && !bare) return null;

  const afterUrl = source[urlIndex + node.url.length];
  if (angleWrapped ? afterUrl !== ">" : !/[\t\n\r )]/.test(afterUrl ?? "")) {
    return null;
  }

  return {
    start: nodeStart + urlIndex,
    end: nodeStart + urlIndex + node.url.length,
  };
}

/**
 * Canonicalize exact same-origin absolute page destinations without
 * reserializing Markdown. Applying position-based replacements in reverse
 * preserves every byte outside the URL, including hard breaks and directives.
 */
export function canonicalizeMcpPageMarkdown(
  markdown: string,
  configuredOrigin: string,
): string {
  const root = fromMarkdown(markdown, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  }) as MarkdownNode;
  const replacements: Replacement[] = [];

  const visit = (node: MarkdownNode) => {
    if (isLink(node) && /^https?:\/\//.test(node.url)) {
      const internal = classifyInternalPageLink(node.url, configuredOrigin);
      const range = internal
        ? literalLinkDestinationRange(markdown, node)
        : null;
      if (internal && range) {
        replacements.push({ ...range, value: internal.href });
      }
    }
    node.children?.forEach(visit);
  };
  visit(root);

  let result = markdown;
  replacements
    .sort((left, right) => right.start - left.start)
    .forEach(({ start, end, value }) => {
      result = result.slice(0, start) + value + result.slice(end);
    });
  return result;
}
