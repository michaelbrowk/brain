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
    shareNavigation?: ShareNavigation;
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
    {
      // A body a link visitor wrote is loaded by other visitors and by the
      // owner. `<style>` elements were already stripped, but the inline
      // style attribute was not, and it carries a remote `url()` plus enough
      // positioning to lay arbitrary chrome over the page. No CSP directive
      // covers it: style-src governs stylesheets, style-src-attr governs
      // this, and neither is on the /share policy. Drop the attribute.
      FORBID_ATTR: ["style"],
      // A form renders. form-action 'none' blocks the submission and there
      // is no script to read the field, so this is a phishing surface rather
      // than a credential leak, and a note has no reason to carry one.
      FORBID_TAGS: ["form", "input", "button"],
    },
  );
}

interface ShareNavigation {
  rootId: string;
  isAllowedPage: (pageId: string) => boolean;
  /** The title and icon that page carries now, for a page the share reaches.
   *  Null keeps the label the body was written with, which is the answer for
   *  every page outside the share. */
  pageLabel?: (
    pageId: string,
  ) => { title: string; icon?: string; kind?: "app" } | null;
}

/** Flatten private app links at render time, after Markdown was tokenized.
 * Rewriting their labels in the source can create new fences/headings and make
 * attachment authorization disagree with what the shared page displays. */
class ReadOnlyRenderer extends Renderer {
  constructor(private readonly shareNavigation?: ShareNavigation) {
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
        // The live title, the way the editor's page-ref node draws it for the
        // owner. A rename does not rewrite the label in this body — Markdown
        // is the source of truth — so the written one is only the fallback,
        // for a page this share cannot see.
        const live = this.shareNavigation.pageLabel?.(pageRef[1]) ?? null;
        // Static markup, byte for byte what `AiChip` renders, `aria-label`
        // included: without one a screen reader on a public page is read the
        // two letters "AI" and nothing else, which names no origin and is
        // the whole of what the chip is for. One CSS rule then serves the
        // owner's editor and the public page alike. Nothing here comes from
        // the page, so there is nothing to escape.
        const chip =
          live?.kind === "app"
            ? `<span class="ai-chip" title="Built by an agent" aria-label="Built by an agent">AI</span>`
            : "";
        const label = live
          ? `<span class="brain-page-ref-icon">${escapeText(live.icon || "📄")}</span> ${escapeText(live.title)}${chip}`
          : this.parser.parseInline(token.tokens);
        return `<a class="brain-page-ref" href="${href}">${label}</a>`;
      }
      return this.parser.parseInline(token.tokens);
    }
    return super.link(token);
  }
}

/** Load-bearing. A page title is text, and this is the one place a title is
 *  concatenated into raw HTML — the derived tail is JSX, where React escapes
 *  it for free. Without this, a title of `<img src=x onerror=…>` becomes live
 *  markup on a public page: DOMPurify drops the handler but keeps the `<img>`
 *  (a remote beacon fired on every anonymous load) and any `<b>` around it.
 *  On an editable share the title need not even be the owner's — a visitor
 *  names the subpage they create, and every later visitor is served it.
 *  DOMPurify is the second line here, not the first. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
