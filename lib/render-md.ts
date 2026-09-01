import { marked, Renderer, type Tokens } from "marked";
import DOMPurify from "isomorphic-dompurify";
import {
  localAttachmentName,
  stripEditorDirectiveFences,
} from "./attachments";

/** One read-only markdown → sanitized HTML renderer for every non-editor
 *  surface (shared pages, version-history preview). The editor's custom blocks
 *  are remark container directives (`:::cols`, `:::callout{…}`, `:::toggle{…}`)
 *  and page refs (`[label](/p/<id>)`); plain `marked` would print the `:::`
 *  fences as literal noise and turn page links into dead hrefs. Strip the
 *  fence lines (keep their inner content) and flatten page refs to plain text,
 *  so a shared page reads as prose rather than showing broken chrome. */
export function renderReadOnly(
  markdown: string,
  options: {
    attachmentAccess?:
      | { pageId: string; shareVersion: number }
      | { rootId: string; targetId: string; shareVersion: number };
    shareNavigation?: {
      rootId: string;
      isAllowedPage: (pageId: string) => boolean;
    };
  } = {},
): string {
  const cleaned = stripEditorDirectiveFences(markdown);
  const tokens = marked.lexer(cleaned, { gfm: true });
  if (options.attachmentAccess) {
    const { shareVersion } = options.attachmentAccess;
    const query =
      "pageId" in options.attachmentAccess
        ? `page=${encodeURIComponent(options.attachmentAccess.pageId)}&v=${shareVersion}`
        : `root=${encodeURIComponent(options.attachmentAccess.rootId)}&page=${encodeURIComponent(options.attachmentAccess.targetId)}&v=${shareVersion}`;
    marked.walkTokens(tokens, (token) => {
      if (token.type !== "link" && token.type !== "image") return;
      if (!localAttachmentName(token.href)) return;
      token.href = `${token.href.split(/[?#]/, 1)[0]}?${query}`;
    });
  }
  return DOMPurify.sanitize(
    marked.parser(tokens, {
      gfm: true,
      renderer: new ReadOnlyRenderer(options.shareNavigation),
    }),
  );
}

/** Flatten private app links at render time, after Markdown was tokenized.
 * Rewriting their labels in the source can create new fences/headings and make
 * attachment authorization disagree with what the shared page displays. */
class ReadOnlyRenderer extends Renderer {
  constructor(
    private readonly shareNavigation?: {
      rootId: string;
      isAllowedPage: (pageId: string) => boolean;
    },
  ) {
    super();
  }

  override link(token: Tokens.Link): string {
    if (token.href.startsWith("/p/")) {
      const pageRef = /^\/p\/([A-Za-z0-9_-]+)$/.exec(token.href);
      if (!pageRef) return this.parser.parseInline(token.tokens);
      if (
        this.shareNavigation?.isAllowedPage(pageRef[1])
      ) {
        const rootHref = `/share/${encodeURIComponent(this.shareNavigation.rootId)}`;
        const href =
          pageRef[1] === this.shareNavigation.rootId
            ? rootHref
            : `${rootHref}?page=${encodeURIComponent(pageRef[1])}`;
        return `<a class="brain-page-ref" href="${href}">${this.parser.parseInline(token.tokens)}</a>`;
      }
      return this.parser.parseInline(token.tokens);
    }
    return super.link(token);
  }
}
