export const INTERNAL_PAGE_LINK_CLASS = "brain-internal-page-link";

export interface InternalPageLink {
  id: string;
  href: `/p/${string}`;
}

const PAGE_ID_RE = /^[A-Za-z0-9_-]+$/;
const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//;

/**
 * Resolve only exact Brain page URLs.
 *
 * Query strings and fragments are deliberately not classified: canonicalizing
 * them away would silently change the destination. Encoded ids are rejected
 * for the same reason instead of being normalized into a different page id.
 */
export function classifyInternalPageLink(
  rawHref: string | null | undefined,
  currentOrigin: string,
): InternalPageLink | null {
  if (!rawHref || rawHref !== rawHref.trim()) return null;
  if (rawHref.includes("?") || rawHref.includes("#") || rawHref.includes("\\")) {
    return null;
  }

  let base: URL;
  try {
    base = new URL(currentOrigin);
  } catch {
    return null;
  }
  if (base.origin !== currentOrigin) return null;

  let url: URL;
  if (rawHref.startsWith("/")) {
    if (rawHref.startsWith("//")) return null;
    try {
      url = new URL(rawHref, base);
    } catch {
      return null;
    }
  } else {
    if (!ABSOLUTE_HTTP_URL_RE.test(rawHref)) return null;
    try {
      url = new URL(rawHref);
    } catch {
      return null;
    }
    if (url.username || url.password) return null;
  }

  if (url.origin !== base.origin || url.search || url.hash) return null;
  const match = /^\/p\/([^/]+)$/.exec(url.pathname);
  const id = match?.[1];
  if (!id || !PAGE_ID_RE.test(id)) return null;

  return { id, href: `/p/${id}` };
}

/** No real link resolves here: `.invalid` is reserved (RFC 2606). Resolving a
 *  relative href against it lets `classifyInternalPageLink` judge the path
 *  while every absolute URL fails the origin check. */
const RELATIVE_ONLY_ORIGIN = "http://brain.invalid";

/** The one rule for what a page link is, wherever a body is read: exactly
 *  `/p/<id>`, or that same path on `origin`. A query, a fragment, a trailing
 *  slash or another host makes an ordinary link — the editor shows it as one,
 *  so nothing that reads the Markdown on the server may treat it as a page row
 *  either. Without an origin only the relative form can be a page link. */
export function internalPageLinkId(
  href: string | null | undefined,
  origin?: string | null,
): string | null {
  return classifyInternalPageLink(href, origin || RELATIVE_ONLY_ORIGIN)?.id ?? null;
}
