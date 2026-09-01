export interface SearchTextTarget {
  /** Exact visible text selected by the search result. */
  exact: string;
  /** Zero-based occurrence in the normalized visible page text. */
  occurrence: number;
  /** Normalized visible context immediately before the match. */
  before: string;
  /** Normalized visible context immediately after the match. */
  after: string;
}

export interface SearchHighlightRequest {
  requestId: number;
  pageId: string;
  target: SearchTextTarget;
}

export type SearchHighlightStatus =
  | "exact"
  | "missing"
  | "ambiguous"
  | "cleared";

export function collapseSearchWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

/** Small lexical projection shared by search payload creation and editor
 * reconciliation. It covers syntax that changes visible inline text without
 * trying to become a second Markdown parser. */
export function projectMarkdownSearchText(markdown: string): string {
  return collapseSearchWhitespace(
    markdown
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(
        /^[\t ]*(?:(?:[-+*])|(?:\d+[.)]))[\t ]+(?:\[[ xX]\][\t ]+)?/gm,
        "",
      )
      .replace(/[*_`#>|]+/g, ""),
  ).trim();
}
