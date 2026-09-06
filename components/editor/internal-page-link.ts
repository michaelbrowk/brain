import {
  classifyInternalPageLink,
  INTERNAL_PAGE_LINK_CLASS,
} from "@/lib/internal-page-link";
import { hasPageRefHrefResolver } from "./page-ref";

export {
  classifyInternalPageLink,
  INTERNAL_PAGE_LINK_CLASS,
} from "@/lib/internal-page-link";
export type { InternalPageLink } from "@/lib/internal-page-link";

export type EditorLinkNavigation =
  | { kind: "internal"; id: string }
  | { kind: "external"; href: string };

const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//;

export function classifyEditorLinkNavigation(
  rawHref: string | null | undefined,
  currentOrigin: string,
): EditorLinkNavigation | null {
  const internal = classifyInternalPageLink(rawHref, currentOrigin);
  if (internal) return { kind: "internal", id: internal.id };
  if (!rawHref || rawHref !== rawHref.trim()) return null;

  let base: URL;
  try {
    base = new URL(currentOrigin);
  } catch {
    return null;
  }
  if (base.origin !== currentOrigin) return null;

  let url: URL;
  try {
    if (rawHref.startsWith("/")) {
      if (rawHref.startsWith("//")) return null;
      url = new URL(rawHref, base);
    } else {
      if (!ABSOLUTE_HTTP_URL_RE.test(rawHref)) return null;
      url = new URL(rawHref);
    }
  } catch {
    return null;
  }
  if (url.username || url.password) return null;

  return { kind: "external", href: url.href };
}

export function followEditorLink(
  rawHref: string | null | undefined,
  currentOrigin: string,
  navigateInternal: ((id: string) => void) | undefined,
  openExternal: (href: string) => void,
): boolean {
  const navigation = classifyEditorLinkNavigation(rawHref, currentOrigin);
  if (!navigation) return false;
  if (navigation.kind === "internal") {
    if (!navigateInternal) return false;
    navigateInternal(navigation.id);
  } else {
    openExternal(navigation.href);
  }
  return true;
}

/** Does this href address the owner's page namespace at all? `/p/<id>` exactly
 *  is a page link everywhere (`classifyInternalPageLink`); the near misses --
 *  a query, a fragment, a trailing slash, an encoded id, a backslash -- are
 *  ordinary links, because canonicalizing them away would change where they
 *  go. This answers for both, so a surface that may not reach `/p/` at all can
 *  ask one question. Whitespace and backslashes are normalized by the URL
 *  parser here on purpose: every form that could reach the namespace answers
 *  yes. */
function addressesPageNamespace(
  rawHref: string | null | undefined,
  currentOrigin: string,
): boolean {
  if (!rawHref) return false;
  let base: URL;
  try {
    base = new URL(currentOrigin);
  } catch {
    return false;
  }
  let url: URL;
  try {
    url = new URL(rawHref, base);
  } catch {
    return false;
  }
  if (url.origin !== base.origin) return false;
  return url.pathname === "/p" || url.pathname.startsWith("/p/");
}

/** A click on an anchor inside the editor. A page ref goes by its id and
 *  never by its href: the owner's shell moves to the page, a link visitor's
 *  island moves within the share, and the href, which only the display
 *  decides, is never what a click reads. A ref with no href is one the editor
 *  could not place, and nothing happens. Every other anchor goes through its
 *  href, resolved first (a bare attachment path becomes the URL the browser
 *  may fetch). Returns whether the click was taken. */
export function followEditorAnchor(
  anchor: HTMLAnchorElement,
  currentOrigin: string,
  navigateInternal: ((id: string) => void) | undefined,
  openExternal: (href: string) => void,
  resolveHref: (href: string) => string = (href) => href,
): boolean {
  const pageRefId = anchor.dataset.pageRef;
  if (pageRefId !== undefined) {
    if (!navigateInternal || !anchor.hasAttribute("href")) return false;
    navigateInternal(pageRefId);
    return true;
  }
  const raw = anchor.getAttribute("href");
  const href = raw === null ? null : resolveHref(raw);
  // A surface that decides for itself where a page id may point -- a link
  // visitor's island, which installs a page-ref resolver -- decides for a
  // plain link mark holding the owner's `/p/` address too, or the address
  // would be a way off it. The exact `/p/<id>` form falls through and reaches
  // `navigateInternal`, which answers for the id; a near miss (a query, a
  // fragment, a trailing slash) has no id to answer for, and the read-only
  // render of the same body flattens it, so nothing follows it here either.
  // Taken, not declined: declining leaves the click to the browser, and
  // following the href is the navigation this refuses.
  if (
    hasPageRefHrefResolver() &&
    addressesPageNamespace(href, currentOrigin) &&
    !classifyInternalPageLink(href, currentOrigin)
  ) {
    return true;
  }
  return followEditorLink(href, currentOrigin, navigateInternal, openExternal);
}

function syncMarker(anchor: HTMLAnchorElement, currentOrigin: string) {
  const internal =
    !anchor.classList.contains("brain-page-ref") &&
    classifyInternalPageLink(anchor.getAttribute("href"), currentOrigin) !== null;
  anchor.classList.toggle(INTERNAL_PAGE_LINK_CLASS, internal);
}

function syncNode(node: Node, currentOrigin: string) {
  if (!(node instanceof Element)) return;
  if (node instanceof HTMLAnchorElement) syncMarker(node, currentOrigin);
  node
    .querySelectorAll<HTMLAnchorElement>("a")
    .forEach((anchor) => syncMarker(anchor, currentOrigin));
}

/**
 * Keep internal-link styling in sync with ProseMirror's live DOM. Milkdown can
 * reuse an anchor node and change its href, so a one-time scan is insufficient.
 */
export function observeInternalPageLinks(
  root: Element,
  currentOrigin: string,
): () => void {
  syncNode(root, currentOrigin);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLAnchorElement) {
          syncMarker(record.target, currentOrigin);
        }
        continue;
      }
      record.addedNodes.forEach((node) => syncNode(node, currentOrigin));
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["href", "class"],
  });
  return () => observer.disconnect();
}
